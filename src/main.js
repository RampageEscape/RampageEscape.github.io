import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Road } from './world/Road.js';
import { WorldGenerator } from './world/WorldGenerator.js';
import { Spawner } from './world/Spawner.js';
import { PlayerController } from './player/PlayerController.js';
import { SwipeInput } from './input/SwipeInput.js';
import { Effects } from './fx/Effects.js';
import { GameFeel } from './fx/GameFeel.js';
import { Snow } from './fx/Weather.js';
import { HUD } from './ui/HUD.js';
import { resolveCollisions } from './systems/Collisions.js';
import { updateSirens } from './models/Models.js';
import { clamp, damp } from './core/utils.js';
import { t } from './i18n.js';

const SKY = { city: new THREE.Color(0xd8c9b2), forest: new THREE.Color(0xdbe4e9) };

class Game {
  constructor() {
    const canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = SKY.city.clone();
    this.scene.fog = new THREE.Fog(this.scene.background, 70, 170);

    // 等距视角：正交相机 + 固定斜俯角
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    this.camOffset = new THREE.Vector3(...CONFIG.camera.offset);
    this.camTarget = new THREE.Vector3();

    this.scene.add(new THREE.HemisphereLight(0xfff3df, 0x6b5d4a, 1.5));
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    this.sunOffset = new THREE.Vector3(22, 45, -8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 1, far: 140 });
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);

    this.world = new WorldGenerator(this.scene);
    this.fx = new Effects(this.scene);
    this.feel = new GameFeel();
    this.snow = new Snow(this.scene);
    this.hud = new HUD();
    this.player = new PlayerController(this.scene, {
      onDashStart: () => { this.feel.onDashStart(); this.fx.decal('ring', this.player.mesh.position, 0.35, 7, 0x66e0ff); },
      onHit: (p, dmg) => this.onPlayerHit(dmg),
    });
    this.spawner = new Spawner(this);
    new SwipeInput(canvas, {
      onSwipe: (d) => this.state === 'playing' && this.player.handleSwipe(d),
      onDash: () => this.tryDash(),
    });
    this.hud.onStart = () => this.start();
    this.hud.onDash = () => this.tryDash();

    this.state = 'title';
    this.time = 0;
    this.best = Number(this.load('best') || 0);
    this.resetRun();
    addEventListener('resize', () => this.resize());
    this.resize();
    this.last = performance.now();
    requestAnimationFrame((t) => this.tick(t));
  }

  load(k) { try { return localStorage.getItem('rampage-escape.' + k); } catch { return null; } }
  save(k, v) { try { localStorage.setItem('rampage-escape.' + k, v); } catch { /* 隐私模式 */ } }

  resetRun() {
    this.player.reset();
    this.spawner.reset();
    this.world.reset();
    this.score = 0;
    this.distance = 0;
    this.kills = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.bust = 0;
    this.biome = Road.biomeAt(0);
    this.camTarget.set(0, 0, CONFIG.camera.lookAhead);
  }

  start() {
    this.resetRun();
    this.state = 'playing';
    this.spawner.prefill(this.player.z);
    this.hud.showPlaying();
    this.hud.banner(this.biome);
  }

  get stars() {
    const s = CONFIG.spawn;
    return clamp(1 + Math.floor(this.distance / s.starDistance) + Math.floor(this.kills / 10), 1, s.maxStars);
  }

  tryDash() {
    if (this.state === 'playing') this.player.tryDash();
  }

  // ---------------- 事件回调（由 AI / 碰撞系统触发） ----------------
  onEnemyDestroyed(enemy, power, reason) {
    if (this.state !== 'playing') return;
    this.kills++;
    this.combo++;
    this.comboTimer = CONFIG.score.comboWindow;
    const pts = Math.round((CONFIG.score[enemy.type] ?? 300) * Math.min(this.combo, 8));
    this.score += pts;
    this.hud.popup(reason === 'crash' ? t('lured', { pts }) : `+${pts}`, enemy.mesh.position, this.camera, this.combo > 2);
    this.player.extendDash();
    this.feel.onEnemyDestroyed(power, this.combo);
    this.hud.flash('#fff6d8', 0.25 + 0.1 * power);
    this.bust = Math.max(0, this.bust - 0.3);
  }

  onPropSmashed(entity, pts) {
    if (this.state !== 'playing') return;
    this.score += pts;
    this.feel.shake.add(0.12);
  }

  /** 被追尾/被侧挤（不是玩家失误）：只有轻微火花和极小的震动，不闪红、不扣血 */
  onPlayerBumped(player) {
    this.fx.impact(player.mesh.position, 0.35);
    this.feel.shake.add(0.06);
    // 这里可以接一个轻微的金属摩擦音效（目前项目还没有音频系统）
  }

  onPlayerHit(damage) {
    this.feel.onPlayerHit(damage);
    this.hud.flash('#ff2a2a', 0.3);
  }

  gameOver(reason) {
    if (this.state !== 'playing') return;
    this.state = 'over';
    if (reason === 'WRECKED') this.fx.explosion(this.player.mesh.position, 1.6);
    this.player.alive = false;
    this.feel.hitStop(0.2, 0.05);
    this.feel.slowMo(0.3, 0.8);
    this.feel.shake.add(0.6);
    const score = Math.floor(this.score);
    this.best = Math.max(this.best, score);
    this.save('best', this.best);
    setTimeout(() => this.hud.showGameOver(reason, { score, distance: Math.floor(this.distance), kills: this.kills, best: this.best }), 1300);
  }

  // ---------------- 主循环 ----------------
  tick(now) {
    this.update(Math.min(0.05, (now - this.last) / 1000));
    this.last = now;
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame((t) => this.tick(t));
  }

  update(realDt) {
    this.feel.update(realDt);
    const dt = realDt * this.feel.timeScale; // 顿帧/慢动作只影响游戏时间
    this.time += dt;

    this.player.update(dt);
    if (this.state !== 'title') this.spawner.update(dt);
    if (this.state === 'playing') this.updatePlaying(dt);
    if (this.player.isDashing) this.fx.dashTrail(this.player);

    this.world.update(this.player.z);
    this.fx.update(dt);
    updateSirens(this.time);
    this.updateEnvironment(realDt);
    this.updateCamera(realDt);
    this.hud.update(this, realDt);
  }

  updatePlaying(dt) {
    const p = this.player;
    resolveCollisions(this);
    this.distance = Math.max(this.distance, p.z);
    this.score += p.speed * dt * CONFIG.score.perMeter * (p.isDashing ? 2 : 1);
    if (this.comboTimer > 0 && (this.comboTimer -= dt) <= 0) this.combo = 0;

    // 路障预警：前方 warnDistance 米内有路障就显示 UI 车道示意
    const rb = this.spawner.nextBarricade(p.z, CONFIG.barricade.warnDistance);
    this.hud.showRoadblock(rb ? rb.blocked : null);

    // 被捕判定：被 2 辆以上警车贴身包夹时，被捕条持续上涨
    const boxed = !p.isDashing && this.spawner.copsNear(p, 5.5, 5.5) >= 2;
    this.bust = clamp(this.bust + (boxed ? 0.55 : -0.7) * dt, 0, 1);

    const biome = Road.biomeAt(p.z);
    if (biome !== this.biome) {
      this.biome = biome;
      this.hud.banner(biome);
    }
    if (!p.alive) this.gameOver('WRECKED');
    else if (this.bust >= 1) this.gameOver('BUSTED');
  }

  updateEnvironment(dt) {
    const forest = Road.biomeAt(this.player.z + 40) === 'forest';
    this.scene.background.lerp(forest ? SKY.forest : SKY.city, 1 - Math.exp(-1.5 * dt));
    this.scene.fog.color.copy(this.scene.background);
    this.snowWeight = damp(this.snowWeight ?? 0, forest ? 1 : 0, 1.5, dt);
    this.snow.update(dt, this.camTarget, this.snowWeight);
  }

  updateCamera(dt) {
    const p = this.player, h = Road.heading(p.z);
    const look = CONFIG.camera.lookAhead * this.lookMul + p.speed * 0.1;
    const tx = p.mesh.position.x + Math.sin(h) * look, tz = p.z + Math.cos(h) * look;
    this.camTarget.x = damp(this.camTarget.x, tx, 5, dt);
    this.camTarget.z = damp(this.camTarget.z, tz, 12, dt); // 冲刺时镜头略微滞后 → 速度感
    const cam = this.camera;
    cam.position.copy(this.camTarget).add(this.camOffset).add(this.feel.shake.offset);
    cam.lookAt(this.camTarget);
    cam.rotateZ(this.feel.shake.roll);
    cam.zoom = this.feel.zoom;
    cam.updateProjectionMatrix();
    this.sun.position.copy(this.camTarget).add(this.sunOffset);
    this.sun.target.position.copy(this.camTarget);
  }

  resize() {
    const w = innerWidth, h = innerHeight, aspect = w / h;
    this.renderer.setSize(w, h);
    const C = CONFIG.camera;
    const halfW = Math.max(C.minWidth / 2, (C.minHeight / 2) * aspect), halfH = halfW / aspect;
    Object.assign(this.camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    this.camera.updateProjectionMatrix();
    this.lookMul = aspect < 1 ? 1.5 : 0.7; // 竖屏时看得更远
    // 竖屏屏幕窄，把镜头转正一点，让道路更接近竖直方向
    this.camOffset.set(...C.offset);
    if (aspect < 1) this.camOffset.x *= 0.45;
  }
}

window.game = new Game(); // 挂到 window 上方便在控制台调试
