import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Road } from './Road.js';
import { JUNCTION_ROAD_CLEARANCE } from './LevelManager.js';
import { mat } from '../models/Models.js';
import { mulberry32 } from '../core/utils.js';
import { BUILDERS, PAL } from './BiomeBuilders.js';

const L = CONFIG.world.chunkLength;
const J = CONFIG.junction;

/** 把地面/道路/标线拼成少量大网格（每种颜色一个 mesh），沿任意路线铺设 */
class Ribbons {
  constructor(path, yBase) {
    this.path = path;
    this.yBase = yBase;
    this.buckets = new Map();
    this.a = {};
    this.b = {};
  }
  quad(color, ax, az, bx, bz, cx, cz, dx, dz, y) {
    if (!this.buckets.has(color)) this.buckets.set(color, []);
    y += this.yBase;
    this.buckets.get(color).push(ax, y, az, cx, y, cz, bx, y, bz, bx, y, bz, cx, y, cz, dx, y, dz);
  }
  // 沿路线的条带：里程 s0~s1，横向 a~b（a < b，+lat 在左侧）
  strip(color, s0, s1, a, b, y, step = 4) {
    const P = this.path, A = this.a, B = this.b; // A = a 侧（右）, B = b 侧（左）
    let s = s0;
    P.sample(s, a, A);
    P.sample(s, b, B);
    let ax = A.x, az = A.z, bx = B.x, bz = B.z;
    while (s < s1 - 1e-6) {
      s = Math.min(s + step, s1);
      P.sample(s, a, A);
      P.sample(s, b, B);
      // 顶点顺序：a 侧在前，保证法线朝上（不然会被背面剔除）
      this.quad(color, ax, az, bx, bz, A.x, A.z, B.x, B.z, y);
      ax = A.x; az = A.z; bx = B.x; bz = B.z;
    }
  }
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

/** 收集同一几何体+材质的物件，最后合成 InstancedMesh */
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

/**
 * 一个区块的构建上下文。地图 builder 只通过它放东西：
 *   - 用道路坐标 (s, lat) 放道具，自动换算世界坐标、可选跟随道路朝向
 *   - 自动避开路口方框和“别的岔路”的路面（blockers）
 *   - roadRanges() 给出可以画路肩/标线的里程区间（扣掉路口区域）
 */
export class ChunkCtx {
  constructor(path, i, yBase, blockers) {
    this.path = path;
    this.i = i;
    this.z0 = i * L;
    this.z1 = this.z0 + L;
    this.rng = mulberry32(i * 7919 + 13 + Math.round(yBase * 1e4));
    this.rib = new Ribbons(path, yBase);
    this.inst = new InstanceBatch();
    this.wires = [];
    this.blockers = blockers;
    this.straight = path.isStraight(this.z0, this.z1);
    this.step = this.straight ? 10 : 2;
  }

  at(s, lat) {
    return this.path.sample(s, lat, {});
  }

  isBlocked(x, z, r) {
    for (const b of this.blockers) {
      if (b.box) {
        // 路口方框：沿进入方向 0~2B，横向 ±B
        const dx = x - b.x, dz = z - b.z;
        const along = dx * Math.sin(b.h) + dz * Math.cos(b.h);
        const across = dx * Math.cos(b.h) - dz * Math.sin(b.h);
        if (along > -r - 2 && along < 2 * J.box + r + 2 && Math.abs(across) < J.box + r + 2) return true;
      } else {
        const lim = (JUNCTION_ROAD_CLEARANCE + r) ** 2;
        for (const p of b.pts) if ((p.x - x) ** 2 + (p.z - z) ** 2 < lim) return true;
      }
    }
    return false;
  }

