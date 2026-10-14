import * as THREE from 'three';
import { pick } from '../core/utils.js';
import { kitVehicle } from './ModelLibrary.js';

// 程序化生成的低多边形模型。以后换成美术做的 glTF 模型时，只需要替换这个文件。

// 共享几何体（底部在 y=0，方便缩放摆放）
export const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  boxBase: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  cylBase: new THREE.CylinderGeometry(0.5, 0.5, 1, 7).translate(0, 0.5, 0),
  coneBase: new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0),
  rock: new THREE.DodecahedronGeometry(1, 0),
  wheel: new THREE.CylinderGeometry(0.42, 0.42, 0.34, 10).rotateZ(Math.PI / 2),
  octagon: new THREE.CylinderGeometry(0.42, 0.42, 0.06, 8).rotateX(Math.PI / 2).rotateZ(Math.PI / 8),
};

const matCache = new Map();
export function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts }));
  return matCache.get(key);
}

// 警灯：所有警车共用两种材质，全局同步闪烁（省 draw call 也省 CPU）
const SIREN_RED = new THREE.MeshBasicMaterial({ color: 0xff2020 });
const SIREN_BLUE = new THREE.MeshBasicMaterial({ color: 0x2050ff });
export function updateSirens(t) {
  const on = Math.floor(t * 7) % 2 === 0;
  SIREN_RED.color.setHex(on ? 0xff3030 : 0x4a0d0d);
  SIREN_BLUE.color.setHex(on ? 0x101a40 : 0x3a70ff);
}

function part(parent, material, sx, sy, sz, x, y, z, geo = GEO.box) {
  const m = new THREE.Mesh(geo, material);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

// 通用车身：车头朝 +Z。root 子节点用来做车身侧倾、被炸飞时的旋转
function vehicle({ L, W, H, body, roof = body, glass = 0x26313c, cabinL = 0.46, cabinZ = -0.06, cabinH = 0.42, clearance = 0.32 }) {
  const g = new THREE.Group();
  const root = new THREE.Group();
  g.add(root);
  const bodyH = H * 0.45;
  part(root, mat(body), W, bodyH, L, 0, clearance + bodyH / 2, 0);
  const cabY = clearance + bodyH;
  part(root, mat(glass), W * 0.84, H * cabinH, L * cabinL, 0, cabY + (H * cabinH) / 2, L * cabinZ);
  part(root, mat(roof), W * 0.86, 0.1, L * cabinL * 0.9, 0, cabY + H * cabinH + 0.05, L * cabinZ);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const w = new THREE.Mesh(GEO.wheel, mat(0x1a1a1a));
      w.position.set(sx * W * 0.47, 0.42, sz * L * 0.32);
      root.add(w);
    }
    part(root, mat(0xfff6d0, { emissive: 0xfff0b0 }), W * 0.22, 0.16, 0.06, sx * W * 0.32, clearance + bodyH * 0.7, L / 2 + 0.03);
    part(root, mat(0xb01010, { emissive: 0x700000 }), W * 0.22, 0.16, 0.06, sx * W * 0.32, clearance + bodyH * 0.7, -L / 2 - 0.03);
  }
  g.userData.root = root;
  g.userData.topY = cabY + H * cabinH + 0.1;
  g.userData.dims = { L, W, H, bodyH, clearance, cabinZ };
  return g;
}

function addLightbar(g, width = 0.38) {
  const { W, L, cabinZ } = g.userData.dims;
  const y = g.userData.topY + 0.08;
  part(g.userData.root, SIREN_RED, W * width, 0.16, 0.36, -W * 0.2, y, L * cabinZ);
  part(g.userData.root, SIREN_BLUE, W * width, 0.16, 0.36, W * 0.2, y, L * cabinZ);
}

export function makePlayerCar() {
  const k = kitVehicle('sedan-sports', { length: 4.4 });
  if (k) return k;
  const g = vehicle({ L: 4.4, W: 2.0, H: 1.45, body: 0xd8261d, cabinL: 0.36, cabinZ: -0.1, cabinH: 0.36, clearance: 0.28 });
  const root = g.userData.root, { bodyH, clearance } = g.userData.dims;
  part(root, mat(0xf5f5f5), 0.32, 0.02, 4.42, 0, clearance + bodyH + 0.01, 0); // 赛车条纹
  part(root, mat(0x161616), 1.9, 0.08, 0.5, 0, 1.35, -1.95); // 尾翼
  for (const sx of [-0.6, 0.6]) part(root, mat(0x161616), 0.1, 0.35, 0.1, sx, 1.15, -1.95);
  return g;
}

