import * as THREE from 'three';
import { Road, ROAD_HALF } from '../world/Road.js';
import { GEO, mat } from '../models/Models.js';
import { GLOW_TEX } from '../fx/Particles.js';
import { clamp, damp, rand } from '../core/utils.js';

const H = {
  altitude: 13, duration: 25, bombEvery: 2.2, bombFlight: 1.15, blastRadius: 3.4, blastDamage: 28,
  hp: 2, score: 2000, coins: 60,
};
const SAMPLE = {};

function part(parent, geo, material, sx, sy, sz, x, y, z) {
  const m = new THREE.Mesh(geo, material);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

/** 警用直升机模型：机身、尾梁、主旋翼（叶片 + 模糊圆盘）、尾旋翼、起落架、闪烁警灯、探照灯光柱 */
function makeHelicopter() {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const navy = mat(0x1d2b4a), white = mat(0xeef1f5), dark = mat(0x15181d), glass = mat(0x2a4a66);
  const capsule = new THREE.CapsuleGeometry(1, 1, 6, 12).rotateX(Math.PI / 2);
  part(body, capsule, navy, 1.3, 1.1, 1.6, 0, 0, 0);
  part(body, capsule, glass, 1.0, 0.85, 0.9, 0, 0.15, 1.3);
  part(body, GEO.box, white, 2.62, 0.35, 2.2, 0, -0.2, -0.2);
  part(body, GEO.cylBase, navy, 0.35, 5, 0.35, 0, 0.1, -1.2).rotation.x = -Math.PI / 2;
  part(body, GEO.box, navy, 0.12, 1.3, 0.8, 0, 0.6, -6);
  for (const sx of [-1, 1]) {
    part(body, GEO.box, dark, 0.12, 0.12, 3.2, sx * 1.1, -1.35, 0.1);
    part(body, GEO.box, dark, 0.1, 0.5, 0.1, sx * 1.1, -1.1, 0.8);
    part(body, GEO.box, dark, 0.1, 0.5, 0.1, sx * 1.1, -1.1, -0.6);
  }
  const rotor = new THREE.Group();
  rotor.position.y = 1.35;
  body.add(rotor);
  for (const r of [0, Math.PI / 2]) part(rotor, GEO.box, dark, 0.35, 0.06, 9, 0, 0, 0).rotation.y = r;
  const blur = new THREE.Mesh(new THREE.CircleGeometry(4.6, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x222833, transparent: true, opacity: 0.25, depthWrite: false }));
  rotor.add(blur);
  const tail = new THREE.Group();
  tail.position.set(0.25, 0.6, -6);
  body.add(tail);
  part(tail, GEO.box, dark, 0.05, 1.6, 0.18, 0, 0, 0);
  // 警灯
  const red = new THREE.MeshBasicMaterial(), blue = new THREE.MeshBasicMaterial();
  part(body, GEO.box, red, 0.3, 0.2, 0.3, -0.5, 1.05, 0.4);
  part(body, GEO.box, blue, 0.3, 0.2, 0.3, 0.5, 1.05, 0.4);
  // 探照灯：从机身打到地面的发光光柱 + 地面光斑
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.4, 2.6, 1, 20, 1, true).translate(0, -0.5, 0),
    new THREE.MeshBasicMaterial({ color: 0xcfe8ff, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
  );
  const spot = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: GLOW_TEX, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  spot.material.color.setRGB(1.6, 1.8, 2.0);
  spot.scale.set(7, 1, 7);
  g.userData = { body, rotor, tail, red, blue, beam, spot };
  return g;
}

/**
 * 警用直升机（Boss 事件）
 *  - 在玩家前上方盘旋，探照灯锁定玩家的预判位置
 *  - 每隔几秒往玩家前方投弹：地面先出现红色预警圈，炸弹落地爆炸
 *  - 撑过 25 秒它就撤退；开坦克可以用主炮把它打下来（2 发）
 */
export class Helicopter {
  constructor(game) {
    this.game = game;
    this.mesh = makeHelicopter();
    this.u = this.mesh.userData;
    this.bombs = [];
    this.bombGeo = new THREE.SphereGeometry(0.45, 10, 8);
    this.bombMat = mat(0x222222);
    this.active = false;
  }

  get collidable() { return this.active && this.state === 'fight'; }

  reset() {
    this.leave(true);
    for (const b of this.bombs) this.game.scene.remove(b.mesh);
    this.bombs = [];
  }

  enter() {
    const g = this.game, p = g.player;
    this.active = true;
    this.state = 'fight';
    this.hp = H.hp;
    this.timer = H.duration;
    this.bombTimer = 2.5;
    this.z = p.z - 30; // 从身后飞过来
    this.lateral = 0;
    this.y = H.altitude + 6;
    this.spin = 0;
    g.scene.add(this.mesh, this.u.beam, this.u.spot);
    g.hud.banner('heliIncoming');
    g.audio?.alert();
    g.feel.shake.add(0.2);
  }

  leave(silent = false) {
    if (!this.active) return;
    const g = this.game;
    g.scene.remove(this.mesh, this.u.beam, this.u.spot);
    this.active = false;
    if (!silent && this.state === 'fight') g.onHeliEscaped();
  }

