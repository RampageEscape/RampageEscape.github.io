import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Road, ROAD_HALF } from '../world/Road.js';
import { Vehicle } from '../entities/Vehicle.js';
import { makeTank } from '../models/Models.js';
import { ObjectPool } from '../fx/ObjectPool.js';
import { clamp, dampAngle, rand } from '../core/utils.js';
import { classifyContact } from '../systems/Collisions.js';

const T = CONFIG.tank;

/** 坦克（城市关卡重型单位）：在前方慢速行驶，炮塔追踪玩家，向玩家的“预判落点”开炮 */
export class TankAI extends Vehicle {
  constructor() {
    super(makeTank(), T.length, T.width);
    this.type = 'tank';
    this.turret = this.mesh.userData.turret;
    this.muzzle = this.mesh.userData.muzzle;
  }

  spawnTank(scene, z, lateral) {
    this.spawn(scene, z, lateral, T.speed);
    this.mode = 'tank';
    this.fireTimer = 1.2;
    this.turret.rotation.y = Math.PI;
  }

  update(dt, { player, fx, shells }) {
    if (this.state === 'wreck') return this.updateWreck(dt, fx);
    this.z += this.speed * dt;
    this.sync();
    const pp = player.mesh.position;
    const aim = Math.atan2(pp.x - this.mesh.position.x, pp.z - this.mesh.position.z) - this.mesh.rotation.y;
    this.turret.rotation.y = dampAngle(this.turret.rotation.y, aim, 4, dt);
    const ahead = this.z - player.z;
    if (player.alive && ahead > 10 && ahead < 95 && (this.fireTimer -= dt) <= 0) {
      this.fireTimer = T.fireInterval * rand(0.8, 1.2);
      shells.fire(this, player);
    }
  }

  knock() {} // 坦克太重，警车撞上来推不动

  /** 被冲刺撞毁 / 被玩家坦克撞毁 / 被主炮击中 */
  destroy(game, source) {
    if (this.state === 'wreck') return;
    const carry = (source?.speed ?? 20) * 0.3;
    this.launch(new THREE.Vector3(rand(-3, 3), 9, carry), new THREE.Vector3(rand(-2, 2), rand(-2, 2), rand(-2, 2)));
    this.burning = true;
    game.fx.explosion(this.mesh.position, 2.2, carry, Road.heading(this.z));
    game.onEnemyDestroyed(this, 2.2, 'dash');
  }

  onPlayerCollision(player, game) {
    // 冲刺中，或者玩家自己也是坦克 → 敌方坦克被撞毁
    if (player.isDashing || player.tier.tankKill) {
      this.destroy(game, player);
      if (!player.isDashing) player.ramImpact(10);
      return;
    }
    const c = classifyContact(player, this);
    if (c.type === 'side') {
      // 侧面擦到坦克：坦克不会横移，基本都是玩家自己变道撞上去
      if (c.playerAtFault) player.hit(T.damage * 0.5, -c.side * 0.8, 0.7);
      else player.bump(-c.side, 0);
      player.lateral = this.lateral - c.side * ((this.colW + player.colW) / 2 + 0.05);
      return;
    }
    // 没冲刺正面撞坦克 = 撞墙
    player.hit(T.damage, 0, 0.3);
    player.z = this.z - (this.colL + player.colL) / 2 - 0.2;
    player.speed = Math.min(player.speed, this.speed * 0.5);
    game.fx.impact(player.mesh.position, 1);
  }
}

/** 炮弹：抛物线飞行，地面提前出现红色预警圈，落地爆炸（也会炸到警车） */
export class Shells {
  constructor(game) {
    this.game = game;
    this.list = [];
    const geo = new THREE.SphereGeometry(0.35, 6, 4), mat = new THREE.MeshBasicMaterial({ color: 0x262626 });
    this.pool = new ObjectPool(() => {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      game.scene.add(m);
      return m;
    }, 4, { grow: true });
  }

  reset() {
    for (const s of this.list) { s.mesh.visible = false; this.pool.release(s.mesh); }
    this.list.length = 0;
  }

  fire(tank, player) {
    const from = tank.muzzle.getWorldPosition(new THREE.Vector3());
    const tz = player.z + player.speed * T.shellFlight; // 预判：炮弹落地时玩家会在哪
    const tl = clamp(player.lateral + rand(-1.5, 1.5), -ROAD_HALF + 1, ROAD_HALF - 1);
    const w = Road.sample(tz, tl);
    const to = new THREE.Vector3(w.x, 0, w.z);
    to.lat = tl;
    const mesh = this.pool.get();
    mesh.visible = true;
    mesh.position.copy(from);
    this.list.push({ from, to, t: 0, mesh });
    this.game.fx.muzzleFlash(from);
    this.game.fx.warning(to, T.shellFlight, T.blastRadius);
    this.game.feel.shake.add(0.12);
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i];
      s.t += dt;
      const f = Math.min(1, s.t / T.shellFlight);
      s.mesh.position.lerpVectors(s.from, s.to, f);
      s.mesh.position.y += Math.sin(Math.PI * f) * 9;
      if (f < 1) continue;
      this.detonate(s.to);
      s.mesh.visible = false;
      this.pool.release(s.mesh);
      this.list.splice(i, 1);
    }
  }

  detonate(pos) {
    const g = this.game, R = T.blastRadius + 1;
    g.fx.explosion(pos, 0.9);
    g.feel.onBlast();
    const p = g.player, pp = p.mesh.position;
    // 推开方向用道路坐标：炮弹落点在玩家哪一侧
    if (!p.airborne && Math.hypot(pp.x - pos.x, pp.z - pos.z) < R) p.hit(T.blastDamage, Math.sign(p.lateral - pos.lat) || 1, 0.6);
    for (const c of g.spawner.police) {
      if (c.collidable && Math.hypot(c.mesh.position.x - pos.x, c.mesh.position.z - pos.z) < R) c.explode(g, null);
    }
  }
}
