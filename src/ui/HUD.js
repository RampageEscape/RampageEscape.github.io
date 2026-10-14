import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { t, applyStatic, toggleLang, onLangChange } from '../i18n.js';

const $ = (id) => document.getElementById(id);
const v = new THREE.Vector3();

export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'), score: $('score'), distance: $('distance'), stars: $('stars'),
      hp: $('hp-fill'), bust: $('bust-fill'), combo: $('combo'), banner: $('banner'), shields: $('shields'),
      dash: $('dash-btn'), fire: $('fire-btn'), popups: $('popups'), flash: $('flash'), lang: $('lang-btn'),
      progress: $('progress'), pgFill: document.querySelector('#progress .pg-fill'), pgText: document.querySelector('#progress .pg-text'),
      roadblock: $('roadblock'), rbLanes: document.querySelector('#roadblock .rb-lanes'),
      junction: $('junction'), jnTitle: document.querySelector('#junction .jn-title'), jnOptions: document.querySelector('#junction .jn-options'),
      title: $('title'), levels: $('levels'), levelGrid: $('level-grid'), upgrade: $('upgrade'), upgradeCards: $('upgrade-cards'),
      complete: $('complete'), cStars: $('complete-stars'), cGoals: $('complete-goals'), cStats: $('complete-stats'), cNext: $('complete-next'),
      over: $('gameover'), reason: $('over-reason'), stats: $('over-stats'), best: $('best'),
    };
    const on = (id, fn) => $(id).addEventListener('click', fn);
    on('mode-levels', () => this.onOpenLevels?.());
    on('mode-endless', () => this.onEndless?.());
    on('levels-back', () => this.showTitle());
    on('retry-btn', () => this.onRetry?.());
    on('over-menu', () => this.onMenu?.());
    on('complete-next', () => this.onNextLevel?.());
    on('complete-retry', () => this.onRetry?.());
    on('complete-menu', () => this.onMenu?.());
    const press = (el, fn) => el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
    press(this.el.dash, () => this.onDash?.());
    press(this.el.fire, () => this.onFire?.());
    this.el.lang.addEventListener('click', () => toggleLang());
    this.lastStars = -1;
    this.bannerTimer = 0;
    this.bannerKey = null;
    this.overData = null;
    this.screen = 'title';

    applyStatic();
    // 切换语言时，把正在显示的动态文字也重新渲染
    onLangChange(() => {
      if (this.overData) this.renderGameOver();
      if (this.bannerKey) this.el.banner.textContent = t(this.bannerKey);
      if (this.screen === 'levels') this.renderLevels();
      if (this.screen === 'upgrade') this.renderUpgrade();
      if (this.screen === 'complete') this.renderComplete();
      this.lastDistance = -1;
      this.jnKey = null;
    });
  }

  /** 只显示一个全屏界面（null = 都不显示，正在游戏） */
  setScreen(name) {
    this.screen = name;
    for (const k of ['title', 'levels', 'upgrade', 'complete', 'over']) this.el[k].classList.toggle('hidden', k !== name);
    this.el.hud.classList.toggle('hidden', !(name === null || name === 'upgrade'));
    // 语言按钮只在菜单类界面显示，游戏中隐藏避免误触
    this.el.lang.classList.toggle('hidden', !['title', 'levels', 'complete', 'over'].includes(name));
  }

  showTitle() {
    this.setScreen('title');
  }

  /** 关卡选择：progress = { unlocked, stars: { [id]: n } } */
  showLevels(levels, progress) {
    this.levelData = { levels, progress };
    this.setScreen('levels');
    this.renderLevels();
  }

  renderLevels() {
    const { levels, progress } = this.levelData, grid = this.el.levelGrid;
    grid.innerHTML = '';
    for (const lv of levels) {
      const locked = lv.id > progress.unlocked, stars = progress.stars[lv.id] ?? 0;
      const b = document.createElement('button');
      b.className = 'level-card' + (locked ? ' locked' : '');
      b.disabled = locked;
      b.innerHTML = `<span class="lv-num">${t('levelN', { n: lv.id })}</span><span class="lv-name">${t('level' + lv.id)}</span>`
        + `<span class="lv-meta">${locked ? t('locked') : t('levelLen', { d: lv.length })}</span>`
        + `<span class="lv-stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span>`;
      b.addEventListener('click', () => this.onPickLevel?.(lv));
      grid.appendChild(b);
    }
  }

  showPlaying() {
    this.setScreen(null);
    this.lastStars = -1;
    this.lastDistance = -1;
    this.overData = null;
    this.showRoadblock(null);
    this.el.junction.classList.add('hidden');
    this.jnKey = null;
  }

  /** 改装站：三张升级卡，点一张就应用 */
  showUpgrade(cards) {
    this.upgradeData = cards;
    this.setScreen('upgrade');
    this.renderUpgrade();
  }

  renderUpgrade() {
    const box = this.el.upgradeCards;
    box.innerHTML = '';
    for (const c of this.upgradeData) {
      const b = document.createElement('button');
      b.className = 'up-card' + (c.id === 'evolve' ? ' evolve' : '');
      b.innerHTML = `<span class="up-icon">${c.icon}</span><span class="up-name">${c.name()}</span><span class="up-desc">${c.desc()}</span>`
        + (c.level ? `<span class="up-level">${t('upLevel', { n: c.level })}</span>` : '');
      b.addEventListener('click', () => this.onPickUpgrade?.(c.id));
      box.appendChild(b);
    }
  }

  /** 过关画面：data = { stars, goals: [{ key, vars, done }], score, kills, hasNext } */
  showComplete(data) {
    this.completeData = data;
    this.setScreen('complete');
    this.renderComplete();
  }

  renderComplete() {
    const d = this.completeData;
    this.el.cStars.innerHTML = [0, 1, 2].map((i) => `<span class="${i < d.stars ? 'on' : ''}">★</span>`).join('');
    this.el.cGoals.innerHTML = d.goals.map((g) => `<li class="${g.done ? 'done' : ''}">${g.done ? '✔' : '✘'} ${t(g.key, g.vars)}</li>`).join('');
    this.el.cStats.innerHTML = t('completeStats', { score: d.score.toLocaleString(), kills: d.kills });
    this.el.cNext.classList.toggle('hidden', !d.hasNext);
  }

  showGameOver(reason, data) {
    this.overData = { reason, ...data };
    this.renderGameOver();
    this.setScreen('over');
  }

  renderGameOver() {
    const { reason, score, distance, kills, best, bestLabel } = this.overData;
    this.el.reason.textContent = t(reason === 'BUSTED' ? 'busted' : 'wrecked');
    this.el.stats.innerHTML = t('stats', { score: score.toLocaleString(), distance, kills });
    this.el.best.textContent = bestLabel ? t(bestLabel.key, bestLabel.vars) : t('best', { best: best.toLocaleString() });
  }

  update(game, dt) {
    if (this.bannerTimer > 0 && (this.bannerTimer -= dt) <= 0) {
      this.el.banner.classList.remove('show');
      this.bannerKey = null;
    }
    if (game.state !== 'playing') return;
    const p = game.player, el = this.el;
    el.score.textContent = Math.floor(game.score).toLocaleString();
    const d = Math.floor(game.distance);
    if (d !== this.lastDistance) {
      this.lastDistance = d;
      el.distance.textContent = t('distance', { d });
      // 闯关模式：终点进度条
      const lv = game.level;
      el.progress.classList.toggle('hidden', !lv);
      if (lv) {
        el.pgFill.style.width = `${Math.min(100, (d / lv.length) * 100)}%`;
        el.pgText.textContent = t('progress', { d: Math.max(0, lv.length - d) });
      }
    }
    el.hp.style.width = `${(p.hp / p.maxHp) * 100}%`;
    el.shields.textContent = '🛡️'.repeat(p.shields);
    el.bust.style.width = `${game.bust * 100}%`;
    el.bust.parentElement.classList.toggle('active', game.bust > 0.01);
    if (game.stars !== this.lastStars) {
      this.lastStars = game.stars;
      el.stars.textContent = '★'.repeat(game.stars) + '☆'.repeat(CONFIG.spawn.maxStars - game.stars);
    }
    el.dash.style.setProperty('--charge', p.dashCharge.toFixed(3));
    el.dash.classList.toggle('ready', p.dashReady);
    el.dash.classList.toggle('active', p.isDashing);
    // 坦克才有开炮按钮
    const cannon = game.cannon;
    el.fire.classList.toggle('hidden', !cannon.active);
    if (cannon.active) {
      el.fire.style.setProperty('--charge', Math.max(0, cannon.charge).toFixed(3));
      el.fire.classList.toggle('ready', cannon.cooldown <= 0);
    }
    el.combo.textContent = game.combo > 1 ? t('combo', { n: game.combo }) : '';
  }

  /**
   * 路障预警：blocked = 被堵的车道编号数组，null = 隐藏。
   * 车道编号越大越靠屏幕左边（镜头在车后方，+X 是驾驶员左侧），所以从大到小画。
   */
  showRoadblock(blocked) {
    const key = blocked ? blocked.join(',') : '';
    if (key === this.rbKey) return;
    this.rbKey = key;
    this.el.roadblock.classList.toggle('hidden', !blocked);
    if (!blocked) return;
    let html = '';
    for (let i = CONFIG.road.lanes - 1; i >= 0; i--) {
      html += blocked.includes(i) ? '<span class="lane closed">✕</span>' : '<span class="lane open">▲</span>';
    }
    this.el.rbLanes.innerHTML = html;
  }

  /**
   * 岔路选择面板：显示每个出口的方向箭头和通往的地图，当前选择高亮。
   * 箭头按屏幕左→右排列；也可以直接点按钮选路（手机上更直观）。
   */
  showJunction(j, s) {
    const d = j && !j.committed ? Math.round(j.sEntry - s) : -1;
    const show = d > CONFIG.junction.commitBefore && d < CONFIG.junction.decisionStart;
    this.el.junction.classList.toggle('hidden', !show);
    if (!show) { this.jnKey = null; return; }
    this.el.jnTitle.textContent = t('junction', { d });
    const key = `${j.id}:${j.selected}`;
    if (key === this.jnKey) return;
    this.jnKey = key;
    const ARROW = { left: '←', forkLeft: '↖', straight: '↑', forkRight: '↗', right: '→' };
    const ORDER = ['left', 'forkLeft', 'straight', 'forkRight', 'right'];
    const opts = j.options.map((o, idx) => ({ o, idx })).sort((a, b) => ORDER.indexOf(a.o.key) - ORDER.indexOf(b.o.key));
    this.el.jnOptions.innerHTML = '';
    for (const { o, idx } of opts) {
      const b = document.createElement('button');
      b.className = 'jn-opt' + (idx === j.selected ? ' selected' : '');
      b.innerHTML = `<span class="arrow">${ARROW[o.key]}</span><span class="name">${t(o.biome)}</span>`;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onSelectRoute?.(idx);
      });
      this.el.jnOptions.appendChild(b);
    }
  }

  popup(text, worldPos, camera, big = false) {
    v.copy(worldPos).project(camera);
    const d = document.createElement('div');
    d.className = big ? 'popup big' : 'popup';
    d.textContent = text;
    d.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
    d.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
    this.el.popups.appendChild(d);
    setTimeout(() => d.remove(), 900);
  }

  flash(color, alpha) {
    const f = this.el.flash;
    f.style.transition = 'none';
    f.style.background = color;
    f.style.opacity = alpha;
    void f.offsetWidth; // 强制重排，让过渡重新开始
    f.style.transition = 'opacity 0.35s ease-out';
    f.style.opacity = 0;
  }

  /** key 是语言表里的键（例如 'city' / 'forest'） */
  banner(key) {
    this.bannerKey = key;
    this.el.banner.textContent = t(key);
    this.el.banner.classList.add('show');
    this.bannerTimer = 2.2;
  }
}
