import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Road } from '../world/Road.js';
import { dampAngle } from '../core/utils.js';

const C = CONFIG.cannon;
const SAMPLE = {};
const ZERO = new THREE.Vector3();

/**
 * 玩家坦克的主炮
 *  - 炮塔自动转向射程内最近的警车（前方优先）
 *  - 按 FIRE（或键盘 F）开炮：炮弹飞向目标的“预判位置”，落地爆炸，范围内的警车全部摧毁
 *  - 冷却和爆炸范围可以在改装站升级
 */
export class Cannon {
  constructor(game) {
    this.game = game;
    this.shells = [];
    this.cooldown = 0;
    this.target = null;
    this.geo = new THREE.SphereGeometry(0.4, 8, 6);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffd36b });
  }

  reset() {
    for (const s of this.shells) this.game.scene.remove(s.mesh);
    this.shells = [];
    this.cooldown = 0;
    this.target = null;
  }

  get active() { return !!this.game.player.tier.cannon; }
  get charge() { return 1 - this.cooldown / this.game.player.stats.cannonCooldown; }

  findTarget(p) {
    const pp = p.mesh.position, sp = this.game.spawner;
    let best = null, bestScore = Infinity;
    for (const c of [...sp.police, ...sp.tanks]) {
      if (!c.collidable) continue;
      const d = pp.distanceTo(c.mesh.position);
      if (d > C.range || d < 3) continue;
      const score = d * (c.z > p.z ? 1 : 1.6); // 前方的目标优先
      if (score < bestScore) { bestScore = score; best = c; }
    }
    // 直升机在射程内就优先打它
    const heli = sp.heli;
    if (heli.collidable && pp.distanceTo(heli.mesh.position) < C.range + 15) return heli;
    return best;
  }

  update(dt) {
    const p = this.game.player, fx = this.game.fx;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.active && p.turret) {
      this.target = this.findTarget(p);
      let want = 0;
      if (this.target) {
        const tp = this.target.mesh.position, pp = p.mesh.position;
        want = Math.atan2(tp.x - pp.x, tp.z - pp.z) - p.mesh.rotation.y;
      }
      p.turret.rotation.y = dampAngle(p.turret.rotation.y, want, 10, dt);
    } else {
      this.target = null;
    }

    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.t += dt;
      const f = Math.min(1, s.t / s.flight);
      s.mesh.position.lerpVectors(s.from, s.to, f);
      s.mesh.position.y += Math.sin(Math.PI * f) * 1.5;
      fx.emit('trail', s.mesh.position, ZERO, 0.25, 0.45, 0xffa040);
      if (f < 1) continue;
      this.detonate(s.to);
      this.game.scene.remove(s.mesh);
      this.shells.splice(i, 1);
    }
  }

  fire() {
    const g = this.game, p = g.player;
    if (!this.active || this.cooldown > 0 || !p.alive || !p.muzzle) return false;
    this.cooldown = p.stats.cannonCooldown;
    p.muzzle.updateWorldMatrix(true, false);
    const from = p.muzzle.getWorldPosition(new THREE.Vector3());
    let w;
    let air = 0.5;
    if (this.target === g.spawner.heli) {
      w = { x: this.target.mesh.position.x, z: this.target.mesh.position.z };
      air = this.target.mesh.position.y;
    } else if (this.target) {
      // 预判：按目标当前速度，算炮弹飞到时它会在哪
      const t = this.target, flight = from.distanceTo(t.mesh.position) / C.speed;
      w = Road.sample(t.z + (t.speed || 0) * flight, t.lateral, SAMPLE);
    } else {
      w = Road.sample(p.z + 35 + p.speed * 0.4, p.lateral, SAMPLE); // 没目标就往正前方打
    }
    const to = new THREE.Vector3(w.x, air, w.z);
    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.position.copy(from);
    g.scene.add(mesh);
    this.shells.push({ from, to, t: 0, flight: Math.max(0.12, from.distanceTo(to) / C.speed), mesh });
    g.fx.muzzleFlash(from);
    g.audio?.cannon();
    g.feel.shake.add(0.18);
    g.feel.zoomKick -= 0.02;
    p.speed *= 0.97; // 后坐力
    return true;
  }

  detonate(pos) {
    const g = this.game, p = g.player, R = p.stats.cannonRadius;
    g.fx.explosion(pos, 1.1);
    g.feel.shake.add(0.25);
    const near = (e, extra = 1) => e.collidable && e.mesh.position.distanceTo(pos) < R + extra;
    for (const c of g.spawner.police) if (near(c)) c.explode(g, p);
    for (const t of g.spawner.tanks) if (near(t, 2.5)) t.destroy(g, p);
    for (const c of g.spawner.traffic) if (near(c)) c.knock(p, g, 0.8);
    for (const o of g.spawner.obstacles) if (near(o)) o.knock(p, g, 1);
    const heli = g.spawner.heli;
    if (heli.collidable && heli.mesh.position.distanceTo(pos) < R + 3) heli.damage(g);
  }
}
