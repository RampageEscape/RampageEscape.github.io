import * as THREE from 'three';
import { pick } from '../core/utils.js';
import { kitVehicle, hasLodCars, CIV_LIVERIES } from './ModelLibrary.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
export const SIREN = { red: SIREN_RED, blue: SIREN_BLUE }; // 水警船也用同一组警灯材质
export function updateSirens(t) {
  const on = Math.floor(t * 7) % 2 === 0;
  // 数值大于 1 = HDR，经过 Bloom 会发出光晕
  AMBER.color.setRGB(...(Math.floor(t * 3) % 2 ? [4, 2.4, 0.2] : [0.4, 0.25, 0.02])); // 路障上的黄色警示灯慢闪
  if (on) { SIREN_RED.color.setRGB(7, 0.5, 0.4); SIREN_BLUE.color.setRGB(0.05, 0.08, 0.3); }
  else { SIREN_RED.color.setRGB(0.3, 0.04, 0.04); SIREN_BLUE.color.setRGB(0.4, 0.9, 7); }
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

// skin：玩家 2 用 'p2'（珍珠白车漆 / 蓝色涂装），方便双人对战时分辨
export function makePlayerCar(skin) {
  const k = kitVehicle(skin === 'p2' ? 'hero-pearl' : 'hero-red', { length: 4.6 }) ?? kitVehicle('sedan-sports', { length: 4.4, tint: skin === 'p2' ? 0x3b6fd8 : undefined });
  if (k) return k;
  const g = vehicle({ L: 4.4, W: 2.0, H: 1.45, body: 0xd8261d, cabinL: 0.36, cabinZ: -0.1, cabinH: 0.36, clearance: 0.28 });
  const root = g.userData.root, { bodyH, clearance } = g.userData.dims;
  part(root, mat(0xf5f5f5), 0.32, 0.02, 4.42, 0, clearance + bodyH + 0.01, 0); // 赛车条纹
  part(root, mat(0x161616), 1.9, 0.08, 0.5, 0, 1.35, -1.95); // 尾翼
  for (const sx of [-0.6, 0.6]) part(root, mat(0x161616), 0.1, 0.35, 0.1, sx, 1.15, -1.95);
  return g;
}

/** 进化 1：肌肉车（黑色车身 + 橙色双条纹 + 进气口） */
export function makeMuscleCar(skin) {
  const k = kitVehicle(skin === 'p2' ? 'hero-pearl' : 'hero-graphite', { length: 4.8 }) ?? kitVehicle('race', { length: 4.8, tint: skin === 'p2' ? 0x3b6fd8 : undefined });
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
/** 在低模真车上加装甲：前防撞杆、车门下的侧裙装甲、车顶行李架 + 射灯 */
function armorUp(k, color = 0x2f3236) {
  const r = k.userData.root, { W, H, L } = k.userData.dims, steel = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.8 });
  const add = (sx, sy, sz, x, y, z, material = steel) => { const m = new THREE.Mesh(GEO.box, material); m.scale.set(sx, sy, sz); m.position.set(x, y, z); m.castShadow = true; r.add(m); };
  const fz = L / 2 + 0.08;
  add(W * 0.74, 0.12, 0.12, 0, H * 0.24, fz); // 防撞杆：下横杆
  add(W * 0.6, 0.1, 0.1, 0, H * 0.5, fz - 0.05); // 上横杆
  for (const s of [-1, 1]) add(0.1, H * 0.34, 0.1, s * W * 0.28, H * 0.36, fz);
  add(W * 0.4, H * 0.18, 0.05, 0, H * 0.37, fz + 0.02); // 中间护板
  for (const s of [-1, 1]) add(0.05, 0.2, L * 0.4, s * W * 0.455, H * 0.3, -L * 0.03); // 侧裙装甲（两个车轮之间）
  for (const s of [-1, 1]) add(0.06, 0.05, L * 0.3, s * W * 0.24, H + 0.03, -L * 0.1); // 车顶行李架
  add(W * 0.5, 0.05, 0.06, 0, H + 0.03, L * 0.05);
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3.8, 3.2) });
  for (const x of [-0.45, -0.15, 0.15, 0.45]) add(0.18, 0.12, 0.06, x * W * 0.5, H + 0.1, L * 0.05 + 0.04, lamp); // 车顶射灯
  return k;
}

