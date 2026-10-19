import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Road, ROAD_HALF, WATER_Y, laneOffset, nearestLane } from '../world/Road.js';
import { clamp, damp } from '../core/utils.js';
import { TIERS } from './Vehicles.js';
import { spinWheels } from '../models/ModelLibrary.js';
import { GLOW_TEX } from '../fx/Particles.js';
import { RUN } from '../data/difficulty.js';
import { makePlayerBoat } from '../models/Boats.js';

const P = CONFIG.player;
const SAMPLE = {};
const LANES = CONFIG.road.lanes;
const GRAVITY = 30;
const SEA = CONFIG.sea;

/**
 * 玩家控制器
 *  - 左/右滑：变道（平滑插值到目标车道）
 *  - 上/下滑：加速 / 刹车（速度偏移量随时间回落到巡航速度）
 *  - 冲刺 Dash：短时间加速 + 无敌，碰撞标签从 'Player' 变成 'PlayerDash'
 *  - 车辆进化：跑车 → 肌肉车 → 装甲车（'PlayerRam'，直接撞爆警车）→ 坦克（还能开炮）
 *  - 护盾：每层抵挡一次伤害
 *  - 跳台：飞起来的时候不参与碰撞
 */
/** 头顶的 “P1 / P2” 标签（双人对战时显示） */
function tagSprite(text, color) {
  const c = Object.assign(document.createElement('canvas'), { width: 128, height: 64 });
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(8, 6, 112, 46, 14);
  g.fill();
  g.beginPath();
  g.moveTo(52, 50); g.lineTo(64, 62); g.lineTo(76, 50);
  g.fill();
  g.fillStyle = '#fff';
  g.font = 'bold 34px "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 30);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  sp.scale.set(1.3, 0.65, 1);
  sp.renderOrder = 10;
  return sp;
}

// 两位玩家的识别色：底盘灯、头顶标签、冲刺光环
export const PLAYER_COLORS = [{ css: '#16b8e8', glow: [0.25, 0.9, 1.0], hex: 0x66e0ff }, { css: '#ff8a1f', glow: [1.0, 0.5, 0.12], hex: 0xffa53a }];

export class PlayerController {
  /** opts.index：0 = 玩家 1，1 = 玩家 2；opts.skin：'p2' = 玩家 2 的车漆 */
  constructor(scene, events = {}, { index = 0, skin = null } = {}) {
    this.scene = scene;
    this.events = events; // { onDashStart, onDashEnd, onHit, onBump, onShieldBreak, onLand, onLaunch, onWater }
    this.index = index;
    this.skin = skin;
    this.color = PLAYER_COLORS[index];
    this.mesh = null;
    this.tag = tagSprite('P' + (index + 1), this.color.css);
    this.tag.visible = false;
    // 霓虹底盘灯：车底一片柔和的发光，平时淡淡的，冲刺时变成很亮的 HDR 光（会被 Bloom 放大）
    this.aura = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: GLOW_TEX, color: 0x46e6ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.aura.renderOrder = 2;
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
    this.onWater = false;
    this.waterY = 0; // 船在水面上的视觉高度偏移（平滑过渡）
    this.setTier(0);
    this.lane = 1;
    this.lateral = laneOffset(this.lane);
    this.latVel = 0;
    this.knockVel = 0;
    this.z = 0;
    this.y = 0;
    this.vy = 0;
    this.speed = this.stats.baseSpeed * RUN.pace;
    this.speedBias = 0;
    this.hp = this.stats.maxHp;
    this.shields = 0;
    this.invuln = 0;
    this.isDashing = false;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.rampage = 0; // 暴走模式剩余秒数
    this.sizeMul = 1;
    this.alive = true;
    this.draft = 0; // 双人对战：落后的一方获得的追赶加速（米/秒）
    // 这一局的成绩（每位玩家各自一份）
    this.score = 0;
    this.distance = 0;
    this.kills = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.fever = 0;
    this.bust = 0;
    this.dashKills = 0;
    this.syncMesh(0);
  }

