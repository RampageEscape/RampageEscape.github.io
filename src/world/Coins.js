import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Road, ROAD_HALF, laneOffset } from './Road.js';
import { rand, randInt } from '../core/utils.js';

/**
 * 金币：路上一串串旋转的金币（直线、S 形绕桩、跳台后面的空中弧线），撞爆运钞车时会喷一地金币。
 *   - 全部用一个 InstancedMesh 画（几百枚也只有一次绘制）
 *   - 连续吃金币有连击：音调越来越高，分数倍率最高 ×5
 *   - 道具“金币磁铁”：附近的金币自己飞过来
 */
const MAX = 360;
const LANES = CONFIG.road.lanes;
const T = CONFIG.thrills;
const G = 30;
const nearJunction = (z) => Road.path.nearJunction(z - 6, z + 40, 30, 40);

// 金币截面：中间略凹、边缘一圈凸起的“币边”，绕 Y 轴旋转成型后转成竖立（面朝前方）
const COIN_GEO = new THREE.LatheGeometry(
  [[0, -0.05], [0.36, -0.05], [0.4, -0.08], [0.5, -0.06], [0.52, 0], [0.5, 0.06], [0.4, 0.08], [0.36, 0.05], [0, 0.05]].map(([x, y]) => new THREE.Vector2(x, y)),
  24,
).rotateX(Math.PI / 2);
const COIN_MAT = new THREE.MeshStandardMaterial({ color: 0xffc23a, metalness: 1, roughness: 0.2, emissive: 0x8a5a00, emissiveIntensity: 0.55 });

const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);

