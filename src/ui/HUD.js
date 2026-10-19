import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { t, applyStatic, toggleLang, onLangChange } from '../i18n.js';
import { GARAGE } from '../systems/Progression.js';
import { DIFFICULTY_IDS } from '../data/difficulty.js';

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
      coins: $('coins'), missions: $('missions'), fever: $('fever-fill'), rampageFx: $('rampage-fx'),
      garage: $('garage'), garageGrid: $('garage-grid'), garageCoins: $('garage-coins'), titleCoins: $('title-coins'),
      cCoins: $('complete-coins'), overCoins: $('over-coins'),
      pause: $('pause'), diffRow: $('difficulty-row'), speedLv: $('speed-lv'),
      vsHud: $('vs-hud'), countdown: $('countdown'), versusSetup: $('versus-setup'), versusOver: $('versus-over'),
      vsWinner: $('vs-winner'), vsReason: $('vs-reason'), vsResults: $('vs-results'),
      vsDash: [$('vs-dash-0'), $('vs-dash-1')], vsFire: [$('vs-fire-0'), $('vs-fire-1')],
    };
    // 双人对战：左右两块面板
    this.vsPanels = [0, 1].map((i) => {
      const root = $('vs-p' + i), q = (c) => root.querySelector(c);
      return { score: q('.vs-score'), meta: q('.vs-meta'), hp: q('.vs-hp'), bust: q('.vs-bust'), shields: q('.vs-shields') };
    });
    this.versus = false;
    const on = (id, fn) => $(id).addEventListener('click', fn);
    on('mode-levels', () => this.onOpenLevels?.());
    on('mode-endless', () => this.onEndless?.());
    on('levels-back', () => this.showTitle());
    on('open-garage', () => this.showGarage());
    on('garage-back', () => this.showTitle());
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
    press($('pause-btn'), () => this.onPause?.());
    on('pause-resume', () => this.onResume?.());
    on('pause-restart', () => this.onRestart?.());
    on('pause-menu', () => this.onMenu?.());
    on('pause-music', () => { this.onToggleMusic?.(); this.renderPause(); });
    on('pause-sfx', () => { this.onToggleSfx?.(); this.renderPause(); });
    on('pause-camera', () => { this.onToggleCamera?.(); this.renderPause(); });
    on('mode-versus', () => this.setScreen('versusSetup'));
    on('versus-start', () => this.onStartVersus?.());
    on('versus-back', () => this.showTitle());
    on('vs-again', () => this.onVersusAgain?.());
    on('vs-menu', () => this.onMenu?.());
    press($('vs-pause'), () => this.onPause?.());
    for (const id of ['cam-btn', 'vs-cam']) press($(id), () => this.onCycleCamera?.());
    this.el.vsDash.forEach((b, i) => press(b, () => this.onVsDash?.(i)));
    this.el.vsFire.forEach((b, i) => press(b, () => this.onVsFire?.(i)));
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
      if (this.screen === 'garage') this.renderGarage();
      if (this.screen === 'title') this.showTitle();
      if (this.screen === 'pause') this.renderPause();
      this.setCamLabel(this.settings?.().camera);
      if (this.screen === 'versusOver') this.renderVersusOver();
      if (this.missionList) this.showMissions(this.missionList);
      this.lastDistance = -1;
      this.lastLv = -1;
      this.jnKey = null;
    });
  }

  /** 只显示一个全屏界面（null = 都不显示，正在游戏） */
  setScreen(name) {
    this.screen = name;
    for (const k of ['title', 'levels', 'upgrade', 'complete', 'over', 'garage', 'pause', 'versusSetup', 'versusOver']) this.el[k].classList.toggle('hidden', k !== name);
    const inGame = name === null || name === 'upgrade' || name === 'pause';
    this.el.hud.classList.toggle('hidden', !inGame || this.versus);
    this.el.vsHud.classList.toggle('hidden', !inGame || !this.versus);
    // 语言按钮只在菜单类界面显示，游戏中隐藏避免误触
    this.el.lang.classList.toggle('hidden', !['title', 'levels', 'complete', 'over', 'garage', 'versusSetup', 'versusOver'].includes(name));
    if (name !== null) this.setRampage(false);
  }

  showTitle() {
    this.setScreen('title');
    if (this.prog) this.el.titleCoins.textContent = t('garageCoins', { n: this.prog.coins.toLocaleString() });
    // 难度选择
    const cur = this.difficulty?.() ?? 'normal', row = this.el.diffRow;
    row.innerHTML = `<div class="diff-label">${t('difficulty')}</div>`;
    const chips = document.createElement('div');
    chips.className = 'diff-chips';
    for (const id of DIFFICULTY_IDS) {
      const b = document.createElement('button');
      b.className = `diff-chip ${id}` + (id === cur ? ' on' : '');
      b.textContent = t('diff_' + id);
      b.addEventListener('click', () => this.onDifficulty?.(id));
      chips.appendChild(b);
    }
    row.appendChild(chips);
    const hint = document.createElement('div');
    hint.className = 'diff-hint';
    hint.textContent = t('diffHint_' + cur);
    row.appendChild(hint);
  }

  showPause() {
    this.setScreen('pause');
    this.renderPause();
  }

  renderPause() {
    const s = this.settings?.() ?? {};

    $('pause-music').textContent = t(s.music === false ? 'musicOff' : 'musicOn');
    $('pause-sfx').textContent = t(s.sfx === false ? 'sfxOff' : 'sfxOn');
    $('pause-camera').textContent = t({ chase: 'camChase', first: 'camFirst', iso: 'camIso' }[s.camera] ?? 'camChase');
    this.setCamLabel(s.camera);
  }

  // ---------------- 车库 ----------------
  showGarage() {
    this.setScreen('garage');
    this.renderGarage();
  }

  renderGarage() {
    const pr = this.prog;
    this.el.garageCoins.textContent = t('garageCoins', { n: pr.coins.toLocaleString() });
    const grid = this.el.garageGrid;
    grid.innerHTML = '';
    for (const id of Object.keys(GARAGE)) {
      const lv = pr.level(id), max = pr.maxLevel(id), cost = pr.nextCost(id);
      const card = document.createElement('div');
      card.className = 'g-card';
      card.innerHTML = `<span class="g-icon">${GARAGE[id].icon}</span><span class="g-name">${t('g_' + id)}</span>`
        + `<span class="g-desc">${t('g_' + id + '_desc')}</span>`
        + `<span class="g-dots">${'●'.repeat(lv)}${'○'.repeat(max - lv)}</span>`;
      const b = document.createElement('button');
      b.className = 'g-buy';
      b.textContent = cost == null ? t('maxed') : t('buy', { c: cost });
      b.disabled = cost == null || pr.coins < cost;
      b.addEventListener('click', () => { if (pr.buy(id)) this.renderGarage(); });
      card.appendChild(b);
      grid.appendChild(card);
    }
  }

  // ---------------- 任务 / 暴走 ----------------
  missionText(m) {
    return t('mission_' + m.id, { n: m.target.toLocaleString() });
  }

  showMissions(list) {
    this.missionList = list;
    this.el.missions.innerHTML = list.map((m) => {
      const prog = m.id === 'distance' ? `${Math.floor(m.progress)}/${m.target}` : `${m.progress}/${m.target}`;
      return `<li class="${m.done ? 'done' : ''}">${m.done ? '✔' : '▸'} ${this.missionText(m)} <b>${m.done ? '' : prog}</b></li>`;
    }).join('');
  }

  setRampage(on) {
    this.el.rampageFx.classList.toggle('hidden', !on);
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
    this.lastLv = -1;
    this.overData = null;
    this.showRoadblock(null);
    this.showOncoming(null);
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
    this.el.cCoins.textContent = d.coins ? t('coinLine', { n: d.coins.run, t: d.coins.total }) : '';
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
    const c = this.overData.coins;
    this.el.overCoins.textContent = c ? t('coinLine', { n: c.run, t: c.total }) : '';
  }

  update(game, dt) {
    if (this.bannerTimer > 0 && (this.bannerTimer -= dt) <= 0) {
      this.el.banner.classList.remove('show');
      this.bannerKey = null;
    }
    if (this.versus) return this.updateVersus(game);
    if (game.state !== 'playing') return;
    const p = game.player, el = this.el;
    el.score.textContent = Math.floor(game.score).toLocaleString();
    if (game.speedLevel !== this.lastLv) {
      this.lastLv = game.speedLevel;
      el.speedLv.textContent = t('speedLv', { n: game.speedLevel });
      el.speedLv.classList.remove('bump');
      void el.speedLv.offsetWidth;
      el.speedLv.classList.add('bump');
    }
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
    el.fever.style.width = `${(p.rampage > 0 ? 1 : game.fever) * 100}%`;
    el.fever.parentElement.classList.toggle('full', p.rampage > 0);
    el.coins.textContent = `🪙 ${this.prog.runCoins}`;
    el.shields.textContent = '🛡️'.repeat(p.shields) + (p.magnet > 0 ? '🧲' : '');
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
  showRoadblock(blocked, spikes = false) {
    const key = blocked ? blocked.join(',') + spikes : '';
    if (key === this.rbKey) return;
    this.rbKey = key;
    this.el.roadblock.classList.toggle('hidden', !blocked);
    if (!blocked) return;
    this.el.roadblock.querySelector('.rb-title').textContent = t(spikes ? 'spikeWarn' : 'roadblock');
    let html = '';
    for (let i = CONFIG.road.lanes - 1; i >= 0; i--) {
      html += blocked.includes(i) ? '<span class="lane closed">✕</span>' : '<span class="lane open">▲</span>';
    }
    this.el.rbLanes.innerHTML = html;
  }

  /** 逆行来车预警：lanes = 有迎面来车的车道编号（可重复），null = 隐藏 */
  showOncoming(lanes) {
    const el = $('oncoming'), key = lanes ? [...new Set(lanes)].sort().join(',') : '';
    if (key === this.ocKey) return;
    this.ocKey = key;
    el.classList.toggle('hidden', !lanes);
    if (!lanes) return;
    let html = '';
    for (let i = CONFIG.road.lanes - 1; i >= 0; i--) html += lanes.includes(i) ? '<span class="lane closed">▼</span>' : '<span class="lane">·</span>';
    el.querySelector('.oc-lanes').innerHTML = html;
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

  /** 游戏中的视角按钮文字 */
  setCamLabel(mode) {
    for (const id of ['cam-btn', 'vs-cam']) $(id).textContent = t('cam_' + (mode ?? 'chase'));
  }

  // ---------------- 双人对战 ----------------
  setVersus(on) {
    this.versus = on;
  }

  /** 每帧刷新左右两块面板 */
  updateVersus(game) {
    if (!game.players[1]) return;
    game.players.forEach((p, i) => {
      const el = this.vsPanels[i];
      el.score.textContent = Math.floor(p.score).toLocaleString();
      el.meta.textContent = t('vsMeta', { d: Math.floor(p.distance), n: game.speedLevel });
      el.hp.style.width = `${Math.max(0, (p.hp / p.maxHp) * 100)}%`;
      el.bust.style.width = `${p.bust * 100}%`;
      el.bust.parentElement.classList.toggle('active', p.bust > 0.01);
      el.shields.textContent = '🛡️'.repeat(p.shields);
      const dash = this.el.vsDash[i];
      dash.style.setProperty('--charge', p.dashCharge.toFixed(3));
      dash.classList.toggle('ready', p.dashReady);
      dash.classList.toggle('active', p.isDashing);
      const cannon = game.cannons[i], fire = this.el.vsFire[i];
      fire.classList.toggle('hidden', !cannon.active);
      if (cannon.active) {
        fire.style.setProperty('--charge', Math.max(0, cannon.charge).toFixed(3));
        fire.classList.toggle('ready', cannon.cooldown <= 0);
      }
    });
  }

  /** 开局倒数：3、2、1、GO! */
  countdown(text) {
    const c = this.el.countdown;
    c.classList.toggle('hidden', text == null);
    if (text == null) return;
    c.textContent = text;
    c.classList.remove('pop');
    void c.offsetWidth;
    c.classList.add('pop');
  }

  /** 对战结果：data = { winner: 0 | 1 | null（平手）, loser, reason, players: [{ score, distance, kills }] } */
  showVersusOver(data) {
    this.vsData = data;
    this.setScreen('versusOver');
    this.renderVersusOver();
  }

  renderVersusOver() {
    const d = this.vsData, name = (i) => t('playerN', { n: i + 1 });
    this.el.vsWinner.textContent = d.winner == null ? t('vsDraw') : t('vsWin', { p: name(d.winner) });
    this.el.vsReason.textContent = d.loser == null ? '' : t(d.reason === 'BUSTED' ? 'vsBusted' : 'vsWrecked', { p: name(d.loser) });
    this.el.vsResults.innerHTML = d.players.map((r, i) => `<div class="vs-res ${i === d.winner ? 'win' : ''}">${t('vsRes', { p: name(i), score: r.score.toLocaleString(), d: r.distance, k: r.kills })}</div>`).join('');
  }

  /** vp：分屏时这位玩家的画面区域 { x: 左边起点（0~1）, w: 宽度（0~1） } */
  popup(text, worldPos, camera, big = false, vp = null) {
    v.copy(worldPos).project(camera);
    const d = document.createElement('div');
    d.className = big ? 'popup big' : 'popup';
    d.textContent = text;
    d.style.left = `${((vp?.x ?? 0) + (v.x * 0.5 + 0.5) * (vp?.w ?? 1)) * innerWidth}px`;
    d.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
    this.el.popups.appendChild(d);
    setTimeout(() => d.remove(), 900);
  }

  /** side：分屏时只闪这位玩家那一半（0 左 / 1 右），不传 = 全屏 */
  flash(color, alpha, side = null) {
    const f = this.el.flash;
    f.style.left = side === 1 ? '50%' : '0';
    f.style.right = side === 0 ? '50%' : '0';
    f.style.transition = 'none';
    f.style.background = color;
    f.style.opacity = alpha;
    void f.offsetWidth; // 强制重排，让过渡重新开始
    f.style.transition = 'opacity 0.35s ease-out';
    f.style.opacity = 0;
  }

  /** key 是语言表里的键（例如 'city' / 'forest'），vars 是文字里的变量 */
  banner(key, vars) {
    this.bannerKey = vars ? null : key;
    this.el.banner.textContent = t(key, vars);
    this.el.banner.classList.add('show');
    this.bannerTimer = 2.2;
  }
}