export function makeArmoredCar(skin) {
  const real = kitVehicle(skin === 'p2' ? 'lod-armoredP2' : 'lod-armored', { length: 5.0 });
  if (real) return armorUp(real);
  const k = kitVehicle('suv-luxury', { length: 5.4, tint: skin === 'p2' ? 0x4a78c8 : undefined });
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

/** 把一组零件按材质合并成少量网格（keep 里的子物体保持独立，例如会转的炮塔） */
function mergeGroup(group, keep = []) {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert(), m4 = new THREE.Matrix4(), groups = new Map(), drop = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o.parent; p && p !== group; p = p.parent) if (keep.includes(p)) return;
    if (keep.includes(o)) return;
    let geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    geo.applyMatrix4(m4.multiplyMatrices(inv, o.matrixWorld));
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (!groups.has(o.material)) groups.set(o.material, []);
    groups.get(o.material).push(geo);
    drop.push(o);
  });
  for (const o of drop) o.parent.remove(o);
  for (const [material, list] of groups) {
    const mesh = new THREE.Mesh(mergeGeometries(list), material);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
}

// 迷彩：灰度斑块（乘上车漆颜色，敌人绿、玩家红 / 蓝都能用）
const CAMO_TEX = (() => {
  const c = Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 256, 256);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [shade, n] of [['#b4b4b4', 14], ['#7c7c7c', 12], ['#d8d8d8', 8]]) {
    g.fillStyle = shade;
    for (let i = 0; i < n; i++) {
      const x = rnd() * 256, y = rnd() * 256, r = 14 + rnd() * 26;
      for (const [dx, dy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]]) { // 四边连续，平铺不出接缝
        g.beginPath();
        for (let a = 0; a < 7; a++) { const ang = (a / 7) * Math.PI * 2, rr = r * (0.6 + rnd() * 0.6); g.lineTo(x + dx + Math.cos(ang) * rr * 1.5, y + dy + Math.sin(ang) * rr); }
        g.closePath(); g.fill();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(0.3, 0.3);
  return t;
})();
const TRACK_MAT = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.9, metalness: 0.3 });
const TANK_DARK = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.6, metalness: 0.6 });
const TANK_WHEEL = new THREE.MeshStandardMaterial({ color: 0x3a3d33, roughness: 0.7, metalness: 0.4 });

/** 侧视轮廓（z, y）挤出成宽 w 的实体，左右居中 */
function sideExtrude(points, w, bevel = 0.04) {
  const sh = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  return new THREE.ExtrudeGeometry(sh, { depth: w, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1 }).rotateY(-Math.PI / 2).translate(w / 2, 0, 0);
}
/** 跑道形（两头半圆）轮廓 */
function stadium(path, len, r, cy) {
  const h = len / 2 - r;
  path.moveTo(-h, cy - r);
  path.lineTo(h, cy - r);
  path.absarc(h, cy, r, -Math.PI / 2, Math.PI / 2, false);
  path.lineTo(-h, cy + r);
  path.absarc(-h, cy, r, Math.PI / 2, Math.PI * 1.5, false);
  return path;
}

/**
 * 坦克（敌人用默认绿色涂装；玩家进化 3 用红色 / 蓝色涂装）
 *   车体：下车体 + 上车体（前装甲斜板）挤出，迷彩涂装；侧裙装甲板；两侧履带（环形履带 + 6 个负重轮 + 主动轮 / 诱导轮）
 *   炮塔：多边形俯视轮廓挤出、侧壁内倾；防盾、长炮管 + 抽烟装置 + 炮口制退器，车长指挥塔 + 机枪、天线、烟雾弹发射器、后部储物篮
 */
