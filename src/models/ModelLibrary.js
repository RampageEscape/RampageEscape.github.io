import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

/**
 * 3D 模型库：Kenney Car Kit（CC0，可商用）。
 * 游戏启动前一次性加载全部 glb，之后用 clone() 复用（几何体和材质共享，不额外占内存）。
 * 加载失败的模型会自动回退到程序生成的方块模型，游戏照样能玩。
 */
const FILES = [
  'sedan-sports', 'race', 'suv-luxury', 'police', 'van',
  'sedan', 'taxi', 'suv', 'truck', 'delivery', 'ambulance', 'firetruck', 'garbage-truck', 'hatchback-sports',
  'cone', 'debris-door', 'debris-tire', 'debris-bumper', 'debris-spoiler-a', 'debris-plate-a',
];
const cache = new Map();

export async function loadModels(onProgress) {
  const loader = new GLTFLoader();
  let done = 0;
  await Promise.all(FILES.map((name) => loader.loadAsync(`assets/models/${name}.glb`)
    .then((gltf) => {
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        // 稍微提高光泽，配合环境反射让车漆有金属感
        o.material.roughness = 0.38;
        o.material.metalness = 0.25;
        o.material.envMapIntensity = 0.8;
      });
      cache.set(name, gltf.scene);
    })
    .catch((e) => console.warn(`[models] ${name} 加载失败，使用方块模型`, e))
    .finally(() => onProgress?.(++done / FILES.length))));
}

export const hasModel = (name) => cache.has(name);

// ---------------------------------------------------------------- 环境模型（Poly Haven 实拍扫描岩石，CC0）
// 几何体归一化成 1×1×1（底部在 y=0、中心在原点），摆放时直接用米数缩放；颜色用实例颜色染成各地图的岩石色
const ENV = {};
export const envModel = (name) => ENV[name] ?? null;
export async function loadEnvModels() {
  const loader = new GLTFLoader();
  for (const name of ['cliff']) {
    try {
      const gltf = await loader.loadAsync(`assets/models/env/${name}.glb`);
      let mesh = null;
      gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
      gltf.scene.updateMatrixWorld(true);
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      geo.computeBoundingBox();
      const b = geo.boundingBox, size = b.getSize(new THREE.Vector3());
      geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
      geo.scale(1 / size.x, 1 / size.y, 1 / size.z);
      const mat = mesh.material;
      mat.envMapIntensity = 0.5;
      ENV[name] = { geo, mat };
    } catch (e) {
      console.warn(`[env] ${name} 加载失败，使用低多边形岩石`, e);
    }
  }
}

function tinted(model, tint) {
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    o.material.color.multiply(new THREE.Color(tint));
  });
}

/**
 * 克隆一辆车，缩放到指定车长、底部贴地、居中，并包装成和程序模型一样的结构：
 *   group.userData = { root, wheels, dims: { L, W, H, ... }, topY }
 * root 用来做侧倾 / 被炸飞的旋转；wheels 是车轮节点，Vehicle 会按速度转动它们。
 */
export function kitVehicle(name, { length = 4.4, tint } = {}) {
  const src = cache.get(name);
  if (!src) return null;
  const model = src.clone(true);
  if (tint) tinted(model, tint);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const s = length / size.z;
  model.scale.setScalar(s);
  model.position.set(-center.x * s, -box.min.y * s, -center.z * s);

  const root = new THREE.Group();
  root.add(model);
  const g = new THREE.Group();
  g.add(root);
  const wheels = [];
  model.traverse((o) => { if (o.name.startsWith('wheel')) wheels.push(o); });
  const H = size.y * s, W = size.x * s;
  g.userData = { root, wheels, wheelR: (src.userData.wheelR ?? 0.3) * s, wheelAxis: src.userData.wheelAxis ?? 'x', kit: true, topY: H, dims: { L: length, W, H, bodyH: H * 0.45, clearance: 0.3, cabinZ: -0.05 } };
  return g;
}

