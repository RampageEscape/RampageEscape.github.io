import * as THREE from 'three';
import { ObjectPool } from './ObjectPool.js';
import { Road, WATER_Y } from '../world/Road.js';
import { rand, pick } from '../core/utils.js';
import { kitPart, DEBRIS } from '../models/ModelLibrary.js';
import { ParticleLayer, StreakLayer, GLOW_TEX, SMOKE_TEX, RING_TEX, SCORCH_TEX } from './Particles.js';

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
const randDir = (out, upBias = 0.3) => out.set(rand(-1, 1), rand(-0.2, 1) + upBias, rand(-1, 1)).normalize();

// 火焰颜色随寿命变化（HDR：数值大于 1 的部分会被 Bloom 变成光晕）
const FIRE_STOPS = [[2.1, 1.5, 0.75], [1.9, 0.85, 0.22], [1.25, 0.36, 0.07], [0.5, 0.13, 0.04], [0.14, 0.05, 0.03]];
function fireColor(t, p) {
  const x = Math.min(0.999, Math.max(0, t)) * (FIRE_STOPS.length - 1), i = Math.floor(x), f = x - i;
  const a = FIRE_STOPS[i], b = FIRE_STOPS[i + 1];
  p.r = a[0] + (b[0] - a[0]) * f;
  p.g = a[1] + (b[1] - a[1]) * f;
  p.b = a[2] + (b[2] - a[2]) * f;
}

/**
 * 特效系统（GPU 粒子 + Bloom 发光）
 *   glow  层（叠加发光）：火球、火焰柱、余烬、闪光、冲刺拖尾
 *   smoke 层（普通混合）：浓烟、尘土
 *   streak 层：火花拖尾线
 *   地面贴花：冲击波光环、焦痕、炮击预警圈
 *   真实碎片：Kenney 车辆零件，飞行时拖着火和烟
 *   点光源闪光：爆炸瞬间照亮周围的车和楼
 */
