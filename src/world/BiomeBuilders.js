import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ROAD_HALF, WATER_Y } from './Road.js';
import { GEO, mat } from '../models/Models.js';
import { envModel } from '../models/ModelLibrary.js';
import { pick } from '../core/utils.js';
import { buildNeon, NEON_PAL } from './NeonBuilder.js';
import { roadMaterial, sidewalks, groundMaterial, waterMaterial } from './RoadMaterial.js';
import { FacadeBatch, LOW_STYLES, TALL_STYLES, SHOP_H } from './Facades.js';

// 五张地图的区块构建器。全部通过 ChunkCtx 放东西：坐标都是道路坐标 (s, lat)，
// 所以无论路线怎么转弯，楼、树、护栏都会自动沿着道路摆放，并避开别的岔路。

const L = CONFIG.world.chunkLength;
const LANES = CONFIG.road.lanes, LW = CONFIG.road.laneWidth;
const GROUND = 45; // 每个区块铺的地面宽度（更远处是全局地面）

export const PAL = {
  city: { ground: 0x9b8f82, asphalt: 0x4b4d53, side: 0xc08a7c, line: 0xf2f2ea, edge: 0xe8c547 },
  forest: { ground: 0xd8e1e6, asphalt: 0x5d5f63, side: 0xb4b1a4, line: 0xf2f2ea, edge: 0xe8c547 },
  desert: { ground: 0xe3c48d, asphalt: 0x5c5650, side: 0xcaa36e, line: 0xf2f2ea, edge: 0xe8c547 },
  coast: { ground: 0x86a85a, asphalt: 0x55585e, side: 0xc9c2ad, line: 0xf2f2ea, edge: 0xe8c547, sea: 0x2f8fc4, foam: 0xf4f8fa, sand: 0xead9a8 },
  harbor: { ground: 0x8d9096, asphalt: 0x45474c, side: 0xa7a9ad, line: 0xf2f2ea, edge: 0xe8c547 },
  neon: { ...NEON_PAL, edge: 0xe8c547 },
  sea: { water: 0x1f6f9a },
};
const FOLIAGE = [0x6d7d2f, 0x5f7230, 0x7e8a36, 0x4f6a2e];
const ROCKS = [0x9c9a92, 0x8a8880, 0xb0aea6];
const CONTAINERS = [0xc0392b, 0x2e6da4, 0x2f8a57, 0xe67e22, 0x8e44ad, 0x7f8c8d, 0xd4ac0d, 0x16a085];
const WHITE = () => mat(0xffffff);

// ---------------------------------------------------------------- 通用部件
function ground(ctx, color, a = -GROUND, b = GROUND) {
  ctx.rib.strip(color, ctx.z0, ctx.z1, a, b, 0, ctx.step);
}

function markings(ctx, P, centerYellow, gaps = []) {
  const { rib } = ctx;
  for (const [a, b] of ctx.roadRanges(gaps)) {
    for (let k = 1; k < LANES; k++) {
      const off = -ROAD_HALF + k * LW;
      if (centerYellow && k === LANES / 2) {
        rib.strip(P.edge, a, b, off - 0.24, off - 0.1, 0.05, ctx.step);
        rib.strip(P.edge, a, b, off + 0.1, off + 0.24, 0.05, ctx.step);
        continue;
      }
      for (let z = Math.ceil(a / 9) * 9; z < b; z += 9) rib.strip(P.line, z, Math.min(z + 4, b), off - 0.09, off + 0.09, 0.05, 2);
    }
    rib.strip(P.line, a, b, -ROAD_HALF + 0.2, -ROAD_HALF + 0.36, 0.05, ctx.step);
    rib.strip(P.line, a, b, ROAD_HALF - 0.36, ROAD_HALF - 0.2, 0.05, ctx.step);
  }
}

/** 自然地形地图通用：沥青 + 两侧路肩 + 双黄线 */
function ruralRoad(ctx, P, shoulder = 1.4) {
  const { rib, z0, z1 } = ctx;
  rib.strip(roadMaterial(P.asphalt), z0, z1, -ROAD_HALF, ROAD_HALF, 0.02, ctx.step);
  for (const [a, b] of ctx.roadRanges()) {
    rib.strip(groundMaterial('concrete', P.side), a, b, -ROAD_HALF - shoulder, -ROAD_HALF, 0.012, ctx.step);
    rib.strip(groundMaterial('concrete', P.side), a, b, ROAD_HALF, ROAD_HALF + shoulder, 0.012, ctx.step);
  }
  markings(ctx, P, true);
}

/**
 * 岩石 / 山崖：有实拍扫描岩石（Poly Haven）就用它，按米数缩放、用实例颜色染成这张地图的岩石色；
 * 没加载到时退回低多边形十二面体。base = 底部高度（海上的小岛在水面下）
 */