export function makeTank(colors = {}) {
  const { hull = 0x56623f, turretColor = 0x5f6c45 } = colors;
  const g = new THREE.Group();
  const root = new THREE.Group();
  g.add(root);
  const paint = new THREE.MeshStandardMaterial({ color: hull, map: CAMO_TEX, roughness: 0.75, metalness: 0.3 });
  const tpaint = new THREE.MeshStandardMaterial({ color: turretColor, map: CAMO_TEX, roughness: 0.7, metalness: 0.3 });
  const add = (parent, geo, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    parent.add(m);
    return m;
  };
  // 车体
  add(root, sideExtrude([[-3.4, 0.45], [2.9, 0.45], [3.6, 1.15], [-3.55, 1.15]], 2.2), paint);
  add(root, sideExtrude([[-3.6, 1.12], [3.72, 1.12], [2.55, 1.66], [-3.45, 1.66], [-3.62, 1.4]], 3.5, 0.05), paint);
  add(root, new THREE.BoxGeometry(2.4, 0.06, 0.5), TANK_DARK, 0, 1.68, -3.0); // 发动机散热格栅
  for (const sx of [-1, 1]) {
    add(root, new THREE.BoxGeometry(0.28, 0.14, 0.06), new THREE.MeshBasicMaterial({ color: 0xfff0c8 }), sx * 1.25, 1.42, 3.12, -0.5); // 车头灯
    // 履带：跑道形外圈减掉内圈 = 一条环形履带，里面放负重轮
    const outer = stadium(new THREE.Shape(), 7.1, 0.52, 0.52);
    outer.holes.push(stadium(new THREE.Path(), 6.86, 0.4, 0.52));
    const belt = new THREE.ExtrudeGeometry(outer, { depth: 0.72, bevelEnabled: false, curveSegments: 10 }).rotateY(-Math.PI / 2).translate(0.36, 0, 0);
    add(root, belt, TRACK_MAT, sx * 1.46, 0, 0);
    for (let k = 0; k < 6; k++) {
      add(root, new THREE.CylinderGeometry(0.36, 0.36, 0.6, 18).rotateZ(Math.PI / 2), TANK_WHEEL, sx * 1.46, 0.48, -2.45 + k * 0.98);
      add(root, new THREE.CylinderGeometry(0.12, 0.12, 0.64, 10).rotateZ(Math.PI / 2), TANK_DARK, sx * 1.46, 0.48, -2.45 + k * 0.98);
    }
    for (const z of [-3.0, 3.0]) add(root, new THREE.CylinderGeometry(0.34, 0.34, 0.62, 14).rotateZ(Math.PI / 2), TANK_DARK, sx * 1.46, 0.6, z);
    add(root, new THREE.BoxGeometry(0.06, 0.42, 6.2), paint, sx * 1.84, 0.95, 0.1); // 侧裙装甲
    for (let k = 0; k < 5; k++) add(root, new THREE.BoxGeometry(0.03, 0.4, 0.04), TANK_DARK, sx * 1.875, 0.95, -2.4 + k * 1.2); // 侧裙分块缝
  }
  // 炮塔（会转）
  const turret = new THREE.Group();
  turret.position.set(0, 1.66, -0.5);
  root.add(turret);
  const foot = new THREE.Shape();
  foot.moveTo(-0.85, -1.75); foot.lineTo(0.85, -1.75); foot.lineTo(1.35, -0.35); foot.lineTo(1.2, 1.65); foot.lineTo(-1.2, 1.65); foot.lineTo(-1.35, -0.35); foot.closePath();
  const turretGeo = new THREE.ExtrudeGeometry(foot, { depth: 0.78, bevelEnabled: true, bevelSize: 0.1, bevelThickness: 0.1, bevelSegments: 2 }).rotateX(-Math.PI / 2);
  const tp = turretGeo.attributes.position;
  for (let i = 0; i < tp.count; i++) if (tp.getY(i) > 0.4) tp.setXYZ(i, tp.getX(i) * 0.86, tp.getY(i), tp.getZ(i) * 0.94); // 侧壁内倾
  turretGeo.computeVertexNormals();
  add(turret, turretGeo, tpaint, 0, 0.1, 0);
  add(turret, new THREE.BoxGeometry(0.95, 0.55, 0.4), tpaint, 0, 0.5, 1.8); // 防盾
  add(turret, new THREE.CylinderGeometry(0.1, 0.13, 4.3, 14).rotateX(Math.PI / 2), TANK_DARK, 0, 0.5, 4.1);
  add(turret, new THREE.CylinderGeometry(0.17, 0.17, 0.6, 14).rotateX(Math.PI / 2), TANK_DARK, 0, 0.5, 3.7); // 抽烟装置
  add(turret, new THREE.CylinderGeometry(0.18, 0.18, 0.42, 14).rotateX(Math.PI / 2), TANK_DARK, 0, 0.5, 6.15); // 炮口制退器
  add(turret, new THREE.CylinderGeometry(0.32, 0.36, 0.3, 16), tpaint, 0.5, 1.02, -0.55); // 车长指挥塔
  add(turret, new THREE.CylinderGeometry(0.28, 0.28, 0.06, 16), TANK_DARK, 0.5, 1.2, -0.55);
  add(turret, new THREE.CylinderGeometry(0.035, 0.035, 0.9, 8).rotateX(Math.PI / 2), TANK_DARK, 0.5, 1.32, -0.15); // 机枪
  add(turret, new THREE.BoxGeometry(0.14, 0.16, 0.36), TANK_DARK, 0.5, 1.3, -0.55);
  add(turret, new THREE.CylinderGeometry(0.28, 0.28, 0.06, 16), TANK_DARK, -0.45, 0.99, -0.2); // 炮手舱盖
  add(turret, new THREE.CylinderGeometry(0.015, 0.02, 2.2, 6), TANK_DARK, -0.75, 1.95, -1.3); // 天线
  for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) add(turret, new THREE.CylinderGeometry(0.06, 0.06, 0.3, 8).rotateX(Math.PI / 2 - 0.4), TANK_DARK, sx * (1.1 - k * 0.13), 0.78, 0.95 + k * 0.17); // 烟雾弹发射器
  add(turret, new THREE.BoxGeometry(2.0, 0.42, 0.7), TANK_DARK, 0, 0.5, -2.1); // 后部储物篮
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.5, 6.4);
  turret.add(muzzle);
  mergeGroup(turret, [muzzle]);
  mergeGroup(root, [turret]);
  g.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  g.userData = { root, turret, muzzle, dims: { L: 7.5, W: 3.3, H: 2.6 }, topY: 2.6 };
  return g;
}

