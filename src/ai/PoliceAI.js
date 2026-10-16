import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Road, ROAD_HALF } from '../world/Road.js';
import { Vehicle } from '../entities/Vehicle.js';
import { makePoliceCar, makeSwat } from '../models/Models.js';
import { makePoliceBoat } from '../models/Boats.js';
import { clamp, damp, lerp, rand, smoothstep } from '../core/utils.js';
import { classifyContact, pushApart } from '../systems/Collisions.js';
import { RUN } from '../data/difficulty.js';

/**
 * 警车 AI（普通警车 / 特警车 SWAT 共用）
 *
 * mode:
 *   'chase'  —— 追捕。按 role 分工包夹玩家：
 *               role  1 / -1 : 侧翼，开到玩家左/右侧并排，冷却好了就横向撞击
 *               role  0      : 拦截者，超车到玩家前方，再刹车逼停
 *               role  2      : 追尾者，紧跟在后面找机会顶撞
 *   'parked' —— 路障里横停的警车，不动
 *
 * 寻路：无尽跑酷的道路是程序生成的，用不了烘焙 NavMesh，
 * 所以用“道路坐标系里的转向行为”（Seek + 预测 + 避障），对弯道天然适用。
 */
export class PoliceAI extends Vehicle {
  constructor(type = 'police') {
    const spec = { ...CONFIG.police, ...(type === 'swat' ? CONFIG.swat : {}) };
    super(type === 'swat' ? makeSwat() : makePoliceCar(), spec.length, spec.width);
    this.type = type;
    this.spec = spec;
  }

  /** 海上：水警船 / 特警船 */
  makeBoat() {
    return makePoliceBoat(this.type === 'swat', this.length, this.width);
  }

  spawnChaser(scene, z, lateral, speed, role) {
    this.spawn(scene, z, lateral, speed);
    this.mode = 'chase';
    this.role = role;
    this.ramTimer = rand(0.8, 2);
    this.skill = rand(0.55, 1); // 避障能力，低的容易被引诱撞车
    this.refSpeed = speed; // 警车“感知到”的玩家速度（低通滤波）
    this.closeTime = 0; // 在危险范围内黏了多久
    this.backoff = 0; // 主动退让的剩余时间
  }

  spawnParked(scene, z, lateral, yaw) {
    this.spawn(scene, z, lateral, 0);
    this.mode = 'parked';
    this.yawOffset = yaw;
    // 横停时碰撞盒的长宽对调
    this.colW = this.length * 0.85;
    this.colL = this.width * 1.5;
    this.sync();
  }

  update(dt, ctx) {
    if (this.state === 'wreck') return this.updateWreck(dt, ctx.fx);
    if (this.mode === 'chase') this.pursue(dt, ctx);
    this.sync();
  }