function rock(ctx, z, lat, { w, h, d, ry = 0, color = 0xffffff, base = 0, r = Math.max(w, d) * 0.5, force = false }) {
  const cliff = envModel('cliff');
  if (cliff) return ctx.prop(cliff.geo, cliff.mat, z, lat, { y: base - h * 0.06, ry, sx: w, sy: h, sz: d, color, r, align: false, force });
  return ctx.prop(GEO.rock, WHITE(), z, lat, { y: base + h * 0.35, ry, sx: w * 0.6, sy: h * 0.6, sz: d * 0.6, color, r, align: false, force });
}

/** 路边两色小桩 */
function posts(ctx, every, lat, topColor) {
  for (let z = Math.ceil(ctx.z0 / every) * every; z < ctx.z1; z += every) {
    for (const s of [-1, 1]) {
      const w = ctx.prop(GEO.boxBase, mat(0xf2f2f2), z, s * lat, { sx: 0.18, sy: 0.9, sz: 0.18, r: 0.3 });
      if (w) ctx.addAt(w, GEO.boxBase, mat(topColor), { y: 0.9, sx: 0.2, sy: 0.2, sz: 0.2 });
    }
  }
}

// ---------------------------------------------------------------- 郊区城市
function buildCity(ctx) {
  const P = PAL.city, SW = 4.5, cw = 7, { z0, z1, rng, rib } = ctx;
  const zc = z0 + L / 2;
  // 装饰性的小十字路口：只在笔直、远离真正路口的路段
  const cross = ((ctx.i % 4) + 4) % 4 === 2 && ctx.path.isStraight(z0 - 20, z1 + 20) && !ctx.nearJunction(200, 220);
  const gaps = cross ? [[zc - cw, zc + cw]] : [];
  const inCross = (a, b = a) => cross && b > zc - cw - 1 && a < zc + cw + 1;

  ground(ctx, groundMaterial('concrete', P.ground));
  rib.strip(roadMaterial(P.asphalt), z0, z1, -ROAD_HALF, ROAD_HALF, 0.02, ctx.step);
  sidewalks(ctx, P.side, SW, 0.16, gaps);
  if (cross) {
    rib.strip(roadMaterial(P.asphalt), zc - cw, zc + cw, -GROUND, GROUND, 0.03, 2);
    for (let x = -ROAD_HALF + 0.4; x < ROAD_HALF; x += 1.2) {
      rib.strip(P.line, zc - cw - 2.8, zc - cw - 0.6, x, x + 0.6, 0.05, 4);
      rib.strip(P.line, zc + cw + 0.6, zc + cw + 2.8, x, x + 0.6, 0.05, 4);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const w = ctx.prop(GEO.cylBase, mat(0x3a3d40), zc + sz * (cw + 1), sx * (ROAD_HALF + 1), { sx: 0.3, sy: 5.5, sz: 0.3, r: 0.5 });
      if (w) ctx.addAt(w, GEO.boxBase, mat(0x222428), { y: 4.2, sx: 0.6, sy: 1.6, sz: 0.6, align: true });
    }
  }
  markings(ctx, P, false, gaps);

  // 两侧建筑：写实立面（地铺商店 + 砖楼/灰泥楼/办公楼/玻璃幕墙）。
  // 俯视角时镜头一侧（-lat）压低避免挡路；追尾视角两边都可以是高楼。
  const fb = new FacadeBatch(), tallNear = CONFIG.world.tallNear;
  for (const s of [-1, 1]) {
    let z = z0 + rng() * 3;
    while (z < z1 - 4) {
      const zEnd = Math.min(z + 10 + rng() * 9, z1);
      if (inCross(z, zEnd)) { z = zc + cw + 1.5; continue; }
      const depth = 12 + rng() * 10, len = zEnd - z - 0.6, zm = (z + zEnd) / 2;
      const floors = s < 0 && !tallNear ? (rng() < 0.35 ? 1 : 0) : 1 + Math.floor(rng() * rng() * 7);
      const style = floors >= 4 && rng() < 0.7 ? pick(TALL_STYLES, rng) : pick(LOW_STYLES, rng);
      const lat = s * (ROAD_HALF + SW + 1 + depth / 2), w = ctx.at(zm, lat);
      const awning = rng() < 0.5 ? pick([0xb03a2e, 0x2e6b4f, 0x2d4f7b, 0x8a6d3b], rng) : null, acA = rng(), acB = rng(), ac = rng() < 0.7;
      if (!ctx.isBlocked(w.x, w.z, Math.max(depth, len) * 0.5)) {
        const h = fb.building({ x: w.x, z: w.z, rotY: w.h, w: depth, d: len, floors, style, r: rng });
        const face = lat - (s * depth) / 2; // 朝马路的立面
        // 地铺上方的石材腰线、楼顶压顶（有厚度的线脚，让楼不像一个平整的盒子）
        ctx.addAt(w, GEO.boxBase, mat(0xcfc6b6), { y: SHOP_H - 0.12, sx: depth + 0.35, sy: 0.32, sz: len + 0.35, align: true });
        ctx.addAt(w, GEO.boxBase, mat(0xb9b1a2), { y: h - 0.05, sx: depth + 0.3, sy: 0.3, sz: len + 0.3, align: true });
        if (awning) ctx.prop(GEO.boxBase, WHITE(), zm, face - s * 0.85, { y: 3.0, sx: 1.7, sy: 0.1, sz: len * 0.7, color: awning, force: true });
        if (ac) ctx.prop(GEO.boxBase, mat(0xb7b9bc), zm + (acB - 0.5) * len * 0.5, lat + (acA - 0.5) * depth * 0.5, { y: h + 0.25, sx: 2.2, sy: 1.3, sz: 2.2, force: true });
      }
      z = zEnd + 0.3 + rng() * 1.5;
    }
    // 远处天际线：后排的高层玻璃大楼，让追尾视角的地平线像真正的城市
    if ((s > 0 || tallNear) && rng() < 0.75) {
      const zm = z0 + rng() * L, depth = 16 + rng() * 10, len = 16 + rng() * 10, lat = s * (ROAD_HALF + SW + 34 + rng() * 22);
      const w = ctx.at(zm, lat);
      if (!ctx.isBlocked(w.x, w.z, 16)) fb.building({ x: w.x, z: w.z, rotY: w.h, w: depth, d: len, floors: 8 + Math.floor(rng() * 12), style: pick(TALL_STYLES, rng), shop: false, r: rng });
    }
  }
  fb.build(ctx.extraMeshes);

  // 路灯（两侧，每 20 米）
  for (let z = Math.ceil(z0 / 20) * 20; z < z1; z += 20) {
    if (inCross(z)) continue;
    for (const s of [-1, 1]) {
      const lat = s * (ROAD_HALF + 0.8);
      if (!ctx.prop(GEO.cylBase, mat(0x55585c), z, lat, { y: 0.16, sx: 0.22, sy: 6.4, sz: 0.22, r: 0.3 })) continue;
      ctx.prop(GEO.boxBase, mat(0x55585c), z, lat - s * 0.9, { y: 6.3, sx: 1.9, sy: 0.14, sz: 0.18, force: true });
      ctx.prop(GEO.boxBase, mat(0xfff3c4, { emissive: 0xffe08a }), z, lat - s * 1.7, { y: 6.1, sx: 0.7, sy: 0.18, sz: 0.4, force: true });
    }
  }

  // 电线杆 + 电线（只在笔直且远离路口的路段，保证电线不会穿过别的路）
  if (ctx.straight && !ctx.nearJunction(80, 200)) {
    const lat = ROAD_HALF + SW - 0.6;
    for (let z = Math.ceil(z0 / 26) * 26; z < z1; z += 26) {
      if (inCross(z)) continue;
      ctx.prop(GEO.cylBase, mat(0x5b4636), z, lat, { y: 0.16, sx: 0.36, sy: 10, sz: 0.36, force: true });
      ctx.prop(GEO.boxBase, mat(0x5b4636), z, lat, { y: 9.1, sx: 2.6, sy: 0.18, sz: 0.18, force: true });
      for (const off of [-1.1, 1.1]) {
        let prev = ctx.at(z, lat + off), py = 9.3;
        for (let k = 1; k <= 4; k++) {
          const ny = 9.3 - Math.sin((Math.PI * k) / 4) * 0.9, w = ctx.at(z + (26 * k) / 4, lat + off);
          ctx.wires.push(prev.x, py, prev.z, w.x, ny, w.z);
          prev = w;
          py = ny;
        }
      }
    }
  }

  // 人行道杂物：邮筒、报箱
  for (let k = 0; k < 3; k++) {
    const z = z0 + rng() * L, s = rng() < 0.5 ? -1 : 1, color = pick([0x2f5fae, 0xc0392b, 0x2f8a57], rng);
    if (!inCross(z)) ctx.prop(GEO.boxBase, WHITE(), z, s * (ROAD_HALF + SW - 1), { y: 0.16, sx: 0.6, sy: 1.1, sz: 0.6, color, r: 0.5 });
  }
}

