import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Road, ROAD_HALF, laneOffset, nearestLane } from '../world/Road.js';
import { clamp, damp } from '../core/utils.js';
import { TIERS } from './Vehicles.js';
import { spinWheels } from '../models/ModelLibrary.js';

const P = CONFIG.player;
const SAMPLE = {};
const LANES = CONFIG.road.lanes;
const GRAVITY = 30;

/**
 * 玩家控制器
 *  - 左/右滑：变道（平滑插值到目标车道）
 *  - 上/下滑：加速 / 刹车（速度偏移量随时间回落到巡航速度）
 *  - 冲刺 Dash：短时间加速 + 无敌，碰撞标签从 'Player' 变成 'PlayerDash'
 *  - 车辆进化：跑车 → 肌肉车 → 装甲车（'PlayerRam'，直接撞爆警车）→ 坦克（还能开炮）
 *  - 护盾：每层抵挡一次伤害
 *  - 跳台：飞起来的时候不参与碰撞
 */
export class PlayerController {
  constructor(scene, events = {}) {
    this.scene = scene;
    this.events = events; // { onDashStart, onDashEnd, onHit, onBump, onShieldBreak, onLand }
    this.mesh = null;
    this.aura = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.bubble = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x5ad1ff, transparent: true, opacity: 0.22, depthWrite: false, wireframe: true }),
    );
    this.reset();
  }

  /** 每局开始：属性回到初始值，车辆回到跑车 */
  reset() {
    this.stats = {
      maxHp: P.maxHp,
      baseSpeed: P.baseSpeed,
      maxSpeed: P.maxSpeed,
      dashCooldown: P.dash.cooldown,
      dashDuration: P.dash.duration,
      cannonCooldown: CONFIG.cannon.cooldown,
      cannonRadius: CONFIG.cannon.radius,
    };
    this.upgradeLevels = {};
    this.setTier(0);
    this.lane = 1;
    this.lateral = laneOffset(this.lane);
    this.latVel = 0;
    this.knockVel = 0;
    this.z = 0;
    this.y = 0;
    this.vy = 0;
    this.speed = this.stats.baseSpeed;
    this.speedBias = 0;
    this.hp = this.stats.maxHp;
    this.shields = 0;
    this.invuln = 0;
    this.isDashing = false;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.alive = true;
    this.syncMesh(0);
  }

  /** 换车：替换模型和碰撞尺寸，光环和护盾挂到新模型上 */
  setTier(index) {
    this.tierIndex = index;
    this.tier = TIERS[index];
    if (this.mesh) this.scene.remove(this.mesh);
    this.mesh = this.tier.model();
    this.root = this.mesh.userData.root;
    this.turret = this.mesh.userData.turret ?? null;
    this.muzzle = this.mesh.userData.muzzle ?? null;
    this.length = this.tier.length;
    this.width = this.tier.width;
    this.aura.scale.set(this.width + 0.6, 1.8, this.length + 1);
    this.aura.position.y = 0.9;
    this.bubble.scale.set(this.width * 0.9 + 0.6, 1.8, this.length * 0.65 + 0.4);
    this.bubble.position.y = 0.9;
    this.root.add(this.aura, this.bubble);
    this.scene.add(this.mesh);
  }

  /** 进化到下一级：血量上限按两级差值增加，并回满 */
  evolve() {
    if (this.tierIndex >= TIERS.length - 1) return false;
    const prev = this.tier;
    this.setTier(this.tierIndex + 1);
    this.stats.maxHp += this.tier.hp - prev.hp;
    this.hp = this.stats.maxHp;
    this.syncMesh(0);
    return true;
  }

  // ---- 碰撞系统读取的属性 ----
  /** Player = 普通；PlayerDash = 冲刺中；PlayerRam = 重型车辆（装甲车/坦克）直接撞爆警车 */
  get collisionTag() {
    if (this.isDashing) return 'PlayerDash';
    return this.tier.ram ? 'PlayerRam' : 'Player';
  }
  get smashes() { return this.collisionTag !== 'Player'; }
  get airborne() { return this.y > 0.6; }
  get colW() { return this.width; }
  get colL() { return this.length; }
  get maxHp() { return this.stats.maxHp; }
  get dashReady() { return this.alive && !this.isDashing && this.dashCooldown <= 0; }
  get dashCharge() { return this.isDashing ? 1 : 1 - this.dashCooldown / this.stats.dashCooldown; }

  handleSwipe(dir) {
    if (!this.alive) return;
    // 镜头在车后方：+lat 是屏幕左侧，所以“左滑”是车道编号 +1
    if (dir === 'left') this.lane = Math.min(LANES - 1, this.lane + 1);
    else if (dir === 'right') this.lane = Math.max(0, this.lane - 1);
    else if (dir === 'up') this.speedBias = Math.min(P.maxBias, this.speedBias + P.swipeUpBias);
    else if (dir === 'down') this.speedBias = Math.max(-P.maxBias, this.speedBias + P.swipeDownBias);
  }

  tryDash() {
    if (!this.dashReady) return false;
    this.isDashing = true;
    this.dashTimer = this.stats.dashDuration;
    this.invuln = 0;
    this.events.onDashStart?.(this);
    return true;
  }

  // 冲刺中每撞毁一辆警车，冲刺时间延长一点 → 鼓励连续撞击（连击）
  extendDash() {
    if (this.isDashing) this.dashTimer = Math.min(this.dashTimer + P.dash.extendOnKill, this.stats.dashDuration * 1.5);
  }

  endDash() {
    this.isDashing = false;
    this.dashCooldown = this.stats.dashCooldown;
    this.events.onDashEnd?.(this);
  }

  /** 从跳台起飞 */
  jump(power = 13) {
    if (this.airborne || !this.alive) return false;
    this.vy = power;
    this.y = 0.7;
    return true;
  }

  /** 重型车辆撞爆东西的代价：掉一点速度和一点点血 */
  ramImpact(damage = 3) {
    this.speed *= 0.92;
    if (!this.isDashing) this.hp = Math.max(1, this.hp - damage);
  }

  /** 被撞：返回 true 表示真的受到了伤害（冲刺/无敌帧/护盾时免疫） */
  hit(damage, pushDir = 0, speedMul = 0.6) {
    if (!this.alive || this.isDashing || this.invuln > 0) return false;
    if (this.shields > 0) {
      // 护盾抵挡这一次伤害
      this.shields--;
      this.invuln = P.hitInvuln;
      this.events.onShieldBreak?.(this);
      return false;
    }
    this.hp = Math.max(0, this.hp - damage);
    this.invuln = P.hitInvuln;
    this.speed *= speedMul;
    if (pushDir) {
      this.knockVel = pushDir * 8;
      this.lane = nearestLane(this.lateral + pushDir * CONFIG.road.laneWidth * 0.6);
    }
    if (this.hp <= 0) this.alive = false;
    this.events.onHit?.(this, damage);
    return true;
  }

  heal(amount) {
    this.hp = Math.min(this.stats.maxHp, this.hp + amount);
  }

  /**
   * 非玩家失误的碰撞（被追尾、被警车侧面挤）：不扣血、不进无敌帧，只推一把。
   *  - speedBoost：被追尾时往前推，加到速度偏移量上，会在 1~2 秒内自然回落
   *  - pushDir：被侧挤时横向推一下，但不改目标车道，车子会自己回正
   */
  bump(pushDir = 0, speedBoost = 0) {
    if (!this.alive) return;
    const B = CONFIG.bump;
    if (pushDir) this.knockVel = pushDir * 8 * B.sidePush;
    if (speedBoost) {
      this.speedBias = Math.min(P.maxBias, this.speedBias + speedBoost);
      const cap = this.stats.maxSpeed * B.maxSpeedMul * (this.isDashing ? P.dash.speedMul : 1);
      this.speed = Math.min(this.speed + speedBoost * 0.6, cap);
    }
    this.events.onBump?.(this);
  }

  update(dt) {
    // 冲刺计时
    if (this.isDashing) {
      this.dashTimer -= dt;
      if (this.dashTimer <= 0) this.endDash();
    } else if (this.dashCooldown > 0) {
      this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    }
    this.invuln = Math.max(0, this.invuln - dt);

    // 纵向速度：滑动产生的速度偏移逐渐回落到巡航速度
    const st = this.stats, cruise = st.baseSpeed + this.tier.speed;
    const decay = P.biasDecay * dt;
    this.speedBias = Math.abs(this.speedBias) <= decay ? 0 : this.speedBias - Math.sign(this.speedBias) * decay;
    let target = clamp(cruise + this.speedBias, P.minSpeed, st.maxSpeed + this.tier.speed);
    if (this.isDashing) target *= P.dash.speedMul;
    if (!this.alive) target = 0;
    const rate = target > this.speed ? (this.isDashing ? P.accel * 5 : P.accel) : P.brake;
    this.speed += clamp(target - this.speed, -rate * dt, rate * dt);

    // 横向：指数平滑到目标车道 + 被撞时的击退速度（空中不能变道）
    const prev = this.lateral;
    if (!this.airborne) this.lateral = damp(this.lateral, laneOffset(this.lane), P.laneSharpness, dt) + this.knockVel * dt;
    this.knockVel = damp(this.knockVel, 0, 6, dt);
    const lim = ROAD_HALF - this.width / 2 - 0.1;
    this.lateral = clamp(this.lateral, -lim, lim);
    this.latVel = dt > 0 ? (this.lateral - prev) / dt : 0;

    // 跳跃
    if (this.y > 0 || this.vy > 0) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        const impact = -this.vy;
        this.y = 0;
        this.vy = 0;
        this.events.onLand?.(this, impact);
      }
    }

    this.z += this.speed * dt;
    this.syncMesh(dt);
  }

  syncMesh(dt) {
    const m = this.mesh;
    const w = Road.sample(this.z, this.lateral, SAMPLE);
    spinWheels(m, this.y > 0 ? this.speed * dt * 1.5 : this.z - (this.wheelZ ?? this.z)); // 空中车轮空转
    this.wheelZ = this.z;
    m.position.set(w.x, this.y, w.z);
    // 车头朝向 = 道路切线方向 + 变道时的转向角
    m.rotation.y = w.h + Math.atan2(this.latVel, Math.max(this.speed, 5)) * 0.9;
    // 车身侧倾 / 加速时抬头 / 空中车头上扬再下压
    const pitch = this.y > 0 ? clamp(-this.vy * 0.02, -0.3, 0.3) : this.isDashing ? -0.05 : 0;
    this.root.rotation.z = damp(this.root.rotation.z, clamp(-this.latVel * 0.025, -0.12, 0.12), 10, dt);
    this.root.rotation.x = damp(this.root.rotation.x, pitch, 8, dt);
    // 冲刺光环、护盾、受伤闪烁
    this.aura.visible = this.isDashing;
    if (this.isDashing) this.aura.material.opacity = 0.25 + 0.15 * Math.sin(performance.now() * 0.03);
    this.bubble.visible = this.shields > 0;
    if (this.shields > 0) {
      this.bubble.rotation.y += dt * 1.5;
      this.bubble.material.opacity = 0.18 + 0.06 * this.shields;
    }
    m.visible = !(this.invuln > 0 && Math.floor(this.invuln * 20) % 2 === 0);
  }
}
