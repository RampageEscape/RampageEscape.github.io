import * as THREE from 'three';
import { ObjectPool } from './ObjectPool.js';
import { Road } from '../world/Road.js';
import { rand, pick } from '../core/utils.js';
import { kitPart, DEBRIS } from '../models/ModelLibrary.js';

const FIRE = [0xfff6c8, 0xffc04a, 0xff7a1c, 0xd4380f, 0x4a3328].map((c) => new THREE.Color(c));
const SMOKE_A = new THREE.Color(0x3b3532), SMOKE_B = new THREE.Color(0x9a948e);
const DUST = new THREE.Color(0xe9e4da), SPARK = new THREE.Color(0xffe27a);
const ZERO = new THREE.Vector3();
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();

function gradient(stops, t, out) {
  const x = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1), i = Math.floor(x);
  return out.copy(stops[i]).lerp(stops[i + 1], x - i);
}
const randDir = (out, upBias = 0.3) => out.set(rand(-1, 1), rand(-0.2, 1) + upBias, rand(-1, 1)).normalize();

/**
 * 特效系统：全部粒子来自对象池，运行时不 new 任何 Mesh。
 *  - 发光粒子（火焰/烟/火花/闪光/拖尾）：低多边形二十面体 + MeshBasicMaterial
 *  - 碎片：受光照的小方块，有重力和落地弹跳
 *  - “火焰喷射柱”(jet)：一个看不见的抛射体，沿抛物线飞行并沿途喷火 → 参考图里那种放射状火焰条
 *  - 地面贴花：冲击波圆环、炮击预警圈
 */