export class Coins {
  constructor(game) {
    this.game = game;
    this.mesh = new THREE.InstancedMesh(COIN_GEO, COIN_MAT, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.count = 0;
    game.scene.add(this.mesh);
    this.list = [];
    this.reset();
  }

  reset() {
    this.list.length = 0;
    this.nextZ = 140;
    this.chain = 0;
    this.chainTimer = 0;
    this.rush = 0; // 挑战“金币狂潮”剩余秒数
    this.spin = 0;
    this.mesh.count = 0;
  }

  add(s, lat, y = 1.0, vel = null) {
    if (this.list.length >= MAX) return;
    this.list.push({ s, lat, y, vel, phase: this.list.length * 0.4 });
  }

  /** 一条车道上的一串金币 */
  line(s, lane, n = 10, gap = 3.2) {
    for (let k = 0; k < n; k++) this.add(s + k * gap, laneOffset(lane));
  }

  /** S 形绕桩：横跨几条车道来回摆 */
  slalom(s, n = 16, gap = 3.4) {
    const mid = laneOffset((LANES - 1) / 2), amp = Math.min(ROAD_HALF - 1.6, CONFIG.road.laneWidth * 1.4), ph = Math.random() * 6;
    for (let k = 0; k < n; k++) this.add(s + k * gap, mid + Math.sin(ph + k * 0.42) * amp);
  }

  /** 跳台后面的空中弧线：按起跳速度算出飞行轨迹，飞起来正好一路吃过去 */
  arc(s, lane, speed) {
    const vy0 = CONFIG.features.jumpPower, lat = laneOffset(lane);
    for (let t = 0.12; t < 1.05; t += 0.09) {
      const y = 0.7 + vy0 * t - (G / 2) * t * t;
      if (y < 0.4) break;
      this.add(s + 5 + speed * t, lat, y + 0.9);
    }
  }

  /** 金币喷泉（运钞车被撞爆）：带速度飞出去，落到路面上 */
  burst(s, lat, n, fwd) {
    for (let k = 0; k < n; k++) {
      this.add(s, lat, 1.4, new THREE.Vector3(rand(-4.5, 4.5), rand(7, 14), fwd + rand(-3, 8)));
    }
  }

  spawnPattern(z) {
    const g = this.game, sp = g.spawner;
    if (sp.inBarricadeZone(z) || sp.inBarricadeZone(z + 50) || nearJunction(z) || z + 60 > (sp.spawnLimit ?? Infinity)) return;
    if (Road.isWater(z) !== Road.isWater(z + 60)) return; // 码头边缘不放
    const r = Math.random();
    if (r < 0.45) this.line(z, randInt(0, LANES - 1), randInt(8, 13));
    else if (r < 0.8) this.slalom(z, randInt(14, 20));
    else {
      // 两条车道各一串，中间换道
      const a = randInt(0, LANES - 1), b = Math.max(0, Math.min(LANES - 1, a + (Math.random() < 0.5 ? -1 : 1)));
      this.line(z, a, 6);
      this.line(z + 26, b, 6);
    }
  }

  update(dt) {
    const g = this.game, lead = g.leader;
    if (g.state === 'playing') {
      this.rush = Math.max(0, this.rush - dt);
      const ahead = lead.z + 170;
      if (ahead > this.nextZ) {
        this.spawnPattern(this.nextZ);
        this.nextZ = Math.max(ahead - 20, this.nextZ) + rand(...(this.rush > 0 ? T.coinRushGap : T.coinGap));
      }
    }
    if (this.chainTimer > 0 && (this.chainTimer -= dt) <= 0) this.chain = 0;
    this.spin += dt * 3.2;

    const trail = g.trailZ - 20;
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const c = this.list[i];
      if (c.s < trail) { this.list.splice(i, 1); continue; }
      // 飞行中的金币（喷泉）：简单抛物线，落地后停住
      if (c.vel) {
        c.vel.y -= G * dt;
        c.s += c.vel.z * dt;
        c.lat = Math.max(-ROAD_HALF + 0.8, Math.min(ROAD_HALF - 0.8, c.lat + c.vel.x * dt));
        c.y += c.vel.y * dt;
        if (c.y <= 0.9 && c.vel.y < 0) { c.y = 0.9; c.vel = null; }
      }
      if (g.state === 'playing' && this.tryCollect(c, dt)) { this.list.splice(i, 1); continue; }
    }
    // 写入实例矩阵
    for (const c of this.list) {
      if (n >= MAX) break;
      const w = Road.sample(c.s, c.lat);
      pos.set(w.x, Road.surfaceY(c.s) + c.y + Math.sin(this.spin * 1.3 + c.phase) * 0.08, w.z);
      q.setFromEuler(e.set(0, w.h + this.spin + c.phase * 0.3, 0));
      this.mesh.setMatrixAt(n++, m4.compose(pos, q, one));
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  tryCollect(c, dt) {
    for (const p of this.game.players) {
      if (!p.alive) continue;
      const dz = c.s - p.z, dl = c.lat - p.lateral, dy = c.y - (p.y + 0.9);
      // 磁铁：8 米内的金币飞向玩家
      if (p.magnet > 0 && Math.abs(dz) < 10 && Math.abs(dl) < 8) {
        const k = Math.min(1, dt * 9);
        c.s += (p.z + 1 - c.s) * k + p.speed * dt;
        c.lat += (p.lateral - c.lat) * k;
        c.y += (p.y + 0.9 - c.y) * k;
        c.vel = null;
      }
      if (Math.abs(dz) < 1.2 + p.colL * 0.5 && Math.abs(dl) < 0.9 + p.colW * 0.5 && Math.abs(dy) < 1.5) {
        this.collect(c, p);
        return true;
      }
    }
    return false;
  }

  collect(c, p) {
    const g = this.game;
    this.chain++;
    this.chainTimer = 1.1;
    const mult = Math.min(5, 1 + Math.floor(this.chain / 6));
    this.game.bonus(p, 30 * mult);
    p.coinsGot = (p.coinsGot ?? 0) + 1;
    g.prog.earn(1);
    g.audio.coin?.(this.chain);
    g.challenges?.event('coin');
    if (this.chain % 6 === 0) {
      const w = Road.sample(c.s, c.lat);
      g.popAt(p, `🪙 ×${mult}`, new THREE.Vector3(w.x, c.y + 1.2, w.z));
    }
  }
}
