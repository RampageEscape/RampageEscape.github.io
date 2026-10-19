import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Road, BIOMES, BIOME_IDS, WATER_Y, laneOffset, nearestLane } from './world/Road.js';
import { LevelManager } from './world/LevelManager.js';
import { WorldGenerator } from './world/WorldGenerator.js';
import { Spawner } from './world/Spawner.js';
import { PlayerController } from './player/PlayerController.js';
import { SwipeInput } from './input/SwipeInput.js';
import { VersusInput } from './input/VersusInput.js';
import { Effects } from './fx/Effects.js';
import { GameFeel } from './fx/GameFeel.js';
import { Snow } from './fx/Weather.js';
import { HUD } from './ui/HUD.js';
import './pwa.js';
import { resolveCollisions } from './systems/Collisions.js';
import { updateSirens } from './models/Models.js';
import { updateWater } from './world/RoadMaterial.js';
import { clamp, damp, dampAngle } from './core/utils.js';
import { t } from './i18n.js';
import { RoadFeatures } from './world/RoadFeatures.js';
import { Cannon } from './player/Cannon.js';
import { Cockpit } from './player/Cockpit.js';
import { Missiles } from './player/Missiles.js';
import { SpeedLines } from './fx/SpeedLines.js';
import { TIERS } from './player/Vehicles.js';
import { UPGRADES, rollUpgrades, applyUpgrade } from './player/Upgrades.js';
import { LEVELS } from './data/levels.js';
import { loadModels, loadHero, loadEnvModels } from './models/ModelLibrary.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { Progression } from './systems/Progression.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { RUN, setDifficulty } from './data/difficulty.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const UP = new THREE.Vector3(0, 1, 0);
const SAMPLE = {};
const tmpColor = new THREE.Color();
const tmpSize = new THREE.Vector2();
const tmpV = new THREE.Vector3();

/** 夜城的环境光：深紫色夜空 + 几块粉色、青色的“霓虹灯牌”，生成反射用的环境贴图 */
function neonEnvironment() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0720);
  const panel = (r, g, b, x, y, z, w, h) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    m.material.color.setRGB(r, g, b);
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  panel(3, 0.35, 2.2, -6, 1.5, 3, 3, 5);
  panel(3, 0.35, 2.2, 5, 1, 5, 2, 3);
  panel(0.3, 2.2, 3.2, 6, 1.5, -3, 3, 5);
  panel(0.3, 2.2, 3.2, -5, 1, -5, 2, 3);
  panel(0.35, 0.25, 0.7, 0, 8, 0, 14, 14); // 被城市灯光照亮的夜空
  return scene;
}

/** 追尾镜头：每位玩家一套（双人对战时左右分屏各用一套） */
function makeRig(cam, layer) {
  cam.layers.enable(layer); // 贴着镜头的车只对这台镜头隐藏（见 hideNearCamera）
  return { cam, pos: new THREE.Vector3(), yaw: 0, init: false, target: new THREE.Vector3(), vp: { x: 0, w: 1 } };
}

// 这些“这一局的成绩”实际存在玩家身上（双人对战时每人一份）；单人模式下 game.score 等就是玩家 1 的
const RUN_STATS = ['score', 'distance', 'kills', 'combo', 'comboTimer', 'fever', 'bust', 'dashKills'];

class Game {
  constructor() {
    const canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 电影感色调映射（ACES）：高光柔和过渡，暗部更有层次，写实感的关键之一
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BIOMES.city.sky);
    this.scene.fog = new THREE.Fog(this.scene.background, 70, 170);
    // 环境光照：先用内置房间环境，真实天空 HDRI（Poly Haven，CC0）加载好后替换
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.dayEnv = this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.nightEnv = pmrem.fromScene(neonEnvironment(), 0.03).texture; // 夜城：车漆和湿路面反射粉色/青色霓虹，而不是白天的天空
    this.skyColor = this.scene.background;
    new RGBELoader().load('assets/env/sky_1k.hdr', (hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      this.dayEnv = pmrem.fromEquirectangular(hdr).texture;
      this.skyTex = hdr; // 追尾视角的天空背景
      pmrem.dispose();
    });

    // 等距视角：正交相机 + 固定斜俯角；追尾视角：透视相机（双人对战时第二台给玩家 2）
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    this.ortho.layers.enable(2);
    this.persp = new THREE.PerspectiveCamera(62, 1, 0.3, 700);
    this.rigs = [makeRig(this.persp, 2), makeRig(new THREE.PerspectiveCamera(62, 1, 0.3, 700), 3)];
    // 视角：chase = 第三人称（GTA 式，车后上方）/ first = 第一人称（驾驶座）/ iso = 俯视
    this.cameraMode = ['chase', 'first', 'iso'].includes(this.load('camera')) ? this.load('camera') : 'chase';
    this.camera = this.cameraMode === 'iso' ? this.ortho : this.persp;
    CONFIG.world.tallNear = this.cameraMode !== 'iso';
    for (const r of this.rigs) r.cam.near = this.cameraMode === 'first' ? 0.05 : 0.3;
    // 第一人称驾驶舱：挂在每台追尾镜头下面（layer 4 / 5 只给自己那台镜头看）
    this.cockpits = this.rigs.map((r, i) => {
      const c = new Cockpit(4 + i);
      r.cam.layers.enable(4 + i);
      r.cam.add(c.group);
      c.mirrorCam.layers.enable(2 + i); // 后视镜看得到对手的车（双人对战第一人称时对手的车在 layer 2 / 3）
      return c;
    });
    this.camOffset = new THREE.Vector3(...CONFIG.camera.offset);
    this.camTarget = new THREE.Vector3();

    this.hemi = new THREE.HemisphereLight(0xfff3df, 0x6b5d4a, 1.5);
    this.scene.add(this.hemi);
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
    for (const r of this.rigs) this.scene.add(r.cam); // 镜头要在场景里，挂在镜头下的驾驶舱才会被渲染