/** 按行驶距离转动车轮（车轮节点绕父节点的 X 轴转，左右轮都对） */
export function spinWheels(mesh, dist) {
  const u = mesh.userData;
  if (!u.wheels?.length || !dist) return;
  const a = dist / u.wheelR, axis = u.wheelAxis ?? 'x';
  for (const w of u.wheels) w.rotation[axis] += a;
}

/** 爆炸碎片：真实的车门、轮胎、保险杠、尾翼（克隆后缩放） */
export const DEBRIS = ['debris-door', 'debris-tire', 'debris-bumper', 'debris-spoiler-a', 'debris-plate-a'];
export function kitPart(name, scale = 1.4) {
  const src = cache.get(name);
  if (!src) return null;
  const m = src.clone(true);
  m.scale.setScalar(scale);
  return m;
}

// ---------------------------------------------------------------- 高精度主角车
/**
 * Khronos 官方示例模型 “Car Concept”（CC BY 4.0）：清漆车漆、真实轮胎和轮毂、三种车漆款式。
 * 用 Draco 压缩网格 + KTX2 压缩贴图，总共约 3.4MB。游戏启动后在后台加载，加载好之前先用 Kenney 跑车。
 * 加载后整理成两个模板放进模型缓存：hero-red（红色糖果漆）、hero-graphite（石墨黑虹彩漆）。
 */
async function applyVariant(root, parser, index) {
  const jobs = [];
  root.traverse((o) => {
    const ext = o.isMesh && o.userData.gltfExtensions?.KHR_materials_variants;
    const m = ext?.mappings.find((mp) => mp.variants.includes(index));
    if (m) jobs.push(parser.getDependency('material', m.material).then((mat) => { o.material = mat; }));
  });
  await Promise.all(jobs);
}

function prepareHero(scene) {
  scene.updateMatrixWorld(true);
  const centerOf = (name) => {
    const n = scene.getObjectByName(name);
    return n ? new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3()) : null;
  };
  // 车轮：给每个车轮包一个“以车轮中心为原点”的转轴，否则会绕着车身中心转
  let wheelR = 0.35;
  for (const name of ['WheelFrontL', 'WheelFrontR', 'WheelRearL', 'WheelRearR']) {
    const w = scene.getObjectByName(name);
    if (!w) continue;
    const box = new THREE.Box3().setFromObject(w), c = box.getCenter(new THREE.Vector3());
    wheelR = box.getSize(new THREE.Vector3()).y / 2;
    const parent = w.parent, pivot = new THREE.Object3D();
    pivot.name = 'wheelPivot';
    parent.worldToLocal(c);
    pivot.position.copy(c);
    parent.add(pivot);
    w.position.sub(c);
    pivot.add(w);
  }
  // 朝向：车头（大灯）要朝 +Z
  const size = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3());
  const along = size.x > size.z ? 'x' : 'z';
  const head = centerOf('BodyHeadlights'), tail = centerOf('BodyTaillights');
  const wrap = new THREE.Group();
  wrap.add(scene);
  if (along === 'x') scene.rotation.y = head && tail && head.x < tail.x ? Math.PI / 2 : -Math.PI / 2;
  else if (head && tail && head.z < tail.z) scene.rotation.y = Math.PI;
  wrap.userData.wheelR = wheelR;
  wrap.userData.wheelAxis = along === 'x' ? 'z' : 'x'; // 车轴方向（在车轮转轴的父坐标系里）
  optimizeHero(scene);
  return wrap;
}