// ---------------------------------------------------------------- 雪地森林
function pine(ctx, s, lat, sc, rng) {
  const ry = rng() * 6.28, color = pick(FOLIAGE, rng);
  const w = ctx.prop(GEO.cylBase, mat(0x5b4030), s, lat, { ry, sx: 0.5 * sc, sy: 1.6 * sc, sz: 0.5 * sc, r: 2.2 * sc, align: false });
  if (!w) return;
  for (let k = 0; k < 3; k++) {
    const r = (2.2 - k * 0.55) * sc, h = 2.6 * sc, y = (1.2 + k * 1.5) * sc;
    ctx.addAt(w, GEO.coneBase, WHITE(), { y, ry, sx: r, sy: h, sz: r, color });
    ctx.addAt(w, GEO.coneBase, mat(0xf3f6f8), { y: y + h * 0.55, ry, sx: r * 0.55, sy: h * 0.45, sz: r * 0.55 });
  }
}

function buildForest(ctx) {
  const P = PAL.forest, { z0, rng } = ctx;
  ground(ctx, groundMaterial('snow', P.ground));
  ruralRoad(ctx, P, 1.6);
  posts(ctx, 12, ROAD_HALF + 1.1, 0xc9261f);
  for (const s of [-1, 1]) {
    const n = 36 + Math.floor(rng() * 12);
    for (let k = 0; k < n; k++) {
      const z = z0 + rng() * L, lat = s * (ROAD_HALF + 3.5 + Math.pow(rng(), 1.4) * 40); // 越靠近路越密
      pine(ctx, z, lat, 0.8 + rng() * 1.0, rng);
    }
    for (let k = 0; k < 4; k++) {
      if (rng() > 0.55) continue;
      const far = k >= 2, z = z0 + rng() * L, sc = far ? 4 + rng() * 5 : 1.5 + rng() * 3;
      const lat = s * (ROAD_HALF + 3 + sc * 0.6 + rng() * (far ? 30 : 6)), ry = rng() * 6.28;
      rock(ctx, z, lat, { w: sc * 2.2, h: sc * 1.3, d: sc * 1.9, ry, color: pick([0xe9eef2, 0xd9dfe4, 0xf2f4f6], rng), r: sc });
    }
  }
}

