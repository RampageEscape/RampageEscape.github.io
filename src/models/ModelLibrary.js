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
  for (const [key, variant] of [['hero-red', 'Carmine Candy'], ['hero-graphite', 'Torched Graphite']]) {
    const copy = gltf.scene.clone(true);
    const idx = variants.indexOf(variant);
    if (idx >= 0) await applyVariant(copy, gltf.parser, idx);
    cache.set(key, prepareHero(copy));
  }
}