// 从外面看不到、却很费性能的零件：雨刷（2.4 万个三角形！）、引擎、踏板、刹车卡钳、车底、内饰骨架……
const HERO_HIDDEN = /^(BodyWindshieldWipers|BodyHoodInterior|BodyHoodUnder|BodyUnderside|Engine|Axles|InteriorCage|InteriorFloor|InteriorPedal|InteriorSteering(Base|Cylinder|Dash|Handle|Emblem)|InteriorDoor[LR]0[3-6]|InteriorRearHatch)|BrakePad/;
// 只让这些材质投影（车身轮廓 + 轮胎），玻璃、内饰、轮毂这些细节不进阴影贴图
const HERO_SHADOW = /Paint|Panel|Tire/;
// 原模型的玻璃用“透射”（transmission）：Three.js 为了它每帧要把整个场景多画一遍（draw call 翻倍）。
// 换成深色、半透明、会反射天空的普通玻璃，看起来几乎一样，性能省一半。
const HERO_GLASS = new THREE.MeshPhysicalMaterial({ name: 'Glass', color: 0x0e141a, roughness: 0.03, metalness: 0, clearcoat: 1, transparent: true, opacity: 0.55, envMapIntensity: 1.6, depthWrite: false });

/**
 * 主角车性能优化：原模型有 111 个网格 → 每帧 200 多次 draw call（加上阴影）。
 * 1) 删掉看不到的零件；2) 车身上不动的零件按材质合并成一个网格（只剩十几个）；
 * 3) 车轮里的零件要跟着转，保持独立。
 */
function optimizeHero(scene) {
  scene.updateMatrixWorld(true);
  const inv = scene.matrixWorld.clone().invert(), m = new THREE.Matrix4();
  const groups = new Map(), drop = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (HERO_HIDDEN.test(o.name)) { drop.push(o); return; }
    if (o.material.transmission > 0) o.material = HERO_GLASS;
    let p = o.parent, inWheel = false;
    for (; p && p !== scene; p = p.parent) if (p.name === 'wheelPivot') inWheel = true;
    const shadow = HERO_SHADOW.test(o.material.name ?? '');
    if (inWheel) { o.castShadow = shadow; o.receiveShadow = true; return; }
    const geo = o.geometry.clone().applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld));
    const key = `${o.material.uuid}|${Object.keys(geo.attributes).sort().join()}|${!!geo.index}`;
    if (!groups.has(key)) groups.set(key, { material: o.material, shadow, list: [] });
    groups.get(key).list.push(geo);
    drop.push(o);
  });
  for (const o of drop) {
    // 有子节点的网格（例如车身根节点下面挂着车轮）：换成一个空节点，保留位置和子节点
    if (o.children.length) {
      const holder = new THREE.Object3D();
      holder.name = o.name;
      holder.position.copy(o.position);
      holder.quaternion.copy(o.quaternion);
      holder.scale.copy(o.scale);
      for (const c of [...o.children]) holder.add(c);
      o.parent.add(holder);
    }
    o.parent.remove(o);
  }
  for (const { material, shadow, list } of groups.values()) {
    const merged = list.length > 1 ? mergeGeometries(list) : list[0];
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

export async function loadHero(renderer) {
  const loader = new GLTFLoader();
  loader.setDRACOLoader(new DRACOLoader().setDecoderPath('vendor/addons/libs/draco/gltf/'));
  loader.setKTX2Loader(new KTX2Loader().setTranscoderPath('vendor/addons/libs/basis/').detectSupport(renderer));
  const gltf = await loader.loadAsync('assets/hero/CarConcept.gltf');
  const variants = (gltf.userData.gltfExtensions?.KHR_materials_variants?.variants ?? []).map((v) => v.name);
  for (const [key, variant] of [['hero-red', 'Carmine Candy'], ['hero-graphite', 'Torched Graphite'], ['hero-pearl', 'Pearly Swirly']]) {
    const copy = gltf.scene.clone(true);
    const idx = variants.indexOf(variant);
    if (idx >= 0) await applyVariant(copy, gltf.parser, idx);
    cache.set(key, prepareHero(copy));
  }
  // 警车 / 民用车：同一台概念车的低模版本（约 1.5 万个三角形，内饰已删掉），换上不同车漆
  const lod = await loader.loadAsync('assets/hero/CarConcept_lod.gltf');
  const base = prepareLod(lod.scene);
  for (const [key, [c1, c2]] of Object.entries(LIVERIES)) {
    const g = base.clone(true);
    g.traverse((o) => {
      if (o.material === SLOT1) o.material = carPaint(c1);
      else if (o.material === SLOT2) o.material = carPaint(c2);
    });
    cache.set('lod-' + key, g);
  }
}

// ---------------------------------------------------------------- 低模真车（警车 / 民用车）
// 车漆：[主色, 下半部 / 侧裙颜色]
export const LIVERIES = {
  police: [0xf4f5f7, 0x0b0c0f],
  white: [0xe9e9e6, 0x1c1e22],
  black: [0x0f1012, 0x0f1012],
  silver: [0xa7abb1, 0x26282c],
  blue: [0x1d3f7a, 0x101216],
  red: [0x8f1a14, 0x141414],
  green: [0x1f4a36, 0x101210],
  taxi: [0xf2c21a, 0x141414],
};
export const CIV_LIVERIES = ['white', 'black', 'silver', 'blue', 'red', 'green', 'white', 'silver'];
const SLOT1 = new THREE.MeshPhysicalMaterial(), SLOT2 = new THREE.MeshPhysicalMaterial(); // 占位，换车漆时替换
const paints = new Map();
function carPaint(color) {
  if (!paints.has(color)) paints.set(color, new THREE.MeshPhysicalMaterial({ color, metalness: 0.45, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06 }));
  return paints.get(color);
}
const LOD_MATS = {
  trim: new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.55, metalness: 0.25 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x131313, roughness: 0.92 }),
  rim: new THREE.MeshStandardMaterial({ color: 0xc6cbd1, roughness: 0.25, metalness: 1 }),
  head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d8, emissiveIntensity: 1.6 }),
  tail: new THREE.MeshStandardMaterial({ color: 0x4a0000, emissive: 0xff1608, emissiveIntensity: 1.3 }),
  signal: new THREE.MeshStandardMaterial({ color: 0x5a3000, emissive: 0xff8a10, emissiveIntensity: 0.8 }),
};
function lodMaterial(name = '') {
  if (/^Paint 1/.test(name)) return SLOT1;
  if (/^Paint 2/.test(name)) return SLOT2;
  if (name === 'Glass') return HERO_GLASS;
  if (/Rim/.test(name)) return LOD_MATS.rim;
  if (/Tire/.test(name)) return LOD_MATS.rubber;
  if (name === 'Headlight') return LOD_MATS.head;
  if (name === 'Brakelight') return LOD_MATS.tail;
  if (name === 'Signallight') return LOD_MATS.signal;
  return LOD_MATS.trim;
}