export function makePlayerTank(skin) {
  if (skin === 'p2') return makeTank({ hull: 0x2f5fb8, top: 0x24498f, turretColor: 0x3a6fd0, track: 0x1e1e1e });
  return makeTank({ hull: 0xb8322a, top: 0x8f2820, turretColor: 0xc8402f, track: 0x1e1e1e });
}

export function makePoliceCar() {
  // 有低模真车就用它（黑白警察涂装 + 警灯），否则用 Kenney 卡通警车
  const real = kitVehicle('lod-police', { length: 4.5 });
  if (real) { addLightbar(real, 0.3); return real; }
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
  const real = kitVehicle('lod-swat', { length: 5.0 });
  if (real) { armorUp(real, 0x1a1c20); addLightbar(real, 0.3); return real; }
  const k = kitVehicle('van', { length: 5.6, tint: 0x3a4250 });
  if (k) { addLightbar(k, 0.3); return k; }
  const g = vehicle({ L: 5.6, W: 2.45, H: 2.7, body: 0x1d2026, glass: 0x14181d, cabinL: 0.74, cabinZ: -0.1, cabinH: 0.48 });
  part(g.userData.root, mat(0x3a3d42), 2.5, 0.5, 0.3, 0, 0.75, 2.9); // 防撞杠
  addLightbar(g, 0.3);
  return g;
}

