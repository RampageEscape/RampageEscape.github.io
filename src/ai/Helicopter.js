import * as THREE from 'three';
import { Road, ROAD_HALF } from '../world/Road.js';
import { mat } from '../models/Models.js';
import { GLOW_TEX } from '../fx/Particles.js';
import { clamp, damp, rand } from '../core/utils.js';

const H = {
  altitude: 13, duration: 25, bombEvery: 2.2, bombFlight: 1.15, blastRadius: 3.4, blastDamage: 28,
  hp: 2, score: 2000, coins: 60,
};
const SAMPLE = {};

/**
 * 警用直升机模型（流线型）：车床旋转出来的水滴形机身、弧形玻璃座舱、渐细的尾梁、垂直尾翼 + 水平安定面、
 * 弯头起落橇、四片桨叶 + 旋转模糊盘、尾桨、红蓝警灯、侧面“POLICE 警察”字样、机腹探照灯光柱
 */
const HELI_PAINT = new THREE.MeshPhysicalMaterial({ color: 0x14213d, metalness: 0.45, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 });
const HELI_DARK = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.5, metalness: 0.6 });
const HELI_GLASS = new THREE.MeshPhysicalMaterial({ color: 0x0b1620, roughness: 0.05, metalness: 0.2, clearcoat: 1, transparent: true, opacity: 0.8, envMapIntensity: 1.5 });

function heliLabel() {
  const c = Object.assign(document.createElement('canvas'), { width: 512, height: 96 });
  const g = c.getContext('2d');
  g.font = 'bold 54px "Arial Black", "PingFang TC", "Microsoft JhengHei", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.fillText('POLICE 警察', 256, 52);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, side: THREE.DoubleSide });
}

