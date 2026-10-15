import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Road, BIOMES, BIOME_IDS } from './world/Road.js';
import { LevelManager } from './world/LevelManager.js';
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
import { clamp, damp, dampAngle } from './core/utils.js';
import { t } from './i18n.js';
import { RoadFeatures } from './world/RoadFeatures.js';
import { Cannon } from './player/Cannon.js';
import { TIERS } from './player/Vehicles.js';
import { UPGRADES, rollUpgrades, applyUpgrade } from './player/Upgrades.js';
import { LEVELS } from './data/levels.js';
import { loadModels } from './models/ModelLibrary.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const UP = new THREE.Vector3(0, 1, 0);
const SAMPLE = {};
const tmpColor = new THREE.Color();

class Game {
  constructor() {
    const canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BIOMES.city.sky);
    this.scene.fog = new THREE.Fog(this.scene.background, 70, 170);
    // 环境反射：让 3D 车模的车漆有光泽（只影响车辆模型的 PBR 材质，地图的低多边形材质不受影响）
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

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

    // 远处的全局地面：颜色跟随当前地图（每个区块只铺道路两侧 45 米）
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: BIOMES.city.ground }));
    this.ground.position.y = -0.03;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    // Bloom 光晕：阈值 1.6 → 只有“比白还亮”（HDR）的东西会发光：火焰、火花、警灯、车灯、霓虹
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.65, 0.22, 1.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.bloomOn = true;
    this.bloomKick = 0;
    this.perf = { avg: 16, slow: 0 };

    this.levels = new LevelManager();
    this.levels.onCommit = (j) => {
      this.world.onCommit(j);
      // 每过一个路口，前方就有一个改装站
      if (this.state === 'playing') this.features.addStation(j.sEntry + j.options[j.chosen].boxLen + CONFIG.features.stationAfterJunction);
    };
    this.world = new WorldGenerator(this.scene, this.levels);
    this.fx = new Effects(this.scene);
    this.feel = new GameFeel();
    this.snow = new Snow(this.scene);
    this.hud = new HUD();
    this.player = new PlayerController(this.scene, {
      onDashStart: () => { this.feel.onDashStart(); this.fx.decal('ring', this.player.mesh.position, 0.35, 7, 0x66e0ff); },
      onHit: (p, dmg) => this.onPlayerHit(dmg),
      onShieldBreak: () => this.onShieldBreak(),
      onLand: (p, impact) => this.onLand(impact),
    });
    this.spawner = new Spawner(this);
    this.features = new RoadFeatures(this);
    this.cannon = new Cannon(this);
    new SwipeInput(canvas, {
      onSwipe: (d) => this.handleSwipe(d),
      onDash: () => this.tryDash(),
    });
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyF' || e.code === 'KeyJ') this.fire();
    });
    const hud = this.hud;
    hud.onDash = () => this.tryDash();
    hud.onFire = () => this.fire();
    hud.onSelectRoute = (idx) => this.levels.select(idx, this.player.lane);
    hud.onOpenLevels = () => hud.showLevels(LEVELS, this.progress);
    hud.onEndless = () => this.startRun({ mode: 'endless' });
    hud.onPickLevel = (level) => this.startRun({ mode: 'level', level });
    hud.onRetry = () => this.startRun(this.runOpts);
    hud.onMenu = () => this.toMenu();
    hud.onNextLevel = () => this.startRun({ mode: 'level', level: LEVELS[LEVELS.indexOf(this.level) + 1] });
    hud.onPickUpgrade = (id) => this.pickUpgrade(id);

    this.state = 'title';
    this.time = 0;
    this.best = Number(this.load('best') || 0);
    this.bestDist = Number(this.load('bestDist') || 0);
    try { this.progress = JSON.parse(this.load('progress')) || null; } catch { this.progress = null; }
    this.progress ??= { unlocked: 1, stars: {} };
    this.resetRun();
    addEventListener('resize', () => this.resize());
    this.resize();
    this.last = performance.now();
    requestAnimationFrame((t) => this.tick(t));
  }

  load(k) { try { return localStorage.getItem('rampage-escape.' + k); } catch { return null; } }
  save(k, v) { try { localStorage.setItem('rampage-escape.' + k, v); } catch { /* 隐私模式 */ } }

  resetRun(opts = { mode: 'endless' }) {
    this.runOpts = opts;
    this.level = opts.mode === 'level' ? opts.level : null;
    const pool = this.level ? this.level.pool : BIOME_IDS;
    this.world.reset();
    this.levels.reset(pool, pool[0]);
    this.player.reset();
    this.spawner.reset();
    this.features.reset();
    this.cannon.reset();
    if (this.level) this.features.setFinish(this.level.length);
    this.camYaw = 0;
    this.score = 0;
    this.distance = 0;
    this.kills = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.bust = 0;
    this.biome = Road.biomeAt(0);
    this.camTarget.set(0, 0, CONFIG.camera.lookAhead);
  }

  /** 开始一局：{ mode: 'endless' } 或 { mode: 'level', level } */
  startRun(opts) {
    this.resetRun(opts);
    this.state = 'playing';
    this.spawner.prefill(this.player.z);
    this.hud.showPlaying();
    this.hud.banner(this.biome);
  }

  /** 回主菜单：背景里继续自动开车（无尽地图） */
  toMenu() {
    this.resetRun();
    this.state = 'title';
    this.hud.showTitle();
  }

  get stars() {
    const s = CONFIG.spawn, base = this.level?.startStars ?? 1;
    return clamp(base + Math.floor(this.distance / s.starDistance) + Math.floor(this.kills / 10), 1, s.maxStars);
  }

  fire() {
    if (this.state === 'playing') this.cannon.fire();
  }

  // ---------------- 改装站 ----------------
  openUpgrade() {
    this.state = 'upgrade';
    const p = this.player;
    const cards = rollUpgrades(p).map((id) => {
      const u = UPGRADES[id], next = TIERS[p.tierIndex + 1];
      return {
        id,
        icon: id === 'evolve' ? ['🚗', '🏎️', '🛻', '🪖'][p.tierIndex + 1] ?? u.icon : u.icon,
        level: p.upgradeLevels[id] ?? 0,
        name: () => (id === 'evolve' ? t('up_evolve', { tier: t('tier_' + next.id) }) : t('up_' + id)),
        desc: () => (id === 'evolve' ? (next.cannon ? t('up_evolve_tank') : next.ram ? t('up_evolve_armored') : t('up_evolve_desc')) : t('up_' + id + '_desc')),
      };
    });
    this.hud.showUpgrade(cards);
  }

  pickUpgrade(id) {
    if (this.state !== 'upgrade') return;
    const p = this.player;
    applyUpgrade(p, id);
    this.state = 'playing';
    this.hud.showPlaying();
    // 回到路上：短暂无敌，附近的警车被推远一点，避免一出来就被包夹
    p.invuln = 1.6;
    for (const c of this.spawner.police) if (c.mode === 'chase' && Math.abs(c.z - p.z) < 25) c.z = Math.min(c.z, p.z - 25);
    this.bust = 0;
    this.feel.slowMo(0.5, 0.4);
    this.feel.shake.add(0.2);
    this.fx.decal('ring', p.mesh.position, 0.5, 9, id === 'evolve' ? 0xffb020 : 0x5ad1ff);
    this.hud.popup(id === 'evolve' ? t('tier_' + p.tier.id) : t('up_' + id), p.mesh.position, this.camera, true);
  }

  // ---------------- 道具 / 跳台 / 护盾 ----------------
  onPickup(kind, pos) {
    const p = this.player;
    if (kind === 'shield') p.shields = Math.min(3, p.shields + 1);
    else if (kind === 'nitro') p.dashCooldown = 0;
    else p.heal(25);
    this.score += 100;
    this.fx.impact(pos, 0.5);
    this.fx.decal('ring', p.mesh.position, 0.3, 5, kind === 'shield' ? 0x2f9bff : kind === 'nitro' ? 0xffb020 : 0x2ecc71);
    this.feel.shake.add(0.06);
    this.hud.popup(t('pk_' + kind), pos, this.camera);
  }

  onJump() {
    this.score += 200;
    this.feel.slowMo(0.55, 0.35);
    this.feel.shake.add(0.12);
    this.hud.popup(t('jump'), this.player.mesh.position, this.camera, true);
  }

  onLand(impact) {
    this.feel.shake.add(Math.min(0.4, impact * 0.025));
    this.fx.dust(this.player.mesh.position);
  }

  onShieldBreak() {
    this.feel.shake.add(0.25);
    this.hud.flash('#5ad1ff', 0.3);
    this.hud.popup(t('shieldBlock'), this.player.mesh.position, this.camera);
  }

  // ---------------- 过关 ----------------
  completeLevel() {
    this.state = 'complete';
    const lv = this.level, p = this.player;
    const goals = [
      { key: 'goalFinish', done: true },
      { key: 'goalKills', vars: { n: lv.kills, k: this.kills }, done: this.kills >= lv.kills },
      { key: 'goalHp', done: p.hp >= p.maxHp * 0.5 },
    ];
    const stars = goals.filter((g) => g.done).length;
    const pr = this.progress;
    pr.stars[lv.id] = Math.max(pr.stars[lv.id] ?? 0, stars);
    pr.unlocked = Math.max(pr.unlocked, Math.min(LEVELS.length, lv.id + 1));
    this.save('progress', JSON.stringify(pr));
    this.feel.slowMo(0.3, 0.8);
    this.hud.flash('#fff6d8', 0.5);
    const hasNext = LEVELS.indexOf(lv) < LEVELS.length - 1;
    setTimeout(() => this.hud.showComplete({ stars, goals, score: Math.floor(this.score), kills: this.kills, hasNext }), 900);
  }

  /** 路口决策区内，左右/上滑是选岔路；其他时候照常变道/加减速 */
  handleSwipe(dir) {
    if (this.state !== 'playing') return;
    this.player.handleSwipe(dir); // 滑动永远是变道/加减速；选路看车道
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
    this.bloomKick = Math.max(this.bloomKick, 0.45 * power); // 爆炸瞬间光晕冲高
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
    const score = Math.floor(this.score), distance = Math.floor(this.distance);
    this.best = Math.max(this.best, score);
    this.save('best', this.best);
    let bestLabel = null;
    if (!this.level) {
      // 无尽模式额外记录最远距离
      this.bestDist = Math.max(this.bestDist, distance);
      this.save('bestDist', this.bestDist);
      bestLabel = { key: 'bestDist', vars: { d: this.bestDist } };
    }
    setTimeout(() => this.hud.showGameOver(reason, { score, distance, kills: this.kills, best: this.best, bestLabel }), 1300);
  }

  // ---------------- 主循环 ----------------
  tick(now) {
    const frame = Math.min(0.05, (now - this.last) / 1000);
    this.update(frame);
    this.last = now;
    this.watchPerformance(frame);
    if (this.bloomOn) {
      this.bloomKick = damp(this.bloomKick, 0, 6, frame);
      this.bloom.strength = 0.7 + this.bloomKick;
      this.composer.render(frame);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    requestAnimationFrame((t) => this.tick(t));
  }

  /** 低端手机保护：平均帧时间持续超过 26ms（< 38fps）就关掉 Bloom 并降低像素比 */
  watchPerformance(dt) {
    const pf = this.perf;
    pf.avg = pf.avg * 0.95 + dt * 1000 * 0.05;
    pf.slow = pf.avg > 26 ? pf.slow + dt : 0;
    if (pf.slow > 3 && this.bloomOn) {
      this.bloomOn = false;
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      this.resize();
      pf.slow = 0;
    }
  }

  update(realDt) {
    // 改装站界面打开时整个世界暂停，只保留镜头和界面
    if (this.state === 'upgrade') {
      this.updateCamera(realDt);
      this.hud.update(this, realDt);
      return;
    }
    this.feel.update(realDt);
    const dt = realDt * this.feel.timeScale; // 顿帧/慢动作只影响游戏时间
    this.time += dt;

    this.player.update(dt);
    this.levels.update(this.player.z);
    if (this.state !== 'title') this.spawner.update(dt);
    this.features.update(dt);
    this.cannon.update(dt);
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

    // 路口：决策区内按车道选出口，并显示岔路面板
    this.levels.followLane(p.lane, p.z);
    this.hud.showJunction(this.levels.junction, p.z);

    // 路障预警：前方 warnDistance 米内有路障就显示 UI 车道示意
    const rb = this.spawner.nextBarricade(p.z, CONFIG.barricade.warnDistance);
    this.hud.showRoadblock(rb ? rb.blocked : null);

    // 被捕判定：被 2 辆以上警车贴身包夹时，被捕条持续上涨（冲刺、飞在空中、开坦克时不会被捕）
    const boxed = !p.isDashing && !p.airborne && !p.tier.cannon && this.spawner.copsNear(p, 5.5, 5.5) >= 2;
    this.bust = clamp(this.bust + (boxed ? 0.55 : -0.7) * dt, 0, 1);

    const biome = Road.biomeAt(p.z);
    if (biome !== this.biome) {
      this.biome = biome;
      this.hud.banner(biome);
    }
    if (!p.alive) this.gameOver('WRECKED');
    else if (this.bust >= 1) this.gameOver('BUSTED');
    else if (this.level && p.z >= this.level.length) this.completeLevel();
  }

  updateEnvironment(dt) {
    const b = BIOMES[Road.biomeAt(this.player.z + 30)];
    const k = 1 - Math.exp(-1.5 * dt);
    this.scene.background.lerp(tmpColor.setHex(b.sky), k);
    this.scene.fog.color.copy(this.scene.background);
    this.ground.material.color.lerp(tmpColor.setHex(b.ground), k);
    this.ground.position.set(this.camTarget.x, -0.03, this.camTarget.z);
    this.snowWeight = damp(this.snowWeight ?? 0, b.snow ? 1 : 0, 1.5, dt);
    this.snow.update(dt, this.camTarget, this.snowWeight);
  }

  updateCamera(dt) {
    const p = this.player;
    // 看向车前方的道路（转弯后自然看向新方向）；冲刺时镜头略微滞后 → 速度感
    const look = CONFIG.camera.lookAhead * this.lookMul + p.speed * 0.1;
    const w = Road.sample(p.z + look, p.lateral * 0.6, SAMPLE);
    this.camTarget.x = damp(this.camTarget.x, w.x, 8, dt);
    this.camTarget.z = damp(this.camTarget.z, w.z, 8, dt);
    // 镜头绕车平滑旋转，始终保持在车辆后方的等距视角
    this.camYaw = dampAngle(this.camYaw, Road.heading(p.z), 3, dt);
    const cam = this.camera;
    cam.position.copy(this.camOffset).applyAxisAngle(UP, this.camYaw).add(this.camTarget).add(this.feel.shake.offset);
    cam.lookAt(this.camTarget);
    cam.rotateZ(this.feel.shake.roll);
    cam.zoom = this.feel.zoom;
    this.fx.setPixelScale(this.renderer.domElement.height / ((cam.top - cam.bottom) / cam.zoom));
    cam.updateProjectionMatrix();
    this.sun.position.copy(this.camTarget).add(this.sunOffset);
    this.sun.target.position.copy(this.camTarget);
  }

  resize() {
    const w = innerWidth, h = innerHeight, aspect = w / h;
    this.renderer.setSize(w, h);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(w, h);
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

// 先加载 3D 模型（最多等 10 秒），再启动游戏；加载失败的模型会自动用方块模型代替
Promise.race([loadModels(), new Promise((r) => setTimeout(r, 10000))]).finally(() => {
  window.game = new Game(); // 挂到 window 上方便在控制台调试
});