export class Effects {
  constructor(scene) {
    this.scene = scene;
    const ico = new THREE.IcosahedronGeometry(1, 0), box = new THREE.BoxGeometry(1, 1, 1);
    this.glowPool = new ObjectPool(() => this.makeParticle(ico, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }), false), 600);
    this.debrisPool = new ObjectPool(() => this.makeParticle(box, new THREE.MeshLambertMaterial({ color: 0x2a2a2e, flatShading: true }), true), 140);
    const ring = new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2);
    const disc = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2);
    this.decalPools = { ring: new ObjectPool(() => this.makeDecal(ring), 12), disc: new ObjectPool(() => this.makeDecal(disc), 6) };
    this.particles = [];
    this.parts = []; // 真实的车辆碎片（车门、轮胎、保险杠……）
    this.jets = [];
    this.decals = [];
  }

  makeParticle(geo, material, debris) {
    const mesh = new THREE.Mesh(geo, material);
    mesh.visible = false;
    mesh.castShadow = debris;
    this.scene.add(mesh);
    return { mesh, debris, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, max: 1, size: 1, kind: 'fire' };
  }

  makeDecal(geo) {
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    mesh.visible = false;
    this.scene.add(mesh);
    return { mesh };
  }

  emit(kind, pos, vel, life, size, color) {
    const debris = kind === 'debris';
    const p = (debris ? this.debrisPool : this.glowPool).get();
    if (!p) return null; // 池子用完就丢弃，宁可少几个粒子也不掉帧
    p.kind = kind;
    p.life = p.max = life;
    p.size = size;
    p.mesh.position.copy(pos);
    p.vel.copy(vel);
    p.mesh.rotation.set(rand(0, 6), rand(0, 6), 0);
    p.spin.set(rand(-9, 9), rand(-9, 9), rand(-9, 9));
    if (debris) p.mesh.scale.set(size * rand(0.6, 1.6), size * rand(0.3, 0.7), size * rand(0.6, 1.4));
    else p.mesh.scale.setScalar(size);
    if (color) p.mesh.material.color.set(color);
    p.mesh.visible = true;
    this.particles.push(p);
    return p;
  }

  decal(type, pos, life, size, color, kind = type) {
    const d = this.decalPools[type].get();
    if (!d) return;
    Object.assign(d, { type, kind, life, max: life, size });
    d.mesh.position.set(pos.x, 0.1, pos.z);
    d.mesh.material.color.set(color);
    d.mesh.visible = true;
    this.decals.push(d);
  }

  // ---------------------------------------------------------------- 组合特效
  /** 警车爆炸：闪光 + 冲击波 + 放射状火焰柱 + 火球 + 浓烟 + 碎片 + 火花
   *  carry = 爆炸物体的前进速度，火焰继承一部分，让爆炸“跟着车飞”而不是原地炸 */
  explosion(pos, power = 1, carry = 0, heading = 0) {
    const c = v1.copy(pos);
    const kx = Math.sin(heading) * carry, kz = Math.cos(heading) * carry; // 沿道路前进方向的惯性
    c.y = Math.max(c.y, 0.8);
    const sp = Math.sqrt(power);
    this.emit('flash', c, ZERO, 0.16, 3.6 * power);
    this.decal('ring', c, 0.4, 11 * power, 0xffffff);
    const jets = Math.round(4 + 2 * power);
    for (let i = 0; i < jets; i++) {
      const a = (i / jets) * Math.PI * 2 + rand(-0.4, 0.4), s = rand(10, 16) * sp;
      this.jets.push({
        pos: c.clone(),
        vel: new THREE.Vector3(Math.cos(a) * s * 0.6 + kx * 0.6, s * rand(0.9, 1.4), Math.sin(a) * s * 0.6 + kz * 0.6),
        life: rand(0.35, 0.6), max: 0.6, size: rand(0.8, 1.1) * sp, acc: 0,
      });
    }
    for (let i = 0; i < 16 * power; i++) this.emit('fire', c, randDir(v2).multiplyScalar(rand(2, 8)).add(v3.set(kx * 0.5, 0, kz * 0.5)), rand(0.45, 0.85), rand(1, 1.9) * sp);
    for (let i = 0; i < 10 * power; i++) this.emit('smoke', c, randDir(v2, 1).multiplyScalar(rand(1, 4)).add(v3.set(kx * 0.3, 0, kz * 0.3)), rand(1.2, 2.2), rand(1.4, 2.6) * sp);
    for (let i = 0; i < 14 * power; i++) this.emit('debris', c, randDir(v2, 0.8).multiplyScalar(rand(8, 18)).add(v3.set(kx * 0.7, 0, kz * 0.7)), rand(1.4, 2.2), rand(0.3, 0.75));
    for (let i = 0; i < 18; i++) this.emit('spark', c, randDir(v2).multiplyScalar(rand(10, 24)), rand(0.25, 0.55), 0.14, SPARK);
    this.spawnParts(c, Math.round(2 + power * 2), kx, kz);
  }

  /** 炸飞几块真实的车辆零件，带重力、旋转和落地弹跳 */
  spawnParts(pos, n, kx = 0, kz = 0) {
    for (let i = 0; i < n; i++) {
      const m = kitPart(pick(DEBRIS), rand(1.2, 1.8));
      if (!m) return;
      if (this.parts.length >= 30) this.scene.remove(this.parts.shift().m); // 同屏碎片上限
      m.position.copy(pos);
      m.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
      m.traverse((o) => { o.castShadow = true; });
      this.scene.add(m);
      const vel = randDir(new THREE.Vector3(), 0.9).multiplyScalar(rand(8, 16));
      vel.x += kx * 0.6;
      vel.z += kz * 0.6;
      this.parts.push({ m, vel, spin: new THREE.Vector3(rand(-10, 10), rand(-10, 10), rand(-10, 10)), life: rand(2, 3), size: m.scale.x });
    }
  }

  updateParts(dt) {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i], m = p.m;
      p.life -= dt;
      p.vel.y -= 30 * dt;
      m.position.addScaledVector(p.vel, dt);
      if (m.position.y < 0.15) {
        m.position.y = 0.15;
        if (p.vel.y < -3) p.vel.y *= -0.35; else p.vel.y = 0;
        p.vel.x *= Math.exp(-4 * dt);
        p.vel.z *= Math.exp(-4 * dt);
        p.spin.multiplyScalar(Math.exp(-5 * dt));
      }
      m.rotation.x += p.spin.x * dt;
      m.rotation.y += p.spin.y * dt;
      m.rotation.z += p.spin.z * dt;
      if (p.life < 0.4) m.scale.setScalar(p.size * Math.max(0, p.life / 0.4));
      if (p.life <= 0) { this.scene.remove(m); this.parts.splice(i, 1); }
    }
  }

  /** 普通碰撞：火花 + 少量烟 */
  impact(pos, s = 1) {
    const c = v1.copy(pos);
    c.y = Math.max(c.y, 0.7);
    for (let i = 0; i < 12 * s; i++) this.emit('spark', c, randDir(v2).multiplyScalar(rand(6, 16)), rand(0.2, 0.45), 0.12, SPARK);
    for (let i = 0; i < 4 * s; i++) this.emit('smoke', c, randDir(v2, 1).multiplyScalar(rand(1, 3)), rand(0.6, 1), rand(0.6, 1.2));
    for (let i = 0; i < 5 * s; i++) this.emit('debris', c, randDir(v2, 0.8).multiplyScalar(rand(5, 10)), rand(0.8, 1.3), rand(0.15, 0.35));
  }

  dust(pos) {
    for (let i = 0; i < 5; i++) this.emit('dust', pos, randDir(v2, 0.2).multiplyScalar(rand(2, 5)), rand(0.5, 0.9), rand(0.6, 1.2), DUST);
  }

  smokePuff(pos, fire = false) {
    this.emit('smoke', pos, v2.set(rand(-0.5, 0.5), rand(2, 4), rand(-0.5, 0.5)), rand(0.9, 1.5), rand(0.7, 1.2));
    if (fire) this.emit('fire', pos, v2.set(0, rand(1, 3), 0), rand(0.3, 0.5), rand(0.5, 0.9));
  }

  muzzleFlash(pos) {
    this.emit('flash', pos, ZERO, 0.1, 1.6);
    for (let i = 0; i < 6; i++) this.emit('smoke', pos, randDir(v2).multiplyScalar(rand(1, 3)), rand(0.5, 0.9), rand(0.5, 1));
  }

  /** 冲刺拖尾：在车尾留下青色光点 */
  dashTrail(player) {
    const h = Road.heading(player.z), pos = player.mesh.position;
    for (let i = 0; i < 2; i++) {
      v1.set(pos.x - Math.sin(h) * 2.2 + rand(-0.8, 0.8), rand(0.4, 1.1), pos.z - Math.cos(h) * 2.2);
      this.emit('trail', v1, ZERO, rand(0.25, 0.4), rand(0.35, 0.6), i ? 0xffffff : 0x66e0ff);
    }
  }

  /** 炮弹预警：外圈固定，内圈逐渐扩大到外圈时炮弹落地 */
  warning(pos, duration, radius) {
    this.decal('ring', pos, duration, radius, 0xff2a2a, 'warnRing');
    this.decal('disc', pos, duration, radius, 0xff3b3b, 'warn');
  }

  // ---------------------------------------------------------------- 每帧更新
  update(dt) {
    this.updateJets(dt);
    this.updateParts(dt);
    this.updateParticles(dt);
    this.updateDecals(dt);
  }

  updateJets(dt) {
    for (let i = this.jets.length - 1; i >= 0; i--) {
      const j = this.jets[i];
      j.life -= dt;
      j.vel.y -= 20 * dt;
      j.pos.addScaledVector(j.vel, dt);
      j.acc += dt;
      while (j.acc > 0.02) {
        j.acc -= 0.02;
        const k = Math.max(0.25, j.life / j.max);
        this.emit('fire', j.pos, v2.set(rand(-1, 1), rand(0, 1.5), rand(-1, 1)), rand(0.35, 0.6), j.size * k);
        if (Math.random() < 0.3) this.emit('smoke', j.pos, v2.set(0, 1, 0), rand(0.8, 1.3), j.size * k * 1.1);
      }
      if (j.life <= 0 || j.pos.y < 0) this.jets.splice(i, 1);
    }
  }

  updateParticles(dt) {
    const list = this.particles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i], m = p.mesh, mat = m.material;
      p.life -= dt;
      if (p.life <= 0) {
        m.visible = false;
        (p.debris ? this.debrisPool : this.glowPool).release(p);
        list[i] = list[list.length - 1];
        list.pop();
        continue;
      }
      const t = 1 - p.life / p.max;
      switch (p.kind) {
        case 'fire':
          p.vel.multiplyScalar(Math.exp(-3 * dt));
          p.vel.y += 4 * dt;
          m.scale.setScalar(p.size * (0.5 + 1.3 * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5)) * (1 - t * 0.4));
          gradient(FIRE, t, mat.color);
          mat.opacity = 1 - t * t * t;
          break;
        case 'smoke':
          p.vel.multiplyScalar(Math.exp(-1.2 * dt));
          p.vel.y += 1.5 * dt;
          m.scale.setScalar(p.size * (0.5 + 1.5 * t));
          mat.color.copy(SMOKE_A).lerp(SMOKE_B, t);
          mat.opacity = 0.8 * Math.pow(1 - t, 1.5);
          break;
        case 'dust':
          p.vel.multiplyScalar(Math.exp(-2 * dt));
          m.scale.setScalar(p.size * (0.6 + 1.4 * t));
          mat.opacity = 0.6 * (1 - t);
          break;
        case 'spark':
          p.vel.y -= 25 * dt;
          m.scale.setScalar(p.size * (1 - t));
          mat.opacity = 1;
          break;
        case 'flash':
          m.scale.setScalar(p.size * (0.6 + t * 0.8));
          mat.color.setRGB(1, 1, 1 - t * 0.7);
          mat.opacity = 1 - t;
          break;
        case 'trail':
          m.scale.setScalar(p.size * (1 - t));
          mat.opacity = 0.7 * (1 - t);
          break;
        case 'debris':
          p.vel.y -= 30 * dt;
          if (m.position.y < 0.1 && p.vel.y < 0) {
            p.vel.y *= -0.35;
            p.vel.x *= 0.6;
            p.vel.z *= 0.6;
            p.spin.multiplyScalar(0.6);
          }
          if (t > 0.8) m.scale.multiplyScalar(1 - dt * 4);
          break;
      }
      m.position.addScaledVector(p.vel, dt);
      m.rotation.x += p.spin.x * dt * (p.debris ? 1 : 0.2);
      m.rotation.y += p.spin.y * dt * (p.debris ? 1 : 0.2);
    }
  }

  updateDecals(dt) {
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i], m = d.mesh;
      d.life -= dt;
      if (d.life <= 0) {
        m.visible = false;
        this.decalPools[d.type].release(d);
        this.decals.splice(i, 1);
        continue;
      }
      const t = 1 - d.life / d.max;
      if (d.kind === 'ring') {
        m.scale.setScalar(d.size * (0.15 + 0.85 * (1 - (1 - t) ** 3)));
        m.material.opacity = 0.85 * (1 - t);
      } else if (d.kind === 'warnRing') {
        m.scale.setScalar(d.size);
        m.material.opacity = 0.6 + 0.4 * Math.sin(t * 40);
      } else {
        m.scale.setScalar(d.size * t);
        m.material.opacity = 0.35;
      }
    }
  }
}
