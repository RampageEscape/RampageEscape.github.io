import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
  g.userData = { root, wheels, wheelR: 0.3 * s, kit: true, topY: H, dims: { L: length, W, H, bodyH: H * 0.45, clearance: 0.3, cabinZ: -0.05 } };
  return g;
}

/** 按行驶距离转动车轮（车轮节点绕父节点的 X 轴转，左右轮都对） */
export function spinWheels(mesh, dist) {
  const u = mesh.userData;
  if (!u.wheels?.length || !dist) return;
  const a = dist / u.wheelR;
  for (const w of u.wheels) w.rotation.x += a;
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
