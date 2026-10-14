import { CONFIG } from '../config.js';
import { smoothstep } from '../core/utils.js';
import { BIOMES } from './biomes.js';

const TRANSITION = CONFIG.road.transition;

// 朝向 h 的约定：前进方向 = (sin h, cos h)（世界 x, z），h 增大 = 向左转
// 车头朝 h 时，左侧法线 = (cos h, -sin h)
const fwdX = (h) => Math.sin(h), fwdZ = (h) => Math.cos(h);
const leftX = (h) => Math.cos(h), leftZ = (h) => -Math.sin(h);

// 蜿蜒公路的横向摆动（和原来的曲线公式一样），两端淡出，保证路段接口处是笔直的
function wiggle(p, s) {
  if (!p.amp) return 0;
  const u = s - p.s0, len = p.s1 - p.s0, T = Math.min(TRANSITION, len / 3);
  const fade = smoothstep(0, T, u) * (1 - smoothstep(len - T, len, u));
  return p.amp * fade * (16 * Math.sin(s * 0.011) + 7 * Math.sin(s * 0.027 + 1.3));
}

/**
 * 一条路线 = 按里程 s 首尾相接的路段（piece）：
 *   line：从 (x0, z0) 出发、朝向 h 的直线，按地图做左右蜿蜒（两端淡出）
 *   arc ：路口里的圆弧转弯（45° / 90°），dir = +1 左转、-1 右转
 * 路段对象创建后不再修改，所以 clone() 可以共享它们——路口的候选路线就是“主路线 + 不同出口”。
 */
export class Path {
  constructor(pieces = [], junctions = []) {
    this.pieces = pieces;
    this.junctions = junctions; // 这条路线经过的路口 { sEntry, boxLen, noDecor }
    this.hint = 0; // 上次查询的路段下标（查询基本是单调的，先从这里找）
  }

  clone() {
    return new Path([...this.pieces], [...this.junctions]);
  }

  get length() {
    return this.pieces.length ? this.pieces[this.pieces.length - 1].s1 : 0;
  }

  /** 路线终点的状态（新路段从这里接上） */
  endState() {
    if (!this.pieces.length) return { s: 0, x: 0, z: 0, h: 0 };
    const p = this.pieces[this.pieces.length - 1];
    const o = this.sample(p.s1, 0, {});
    // 终点朝向取“基线朝向”，不含蜿蜒（蜿蜒在两端已经淡出为 0）
    return { s: p.s1, x: o.x, z: o.z, h: p.kind === 'line' ? p.h : p.h0 + p.dir * (p.s1 - p.s0) / p.r };
  }

  addLine(len, biome, { wiggleOn = true } = {}) {
    const e = this.endState();
    this.pieces.push({ kind: 'line', s0: e.s, s1: e.s + len, x0: e.x, z0: e.z, h: e.h, biome, amp: wiggleOn ? BIOMES[biome].curve : 0 });
    return this;
  }

  addArc(turn, radius, biome) {
    const e = this.endState(), dir = Math.sign(turn) || 1;
    const len = Math.abs(turn) * radius;
    // 圆心在起点的左侧（左转）或右侧（右转）radius 处
    const cx = e.x + dir * radius * leftX(e.h), cz = e.z + dir * radius * leftZ(e.h);
    this.pieces.push({ kind: 'arc', s0: e.s, s1: e.s + len, cx, cz, r: radius, h0: e.h, dir, biome });
    return this;
  }

  /** 丢掉玩家身后很远的路段，避免数组无限增长 */
  trimBefore(s) {
    let n = 0;
    while (n < this.pieces.length - 1 && this.pieces[n].s1 < s) n++;
    if (n) {
      this.pieces = this.pieces.slice(n);
      this.hint = 0;
    }
  }

  pieceAt(s) {
    const ps = this.pieces;
    let i = Math.min(this.hint, ps.length - 1);
    while (i > 0 && s < ps[i].s0) i--;
    while (i < ps.length - 1 && s >= ps[i].s1) i++;
    this.hint = i;
    return ps[i];
  }

  /**
   * 里程 s、横向偏移 lat → 世界坐标 { x, z, h }。
   * 超出路线终点时沿最后的朝向直线外推（路口还没选定时，前方的车辆用得到）。
   */
  sample(s, lat = 0, out = {}) {
    const p = this.pieceAt(s);
    if (!p) return Object.assign(out, { x: 0, z: lat, h: 0 });
    if (p.kind === 'line') {
      const u = s - p.s0, w = wiggle(p, s) + lat;
      out.x = p.x0 + fwdX(p.h) * u + leftX(p.h) * w;
      out.z = p.z0 + fwdZ(p.h) * u + leftZ(p.h) * w;
      out.h = p.h + (p.amp ? Math.atan(wiggle(p, s + 0.5) - wiggle(p, s - 0.5)) : 0);
      return out;
    }
    // 圆弧：转过的角度 = 弧长 / 半径
    const u = Math.min(s, p.s1) - p.s0, h = p.h0 + (p.dir * u) / p.r;
    const extra = s - Math.min(s, p.s1); // 超出终点的部分沿切线外推
    out.x = p.cx - p.dir * p.r * leftX(h) + leftX(h) * lat + fwdX(h) * extra;
    out.z = p.cz - p.dir * p.r * leftZ(h) + leftZ(h) * lat + fwdZ(h) * extra;
    out.h = h;
    return out;
  }

  heading(s) {
    return this.sample(s, 0, {}).h;
  }

  biomeAt(s) {
    return this.pieceAt(s)?.biome ?? 'city';
  }

  /** [s0, s1] 内是否完全笔直（用来决定能不能放城市的装饰十字路口） */
  isStraight(s0, s1) {
    for (const p of this.pieces) {
      if (p.s1 <= s0 || p.s0 >= s1) continue;
      if (p.kind !== 'line' || p.amp) return false;
    }
    return true;
  }

  /** 与路口区域（入口前 before 米到出口后 after 米）是否重叠 */
  nearJunction(s0, s1, before = 0, after = 0) {
    return this.junctions.some((j) => s1 > j.sEntry - before && s0 < j.sEntry + j.boxLen + after);
  }
}
