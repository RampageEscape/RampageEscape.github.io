/**
 * 长期成长：金币、每局任务、车库永久升级。存档在 localStorage。
 *
 * 金币来源：撞毁警车、擦边、吃道具、跑距离、完成任务（都乘以车库的“金币加成”）。
 * 任务：每局随机 3 个；目标会随着累计完成的任务数慢慢变难。
 * 车库：用金币买永久升级，每局开始时套用到玩家身上。
 */
const SAVE_KEY = 'rampage-escape.save';

export const GARAGE = {
  hp: { icon: '❤️', cost: [150, 300, 600, 1000, 1600] },
  shield: { icon: '🛡️', cost: [400, 1200] },
  nitro: { icon: '⚡', cost: [150, 300, 600, 1000, 1600] },
  rampage: { icon: '🔥', cost: [300, 800, 1600] },
  coins: { icon: '🪙', cost: [200, 400, 800, 1300, 2000] },
};

const MISSIONS = [
  { id: 'kills', base: 8, step: 3, reward: 60 },
  { id: 'nearMiss', base: 6, step: 3, reward: 60 },
  { id: 'jumps', base: 2, step: 1, reward: 50 },
  { id: 'pickups', base: 4, step: 2, reward: 40 },
  { id: 'distance', base: 1500, step: 500, reward: 70 },
  { id: 'rampage', base: 1, step: 1, reward: 80 },
  { id: 'dashCombo', base: 3, step: 1, reward: 90 },
  { id: 'junctions', base: 3, step: 1, reward: 50 },
  { id: 'stunts', base: 2, step: 1, reward: 70 },
  { id: 'barrels', base: 3, step: 2, reward: 60 },
  { id: 'challenges', base: 1, step: 1, reward: 90 },
];

export class Progression {
  constructor() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { /* 隐私模式 */ }
    this.data = { coins: 0, garage: {}, missionsDone: 0, ...(d || {}) };
    this.missions = [];
    this.runCoins = 0;
  }

  save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.data)); } catch { /* ignore */ }
  }

  get coins() { return this.data.coins; }
  level(id) { return this.data.garage[id] ?? 0; }
  maxLevel(id) { return GARAGE[id].cost.length; }
  nextCost(id) { return GARAGE[id].cost[this.level(id)] ?? null; }

  buy(id) {
    const cost = this.nextCost(id);
    if (cost == null || this.data.coins < cost) return false;
    this.data.coins -= cost;
    this.data.garage[id] = this.level(id) + 1;
    this.save();
    return true;
  }

  get coinMul() { return 1 + 0.1 * this.level('coins'); }
  get rampageSeconds() { return 6 + this.level('rampage'); }

  /** 每局开始：把车库升级套用到玩家身上 */
  applyGarage(p) {
    p.stats.maxHp += 15 * this.level('hp');
    p.hp = p.stats.maxHp;
    p.shields += this.level('shield');
    p.stats.dashCooldown *= Math.pow(0.92, this.level('nitro'));
  }

  /** 每局开始：抽 3 个任务，目标随累计完成数变难 */
  startRun() {
    this.runCoins = 0;
    const pool = [...MISSIONS];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const tier = Math.floor(this.data.missionsDone / 3);
    this.missions = pool.slice(0, 3).map((m) => ({ id: m.id, target: m.base + m.step * tier, reward: m.reward + 10 * tier, progress: 0, done: false }));
  }

  /** 赚金币（乘以车库加成），返回实际得到的数量 */
  earn(n) {
    const got = Math.round(n * this.coinMul * (this.rewardMul ?? 1));
    this.data.coins += got;
    this.runCoins += got;
    return got;
  }

  /**
   * 记录事件，返回这次刚完成的任务列表。
   * mode 'add' 累加（击杀、擦边……），'max' 取最大值（距离、单次冲刺连撞）
   */
  track(id, amount = 1, mode = 'add') {
    const finished = [];
    for (const m of this.missions) {
      if (m.done || m.id !== id) continue;
      m.progress = mode === 'max' ? Math.max(m.progress, amount) : m.progress + amount;
      if (m.progress >= m.target) {
        m.progress = m.target;
        m.done = true;
        this.data.missionsDone++;
        m.paid = this.earn(m.reward);
        finished.push(m);
      }
    }
    if (finished.length) this.save();
    return finished;
  }

  endRun() {
    this.save();
  }
}