/** 进化 1：肌肉车（黑色车身 + 橙色双条纹 + 进气口） */
export function makeMuscleCar() {
  const k = kitVehicle('race', { length: 4.8 });
  if (k) return k;
  const g = vehicle({ L: 4.8, W: 2.15, H: 1.55, body: 0x1d1f24, cabinL: 0.34, cabinZ: -0.12, cabinH: 0.36, clearance: 0.32 });
  const root = g.userData.root, { bodyH, clearance } = g.userData.dims, top = clearance + bodyH;
  for (const sx of [-0.3, 0.3]) part(root, mat(0xff7a1a), 0.22, 0.02, 4.82, sx, top + 0.01, 0);
  part(root, mat(0x111111), 0.7, 0.28, 1.0, 0, top + 0.14, 1.2); // 引擎盖进气口
  part(root, mat(0x111111), 2.1, 0.1, 0.55, 0, 1.45, -2.1); // 尾翼
  for (const sx of [-0.55, 0.55]) part(root, mat(0x9a9a9a), 0.16, 0.16, 0.5, sx, 0.45, -2.5, GEO.cylBase).rotation.x = Math.PI / 2;
  return g;
}

/** 进化 2：装甲车（橄榄绿装甲 + 前方撞角 + 侧装甲板） */
export function makeArmoredCar() {
  const k = kitVehicle('suv-luxury', { length: 5.4 });
  if (k) {
    part(k.userData.root, mat(0x3a3d40), k.userData.dims.W * 1.05, 0.6, 0.45, 0, 0.6, 2.8); // 撞角
    return k;
  }
  const g = vehicle({ L: 5.4, W: 2.45, H: 2.3, body: 0x55603f, glass: 0x1a1f22, cabinL: 0.5, cabinZ: 0.02, cabinH: 0.4 });
  const root = g.userData.root;
  part(root, mat(0x3a3d40), 2.7, 0.7, 0.5, 0, 0.75, 2.85); // 撞角
  for (const sx of [-1, 1]) {
    part(root, mat(0x3a3d40), 0.5, 0.18, 0.18, sx * 0.8, 1.1, 3.15); // 撞角尖刺
    part(root, mat(0x47503a), 0.12, 0.7, 4.0, sx * 1.27, 1.0, -0.1); // 侧装甲
  }
  part(root, mat(0xd8261d), 2.47, 0.16, 0.6, 0, 1.5, -0.4); // 玩家标识红条
  return g;
}

/** 坦克（敌人用默认绿色涂装；玩家进化 3 用红色涂装） */
export function makeTank(colors = {}) {
  const { hull = 0x56623f, top = hull, turretColor = 0x5f6c45, track = 0x2a2b27 } = colors;
  const g = new THREE.Group();
  const root = new THREE.Group();
  g.add(root);
  const green = mat(hull), dark = mat(track);
  part(root, green, 3.0, 1.0, 7.0, 0, 1.1, 0);
  part(root, mat(top), 2.6, 0.5, 4.6, 0, 1.85, -0.4);
  for (const sx of [-1, 1]) part(root, dark, 0.75, 1.15, 7.5, sx * 1.65, 0.6, 0);
  const turret = new THREE.Group();
  turret.position.set(0, 2.1, -0.6);
  root.add(turret);
  part(turret, mat(turretColor), 2.2, 0.9, 2.8, 0, 0.45, 0);
  const barrel = part(turret, green, 0.3, 4.2, 0.3, 0, 0.5, 1.2, GEO.cylBase);
  barrel.rotation.x = Math.PI / 2;
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.5, 5.5);
  turret.add(muzzle);
  g.userData = { root, turret, muzzle, dims: { L: 7.5, W: 3.3, H: 2.6 } };
  return g;
}

export function makePlayerTank() {
  return makeTank({ hull: 0xb8322a, top: 0x8f2820, turretColor: 0xc8402f, track: 0x1e1e1e });
}