const CIV_COLORS = [0x8c2f2a, 0x4b5f8a, 0x6c7a5a, 0xcfcfcf, 0x2f3a46, 0x9b6b3d, 0x5a6e74];
// 小车（会用低模真车）占大多数，大车（Kenney 模型）偶尔出现
const KIT_CIVILIANS = [['sedan', 4.4], ['sedan', 4.4], ['sedan', 4.4], ['taxi', 4.4], ['suv', 4.6], ['hatchback-sports', 4.3]];
// 私家车 / 的士 / SUV 用低模真车（各种车漆），货车、救护车、消防车这些大车还是 Kenney 模型
const REAL_KINDS = new Set(['sedan', 'taxi', 'suv', 'hatchback-sports']);
export function makeCivilian(kind = pick(['sedan', 'sedan', 'taxi', 'suv', 'pickup']), forced = null) {
  const [name, length] = forced ?? pick(KIT_CIVILIANS);
  if (REAL_KINDS.has(name) && hasLodCars()) {
    const real = kitVehicle('lod-' + (name === 'taxi' ? 'taxi' : pick(CIV_LIVERIES)), { length: Math.max(4.4, length) });
    real.userData.kind = [name, length];
    return real;
  }
  const k = kitVehicle(name, { length });
  if (k) { k.userData.kind = [name, length]; return k; }
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

// 警用路障：两组 A 字支架 + 两块红白反光斜纹板（上面一块印着 POLICE 警察）+ 顶上闪烁的黄色警示灯
const BARRIER_TEX = (() => {
  const c = Object.assign(document.createElement('canvas'), { width: 512, height: 64 });
  const g = c.getContext('2d');
  g.fillStyle = '#f4f4f2'; g.fillRect(0, 0, 512, 64);
  g.fillStyle = '#d0201b';
  for (let x = -64; x < 576; x += 64) { g.beginPath(); g.moveTo(x, 64); g.lineTo(x + 32, 64); g.lineTo(x + 64, 0); g.lineTo(x + 32, 0); g.closePath(); g.fill(); }
  g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillRect(150, 12, 212, 40);
  g.fillStyle = '#1d2b4a'; g.font = 'bold 30px "Arial Black", "PingFang TC", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('POLICE 警察', 256, 33);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const BARRIER_MAT = new THREE.MeshStandardMaterial({ map: BARRIER_TEX, roughness: 0.35, metalness: 0.1, emissive: 0x222222, emissiveMap: BARRIER_TEX, emissiveIntensity: 0.3 });
export const AMBER = new THREE.MeshBasicMaterial({ color: 0xffb000 });
export function makeBarrier() {
  const g = new THREE.Group();
  const root = new THREE.Group();
  g.add(root);
  const frame = new THREE.MeshStandardMaterial({ color: 0xe8e8e6, roughness: 0.5 });
  const foot = new THREE.MeshStandardMaterial({ color: 0x1d1e20, roughness: 0.8 });
  for (const sx of [-1.35, 1.35]) {
    for (const sz of [-0.35, 0.35]) {
      const a = new THREE.Vector3(sx, 0, sz), b = new THREE.Vector3(sx, 1.15, 0), dir = b.clone().sub(a);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, dir.length(), 0.07), frame);
      leg.position.copy(a).add(b).multiplyScalar(0.5);
      leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      root.add(leg);
    }
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.9), foot);
    f.position.set(sx, 0.03, 0);
    root.add(f);
  }
  const board = new THREE.BoxGeometry(3.1, 0.3, 0.04);
  for (const y of [1.0, 0.5]) {
    const b = new THREE.Mesh(board, BARRIER_MAT);
    b.position.set(0, y, 0.02);
    root.add(b);
  }
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.16, 12), AMBER);
  lamp.position.set(1.35, 1.25, 0);
  root.add(lamp);
  mergeGroup(root);
  g.userData.root = root;
  return g;
}

/** 钉刺带：一条贴地的折叠钢架 + 一排排银色钢钉，两端黄黑警示块（合并成两个网格） */
const SPIKE_GEO = (() => {
  const base = new THREE.BoxGeometry(3.3, 0.06, 0.55).translate(0, 0.03, 0);
  const spikes = [];
  for (let i = 0; i < 22; i++) for (const z of [-0.16, 0.16]) spikes.push(new THREE.ConeGeometry(0.045, 0.16, 5).translate(-1.55 + i * 0.148, 0.14, z + (i % 2) * 0.05));
  return { base, spikes: mergeGeometries(spikes) };
})();
export function makeSpikeStrip() {
  const g = new THREE.Group();
  const root = new THREE.Group();
  g.add(root);
  root.add(new THREE.Mesh(SPIKE_GEO.base, mat(0x2a2b2e)));
  const sp = new THREE.Mesh(SPIKE_GEO.spikes, new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.25 }));
  root.add(sp);
  for (const sx of [-1.75, 1.75]) part(root, mat(0xf2c21a), 0.2, 0.12, 0.6, sx, 0.06, 0);
  g.userData.root = root;
  return g;
}

