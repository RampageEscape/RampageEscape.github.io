import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { laneOffset, nearestLane } from '../world/Road.js';
import { classifyContact, pushApart } from '../systems/Collisions.js';
import { Vehicle } from '../entities/Vehicle.js';
import { makeCivilian, makeBarrier, makeCone, makeSpikeStrip } from '../models/Models.js';
import { makeCivilianBoat, makeBuoy, makeFloatBarrier, makeSeaMine } from '../models/Boats.js';
import { RUN } from '../data/difficulty.js';
import { damp, rand } from '../core/utils.js';

const LANES = CONFIG.road.lanes;

/** 无辜的民用车辆：比玩家慢，保持车道，偶尔变道，前方有障碍会刹车/绕开 */
export class Civilian extends Vehicle {
  constructor() {
    const mesh = makeCivilian();
    super(mesh, mesh.userData.dims.L, mesh.userData.dims.W);
    this.type = 'civilian';
    this.kind = mesh.userData.kind;
  }

  makeBoat() {
    return makeCivilianBoat(this.length, this.width);
  }

  spawnCivilian(scene, z, lane, speed) {
    this.spawn(scene, z, laneOffset(lane), speed);
    this.mode = 'drive';
    this.oncoming = false;
    this.lane = lane;
    this.cruise = speed;
    this.laneTimer = rand(3, 8);
  }

  /** 逆行来车：车头朝向玩家，速度为负（沿道路往回开） */
  spawnOncoming(scene, z, lane, speed) {
    this.spawnCivilian(scene, z, lane, -speed);
    this.oncoming = true;
    this.yawOffset = Math.PI;
    this.sync();
  }

  /** 逆行车：直线冲过来；自己车道前方（更小的 z）有车挡着就换到空一点的相邻车道 */
  updateOncoming(dt, hazards) {
    let blocked = false;
    for (const o of hazards) {
      if (o === this || !o.collidable || o.oncoming) continue;
      const d = this.z - o.z;
      if (d > 0 && d < 26 && Math.abs(o.lateral - this.lateral) < 2.4) blocked = true;
    }
    if (blocked && (this.laneTimer -= dt) <= 0) {
      this.laneTimer = 0.8;
      const opts = [this.lane - 1, this.lane + 1].filter((l) => l >= 0 && l < LANES);
      this.lane = opts[Math.floor(Math.random() * opts.length)] ?? this.lane;
    }
    const prevLat = this.lateral, goal = laneOffset(this.lane);
    this.lateral = damp(this.lateral, goal, 3, dt);
    this.latVel = dt > 0 ? (this.lateral - prevLat) / dt : 0;
    this.yawOffset = Math.PI - (goal - this.lateral) * 0.06;
    this.z += this.speed * dt;
    this.sync();
  }

  update(dt, { hazards, fx }) {
    if (this.state === 'wreck') return this.updateWreck(dt, fx);
    if (this.oncoming) return this.updateOncoming(dt, hazards);
    let target = this.cruise;
    for (const o of hazards) {
      if (o === this || !o.collidable) continue;
      const ahead = o.z - this.z;
      if (ahead > 0 && ahead < 14 && Math.abs(o.lateral - this.lateral) < 2.4) {
        target = Math.min(target, Math.max(0, (o.speed || 0) - 1));
        if (target < 2) this.laneTimer = Math.min(this.laneTimer, 0.3); // 堵住了就换道
      }
    }
    this.speed = damp(this.speed, target, 2, dt);
    if ((this.laneTimer -= dt) <= 0) {
      this.laneTimer = rand(4, 9);
      const next = this.lane + (Math.random() < 0.5 ? -1 : 1);
      if (next >= 0 && next < LANES) this.lane = next;
    }
    const goal = laneOffset(this.lane);
    const prevLat = this.lateral;
    this.lateral = damp(this.lateral, goal, 2.5, dt);
    this.latVel = dt > 0 ? (this.lateral - prevLat) / dt : 0; // 碰撞判定要用：谁在变道
    this.yawOffset = (goal - this.lateral) * 0.06;
    this.z += this.speed * dt;
    this.sync();
  }