  /** 在 (s, lat) 放一个道具；被挡住时不放并返回 null。返回世界坐标，方便叠加细节 */
  prop(geo, material, s, lat, { y = 0, ry = 0, sx = 1, sy = 1, sz = 1, color, r = 1, align = true, force = false } = {}) {
    const w = this.at(s, lat);
    if (!force && this.isBlocked(w.x, w.z, r)) return null;
    this.inst.add(geo, material, w.x, y, w.z, (align ? w.h : 0) + ry, sx, sy, sz, color);
    return w;
  }

  /** 在已知世界坐标 w 处直接放（同一棵树 / 同一栋楼的多个部件） */
  addAt(w, geo, material, { y = 0, ry = 0, sx = 1, sy = 1, sz = 1, color, align = false } = {}) {
    this.inst.add(geo, material, w.x, y, w.z, (align ? w.h : 0) + ry, sx, sy, sz, color);
  }

  roadRanges(extraGaps = []) {
    let ranges = [[this.z0, this.z1]];
    const gaps = this.path.junctions.map((j) => [j.sEntry, j.sEntry + j.boxLen]).concat(extraGaps);
    for (const [g0, g1] of gaps) {
      const next = [];
      for (const [a, b] of ranges) {
        if (g1 <= a || g0 >= b) next.push([a, b]);
        else {
          if (g0 > a) next.push([a, g0]);
          if (g1 < b) next.push([g1, b]);
        }
      }
      ranges = next;
    }
    return ranges;
  }

  nearJunction(before, after) {
    return this.path.nearJunction(this.z0, this.z1, before, after);
  }
}

export class WorldGenerator {
  constructor(scene, levels) {
    this.scene = scene;
    this.levels = levels;
    this.chunks = new Map(); // key -> { group }
    this.orphans = []; // 没被选中的岔路区块 { group, until }
    this.pads = new Map(); // 路口 id -> 路口路面
  }

  reset() {
    for (const c of this.chunks.values()) this.dispose(c.group);
    for (const o of this.orphans) this.dispose(o.group);
    for (const g of this.pads.values()) this.dispose(g);
    this.chunks.clear();
    this.orphans = [];
    this.pads.clear();
  }

  /** 路口提交：选中出口的区块改为主路线区块，其他出口的区块留到玩家开远再清理 */
  onCommit(j) {
    for (const [key, c] of [...this.chunks]) {
      const m = key.match(/^j(\d+)o(\d+):(-?\d+)$/);
      if (!m || Number(m[1]) !== j.id) continue;
      this.chunks.delete(key);
      if (Number(m[2]) === j.chosen) this.chunks.set(`m:${m[3]}`, c);
      else this.orphans.push({ group: c.group, until: j.sEntry + J.keepAfter });
    }
  }

  update(playerS) {
    const { chunksAhead, chunksBehind } = CONFIG.world;
    const cur = Math.floor(playerS / L);
    const j = this.levels.junction;
    const pendingK = j && !j.committed ? Math.round(j.sEntry / L) : Infinity;
    const wanted = new Set();

    for (let i = cur - chunksBehind; i <= cur + chunksAhead; i++) {
      if (i < pendingK) {
        const key = `m:${i}`;
        wanted.add(key);
        if (!this.chunks.has(key)) this.chunks.set(key, { group: this.build(Road.path, i, 0, null) });
      } else {
        // 路口还没选：每个出口各建一套区块（地面略微错开高度，避免重叠闪烁）
        j.options.forEach((o, k) => {
          const key = `j${j.id}o${k}:${i}`;
          wanted.add(key);
          if (!this.chunks.has(key)) this.chunks.set(key, { group: this.build(o.path, i, 0.004 * (k + 1), o) });
        });
      }
    }
    for (const [key, c] of this.chunks) {
      if (!wanted.has(key)) { this.dispose(c.group); this.chunks.delete(key); }
    }
    this.orphans = this.orphans.filter((o) => {
      if (playerS < o.until) return true;
      this.dispose(o.group);
      return false;
    });

    // 路口路面：进入视野范围就建，开远了就清
    const active = this.levels.activeJunctions;
    for (const jn of active) {
      const near = jn.sEntry - playerS < (chunksAhead + 1) * L && playerS < jn.sEntry + J.keepAfter;
      if (near && !this.pads.has(jn.id)) this.pads.set(jn.id, this.buildPad(jn));
    }
    for (const [id, g] of this.pads) {
      const jn = active.find((x) => x.id === id);
      if (!jn || playerS >= jn.sEntry + J.keepAfter) { this.dispose(g); this.pads.delete(id); }
    }
  }

