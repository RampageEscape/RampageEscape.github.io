import { CONFIG } from '../config.js';
import { ROAD_HALF } from './Road.js';
import { GEO, mat } from '../models/Models.js';
import { pick } from '../core/utils.js';

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
};
const BRICKS = [0x8e3b2f, 0xa04a36, 0x7c5a4a, 0x6aa3a0, 0xb5a58f, 0x94563f];
const FOLIAGE = [0x6d7d2f, 0x5f7230, 0x7e8a36, 0x4f6a2e];
const ROCKS = [0x9c9a92, 0x8a8880, 0xb0aea6];
const MESA = [0xc0643d, 0xb5583a, 0xa94f33, 0xcf7a4b];
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
  rib.strip(P.asphalt, z0, z1, -ROAD_HALF, ROAD_HALF, 0.02, ctx.step);
  for (const [a, b] of ctx.roadRanges()) {
    rib.strip(P.side, a, b, -ROAD_HALF - shoulder, -ROAD_HALF, 0.012, ctx.step);
    rib.strip(P.side, a, b, ROAD_HALF, ROAD_HALF + shoulder, 0.012, ctx.step);
  }
  markings(ctx, P, true);
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

  ground(ctx, P.ground);
  rib.strip(P.asphalt, z0, z1, -ROAD_HALF, ROAD_HALF, 0.02, ctx.step);
  for (const [a, b] of ctx.roadRanges(gaps)) {
    rib.strip(P.side, a, b, -ROAD_HALF - SW, -ROAD_HALF, 0.16, ctx.step);
    rib.strip(P.side, a, b, ROAD_HALF, ROAD_HALF + SW, 0.16, ctx.step);
  }
  if (cross) {
    rib.strip(P.asphalt, zc - cw, zc + cw, -GROUND, GROUND, 0.03, 2);
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

  // 两侧建筑：镜头一侧（-lat）压低，避免挡住马路
  for (const s of [-1, 1]) {
    let z = z0 + rng() * 3;
    while (z < z1 - 4) {
      const zEnd = Math.min(z + 9 + rng() * 8, z1);
      if (inCross(z, zEnd)) { z = zc + cw + 1.5; continue; }
      const depth = 12 + rng() * 10, h = s < 0 ? 3.5 + rng() * 3 : 7 + rng() * 16, len = zEnd - z - 0.6, zm = (z + zEnd) / 2;
      const lat = s * (ROAD_HALF + SW + 1 + depth / 2), color = pick(BRICKS, rng);
      const awning = rng() < 0.5 ? pick([0xc0392b, 0x2e7d5b, 0x2d5f8b], rng) : null, acA = rng(), acB = rng(), ac = rng() < 0.7;
      if (ctx.prop(GEO.boxBase, WHITE(), zm, lat, { sx: depth, sy: h, sz: len, color, r: Math.max(depth, len) * 0.5 })) {
        const face = lat - (s * depth) / 2; // 朝马路的立面
        for (let fy = 3.2; fy < h - 1.5; fy += 3.4) ctx.prop(GEO.boxBase, mat(0x2b3a48), zm, face - s * 0.08, { y: fy, sx: 0.3, sy: 1.5, sz: len * 0.8, force: true });
        ctx.prop(GEO.boxBase, mat(0xe9e1d3), zm, face - s * 0.1, { y: h - 0.6, sx: 0.7, sy: 0.6, sz: len, force: true });
        if (awning) ctx.prop(GEO.boxBase, WHITE(), zm, face - s * 0.8, { y: 2.6, sx: 1.6, sy: 0.25, sz: len * 0.7, color: awning, force: true });
        if (ac) ctx.prop(GEO.boxBase, mat(0xb7b9bc), zm + (acB - 0.5) * len * 0.5, lat + (acA - 0.5) * depth * 0.5, { y: h, sx: 2.2, sy: 1.3, sz: 2.2, force: true });
      }
      z = zEnd + 0.3 + rng() * 1.5;
    }
  }

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
  ground(ctx, P.ground);
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
      const lat = s * (ROAD_HALF + 3 + sc * 0.6 + rng() * (far ? 30 : 6)), ry = rng() * 6.28, color = pick(ROCKS, rng);
      const w = ctx.prop(GEO.rock, WHITE(), z, lat, { y: sc * 0.35, ry, sx: sc * 1.3, sy: sc, sz: sc * 1.1, color, r: sc, align: false });
      if (w) ctx.addAt(w, GEO.rock, mat(0xf4f7f9), { y: sc * 0.75, ry, sx: sc * 1.05, sy: sc * 0.45, sz: sc * 0.9 });
    }
  }
}

