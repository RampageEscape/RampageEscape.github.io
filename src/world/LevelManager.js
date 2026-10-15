import { CONFIG } from '../config.js';
import { Road, ROAD_HALF } from './Road.js';
import { Path } from './Path.js';
import { BIOME_IDS } from './biomes.js';
import { rand } from '../core/utils.js';

const L = CONFIG.world.chunkLength;
const J = CONFIG.junction;
const QUARTER = Math.PI / 2, EIGHTH = Math.PI / 4;
const LANES = CONFIG.road.lanes;
const ORDER = ['left', 'forkLeft', 'straight', 'forkRight', 'right'];

// 每种出口：转弯角度（左正右负）+ 对应的滑动方向
const EXITS = {
  left: { turn: QUARTER, swipe: 'left' },
  straight: { turn: 0, swipe: 'up' },
  right: { turn: -QUARTER, swipe: 'right' },
  forkLeft: { turn: EIGHTH, swipe: 'left' },
  forkRight: { turn: -EIGHTH, swipe: 'right' },
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 无尽地图的路线管理：直线路段 → 路口（十字 / T 字 / Y 型分叉）→ 玩家选择 → 新路线 → ……
 *
 * 生成路口时，为每个出口各算一条完整的“候选路线”（主路线 + 转弯 + 下一段直路），
 * 每条候选路线通往不同的地图，画面上可以同时看到所有岔路。
 * 玩家在决策区内滑动选择，到达路口前一刻“提交”：被选中的候选路线变成新的主路线。
 *
 * 为了路线永远不会绕回来和自己相交，出口方向限制为 |朝向| ≤ 90°（整体一直往前走）。
 */
export class LevelManager {
  constructor() {
    this.junction = null;
    this.history = []; // 已经通过的路口（没选的岔路还在画面里，地图生成器需要继续避让）
    this.nextId = 1;
    this.pool = BIOME_IDS;
    this.onCommit = null; // (junction) => void
  }

  reset(pool = BIOME_IDS, startBiome = pool[0]) {
    this.pool = pool;
    this.junction = null;
    this.history = [];
    const path = new Path();
    path.addLine(Math.ceil(J.firstAt / L) * L, startBiome); // 路口入口对齐到区块边界
    Road.path = path;
    this.createJunction();
  }

  /** 在主路线终点生成下一个路口及其所有候选路线 */
  createJunction() {
    const main = Road.path, e = main.endState();
    const h0 = Math.round(e.h / EIGHTH) * EIGHTH;
    const ok = (k) => Math.abs(h0 + EXITS[k].turn) <= QUARTER + 1e-6;

    let type = Math.random() < J.crossChance ? 'cross' : 'fork';
    let keys = (type === 'cross' ? ['left', 'straight', 'right'] : ['forkLeft', 'forkRight']).filter(ok);
    if (keys.length < 2) {
      type = 'cross';
      keys = ['left', 'straight', 'right'].filter(ok);
    }
    if (type === 'cross' && keys.length === 2) type = 'T';

    // 每个出口分配不同的地图（地图池不够时才重复）
    const current = main.biomeAt(e.s - 1);
    let biomes = shuffle(this.pool.filter((b) => b !== current));
    if (this.pool.includes(current)) biomes.push(current);
    while (biomes.length < keys.length) biomes = biomes.concat(shuffle(this.pool));

    const id = this.nextId++;
    const options = keys.map((key, k) => {
      const biome = biomes[k], turn = EXITS[key].turn, p = main.clone();
      let boxLen;
      if (key === 'straight') {
        p.addLine(2 * J.box, biome, { wiggleOn: false });
        boxLen = 2 * J.box;
      } else if (key === 'left' || key === 'right') {
        p.addArc(turn, J.box, biome); // 圆心在路口方框的角上，正好在方框内转 90°
        boxLen = QUARTER * J.box;
      } else {
        p.addArc(turn, J.forkRadius, biome);
        boxLen = EIGHTH * J.forkRadius + J.forkClear; // Y 型分叉：两条路完全分开前都算路口区域
      }
      const target = Math.ceil((p.length + rand(J.minGap, J.maxGap)) / L) * L;
      p.addLine(target - p.length, biome);
      p.junctions.push({ id, sEntry: e.s, boxLen, type });
      // 采样这条出口的路面，地图生成器用来避免把树、楼放到别的岔路上
      const samples = [];
      for (let s = e.s; s < e.s + boxLen + J.blockAfter; s += 3) samples.push(p.sample(s, 0, {}));
      return { key, biome, turn, path: p, boxLen, samples };
    });

    const straightIdx = options.findIndex((o) => o.key === 'straight');
    this.junction = {
      id, type, options,
      sEntry: e.s, x: e.x, z: e.z, h0,
      selected: straightIdx >= 0 ? straightIdx : Math.floor(Math.random() * options.length),
      committed: false,
    };
  }

  /** 决策区：路口前 decisionStart 米到 commitBefore 米 */
  inDecisionZone(s) {
    const j = this.junction;
    return !!j && !j.committed && s > j.sEntry - J.decisionStart && s < j.sEntry - J.commitBefore;
  }

  /**
   * 按车道选出口：出口按屏幕从左到右排列，玩家所在车道决定走哪个出口。
   *   3 个出口：最左车道 → 左转，中间两条 → 直走，最右车道 → 右转
   *   2 个出口：左边两条 → 左边出口，右边两条 → 右边出口
   * 车道编号越大越靠左（镜头在车后方，+lat 是左侧）。
   */
  optionForLane(lane) {
    const j = this.junction, opts = this.screenOrder();
    const fromLeft = LANES - 1 - lane;
    if (opts.length === 3) return opts[fromLeft === 0 ? 0 : fromLeft === LANES - 1 ? 2 : 1];
    return opts[fromLeft < LANES / 2 ? 0 : 1];
  }

  /** 当前路口的出口下标，按屏幕从左到右排序 */
  screenOrder() {
    const j = this.junction;
    return j.options.map((o, i) => i).sort((a, b) => ORDER.indexOf(j.options[a].key) - ORDER.indexOf(j.options[b].key));
  }

  /** 每帧调用：决策区内按玩家车道自动选出口（玩家点过面板按钮就以按钮为准，直到再换车道） */
  followLane(lane, s) {
    if (!this.inDecisionZone(s)) return;
    const j = this.junction;
    if (j.manual && j.manualLane === lane) return;
    j.manual = false;
    j.selected = this.optionForLane(lane);
  }

  select(idx, lane) {
    const j = this.junction;
    if (!j || j.committed || !j.options[idx]) return;
    j.selected = idx;
    j.manual = true;
    j.manualLane = lane;
  }

  update(playerS) {
    const j = this.junction;
    if (j && !j.committed && playerS >= j.sEntry - J.commitBefore) this.commit();
    Road.path.trimBefore(playerS - 400);
    this.history = this.history.filter((h) => playerS < h.sEntry + J.keepAfter);
  }

  /** 提交选择：选中的候选路线成为主路线，并马上生成下一个路口 */
  commit() {
    const j = this.junction;
    j.committed = true;
    j.chosen = j.selected;
    Road.path = j.options[j.chosen].path;
    Road.path.trimBefore(j.sEntry - 400); // 先裁掉旧路段，否则下一批候选路线会复制整段历史
    this.history.push(j);
    this.onCommit?.(j);
    this.createJunction();
  }

  /** 当前和最近的所有路口（地图生成器避让用） */
  get activeJunctions() {
    return this.junction ? [...this.history, this.junction] : this.history;
  }
}

export const JUNCTION_ROAD_CLEARANCE = ROAD_HALF + 2.5;
