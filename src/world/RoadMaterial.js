import * as THREE from 'three';
import { ROAD_HALF } from './Road.js';

// 真实沥青（Poly Haven “asphalt_02”，CC0）：颜色 + 法线 + 粗糙度三张贴图，按道路 UV 每 6 米重复。
// 每张地图用不同的色调乘上去（沙漠偏暖、港口偏冷），夜城的路面更光滑（像刚下过雨）。
const loader = new THREE.TextureLoader();
function tex(file, srgb) {
  const t = loader.load(`assets/textures/${file}`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const MAPS = {
  map: tex('asphalt_diff.jpg', true),
  normalMap: tex('asphalt_nor_gl.jpg', false),
  roughnessMap: tex('asphalt_rough.jpg', false),
};

const cache = new Map();
/** tint：原来的路面颜色，用来给贴图上色；roughness < 1 的路面更反光 */
export function roadMaterial(tint, roughness = 1) {
  const key = `${tint}:${roughness}`;
  if (!cache.has(key)) {
    const c = new THREE.Color(tint);
    // 贴图本身就是深灰色，乘一个提亮过的色调，避免整体太暗
    c.multiplyScalar(2.2);
    cache.set(key, new THREE.MeshStandardMaterial({ ...MAPS, color: c, roughness, metalness: 0, normalScale: new THREE.Vector2(0.8, 0.8) }));
  }
  return cache.get(key);
}

// ---------------------------------------------------------------- 人行道地砖（程序化生成）
// 0.6 米见方的水泥砖，每块亮度略有不同，砖缝凹下去（法线贴图），整体再乘上各地图的人行道颜色。
function pavingMaps() {
  const S = 512, n = 10, cell = S / n;
  const col = Object.assign(document.createElement('canvas'), { width: S, height: S });
  const hgt = Object.assign(document.createElement('canvas'), { width: S, height: S });
  const c = col.getContext('2d'), h = hgt.getContext('2d');
  let seed = 5;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  c.fillStyle = '#6f6c68';
  c.fillRect(0, 0, S, S);
  h.fillStyle = '#202020';
  h.fillRect(0, 0, S, S);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = Math.round(178 + r() * 36);
      c.fillStyle = `rgb(${v},${v - 2},${v - 6})`;
      c.fillRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
      h.fillStyle = '#d0d0d0';
      h.fillRect(x * cell + 3, y * cell + 3, cell - 6, cell - 6);
    }
  }
  // 污渍、口香糖印、细噪点
  for (let i = 0; i < 60; i++) {
    const x = r() * S, y = r() * S, rad = 6 + r() * 40, g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(50,45,40,${0.05 + r() * 0.12})`);
    g.addColorStop(1, 'rgba(50,45,40,0)');
    c.fillStyle = g;
    c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  const img = c.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const k = 1 + (r() - 0.5) * 0.12; d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; }
  c.putImageData(img, 0, 0);
  // 高度 → 法线
  const src = h.getImageData(0, 0, S, S).data, out = new ImageData(S, S), o = out.data;
  const H = (x, y) => src[(((y + S) % S) * S + ((x + S) % S)) * 4] / 255;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let nx = (H(x - 1, y) - H(x + 1, y)) * 2, ny = (H(x, y + 1) - H(x, y - 1)) * 2;
    const l = Math.hypot(nx, ny, 1), i = (y * S + x) * 4;
    o[i] = (nx / l * 0.5 + 0.5) * 255; o[i + 1] = (ny / l * 0.5 + 0.5) * 255; o[i + 2] = (1 / l * 0.5 + 0.5) * 255; o[i + 3] = 255;
  }
  const nc = Object.assign(document.createElement('canvas'), { width: S, height: S });
  nc.getContext('2d').putImageData(out, 0, 0);
  const t = (cv, srgb) => {
    const tx = new THREE.CanvasTexture(cv);
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    tx.anisotropy = 4;
    tx.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return tx;
  };
  return { map: t(col, true), normalMap: t(nc, false) };
}
let PAVING = null;
const pavingCache = new Map();
export function pavingMaterial(tint) {
  if (!pavingCache.has(tint)) {
    PAVING ??= pavingMaps();
    const c = new THREE.Color(tint).multiplyScalar(1.25);
    pavingCache.set(tint, new THREE.MeshStandardMaterial({ ...PAVING, color: c, roughness: 0.88, metalness: 0 }));
  }
  return pavingCache.get(tint);
}

/** 路缘石侧面：浅灰色水泥 */
export const CURB = new THREE.MeshStandardMaterial({ color: 0xb4b1aa, roughness: 0.9, metalness: 0 });

/** 人行道：真实地砖贴图 + 朝向马路的路缘石侧面 */
export function sidewalks(ctx, color, width, height, gaps = []) {
  const { rib } = ctx, m = pavingMaterial(color);
  for (const [a, b] of ctx.roadRanges(gaps)) {
    rib.strip(m, a, b, -ROAD_HALF - width, -ROAD_HALF, height, ctx.step);
    rib.strip(m, a, b, ROAD_HALF, ROAD_HALF + width, height, ctx.step);
    rib.wall(CURB, a, b, ROAD_HALF, 0.02, height, ctx.step);
    rib.wall(CURB, a, b, -ROAD_HALF, height, 0.02, ctx.step);
  }
}

// ---------------------------------------------------------------- 地面（Poly Haven 实拍贴图，CC0）
// [文件名, 一张贴图覆盖几米]。贴图加载后会量一下它的平均颜色，自动把材质颜色调到和这张地图原来的地面色一致，
// 这样贴图地面和远处的纯色大地面之间看不出接缝。
const GROUND_TEX = { snow: ['snow', 4], sand: ['sand', 14], grass: ['grass', 14], beach: ['beach', 10], concrete: ['concrete', 3.5] };
const texCache = new Map();
function groundTex(file, srgb, rep, onMean) {
  const key = file;
  if (!texCache.has(key)) {
    const t = loader.load(`assets/textures/${file}`, (tx) => {
      if (!srgb) return;
      // 缩到 8×8 取平均色（sRGB → 线性）
      const c = Object.assign(document.createElement('canvas'), { width: 8, height: 8 }), g = c.getContext('2d');
      g.drawImage(tx.image, 0, 0, 8, 8);
      const d = g.getImageData(0, 0, 8, 8).data, sum = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
      t.userData.mean = new THREE.Color().setRGB(sum[0] / 64 / 255, sum[1] / 64 / 255, sum[2] / 64 / 255, THREE.SRGBColorSpace);
      for (const fn of t.userData.waiting) fn(t.userData.mean);
      t.userData.waiting = [];
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.repeat.set(rep, rep);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.userData.waiting = [];
    texCache.set(key, t);
  }
  const t = texCache.get(key);
  if (onMean) t.userData.mean ? onMean(t.userData.mean) : t.userData.waiting.push(onMean);
  return t;
}

const groundCache = new Map();
/** kind：snow / sand / grass / beach / concrete；tint：这张地图原来的地面颜色 */
export function groundMaterial(kind, tint) {
  const key = `${kind}:${tint}`;
  if (!groundCache.has(key)) {
    const [file, size] = GROUND_TEX[kind], rep = 6 / size; // 条带 UV 每 6 米 = 1
    const target = new THREE.Color(tint).multiplyScalar(0.8); // 原配色是给平涂风格调的，写实光照下要暗一点
    const m = new THREE.MeshStandardMaterial({ color: target.clone(), roughness: 0.95, metalness: 0 });
    m.map = groundTex(`${file}_diff.jpg`, true, rep, (mean) => {
      m.color.setRGB(Math.min(3, target.r / Math.max(mean.r, 0.02)), Math.min(3, target.g / Math.max(mean.g, 0.02)), Math.min(3, target.b / Math.max(mean.b, 0.02)));
    });
    m.normalMap = groundTex(`${file}_nor_gl.jpg`, false, rep);
    groundCache.set(key, m);
  }
  return groundCache.get(key);
}

// ---------------------------------------------------------------- 海水
// 程序化的波浪法线贴图 + 很低的粗糙度：会反射 HDRI 天空；两层法线贴图偏移随时间滚动 → 海面在动。
function waveNormals() {
  const S = 256, out = new ImageData(S, S), d = out.data, TAU = Math.PI * 2;
  const waves = [];
  let seed = 9;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 9; i++) waves.push({ kx: Math.round((r() - 0.5) * 12), ky: Math.round(1 + r() * 8), a: 0.5 / (i + 1.5), p: r() * TAU });
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let dx = 0, dy = 0;
    for (const w of waves) {
      const ph = TAU * (w.kx * x + w.ky * y) / S + w.p, c = Math.cos(ph) * w.a;
      dx += c * w.kx * 0.12; dy += c * w.ky * 0.12;
    }
    const l = Math.hypot(dx, dy, 1), i = (y * S + x) * 4;
    d[i] = (-dx / l * 0.5 + 0.5) * 255; d[i + 1] = (dy / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  const c = Object.assign(document.createElement('canvas'), { width: S, height: S });
  c.getContext('2d').putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.repeat.set(0.5, 0.5);
  return t;
}
let WATER = null;
export function waterMaterial(color) {
  // 掠射角下水面会强烈反射天空（发白），所以环境反射调低、颜色加深，看起来才是蓝色的海
  WATER ??= new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.55), roughness: 0.16, metalness: 0, normalMap: waveNormals(), normalScale: new THREE.Vector2(0.45, 0.45), envMapIntensity: 0.5 });
  return WATER;
}
/** 每帧调用：让海浪慢慢流动 */
export function updateWater(t) {
  if (!WATER) return;
  WATER.normalMap.offset.set(t * 0.012, t * 0.02);
}
