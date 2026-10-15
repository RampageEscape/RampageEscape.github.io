import * as THREE from 'three';
import { Road } from '../world/Road.js';
import { rand } from '../core/utils.js';
import { spinWheels } from '../models/ModelLibrary.js';

const GRAVITY = 38;
const SAMPLE = {};
const UP = new THREE.Vector3(0, 1, 0);

/**
 * 所有道路上实体的基类（警车、民用车、路障、坦克）。
 * 正常行驶时用道路坐标 (z, lateral)；被撞飞后切换到世界坐标的简易刚体（wreck 状态）。
 */
export class Vehicle {
  constructor(mesh, length, width) {
    this.mesh = mesh;
    this.root = mesh.userData.root;
    this.length = length;
    this.width = width;
    this.alive = false;
    this.state = 'drive';
    this.wreck = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(), t: 0 };
  }

  spawn(scene, z, lateral, speed) {
    this.z = z;
    this.lateral = lateral;
    this.speed = speed;
    this.latVel = 0;
    this.yawOffset = 0;
    this.colW = this.width;
    this.colL = this.length;
    this.alive = true;
    this.state = 'drive';
    this.removeMe = false;
    this.burning = false;
    this.wheelZ = z;
    this.nmSide = undefined; // 擦边检测用：上一帧在玩家前面还是后面
    this.mesh.rotation.set(0, 0, 0);
    this.root?.rotation.set(0, 0, 0);
    this.mesh.visible = true;
    scene.add(this.mesh);
    this.sync();
  }

  despawn() {
    this.mesh.parent?.remove(this.mesh);
    this.alive = false;
  }

  get collidable() {
    return this.alive && this.state !== 'wreck';
  }

  sync() {
    const w = Road.sample(this.z, this.lateral, SAMPLE);
    spinWheels(this.mesh, this.z - (this.wheelZ ?? this.z));
    this.wheelZ = this.z;
    this.mesh.position.set(w.x, 0, w.z);
    this.mesh.rotation.y = w.h + this.yawOffset;
  }

  /**
   * 进入被撞飞状态：不再参与碰撞，按简易物理飞行、弹跳，几秒后由 Spawner 回收进对象池。
   * vel 用“道路局部坐标”给出（x = 道路左侧, y = 上, z = 前进方向），这里按道路朝向转成世界坐标，
   * 所以路线转弯以后，车也会往正确的方向飞。
   */
  launch(vel, spin) {
    this.state = 'wreck';
    this.wreck.pos.copy(this.mesh.position);
    this.wreck.vel.copy(vel).applyAxisAngle(UP, Road.heading(this.z));
    this.wreck.spin.copy(spin);
    this.wreck.t = 0;
  }

  updateWreck(dt, fx) {
    const w = this.wreck;
    w.t += dt;
    w.vel.y -= GRAVITY * dt;
    w.pos.addScaledVector(w.vel, dt);
    if (w.pos.y < 0) {
      w.pos.y = 0;
      if (w.vel.y < -5) {
        w.vel.y *= -0.35; // 落地弹跳
        w.spin.multiplyScalar(0.5);
        fx.dust(w.pos);
      } else {
        w.vel.y = 0;
        w.spin.multiplyScalar(Math.exp(-6 * dt));
      }
      const f = Math.exp(-3 * dt);
      w.vel.x *= f;
      w.vel.z *= f;
    }
    this.mesh.position.copy(w.pos);
    this.mesh.rotation.x += w.spin.x * dt;
    this.mesh.rotation.y += w.spin.y * dt;
    this.mesh.rotation.z += w.spin.z * dt;
    if (this.burning && Math.random() < dt * 14) fx.smokePuff(w.pos, true);
    if (w.t > (this.burning ? 2.6 : 1.8)) this.removeMe = true;
  }

  /** 被别的东西撞飞（通用实现，子类可覆盖） */
  knock(by, game, strength = 1) {
    if (this.state === 'wreck') return;
    const dir = Math.sign(this.lateral - (by?.lateral ?? 0)) || 1;
    const fwd = (by?.speed ?? 20) * 0.65 * strength + this.speed * 0.3;
    this.launch(
      new THREE.Vector3(dir * rand(4, 8) * strength, rand(5, 9) * strength, fwd),
      new THREE.Vector3(rand(-3, 3), rand(-4, 4), dir * rand(2, 5)).multiplyScalar(strength),
    );
    game.fx.impact(this.mesh.position, strength);
  }
}
