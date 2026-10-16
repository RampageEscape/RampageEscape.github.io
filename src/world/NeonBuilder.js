import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { ROAD_HALF } from './Road.js';
import { GEO, mat } from '../models/Models.js';
import { pick } from '../core/utils.js';
import { GLOW_TEX } from '../fx/Particles.js';
import { roadMaterial, sidewalks } from './RoadMaterial.js';

// 霓虹夜城：发光窗户的摩天大楼、霓虹灯带、广告牌、路面彩色倒影

const L = CONFIG.world.chunkLength;
const LANES = CONFIG.road.lanes, LW = CONFIG.road.laneWidth;
export const NEON_PAL = { ground: 0x15121f, asphalt: 0x1d1e27, side: 0x2a2734, line: 0x6e6a80 };

// HDR 霓虹色（数值 > 1，经过 Bloom 会发光）
const NEON = [[3.2, 0.35, 2.4], [0.3, 2.4, 3.4], [2.2, 0.6, 3.4], [3.2, 2.2, 0.4]];
const basic = (r, g, b, extra = {}) => {
  const m = new THREE.MeshBasicMaterial(extra);
  m.color.setRGB(r, g, b);
  return m;
};
const PINK_STRIP = basic(2.3, 0.25, 1.7);
const CYAN_STRIP = basic(0.2, 1.7, 2.4);
const NEON_MAT = basic(1, 1, 1); // 颜色由实例颜色决定
const POOL_MAT = new THREE.MeshBasicMaterial({ map: GLOW_TEX, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
const POOL_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

// 窗户贴图：一张 4 列 × 8 行的随机亮灯窗户，左上角留一块深色给楼顶用
function windowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#100e18';
  g.fillRect(0, 0, 256, 256);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 8; row++) {
      const x = col * 64 + 10, y = row * 32 + 7;
      const lit = rnd() < 0.36;
      g.fillStyle = lit ? pick(['#ffd89a', '#ffe8c0', '#9fd8ff', '#ff9ad5'], rnd) : '#1f1c2c';
      g.fillRect(x, y, 44, 18);
    }
  }
  g.fillStyle = '#0d0b14';
  g.fillRect(0, 0, 8, 6); // 楼顶取样区：纯深色
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const WINDOW_MAT = new THREE.MeshBasicMaterial({ map: windowTexture() });
WINDOW_MAT.color.setRGB(1.25, 1.25, 1.25); // 亮着的窗户略微超过 1，会有淡淡的光晕（追尾视角下整面楼都在画面里，不能太亮）

/** 一栋楼的几何体：侧面按真实尺寸重复窗户贴图，顶面贴深色 */
function buildingGeometry(w, h, d, x, z, rotY) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  // BoxGeometry 面的顺序：+x, -x, +y, -y, +z, -z，每面 4 个顶点
  const faceW = [d, d, w, w, w, w];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      if (f === 2 || f === 3) uv.setXY(i, 0.01, 0.99);
      else uv.setXY(i, uv.getX(i) * (faceW[f] / 10), uv.getY(i) * (h / 26));
    }
  }
  geo.translate(0, h / 2, 0);
  geo.rotateY(rotY);
  geo.translate(x, 0, z);
  return geo;
}

