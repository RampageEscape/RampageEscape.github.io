import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { laneOffset } from '../world/Road.js';
import { Vehicle } from '../entities/Vehicle.js';
import { makeCivilian, makeBarrier, makeCone } from '../models/Models.js';
import { damp, rand } from '../core/utils.js';

const LANES = CONFIG.road.lanes;

/** 无辜的民用车辆：比玩家慢，保持车道，偶尔变道，前方有障碍会刹车/绕开 */
export class Civilian extends Vehicle {
  constructor() {
    const mesh = makeCivilian();
    super(mesh, mesh.userData.dims.L, mesh.userData.dims.W);
    this.type = 'civilian';
  }

  spawnCivilian(scene, z, lane, speed) {
    this.spawn(scene, z, laneOffset(lane), speed);
    this.mode = 'drive';
    this.lane = lane;
    this.cruise = speed;
    this.laneTimer = rand(3, 8);
  }

  update(dt, { hazards, fx }) {
    if (this.state === 'wreck') return this.updateWreck(dt, fx);
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
    this.lateral = damp(this.lateral, goal, 2.5, dt);
    this.yawOffset = (goal - this.lateral) * 0.06;
    this.z += this.speed * dt;
    this.sync();
  }

  onPlayerCollision(player, game) {
    const dash = player.collisionTag === 'PlayerDash';
    if (!dash) player.hit(CONFIG.traffic.damage, -(Math.sign(this.lateral - player.lateral) || 1) * 0.6, 0.75);
    this.knock(player, game, dash ? 1.2 : 0.6);
    game.onPropSmashed(this, CONFIG.score.civilian);
  }
}

/** 静态障碍：路障栏杆、雪糕筒 */
export class Obstacle extends Vehicle {
  constructor(kind) {
    super(kind === 'cone' ? makeCone() : makeBarrier(), kind === 'cone' ? 0.7 : 0.7, kind === 'cone' ? 0.7 : 3.2);
    this.type = kind;
  }

  spawnStatic(scene, z, lateral) {
    this.spawn(scene, z, lateral, 0);
    this.mode = 'static';
  }

  update(dt, { fx }) {
    if (this.state === 'wreck') this.updateWreck(dt, fx);
  }

  onPlayerCollision(player, game) {
    const dash = player.collisionTag === 'PlayerDash';
    if (!dash && this.type === 'barrier') player.hit(CONFIG.barricade.damage * 0.5, 0, 0.7);
    this.knock(player, game, dash ? 1.3 : 0.9);
    game.onPropSmashed(this, CONFIG.score.prop);
  }

  knock(by, game, s = 1) {
    if (this.state === 'wreck') return;
    this.launch(
      new THREE.Vector3(rand(-6, 6), rand(7, 12) * s, (by?.speed ?? 20) * 0.9),
      new THREE.Vector3(rand(-10, 10), rand(-10, 10), rand(-10, 10)),
    );
    game.fx.impact(this.mesh.position, 0.7);
  }
}
