import { CONFIG } from '../config.js';
import { Road } from '../world/Road.js';
import { t } from '../i18n.js';
import { rand, randInt } from '../core/utils.js';

/**
 * 限时挑战：每隔 40 秒左右随机来一个，右上角显示目标、进度和倒计时。
 *   cashVan  抢劫运钞车：前方出现金色运钞车，撞它 3 次（冲刺一次就爆）→ 金币喷泉
 *   frenzy   清剿警车：警车一下子多很多，限时撞毁 5 辆
 *   nearMiss 擦边狂人：限时擦边闪过 6 辆车
 *   coinRush 金币狂潮：路上铺满金币，限时吃 40 枚
 *   stunts   空中特技：前方连放几个跳台，飞起来滑动做 3 个特技
 * 成功：大量分数 + 金币 + 一层护盾 + 暴走能量；失败没有惩罚。
 */
const DEFS = {
  cashVan: { icon: '💰', time: 30, goal: 1, reward: 3000, coins: 30, event: 'van' },
  frenzy: { icon: '🚓', time: 25, goal: 5, reward: 2500, coins: 25, event: 'kill' },
  nearMiss: { icon: '😱', time: 20, goal: 6, reward: 2000, coins: 20, event: 'nearMiss' },
  coinRush: { icon: '🪙', time: 18, goal: 40, reward: 2000, coins: 20, event: 'coin' },
  stunts: { icon: '🤸', time: 30, goal: 3, reward: 3000, coins: 25, event: 'stunt' },
};
const C = CONFIG.thrills;

export class Challenges {
  constructor(game) {
    this.game = game;
    const el = document.createElement('div');
    el.id = 'challenge';
    el.className = 'hidden';
    el.innerHTML = '<div class="ch-title"></div><div class="ch-goal"></div><div class="ch-row"><span class="ch-count"></span><div class="ch-bar"><div class="ch-fill"></div></div></div>';
    document.getElementById('hud').appendChild(el);
    this.el = { root: el, title: el.querySelector('.ch-title'), goal: el.querySelector('.ch-goal'), count: el.querySelector('.ch-count'), fill: el.querySelector('.ch-fill') };
    this.reset();
  }

  reset() {
    this.active = null;
    this.timer = C.challengeFirst;
    this.last = null;
    this.el.root.classList.add('hidden');
  }

  get enabled() {
    const g = this.game;
    return g.state === 'playing' && !g.versus;
  }

  update(dt) {
    if (!this.enabled) return;
    const a = this.active;
    if (!a) {
      if ((this.timer -= dt) <= 0) this.start();
      return;
    }
    a.time -= dt;
    if (a.id === 'cashVan') this.updateVan(a, dt);
    if (a.time <= 0) return this.finish(false);
    this.render();
  }

  /** 挑一个当前路况能做的挑战（海上没有运钞车和跳台） */
  start() {
    const g = this.game, p = g.player, z = p.z;
    const sea = Road.path.hasBiome(z, z + 400, 'sea');
    const busy = g.levels.junction && !g.levels.junction.committed && g.levels.junction.sEntry - z < 400;
    const options = Object.keys(DEFS).filter((id) => id !== this.last && !(sea && (id === 'cashVan' || id === 'stunts')) && !(busy && id === 'stunts'));
    const id = options[randInt(0, options.length - 1)];
    const def = DEFS[id];
    this.active = { id, def, time: def.time, count: 0 };
    this.last = id;
    if (id === 'cashVan') {
      this.active.van = g.spawner.spawnCashVan(z + 110, p.speed * 0.75);
      g.audio.whistle?.(0.6);
    } else if (id === 'frenzy') {
      g.spawner.frenzy = def.time;
      g.audio.alert();
    } else if (id === 'coinRush') {
      g.coins.rush = def.time;
      g.coins.nextZ = Math.min(g.coins.nextZ, z + 60);
    } else if (id === 'stunts') {
      // 前方连放 4 个跳台（避开路障、码头）
      let placed = 0;
      for (let s = z + 110; s < z + 560 && placed < 4; s += rand(80, 120)) {
        if (Road.isWater(s) || Road.isWater(s + 30) || g.spawner.inBarricadeZone(s) || s > (g.spawner.spawnLimit ?? Infinity)) continue;
        g.features.addRamp(s, randInt(0, CONFIG.road.lanes - 1));
        placed++;
      }
    }
    g.audio.mission();
    g.hud.banner('ch_' + id);
    this.el.root.classList.remove('hidden', 'done', 'fail');
    this.el.title.textContent = `${def.icon} ${t('ch_' + id)}`;
    this.el.goal.textContent = t('chg_' + id, { n: def.goal });
    this.render();
  }

  /** 运钞车：车速跟着玩家（比玩家慢一点，慢慢追得上），频繁变道躲你；被甩到后面太远 = 失败 */
  updateVan(a, dt) {
    const v = a.van, p = this.game.player;
    if (!v || v.type !== 'cashvan') return;
    if (!v.alive || v.state === 'wreck') return;
    if (v.removeMe || v.z < p.z - 35) return this.finish(false);
    v.hitCooldown = Math.max(0, v.hitCooldown - dt);
    const gap = v.z - p.z;
    v.cruise = p.speed * (gap > 60 ? 0.72 : gap > 20 ? 0.86 : 0.95);
    if (v.laneTimer > 2.2) v.laneTimer = rand(1.0, 2.0);
    const icon = v.mesh.userData.icon;
    if (icon) icon.position.y = v.mesh.userData.topY + 1.6 + Math.sin(performance.now() * 0.006) * 0.25;
  }

  event(kind, n = 1) {
    const a = this.active;
    if (!a || !this.enabled || a.def.event !== kind) return;
    a.count = Math.min(a.def.goal, a.count + n);
    if (a.count >= a.def.goal) this.finish(true);
  }

  finish(ok) {
    const g = this.game, a = this.active, p = g.player;
    if (!a) return;
    this.active = null;
    this.timer = rand(...C.challengeGap);
    if (a.id === 'frenzy') g.spawner.frenzy = 0;
    if (a.id === 'coinRush') g.coins.rush = 0;
    if (a.van && a.van.type === 'cashvan' && a.van.state !== 'wreck') a.van.removeMe = a.van.z < p.z; // 没撞到的运钞车：在前面就让它开走
    this.el.root.classList.add(ok ? 'done' : 'fail');
    this.render(a);
    setTimeout(() => { if (!this.active) this.el.root.classList.add('hidden'); }, 1600);
    if (ok) {
      const pts = a.def.reward;
      g.bonus(p, pts);
      g.prog.earn(a.def.coins);
      g.addFever(0.35, p);
      p.shields = Math.min(3, p.shields + 1);
      g.hud.banner('ch_done', { pts });
      g.hud.flash('#ffd84a', 0.35);
      g.audio.upgrade(true);
      g.bloomKick = Math.max(g.bloomKick, 1);
      g.feel.zoomKick += 0.05;
      g.missionEvent?.('challenges');
    } else {
      g.hud.banner('ch_fail');
    }
  }

  render(a = this.active) {
    if (!a) return;
    this.el.count.textContent = `${a.count} / ${a.def.goal}`;
    this.el.fill.style.width = `${Math.max(0, a.time / a.def.time) * 100}%`;
  }
}