// ---------------------------------------------------------------- 沙漠峡谷
// 仙人掌：圆润的胶囊形主干和手臂（平滑着色），手臂先水平伸出、再向上弯
const CACTUS = new THREE.CapsuleGeometry(0.5, 1, 4, 12).translate(0, 1, 0); // 高 2、底部在 y=0
const CACTUS_JOINT = new THREE.CapsuleGeometry(0.5, 1, 4, 10).rotateZ(Math.PI / 2); // 横躺的连接段
const CACTUS_MAT = new THREE.MeshStandardMaterial({ color: 0x4f7a34, roughness: 0.85 });
function cactus(ctx, s, lat, sc, rng) {
  const g = CACTUS_MAT, ry = rng() * 6.28, arms = [rng() < 0.75, rng() < 0.75], ys = [rng(), rng()];
  const w = ctx.prop(CACTUS, g, s, lat, { ry, sx: 0.7 * sc, sy: 2.1 * sc, sz: 0.7 * sc, r: 1.2 * sc, align: false });
  if (!w) return;
  [1, -1].forEach((dir, k) => {
    if (!arms[k]) return;
    // 绕 Y 旋转 ry 后，局部 X 轴的世界方向是 (cos ry, 0, -sin ry)
    const ax = Math.cos(ry) * dir, az = -Math.sin(ry) * dir, y = (1.6 + ys[k] * 1.2) * sc;
    ctx.addAt({ x: w.x + ax * 0.6 * sc, z: w.z + az * 0.6 * sc }, CACTUS_JOINT, g, { y, ry, sx: 0.5 * sc, sy: 0.42 * sc, sz: 0.42 * sc });
    ctx.addAt({ x: w.x + ax * 0.95 * sc, z: w.z + az * 0.95 * sc }, CACTUS, g, { y: y - 0.2 * sc, ry, sx: 0.42 * sc, sy: 0.8 * sc, sz: 0.42 * sc });
  });
}

function buildDesert(ctx) {
  const P = PAL.desert, { z0, rng } = ctx;
  ground(ctx, groundMaterial('sand', P.ground));
  ruralRoad(ctx, P);
  posts(ctx, 14, ROAD_HALF + 1.0, 0xe67e22);
  for (const s of [-1, 1]) {
    // 远处的岩山 / 峭壁（实拍扫描岩石染成红砂岩色）；俯视角时镜头一侧压低
    if (rng() < 0.75) {
      const z = z0 + rng() * L, lat = s * (ROAD_HALF + 20 + rng() * 32), w = 14 + rng() * 18, d = 12 + rng() * 16;
      const h = s < 0 && !CONFIG.world.tallNear ? 4 + rng() * 3 : 9 + rng() * 16;
      rock(ctx, z, lat, { w, h, d, ry: rng() * 6.28, color: pick([0xffc79a, 0xf2b285, 0xe8a77a, 0xffd2aa], rng), r: Math.max(w, d) * 0.6 });
    }
    for (let k = 0; k < 6; k++) cactus(ctx, z0 + rng() * L, s * (ROAD_HALF + 3 + Math.pow(rng(), 1.3) * 30), 0.8 + rng() * 0.7, rng);
    // 路边的碎石和大石头
    for (let k = 0; k < 7; k++) {
      const z = z0 + rng() * L, lat = s * (ROAD_HALF + 2.5 + rng() * 40), sc = 0.5 + rng() * rng() * 3;
      rock(ctx, z, lat, { w: sc * 1.6, h: sc * 0.9, d: sc * 1.4, ry: rng() * 6.28, color: pick([0xf5c9a0, 0xe7b48c, 0xd9a27a], rng), r: sc });
    }
  }
}