    // Bloom 光晕：阈值 1.6 → 只有“比白还亮”（HDR）的东西会发光：火焰、火花、警灯、车灯、霓虹
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
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
      if (this.state === 'playing') {
        this.features.addStation(j.sEntry + j.options[j.chosen].boxLen + CONFIG.features.stationAfterJunction);
        this.missionEvent('junctions');
      }
    };
    this.world = new WorldGenerator(this.scene, this.levels);
    this.fx = new Effects(this.scene);
    this.feel = new GameFeel();
    this.snow = new Snow(this.scene);
    this.hud = new HUD();
    this.versus = false;
    this.player = this.makePlayer(0);
    this.players = [this.player];
    this.spawner = new Spawner(this);
    this.features = new RoadFeatures(this);
    this.cannon = new Cannon(this, this.player);
    this.cannons = [this.cannon];
    this.missiles = new Missiles(this);
    this.speedLines = new SpeedLines();
    this.lowHp = document.getElementById('low-hp');

    // 单人：全屏滑动 / 方向键；双人：左右半屏 + 两套键位（VersusInput）
    new SwipeInput(canvas, {
      onSwipe: (d) => { if (!this.versus) this.handleSwipe(d); },
      onDash: () => { if (!this.versus) this.tryDash(); },
    });
    new VersusInput(canvas, {
      enabled: () => this.versus,
      onSwipe: (i, d) => { if (this.state === 'playing') this.players[i]?.handleSwipe(d); },
      onDash: (i) => { if (this.state === 'playing') this.players[i]?.tryDash(); },
      onFire: (i) => { if (this.state === 'playing') this.cannons[i]?.fire(); },
    });
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyC' && !e.repeat && (this.state === 'playing' || this.state === 'countdown')) this.cycleCamera();
      if (!this.versus && (e.code === 'KeyF' || e.code === 'KeyJ')) this.fire();
      if (e.code === 'Escape' || e.code === 'KeyP') this.state === 'paused' ? this.resume() : this.pause();
    });
    const hud = this.hud;
    hud.onDash = () => this.tryDash();
    hud.onFire = () => this.fire();
    hud.onVsDash = (i) => { if (this.state === 'playing') this.players[i]?.tryDash(); };
    hud.onVsFire = (i) => { if (this.state === 'playing') this.cannons[i]?.fire(); };
    hud.onSelectRoute = (idx) => this.levels.select(idx, this.player.lane);
    hud.onOpenLevels = () => hud.showLevels(LEVELS, this.progress);
    hud.onEndless = () => this.startRun({ mode: 'endless' });
    hud.onPickLevel = (level) => this.startRun({ mode: 'level', level });
    hud.onRetry = () => this.startRun(this.runOpts);
    hud.onMenu = () => this.toMenu();
    hud.onNextLevel = () => this.startRun({ mode: 'level', level: LEVELS[LEVELS.indexOf(this.level) + 1] });
    hud.onPickUpgrade = (id) => this.pickUpgrade(id);
    hud.onStartVersus = () => this.startVersus();
    hud.onVersusAgain = () => this.startVersus();

    this.state = 'title';
    this.speedLevel = 1;
    this.time = 0;
    this.best = Number(this.load('best') || 0);
    this.prog = new Progression();
    this.hud.prog = this.prog;
    // ---- 音频：第一次点击/按键后才能出声（浏览器规定）
    this.audio = new AudioEngine();
    const unlock = () => this.audio.unlock();
    addEventListener('pointerdown', unlock, { passive: true });
    addEventListener('keydown', unlock);
    document.addEventListener('click', (e) => { if (e.target.closest?.('button')) this.audio.ui(); });
    // 越远越小声（双人对战时按离两位玩家里较近的那位算）
    const att = (pos) => clamp(1 - Math.min(...this.players.map((p) => p.mesh.position.distanceTo(pos))) / 90, 0.15, 1);
    this.fx.onExplosion = (pos, power) => this.audio.explosion(power, att(pos));
    this.fx.onImpact = (pos, s) => this.audio.impact(s, att(pos));
    this.fx.onSplash = (pos, s) => this.audio.splash(s, att(pos));
    hud.onToggleMusic = () => this.audio.toggleMusic();
    hud.onToggleSfx = () => this.audio.toggleSfx();
    hud.onToggleCamera = () => this.cycleCamera(false);
    hud.onCycleCamera = () => this.cycleCamera();
    hud.setCamLabel(this.cameraMode);
    hud.settings = () => ({ music: this.audio.musicOn, sfx: this.audio.sfxOn, camera: this.cameraMode });
    setDifficulty(this.load('difficulty') || 'normal');
    hud.onDifficulty = (id) => { setDifficulty(id); this.save('difficulty', id); hud.showTitle(); };
    hud.difficulty = () => RUN.id;
    hud.onPause = () => this.pause();
    hud.onResume = () => this.resume();
    hud.onRestart = () => (this.versus ? this.startVersus() : this.startRun(this.runOpts));
    // 切出网页 / 锁屏时自动暂停
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); });
    this.bestDist = Number(this.load('bestDist') || 0);
    try { this.progress = JSON.parse(this.load('progress')) || null; } catch { this.progress = null; }
    this.progress ??= { unlocked: 1, stars: {} };
    this.resetRun();
    this.hud.showTitle();
    addEventListener('resize', () => this.resize());
    this.resize();
    this.last = performance.now();
    requestAnimationFrame((t) => this.tick(t));
  }

  load(k) { try { return localStorage.getItem('rampage-escape.' + k); } catch { return null; } }
  save(k, v) { try { localStorage.setItem('rampage-escape.' + k, v); } catch { /* 隐私模式 */ } }

  makePlayer(index) {
    return new PlayerController(this.scene, {
      onDashStart: (p) => { this.feel.onDashStart(); this.audio?.dash(); p.dashKills = 0; this.fx.decal('ring', p.mesh.position, 0.35, 7, p.color.hex); },
      onRampageStart: (p) => this.onRampage(true, p),
      onRampageEnd: (p) => this.onRampage(false, p),
      onHit: (p, dmg) => this.onPlayerHit(dmg, p),
      onShieldBreak: (p) => this.onShieldBreak(p),
      onLand: (p, impact) => this.onLand(impact, p),
      onLaunch: (p, kind) => this.onLaunch(p, kind),
      onWater: (p, on) => this.onWaterChange(p, on),
    }, { index, skin: index ? 'p2' : null });
  }

  // ---------------- 多玩家辅助 ----------------
  isPlayer(o) { return !!o && this.players.includes(o); }

  /** 领先的玩家（前方的车流、路障、路口都按他来生成） */
  get leader() {
    if (!this.versus) return this.player;
    const [a, b] = this.players;
    return b.alive && (b.z > a.z || !a.alive) ? b : a;
  }

  /** 落后玩家的位置（身后的东西按它来清理） */
  get trailZ() {
    return this.versus ? Math.min(this.players[0].z, this.players[1].z) : this.player.z;
  }

  /** 离某个实体最近的活着的玩家（警车、坦克追这个人） */
  targetFor(e) {
    if (!this.versus) return this.player;
    const [a, b] = this.players;
    if (!a.alive) return b;
    if (!b.alive) return a;
    return Math.abs(a.z - e.z) <= Math.abs(b.z - e.z) ? a : b;
  }

  nearestPlayer(z) { return this.targetFor({ z }); }

  randomPlayer() {
    if (!this.versus) return null;
    const alive = this.players.filter((p) => p.alive);
    return alive[Math.floor(Math.random() * alive.length)] ?? null;
  }

  /** 直升机盯分数高的那位（领先者压力更大，比赛更胶着） */
  heliTarget() {
    if (!this.versus) return this.player;
    const [a, b] = this.players;
    return b.alive && (b.score > a.score || !a.alive) ? b : a;
  }

  /** 在某位玩家的画面里弹出文字 */
  popAt(p, text, pos, big = false) {
    const rig = this.versus ? this.rigs[p.index] : null;
    this.hud.popup(text, pos, rig ? rig.cam : this.camera, big, rig?.vp);
  }

  flashFor(p, color, alpha) {
    this.hud.flash(color, alpha, this.versus ? p.index : null);
  }

  resetRun(opts = { mode: 'endless' }) {
    this.runOpts = opts;
    this.level = opts.mode === 'level' ? opts.level : null;
    const pool = this.level ? this.level.pool : BIOME_IDS;
    this.world.reset();
    this.levels.reset(pool, pool[0]);
    for (const p of this.players) p.reset();
    if (this.versus) {
      // 两辆车并排起跑：玩家 1 在左边车道，玩家 2 在右边
      this.players.forEach((p, i) => {
        p.lane = i ? 1 : 2;
        p.lateral = laneOffset(p.lane);
        p.syncMesh(0);
      });
    }
    this.spawner.reset();
    this.features.reset();
    for (const c of this.cannons) c.reset();
    this.missiles.reset();
    this.coinDist = 0;
    if (this.level) this.features.setFinish(this.level.length);
    this.camYaw = 0;
    for (const r of this.rigs) r.init = false;
    this.biome = Road.biomeAt(0);
    this.camTarget.set(0, 0, CONFIG.camera.lookAhead);
  }

  /** 开始一局：{ mode: 'endless' } 或 { mode: 'level', level } */
  startRun(opts) {
    this.setVersus(false);
    setDifficulty(RUN.id);
    RUN.pace = CONFIG.pace.start; // 速度分级从第 1 级开始（慢）
    RUN.heat = this.speedLevel = 1;
    this.resetRun(opts);
    this.prog.startRun();
    this.prog.rewardMul = RUN.diff.reward;
    this.prog.applyGarage(this.player);
    this.hud.showMissions(this.prog.missions);
    this.state = 'playing';
    this.spawner.prefill(this.player.z);
    this.hud.showPlaying();
    this.hud.banner(this.biome);
    this.audio.setMode('game');
  }

  // ---------------- 双人对战 ----------------
  /** 打开 / 关闭双人模式：创建玩家 2、第二门炮，强制追尾分屏 */
  setVersus(on) {
    if (on === this.versus) return;
    this.versus = on;
    this.feel.versus = on;
    this.hud.setVersus(on);
    if (on) {
      this.player2 ??= this.makePlayer(1);
      this.cannons[1] ??= new Cannon(this, this.player2);
      this.scene.add(this.player2.mesh);
      this.players = [this.player, this.player2];
      this.modeBeforeVersus = this.cameraMode;
      if (this.cameraMode === 'iso') this.setCameraMode('chase', false); // 分屏没有俯视角
    } else {
      this.players = [this.player];
      if (this.player2) this.scene.remove(this.player2.mesh);
      if (this.modeBeforeVersus && this.modeBeforeVersus !== this.cameraMode) this.setCameraMode(this.modeBeforeVersus, false);
    }
    this.updateTags();
    this.hud.setCamLabel(this.cameraMode);
    this.resize();
  }

  startVersus() {
    this.setVersus(true);
    setDifficulty(RUN.id);
    RUN.pace = CONFIG.pace.start;
    RUN.heat = this.speedLevel = 1;
    this.resetRun({ mode: 'versus' });
    this.prog.startRun();
    this.prog.rewardMul = RUN.diff.reward;
    this.spawner.prefill(this.player.z);
    this.world.update(this.leader.z, this.trailZ); // 倒数期间世界不更新，先把周围的区块建好
    this.state = 'countdown';
    this.countdown = 3;
    this.hud.showPlaying();
    this.hud.countdown('3');
    this.audio.setMode('game');
    this.audio.alert();
  }

  updateCountdown(dt) {
    const before = Math.ceil(this.countdown);
    this.countdown -= dt;
    const now = Math.ceil(this.countdown);
    if (now !== before && now > 0) {
      this.hud.countdown(String(now));
      this.audio.alert();
    }
    if (this.countdown <= 0) {
      this.state = 'playing';
      this.hud.countdown(t('go'));
      this.audio.speedUp();
      this.hud.banner(this.biome);
      setTimeout(() => { if (this.state !== 'countdown') this.hud.countdown(null); }, 900);
    }
  }

  /** 对战结束：先倒下的一方输（同时倒下比分数） */
  endVersus() {
    if (this.state !== 'playing') return;
    this.state = 'over';
    const [a, b] = this.players;
    const out = (p) => !p.alive || p.bust >= 1;
    const both = out(a) && out(b);
    const loser = both ? (a.score <= b.score ? a : b) : out(a) ? a : b;
    const draw = both && Math.floor(a.score) === Math.floor(b.score);
    const reason = loser.alive && loser.bust >= 1 ? 'BUSTED' : 'WRECKED';
    if (reason === 'WRECKED') this.fx.explosion(loser.mesh.position, 1.6);
    loser.alive = false;
    this.feel.shake.add(0.6);
    this.audio.sting(true);
    this.flashFor(loser, '#ff2a2a', 0.5);
    this.prog.endRun();
    const data = {
      winner: draw ? null : 1 - loser.index,
      loser: draw ? null : loser.index,
      reason,
      players: this.players.map((p) => ({ score: Math.floor(p.score), distance: Math.floor(p.distance), kills: p.kills })),
    };
    setTimeout(() => this.hud.showVersusOver(data), 1300);
  }

  /** 回主菜单：背景里继续自动开车（无尽地图） */
  toMenu() {
    this.setVersus(false);
    this.hud.countdown(null);
    RUN.pace = 1; // 标题画面背景里的自动驾驶用正常速度
    this.resetRun();
    this.state = 'title';
    this.audio?.setMode('menu');
    this.audio?.setPaused(false);
    this.hud.showTitle();
  }

  // ---------------- 暂停 ----------------
  pause() {
    if (this.state !== 'playing' && this.state !== 'countdown') return;
    this.pausedFrom = this.state;
    this.state = 'paused';
    this.hud.showPause();
    this.audio.setPaused(true);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = this.pausedFrom ?? 'playing';
    this.hud.showPlaying(true);
    this.audio.setPaused(false);
    this.last = performance.now();
  }

  get stars() {
    const s = CONFIG.spawn, base = (this.level?.startStars ?? 1) + RUN.diff.stars;
    const dist = this.leader.distance, kills = this.players.reduce((n, p) => n + p.kills, 0);
    return clamp(base + Math.floor(dist / s.starDistance) + Math.floor(kills / 10), 1, s.maxStars);
  }

  fire() {
    if (this.state === 'playing') this.cannon.fire();
  }

  // ---------------- 改装站 ----------------
  /** 开过改装站：单人打开三选一；双人对战自动升级（不能暂停别人的游戏） */
  onStation(p) {
    if (!this.versus) return this.openUpgrade();
    const id = rollUpgrades(p)[0];
    if (!id) return;
    applyUpgrade(p, id);
    this.audio.upgrade(id === 'evolve');
    p.invuln = 1.2;
    this.fx.decal('ring', p.mesh.position, 0.5, 9, id === 'evolve' ? 0xffb020 : 0x5ad1ff);
    this.popAt(p, id === 'evolve' ? t('tier_' + p.tier.id) : t('up_' + id), p.mesh.position, true);
  }

  openUpgrade() {
    this.state = 'upgrade';
    this.audio.garage();
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
    this.audio.upgrade(id === 'evolve');
    this.state = 'playing';
    this.hud.showPlaying();
    // 回到路上：短暂无敌，附近的警车被推远一点，避免一出来就被包夹
    p.invuln = 1.6;
    for (const c of this.spawner.police) if (c.mode === 'chase' && Math.abs(c.z - p.z) < 25) c.z = Math.min(c.z, p.z - 25);
    p.bust = 0;
    this.feel.slowMo(0.5, 0.4);
    this.feel.shake.add(0.2);
    this.fx.decal('ring', p.mesh.position, 0.5, 9, id === 'evolve' ? 0xffb020 : 0x5ad1ff);
    this.popAt(p, id === 'evolve' ? t('tier_' + p.tier.id) : t('up_' + id), p.mesh.position, true);
  }

  // ---------------- 擦边 / 暴走 / 任务 / 金币 ----------------
  addFever(x, p = this.player) {
    if (p.rampage > 0 || this.state !== 'playing') return;
    p.fever = Math.min(1, p.fever + x);
    if (p.fever >= 1) {
      p.fever = 0;
      p.startRampage(this.prog.rampageSeconds);
    }
  }

  onRampage(on, p = this.player) {
    if (!this.versus) this.hud.setRampage(on);
    if (!on) return;
    this.audio.rampage();
    this.feel.shake.add(0.4);
    this.feel.slowMo(0.4, 0.45);
    this.bloomKick = 1.2;
    this.fx.decal('ring', p.mesh.position, 0.6, 14, 0xff4fd8);
    this.popAt(p, t('rampageOn'), p.mesh.position, true);
    this.missionEvent('rampage');
  }

  /** 贴着车擦过去（没撞到）：加分、加暴走值、冲刺冷却缩短 */
  onNearMiss(e, p = this.player) {
    const pts = Math.round(150 * RUN.diff.reward * (e.oncoming ? 2 : 1)); // 擦过逆行车：双倍
    p.score += pts;
    this.prog.earn(2);
    p.dashCooldown = Math.max(0, p.dashCooldown - 0.6);
    this.addFever(0.1, p);
    this.feel.shake.add(0.05);
    this.feel.zoomKick += 0.02;
    const mid = e.mesh.position.clone().lerp(p.mesh.position, 0.5);
    mid.y = p.mesh.position.y + 0.8;
    for (let i = 0; i < 8; i++) this.fx.spark(mid, new THREE.Vector3((Math.random() - 0.5) * 8, Math.random() * 4, (Math.random() - 0.5) * 8), 0.3, [0.6, 2.4, 3.4]);
    this.popAt(p, `${t(e.oncoming ? 'oncomingMiss' : 'nearMiss')} +${pts}`, mid, e.oncoming);
    this.audio.whoosh(e.lateral > p.lateral ? -0.6 : 0.6);
    this.missionEvent('nearMiss');
  }

  checkNearMiss(p) {
    for (const e of this.spawner.entities) {
      if (!e.collidable || (e.type !== 'civilian' && e.mode !== 'chase')) continue;
      const side = Math.sign(e.z - p.z) || 1, last = e.nmSides[p.index];
      if (last !== undefined && side !== last && !p.airborne && !p.smashes) {
        const gap = Math.abs(e.lateral - p.lateral) - (e.colW + p.colW) / 2;
        if (gap > -0.1 && gap < 1.3) this.onNearMiss(e, p);
      }
      e.nmSides[p.index] = side;
    }
  }

  /** 任务事件：完成时发金币、弹提示（双人对战不算任务） */
  missionEvent(id, amount = 1, mode = 'add') {
    if (this.state !== 'playing' || this.versus) return;
    for (const m of this.prog.track(id, amount, mode)) {
      this.hud.banner('missionDone', { n: m.paid, text: this.hud.missionText(m) });
      this.audio.mission();
      this.feel.shake.add(0.1);
    }
    this.hud.showMissions(this.prog.missions);
  }

  onHeliEscaped() {
    if (this.state !== 'playing') return;
    for (const p of this.players) p.score += 500;
    this.prog.earn(15);
    this.hud.banner('heliEscaped');
  }

  onHeliDown(heli, by) {
    if (this.state !== 'playing') return;
    const p = this.isPlayer(by) ? by : this.player;
    p.score += 2000;
    this.prog.earn(60);
    p.kills++;
    this.missionEvent('kills');
    this.feel.onEnemyDestroyed(2.2, ++p.combo);
    this.bloomKick = 1.3;
    this.hud.banner('heliDown');
    this.popAt(p, '+2000', heli.mesh.position, true);
  }

  onPickup(kind, pos, p = this.player) {
    this.audio.pickup(kind);
    this.prog.earn(3);
    this.addFever(0.06, p);
    this.missionEvent('pickups');
    if (kind === 'shield') p.shields = Math.min(3, p.shields + 1);
    else if (kind === 'nitro') p.dashCooldown = 0;
    else if (kind === 'emp') this.empBlast(p);
    else if (kind === 'missile') this.fireMissiles(p);
    else if (kind === 'oil') { this.spawner.dropOil(p); this.audio.whoosh(0, 0.6); }
    else p.heal(25);
    p.score += 100;
    this.fx.impact(pos, 0.5);
    this.fx.decal('ring', p.mesh.position, 0.3, 5, kind === 'shield' ? 0x2f9bff : kind === 'nitro' ? 0xffb020 : 0x2ecc71);
    this.feel.shake.add(0.06);
    this.popAt(p, t('pk_' + kind), pos);
  }

  onJump(p = this.player) {
    this.audio.jump();
    this.addFever(0.08, p);
    this.missionEvent('jumps');
    p.score += 200;
    this.feel.slowMo(0.55, 0.35);
    this.feel.shake.add(0.12);
    this.popAt(p, t('jump'), p.mesh.position, true);
  }

  onLand(impact, p = this.player) {
    this.feel.shake.add(Math.min(0.4, impact * 0.025));
    if (p.onWater) {
      // 砸进水里：大水花 + 慢动作一瞬间
      this.fx.splash(p.mesh.position, Math.min(1.6, 0.6 + impact * 0.06));
      if (impact > 8) this.feel.slowMo(0.6, 0.25);
    } else {
      this.audio.land(impact);
      this.fx.dust(p.mesh.position);
    }
  }

  /** 码头跳台起飞（下水）/ 冲上滑道（上岸） */
  onLaunch(p, kind) {
    this.audio.jump();
    this.audio.whoosh(0, 0.9);
    this.feel.slowMo(0.5, 0.45);
    this.feel.shake.add(0.2);
    p.score += 300;
    if (kind === 'land') this.fx.splash(p.mesh.position, 0.9);
  }

  /** 模型切换的那一刻（在空中）：横幅提示 */
  onWaterChange(p, on) {
    if (this.state !== 'playing') return;
    this.hud.banner(on ? 'toWater' : 'toLand');
    this.bloomKick = Math.max(this.bloomKick, 0.4);
    if (!on) this.fx.impact(p.mesh.position, 0.6);
  }

  onShieldBreak(p = this.player) {
    this.audio.shield();
    this.feel.shake.add(0.25);
    this.flashFor(p, '#5ad1ff', 0.3);
    this.popAt(p, t('shieldBlock'), p.mesh.position);
  }

  /** 道具：电磁脉冲 —— 周围 24 米内的警车全部瘫痪爆炸，坦克、直升机也逃不掉 */
  empBlast(p) {
    const R = 24, pos = p.mesh.position, sp = this.spawner;
    this.fx.empWave(pos, R);
    this.audio.emp();
    this.feel.shake.add(0.45);
    this.feel.zoomKick += 0.08;
    this.bloomKick = 1.4;
    this.flashFor(p, '#46e6ff', 0.35);
    for (const c of sp.police) if (c.collidable && c.mesh.position.distanceTo(pos) < R) c.explode(this, p);
    for (const tk of sp.tanks) if (tk.collidable && tk.mesh.position.distanceTo(pos) < R) tk.destroy(this, p);
    if (sp.heli.collidable && sp.heli.mesh.position.distanceTo(pos) < R + 12) sp.heli.damage(this, p);
  }

  /** 道具：导弹 —— 三枚追踪导弹打最近的三个目标（警车 / 坦克 / 直升机），没有目标就往前打 */
  fireMissiles(p) {
    const sp = this.spawner, pos = p.mesh.position;
    const targets = [...sp.police, ...sp.tanks, sp.heli]
      .filter((e) => e.collidable && e.mesh.position.distanceTo(pos) < 140)
      .sort((a, b) => a.mesh.position.distanceTo(pos) - b.mesh.position.distanceTo(pos));
    while (targets.length < 3) targets.push(null);
    this.missiles.fire(p, targets);
    this.feel.shake.add(0.15);
  }

  /** 开上加速带 */
  onBoostPad(p) {
    p.boost(2.4);
    this.audio.dash();
    this.speedKick = 1;
    this.feel.zoomKick -= 0.05;
    this.flashFor(p, '#46e6ff', 0.15);
    this.fx.decal('ring', p.mesh.position, 0.4, 8, 0x46e6ff);
    this.popAt(p, t('boostPad'), p.mesh.position, true);
    p.score += 100;
  }

  /** 双人对战：开上对手丢的油渍 */
  onSlip(p) {
    this.popAt(p, t('slipped'), p.mesh.position, true);
    this.audio.impact(0.6, 1);
  }

  /** 压到钉刺带：爆胎（速度骤降、掉血、火花） */
  onSpikes(p, strip) {
    this.popAt(p, t('flatTire'), p.mesh.position, true);
    this.audio.impact(1.3, 1);
    this.feel.shake.add(0.35);
    const pos = p.mesh.position.clone();
    pos.y += 0.3;
    for (let i = 0; i < 26; i++) this.fx.spark(pos, new THREE.Vector3((Math.random() - 0.5) * 10, Math.random() * 5, (Math.random() - 0.5) * 10), 0.5);
    this.flashFor(p, '#ff7a1a', 0.3);
  }

  /** 和逆行车相撞 */
  onHeadOn(p, headOn) {
    this.popAt(p, t('headOn'), p.mesh.position, true);
    this.feel.shake.add(headOn ? 0.6 : 0.3);
  }

  /** 双人对战：用冲刺撞飞对手 */
  onPlayerVsPlayer(hitter, victim) {
    hitter.score += 500;
    this.popAt(hitter, t('vsHit') + ' +500', victim.mesh.position, true);
    this.feel.shake.add(0.3);
    this.audio.impact(1.2, 1);
  }

  // ---------------- 过关 ----------------
  completeLevel() {
    this.state = 'complete';
    const lv = this.level, p = this.player;
    const goals = [
      { key: 'goalFinish', done: true },
      { key: 'goalKills', vars: { n: lv.kills, k: p.kills }, done: p.kills >= lv.kills },
      { key: 'goalHp', done: p.hp >= p.maxHp * 0.5 },
    ];
    const stars = goals.filter((g) => g.done).length;
    const pr = this.progress;
    pr.stars[lv.id] = Math.max(pr.stars[lv.id] ?? 0, stars);
    pr.unlocked = Math.max(pr.unlocked, Math.min(LEVELS.length, lv.id + 1));
    this.save('progress', JSON.stringify(pr));
    this.feel.slowMo(0.3, 0.8);
    this.hud.flash('#fff6d8', 0.5);
    this.audio.sting(true);
    const hasNext = LEVELS.indexOf(lv) < LEVELS.length - 1;
    this.prog.endRun();
    const coins = { run: this.prog.runCoins, total: this.prog.coins };
    setTimeout(() => this.hud.showComplete({ stars, goals, score: Math.floor(p.score), kills: p.kills, hasNext, coins }), 900);
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
  /** by：造成摧毁的玩家（冲刺撞、开炮）；被引诱撞车、被炸弹波及时为空 → 记给离得最近的玩家 */
  onEnemyDestroyed(enemy, power, reason, by) {
    if (this.state !== 'playing') return;
    const p = this.isPlayer(by) ? by : this.nearestPlayer(enemy.z);
    p.kills++;
    this.prog.earn(enemy.type === 'tank' ? 40 : enemy.type === 'swat' ? 10 : 5);
    this.addFever(enemy.type === 'tank' ? 0.4 : 0.12, p);
    this.missionEvent('kills');
    if (p.isDashing) this.missionEvent('dashCombo', ++p.dashKills, 'max');
    p.combo++;
    p.comboTimer = CONFIG.score.comboWindow;
    const pts = Math.round((CONFIG.score[enemy.type] ?? 300) * Math.min(p.combo, 8) * RUN.diff.reward);
    p.score += pts;
    this.popAt(p, reason === 'crash' ? t('lured', { pts }) : `+${pts}`, enemy.mesh.position, p.combo > 2);
    p.extendDash();
    this.feel.onEnemyDestroyed(power, p.combo);
    this.bloomKick = Math.max(this.bloomKick, 0.45 * power); // 爆炸瞬间光晕冲高
    this.flashFor(p, '#fff6d8', 0.25 + 0.1 * power);
    p.bust = Math.max(0, p.bust - 0.3);
  }

  onPropSmashed(entity, pts, p = this.player) {
    if (this.state !== 'playing') return;
    p.score += pts;
    this.feel.shake.add(0.12);
  }

  /** 被追尾/被侧挤（不是玩家失误）：只有轻微火花和极小的震动，不闪红、不扣血 */
  onPlayerBumped(player) {
    this.fx.impact(player.mesh.position, 0.35);
    this.feel.shake.add(0.06);
  }

  onPlayerHit(damage, p = this.player) {
    this.feel.onPlayerHit(damage);
    this.flashFor(p, '#ff2a2a', 0.3);
  }

  gameOver(reason) {
    if (this.state !== 'playing') return;
    this.state = 'over';
    const p = this.player;
    if (reason === 'WRECKED') this.fx.explosion(p.mesh.position, 1.6);
    p.alive = false;
    this.feel.hitStop(0.2, 0.05);
    this.feel.slowMo(0.3, 0.8);
    this.feel.shake.add(0.6);
    this.audio.sting(false);
    const score = Math.floor(p.score), distance = Math.floor(p.distance);
    this.best = Math.max(this.best, score);
    this.save('best', this.best);
    let bestLabel = null;
    if (!this.level) {
      // 无尽模式额外记录最远距离
      this.bestDist = Math.max(this.bestDist, distance);
      this.save('bestDist', this.bestDist);
      bestLabel = { key: 'bestDist', vars: { d: this.bestDist } };
    }
    this.prog.endRun();
    const coins = { run: this.prog.runCoins, total: this.prog.coins };
    setTimeout(() => this.hud.showGameOver(reason, { score, distance, kills: p.kills, best: this.best, bestLabel, coins }), 1300);
  }

  // ---------------- 主循环 ----------------
  tick(now) {
    const frame = Math.min(0.05, (now - this.last) / 1000);
    this.update(frame);
    this.last = now;
    // 第一人称后视镜：每隔几帧渲染一次身后的画面（双人时两面镜子轮流更新）
    if (this.cameraMode === 'first') {
      this.mirrorFrame = (this.mirrorFrame ?? 0) + 1;
      const every = this.versus ? 3 : 3, i = this.versus ? Math.floor(this.mirrorFrame / every) % 2 : 0;
      if (this.mirrorFrame % every === 0) {
        const p = this.players[i];
        this.cockpits[i].renderMirror(this.renderer, this.scene, p.mesh.position, p.mesh.rotation.y);
      }
    }
    this.watchPerformance(frame);
    this.bloomKick = damp(this.bloomKick, 0, 6, frame);
    if (this.versus) {
      this.renderSplit();
    } else if (this.bloomOn) {
      this.bloom.strength = 0.7 + this.bloomKick;
      this.composer.render(frame);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    requestAnimationFrame((t) => this.tick(t));
  }

  /** 双人分屏：同一个场景用两台镜头各画半边（阴影贴图每帧只算一次） */
  renderSplit() {
    const r = this.renderer, size = r.getSize(tmpSize), w = size.x, h = size.y, half = Math.floor(w / 2);
    r.setScissorTest(true);
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = true;
    this.rigs.forEach((rig, i) => {
      const x = i ? w - half : 0;
      r.setViewport(x, 0, half, h);
      r.setScissor(x, 0, half, h);
      this.fx.setPixelScale(r.domElement.height / (2 * Math.tan((rig.cam.fov * Math.PI) / 360)), true);
      r.render(this.scene, rig.cam);
    });
    r.shadowMap.autoUpdate = true;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
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
    // 改装站界面 / 暂停 / 开局倒数时整个世界停住，只保留镜头和界面
    if (this.state === 'upgrade' || this.state === 'paused' || this.state === 'countdown') {
      if (this.state === 'countdown') this.updateCountdown(realDt);
      this.updateCamera(realDt);
      this.hud.update(this, realDt);
      return;
    }
    this.feel.update(realDt);
    const dt = realDt * this.feel.timeScale; // 顿帧/慢动作只影响游戏时间
    this.time += dt;

    for (const p of this.players) p.update(dt);
    this.levels.update(this.leader.z, this.trailZ);
    if (this.state !== 'title') this.spawner.update(dt);
    this.features.update(dt);
    for (const c of this.cannons.slice(0, this.players.length)) c.update(dt);
    if (this.state === 'playing') this.updatePlaying(dt);
    this.missiles.update(dt);
    for (const p of this.players) {
      if (p.isDashing) this.fx.dashTrail(p);
      if ((p.isDashing || p.boosting) && !p.onWater && p.alive) this.fx.exhaust(p); // 排气管喷火
      this.fx.damageSmoke(p, dt); // 受损冒烟 / 着火
    }

    this.world.update(this.leader.z, this.trailZ);
    this.updateWakes(dt);
    this.fx.update(dt);
    this.updateAudio(realDt);
    updateSirens(this.time);
    updateWater(this.time);
    this.updateEnvironment(realDt);
    this.updateCamera(realDt);
    this.hideNearCamera();
    this.updateOverlays(realDt);
    this.hud.update(this, realDt);
  }

  /** 速度线 + 低血量红色暗角（单人模式） */
  updateOverlays(dt) {
    const p = this.player, live = this.state === 'playing' && !this.versus;
    const fast = clamp((p.speed * 3.6 - 150) / 100, 0, 0.5) + (p.isDashing || p.boosting ? 0.9 : 0) + (p.rampage > 0 ? 0.4 : 0);
    this.speedLines.update(dt, live ? fast : 0);
    const ratio = p.hp / p.maxHp, danger = live && ratio < 0.35 ? (0.35 - ratio) / 0.35 : 0;
    const pulse = 0.7 + 0.3 * Math.sin(performance.now() * 0.006 * (1 + danger));
    this.lowHp.style.opacity = (Math.min(1, 0.35 + danger) * pulse * (danger > 0 ? 1 : 0)).toFixed(3);
  }

  /**
   * 速度分级：分数每突破 CONFIG.pace.scores 里的一个门槛升一级，
   * 整体速度倍率 RUN.pace 在两三秒内平滑地加上去（不是瞬间变快）。
   */
  updatePace(dt) {
    const C = CONFIG.pace, score = this.paceScore();
    let lv = 1;
    while (lv < C.scores.length && score >= C.scores[lv]) lv++;
    if (lv > this.speedLevel) {
      this.speedLevel = RUN.heat = lv; // 难度跟着速度一起升级
      this.hud.banner('speedUp', { n: lv });
      this.audio.speedUp();
      this.feel.shake.add(0.15);
      this.feel.zoomKick += 0.06;
      this.speedKick = 1;
    }
    RUN.pace = damp(RUN.pace, Math.min(C.max, C.start + C.step * (lv - 1)), 0.9, dt);
    this.speedKick = Math.max(0, (this.speedKick ?? 0) - dt);
  }

  /** 双人对战时两人共用一个速度等级（按分数高的那位算），保证公平 */
  paceScore() {
    return Math.max(...this.players.map((p) => p.score));
  }

  /** 每位玩家每帧的结算：分数、连击、被捕条、擦边 */
  updateRun(p, dt) {
    p.distance = Math.max(p.distance, p.z);
    p.score += p.speed * dt * CONFIG.score.perMeter * (p.isDashing ? 2 : 1) * RUN.diff.reward;
    if (p.comboTimer > 0 && (p.comboTimer -= dt) <= 0) p.combo = 0;
    // 被捕判定：被 2 辆以上警车贴身包夹时，被捕条持续上涨（冲刺、暴走、飞在空中时不会被捕）
    const boxed = !p.isDashing && !p.airborne && p.rampage <= 0 && this.spawner.copsNear(p, 5.5, 5.5) >= 2;
    const bustRate = 0.55 * RUN.diff.bust * (1 + CONFIG.heat.bust * (RUN.heat - 1));
    p.bust = clamp(p.bust + (boxed ? bustRate : -0.7) * dt, 0, 1);
    this.checkNearMiss(p);
  }

  updatePlaying(dt) {
    this.updatePace(dt);
    resolveCollisions(this);
    for (const p of this.players) this.updateRun(p, dt);
    const lead = this.leader;

    if (this.versus) {
      // 落后的一方获得追赶加速，两辆车不会拉开太远（分屏和阴影都需要两人离得近）
      const [a, b] = this.players, gap = Math.abs(a.z - b.z);
      const back = a.z < b.z ? a : b, front = back === a ? b : a;
      back.draft = clamp((gap - 18) * 0.3, 0, 12);
      front.draft = 0;
    } else {
      // 路口：决策区内按车道选出口，并显示岔路面板
      this.hud.showJunction(this.levels.junction, lead.z);
      // 路障预警：前方 warnDistance 米内有路障就显示 UI 车道示意（钉刺带标题不一样）
      const rb = this.spawner.nextBarricade(lead.z, CONFIG.barricade.warnDistance);
      this.hud.showRoadblock(rb ? rb.blocked : null, rb?.spikes);
      // 逆行来车预警：前方 150 米内有迎面开来的车，显示它在哪条车道
      const lanes = [];
      for (const c of this.spawner.traffic) {
        if (c.oncoming && c.collidable && c.z > lead.z && c.z - lead.z < 150) lanes.push(nearestLane(c.lateral));
      }
      this.hud.showOncoming(lanes.length ? lanes : null);
    }
    this.levels.followLane(lead.lane, lead.z);

    // 每跑 100 米 1 枚金币；距离任务
    const hundreds = Math.floor(lead.distance / 100);
    if (hundreds > this.coinDist) {
      this.prog.earn(hundreds - this.coinDist);
      this.coinDist = hundreds;
      this.missionEvent('distance', lead.distance, 'max');
    }

    const biome = Road.biomeAt(lead.z);
    if (biome !== this.biome) {
      this.biome = biome;
      this.hud.banner(biome);
    }
    if (this.versus) {
      if (this.players.some((p) => !p.alive || p.bust >= 1)) this.endVersus();
      return;
    }
    const p = this.player;
    if (!p.alive) this.gameOver('WRECKED');
    else if (p.bust >= 1) this.gameOver('BUSTED');
    else if (this.level && p.z >= this.level.length) this.completeLevel();
  }

  /** 海上：所有船的尾浪 / 船头水花 */
  updateWakes(dt) {
    const fx = this.fx;
    for (const p of this.players) {
      if (p.onWater && p.alive && !p.airborne) fx.wake(p.mesh.position, p.mesh.rotation.y, p.speed, p.width, p.length, dt, 1, p.isDashing || p.rampage > 0);
    }
    const lz = this.leader.z, tz = this.trailZ;
    for (const e of this.spawner.entities) {
      if (!e.onWater || !e.collidable || e.speed < 2 || e.z > lz + 120 || e.z < tz - 60) continue;
      fx.wake(e.mesh.position, e.mesh.rotation.y, e.speed, e.width, e.length, dt, 0.45);
    }
  }

  /** 持续音：引擎、警笛、直升机、风声、轮胎尖叫（+ 转弯时的轮胎烟） */
  updateAudio(dt) {
    const p = this.leader, pp = p.mesh.position;
    let near = 99;
    for (const c of this.spawner.police) {
      if (!c.collidable || c.mode !== 'chase') continue;
      for (const pl of this.players) near = Math.min(near, c.mesh.position.distanceTo(pl.mesh.position));
    }
    const heli = this.spawner.heli;
    const h = Road.heading(p.z), turn = this.lastHeading === undefined ? 0 : Math.abs(dampAngle(0, h - this.lastHeading, 1e9, 1)) / Math.max(dt, 1e-3);
    this.lastHeading = h;
    const screech = this.state === 'playing' && !p.airborne && !p.onWater ? clamp((turn - 0.6) * 0.8, 0, 1) + clamp((Math.abs(p.latVel) - 7) * 0.15, 0, 0.5) : 0;
    if (screech > 0.3 && Math.random() < 0.5) this.fx.smokePuffAt(pp, { x: 0, y: 0.6, z: 0 }, 0.9, 1.4, 0.62, 0.2);
    this.audio.update({
      speed01: clamp(p.speed / 60, 0, 1),
      dashing: p.isDashing,
      rampage: p.rampage > 0,
      heavy: !!p.tier.ram,
      water: p.onWater,
      siren: this.state === 'title' ? 0 : clamp(1 - near / 45, 0, 1),
      rotor: heli.active ? clamp(1 - heli.mesh.position.distanceTo(pp) / 90, 0, 1) : 0,
      screech,
      playing: this.state === 'playing',
    });
  }

  updateEnvironment(dt) {
    const lead = this.leader;
    const b = BIOMES[Road.biomeAt(lead.z + 30)];
    const k = 1 - Math.exp(-1.5 * dt);
    this.skyColor.lerp(tmpColor.setHex(b.sky), k);
    this.scene.fog.color.copy(this.skyColor);
    // 追尾视角看得到天空：白天用真实天空 HDRI，夜城用纯色夜空
    const useSky = this.cameraMode === 'chase' && this.skyTex && !b.night;
    this.scene.background = useSky ? this.skyTex : this.skyColor;
    this.scene.backgroundIntensity = 0.85;
    const env = b.night ? this.nightEnv : this.dayEnv;
    if (this.scene.environment !== env) this.scene.environment = env;
    this.ground.material.color.lerp(tmpColor.setHex(b.ground), k);
    // 夜晚地图把太阳和天光调暗，让霓虹和发光窗户成为主光源
    this.sun.intensity = damp(this.sun.intensity, b.night ? 0.35 : 2.6, 1.5, dt);
    this.hemi.intensity = damp(this.hemi.intensity, b.night ? 0.55 : 1.5, 1.5, dt);
    // 附近有海上路段时，远处的全局地面降到水面以下（否则会盖住海面）
    const seaNear = Road.path.hasBiome(this.trailZ - 80, lead.z + 340, 'sea');
    this.ground.position.set(this.camTarget.x, seaNear ? WATER_Y - 0.1 : -0.03, this.camTarget.z);
    this.snowWeight = damp(this.snowWeight ?? 0, b.snow ? 1 : 0, 1.5, dt);
    this.snow.update(dt, this.camTarget, this.snowWeight);
  }

  /**
   * 追尾视角：贴着镜头的车（通常是跟在后面的警车）会挡住小半个画面 → 离镜头 5.5 米以内时暂时不画。
   * 用 layers 控制“哪台镜头看得见”，不碰 visible，避免和对象池的显示/隐藏逻辑打架。
   *   layer 0：两台镜头都看得见；layer 2：只有镜头 1；layer 3：只有镜头 2；layer 1：谁都看不见
   */
  hideNearCamera() {
    const chase = this.cameraMode === 'chase', cams = this.rigs.map((r) => r.cam.position);
    const apply = (obj, skip = -1) => {
      const near0 = chase && skip !== 0 && obj.position.distanceToSquared(cams[0]) < 42;
      const near1 = chase && this.versus && skip !== 1 && obj.position.distanceToSquared(cams[1]) < 42;
      let mask = 1;
      if (near0 || near1) mask = (near0 ? 0 : 1 << 2) | (this.versus && !near1 ? 1 << 3 : 0) || 1 << 1;
      if (mask === obj.userData.camMask) return;
      obj.userData.camMask = mask;
      obj.traverse((o) => { o.layers.mask = mask; });
    };
    for (const e of this.spawner.entities) if (e.mesh) apply(e.mesh);
    const setMask = (obj, mask) => {
      if (obj.userData.camMask === mask) return;
      obj.userData.camMask = mask;
      obj.traverse((o) => { o.layers.mask = mask; });
    };
    for (const p of this.players) {
      // 第一人称：自己的车身对自己的镜头隐藏（只看驾驶舱）；双人时对手的镜头照样看得到
      if (this.cameraMode === 'first') setMask(p.mesh, this.versus ? 1 << (p.index ? 2 : 3) : 1 << 1);
      else if (this.versus) apply(p.mesh, p.index);
      else setMask(p.mesh, 1);
    }
  }

  /** 头顶 P1/P2 标签：双人对战才显示；第一人称时会挡住视线，隐藏 */
  updateTags() {
    for (const p of [this.player, this.player2]) if (p) p.tag.visible = this.versus && this.cameraMode !== 'first';
  }

  /** 视角快速切换：第三人称 → 第一人称 → 俯视（双人分屏只在前两种之间切） */
  cycleCamera(announce = true) {
    const order = this.versus ? ['chase', 'first'] : ['chase', 'first', 'iso'];
    const next = order[(order.indexOf(this.cameraMode) + 1) % order.length];
    this.setCameraMode(next);
    this.hud.setCamLabel(next);
    if (announce) this.hud.banner('cam_' + next);
  }

  /** 切换视角。save = false 时不记住（双人对战临时切换） */
  setCameraMode(mode, save = true) {
    this.cameraMode = mode;
    // 俯视角时镜头一侧的楼要压低：切换视角后按新规则重建周围的区块
    const tall = mode !== 'iso';
    if (CONFIG.world.tallNear !== tall) {
      CONFIG.world.tallNear = tall;
      this.world.reset();
      this.world.update(this.leader.z, this.trailZ);
    }
    if (save) this.save('camera', mode);
    this.camera = mode === 'iso' ? this.ortho : this.persp;
    this.renderPass.camera = this.camera;
    for (const r of this.rigs) {
      r.init = false;
      r.cam.near = mode === 'first' ? 0.05 : 0.3; // 第一人称镜头在车里，近裁剪面要很近
      r.cam.updateProjectionMatrix();
    }
    this.updateTags();
    this.hud.setCamLabel(mode);
    this.resize();
  }

  updateCamera(dt) {
    const first = this.cameraMode === 'first';
    for (const p of this.players) p.firstPerson = first;
    this.cockpits.forEach((c, i) => { c.group.visible = first && i < this.players.length; });
    if (this.versus) {
      this.players.forEach((p, i) => this.updatePerspCamera(dt, this.rigs[i], p));
      this.camTarget.copy(this.rigs[0].target).lerp(this.rigs[1].target, 0.5); // 阴影、地面、雪跟着两人中间
      this.placeSun();
      return;
    }
    if (this.cameraMode !== 'iso') {
      this.updatePerspCamera(dt, this.rigs[0], this.player);
      this.camTarget.copy(this.rigs[0].target);
      this.fx.setPixelScale(this.renderer.domElement.height / (2 * Math.tan((this.persp.fov * Math.PI) / 360)), true);
      this.placeSun();
      return;
    }
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
    this.fx.setPixelScale(this.renderer.domElement.height / ((cam.top - cam.bottom) / cam.zoom), false);
    cam.updateProjectionMatrix();
    this.placeSun();
  }

  placeSun() {
    this.sun.position.copy(this.camTarget).add(this.sunOffset);
    this.sun.target.position.copy(this.camTarget);
  }

  updatePerspCamera(dt, rig, p) {
    if (this.cameraMode === 'first') this.updateFirstPerson(dt, rig, p);
    else this.updateChaseCamera(dt, rig, p);
  }

  /**
   * 第一人称：镜头在驾驶座的眼睛位置，跟着车头方向；变道时随车身轻微侧倾，冲刺时视野变广。
   * 真车模型有内饰（仪表台、方向盘、A 柱），所以看得到“坐在车里”的感觉；开船时在驾驶台上。
   */
  updateFirstPerson(dt, rig, p) {
    const cam = rig.cam, m = p.mesh, u = m.userData, cockpit = this.cockpits[rig === this.rigs[0] ? 0 : 1];
    // 眼睛高度：轿跑约 1.15 米；船站在驾驶台上更高；坦克从炮塔舱口看出去
    const eye = (u.boat ? 1.55 : p.tier.cannon ? 2.5 : p.tier.ram ? 1.5 : 1.15) * p.sizeMul;
    const h = m.rotation.y, fwd = 0.1 * p.length * p.sizeMul;
    cam.position.set(m.position.x + Math.sin(h) * fwd, m.position.y + eye, m.position.z + Math.cos(h) * fwd);
    cam.position.addScaledVector(this.feel.shake.offset, 0.2);
    // 高速时轻微的路面震动
    const t = performance.now() * 0.001, rumble = Math.min(1, p.speed / 45) * (p.onWater ? 0.012 : 0.004);
    cam.position.y += Math.sin(t * 37) * rumble + Math.sin(t * 23) * rumble * 0.6;
    const ahead = Road.sample(p.z + 30, p.lateral * 0.6 + p.latVel * 0.12, SAMPLE);
    if (!rig.init) { rig.target.set(ahead.x, 0, ahead.z); rig.init = true; rig.lastH = Road.heading(p.z); rig.lastSpeed = p.speed; }
    rig.target.x = damp(rig.target.x, ahead.x, 10, dt);
    rig.target.z = damp(rig.target.z, ahead.z, 10, dt);
    cam.lookAt(rig.target.x, m.position.y + eye * 0.86, rig.target.z);
    cam.rotateZ(-(p.root?.rotation.z ?? 0) * 0.6 + this.feel.shake.roll * 0.3);
    const fov = 70 + (p.isDashing || p.boosting ? 12 : 0) + (p.rampage > 0 ? 6 : 0) + (this.speedKick ?? 0) * 8 + (RUN.pace - 1) * 10;
    cam.fov = damp(cam.fov, fov / this.feel.zoom, 6, dt);
    cam.updateProjectionMatrix();
    // 驾驶舱：方向盘跟着变道和弯道转，仪表显示车速 / 转速 / 档位
    const hd = Road.heading(p.z), turn = Math.atan2(Math.sin(hd - rig.lastH), Math.cos(hd - rig.lastH)) / Math.max(dt, 1e-3);
    rig.lastH = hd;
    const accel = (p.speed - rig.lastSpeed) / Math.max(dt, 1e-3);
    rig.lastSpeed = p.speed;
    cockpit.setPaint(this.hoodColor(p));
    cockpit.update(dt, cam, { steer: clamp(p.latVel * 0.06 + turn * 2, -1, 1), speed: p.speed, boost: p.isDashing || p.boosting, accel });
  }

  /** 第一人称时挡风玻璃外引擎盖的颜色（跟着当前车辆 / 船、玩家 1 / 2） */
  hoodColor(p) {
    const P1 = { sports: 0xb3140f, muscle: 0x1a1b1e, armored: 0x55603f, tank: 0xb8322a };
    const P2 = { sports: 0xe6e3dc, muscle: 0xe6e3dc, armored: 0x4a78c8, tank: 0x2f5fb8 };
    if (p.onWater && p.tier.id !== 'armored' && p.tier.id !== 'tank') return p.index ? 0xf4f6f8 : P1[p.tier.id];
    return (p.index ? P2 : P1)[p.tier.id];
  }

  /**
   * 第三人称（GTA 式）：镜头在车后上方较远处，看向前方道路，画面里能看到整辆车和周围的警车。
   * 位置、朝向都做平滑，转 90° 弯时镜头会自然甩过去；速度越快镜头拉得越远、视野越广（速度感）。
   */
  updateChaseCamera(dt, rig, p) {
    const cam = rig.cam;
    rig.yaw = rig.init ? dampAngle(rig.yaw, Road.heading(p.z), 4, dt) : Road.heading(p.z);
    const h = rig.yaw, w = Road.sample(p.z, p.lateral * 0.8, SAMPLE);
    const back = 10.5 + p.speed * 0.06, up = 4.4 + p.y * 0.5 + p.waterY * 0.8;
    const tx = w.x - Math.sin(h) * back, tz = w.z - Math.cos(h) * back;
    if (!rig.init) { rig.pos.set(tx, up, tz); rig.init = true; }
    rig.pos.x = damp(rig.pos.x, tx, 9, dt);
    rig.pos.y = damp(rig.pos.y, up, 6, dt);
    rig.pos.z = damp(rig.pos.z, tz, 9, dt);
    const ahead = Road.sample(p.z + 20, p.lateral * 0.5, {});
    rig.target.set(ahead.x, 0, ahead.z);
    const shake = this.versus ? 0.5 : 1;
    cam.position.copy(rig.pos).addScaledVector(this.feel.shake.offset, shake);
    cam.lookAt(ahead.x, 1.0 + p.y * 0.3 + p.waterY, ahead.z);
    cam.rotateZ(this.feel.shake.roll * 0.6 * shake);
    const fov = 58 + (p.isDashing ? 10 : 0) + (p.rampage > 0 ? 6 : 0) + (this.speedKick ?? 0) * 8 + (RUN.pace - 1) * 10; // 越快视野越广
    cam.fov = damp(cam.fov, fov / this.feel.zoom, 6, dt);
    cam.updateProjectionMatrix();
  }

  resize() {
    const w = innerWidth, h = innerHeight, aspect = w / h;
    this.renderer.setSize(w, h);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(w, h);
    const C = CONFIG.camera;
    const halfW = Math.max(C.minWidth / 2, (C.minHeight / 2) * aspect), halfH = halfW / aspect;
    Object.assign(this.ortho, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    this.ortho.updateProjectionMatrix();
    // 双人分屏：每台镜头只占一半宽度
    this.rigs.forEach((r, i) => {
      r.cam.aspect = this.versus ? w / 2 / h : aspect;
      r.cam.updateProjectionMatrix();
      r.vp = this.versus ? { x: i * 0.5, w: 0.5 } : { x: 0, w: 1 };
    });
    // 追尾视角看得远，雾也推远
    this.scene.fog.near = this.cameraMode === 'chase' ? 80 : 70;
    this.scene.fog.far = this.cameraMode === 'chase' ? 300 : 170;
    this.lookMul = aspect < 1 ? 1.5 : 0.7; // 竖屏时看得更远
    // 竖屏屏幕窄，把镜头转正一点，让道路更接近竖直方向
    this.camOffset.set(...C.offset);
    if (aspect < 1) this.camOffset.x *= 0.45;
  }
}

// 单人模式的“这一局成绩”直接读写玩家 1 身上的数据（game.score === game.player.score）
for (const k of RUN_STATS) {
  Object.defineProperty(Game.prototype, k, {
    get() { return this.player[k]; },
    set(v) { this.player[k] = v; },
  });
}

// 先加载 3D 模型（最多等 10 秒），再启动游戏；加载失败的模型会自动用方块模型代替
Promise.race([Promise.all([loadModels(), loadEnvModels()]), new Promise((r) => setTimeout(r, 10000))]).finally(() => {
  window.game = new Game(); // 挂到 window 上方便在控制台调试
  // 高精度主角车在后台加载，好了就换上（开着跑车/赛车时）
  loadHero(window.game.renderer).then(() => {
    window.game.spawner.upgradeModels(); // 警车、私家车换成真车
    for (const p of window.game.players.concat(window.game.player2 ?? [])) {
      if (p.tierIndex <= 1 && !p.onWater) { p.setTier(p.tierIndex); p.syncMesh(0); }
    }
    if (window.game.player2 && !window.game.versus) window.game.scene.remove(window.game.player2.mesh);
  }).catch((e) => console.warn('[hero] 高精度车模加载失败，继续使用普通车模', e));
});