  /** 这个区块需要避让的东西：附近路口的方框 + 除自己以外所有出口的路面 */
  blockersFor(path, ownOption, s0, s1) {
    const list = [];
    for (const jn of this.levels.activeJunctions) {
      if (s1 < jn.sEntry - 160 || s0 > jn.sEntry + J.blockAfter + 60) continue;
      if (jn.type !== 'fork') list.push({ box: true, x: jn.x, z: jn.z, h: jn.h0 });
      const mine = ownOption ?? (jn.committed && path === jn.options[jn.chosen].path ? jn.options[jn.chosen] : null);
      for (const o of jn.options) if (o !== mine) list.push({ pts: o.samples });
    }
    return list;
  }

  build(path, i, yBase, ownOption) {
    const group = new THREE.Group();
    const s0 = i * L;
    const ctx = new ChunkCtx(path, i, yBase, this.blockersFor(path, ownOption, s0, s0 + L));
    BUILDERS[path.biomeAt(s0 + L / 2)](ctx);
    ctx.rib.build(group);
    ctx.inst.build(group);
    if (ctx.wires.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(ctx.wires, 3));
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2a2a2a }));
      lines.userData.ownGeo = true;
      group.add(lines);
    }
    this.scene.add(group);
    return group;
  }

  /** 十字/T 字路口的方形路面（盖住各出口在方框内重叠的部分）+ 斑马线；Y 型分叉不需要 */
  buildPad(jn) {
    const group = new THREE.Group();
    this.scene.add(group);
    if (jn.type === 'fork') return group;
    const biome = jn.options[0].path.biomeAt(jn.sEntry - 1);
    const h = jn.h0, cx = jn.x + Math.sin(h) * J.box, cz = jn.z + Math.cos(h) * J.box;
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(2 * J.box + 0.6, 2 * J.box + 0.6).rotateX(-Math.PI / 2), mat((PAL[biome] ?? PAL.city).asphalt));
    pad.position.set(cx, 0.045, cz);
    pad.rotation.y = h;
    pad.receiveShadow = true;
    pad.userData.ownGeo = true;
    group.add(pad);

    // 每个出口和来路的边缘画一排斑马线
    const stripe = new THREE.PlaneGeometry(0.6, 2.4).rotateX(-Math.PI / 2);
    const holder = new THREE.Mesh(stripe, mat(0xf2f2ea));
    holder.visible = false;
    holder.userData.ownGeo = true; // 由它负责释放共享的斑马线几何体
    group.add(holder);
    const sm = mat(0xf2f2ea);
    for (const turn of jn.options.map((o) => o.turn).concat([Math.PI])) {
      const ang = h + turn, ex = cx + Math.sin(ang) * (J.box - 1.6), ez = cz + Math.cos(ang) * (J.box - 1.6);
      for (let k = -5; k <= 5; k++) {
        const s = new THREE.Mesh(stripe, sm);
        s.position.set(ex + Math.cos(ang) * k * 1.25, 0.06, ez - Math.sin(ang) * k * 1.25);
        s.rotation.y = ang;
        group.add(s);
      }
    }
    return group;
  }

  dispose(group) {
    group.traverse((o) => {
      if (o.userData.ownGeo) o.geometry.dispose();
      if (o.isInstancedMesh) o.dispose();
    });
    this.scene.remove(group);
  }
}