  /** 被主炮击中 */
  damage(game) {
    if (this.state !== 'fight') return;
    this.hp--;
    game.fx.explosion(this.mesh.position, 0.8);
    if (this.hp > 0) return;
    // 击落：空中大爆炸，然后冒着烟旋转坠落
    this.state = 'down';
    this.fallVy = 0;
    game.fx.explosion(this.mesh.position, 2);
    game.onHeliDown(this);
  }

  update(dt) {
    if (!this.active) return;
    const g = this.game, p = g.player, u = this.u;
    u.rotor.rotation.y += dt * 28;
    u.tail.rotation.x += dt * 40;
    const on = Math.floor(performance.now() / 160) % 2 === 0;
    u.red.color.setRGB(on ? 6 : 0.3, 0.2, 0.2);
    u.blue.color.setRGB(0.2, 0.3, on ? 0.3 : 6);

    if (this.state === 'down') {
      this.fallVy -= 18 * dt;
      this.y += this.fallVy * dt;
      this.z += p.speed * 0.5 * dt;
      u.body.rotation.y += dt * 5;
      u.body.rotation.z = 0.5;
      if (Math.random() < dt * 30) g.fx.smokePuff(this.mesh.position, true);
      if (this.y <= 0.8) {
        g.fx.explosion(this.mesh.position, 1.8);
        g.feel.shake.add(0.5);
        this.leave(true);
        return;
      }
    } else {
      this.timer -= dt;
      const leaving = this.timer <= 0;
      // 盘旋在玩家前上方；撤退时加速飞走、爬升
      const wantZ = leaving ? this.z + 80 : p.z + 22 + Math.sin(performance.now() * 0.0007) * 6;
      const wantLat = leaving ? this.lateral : clamp(p.lateral * 0.6 + Math.sin(performance.now() * 0.0011) * 4, -ROAD_HALF, ROAD_HALF);
      this.z = damp(this.z, wantZ, leaving ? 0.8 : 1.6, dt) + (leaving ? 0 : p.speed * dt * 0.15);
      this.lateral = damp(this.lateral, wantLat, 1.2, dt);
      this.y = damp(this.y, leaving ? H.altitude + 25 : H.altitude, 1.2, dt);
      if (leaving && this.y > H.altitude + 18) { this.leave(); return; }
      if (!leaving && (this.bombTimer -= dt) <= 0) {
        this.bombTimer = H.bombEvery * rand(0.8, 1.2);
        this.dropBomb();
      }
    }

    const w = Road.sample(this.z, this.lateral, SAMPLE);
    this.mesh.position.set(w.x, this.y, w.z);
    this.mesh.rotation.y = w.h;
    if (this.state === 'fight') u.body.rotation.x = 0.12; // 机头微微下压，像在追
    // 探照灯打在玩家前方
    const tz = p.z + p.speed * 0.4, tw = Road.sample(tz, p.lateral, {});
    u.spot.position.set(tw.x, 0.09, tw.z);
    const dx = tw.x - w.x, dz = tw.z - w.z, dist = Math.hypot(dx, dz, this.y);
    u.beam.position.copy(this.mesh.position);
    u.beam.scale.set(1, dist, 1);
    u.beam.lookAt(tw.x, 0, tw.z);
    u.beam.rotateX(-Math.PI / 2);
    u.beam.visible = u.spot.visible = this.state === 'fight';
    this.updateBombs(dt);
  }

  dropBomb() {
    const g = this.game, p = g.player;
    // 瞄准玩家的预判位置；一直不换车道的玩家会被精准命中
    const camping = Math.abs(p.latVel) < 0.5;
    const tz = p.z + p.speed * H.bombFlight, tl = clamp(p.lateral + (camping ? rand(-0.4, 0.4) : rand(-1.4, 1.4)), -ROAD_HALF + 1, ROAD_HALF - 1);
    const w = Road.sample(tz, tl, {});
    const to = new THREE.Vector3(w.x, 0, w.z);
    const mesh = new THREE.Mesh(this.bombGeo, this.bombMat);
    mesh.position.copy(this.mesh.position);
    g.scene.add(mesh);
    this.bombs.push({ from: this.mesh.position.clone(), to, t: 0, mesh });
    g.fx.warning(to, H.bombFlight, H.blastRadius);
    g.audio?.whistle(H.bombFlight);
  }

  updateBombs(dt) {
    const g = this.game;
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.t += dt;
      const f = Math.min(1, b.t / H.bombFlight);
      b.mesh.position.lerpVectors(b.from, b.to, f * f); // 越掉越快
      g.fx.glowDot(b.mesh.position, SAMPLE_ZERO, 0.15, 0.6, 0xff6030, 'trail');
      if (f < 1) continue;
      g.scene.remove(b.mesh);
      this.bombs.splice(i, 1);
      g.fx.explosion(b.to, 0.9);
      g.feel.onBlast();
      const p = g.player, pp = p.mesh.position;
      if (!p.airborne && Math.hypot(pp.x - b.to.x, pp.z - b.to.z) < H.blastRadius + 1) p.hit(H.blastDamage, Math.sign(pp.x - b.to.x) || 1, 0.6);
      for (const c of g.spawner.police) {
        if (c.collidable && c.mesh.position.distanceTo(b.to) < H.blastRadius + 1) c.explode(g, null);
      }
    }
  }
}

const SAMPLE_ZERO = new THREE.Vector3();
export const HELI = H;