  /** 换车：替换模型和碰撞尺寸，光环和护盾挂到新模型上 */
  setTier(index) {
    this.tierIndex = index;
    this.tier = TIERS[index];
    if (this.mesh) this.scene.remove(this.mesh);
    // 海上：同一个进化等级的快艇版本（跑车 → 红色快艇 … 坦克 → 炮艇）
    this.mesh = this.onWater ? makePlayerBoat(this.tier.id, this.tier.length, this.tier.width, this.skin) : this.tier.model(this.skin);
    this.root = this.mesh.userData.root;
    this.turret = this.mesh.userData.turret ?? null;
    this.muzzle = this.mesh.userData.muzzle ?? null;
    this.length = this.tier.length;
    this.width = this.tier.width;
    this.aura.scale.set(this.width * 2.4, 1, this.length * 1.7);
    this.aura.position.y = 0.08;
    this.bubble.scale.set(this.width * 0.9 + 0.6, 1.8, this.length * 0.65 + 0.4);
    this.bubble.position.y = 0.9;
    this.tag.position.y = (this.mesh.userData.topY ?? 1.6) + 1.6;
    this.root.add(this.aura, this.bubble, this.tag);
    this.scene.add(this.mesh);
  }

  /** 下水变快艇 / 上岸变回汽车：只换模型，血量、升级、冲刺这些都保留 */
  setWater(on) {
    if (on === this.onWater) return;
    this.onWater = on;
    this.setTier(this.tierIndex);
    this.syncMesh(0);
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
    if (this.isDashing || this.rampage > 0) return 'PlayerDash'; // 暴走中和冲刺一样，撞什么炸什么
    return this.tier.ram ? 'PlayerRam' : 'Player';
  }
  get smashes() { return this.collisionTag !== 'Player'; }
  get airborne() { return this.y > 0.6; }
  get colW() { return this.width * this.sizeMul; }
  get colL() { return this.length * this.sizeMul; }
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

  /** 暴走模式：车身变大、无敌、加速，撞到的一切都会爆炸 */
  startRampage(seconds) {
    this.rampage = seconds;
    this.events.onRampageStart?.(this);
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
    if (this.isDashing || this.rampage > 0) return;
    // 高难度下重型车辆撞车很伤：坦克也不是无敌的，掉到 0 血会直接报废
    this.hp = Math.max(0, this.hp - damage * RUN.diff.ramCost);
    if (this.hp <= 0) {
      this.alive = false;
      this.events.onHit?.(this, damage);
    }
  }

