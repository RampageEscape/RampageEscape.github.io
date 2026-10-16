import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// 写实建筑立面：全部用 canvas 程序化画出来（不需要下载图片），每种立面三张贴图：
//   颜色贴图   ：砖、灰泥、混凝土、玻璃、窗框、招牌……
//   法线贴图   ：由“高度图”推算，砖缝、窗洞、窗台会有真实的凹凸和阴影
//   粗糙/金属  ：玻璃很光滑、带金属感 → 会反射 HDRI 天空；墙面粗糙
// 一张立面贴图 = 2 个开间 × 2 层楼（8 米 × 6.8 米），按建筑真实尺寸重复。
// 一栋楼 = 地铺（4 米高，带中文/英文招牌的商店）+ 上面 N 层 + 女儿墙；楼顶单独一种材质。

const S = 512;
export const FLOOR = 3.4; // 层高
export const SHOP_H = 4; // 地铺高度
const BAY = 4; // 开间宽度
const TILE_W = 8, TILE_H = 2 * FLOOR;
const SHOPS = 8, SHOP_W = 6; // 地铺贴图：8 间店并排，每间 6 米

function rng(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

/** 三层画布：颜色 / 高度 / 粗糙度+金属度（G=粗糙度，B=金属度，Three.js 的约定） */
function layers(w, h) {
  const mk = () => Object.assign(document.createElement('canvas'), { width: w, height: h });
  const col = mk(), hgt = mk(), orm = mk();
  return { w, h, col, hgt, orm, c: col.getContext('2d'), hh: hgt.getContext('2d'), o: orm.getContext('2d') };
}

/** 在三层上同时画一个矩形。color 可以是 CSS 颜色或渐变；height / rough / metal 为 0~1，传 null 表示这一层不画 */
function rect(L, x, y, w, h, color, height, rough, metal = 0) {
  if (color != null) { L.c.fillStyle = color; L.c.fillRect(x, y, w, h); }
  if (height != null) { const v = Math.round(height * 255); L.hh.fillStyle = `rgb(${v},${v},${v})`; L.hh.fillRect(x, y, w, h); }
  if (rough != null) { L.o.fillStyle = `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`; L.o.fillRect(x, y, w, h); }
}

function vgrad(L, y0, y1, stops) {
  const g = L.c.createLinearGradient(0, y0, 0, y1);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * k)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/** 窗户下方的雨水污渍（只画颜色层），让墙面不那么“干净得像塑料” */
function streaks(L, x, y, w, len, alpha = 0.22) {
  const g = L.c.createLinearGradient(0, y, 0, y + len);
  g.addColorStop(0, `rgba(30,24,20,${alpha})`);
  g.addColorStop(1, 'rgba(30,24,20,0)');
  L.c.fillStyle = g;
  L.c.fillRect(x, y, w, len);
}

/** 整体做旧：像素级的轻微噪点 + 几块大的深色污渍 */
function weather(L, r, amount = 0.07, blotches = 6) {
  for (let i = 0; i < blotches; i++) {
    const x = r() * L.w, y = r() * L.h, rad = 40 + r() * 120;
    const g = L.c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(40,34,28,${0.06 + r() * 0.08})`);
    g.addColorStop(1, 'rgba(40,34,28,0)');
    L.c.fillStyle = g;
    L.c.fillRect(0, 0, L.w, L.h);
  }
  const img = L.c.getImageData(0, 0, L.w, L.h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = 1 + (r() - 0.5) * amount;
    d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
  }
  L.c.putImageData(img, 0, 0);
}

/** 高度图 → 切线空间法线贴图（OpenGL 约定，和 Three.js 一致） */
function normalMap(hc, strength) {
  const w = hc.width, h = hc.height, src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const out = new ImageData(w, h), d = out.data;
  const H = (x, y) => src[((((y + h) % h) * w) + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 画布 y 向下、贴图 v 向上，所以 y 方向的差分要反过来
      let nx = (H(x - 1, y) - H(x + 1, y)) * strength, ny = (H(x, y + 1) - H(x, y - 1)) * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * w + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
  }
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}

function toTex(canvas, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

function material(L, normalStrength, extra = {}) {
  const orm = toTex(L.orm, false);
  return new THREE.MeshStandardMaterial({
    map: toTex(L.col, true),
    normalMap: normalStrength ? toTex(normalMap(L.hgt, normalStrength), false) : null,
    roughnessMap: orm,
    metalnessMap: orm,
    roughness: 1,
    metalness: 1,
    envMapIntensity: 1.1,
    ...extra,
  });
}

// ---------------------------------------------------------------- 窗户（砖楼、灰泥楼共用）
const GLASS = ['#6f8aa3', '#3d5368', '#1b2632', '#121a22'];
function glassPane(L, x, y, w, h, r) {
  rect(L, x, y, w, h, vgrad(L, y, y + h, GLASS), 0.05, 0.06, 0.75);
  // 一部分窗户里有窗帘（米色、粗糙、不反光）
  if (r() < 0.45) {
    const cw = w * (0.3 + r() * 0.4), left = r() < 0.5;
    rect(L, left ? x : x + w - cw, y, cw, h, shade(['#d9cbb0', '#c9b79a', '#e3dccf', '#9c8a76'][Math.floor(r() * 4)], 0.8 + r() * 0.2), 0.08, 0.85, 0);
  }
  // 斜向高光：天空在玻璃上的反射带
  L.c.fillStyle = 'rgba(255,255,255,0.07)';
  L.c.beginPath();
  L.c.moveTo(x + w * 0.15, y); L.c.lineTo(x + w * 0.45, y); L.c.lineTo(x + w * 0.1, y + h); L.c.lineTo(x - w * 0.2, y + h);
  L.c.closePath();
  L.c.save(); L.c.beginPath(); L.c.rect(x, y, w, h); L.c.clip(); L.c.fill(); L.c.restore();
}

/** 一个开间的窗户：石头过梁 + 窗台 + 白色窗框 + 两扇玻璃 + 上亮子 */
function sashWindow(L, bx, by, r, { frame = '#ece6da', stone = '#d8cfbf', shutters = null, balcony = false } = {}) {
  const ww = 104, wh = 146, x = bx + (256 - ww) / 2, y = by + 256 - 70 - wh;
  rect(L, x - 10, y - 16, ww + 20, 16, stone, 0.95, 0.8);
  rect(L, x - 12, y + wh, ww + 24, 11, stone, 1, 0.8);
  streaks(L, x - 6, y + wh + 11, ww + 12, 46 + r() * 30);
  if (shutters) {
    for (const sx of [x - 44, x + ww + 6]) {
      rect(L, sx, y, 38, wh, shutters, 0.8, 0.7);
      for (let k = 6; k < wh; k += 7) rect(L, sx + 3, y + k, 32, 2, shade(shutters, 0.7), 0.7, null);
    }
  }
  rect(L, x, y, ww, wh, frame, 0.72, 0.5);
  const t = 40; // 上亮子高度
  glassPane(L, x + 7, y + 7, ww - 14, t - 10, r);
  glassPane(L, x + 7, y + t + 2, (ww - 20) / 2, wh - t - 9, r);
  glassPane(L, x + 13 + (ww - 20) / 2, y + t + 2, (ww - 20) / 2, wh - t - 9, r);
  if (balcony) {
    const top = y + wh - 48;
    rect(L, x - 22, y + wh + 2, ww + 44, 9, '#b9b2a6', 1, 0.7);
    rect(L, x - 22, top, ww + 44, 4, '#24272b', 0.95, 0.45, 0.6);
    for (let k = x - 20; k < x + ww + 22; k += 9) rect(L, k, top, 3, 52, '#24272b', 0.95, 0.45, 0.6);
  }
}

// ---------------------------------------------------------------- 立面样式
function brick(pal, seed) {
  return () => {
    const L = layers(S, S), r = rng(seed);
    rect(L, 0, 0, S, S, pal.mortar, 0.3, 0.95);
    const rows = 80, bh = S / rows, bw = S / 32;
    for (let row = 0; row < rows; row++) {
      const off = (row % 2) * bw * 0.5;
      for (let k = -1; k < 32; k++) {
        const c = pal.bricks[Math.floor(r() * pal.bricks.length)];
        rect(L, k * bw + off + 0.8, row * bh + 0.8, bw - 1.2, bh - 1.2, shade(c, 0.82 + r() * 0.32), 0.62 + r() * 0.12, 0.88);
      }
    }
    // 每层楼板位置一条砖砌腰线
    for (let f = 0; f < 2; f++) rect(L, 0, f * 256 + 250, S, 6, shade(pal.bricks[0], 0.7), 0.85, 0.9);
    for (let f = 0; f < 2; f++) for (let b = 0; b < 2; b++) sashWindow(L, b * 256, f * 256, r, { frame: pal.frame, stone: pal.stone, balcony: pal.balcony && f === 0 && b === 1 });
    weather(L, r, 0.08, 5);
    return material(L, 3.2);
  };
}

function stucco(wall, shutters, seed) {
  return () => {
    const L = layers(S, S), r = rng(seed);
    rect(L, 0, 0, S, S, wall, 0.5, 0.92);
    // 灰泥表面的细微起伏
    for (let i = 0; i < 2400; i++) {
      const v = 0.42 + r() * 0.16;
      rect(L, r() * S, r() * S, 2 + r() * 5, 2 + r() * 5, null, v, null);
    }
    for (let f = 0; f < 2; f++) rect(L, 0, f * 256 + 246, S, 10, shade(wall, 0.9), 0.75, 0.85);
    for (let f = 0; f < 2; f++) for (let b = 0; b < 2; b++) sashWindow(L, b * 256, f * 256, r, { frame: '#f3efe7', stone: shade(wall, 0.93), shutters, balcony: (f + b) % 2 === 0 });
    weather(L, r, 0.05, 8);
    return material(L, 2.2);
  };
}

/** 米色混凝土办公楼：预制板 + 横向带形窗 + 铝合金竖框 */
function concrete(seed) {
  return () => {
    const L = layers(S, S), r = rng(seed);
    rect(L, 0, 0, S, S, '#c9bea9', 0.6, 0.9);
    for (let f = 0; f < 2; f++) {
      const y0 = f * 256;
      for (let x = 0; x < S; x += 128) rect(L, x, y0, 2, 256, '#9d937f', 0.35, 0.9); // 板缝
      rect(L, 0, y0 + 254, S, 2, '#9d937f', 0.35, 0.9);
      const wy = y0 + 62, wh = 128;
      rect(L, 0, wy - 6, S, wh + 12, '#8d9299', 0.75, 0.4, 0.8); // 窗框
      for (let x = 0; x < S; x += 64) glassPane(L, x + 5, wy, 54, wh, r);
      rect(L, 0, wy + wh + 6, S, 8, '#ddd4c2', 1, 0.8); // 窗台
      streaks(L, 0, wy + wh + 14, S, 40, 0.12);
    }
    weather(L, r, 0.05, 7);
    return material(L, 2.6);
  };
}

/** 玻璃幕墙：蓝绿色反光玻璃 + 细铝框 + 每层的深色层间板 */
function curtainGlass(tint, seed) {
  return () => {
    const L = layers(S, S), r = rng(seed), pw = S / 6;
    rect(L, 0, 0, S, S, '#9aa1a8', 0.8, 0.35, 0.9);
    for (let f = 0; f < 2; f++) {
      const y0 = f * 256;
      rect(L, 0, y0, S, 46, '#2a333c', 0.55, 0.22, 0.6); // 层间板
      for (let k = 0; k < 6; k++) {
        const x = k * pw, b = 0.85 + r() * 0.3;
        rect(L, x + 3, y0 + 50, pw - 6, 202, vgrad(L, y0 + 50, y0 + 252, tint.map((c) => shade(c, b))), 0.5, 0.03 + r() * 0.04, 0.92);
        if (r() < 0.3) rect(L, x + 3, y0 + 150, pw - 6, 102, 'rgba(210,200,180,0.25)', null, null); // 室内的百叶帘
      }
    }
    weather(L, r, 0.03, 3);
    return material(L, 1.6, { envMapIntensity: 1.4 });
  };
}

// ---------------------------------------------------------------- 地铺（商店）
const SHOP_NAMES = ['茶餐廳', 'COFFEE', '便利店', '藥房', 'BAKERY', '金舖', '書局', 'PIZZA', '花店', '髮型屋', '麵包店', 'NOODLE'];
const SIGN_COLORS = ['#b3261e', '#1f5f3f', '#123c69', '#d98c1f', '#2f2f33', '#6a1b9a', '#0b7a75', '#c2185b'];
function shops() {
  const W = 2048, H = 256, L = layers(W, H), r = rng(91), sw = W / SHOPS;
  const names = [...SHOP_NAMES].sort(() => r() - 0.5);
  for (let k = 0; k < SHOPS; k++) {
    const x0 = k * sw, signC = SIGN_COLORS[k % SIGN_COLORS.length];
    rect(L, x0, 0, sw, H, '#3b3a3c', 0.7, 0.6, 0.2); // 门面石材
    // 招牌
    rect(L, x0 + 6, 6, sw - 12, 50, signC, 0.9, 0.45, 0.1);
    L.c.fillStyle = signC === '#d98c1f' ? '#1d1d1d' : '#fbf4e4';
    L.c.font = 'bold 34px "PingFang TC","Microsoft JhengHei","Noto Sans TC","Heiti TC",sans-serif';
    L.c.textAlign = 'center';
    L.c.textBaseline = 'middle';
    L.c.fillText(names[k], x0 + sw / 2, 32);
    // 橱窗：暖色的店内灯光 + 货架剪影，再盖一层天空反射
    const gy = 66, gh = H - gy - 26;
    rect(L, x0 + 8, gy, sw - 16, gh, vgrad(L, gy, gy + gh, ['#f2dcb0', '#c49a6c', '#5a4430']), 0.15, 0.05, 0.35);
    for (let s = 0; s < 3; s++) rect(L, x0 + 14, gy + 40 + s * 44, sw - 28, 5, 'rgba(60,40,25,0.55)', null, null);
    for (let p = 0; p < 14; p++) rect(L, x0 + 16 + r() * (sw - 40), gy + 18 + Math.floor(r() * 3) * 44, 8 + r() * 14, 20, shade(['#c0392b', '#2e86c1', '#f4d03f', '#27ae60', '#ecf0f1'][Math.floor(r() * 5)], 0.75), null, null);
    rect(L, x0 + 8, gy, sw - 16, gh, vgrad(L, gy, gy + gh, ['rgba(170,195,220,0.55)', 'rgba(120,150,180,0.18)', 'rgba(0,0,0,0)']), null, null);
    // 门：深色玻璃 + 门把
    const dx = x0 + (r() < 0.5 ? 26 : sw - 26 - 60);
    rect(L, dx, gy, 60, gh, '#1b2128', 0.1, 0.06, 0.8);
    rect(L, dx + (dx < x0 + sw / 2 ? 50 : 6), gy + gh / 2, 4, 26, '#c9c9c9', 0.8, 0.3, 1);
    // 铝合金框 + 底部石材墙裙
    for (const fx of [x0 + 8, dx - 3, dx + 59, x0 + sw - 12]) rect(L, fx, gy, 4, gh, '#2a2c2f', 0.8, 0.45, 0.7);
    rect(L, x0 + 8, gy - 2, sw - 16, 4, '#2a2c2f', 0.8, 0.45, 0.7);
    rect(L, x0, H - 26, sw, 26, '#5b5856', 0.95, 0.8);
  }
  weather(L, r, 0.04, 6);
  return material(L, 1.6);
}

// 延迟创建：第一次用到才画（避免拖慢启动）
const STYLE_MAKERS = {
  brickRed: brick({ mortar: '#b9ae9f', bricks: ['#8e3b2f', '#9a4433', '#7d3328', '#a3523c'], frame: '#efe9dd', stone: '#d9cfbd', balcony: true }, 11),
  brickBrown: brick({ mortar: '#a79d8e', bricks: ['#6f5242', '#7c5d49', '#5f4537', '#866652'], frame: '#2f3a33', stone: '#c6bba6', balcony: false }, 23),
  stuccoCream: stucco('#e2d6bd', '#3f5f4a', 37),
  stuccoTerracotta: stucco('#cf9a76', '#5a3b2a', 41),
  concrete: concrete(53),
  glassBlue: curtainGlass(['#9ec3dd', '#4e7896', '#1c3a52', '#0f2233'], 67),
  glassTeal: curtainGlass(['#a8d4cc', '#4f8c86', '#1d4c4a', '#0c2b2b'], 71),
  shops,
};
const MATS = {};
export function facadeMaterial(style) {
  return (MATS[style] ??= STYLE_MAKERS[style]());
}
const ROOF = new THREE.MeshStandardMaterial({ color: 0x6a6b6d, roughness: 0.95, metalness: 0 });

export const LOW_STYLES = ['brickRed', 'brickBrown', 'stuccoCream', 'stuccoTerracotta', 'concrete'];
export const TALL_STYLES = ['glassBlue', 'glassTeal', 'concrete', 'glassBlue'];

// ---------------------------------------------------------------- 几何体
// BoxGeometry.toNonIndexed() 每个面 6 个顶点，面的顺序：+x, -x, +y, -y, +z, -z
const WALL_FACES = [0, 1, 4, 5];

/**
 * 一个“盒子”的墙面（和可选的顶面），UV 按真实尺寸换算：
 * 每个墙面横向取整数个开间（窗户不会被楼角切掉一半），纵向按 tileH 重复。
 */
function boxPart(w, h, d, { tileW, tileH, unit, uOff = 0, roof = false }) {
  const box = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const P = box.attributes.position.array, N = box.attributes.normal.array, U = box.attributes.uv.array;
  const pos = [], nor = [], uv = [], rp = [], rn = [];
  const faceW = [d, d, w, w, w, w];
  for (const f of WALL_FACES) {
    const units = Math.max(1, Math.round(faceW[f] / unit));
    for (let v = f * 6; v < f * 6 + 6; v++) {
      pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      nor.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
      uv.push(U[v * 2] * (units * unit) / tileW + uOff, U[v * 2 + 1] * h / tileH);
    }
  }
  if (roof) {
    for (let v = 12; v < 18; v++) {
      rp.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      rn.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
    }
  }
  box.dispose();
  const make = (p, n, withUv) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(withUv ?? new Array((p.length / 3) * 2).fill(0), 2));
    return g;
  };
  return { walls: make(pos, nor, uv), roof: roof ? make(rp, rn) : null };
}

/** 收集一个区块里所有楼的几何体，按材质合并成少量网格 */
export class FacadeBatch {
  constructor() { this.parts = new Map(); }

  push(key, geo, x, y, z, rotY) {
    geo.translate(0, y, 0);
    geo.rotateY(rotY);
    geo.translate(x, 0, z);
    if (!this.parts.has(key)) this.parts.set(key, []);
    this.parts.get(key).push(geo);
  }

  /**
   * 加一栋楼。w = 横向深度（垂直于道路），d = 沿道路的长度。
   * floors = 地铺以上的楼层数（0 = 只有一层商店）。返回楼的总高度。
   */
  building({ x, z, rotY, w, d, floors, style, shop = true, r = Math.random }) {
    let y = 0;
    if (shop) {
      const base = boxPart(w, SHOP_H, d, { tileW: SHOPS * SHOP_W, tileH: SHOP_H, unit: SHOP_W, uOff: Math.floor(r() * SHOPS) / SHOPS });
      this.push('shops', base.walls, x, SHOP_H / 2, z, rotY);
      y = SHOP_H;
    }
    const upper = floors * FLOOR + 0.7; // 0.7 米女儿墙
    const part = boxPart(w, upper, d, { tileW: TILE_W, tileH: TILE_H, unit: BAY, uOff: Math.floor(r() * 2) * 0.5, roof: true });
    this.push(style, part.walls, x, y + upper / 2, z, rotY);
    this.push('roof', part.roof, x, y + upper / 2, z, rotY);
    return y + upper;
  }

  build(out) {
    for (const [key, list] of this.parts) {
      const merged = mergeGeometries(list);
      for (const g of list) g.dispose();
      const m = new THREE.Mesh(merged, key === 'roof' ? ROOF : facadeMaterial(key));
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.ownGeo = true;
      out.push(m);
    }
    this.parts.clear();
  }
}
