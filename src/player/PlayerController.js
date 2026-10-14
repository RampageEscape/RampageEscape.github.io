import { CONFIG } from '../config.js';
import { Road, ROAD_HALF, laneOffset, nearestLane } from '../world/Road.js';
import { clamp, damp } from '../core/utils.js';
import { makePlayerCar } from '../models/Models.js';

const P = CONFIG.player;
const LANES = CONFIG.road.lanes;

/**
 * 玩家控制器
 *  - 左/右滑：变道（平滑插值到目标车道）
 *  - 上/下滑：加速 / 刹车（速度偏移量随时间回落到巡航速度）
 *  - 冲刺 Dash：短时间加速 + 无敌，碰撞标签从 'Player' 变成 'PlayerDash'
 */
export class PlayerController {
  constructor(scene, events = {}) {
    this.events = events; // { onDashStart, onDashEnd, onHit }
    this.mesh = makePlayerCar();
    this.root = this.mesh.userData.root;
    this.aura = this.mesh.userData.aura;
    scene.add(this.mesh);
    this.length = P.length;
    this.width = P.width;
    this.reset();
  }

  reset() {
    this.lane = 1;
    this.lateral = laneOffset(this.lane);
    this.latVel = 0;
    this.knockVel = 0;
    this.z = 0;
    this.speed = P.baseSpeed;
    this.speedBias = 0;
    this.hp = P.maxHp;
    this.invuln = 0;
    this.isDashing = false;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.alive = true;
    this.mesh.visible = true;
    this.root.rotation.set(0, 0, 0);
    this.syncMesh(0);
  }

  // ---- 碰撞系统读取的属性 ----
  get collisionTag() { return this.isDashing ? 'PlayerDash' : 'Player'; }
  get colW() { return this.width; }
  get colL() { return this.length; }
  get dashReady() { return this.alive && !this.isDashing && this.dashCooldown <= 0; }
  get dashCharge() { return this.isDashing ? 1 : 1 - this.dashCooldown / P.dash.cooldown; }

  handleSwipe(dir) {
    if (!this.alive) return;
    // 镜头在车后方：+X 是屏幕左侧，所以“左滑”是车道编号 +1
    if (dir === 'left') this.lane = Math.min(LANES - 1, this.lane + 1);
    else if (dir === 'right') this.lane = Math.max(0, this.lane - 1);
    else if (dir === 'up') this.speedBias = Math.min(P.maxBias, this.speedBias + P.swipeUpBias);
    else if (dir === 'down') this.speedBias = Math.max(-P.maxBias, this.speedBias + P.swipeDownBias);
  }

  tryDash() {
    if (!this.dashReady) return false;
    this.isDashing = true;
    this.dashTimer = P.dash.duration;
    this.invuln = 0;
    this.events.onDashStart?.(this);
    return true;
  }

  // 冲刺中每撞毁一辆警车，冲刺时间延长一点 → 鼓励连续撞击（连击）
  extendDash() {
    if (this.isDashing) this.dashTimer = Math.min(this.dashTimer + P.dash.extendOnKill, P.dash.duration * 1.5);
  }

  endDash() {
    this.isDashing = false;
    this.dashCooldown = P.dash.cooldown;
    this.events.onDashEnd?.(this);
  }

  /** 被撞：返回 true 表示真的受到了伤害（冲刺/无敌帧时免疫） */
  hit(damage, pushDir = 0, speedMul = 0.6) {
    if (!this.alive || this.isDashing || this.invuln > 0) return false;
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
      const cap = P.maxSpeed * B.maxSpeedMul * (this.isDashing ? P.dash.speedMul : 1);
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
    const decay = P.biasDecay * dt;
    this.speedBias = Math.abs(this.speedBias) <= decay ? 0 : this.speedBias - Math.sign(this.speedBias) * decay;
    let target = clamp(P.baseSpeed + this.speedBias, P.minSpeed, P.maxSpeed);
    if (this.isDashing) target *= P.dash.speedMul;
    if (!this.alive) target = 0;
    const rate = target > this.speed ? (this.isDashing ? P.accel * 5 : P.accel) : P.brake;
    this.speed += clamp(target - this.speed, -rate * dt, rate * dt);

    // 横向：指数平滑到目标车道 + 被撞时的击退速度
    const prev = this.lateral;
    this.lateral = damp(this.lateral, laneOffset(this.lane), P.laneSharpness, dt) + this.knockVel * dt;
    this.knockVel = damp(this.knockVel, 0, 6, dt);
    const lim = ROAD_HALF - this.width / 2 - 0.1;
    this.lateral = clamp(this.lateral, -lim, lim);
    this.latVel = dt > 0 ? (this.lateral - prev) / dt : 0;

    this.z += this.speed * dt;
    this.syncMesh(dt);
  }

  syncMesh(dt) {
    const m = this.mesh;
    m.position.set(Road.centerX(this.z) + this.lateral, 0, this.z);
    // 车头朝向 = 道路切线方向 + 变道时的转向角
    m.rotation.y = Road.heading(this.z) + Math.atan2(this.latVel, Math.max(this.speed, 5)) * 0.9;
    // 车身侧倾 / 加速时抬头
    this.root.rotation.z = damp(this.root.rotation.z, clamp(-this.latVel * 0.025, -0.12, 0.12), 10, dt);
    this.root.rotation.x = damp(this.root.rotation.x, this.isDashing ? -0.05 : 0, 8, dt);
    // 冲刺光环 & 受伤闪烁
    this.aura.visible = this.isDashing;
    if (this.isDashing) this.aura.material.opacity = 0.25 + 0.15 * Math.sin(performance.now() * 0.03);
    m.visible = !(this.invuln > 0 && Math.floor(this.invuln * 20) % 2 === 0);
  }
}