// ---------------------------------------------------------------- 海滨公路
function palm(ctx, s, lat, sc, rng) {
  const h = 6.5 * sc, ry0 = rng() * 6.28;
  const w = ctx.prop(GEO.cylBase, mat(0x8b6b45), s, lat, { sx: 0.45 * sc, sy: h, sz: 0.45 * sc, r: 2.5 * sc, align: false });
  if (!w) return;
  for (let k = 0; k < 6; k++) {
    // 叶子沿局部 Z 轴伸出：绕 Y 旋转 ry 后局部 Z 的世界方向是 (sin ry, 0, cos ry)
    const ry = ry0 + (k * Math.PI * 2) / 6;
    ctx.addAt({ x: w.x + Math.sin(ry) * 1.5 * sc, z: w.z + Math.cos(ry) * 1.5 * sc }, GEO.boxBase, mat(0x3f8f3a), { y: h - 0.35 * sc, ry, sx: 0.9 * sc, sy: 0.18 * sc, sz: 3.2 * sc });
  }
  ctx.addAt(w, GEO.rock, mat(0x6b4a2a), { y: h - 0.2 * sc, sx: 0.5 * sc, sy: 0.5 * sc, sz: 0.5 * sc });
}

function buildCoast(ctx) {
  const P = PAL.coast, beach = 13, { z0, z1, rng, rib } = ctx;
  // 镜头一侧（-lat）是沙滩和大海，视野开阔不挡路
  rib.strip(waterMaterial(P.sea), z0, z1, -80, -ROAD_HALF - beach, 0, ctx.step);
  rib.strip(P.foam, z0, z1, -ROAD_HALF - beach - 0.6, -ROAD_HALF - beach + 0.5, 0.02, ctx.step);
  rib.strip(groundMaterial('beach', P.sand), z0, z1, -ROAD_HALF - beach + 0.5, -ROAD_HALF - 1.2, 0.01, ctx.step);
  ground(ctx, groundMaterial('grass', P.ground), ROAD_HALF + 1.2, GROUND);
  ruralRoad(ctx, P, 1.2);
  // 海边护栏：每 4 米一节，跟着道路朝向，弯道上也贴着路
  for (let z = Math.ceil(z0 / 4) * 4; z < z1; z += 4) {
    if (!ctx.prop(GEO.boxBase, mat(0xdfe3e6), z, -ROAD_HALF - 0.9, { y: 0.55, sx: 0.12, sy: 0.25, sz: 4.05, r: 0.5 })) continue;
    if (z % 8 === 0) ctx.prop(GEO.boxBase, mat(0x9aa0a6), z, -ROAD_HALF - 0.9, { sx: 0.15, sy: 0.8, sz: 0.15, force: true });
  }
  for (let k = 0; k < 3; k++) {
    if (rng() < 0.5) continue;
    const z = z0 + rng() * L, lat = -ROAD_HALF - 4 - rng() * 7, ry = rng() * 6, color = pick([0xe74c3c, 0xf1c40f, 0x3498db, 0xff7eb6], rng);
    const w = ctx.prop(GEO.cylBase, mat(0xeeeeee), z, lat, { sx: 0.1, sy: 2.2, sz: 0.1, r: 1.6 });
    if (w) ctx.addAt(w, GEO.coneBase, WHITE(), { y: 1.9, ry, sx: 1.6, sy: 0.7, sz: 1.6, color });
  }
  for (let k = 0; k < 2; k++) {
    if (rng() < 0.5) continue;
    const z = z0 + rng() * L, sc = 2 + rng() * 4;
    rock(ctx, z, -ROAD_HALF - beach - 6 - rng() * 40, { w: sc * 2, h: sc * 1.1, d: sc * 1.7, ry: rng() * 6.28, color: pick([0xd8d2c8, 0xc9c2b6, 0xe2ddd4], rng), r: sc });
  }
  for (let k = 0; k < 14; k++) palm(ctx, z0 + rng() * L, ROAD_HALF + 3 + Math.pow(rng(), 1.2) * 38, 0.8 + rng() * 0.6, rng);
  for (let k = 0; k < 10; k++) {
    const z = z0 + rng() * L, sc = 0.6 + rng() * 1.2;
    ctx.prop(GEO.rock, WHITE(), z, ROAD_HALF + 2 + rng() * 40, { y: sc * 0.3, ry: rng() * 6.28, sx: sc * 1.4, sy: sc * 0.8, sz: sc * 1.2, color: pick([0x4f7f3a, 0x5d8f45, 0x3f6f35], rng), r: sc, align: false });
  }
}