export function buildNeon(ctx) {
  const P = NEON_PAL, SW = 3.5, { z0, z1, rng, rib, inst } = ctx;
  rib.strip(P.ground, z0, z1, -45, 45, 0, ctx.step);
  rib.strip(roadMaterial(P.asphalt, 0.35), z0, z1, -ROAD_HALF, ROAD_HALF, 0.02, ctx.step);
  sidewalks(ctx, P.side, SW, 0.12);
  for (const [a, b] of ctx.roadRanges()) {
    // 路边霓虹灯带：一边粉、一边青
    rib.strip(CYAN_STRIP, a, b, -ROAD_HALF - 0.05, -ROAD_HALF + 0.22, 0.06, ctx.step);
    rib.strip(PINK_STRIP, a, b, ROAD_HALF - 0.22, ROAD_HALF + 0.05, 0.06, ctx.step);
    for (let k = 1; k < LANES; k++) {
      const off = -ROAD_HALF + k * LW;
      for (let z = Math.ceil(a / 9) * 9; z < b; z += 9) rib.strip(P.line, z, Math.min(z + 4, b), off - 0.08, off + 0.08, 0.05, 2);
    }
  }

  // 摩天大楼：远离镜头一侧很高，镜头一侧压低（避免挡路）
  const geos = [];
  for (const s of [-1, 1]) {
    let z = z0 + rng() * 3;
    while (z < z1 - 4) {
      const zEnd = Math.min(z + 10 + rng() * 10, z1), len = zEnd - z - 1, zm = (z + zEnd) / 2;
      const depth = 12 + rng() * 10, h = s < 0 && !CONFIG.world.tallNear ? 5 + rng() * 4 : 18 + rng() * 40;
      const lat = s * (ROAD_HALF + SW + 1 + depth / 2), w = ctx.at(zm, lat);
      const neon = pick(NEON, rng), sign = rng() < 0.55, trim = rng() < 0.7, signY = 6 + rng() * 8;
      if (!ctx.isBlocked(w.x, w.z, Math.max(depth, len) * 0.5)) {
        geos.push(buildingGeometry(depth, h, len, w.x, w.z, w.h));
        const face = lat - (s * depth) / 2;
        if (trim) {
          // 楼顶朝路一侧的霓虹灯条 + 楼角竖灯条
          ctx.prop(GEO.boxBase, NEON_MAT, zm, face - s * 0.1, { y: h - 0.3, sx: 0.25, sy: 0.3, sz: len, color: neon, force: true });
          ctx.prop(GEO.boxBase, NEON_MAT, zm - len / 2 + 0.2, face - s * 0.1, { y: 0, sx: 0.25, sy: h, sz: 0.25, color: neon, force: true });
        }
        if (sign && s > 0) {
          // 发光广告牌
          ctx.prop(GEO.boxBase, NEON_MAT, zm + (rng() - 0.5) * len * 0.4, face - s * 0.25, { y: signY, sx: 0.2, sy: 2.6, sz: Math.min(7, len * 0.6), color: pick(NEON, rng), force: true });
        }
      }
      z = zEnd + 0.5 + rng() * 2;
    }
    // 远处天际线：更高、更远的楼
    if ((s > 0 || CONFIG.world.tallNear) && rng() < 0.8) {
      const zm = z0 + rng() * L, depth = 14 + rng() * 10, h = 45 + rng() * 45, len = 14 + rng() * 10;
      const w = ctx.at(zm, s * (ROAD_HALF + SW + 30 + rng() * 25));
      if (!ctx.isBlocked(w.x, w.z, 14)) geos.push(buildingGeometry(depth, h, len, w.x, w.z, w.h));
    }
  }
  if (geos.length) {
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    const m = new THREE.Mesh(merged, WINDOW_MAT);
    m.userData.ownGeo = true;
    ctx.extraMeshes.push(m);
  }

  // 路灯 + 路面彩色倒影（湿马路的感觉）
  for (let z = Math.ceil(z0 / 24) * 24; z < z1; z += 24) {
    for (const s of [-1, 1]) {
      const lat = s * (ROAD_HALF + 0.9);
      if (!ctx.prop(GEO.cylBase, mat(0x2b2a33), z, lat, { y: 0.12, sx: 0.2, sy: 7, sz: 0.2, r: 0.3 })) continue;
      const c = s < 0 ? [0.3, 2.4, 3.4] : [3.2, 0.35, 2.4];
      ctx.prop(GEO.boxBase, NEON_MAT, z, lat - s * 1.2, { y: 6.9, sx: 2.4, sy: 0.16, sz: 0.3, color: c, force: true });
      ctx.prop(POOL_GEO, POOL_MAT, z, lat - s * 2.6, { y: 0.07, sx: 4.5, sy: 1, sz: 11, color: [c[0] * 0.18, c[1] * 0.18, c[2] * 0.18], force: true });
    }
  }
}