  pursue(dt, { player, hazards }) {
    const S = this.spec;
    const lim = ROAD_HALF - this.width / 2 - 0.1;
    const rel = this.z - player.z; // >0 表示警车在玩家前面

    // 1) 预测玩家的横向位置（提前量追踪）
    const predLat = clamp(player.lateral + player.latVel * S.lookAhead, -lim, lim);
    const side = this.role === 1 || this.role === -1 ? this.role : Math.sign(this.lateral - player.lateral) || 1;
    const beside = (this.width + player.width) / 2 + 0.5;
    let flankLat = predLat + side * beside;
    if (Math.abs(flankLat) > lim) flankLat = predLat - side * beside; // 这一侧没路了，换另一侧

    // 2) 按角色决定目标位置
    let desiredLat, desiredGap;
    const ahead = rel > (this.length + player.length) / 2 + 1.5;
    if (this.role === 0) {
      desiredGap = 10;
      desiredLat = ahead ? predLat : flankLat; // 先从旁边超车，超过去再并线挡路
    } else if (this.role === 2) {
      desiredGap = this.ramTimer <= 0 ? 0 : -7;
      desiredLat = predLat;
    } else {
      desiredGap = 0;
      desiredLat = flankLat;
    }

    // 3) 纵向速度：橡皮筋机制（远快近慢）
    const overtaking = this.role === 0 && !ahead; // 拦截者正在超车，不算“黏住”
    let desiredSpeed = this.rubberBandSpeed(dt, player, desiredGap, overtaking);
    if (this.role === 0 && ahead && this.backoff <= 0 && Math.abs(this.lateral - player.lateral) < 2.5) {
      desiredSpeed = Math.min(desiredSpeed, this.refSpeed - 3); // 挡在前面轻踩刹车：看得见、躲得开
    }

    // 4) 避障：找正前方最近的障碍物，从旁边绕开；两边都没空间就减速
    const look = (12 + Math.max(0, this.speed - 10) * 0.5) * this.skill;
    let nearest = null, nearestDist = look;
    for (const o of hazards) {
      if (o === this || !o.collidable || o.mode === 'chase') continue;
      const ahead = o.z - this.z;
      if (ahead <= 0 || ahead >= nearestDist) continue;
      const clear = (o.colW + this.width) / 2 + 0.6;
      if (Math.abs(o.lateral - this.lateral) < clear || Math.abs(o.lateral - desiredLat) < clear) {
        nearest = o;
        nearestDist = ahead;
      }
    }
    if (nearest) {
      const clear = (nearest.colW + this.width) / 2 + 0.8;
      const s = Math.sign(this.lateral - nearest.lateral) || 1;
      let alt = nearest.lateral + s * clear;
      if (Math.abs(alt) > lim) alt = nearest.lateral - s * clear;
      if (Math.abs(alt) > lim) desiredSpeed = Math.min(desiredSpeed, nearest.speed || 0);
      else desiredLat = alt;
    }

    // 5) 横向转向 + 撞击
    this.ramTimer -= dt;
    const wantLatVel = clamp((desiredLat - this.lateral) * S.steerGain, -S.maxLatSpeed, S.maxLatSpeed);
    this.latVel = damp(this.latVel, wantLatVel, 4, dt);
    if (this.role !== 2 && this.ramTimer <= 0 && Math.abs(rel) < 2.6 && Math.abs(player.lateral - this.lateral) < 4.6) {
      this.latVel = Math.sign(player.lateral - this.lateral) * S.ramImpulse;
      this.ramTimer = S.ramCooldown * rand(0.8, 1.4);
    }
    this.lateral = clamp(this.lateral + this.latVel * dt, -lim, lim);

    // 加速柔和（不会“瞬移”追上来）；追逐范围内刹车和玩家一样灵敏，玩家急刹时不会冲上来
    const nearPlayer = Math.abs(rel) < S.rubber.far;
    const accel = desiredSpeed > this.speed ? 14 : nearPlayer ? CONFIG.player.brake + 2 : 20;
    this.speed += clamp(desiredSpeed - this.speed, -accel * dt, accel * dt);
    this.z += this.speed * dt;
    this.yawOffset = Math.atan2(this.latVel, Math.max(this.speed, 5)) * 0.8;
  }

  /**
   * 橡皮筋速度（返回目标速度）
   *   距离 > far        → 玩家速度 + maxBoost：快速拉近，保持追逐压迫感
   *   near < 距离 < far → 加成随距离平滑减小
   *   距离 < near       → 危险范围：与玩家基本同速（-4 ~ +1.5），慢慢贴近，不会瞬间超车
   *   黏住超过 stickTime → 主动退让 backoffTime 秒，给玩家脱战窗口
   * 参照的玩家速度经过低通滤波：玩家突然加速/刹车时，警车反应慢半拍，可以被甩开。
   */
  rubberBandSpeed(dt, player, desiredGap, overtaking) {
    const R = this.spec.rubber;
    // 不对称反应：玩家加速时警车反应慢（能甩开），玩家减速时立刻跟着减（不会趁机冲上来）
    const k = player.speed < this.refSpeed ? R.reaction * 6 : R.reaction;
    this.refSpeed = damp(this.refSpeed, player.speed, k, dt);
    const dist = player.z - this.z; // >0：警车在玩家后面
    const near = Math.abs(dist) < R.near;
    let rel;
    if (this.backoff > 0) {
      this.backoff -= dt;
      // 在玩家后面/旁边 → 减速退后；已经在玩家前面 → 加速让开（不能刹车，否则玩家会撞上来）
      rel = dist < -2 ? -R.backoffRel : R.backoffRel;
    } else if (dist > R.far) {
      rel = R.maxBoost * RUN.diff.speed;
    } else if (dist > R.near) {
      rel = lerp(R.nearMaxRel, R.maxBoost * RUN.diff.speed, smoothstep(R.near, R.far, dist));
    } else {
      const maxRel = this.role === 0 ? R.blockerRel : R.nearMaxRel;
      rel = clamp((player.z + desiredGap - this.z) * 0.5, R.nearMinRel, maxRel);
    }
    // 黏住计时
    if (near && !overtaking && this.backoff <= 0) {
      this.closeTime += dt;
      if (this.closeTime > R.stickTime) {
        this.backoff = R.backoffTime;
        this.closeTime = 0;
      }
    } else {
      this.closeTime = Math.max(0, this.closeTime - dt);
    }
    let speed = Math.min(this.refSpeed + rel, R.absMax * RUN.diff.speed * RUN.pace); // 高难度警车更快，可能追上全速的玩家
    // 危险范围内的硬上限：绝不比玩家当前速度快超过 nearMaxRel（拦截者超车时用 blockerRel）
    if (near && this.backoff <= 0) speed = Math.min(speed, player.speed + (this.role === 0 ? R.blockerRel : R.nearMaxRel));
    return speed;
  }