// ---------------------------------------------------------------- 工业港口
function buildHarbor(ctx) {
  const P = PAL.harbor, SW = 3, { z0, z1, rng, rib } = ctx;
  ground(ctx, groundMaterial('concrete', P.ground));
  if (ctx.path.biomeAt(z1 + 1) === 'sea') launchPier(ctx);
  rib.strip(roadMaterial(P.asphalt), z0, z1, -ROAD_HALF, ROAD_HALF, 0.02, ctx.step);
  sidewalks(ctx, P.side, SW, 0.12);
  markings(ctx, P, false);

  // 集装箱堆：镜头一侧只堆 1 层，另一侧 1~3 层
  for (const s of [-1, 1]) {
    let z = z0 + rng() * 4;
    while (z < z1 - 3) {
      const len = 6.1, rows = 1 + Math.floor(rng() * 2), zm = z + len / 2;
      for (let r = 0; r < rows; r++) {
        const stacks = s < 0 && !CONFIG.world.tallNear ? 1 : 1 + Math.floor(rng() * 3), colors = [pick(CONTAINERS, rng), pick(CONTAINERS, rng), pick(CONTAINERS, rng)];
        const w = ctx.prop(GEO.boxBase, WHITE(), zm, s * (ROAD_HALF + SW + 3.3 + r * 2.7), { sx: 2.45, sy: 2.55, sz: len, color: colors[0], r: 3.2 });
        if (w) for (let k = 1; k < stacks; k++) ctx.addAt(w, GEO.boxBase, WHITE(), { y: k * 2.6, sx: 2.45, sy: 2.55, sz: len, color: colors[k], align: true });
      }
      z += len + 0.4 + (rng() < 0.25 ? 6 : 0);
    }
  }
  // 龙门吊（远离镜头的一侧）
  if (rng() < 0.4) {
    const z = z0 + 8 + rng() * (L - 16), yellow = mat(0xe0b020), mid = ROAD_HALF + SW + 10.25;
    if (ctx.prop(GEO.boxBase, yellow, z, mid, { y: 16, sx: 19, sy: 1.2, sz: 1.2, r: 10 })) {
      for (const dz of [0, 7]) {
        for (const lat of [ROAD_HALF + SW + 1.5, ROAD_HALF + SW + 19]) ctx.prop(GEO.boxBase, yellow, z + dz, lat, { sx: 0.9, sy: 16, sz: 0.9, force: true });
        if (dz) ctx.prop(GEO.boxBase, yellow, z + dz, mid, { y: 16, sx: 19, sy: 1.2, sz: 1.2, force: true });
      }
      ctx.prop(GEO.boxBase, mat(0xc0392b), z + 3.5, ROAD_HALF + SW + 6, { y: 14.6, sx: 2.4, sy: 1.4, sz: 8.2, force: true });
    }
  }
  // 仓库
  for (const s of [-1, 1]) {
    if (rng() < 0.3) continue;
    const z = z0 + rng() * L, depth = 14 + rng() * 8, len = 16 + rng() * 8, h = s < 0 && !CONFIG.world.tallNear ? 4 + rng() * 2 : 7 + rng() * 5;
    const lat = s * (ROAD_HALF + SW + 12 + depth / 2 + rng() * 10), color = pick([0x6d8a96, 0x8a8f94, 0x5f7380, 0xa3a7ab], rng);
    const w = ctx.prop(GEO.boxBase, WHITE(), z, lat, { sx: depth, sy: h, sz: len, color, r: Math.max(depth, len) * 0.5 });
    if (w) ctx.addAt(w, GEO.boxBase, mat(0x5a5f66), { y: h, sx: depth + 0.4, sy: 0.5, sz: len + 0.4, align: true });
  }
  // 高杆灯
  for (let z = Math.ceil(z0 / 30) * 30; z < z1; z += 30) {
    const w = ctx.prop(GEO.cylBase, mat(0x6b6f75), z, ROAD_HALF + SW - 0.5, { y: 0.12, sx: 0.3, sy: 11, sz: 0.3, r: 0.5 });
    if (w) ctx.addAt(w, GEO.boxBase, mat(0xfff3c4, { emissive: 0xffe08a }), { y: 11, sx: 1.4, sy: 0.4, sz: 1.4 });
  }
}

