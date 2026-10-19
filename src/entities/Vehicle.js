import * as THREE from 'three';
import { Road, WATER_Y } from '../world/Road.js';
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
    this.bobPhase = rand(0, 6.28);
  }

  /** 换一个陆地模型（例如高精度车模加载完成后替换）；正在开船时只替换备用的车模型 */
  replaceCarMesh(next) {
    const cur = this.carMesh ?? this.mesh;
    this.carMesh = next;
    if (this.mesh !== cur) return;
    const parent = cur.parent;
    next.position.copy(cur.position);
    next.rotation.copy(cur.rotation);
    next.visible = cur.visible;
    parent?.remove(cur);
    this.mesh = next;
    this.root = next.userData.root;
    parent?.add(next);
  }

  /** 海上用的船模型（子类覆盖；返回 null 表示没有船的版本，例如坦克） */
  makeBoat() {
    return null;
  }

  /**
   * 上船 / 下船：在陆地模型和船模型之间切换（同一个实体、同样的碰撞尺寸和 AI，只换外观）。
   * 船模型第一次用到时才创建，之后一直留着复用。
   */
  setWater(on) {
    if (on === !!this.onWater) return;
    if (on && !this.boatMesh) this.boatMesh = this.makeBoat();
    if (on && !this.boatMesh) return;
    this.carMesh ??= this.mesh;
    this.onWater = on;
    const next = on ? this.boatMesh : this.carMesh, parent = this.mesh.parent;
    next.position.copy(this.mesh.position);
    next.rotation.copy(this.mesh.rotation);
    next.visible = this.mesh.visible;
    parent?.remove(this.mesh);
    this.mesh = next;
    this.root = next.userData.root;
    parent?.add(next);
  }

  spawn(scene, z, lateral, speed) {
    this.setWater(false); // 对象池里拿出来的可能还是船，先换回陆地模型
    this.visLat = this.visZ = 0;
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
    this.nmSides = []; // 擦边检测用：上一帧在每位玩家的前面还是后面
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

  /**
   * 碰撞分离时，逻辑位置要立刻推开（避免下一帧重复碰撞），但画面上如果也瞬间跳过去会显得“卡一下”。
   * 所以把跳跃量记成视觉偏移，在 0.15 秒内平滑地收回来。
   */
  snapTo(lateral, z = this.z) {
    this.visLat = (this.visLat ?? 0) + this.lateral - lateral;
    this.visZ = (this.visZ ?? 0) + this.z - z;
    this.lateral = lateral;
    this.z = z;
  }

  sync() {
    const water = Road.isWater(this.z);
    if (water !== !!this.onWater) this.setWater(water);
    const now = performance.now(), dt = Math.min(0.1, (now - (this.lastSync ?? now)) / 1000);
    this.lastSync = now;
    if (this.visLat || this.visZ) {
      const k = Math.exp(-14 * dt);
      this.visLat = Math.abs(this.visLat * k) < 0.01 ? 0 : this.visLat * k;
      this.visZ = Math.abs(this.visZ * k) < 0.01 ? 0 : this.visZ * k;
    }
    const w = Road.sample(this.z + (this.visZ ?? 0), this.lateral + (this.visLat ?? 0), SAMPLE);
    spinWheels(this.mesh, this.z - (this.wheelZ ?? this.z));
    this.wheelZ = this.z;
    let y = 0;
    if (this.onWater) {
      // 船在浪里上下起伏、左右摇晃；开得快船头微微抬起
      const t = performance.now() * 0.001 + this.bobPhase;
      y = WATER_Y - 0.12 + Math.sin(t * 2.1) * 0.07;
      if (this.root) {
        this.root.rotation.z = Math.sin(t * 1.6) * 0.045;
        this.root.rotation.x = -Math.min(0.08, this.speed * 0.003) + Math.sin(t * 2.3 + 1) * 0.025;
      }
    }
    this.mesh.position.set(w.x, y, w.z);
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
    this.wreck.splashed = false;
  }

  updateWreck(dt, fx) {
    const w = this.wreck;
    w.t += dt;
    w.vel.y -= GRAVITY * dt;
    w.pos.addScaledVector(w.vel, dt);
    if (this.onWater && w.pos.y < WATER_Y) {
      // 海上：砸进水里溅起水花，然后慢慢沉下去
      if (!w.splashed) { w.splashed = true; fx.splash?.(w.pos, 1); }
      w.vel.y = -1.6;
      const f = Math.exp(-4 * dt);
      w.vel.x *= f;
      w.vel.z *= f;
      w.spin.multiplyScalar(f);
    } else if (w.pos.y < 0 && !this.onWater) {
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