export function makePoliceCar() {
  const k = kitVehicle('police', { length: 4.4 });
  if (k) { addLightbar(k); return k; }
  const g = vehicle({ L: 4.4, W: 2.0, H: 1.7, body: 0xeef1f5 });
  const { bodyH, clearance } = g.userData.dims;
  part(g.userData.root, mat(0x2b5cb8), 2.03, bodyH * 0.5, 2.0, 0, clearance + bodyH * 0.5, -0.1);
  part(g.userData.root, mat(0x1d1f24), 2.02, bodyH * 0.6, 0.9, 0, clearance + bodyH * 0.45, 1.8);
  addLightbar(g);
  return g;
}

export function makeSwat() {
  const k = kitVehicle('van', { length: 5.6, tint: 0x3a4250 });
  if (k) { addLightbar(k, 0.3); return k; }
  const g = vehicle({ L: 5.6, W: 2.45, H: 2.7, body: 0x1d2026, glass: 0x14181d, cabinL: 0.74, cabinZ: -0.1, cabinH: 0.48 });
  part(g.userData.root, mat(0x3a3d42), 2.5, 0.5, 0.3, 0, 0.75, 2.9); // 防撞杠
  addLightbar(g, 0.3);
  return g;
}

const CIV_COLORS = [0x8c2f2a, 0x4b5f8a, 0x6c7a5a, 0xcfcfcf, 0x2f3a46, 0x9b6b3d, 0x5a6e74];
const KIT_CIVILIANS = [['sedan', 4.4], ['sedan', 4.4], ['taxi', 4.4], ['suv', 4.6], ['hatchback-sports', 4.3], ['truck', 5.2], ['delivery', 5.6], ['ambulance', 5.6], ['firetruck', 6.4], ['garbage-truck', 6.0]];
export function makeCivilian(kind = pick(['sedan', 'sedan', 'taxi', 'suv', 'pickup'])) {
  const [name, length] = pick(KIT_CIVILIANS);
  const k = kitVehicle(name, { length });
  if (k) return k;
  const color = pick(CIV_COLORS);
  if (kind === 'taxi') {
    const g = vehicle({ L: 4.4, W: 2.0, H: 1.65, body: 0xf2c12e });
    part(g.userData.root, mat(0xfafafa), 0.7, 0.25, 0.35, 0, g.userData.topY + 0.1, -0.3);
    return g;
  }
  if (kind === 'suv') return vehicle({ L: 4.7, W: 2.15, H: 2.1, body: color, cabinL: 0.62, cabinZ: -0.08 });
  if (kind === 'pickup') {
    const g = vehicle({ L: 5.0, W: 2.1, H: 1.9, body: color, cabinL: 0.3, cabinZ: 0.12 });
    const r = g.userData.root;
    for (const sx of [-1, 1]) part(r, mat(color), 0.12, 0.45, 2.0, sx * 1.0, 1.45, -1.4);
    return g;
  }
  return vehicle({ L: 4.4, W: 2.0, H: 1.6, body: color });
}

export function makeBarrier() {
  const g = new THREE.Group();
  const root = new THREE.Group();
  g.add(root);
  for (const sx of [-1.3, 1.3]) part(root, mat(0xe8e8e8), 0.14, 1.1, 0.5, sx, 0.55, 0);
  for (let i = 0; i < 4; i++) part(root, mat(i % 2 ? 0xf2f2f2 : 0xd0201b), 0.8, 0.32, 0.12, -1.2 + i * 0.8, 0.95, 0);
  part(root, mat(0x9a9a9a), 0.08, 1.9, 0.08, 0, 0.95, -0.08);
  part(root, mat(0xc81e1e), 1, 1, 1, 0, 1.75, -0.1, GEO.octagon);
  part(root, mat(0xffd34d, { emissive: 0xffb000 }), 0.18, 0.18, 0.18, 1.3, 1.2, 0);
  g.userData.root = root;
  return g;
}

export function makeCone() {
  const g = new THREE.Group();
  const root = new THREE.Group();
  g.add(root);
  part(root, mat(0x222222), 0.7, 0.08, 0.7, 0, 0.04, 0);
  part(root, mat(0xf06a12), 0.32, 0.9, 0.32, 0, 0.05, 0, GEO.coneBase);
  part(root, mat(0xffffff), 0.4, 0.12, 0.4, 0, 0.42, 0, GEO.cylBase);
  g.userData.root = root;
  return g;
}