// ---------------------------------------------------------------- 海上追逐
// 码头尽头：黄黑斜纹的下水跳台（车道全宽）+ 两侧系船柱和警示灯
const STRIPES = (() => {
  const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
  const g = c.getContext('2d');
  g.fillStyle = '#f2c21a';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#16171a';
  for (let i = -2; i < 4; i++) {
    g.beginPath();
    g.moveTo(i * 64, 0); g.lineTo(i * 64 + 32, 0); g.lineTo(i * 64 + 160, 128); g.lineTo(i * 64 + 128, 128);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 1);
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 });
})();
const QUAY = new THREE.MeshStandardMaterial({ color: 0x8f8d88, roughness: 0.9 });

/** 楔形（沿局部 +Z 从 h0 升/降到 h1），宽 w、长 len，带 UV（斜面贴条纹） */
function wedge(w, len, h0, h1, bottom) {
  const x = w / 2;
  const v = [[-x, h0, 0], [x, h0, 0], [x, h1, len], [-x, h1, len], [-x, bottom, 0], [x, bottom, 0], [x, bottom, len], [-x, bottom, len]];
  const quads = [[0, 1, 2, 3], [4, 0, 3, 7], [1, 5, 6, 2], [4, 5, 1, 0], [3, 2, 6, 7]];
  const pos = [], uv = [];
  for (const [a, b, c, d] of quads) {
    pos.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]);
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function placeMesh(ctx, geo, material, s, lat = 0) {
  const w = ctx.at(s, lat), m = new THREE.Mesh(geo, material);
  m.position.set(w.x, 0, w.z);
  m.rotation.y = w.h;
  m.castShadow = m.receiveShadow = true;
  m.userData.ownGeo = true;
  ctx.extraMeshes.push(m);
  return m;
}

function launchPier(ctx) {
  const { z1 } = ctx, L = 6;
  placeMesh(ctx, wedge(ROAD_HALF * 2, L, 0.02, 1.4, 0), STRIPES, z1 - L);
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const w = ctx.prop(GEO.cylBase, mat(0x1d1f22), z1 - 2 - k * 7, s * (ROAD_HALF + 0.8), { sx: 0.45, sy: 0.7, sz: 0.45, force: true });
      if (w && k === 0) ctx.addAt(w, GEO.boxBase, mat(0xffd34d, { emissive: 0xffb000 }), { y: 0.72, sx: 0.3, sy: 0.3, sz: 0.3 });
    }
  }
}

