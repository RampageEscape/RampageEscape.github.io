import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ROAD_HALF } from '../world/Road.js';
import { Vehicle } from '../entities/Vehicle.js';
import { makePoliceCar, makeSwat } from '../models/Models.js';
import { clamp, damp, rand } from '../core/utils.js';

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

  spawnChaser(scene, z, lateral, speed, role) {
    this.spawn(scene, z, lateral, speed);
    this.mode = 'chase';
    this.role = role;
    this.ramTimer = rand(0.8, 2);
    this.skill = rand(0.55, 1); // 避障能力，低的容易被引诱撞车
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
    if (this.role === 0) {
      desiredGap = 10;
      const ahead = rel > (this.length + player.length) / 2 + 1.5;
      desiredLat = ahead ? predLat : flankLat; // 先从旁边超车，超过去再并线挡路
    } else if (this.role === 2) {
      desiredGap = this.ramTimer <= 0 ? 0 : -7;
      desiredLat = predLat;
    } else {
      desiredGap = 0;
      desiredLat = flankLat;
    }

    // 3) 纵向速度：P 控制追到目标间距，最高速度有上限 → 玩家冲刺时能甩开
    let desiredSpeed = player.speed + clamp((player.z + desiredGap - this.z) * 1.4, -14, S.catchUp);
    if (this.role === 0 && rel > 3 && Math.abs(this.lateral - player.lateral) < 2.5) {
      desiredSpeed = Math.min(desiredSpeed, player.speed - 5); // 挡在前面刹车逼停
    }
    desiredSpeed = Math.min(desiredSpeed, CONFIG.player.baseSpeed + S.catchUp + 6);

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

    const accel = desiredSpeed > this.speed ? 22 : 30;
    this.speed += clamp(desiredSpeed - this.speed, -accel * dt, accel * dt);
    this.z += this.speed * dt;
    this.yawOffset = Math.atan2(this.latVel, Math.max(this.speed, 5)) * 0.8;
  }

  /** 与玩家碰撞（由 Collisions 系统调用） */
  onPlayerCollision(player, game) {
    // 关键机制：玩家处于冲刺状态（碰撞标签 PlayerDash）→ 警车瞬间被摧毁
    if (player.collisionTag === 'PlayerDash') {
      this.explode(game, player);
      return;
    }
    if (this.mode === 'parked') {
      // 没冲刺硬闯路障：扣大量血，警车被顶开
      player.hit(CONFIG.barricade.damage, 0, 0.45);
      this.knock(player, game, 0.5);
      return;
    }
    const dz = player.z - this.z;
    const sideHit = Math.abs(dz) < (this.colL + player.colL) * 0.35;
    if (sideHit) {
      const dir = Math.sign(player.lateral - this.lateral) || 1;
      player.hit(this.spec.damage, dir * 0.8, 0.85);
      this.latVel = -dir * 5;
      this.lateral -= dir * 0.3;
    } else if (dz > 0) {
      // 警车从后面追尾
      player.hit(this.spec.damage, 0, 1);
      this.speed = player.speed - 10;
      this.z = player.z - (this.colL + player.colL) / 2 - 0.3;
    } else {
      // 玩家撞上前面的拦截警车
      player.hit(this.spec.damage * 1.3, 0, 0.55);
      this.speed = player.speed + 6;
      this.z = player.z + (this.colL + player.colL) / 2 + 0.3;
    }
    this.ramTimer = this.spec.ramCooldown;
    game.fx.impact(player.mesh.position, 0.6);
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
    if (by === game.player && strength < 1) return super.knock(by, game, strength);
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
    game.fx.explosion(this.mesh.position, power, fwd);
    game.onEnemyDestroyed(this, power, source === game.player ? 'dash' : 'crash');
  }
}