  /** 被撞：返回 true 表示真的受到了伤害（冲刺/无敌帧/护盾时免疫） */
  hit(damage, pushDir = 0, speedMul = 0.6) {
    if (!this.alive || this.isDashing || this.rampage > 0 || this.invuln > 0) return false;
    if (this.shields > 0) {
      // 护盾抵挡这一次伤害
      this.shields--;
      this.invuln = P.hitInvuln;
      this.events.onShieldBreak?.(this);
      return false;
    }
    damage *= RUN.diff.dmg;
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
    if (this.rampage > 0 && (this.rampage -= dt) <= 0) {
      this.rampage = 0;
      this.events.onRampageEnd?.(this);
    }
    this.sizeMul = damp(this.sizeMul, this.rampage > 0 ? 1.35 : 1, 6, dt);

    // 纵向速度：滑动产生的速度偏移逐渐回落到巡航速度
    const st = this.stats, cruise = st.baseSpeed + this.tier.speed;
    const decay = P.biasDecay * dt;
    this.speedBias = Math.abs(this.speedBias) <= decay ? 0 : this.speedBias - Math.sign(this.speedBias) * decay;
    const pace = RUN.pace; // 速度分级：开局慢，分数越高越快
    let target = clamp((cruise + this.speedBias) * pace, P.minSpeed * pace, (st.maxSpeed + this.tier.speed) * pace) + this.draft * pace;
    if (this.isDashing) target *= P.dash.speedMul;
    else if (this.rampage > 0) target *= 1.3;
    if (!this.alive) target = 0;
    const rate = target > this.speed ? (this.isDashing ? P.accel * 5 : P.accel) : P.brake;
    this.speed += clamp(target - this.speed, -rate * dt, rate * dt);

    // 码头：开到码头尽头的跳台自动飞起来下水；海上快到对岸时冲上滑道飞回陆地
    if (this.alive && !this.airborne) {
      if (!this.onWater && Road.isWater(this.z + 5.5)) { this.jump(SEA.launchPower); this.events.onLaunch?.(this, 'sea'); }
      else if (this.onWater && !Road.isWater(this.z + 9)) { this.jump(SEA.landPower); this.events.onLaunch?.(this, 'land'); }
    }
    const water = Road.isWater(this.z);
    if (water !== this.onWater) {
      this.setWater(water);
      this.events.onWater?.(this, water);
    }

    // 横向：指数平滑到目标车道 + 被撞时的击退速度（空中不能变道）；船在水上转向更“飘”
    const prev = this.lateral;
    const sharp = P.laneSharpness * (this.onWater ? 0.7 : 1);
    if (!this.airborne) this.lateral = damp(this.lateral, laneOffset(this.lane), sharp, dt) + this.knockVel * dt;
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
    this.waterY = damp(this.waterY, this.onWater ? WATER_Y - 0.12 : 0, 8, dt);
    const t = performance.now() * 0.001;
    const bob = this.onWater && this.y <= 0 ? Math.sin(t * 2.2) * 0.06 : 0;
    m.position.set(w.x, this.y + this.waterY + bob, w.z);
    // 车头朝向 = 道路切线方向 + 变道时的转向角
    m.rotation.y = w.h + Math.atan2(this.latVel, Math.max(this.speed, 5)) * 0.9;
    // 车身侧倾 / 加速时抬头 / 空中车头上扬再下压；快艇高速滑行时船头翘起、变道时侧倾更大
    let pitch = this.y > 0 ? clamp(-this.vy * 0.02, -0.3, 0.3) : this.isDashing ? -0.05 : 0;
    let roll = clamp(-this.latVel * 0.025, -0.12, 0.12);
    if (this.onWater && this.y <= 0) {
      pitch = -0.05 - Math.min(0.07, this.speed * 0.0022) - (this.isDashing ? 0.05 : 0) + Math.sin(t * 2.7) * 0.02;
      roll = clamp(-this.latVel * 0.045, -0.22, 0.22) + Math.sin(t * 1.7) * 0.035;
    }
    this.root.rotation.z = damp(this.root.rotation.z, roll, 10, dt);
    this.root.rotation.x = damp(this.root.rotation.x, pitch, 8, dt);
    // 冲刺光环、护盾、受伤闪烁
    m.scale.setScalar(this.sizeMul);
    const pulse = Math.sin(performance.now() * 0.03);
    if (this.rampage > 0) this.aura.material.color.setRGB(3.2 + pulse, 0.3, 2.4 + pulse * 0.6); // 暴走：粉色霓虹
    else {
      const glow = this.isDashing ? 2.6 + 0.6 * pulse : 0.55, c = this.color.glow;
      this.aura.material.color.setRGB(c[0] * glow, c[1] * glow, c[2] * glow);
    }
    this.bubble.visible = this.shields > 0 && !this.firstPerson; // 第一人称时护盾罩在镜头外面会挡视线
    if (this.shields > 0) {
      this.bubble.rotation.y += dt * 1.5;
      this.bubble.material.opacity = 0.18 + 0.06 * this.shields;
    }
    m.visible = !(this.invuln > 0 && Math.floor(this.invuln * 20) % 2 === 0);
  }
}