  onPlayerCollision(player, game) {
    if (player.smashes) {
      this.knock(player, game, this.oncoming ? 1.6 : 1.2);
      if (!player.isDashing) player.ramImpact(this.oncoming ? 3 : 1);
      game.onPropSmashed(this, CONFIG.score.civilian * (this.oncoming ? 4 : 1), player);
      return;
    }
    const c = classifyContact(player, this);
    if (this.oncoming) {
      // 迎面相撞：伤害很大，速度几乎归零，两车都被弹开
      const headOn = c.type === 'front';
      player.hit(CONFIG.heat.oncomingDamage * (headOn ? 1 : 0.4), headOn ? 0 : -c.side * 0.8, headOn ? 0.25 : 0.7);
      this.knock(player, game, headOn ? 1.5 : 0.8);
      game.fx.explosion(this.mesh.position, headOn ? 0.8 : 0.4);
      game.onHeadOn?.(player, headOn);
      return;
    }
    if (c.playerAtFault) {
      // 玩家追尾前车，或自己变道撞上 → 扣血
      player.hit(CONFIG.traffic.damage, c.type === 'side' ? -c.side * 0.6 : 0, 0.75);
      this.knock(player, game, 0.6);
      game.onPropSmashed(this, CONFIG.score.civilian, player);
    } else {
      // 民用车自己变道挤过来 → 不扣血，民用车放弃变道退回去
      player.bump(c.type === 'side' ? -c.side : 0, c.type === 'rear' ? CONFIG.bump.rearBoost : 0);
      this.lane = nearestLane(this.lateral + c.side * CONFIG.road.laneWidth * 0.5);
      pushApart(player, this, c);
      game.onPlayerBumped(player);
    }
  }
}

/** 静态障碍：路障栏杆、雪糕筒、钉刺带 */
const OBSTACLES = {
  cone: { make: makeCone, boat: makeBuoy, L: 0.7, W: 0.7 },
  barrier: { make: makeBarrier, boat: makeFloatBarrier, L: 0.7, W: 3.2 },
  spikes: { make: makeSpikeStrip, boat: makeSeaMine, L: 0.9, W: 3.3 },
};
export class Obstacle extends Vehicle {
  constructor(kind) {
    const o = OBSTACLES[kind];
    super(o.make(), o.L, o.W);
    this.type = kind;
  }

  /** 海上：雪糕筒 → 浮标，路障 → 浮动路障，钉刺带 → 水雷 */
  makeBoat() {
    return OBSTACLES[this.type].boat();
  }

  spawnStatic(scene, z, lateral) {
    this.spawn(scene, z, lateral, 0);
    this.mode = 'static';
    this.spiked = [];
  }

  update(dt, { fx }) {
    if (this.state === 'wreck') this.updateWreck(dt, fx);
  }

  onPlayerCollision(player, game) {
    const dash = player.smashes;
    if (this.type === 'spikes') {
      // 钉刺带：每位玩家只触发一次；冲刺 / 暴走 / 坦克直接压过去没事
      if (this.spiked[player.index]) return;
      this.spiked[player.index] = true;
      if (this.onWater) { this.knock(player, game, 1); game.fx.explosion(this.mesh.position, 0.9); }
      if (player.isDashing || player.rampage > 0 || player.tier.tankKill) return;
      player.hit(CONFIG.heat.spikesDamage, 0, 0.45);
      game.onSpikes?.(player, this);
      return;
    }
    if (!dash && this.type === 'barrier') player.hit(CONFIG.barricade.damage * 0.5, 0, 0.7);
    this.knock(player, game, dash ? 1.3 : 0.9);
    game.onPropSmashed(this, CONFIG.score.prop, player);
  }

  knock(by, game, s = 1) {
    if (this.state === 'wreck' || (this.type === 'spikes' && !this.onWater)) return; // 钉刺带贴在地上，撞不飞
    this.launch(
      new THREE.Vector3(rand(-6, 6), rand(7, 12) * s, (by?.speed ?? 20) * 0.9),
      new THREE.Vector3(rand(-10, 10), rand(-10, 10), rand(-10, 10)),
    );
    game.fx.impact(this.mesh.position, 0.7);
  }
}