/** 油渍：不规则的黑色油膜，带彩虹色的油光（iridescence） */
const OIL_MAT = new THREE.MeshPhysicalMaterial({ color: 0x060606, roughness: 0.06, metalness: 0.3, iridescence: 1, iridescenceIOR: 1.6, iridescenceThicknessRange: [200, 700], transparent: true, opacity: 0.92, depthWrite: false });
const OIL_GEO = (() => {
  const shape = new THREE.Shape();
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2, r = 1 + 0.18 * Math.sin(a * 3 + 1) + 0.1 * Math.sin(a * 7);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i) shape.lineTo(x, y); else shape.moveTo(x, y);
  }
  return new THREE.ShapeGeometry(shape, 6).rotateX(-Math.PI / 2);
})();
export function makeOilSlick() {
  const g = new THREE.Group();
  const root = new THREE.Group();
  g.add(root);
  const m = new THREE.Mesh(OIL_GEO, OIL_MAT);
  m.scale.set(3.4, 1, 2.2);
  m.position.y = 0.05;
  m.renderOrder = 1;
  root.add(m);
  g.userData.root = root;
  return g;
}

// 红色爆炸油桶：桶身贴黄色易燃警示标签 + 两道加强筋 + 顶盖（撞到 / 被警车撞到会爆炸，连锁引爆附近的油桶）
const BARREL_TEX = (() => {
  const c = Object.assign(document.createElement('canvas'), { width: 256, height: 128 });
  const g = c.getContext('2d');
  g.fillStyle = '#c42519'; g.fillRect(0, 0, 256, 128);
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 0, 256, 10); g.fillRect(0, 118, 256, 10);
  for (const cx of [64, 192]) {
    g.save(); g.translate(cx, 64); g.rotate(Math.PI / 4);
    g.fillStyle = '#f5c400'; g.fillRect(-30, -30, 60, 60);
    g.strokeStyle = '#111'; g.lineWidth = 4; g.strokeRect(-26, -26, 52, 52);
    g.restore();
    g.fillStyle = '#111'; // 火焰图标
    g.beginPath(); g.moveTo(cx, 40); g.quadraticCurveTo(cx + 22, 62, cx + 10, 82); g.quadraticCurveTo(cx, 90, cx - 10, 82); g.quadraticCurveTo(cx - 20, 64, cx - 4, 52); g.quadraticCurveTo(cx - 2, 64, cx + 4, 66); g.closePath(); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const BARREL_MAT = new THREE.MeshStandardMaterial({ map: BARREL_TEX, roughness: 0.4, metalness: 0.5 });
const BARREL_TOP = new THREE.MeshStandardMaterial({ color: 0x9a1d14, roughness: 0.45, metalness: 0.6 });
export function makeBarrel() {
  const g = new THREE.Group();
  const root = new THREE.Group();
  g.add(root);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.05, 22, 1, true).translate(0, 0.525, 0), BARREL_MAT);
  root.add(body);
  for (const y of [0.35, 0.7]) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(0.425, 0.025, 6, 26).rotateX(Math.PI / 2), BARREL_TOP);
    rib.position.y = y;
    root.add(rib);
  }
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.04, 22).translate(0, 1.05, 0), BARREL_TOP);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 10).translate(0.22, 1.09, 0), BARREL_TOP);
  root.add(lid, cap);
  mergeGroup(root);
  g.userData.root = root;
  return g;
}

/** 挑战“抢劫运钞车”：金色装甲车 + 头顶的钱袋图标（远远就看得到） */
const MONEY_TEX = (() => {
  const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
  const g = c.getContext('2d');
  g.font = '96px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('💰', 64, 72);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
export function makeCashVan() {
  const real = kitVehicle('lod-gold', { length: 4.9 });
  const k = real ? armorUp(real, 0x8a6a1c) : kitVehicle('van', { length: 5.2, tint: 0xd4a72c }) ?? vehicle({ L: 5.2, W: 2.2, H: 2.2, body: 0xd4a72c });
  const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: MONEY_TEX, depthWrite: false }));
  icon.scale.setScalar(2.2);
  icon.position.y = k.userData.topY + 1.6;
  k.add(icon);
  k.userData.icon = icon;
  return k;
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