// ---------------------------------------------------------------- 沙漠峡谷
function cactus(ctx, s, lat, sc, rng) {
  const g = mat(0x5f8a3a), ry = rng() * 6.28, arms = [rng() < 0.75, rng() < 0.75], ys = [rng(), rng()];
  const w = ctx.prop(GEO.cylBase, g, s, lat, { ry, sx: 0.7 * sc, sy: 4.2 * sc, sz: 0.7 * sc, r: 1.2 * sc, align: false });
  if (!w) return;
  [1, -1].forEach((dir, k) => {
    if (!arms[k]) return;
    // 绕 Y 旋转 ry 后，局部 X 轴的世界方向是 (cos ry, 0, -sin ry)
    const ax = Math.cos(ry) * dir, az = -Math.sin(ry) * dir, y = (1.6 + ys[k] * 1.2) * sc;
    ctx.addAt({ x: w.x + ax * 0.55 * sc, z: w.z + az * 0.55 * sc }, GEO.boxBase, g, { y, ry, sx: 0.9 * sc, sy: 0.45 * sc, sz: 0.45 * sc });
    ctx.addAt({ x: w.x + ax * 0.95 * sc, z: w.z + az * 0.95 * sc }, GEO.cylBase, g, { y, ry, sx: 0.45 * sc, sy: 1.5 * sc, sz: 0.45 * sc });
  });
}

function buildDesert(ctx) {
  const P = PAL.desert, { z0, rng } = ctx;
  ground(ctx, P.ground);
  ruralRoad(ctx, P);
  posts(ctx, 14, ROAD_HALF + 1.0, 0xe67e22);
  for (const s of [-1, 1]) {
    // 远处的平顶岩山：两层岩块 + 浅色顶面；镜头一侧压低
    if (rng() < 0.65) {
      const z = z0 + rng() * L, lat = s * (ROAD_HALF + 22 + rng() * 30), w = 10 + rng() * 14, d = 10 + rng() * 14;
      const h = s < 0 ? 4 + rng() * 3 : 10 + rng() * 14, ry = rng() * 6.28, c1 = pick(MESA, rng), c2 = pick(MESA, rng);
      const at = ctx.prop(GEO.boxBase, WHITE(), z, lat, { ry, sx: w, sy: h * 0.6, sz: d, color: c1, r: Math.max(w, d) * 0.6, align: false });
      if (at) {
        ctx.addAt(at, GEO.boxBase, WHITE(), { y: h * 0.6, ry, sx: w * 0.8, sy: h * 0.4, sz: d * 0.8, color: c2 });
        ctx.addAt(at, GEO.boxBase, mat(0xe0a27a), { y: h, ry, sx: w * 0.82, sy: 0.4, sz: d * 0.82 });
      }
    }
    for (let k = 0; k < 6; k++) cactus(ctx, z0 + rng() * L, s * (ROAD_HALF + 3 + Math.pow(rng(), 1.3) * 30), 0.8 + rng() * 0.7, rng);
    for (let k = 0; k < 10; k++) {
      const z = z0 + rng() * L, lat = s * (ROAD_HALF + 2 + rng() * 40), sc = 0.4 + rng() * 0.8;
      ctx.prop(GEO.rock, WHITE(), z, lat, { y: sc * 0.3, ry: rng() * 6.28, sx: sc * 1.3, sy: sc * 0.6, sz: sc, color: pick([0xa08850, 0x8f7a45, 0xb7a06a, 0x9c6a4a], rng), r: sc, align: false });
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
  rib.strip(P.sea, z0, z1, -80, -ROAD_HALF - beach, 0, ctx.step);
  rib.strip(P.foam, z0, z1, -ROAD_HALF - beach - 0.6, -ROAD_HALF - beach + 0.5, 0.02, ctx.step);
  rib.strip(P.sand, z0, z1, -ROAD_HALF - beach + 0.5, -ROAD_HALF - 1.2, 0.01, ctx.step);
  ground(ctx, P.ground, ROAD_HALF + 1.2, GROUND);
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
    ctx.prop(GEO.rock, WHITE(), z, -ROAD_HALF - beach - 6 - rng() * 40, { y: sc * 0.2, ry: rng() * 6.28, sx: sc * 1.3, sy: sc * 0.7, sz: sc, color: pick(ROCKS, rng), r: sc, align: false });
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
  ground(ctx, P.ground);
  rib.strip(P.asphalt, z0, z1, -ROAD_HALF, ROAD_HALF, 0.02, ctx.step);
  for (const [a, b] of ctx.roadRanges()) {
    rib.strip(P.side, a, b, -ROAD_HALF - SW, -ROAD_HALF, 0.12, ctx.step);
    rib.strip(P.side, a, b, ROAD_HALF, ROAD_HALF + SW, 0.12, ctx.step);
  }
  markings(ctx, P, false);

  // 集装箱堆：镜头一侧只堆 1 层，另一侧 1~3 层
  for (const s of [-1, 1]) {
    let z = z0 + rng() * 4;
    while (z < z1 - 3) {
      const len = 6.1, rows = 1 + Math.floor(rng() * 2), zm = z + len / 2;
      for (let r = 0; r < rows; r++) {
        const stacks = s < 0 ? 1 : 1 + Math.floor(rng() * 3), colors = [pick(CONTAINERS, rng), pick(CONTAINERS, rng), pick(CONTAINERS, rng)];
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
    const z = z0 + rng() * L, depth = 14 + rng() * 8, len = 16 + rng() * 8, h = s < 0 ? 4 + rng() * 2 : 7 + rng() * 5;
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

export const BUILDERS = { city: buildCity, forest: buildForest, desert: buildDesert, coast: buildCoast, harbor: buildHarbor };
