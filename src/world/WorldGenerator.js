import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Road, ROAD_HALF } from './Road.js';
import { GEO, mat } from '../models/Models.js';
import { mulberry32, pick } from '../core/utils.js';

const L = CONFIG.world.chunkLength;
const LANES = CONFIG.road.lanes, LW = CONFIG.road.laneWidth;
const PAL = {
  city: { ground: 0x9b8f82, asphalt: 0x4b4d53, side: 0xc08a7c, line: 0xf2f2ea, edge: 0xe8c547 },
  forest: { ground: 0xd8e1e6, asphalt: 0x5d5f63, side: 0xb4b1a4, line: 0xf2f2ea, edge: 0xe8c547 },
};
const BRICKS = [0x8e3b2f, 0xa04a36, 0x7c5a4a, 0x6aa3a0, 0xb5a58f, 0x94563f];
const FOLIAGE = [0x6d7d2f, 0x5f7230, 0x7e8a36, 0x4f6a2e];
const ROCKS = [0x9c9a92, 0x8a8880, 0xb0aea6];
const WHITE = () => mat(0xffffff);

/** 把地面/道路/标线拼成少量大网格（每种颜色一个 mesh），减少 draw call */
class Ribbons {
  constructor() { this.buckets = new Map(); }
  quad(color, ax, az, bx, bz, cx, cz, dx, dz, y) {
    if (!this.buckets.has(color)) this.buckets.set(color, []);
    this.buckets.get(color).push(ax, y, az, cx, y, cz, bx, y, bz, bx, y, bz, cx, y, cz, dx, y, dz);
  }
  // 沿道路中心线的条带，a < b 是相对中心线的横向范围
  strip(color, z0, z1, a, b, y, step = 4) {
    let zp = z0, cp = Road.centerX(z0);
    while (zp < z1 - 1e-6) {
      const z = Math.min(zp + step, z1), c = Road.centerX(z);
      this.quad(color, cp + a, zp, cp + b, zp, c + a, z, c + b, z, y);
      zp = z; cp = c;
    }
  }
  rect(color, x0, x1, z0, z1, y) { this.quad(color, x0, z0, x1, z0, x0, z1, x1, z1, y); }
  build(group) {
    for (const [color, arr] of this.buckets) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat(color));
      m.receiveShadow = true;
      m.userData.ownGeo = true;
      group.add(m);
    }
  }
}

/** 收集同一几何体+材质的物件，最后合成 InstancedMesh（树、楼、路灯都靠它） */
class InstanceBatch {
  constructor() { this.items = new Map(); }
  add(geo, material, x, y, z, ry, sx, sy, sz, color) {
    const key = geo.uuid + material.uuid;
    if (!this.items.has(key)) this.items.set(key, { geo, material, list: [] });
    this.items.get(key).list.push([x, y, z, ry, sx, sy, sz, color]);
  }
  build(group) {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
    for (const { geo, material, list } of this.items.values()) {
      const im = new THREE.InstancedMesh(geo, material, list.length);
      const colored = list.some((d) => d[7] != null);
      list.forEach((d, i) => {
        m4.compose(p.set(d[0], d[1], d[2]), q.setFromEuler(e.set(0, d[3], 0)), s.set(d[4], d[5], d[6]));
        im.setMatrixAt(i, m4);
        if (colored) im.setColorAt(i, c.setHex(d[7] ?? 0xffffff));
      });
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      group.add(im);
    }
  }
}

