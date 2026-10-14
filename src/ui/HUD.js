import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { t, applyStatic, toggleLang, onLangChange } from '../i18n.js';

const $ = (id) => document.getElementById(id);
const v = new THREE.Vector3();

export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'), score: $('score'), distance: $('distance'), stars: $('stars'),
      hp: $('hp-fill'), bust: $('bust-fill'), combo: $('combo'), banner: $('banner'),
      dash: $('dash-btn'), popups: $('popups'), flash: $('flash'), lang: $('lang-btn'),
      title: $('title'), over: $('gameover'), reason: $('over-reason'), stats: $('over-stats'), best: $('best'),
    };
    $('start-btn').addEventListener('click', () => this.onStart?.());
    $('retry-btn').addEventListener('click', () => this.onStart?.());
    this.el.dash.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onDash?.();
    });
    this.el.lang.addEventListener('click', () => toggleLang());
    this.lastStars = -1;
    this.bannerTimer = 0;
    this.bannerKey = null;
    this.overData = null;

    applyStatic();
    // 切换语言时，把正在显示的动态文字也重新渲染
    onLangChange(() => {
      if (this.overData) this.renderGameOver();
      if (this.bannerKey) this.el.banner.textContent = t(this.bannerKey);
      this.lastDistance = -1;
    });
  }

  showPlaying() {
    this.el.title.classList.add('hidden');
    this.el.over.classList.add('hidden');
    this.el.lang.classList.add('hidden'); // 游戏中隐藏，避免滑动时误触
    this.el.hud.classList.remove('hidden');
    this.lastStars = -1;
    this.lastDistance = -1;
    this.overData = null;
  }

  showGameOver(reason, data) {
    this.overData = { reason, ...data };
    this.renderGameOver();
    this.el.hud.classList.add('hidden');
    this.el.over.classList.remove('hidden');
    this.el.lang.classList.remove('hidden');
  }

  renderGameOver() {
    const { reason, score, distance, kills, best } = this.overData;
    this.el.reason.textContent = t(reason === 'BUSTED' ? 'busted' : 'wrecked');
    this.el.stats.innerHTML = t('stats', { score: score.toLocaleString(), distance, kills });
    this.el.best.textContent = t('best', { best: best.toLocaleString() });
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
    }
    el.hp.style.width = `${(p.hp / CONFIG.player.maxHp) * 100}%`;
    el.bust.style.width = `${game.bust * 100}%`;
    el.bust.parentElement.classList.toggle('active', game.bust > 0.01);
    if (game.stars !== this.lastStars) {
      this.lastStars = game.stars;
      el.stars.textContent = '★'.repeat(game.stars) + '☆'.repeat(CONFIG.spawn.maxStars - game.stars);
    }
    el.dash.style.setProperty('--charge', p.dashCharge.toFixed(3));
    el.dash.classList.toggle('ready', p.dashReady);
    el.dash.classList.toggle('active', p.isDashing);
    el.combo.textContent = game.combo > 1 ? t('combo', { n: game.combo }) : '';
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