/** 低模车：朝向转成车头朝 +Z，所有零件（含车轮）按材质合并成 7~8 个网格，只有车漆投影 */
function prepareLod(scene) {
  scene.updateMatrixWorld(true);
  const centerOf = (name) => {
    const n = scene.getObjectByName(name);
    return n ? new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3()) : null;
  };
  const size = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3());
  const along = size.x > size.z ? 'x' : 'z';
  const head = centerOf('BodyHeadlights'), tail = centerOf('BodyTaillights');
  const wrap = new THREE.Group();
  wrap.add(scene);
  if (along === 'x') scene.rotation.y = head && tail && head.x < tail.x ? Math.PI / 2 : -Math.PI / 2;
  else if (head && tail && head.z < tail.z) scene.rotation.y = Math.PI;
  wrap.updateMatrixWorld(true);
  const groups = new Map();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const material = lodMaterial(o.material?.name);
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    const g2 = geo.index ? geo.toNonIndexed() : geo;
    if (!groups.has(material)) groups.set(material, []);
    groups.get(material).push(g2);
  });
  wrap.remove(scene);
  for (const [material, list] of groups) {
    const mesh = new THREE.Mesh(mergeGeometries(list), material);
    mesh.castShadow = material === SLOT1 || material === SLOT2;
    mesh.receiveShadow = true;
    wrap.add(mesh);
  }
  return wrap;
}

export const hasLodCars = () => cache.has('lod-police');