export class WorldGenerator {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map();
  }

  reset() {
    for (const g of this.chunks.values()) this.dispose(g);
    this.chunks.clear();
  }

  update(playerZ) {
    const { chunksAhead, chunksBehind } = CONFIG.world;
    const cur = Math.floor(playerZ / L);
    for (let i = cur - chunksBehind; i <= cur + chunksAhead; i++) {
      if (!this.chunks.has(i)) this.chunks.set(i, this.build(i));
    }
    for (const [i, g] of this.chunks) {
      if (i < cur - chunksBehind || i > cur + chunksAhead) { this.dispose(g); this.chunks.delete(i); }
    }
  }

  dispose(group) {
    group.traverse((o) => {
      if (o.userData.ownGeo) o.geometry.dispose();
      if (o.isInstancedMesh) o.dispose();
    });
    this.scene.remove(group);
  }

  build(i) {
    const group = new THREE.Group();
    const z0 = i * L, z1 = z0 + L;
    const rng = mulberry32(i * 7919 + 13);
    const rib = new Ribbons(), inst = new InstanceBatch(), wires = [];
    if (Road.biomeAt(z0 + L / 2) === 'city') this.buildCity(i, z0, z1, rng, rib, inst, wires);
    else this.buildForest(z0, z1, rng, rib, inst);
    rib.build(group);
    inst.build(group);
    if (wires.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2a2a2a }));
      lines.userData.ownGeo = true;
      group.add(lines);
    }
    this.scene.add(group);
    return group;
  }

  markings(rib, P, z0, z1, centerYellow, skip) {
    for (let k = 1; k < LANES; k++) {
      const off = -ROAD_HALF + k * LW;
      if (centerYellow && k === LANES / 2) {
        rib.strip(P.edge, z0, z1, off - 0.24, off - 0.1, 0.05);
        rib.strip(P.edge, z0, z1, off + 0.1, off + 0.24, 0.05);
        continue;
      }
      for (let z = Math.ceil(z0 / 9) * 9; z < z1; z += 9) {
        if (!skip?.(z)) rib.strip(P.line, z, z + 4, off - 0.09, off + 0.09, 0.05, 4);
      }
    }
    rib.strip(P.line, z0, z1, -ROAD_HALF + 0.2, -ROAD_HALF + 0.36, 0.05);
    rib.strip(P.line, z0, z1, ROAD_HALF - 0.36, ROAD_HALF - 0.2, 0.05);
  }

  // ---------------- 郊区城市：直路、十字路口、红砖楼、路灯、电线杆 ----------------
  buildCity(i, z0, z1, rng, rib, inst, wires) {
    const P = PAL.city, SW = 4.5, cw = 7;
    const zc = z0 + L / 2;
    const cross = ((i % 4) + 4) % 4 === 2;
    const inCross = (a, b = a) => cross && b > zc - cw - 1 && a < zc + cw + 1;

    rib.strip(P.ground, z0, z1, -130, 130, 0, 10);
    rib.strip(P.asphalt, z0, z1, -ROAD_HALF, ROAD_HALF, 0.02, 10);
    const segs = cross ? [[z0, zc - cw], [zc + cw, z1]] : [[z0, z1]];
    for (const [a, b] of segs) {
      rib.strip(P.side, a, b, -ROAD_HALF - SW, -ROAD_HALF, 0.16, 10);
      rib.strip(P.side, a, b, ROAD_HALF, ROAD_HALF + SW, 0.16, 10);
    }
    if (cross) {
      rib.rect(P.asphalt, -130, 130, zc - cw, zc + cw, 0.03);
      for (let x = -ROAD_HALF + 0.4; x < ROAD_HALF; x += 1.2) {
        rib.rect(P.line, x, x + 0.6, zc - cw - 2.8, zc - cw - 0.6, 0.05);
        rib.rect(P.line, x, x + 0.6, zc + cw + 0.6, zc + cw + 2.8, 0.05);
      }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const x = sx * (ROAD_HALF + 1), z = zc + sz * (cw + 1);
        inst.add(GEO.cylBase, mat(0x3a3d40), x, 0, z, 0, 0.3, 5.5, 0.3);
        inst.add(GEO.boxBase, mat(0x222428), x, 4.2, z, 0, 0.6, 1.6, 0.6);
      }
    }
    this.markings(rib, P, z0, z1, false, (z) => inCross(z, z + 4));

    // 两侧建筑
    for (const s of [-1, 1]) {
      let z = z0 + rng() * 3;
      while (z < z1 - 4) {
        const zEnd = Math.min(z + 9 + rng() * 8, z1);
        if (inCross(z, zEnd)) { z = zc + cw + 1.5; continue; }
        // 靠镜头一侧（-X）的楼压低，避免挡住马路
        const depth = 12 + rng() * 10, h = s < 0 ? 3.5 + rng() * 3 : 7 + rng() * 16, len = zEnd - z - 0.6, zm = (z + zEnd) / 2;
        const x = Road.centerX(zm) + s * (ROAD_HALF + SW + 1 + depth / 2);
        const fx = x - (s * depth) / 2; // 朝向马路的立面
        inst.add(GEO.boxBase, WHITE(), x, 0, zm, 0, depth, h, len, pick(BRICKS, rng));
        for (let fy = 3.2; fy < h - 1.5; fy += 3.4) inst.add(GEO.boxBase, mat(0x2b3a48), fx - s * 0.08, fy, zm, 0, 0.3, 1.5, len * 0.8);
        inst.add(GEO.boxBase, mat(0xe9e1d3), fx - s * 0.1, h - 0.6, zm, 0, 0.7, 0.6, len);
        if (rng() < 0.5) inst.add(GEO.boxBase, WHITE(), fx - s * 0.8, 2.6, zm, 0, 1.6, 0.25, len * 0.7, pick([0xc0392b, 0x2e7d5b, 0x2d5f8b], rng));
        if (rng() < 0.7) inst.add(GEO.boxBase, mat(0xb7b9bc), x + (rng() - 0.5) * depth * 0.5, h, zm + (rng() - 0.5) * len * 0.5, 0, 2.2, 1.3, 2.2);
        z = zEnd + 0.3 + rng() * 1.5;
      }
    }

    // 路灯（两侧，每 20 米）
    for (let z = Math.ceil(z0 / 20) * 20; z < z1; z += 20) {
      if (inCross(z)) continue;
      for (const s of [-1, 1]) {
        const x = Road.centerX(z) + s * (ROAD_HALF + 0.8);
        inst.add(GEO.cylBase, mat(0x55585c), x, 0.16, z, 0, 0.22, 6.4, 0.22);
        inst.add(GEO.boxBase, mat(0x55585c), x - s * 0.9, 6.3, z, 0, 1.9, 0.14, 0.18);
        inst.add(GEO.boxBase, mat(0xfff3c4, { emissive: 0xffe08a }), x - s * 1.7, 6.1, z, 0, 0.7, 0.18, 0.4);
      }
    }

    // 电线杆 + 电线（右侧，全局每 26 米一根，保证跨区块连续）
    const poleX = (z) => Road.centerX(z) + ROAD_HALF + SW - 0.6;
    for (let z = Math.ceil(z0 / 26) * 26; z < z1; z += 26) {
      if (inCross(z)) continue;
      inst.add(GEO.cylBase, mat(0x5b4636), poleX(z), 0.16, z, 0, 0.36, 10, 0.36);
      inst.add(GEO.boxBase, mat(0x5b4636), poleX(z), 9.1, z, 0, 2.6, 0.18, 0.18);
      for (const off of [-1.1, 1.1]) {
        let pz = z, py = 9.3;
        for (let k = 1; k <= 4; k++) {
          const nz = z + (26 * k) / 4, ny = 9.3 - Math.sin((Math.PI * k) / 4) * 0.9;
          wires.push(poleX(pz) + off, py, pz, poleX(nz) + off, ny, nz);
          pz = nz; py = ny;
        }
      }
    }

    // 人行道杂物：邮筒、报箱
    for (let k = 0; k < 3; k++) {
      const z = z0 + rng() * L;
      if (inCross(z)) continue;
      const s = rng() < 0.5 ? -1 : 1;
      inst.add(GEO.boxBase, WHITE(), Road.centerX(z) + s * (ROAD_HALF + SW - 1), 0.16, z, 0, 0.6, 1.1, 0.6, pick([0x2f5fae, 0xc0392b, 0x2f8a57], rng));
    }
  }

  // ---------------- 雪地与森林：蜿蜒公路、松树林、巨石 ----------------
  buildForest(z0, z1, rng, rib, inst) {
    const P = PAL.forest;
    rib.strip(P.ground, z0, z1, -130, 130, 0, 4);
    rib.strip(P.side, z0, z1, -ROAD_HALF - 1.6, -ROAD_HALF, 0.012, 2);
    rib.strip(P.side, z0, z1, ROAD_HALF, ROAD_HALF + 1.6, 0.012, 2);
    rib.strip(P.asphalt, z0, z1, -ROAD_HALF, ROAD_HALF, 0.02, 2);
    this.markings(rib, P, z0, z1, true);

    // 路边红头白桩
    for (let z = Math.ceil(z0 / 12) * 12; z < z1; z += 12) {
      for (const s of [-1, 1]) {
        const x = Road.centerX(z) + s * (ROAD_HALF + 1.1);
        inst.add(GEO.boxBase, mat(0xf2f2f2), x, 0, z, 0, 0.18, 0.9, 0.18);
        inst.add(GEO.boxBase, mat(0xc9261f), x, 0.9, z, 0, 0.2, 0.2, 0.2);
      }
    }

    for (const s of [-1, 1]) {
      // 松树
      const n = 36 + Math.floor(rng() * 12);
      for (let k = 0; k < n; k++) {
        const z = z0 + rng() * L;
        const lat = s * (ROAD_HALF + 3.5 + Math.pow(rng(), 1.4) * 50); // 越靠近路越密
        this.pine(inst, Road.centerX(z) + lat, z, 0.8 + rng() * 1.0, rng);
      }
      // 巨石（近处小、远处大）
      for (let k = 0; k < 4; k++) {
        if (rng() > 0.55) continue;
        const far = k >= 2;
        const z = z0 + rng() * L, sc = far ? 4 + rng() * 5 : 1.5 + rng() * 3;
        const x = Road.centerX(z) + s * (ROAD_HALF + 3 + sc * 0.6 + rng() * (far ? 30 : 6));
        const ry = rng() * 6.28;
        inst.add(GEO.rock, WHITE(), x, sc * 0.35, z, ry, sc * 1.3, sc, sc * 1.1, pick(ROCKS, rng));
        inst.add(GEO.rock, mat(0xf4f7f9), x, sc * 0.75, z, ry, sc * 1.05, sc * 0.45, sc * 0.9);
      }
    }
  }

  pine(inst, x, z, s, rng) {
    const ry = rng() * 6.28, color = pick(FOLIAGE, rng);
    inst.add(GEO.cylBase, mat(0x5b4030), x, 0, z, ry, 0.5 * s, 1.6 * s, 0.5 * s);
    for (let k = 0; k < 3; k++) {
      const r = (2.2 - k * 0.55) * s, h = 2.6 * s, y = (1.2 + k * 1.5) * s;
      inst.add(GEO.coneBase, WHITE(), x, y, z, ry, r, h, r, color);
      inst.add(GEO.coneBase, mat(0xf3f6f8), x, y + h * 0.55, z, ry, r * 0.55, h * 0.45, r * 0.55);
    }
  }
}