function makeHelicopter() {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const add = (geo, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, parent = body) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  // 机身：沿 Z 轴的水滴形（车床旋转，机头圆、机舱最粗、往后收成尾梁）
  const prof = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24, z = -2.6 + t * 5.2;
    const r = t < 0.75 ? Math.sin(Math.min(1, t / 0.75) * Math.PI * 0.5) ** 0.6 * 1.15 : 1.15 * Math.cos(((t - 0.75) / 0.25) * Math.PI * 0.5) ** 0.8;
    prof.push(new THREE.Vector2(Math.max(0.001, r), z));
  }
  const hull = new THREE.LatheGeometry(prof.reverse(), 32).rotateX(Math.PI / 2);
  hull.scale(1, 0.95, 1);
  add(hull, HELI_PAINT, 0, 0, 0.2);
  // 两侧：“POLICE 警察”字样
  for (const s of [-1, 1]) {
    const lab = add(new THREE.PlaneGeometry(2.4, 0.45), heliLabel(), s * 1.1, 0.25, -0.3, 0, s * Math.PI / 2);
    lab.castShadow = false;
  }
  // 弧形座舱玻璃（机头上半部）
  const canopy = add(new THREE.SphereGeometry(1, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.5), HELI_GLASS, 0, 0.05, 1.45, -0.5);
  canopy.scale.set(0.98, 0.9, 1.25);
  // 尾梁（渐细的圆柱）+ 垂直尾翼 + 水平安定面
  add(new THREE.CylinderGeometry(0.16, 0.34, 5.2, 16).rotateX(Math.PI / 2), HELI_PAINT, 0, 0.35, -4.6);
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0); finShape.lineTo(-0.9, 0); finShape.lineTo(-0.5, 1.6); finShape.lineTo(0.15, 1.6); finShape.closePath();
  const fin = new THREE.ExtrudeGeometry(finShape, { depth: 0.08, bevelEnabled: false }).rotateY(Math.PI / 2).translate(-0.04, 0, 0);
  add(fin, HELI_PAINT, 0, 0.4, -6.6);
  add(new THREE.BoxGeometry(2.0, 0.06, 0.5), HELI_PAINT, 0, 0.42, -5.9);
  // 发动机整流罩
  const cowl = add(new THREE.CapsuleGeometry(0.5, 1.4, 6, 16).rotateX(Math.PI / 2), HELI_PAINT, 0, 1.0, -0.3);
  cowl.scale.set(1, 0.7, 1);
  // 起落橇：两根长管（前端上翘）+ 四根支柱
  for (const s of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.06, 0.06, 3.4, 10).rotateX(Math.PI / 2), HELI_DARK, s * 1.05, -1.45, 0.1);
    add(new THREE.TorusGeometry(0.3, 0.06, 8, 12, Math.PI / 2), HELI_DARK, s * 1.05, -1.15, 1.8, 0, Math.PI / 2, 0);
    for (const z of [-0.8, 0.9]) add(new THREE.CylinderGeometry(0.05, 0.05, 0.75, 8), HELI_DARK, s * 0.9, -1.1, z, 0, 0, s * 0.35);
  }
  // 主旋翼：桨毂 + 四片桨叶 + 半透明模糊盘
  const rotor = new THREE.Group();
  rotor.position.y = 1.5;
  body.add(rotor);
  add(new THREE.CylinderGeometry(0.12, 0.18, 0.5, 12), HELI_DARK, 0, -0.15, 0, 0, 0, 0, rotor);
  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(0, -0.14); bladeShape.lineTo(4.6, -0.1); bladeShape.lineTo(4.8, 0); bladeShape.lineTo(4.6, 0.12); bladeShape.lineTo(0, 0.14); bladeShape.closePath();
  const blade = new THREE.ExtrudeGeometry(bladeShape, { depth: 0.04, bevelEnabled: false }).rotateX(Math.PI / 2);
  for (let k = 0; k < 4; k++) add(blade, HELI_DARK, 0, 0.02, 0, 0, (k * Math.PI) / 2, 0.04, rotor);
  const blur = new THREE.Mesh(new THREE.CircleGeometry(4.8, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x20262e, transparent: true, opacity: 0.18, depthWrite: false }));
  rotor.add(blur);
  // 尾桨
  const tail = new THREE.Group();
  tail.position.set(0.18, 1.2, -6.4);
  body.add(tail);
  for (const r of [0, Math.PI / 2]) add(new THREE.BoxGeometry(0.04, 1.4, 0.14), HELI_DARK, 0, 0, 0, r, 0, 0, tail);
  // 警灯
  const red = new THREE.MeshBasicMaterial(), blue = new THREE.MeshBasicMaterial();
  add(new THREE.SphereGeometry(0.14, 12, 8), red, -0.35, 1.3, 0.6);
  add(new THREE.SphereGeometry(0.14, 12, 8), blue, 0.35, 1.3, 0.6);
  add(new THREE.SphereGeometry(0.12, 12, 8), red, 0, 0.5, -6.6);
  // 机腹探照灯
  add(new THREE.CylinderGeometry(0.2, 0.26, 0.3, 14), HELI_DARK, 0, -1.0, 1.6);
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
    const g = this.game, p = (this.target = g.heliTarget());
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
  damage(game, by) {
    if (this.state !== 'fight') return;
    this.hp--;
    game.fx.explosion(this.mesh.position, 0.8);
    if (this.hp > 0) return;
    // 击落：空中大爆炸，然后冒着烟旋转坠落
    this.state = 'down';
    this.fallVy = 0;
    game.fx.explosion(this.mesh.position, 2);
    game.onHeliDown(this, by);
  }

  update(dt) {
    if (!this.active) return;
    const g = this.game, u = this.u;
    const p = this.target?.alive ? this.target : (this.target = g.heliTarget());
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
    const g = this.game, p = this.target;
    // 瞄准玩家的预判位置；一直不换车道的玩家会被精准命中
    const camping = Math.abs(p.latVel) < 0.5;
    const tz = p.z + p.speed * H.bombFlight, tl = clamp(p.lateral + (camping ? rand(-0.4, 0.4) : rand(-1.4, 1.4)), -ROAD_HALF + 1, ROAD_HALF - 1);
    const w = Road.sample(tz, tl, {});
    const to = new THREE.Vector3(w.x, Road.surfaceY(tz), w.z);
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
      for (const p of g.players) {
        const pp = p.mesh.position;
        if (!p.airborne && Math.hypot(pp.x - b.to.x, pp.z - b.to.z) < H.blastRadius + 1) p.hit(H.blastDamage, Math.sign(pp.x - b.to.x) || 1, 0.6);
      }
      for (const c of g.spawner.police) {
        if (c.collidable && c.mesh.position.distanceTo(b.to) < H.blastRadius + 1) c.explode(g, null);
      }
    }
  }
}

const SAMPLE_ZERO = new THREE.Vector3();
export const HELI = H;
