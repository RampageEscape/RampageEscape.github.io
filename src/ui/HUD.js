import * as THREE from 'three';
import { CONFIG } from '../config.js';

const $ = (id) => document.getElementById(id);
const v = new THREE.Vector3();

export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'), score: $('score'), distance: $('distance'), stars: $('stars'),
      hp: $('hp-fill'), bust: $('bust-fill'), combo: $('combo'), banner: $('banner'),
      dash: $('dash-btn'), popups: $('popups'), flash: $('flash'),
      title: $('title'), over: $('gameover'), reason: $('over-reason'), stats: $('over-stats'), best: $('best'),
    };
    $('start-btn').addEventListener('click', () => this.onStart?.());
    $('retry-btn').addEventListener('click', () => this.onStart?.());
    this.el.dash.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onDash?.();
    });
    this.lastStars = -1;
    this.bannerTimer = 0;
  }

  showPlaying() {
    this.el.title.classList.add('hidden');
    this.el.over.classList.add('hidden');
    this.el.hud.classList.remove('hidden');
    this.lastStars = -1;
  }

  showGameOver(reason, { score, distance, kills, best }) {
    this.el.hud.classList.add('hidden');
    this.el.reason.textContent = reason === 'BUSTED' ? '被捕了！BUSTED' : '车毁了！WRECKED';
    this.el.stats.innerHTML = `得分 <b>${score}</b><br>距离 ${distance} m · 摧毁警车 ${kills}`;
    this.el.best.textContent = `最高分 ${best}`;
    this.el.over.classList.remove('hidden');
  }

  update(game, dt) {
    if (this.bannerTimer > 0 && (this.bannerTimer -= dt) <= 0) this.el.banner.classList.remove('show');
    if (game.state !== 'playing') return;
    const p = game.player, el = this.el;
    el.score.textContent = Math.floor(game.score).toLocaleString();
    el.distance.textContent = `${Math.floor(game.distance)} m`;
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
    el.combo.textContent = game.combo > 1 ? `连击 x${game.combo}` : '';
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

  banner(text) {
    this.el.banner.textContent = text;
    this.el.banner.classList.add('show');
    this.bannerTimer = 2.2;
  }
}