export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.glow = new ParticleLayer(scene, { capacity: 900, map: GLOW_TEX, additive: true });
    this.smoke = new ParticleLayer(scene, { capacity: 350, map: SMOKE_TEX, additive: false });
    this.streaks = new StreakLayer(scene, 300);
    this.foam = new ParticleLayer(scene, { capacity: 900, map: SMOKE_TEX, additive: false }); // 海上：尾浪、水花
    this.jets = [];
    this.parts = [];
    this.decals = [];

    const ring = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    const disc = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2);
    const decalMat = (map, additive) => new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.decalPools = {
      ring: new ObjectPool(() => this.makeDecal(ring, decalMat(RING_TEX, true)), 12),
      scorch: new ObjectPool(() => this.makeDecal(ring, decalMat(SCORCH_TEX, false)), 10),
      disc: new ObjectPool(() => this.makeDecal(disc, decalMat(null, false)), 6),
    };

    // 固定两盏点光源轮流用（数量不变 → 不会触发着色器重新编译）
    this.lights = [0, 1].map(() => {
      const l = new THREE.PointLight(0xff8a3a, 0, 20, 1.8);
      scene.add(l);
      return l;
    });
    this.lightIdx = 0;
  }

  makeDecal(geo, material) {
    const mesh = new THREE.Mesh(geo, material);
    mesh.visible = false;
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    return { mesh };
  }

  /** 每帧由 main 调用：正交相机下每米多少像素，用来换算粒子大小 */
  setPixelScale(px, perspective = false) {
    for (const layer of [this.glow, this.smoke, this.foam]) {
      layer.mat.uniforms.uScale.value = px;
      layer.mat.uniforms.uPersp.value = perspective ? 1 : 0;
    }
  }

  // ---------------------------------------------------------------- 基础发射
  fire(pos, vel, life, size, hot = 1) {
    return this.glow.add({ kind: 'fire', x: pos.x, y: pos.y, z: pos.z, vx: vel.x, vy: vel.y, vz: vel.z, life, max: life, s0: size, s: size, hot, r: 0, g: 0, b: 0, a: 1, rot: rand(0, 6), vr: rand(-2, 2) });
  }

  glowDot(pos, vel, life, size, color, kind = 'ember') {
    const c = new THREE.Color(color);
    const k = kind === 'flash' ? 1.4 : 2.4; // HDR 亮度倍数
    return this.glow.add({ kind, x: pos.x, y: pos.y, z: pos.z, vx: vel.x, vy: vel.y, vz: vel.z, life, max: life, s0: size, s: size, r: c.r * k, g: c.g * k, b: c.b * k, cr: c.r * k, cg: c.g * k, cb: c.b * k, a: 1, rot: 0, vr: 0 });
  }

  smokePuffAt(pos, vel, life, size, shade = 0.18, lighten = 0.4) {
    return this.smoke.add({ kind: 'smoke', x: pos.x, y: pos.y, z: pos.z, vx: vel.x, vy: vel.y, vz: vel.z, life, max: life, s0: size, s: size, shade, lighten, r: shade, g: shade, b: shade, a: 0, rot: rand(0, 6), vr: rand(-0.8, 0.8) });
  }

  spark(pos, vel, life, color = [4, 2.6, 0.8]) {
    this.streaks.add({ x: pos.x, y: pos.y, z: pos.z, vx: vel.x, vy: vel.y, vz: vel.z, life, max: life, r: color[0], g: color[1], b: color[2], a: 1 });
  }

  /** 兼容旧接口（主炮拖尾等仍在调用） */
  emit(kind, pos, vel, life, size, color) {
    if (kind === 'trail') return this.glowDot(pos, vel, life, size, color ?? 0xffa040, 'trail');
    if (kind === 'smoke') return this.smokePuffAt(pos, vel, life, size);
    if (kind === 'spark') return this.spark(pos, vel, life);
    return this.fire(pos, vel, life, size);
  }

  decal(type, pos, life, size, color, kind = type) {
    const d = this.decalPools[type].get();
    if (!d) return;
    Object.assign(d, { type, kind, life, max: life, size });
    const base = pos.y < -0.3 ? WATER_Y : 0; // 海上的贴花贴在水面上
    d.mesh.position.set(pos.x, base + (type === 'scorch' ? 0.07 : 0.1), pos.z);
    d.mesh.rotation.y = rand(0, 6);
    d.mesh.material.color.set(color);
    d.mesh.visible = true;
    this.decals.push(d);
  }

  flashLight(pos, power) {
    const l = this.lights[this.lightIdx++ % this.lights.length];
    l.position.set(pos.x, 2.5, pos.z);
    l.userData.peak = 55 * power;
    l.userData.t = 0;
    l.intensity = l.userData.peak;
  }

  // ---------------------------------------------------------------- 组合特效
  /** 警车爆炸：闪光 → 火球 → 火焰柱 → 火花 → 余烬 → 浓烟柱，加冲击波、焦痕、飞出的零件 */
  explosion(pos, power = 1, carry = 0, heading = 0) {
    this.onExplosion?.(pos, power); // 声音
    const water = pos.y < -0.3, c = v1.copy(pos);
    c.y = Math.max(c.y, (water ? WATER_Y : 0) + 0.8);
    if (water) this.splash(pos, power * 0.8, false);
    const kx = Math.sin(heading) * carry, kz = Math.cos(heading) * carry; // 沿道路前进方向的惯性
    const sp = Math.sqrt(power);

    this.glowDot(c, v2.set(0, 0, 0), 0.12, 4.5 * power, 0xffd9a0, 'flash');
    this.flashLight(c, power);
    this.decal('ring', c, 0.45, 9 * power, 0xffb070);
    if (!water) this.decal('scorch', c, 6, 3.2 * sp, 0xffffff); // 水面上不留焦痕

    // 火球：一团快速膨胀的高温火焰
    for (let i = 0; i < 11 * power; i++) {
      randDir(v2, 0.6).multiplyScalar(rand(2, 7) * sp);
      v2.x += kx * 0.45; v2.z += kz * 0.45;
      this.fire(c, v2, rand(0.45, 0.85), rand(1.6, 2.8) * sp, rand(0.85, 1.1));
    }
    // 火焰柱：看不见的抛射体，沿抛物线飞并一路喷火
    const jets = Math.round(4 + 2 * power);
    for (let i = 0; i < jets; i++) {
      const a = (i / jets) * Math.PI * 2 + rand(-0.4, 0.4), s = rand(9, 15) * sp;
      this.jets.push({ pos: c.clone(), vel: new THREE.Vector3(Math.cos(a) * s * 0.6 + kx * 0.6, s * rand(0.9, 1.4), Math.sin(a) * s * 0.6 + kz * 0.6), life: rand(0.35, 0.6), max: 0.6, size: rand(1.3, 1.8) * sp, acc: 0 });
    }
    // 火花：发光拖尾线
    for (let i = 0; i < 34 * sp; i++) {
      randDir(v2, 0.5).multiplyScalar(rand(12, 30));
      v2.x += kx * 0.5; v2.z += kz * 0.5;
      this.spark(c, v2, rand(0.35, 0.8));
    }
    // 余烬：慢慢飘落的小火星
    for (let i = 0; i < 18 * power; i++) {
      randDir(v2, 0.8).multiplyScalar(rand(3, 9));
      v2.x += kx * 0.4; v2.z += kz * 0.4;
      this.glowDot(c, v2, rand(1.0, 2.0), rand(0.25, 0.45), pick([0xff8a2a, 0xffb347, 0xff5a1a]));
    }
    // 浓烟：比火慢一拍，往上翻滚
    for (let i = 0; i < 12 * power; i++) {
      randDir(v2, 1.2).multiplyScalar(rand(1, 3.5));
      v2.x += kx * 0.25; v2.z += kz * 0.25;
      const cy = c.y;
      this.smokePuffAt(v1.set(c.x + rand(-1, 1), cy + rand(0, 1), c.z + rand(-1, 1)), v2, rand(1.6, 2.8), rand(2.6, 4.2) * sp, rand(0.1, 0.2));
      v1.copy(pos); v1.y = cy;
    }
    this.spawnParts(c, Math.round(2 + power * 2), kx, kz);
  }

  /** 普通碰撞：一束火花 + 少量烟 */
  impact(pos, s = 1) {
    this.onImpact?.(pos, s);
    const c = v1.copy(pos);
    c.y = Math.max(c.y, 0.7);
    for (let i = 0; i < 16 * s; i++) this.spark(c, randDir(v2, 0.4).multiplyScalar(rand(8, 20)), rand(0.2, 0.5));
    this.glowDot(c, v2.set(0, 0, 0), 0.1, 2.5 * s, 0xfff0c0, 'flash');
    for (let i = 0; i < 3 * s; i++) this.smokePuffAt(c, randDir(v2, 1).multiplyScalar(rand(1, 2.5)), rand(0.6, 1.1), rand(1, 1.8), 0.3);
  }

  dust(pos) {
    if (pos.y < -0.3) return this.splash(pos, 0.5);
    for (let i = 0; i < 5; i++) this.smokePuffAt(v1.set(pos.x, 0.3, pos.z), randDir(v2, 0.1).multiplyScalar(rand(2, 5)), rand(0.6, 1), rand(1.2, 2.2), 0.62, 0.15);
  }

  /** 燃烧中的残骸：持续冒火和烟 */
  smokePuff(pos, fire = false) {
    this.smokePuffAt(pos, v2.set(rand(-0.5, 0.5), rand(2, 4), rand(-0.5, 0.5)), rand(1.2, 2), rand(1.4, 2.4), 0.14);
    if (fire) this.fire(pos, v2.set(rand(-0.4, 0.4), rand(1.5, 3), rand(-0.4, 0.4)), rand(0.3, 0.5), rand(1.1, 1.8), 0.8);
  }

  muzzleFlash(pos) {
    this.glowDot(pos, v2.set(0, 0, 0), 0.09, 3.5, 0xfff0b0, 'flash');
    this.flashLight(pos, 0.5);
    for (let i = 0; i < 6; i++) this.smokePuffAt(pos, randDir(v2).multiplyScalar(rand(1, 3)), rand(0.5, 0.9), rand(1, 1.8), 0.35);
  }

  /** 冲刺拖尾：两道霓虹光流从车尾两侧喷出 */
  dashTrail(player) {
    const h = Road.heading(player.z), pos = player.mesh.position;
    const bx = -Math.sin(h) * player.length * 0.5, bz = -Math.cos(h) * player.length * 0.5;
    const lx = Math.cos(h) * player.width * 0.35, lz = -Math.sin(h) * player.width * 0.35;
    for (const side of [-1, 1]) {
      v1.set(pos.x + bx + lx * side, pos.y + 0.55, pos.z + bz + lz * side);
      this.glowDot(v1, v2.set(0, 0.3, 0), rand(0.25, 0.4), rand(0.7, 1.0), side < 0 ? 0x46e6ff : 0xff4fd8, 'trail');
    }
  }

  // ---------------------------------------------------------------- 海上
  foamAt(x, y, z, vx, vy, vz, life, size, kind) {
    return this.foam.add({ kind, x, y, z, vx, vy, vz, life, max: life, s0: size, s: size, r: 0.95, g: 0.97, b: 1, a: 0, rot: rand(0, 6), vr: rand(-0.6, 0.6), surf: WATER_Y + 0.06 });
  }

  /**
   * 船尾浪 + 船头水花（每帧调用）。
   *   两道白色尾浪从船尾两侧向外散开，速度越快喷得越多；中间一道螺旋桨翻起的白水；
   *   高速时船头两侧溅起水花；冲刺时船尾喷起一道高高的“鸡尾”水柱。
   */
  wake(pos, heading, speed, width, length, dt, power = 1, boost = false) {
    const fx = Math.sin(heading), fz = Math.cos(heading), lx = fz, lz = -fx;
    const sx = pos.x - fx * length * 0.5, sz = pos.z - fz * length * 0.5;
    const n = (k) => Math.floor(k * dt + Math.random());
    const sy = WATER_Y + 0.06;
    for (let i = n((4 + speed * 0.7) * power); i > 0; i--) {
      const side = Math.random() < 0.5 ? -1 : 1, out = rand(1, 2.6);
      this.foamAt(sx + lx * side * width * 0.42, sy, sz + lz * side * width * 0.42, lx * side * out - fx * 2, 0, lz * side * out - fz * 2, rand(1.6, 2.6), width * rand(0.45, 0.65), 'wake');
    }
    for (let i = n((3 + speed * 0.4) * power); i > 0; i--) {
      this.foamAt(sx + rand(-0.3, 0.3), sy, sz + rand(-0.3, 0.3), -fx * rand(1, 3), 0, -fz * rand(1, 3), rand(0.9, 1.5), width * rand(0.55, 0.8), 'wake');
    }
    if (speed > 16) {
      for (let i = n((speed - 14) * 0.9 * power); i > 0; i--) {
        const side = Math.random() < 0.5 ? -1 : 1, bx = pos.x + fx * length * 0.3 + lx * side * width * 0.5, bz = pos.z + fz * length * 0.3 + lz * side * width * 0.5;
        this.foamAt(bx, sy + 0.2, bz, lx * side * rand(2, 4) + fx * speed * 0.4, rand(2, 4), lz * side * rand(2, 4) + fz * speed * 0.4, rand(0.45, 0.7), rand(0.5, 0.8), 'spray');
      }
    }
    if (boost) {
      for (let i = n(40); i > 0; i--) {
        this.foamAt(sx, sy + 0.4, sz, -fx * rand(3, 8) + rand(-1, 1), rand(5, 9), -fz * rand(3, 8) + rand(-1, 1), rand(0.6, 0.9), rand(0.7, 1.1), 'spray');
      }
    }
  }

  /** 大水花：落水、残骸沉没、水上爆炸 */
  splash(pos, power = 1, sound = true) {
    if (sound) this.onSplash?.(pos, power);
    const y = WATER_Y + 0.06;
    this.decal('ring', v2.set(pos.x, WATER_Y, pos.z), 0.7, 7 * power, 0xe8f6ff);
    for (let i = 0; i < 34 * power; i++) {
      const a = rand(0, Math.PI * 2), r = rand(2, 7) * power;
      this.foamAt(pos.x, y + 0.3, pos.z, Math.cos(a) * r, rand(5, 12) * Math.sqrt(power), Math.sin(a) * r, rand(0.7, 1.2), rand(0.7, 1.3) * Math.sqrt(power), 'spray');
    }
    for (let i = 0; i < 18 * power; i++) {
      const a = rand(0, Math.PI * 2), r = rand(1.5, 4);
      this.foamAt(pos.x + Math.cos(a), y, pos.z + Math.sin(a), Math.cos(a) * r, 0, Math.sin(a) * r, rand(1.5, 2.5), rand(1.2, 2.2) * power, 'wake');
    }
  }

  /** 冲刺 / 加速时排气管喷火：车尾两侧的火焰 + 蓝色内焰 */
  exhaust(p) {
    const h = p.mesh.rotation.y, pos = p.mesh.position, fx = Math.sin(h), fz = Math.cos(h), lx = fz, lz = -fx;
    const back = p.length * 0.5 + 0.1;
    for (const side of [-1, 1]) {
      v1.set(pos.x - fx * back + lx * side * p.width * 0.28, pos.y + 0.42, pos.z - fz * back + lz * side * p.width * 0.28);
      this.fire(v1, v2.set(-fx * rand(4, 9), rand(0, 1), -fz * rand(4, 9)), rand(0.1, 0.2), rand(0.45, 0.7), 1.1);
      if (Math.random() < 0.5) this.glowDot(v1, v2.set(-fx * 3, 0, -fz * 3), 0.08, 0.4, 0x5ad1ff, 'flash');
    }
  }

  /** 车子受损：血量低于一半时引擎盖冒烟，低于四分之一时着火 */
  damageSmoke(p, dt) {
    const ratio = p.hp / p.maxHp;
    if (ratio >= 0.5 || !p.alive) return;
    const h = p.mesh.rotation.y, pos = p.mesh.position, front = p.length * 0.3;
    v1.set(pos.x + Math.sin(h) * front, pos.y + 1.0, pos.z + Math.cos(h) * front);
    const rate = (0.5 - ratio) * 40;
    if (Math.random() < rate * dt) this.smokePuffAt(v1, v2.set(rand(-0.4, 0.4), rand(2, 3.5), rand(-0.4, 0.4)), rand(1, 1.6), rand(0.9, 1.5), ratio < 0.25 ? 0.12 : 0.35, 0.3);
    if (ratio < 0.25 && Math.random() < 25 * dt) this.fire(v1, v2.set(rand(-0.3, 0.3), rand(1.5, 3), rand(-0.3, 0.3)), rand(0.25, 0.4), rand(0.6, 1.0), 0.9);
  }

  /** 电磁脉冲：一圈向外扩散的青色冲击波 + 电弧火花 */
  empWave(pos, radius) {
    this.decal('ring', pos, 0.9, radius * 2.2, 0x46e6ff);
    this.decal('ring', pos, 0.6, radius * 1.4, 0xbff4ff);
    this.glowDot(v1.set(pos.x, pos.y + 1, pos.z), v2.set(0, 0, 0), 0.25, 9, 0x8fe8ff, 'flash');
    for (let i = 0; i < 70; i++) {
      const a = rand(0, Math.PI * 2), s = rand(18, 34);
      this.spark(v1.set(pos.x, pos.y + 0.8, pos.z), v2.set(Math.cos(a) * s, rand(1, 6), Math.sin(a) * s), rand(0.4, 0.7), [0.6, 2.6, 4]);
    }
    this.flashLight(pos, 1.2);
  }

  /** 炮弹预警：外圈固定，内圈逐渐扩大到外圈时炮弹落地 */
  warning(pos, duration, radius) {
    this.decal('ring', pos, duration, radius, 0xff2a2a, 'warnRing');
    this.decal('disc', pos, duration, radius, 0xff3b3b, 'warn');
  }

  /** 炸飞几块真实的车辆零件，带重力、旋转、落地弹跳，飞行时拖着火和烟 */
  spawnParts(pos, n, kx = 0, kz = 0) {
    for (let i = 0; i < n; i++) {
      const m = kitPart(pick(DEBRIS), rand(1.2, 1.8));
      if (!m) return;
      if (this.parts.length >= 30) this.scene.remove(this.parts.shift().m);
      m.position.copy(pos);
      m.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
      m.traverse((o) => { o.castShadow = true; });
      this.scene.add(m);
      const vel = randDir(new THREE.Vector3(), 0.9).multiplyScalar(rand(8, 16));
      vel.x += kx * 0.6;
      vel.z += kz * 0.6;
      this.parts.push({ m, vel, spin: new THREE.Vector3(rand(-10, 10), rand(-10, 10), rand(-10, 10)), life: rand(2, 3), size: m.scale.x, burn: Math.random() < 0.6, acc: 0 });
    }
  }

  // ---------------------------------------------------------------- 每帧
  update(dt) {
    this.updateJets(dt);
    this.updateParts(dt);
    this.updateGlow(dt);
    this.updateSmoke(dt);
    this.updateStreaks(dt);
    this.updateFoam(dt);
    this.updateDecals(dt);
    for (const l of this.lights) {
      if (l.intensity <= 0) continue;
      l.userData.t += dt;
      l.intensity = Math.max(0, l.userData.peak * (1 - l.userData.t / 0.35));
    }
  }

  updateJets(dt) {
    for (let i = this.jets.length - 1; i >= 0; i--) {
      const j = this.jets[i];
      j.life -= dt;
      j.vel.y -= 20 * dt;
      j.pos.addScaledVector(j.vel, dt);
      j.acc += dt;
      while (j.acc > 0.016) {
        j.acc -= 0.016;
        const k = Math.max(0.3, j.life / j.max);
        this.fire(j.pos, v2.set(rand(-1, 1), rand(0, 1.5), rand(-1, 1)), rand(0.3, 0.5), j.size * k, 1.05);
        if (Math.random() < 0.25) this.smokePuffAt(j.pos, v2.set(0, 1.2, 0), rand(0.9, 1.4), j.size * k * 1.6, 0.16);
      }
      if (j.life <= 0 || j.pos.y < 0) this.jets.splice(i, 1);
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
      // 燃烧的零件在空中拖着火和烟
      if (p.burn && m.position.y > 0.4 && (p.acc += dt) > 0.03) {
        p.acc = 0;
        this.fire(m.position, v2.set(0, 0.5, 0), 0.3, 0.9, 0.9);
        if (Math.random() < 0.35) this.smokePuffAt(m.position, v2.set(0, 0.8, 0), 0.9, 1.1, 0.15);
      }
      if (p.life < 0.4) m.scale.setScalar(p.size * Math.max(0, p.life / 0.4));
      if (p.life <= 0) { this.scene.remove(m); this.parts.splice(i, 1); }
    }
  }

  updateGlow(dt) {
    const list = this.glow.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) { list[i] = list[list.length - 1]; list.pop(); continue; }
      const t = 1 - p.life / p.max;
      if (p.kind === 'fire') {
        const k = Math.exp(-2.5 * dt);
        p.vx *= k; p.vy = p.vy * k + 5 * dt; p.vz *= k; // 热气上升
        fireColor(t, p);
        p.r *= p.hot; p.g *= p.hot; p.b *= p.hot;
        p.s = p.s0 * (0.55 + 0.9 * Math.sin(Math.min(1, t * 1.8) * Math.PI * 0.5)) * (1 - 0.35 * t);
        p.a = 1 - t * t;
      } else if (p.kind === 'ember') {
        p.vy -= 6 * dt;
        p.vx *= Math.exp(-1.5 * dt); p.vz *= Math.exp(-1.5 * dt);
        const flicker = 0.7 + 0.3 * Math.sin(p.life * 40 + i);
        p.r = p.cr * flicker; p.g = p.cg * flicker; p.b = p.cb * flicker;
        p.a = 1 - t;
        if (p.y < 0.05) { p.y = 0.05; p.vy = 0; }
      } else if (p.kind === 'flash') {
        p.s = p.s0 * (0.7 + 0.6 * t);
        p.a = 1 - t;
      } else {
        // trail
        p.s = p.s0 * (1 - t);
        p.a = 0.85 * (1 - t);
      }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.rot += p.vr * dt;
    }
    this.glow.flush();
  }

  updateSmoke(dt) {
    const list = this.smoke.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) { list[i] = list[list.length - 1]; list.pop(); continue; }
      const t = 1 - p.life / p.max;
      const k = Math.exp(-1.4 * dt);
      p.vx *= k; p.vz *= k; p.vy = p.vy * k + 1.2 * dt;
      p.s = p.s0 * (0.5 + 1.3 * Math.sqrt(t));
      const shade = p.shade + p.lighten * t;
      p.r = p.g = p.b = shade;
      p.a = Math.min(1, t * 6) * 0.75 * Math.pow(1 - t, 1.3); // 淡入再慢慢散开
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.rot += p.vr * dt;
    }
    this.smoke.flush();
  }

  updateFoam(dt) {
    const list = this.foam.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0 || (p.kind === 'spray' && p.y < p.surf - 0.3)) { list[i] = list[list.length - 1]; list.pop(); continue; }
      const t = 1 - p.life / p.max;
      if (p.kind === 'spray') {
        p.vy -= 16 * dt;
        p.s = p.s0 * (0.6 + 1.2 * t);
        p.a = Math.min(1, t * 8) * 0.85 * (1 - t);
      } else {
        // 尾浪：贴着水面慢慢散开、变淡
        const k = Math.exp(-1.2 * dt);
        p.vx *= k; p.vz *= k;
        p.y = p.surf;
        p.s = p.s0 * (1 + 2.2 * Math.sqrt(t));
        p.a = Math.min(1, t * 10) * 0.62 * (1 - t) ** 1.4;
      }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.rot += p.vr * dt;
    }
    this.foam.flush();
  }

  updateStreaks(dt) {
    const list = this.streaks.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) { list[i] = list[list.length - 1]; list.pop(); continue; }
      p.vy -= 22 * dt;
      if (p.y < 0.05 && p.vy < 0) { p.vy *= -0.4; p.vx *= 0.6; p.vz *= 0.6; } // 落地弹起
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.a = Math.min(1, p.life / p.max * 1.5);
    }
    this.streaks.flush();
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
        m.scale.setScalar(d.size * (0.15 + 0.85 * (1 - (1 - t) ** 3)) * 0.5);
        m.material.opacity = 1 - t;
      } else if (d.kind === 'scorch') {
        m.scale.setScalar(d.size * 0.5);
        m.material.opacity = Math.min(1, (1 - t) * 3);
      } else if (d.kind === 'warnRing') {
        m.scale.setScalar(d.size * 0.5);
        m.material.opacity = 0.6 + 0.4 * Math.sin(t * 40);
      } else {
        m.scale.setScalar(d.size * t);
        m.material.opacity = 0.35;
      }
    }
  }
}
