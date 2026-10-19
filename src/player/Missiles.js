import * as THREE from 'three';
import { rand } from '../core/utils.js';

/**
 * 道具“导弹”：从车顶向上射出 3 枚追踪导弹，先往上飞一小段，再拐弯扑向最近的 3 辆警车（或坦克、直升机），
 * 拖着火焰和白烟，命中就爆炸。目标先被别的东西摧毁的话，导弹继续往前飞一会儿然后空中爆炸。
 */
const BODY = new THREE.CylinderGeometry(0.11, 0.11, 1.1, 10).rotateX(Math.PI / 2);
const NOSE = new THREE.ConeGeometry(0.11, 0.3, 10).rotateX(Math.PI / 2).translate(0, 0, 0.7);
const FIN = new THREE.BoxGeometry(0.5, 0.03, 0.2).translate(0, 0, -0.45);
const WHITE = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.4, metalness: 0.3 });
const RED = new THREE.MeshStandardMaterial({ color: 0xc81a14, roughness: 0.4 });
const FLAME = new THREE.MeshBasicMaterial({ color: 0xffb040 });
FLAME.color.setRGB(4, 2, 0.6); // HDR：Bloom 下会发光

function makeMissile() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(BODY, WHITE), new THREE.Mesh(NOSE, RED));
  const f1 = new THREE.Mesh(FIN, RED), f2 = new THREE.Mesh(FIN, RED);
  f2.rotation.z = Math.PI / 2;
  g.add(f1, f2);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.5, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.8), FLAME);
  g.add(flame);
  return g;
}

const tmp = new THREE.Vector3(), aim = new THREE.Vector3();

export class Missiles {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.free = [];
  }

  reset() {
    for (const m of this.list) this.game.scene.remove(m.mesh);
    this.list = [];
  }

  /** 发射：targets 是要打的敌人（警车 / 坦克 / 直升机），by 是发射的玩家 */
  fire(by, targets) {
    const g = this.game, pos = by.mesh.position;
    const h = by.mesh.rotation.y, fx = Math.sin(h), fz = Math.cos(h);
    targets.slice(0, 3).forEach((target, i) => {
      const mesh = this.free.pop() ?? makeMissile();
      mesh.position.set(pos.x + fx * 0.5 + (i - 1) * 0.6 * fz, pos.y + 1.6, pos.z + fz * 0.5 - (i - 1) * 0.6 * fx);
      g.scene.add(mesh);
      // 先往上、往前飞（加上一点左右散开），再转向目标
      const vel = new THREE.Vector3(fx * 14 + (i - 1) * 5 * fz, 16 + i * 2, fz * 14 - (i - 1) * 5 * fx);
      this.list.push({ mesh, vel, target, by, t: -i * 0.12, life: 3.2 });
    });
    g.audio?.cannon();
    g.audio?.whoosh(0, 1);
  }

  /** 目标还活着吗？ */
  alive(t) {
    return t && (t.collidable ?? t.active);
  }

  update(dt) {
    const g = this.game;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const m = this.list[i];
      m.t += dt;
      if (m.t < 0) { m.mesh.visible = false; continue; } // 依次发射，有一点间隔
      m.mesh.visible = true;
      const p = m.mesh.position;
      if (this.alive(m.target) && m.t > 0.25) {
        // 追踪：速度方向逐渐转向目标（转向越来越快），速度越来越快
        aim.copy(m.target.mesh.position).setY(m.target.mesh.position.y + 0.8).sub(p);
        const dist = aim.length();
        if (dist < 2.2) { this.hit(m, i); continue; }
        const speed = Math.min(75, m.vel.length() + 60 * dt);
        m.vel.lerp(aim.normalize().multiplyScalar(speed), Math.min(1, dt * (3 + m.t * 6)));
        m.vel.setLength(speed);
      } else {
        m.vel.y -= 6 * dt;
      }
      p.addScaledVector(m.vel, dt);
      m.mesh.lookAt(tmp.copy(p).add(m.vel));
      // 尾焰 + 白烟
      g.fx.glowDot(p, tmp.set(0, 0, 0), 0.18, 0.6, 0xff9a3a, 'trail');
      if (Math.random() < 0.8) g.fx.smokePuffAt(p, tmp.set(rand(-0.3, 0.3), rand(0, 0.6), rand(-0.3, 0.3)), rand(0.6, 1), rand(0.7, 1.1), 0.75, 0.15);
      if ((m.life -= dt) <= 0 || p.y < -1.5) this.hit(m, i, true);
    }
  }

  hit(m, i, miss = false) {
    const g = this.game, t = m.target;
    g.fx.explosion(m.mesh.position, miss ? 0.7 : 1);
    if (!miss && this.alive(t)) {
      if (t.type === 'tank') t.destroy(g, m.by);
      else if (t.damage) t.damage(g, m.by); // 直升机
      else t.explode?.(g, m.by);
    }
    g.scene.remove(m.mesh);
    this.free.push(m.mesh);
    this.list.splice(i, 1);
  }
}