function buildSea(ctx) {
  const { z0, z1, rng, rib, path } = ctx, W = WATER_Y;
  rib.strip(waterMaterial(PAL.sea.water), z0, z1, -260, 260, W, ctx.step);

  // 航道浮标：左红右绿（+lat 是驾驶员左侧），每 16 米一对；车道线上的小白浮子提供速度感
  for (let z = Math.ceil(z0 / 16) * 16; z < z1; z += 16) {
    for (const s of [-1, 1]) {
      const c = s > 0 ? 0xd62a1e : 0x1f9a4a;
      const w = ctx.prop(GEO.cylBase, mat(c), z, s * (ROAD_HALF + 1.3), { y: W - 0.3, sx: 0.6, sy: 1.1, sz: 0.6, r: 0.5, force: true });
      if (w) ctx.addAt(w, GEO.coneBase, mat(c), { y: W + 0.8, sx: 0.34, sy: 0.55, sz: 0.34 });
    }
  }
  for (let z = Math.ceil(z0 / 24) * 24; z < z1; z += 24) {
    for (let k = 1; k < CONFIG.road.lanes; k++) {
      ctx.prop(GEO.cylBase, mat(0xf4f4f0), z, -ROAD_HALF + k * CONFIG.road.laneWidth, { y: W - 0.1, sx: 0.28, sy: 0.22, sz: 0.28, force: true });
    }
  }

  for (const s of [-1, 1]) {
    // 礁石小岛（有的上面有灯塔）
    if (rng() < 0.55) {
      const z = z0 + rng() * 40, lat = s * (ROAD_HALF + 18 + rng() * 45), sx = 8 + rng() * 16, sy = 3 + rng() * 6, sz = 8 + rng() * 14;
      const w = rock(ctx, z, lat, { w: sx * 1.5, h: sy * 1.25, d: sz * 1.5, base: W - 1, ry: rng() * 6, color: pick([0xc8c0b6, 0xb8b0a6, 0xd6cfc4], rng), r: Math.max(sx, sz) });
      if (w) {
        ctx.addAt(w, GEO.rock, mat(0x4f7a3a), { y: W - 1 + sy * 1.05, ry: rng() * 6, sx: sx * 0.6, sy: sy * 0.25, sz: sz * 0.6 });
        if (rng() < 0.35) {
          const top = W - 1 + sy * 1.1;
          for (let k = 0; k < 4; k++) ctx.addAt(w, GEO.cylBase, mat(k % 2 ? 0xd62a1e : 0xf4f4f0), { y: top + k * 1.6, sx: 1.6 - k * 0.12, sy: 1.6, sz: 1.6 - k * 0.12 });
          ctx.addAt(w, GEO.boxBase, mat(0xfff3c4, { emissive: 0xffe08a }), { y: top + 6.4, sx: 1, sy: 1, sz: 1 });
          ctx.addAt(w, GEO.coneBase, mat(0x2a2c30), { y: top + 7.4, sx: 0.9, sy: 0.9, sz: 0.9 });
        }
      }
    }
    // 远处的货轮：船身 + 一排排集装箱 + 船尾驾驶楼
    if (rng() < 0.3) {
      const z = z0 + rng() * 40, lat = s * (ROAD_HALF + 50 + rng() * 40), hullC = pick([0x2b3f5c, 0x7a2a22, 0x2f4a3a, 0x3a3a3e], rng);
      const w = ctx.prop(GEO.boxBase, mat(hullC), z, lat, { y: W - 2, sx: 11, sy: 5, sz: 64, r: 34 });
      if (w) {
        ctx.addAt(w, GEO.boxBase, mat(0xb8b2a6), { y: W + 3, sx: 10.5, sy: 0.4, sz: 63, align: true });
        for (let row = -3; row <= 2; row++) {
          for (let tier = 0; tier < 2 + Math.floor(rng() * 2); tier++) {
            const off = row * 8.5;
            ctx.addAt({ x: w.x + Math.sin(w.h) * off, z: w.z + Math.cos(w.h) * off, h: w.h }, GEO.boxBase, WHITE(), { y: W + 3.4 + tier * 2.6, sx: 9.5, sy: 2.5, sz: 6, color: pick(CONTAINERS, rng), align: true });
          }
        }
        const back = -27;
        ctx.addAt({ x: w.x + Math.sin(w.h) * back, z: w.z + Math.cos(w.h) * back, h: w.h }, GEO.boxBase, mat(0xf2f2ee), { y: W + 3.4, sx: 9, sy: 8, sz: 6, align: true });
      }
    }
    // 帆船
    if (rng() < 0.45) {
      const z = z0 + rng() * 40, lat = s * (ROAD_HALF + 12 + rng() * 22), ry = rng() * 6;
      const w = ctx.prop(GEO.boxBase, mat(0xf2f2ee), z, lat, { y: W - 0.3, ry, sx: 1.6, sy: 0.7, sz: 5, r: 3, align: false });
      if (w) {
        ctx.addAt(w, GEO.cylBase, mat(0xcfd2d6), { y: W + 0.4, ry, sx: 0.12, sy: 7, sz: 0.12 });
        ctx.addAt(w, SAIL, mat(pick([0xf7f7f2, 0xf7f7f2, 0xd84a1e, 0x2f6fb0], rng)), { y: W + 0.9, ry, sx: 0.05, sy: 6, sz: 2.2 });
      }
    }
    // 远方山影（海平线上的陆地）
    if (rng() < 0.5) {
      const z = z0 + rng() * 40, sx = 50 + rng() * 60, sy = 14 + rng() * 22;
      rock(ctx, z, s * (150 + rng() * 80), { w: sx * 1.4, h: sy * 1.3, d: 50 + rng() * 40, base: W - 2, ry: rng() * 6, color: pick([0x9fb398, 0xa9b5a5, 0xb3bdb0], rng), r: 60, force: true });
    }
  }

  // 起点：码头岸壁（路面到水面有落差）+ 橡胶护舷
  if (path.biomeAt(z0 - 1) !== 'sea') {
    ctx.prop(GEO.boxBase, QUAY, z0 - 0.6, 0, { y: W - 1.2, sx: 90, sy: -W + 1.22, sz: 1.2, force: true });
    for (let lat = -40; lat <= 40; lat += 5) ctx.prop(GEO.boxBase, mat(0x1b1c1e), z0 + 0.15, lat, { y: W - 0.3, sx: 1.1, sy: 0.9, sz: 0.4, force: true });
  }
  // 终点：混凝土滑道从水里升到路面，两侧是岸壁
  if (path.biomeAt(z1 + 1) !== 'sea') {
    placeMesh(ctx, wedge(ROAD_HALF * 2 + 4, 12, W - 0.4, 0.02, W - 1.5), QUAY, z1 - 12);
    for (const s of [-1, 1]) ctx.prop(GEO.boxBase, QUAY, z1 + 0.6, s * (ROAD_HALF + 2 + 21.5), { y: W - 1.2, sx: 43, sy: -W + 1.22, sz: 1.2, force: true });
  }
}
const SAIL = new THREE.ConeGeometry(1, 1, 3).translate(0, 0.5, 0);

export const BUILDERS = { city: buildCity, forest: buildForest, desert: buildDesert, coast: buildCoast, harbor: buildHarbor, neon: buildNeon, sea: buildSea };