  /**
   * 与玩家碰撞（由 Collisions 系统调用）。原则：只惩罚玩家的主动失误。
   *   冲刺中            → 警车被摧毁
   *   被追尾 (rear)      → 不扣血，玩家被往前推一把
   *   被警车侧面挤       → 不扣血，只横向推一下
   *   正面撞上前车 / 自己变道撞上去 → 扣血
   */
  onPlayerCollision(player, game) {
    const c = classifyContact(player, this);
    // 冲刺 / 暴走中 → 警车被撞爆；开着装甲车/坦克（PlayerRam）只有正面撞上去才算撞爆，
    // 被侧挤、被追尾时照常处理 → 重型车辆也会被包夹、被捕
    if (player.collisionTag === 'PlayerDash' || (player.smashes && (c.type === 'front' || this.mode === 'parked'))) {
      this.explode(game, player);
      if (!player.isDashing && player.rampage <= 0) player.ramImpact(this.type === 'swat' ? 8 : 4);
      return;
    }
    if (this.mode === 'parked') {
      // 路障警车是静止的，碰到它一定是玩家自己开过去的
      const front = c.type === 'front';
      player.hit(CONFIG.barricade.damage * (front ? 1 : 0.5), front ? 0 : -c.side * 0.6, front ? 0.45 : 0.8);
      this.knock(player, game, 0.5);
      return;
    }
    if (c.type === 'rear') {
      player.bump(0, CONFIG.bump.rearBoost);
      this.speed = player.speed - 6; // 警车被弹回去
      game.onPlayerBumped(player);
    } else if (c.type === 'side' && !c.playerAtFault) {
      // 普通难度被侧挤不扣血；困难/地狱难度会扣一部分
      if (RUN.diff.sideRam > 0) player.hit(this.spec.damage * RUN.diff.sideRam, -c.side * 0.8, 0.85);
      else player.bump(-c.side, 0);
      this.latVel = c.side * 4;
      game.onPlayerBumped(player);
    } else {
      const front = c.type === 'front';
      player.hit(this.spec.damage * (front ? 1.3 : 1), front ? 0 : -c.side * 0.8, front ? 0.55 : 0.85);
      if (front) this.speed = player.speed + 6;
      else this.latVel = c.side * 5;
      game.fx.impact(player.mesh.position, 0.6);
    }
    pushApart(player, this, c);
    this.ramTimer = this.spec.ramCooldown;
  }

  /** 追捕中撞上别的东西（被玩家引诱去撞民用车、路障、坦克） */
  crashInto(o, game) {
    const rel = this.speed - (o.speed || 0);
    if (o.type === 'tank' || o.mode === 'parked' || o.mode === 'static' || rel > 6) {
      this.explode(game, o);
      o.knock?.(this, game, 0.8);
    } else {
      this.latVel = (Math.sign(this.lateral - o.lateral) || 1) * 4;
      this.speed = Math.min(this.speed, o.speed);
    }
  }

  // 警车被别的车撞到 = 直接爆炸（可以形成连锁反应）
  knock(by, game, strength) {
    if (game.isPlayer(by) && strength < 1) return super.knock(by, game, strength);
    this.explode(game, by);
  }

  /** 爆炸：从对象池“实例化”粒子特效，自身切换为残骸，飞完后由 Spawner 回收 */
  explode(game, source) {
    if (this.state === 'wreck') return;
    const power = this.type === 'swat' ? 1.5 : 1;
    const dir = (source && Math.sign(this.lateral - source.lateral)) || (Math.random() < 0.5 ? -1 : 1);
    const fwd = (source?.speed ?? this.speed) * 0.55;
    this.launch(
      new THREE.Vector3(dir * rand(6, 11), rand(13, 19) / Math.sqrt(power), fwd),
      new THREE.Vector3(rand(-6, 6), rand(-5, 5), dir * rand(4, 9)),
    );
    this.burning = true;
    game.fx.explosion(this.mesh.position, power, fwd, Road.heading(this.z));
    game.onEnemyDestroyed(this, power, game.isPlayer(source) ? 'dash' : 'crash', source);
  }
}
