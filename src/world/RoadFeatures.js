import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Road, ROAD_HALF, laneOffset } from './Road.js';

// 码头边缘（陆地和海面交界）前后不放道具和跳台
const nearDock = (z, r) => Road.isWater(z - r) !== Road.isWater(z + r);
import { GEO } from '../models/Models.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rand, randInt } from '../core/utils.js';
import { t, onLangChange } from '../i18n.js';

const F = CONFIG.features;
// 路口方框和转弯处不放道具/跳台
const nearJunction = (z) => Road.path.nearJunction(z - 6, z + 6, 30, 40);
const LANES = CONFIG.road.lanes;

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 道具：圆形图标（用 Sprite 渲染，永远面向镜头）
const PICKUPS = {
  shield: { color: '#2f9bff', icon: '🛡️' },
  nitro: { color: '#ffb020', icon: '⚡' },
  repair: { color: '#2ecc71', icon: '🔧' },
  emp: { color: '#16b8e8', icon: '💠' }, // 电磁脉冲：周围的警车全部瘫痪爆炸
  missile: { color: '#e8410f', icon: '🚀' }, // 导弹：三枚追踪导弹打最近的警车
  oil: { color: '#3a3a3a', icon: '🛢️' }, // 油渍：身后铺一片油，追上来的警车打滑翻车
  magnet: { color: '#ffcc00', icon: '🧲' }, // 金币磁铁：10 秒内附近的金币自己飞过来
};
// 抽道具的权重（攻击道具稍微少一点）
const PICKUP_POOL = ['shield', 'shield', 'nitro', 'nitro', 'repair', 'repair', 'emp', 'missile', 'missile', 'oil', 'oil', 'magnet'];

// 加速带：路面上发光的青色箭头，箭头会往前流动
const BOOST_TEX = (() => {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(30,200,255,0.25)';
  g.fillRect(0, 0, 128, 256);
  g.fillStyle = 'rgba(255,255,255,0.95)';
  for (let k = 0; k < 2; k++) {
    const y = 40 + k * 128;
    g.beginPath();
    g.moveTo(14, y + 60); g.lineTo(64, y); g.lineTo(114, y + 60); g.lineTo(114, y + 88); g.lineTo(64, y + 30); g.lineTo(14, y + 88);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 2);
  return t;
})();
const BOOST_MAT = new THREE.MeshBasicMaterial({ map: BOOST_TEX, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
BOOST_MAT.color.setRGB(0.6, 2.2, 3.2);
const BOOST_GEO = new THREE.PlaneGeometry(3.0, 7).rotateX(-Math.PI / 2);
const pickupTex = {};
function pickupMaterial(kind) {
  if (!pickupTex[kind]) {
    const k = PICKUPS[kind];
    pickupTex[kind] = new THREE.SpriteMaterial({
      map: canvasTexture(128, 128, (g) => {
        g.fillStyle = k.color;
        g.strokeStyle = '#fff';
        g.lineWidth = 8;
        g.beginPath();
        g.arc(64, 64, 54, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.font = '64px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(k.icon, 64, 70);
      }),
      depthWrite: false,
    });
  }
  return pickupTex[kind];
}

// 道具底座：地上的发光圆环 + 往上渐隐的光柱 + 绕着图标转的光环（同一种道具共用材质）
const BEAM_TEX = canvasTexture(4, 128, (g) => {
  const gr = g.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0, 'rgba(255,255,255,0)');
  gr.addColorStop(0.7, 'rgba(255,255,255,0.35)');
  gr.addColorStop(1, 'rgba(255,255,255,0.9)');
  g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
});
const PICKUP_GEO = {
  ring: new THREE.RingGeometry(1.05, 1.35, 48).rotateX(-Math.PI / 2),
  disc: new THREE.CircleGeometry(1.05, 40).rotateX(-Math.PI / 2),
  beam: new THREE.CylinderGeometry(0.95, 1.05, 6, 28, 1, true).translate(0, 3, 0),
  halo: new THREE.TorusGeometry(1.2, 0.06, 8, 48),
};
const glowMats = {};
function glowMaterials(kind) {
  if (!glowMats[kind]) {
    const c = new THREE.Color(PICKUPS[kind].color === '#3a3a3a' ? '#b98cff' : PICKUPS[kind].color);
    glowMats[kind] = {
      ring: new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: c.clone().multiplyScalar(3) }),
      disc: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, color: c.clone() }),
      beam: new THREE.MeshBasicMaterial({ map: BEAM_TEX, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, color: c.clone().multiplyScalar(1.4) }),
      halo: new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(2.6) }),
    };
  }
  return glowMats[kind];
}

// 路面箭头：每条车道通往哪个出口（白色箭头，按出口方向旋转）
const ARROW_ANGLE = { left: -90, forkLeft: -45, straight: 0, forkRight: 45, right: 90 };
const arrowMats = {};
function arrowMaterial(key) {
  if (!arrowMats[key]) {
    arrowMats[key] = new THREE.MeshBasicMaterial({
      map: canvasTexture(128, 128, (g) => {
        g.translate(64, 64);
        g.rotate((ARROW_ANGLE[key] * Math.PI) / 180);
        g.fillStyle = 'rgba(255,255,255,0.92)';
        g.beginPath();
        g.moveTo(0, -56); g.lineTo(34, -14); g.lineTo(12, -14); g.lineTo(12, 52);
        g.lineTo(-12, 52); g.lineTo(-12, -14); g.lineTo(-34, -14);
        g.closePath();
        g.fill();
      }),
      transparent: true,
      depthWrite: false,
    });
  }
  return arrowMats[key];
}

// 黄黑警示斜纹（跳台侧板 / 大门底座用）
const HAZARD_TEX = (() => {
  const t = canvasTexture(64, 64, (g) => {
    g.fillStyle = '#16171a'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#f2b705';
    for (let x = -64; x < 128; x += 32) { g.beginPath(); g.moveTo(x, 64); g.lineTo(x + 16, 64); g.lineTo(x + 80, 0); g.lineTo(x + 64, 0); g.closePath(); g.fill(); }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
})();
const HAZARD_MAT = new THREE.MeshStandardMaterial({ map: HAZARD_TEX, roughness: 0.5, metalness: 0.4 });

// 跳台斜面：防滑花纹钢板 + 两边黄黑警示边 + 往前指的白色箭头
const RAMP_TEX = canvasTexture(256, 512, (g, w, h) => {
  g.fillStyle = '#7b8087'; g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 16) {
    for (let x = (y / 16) % 2 ? 8 : 0; x < w; x += 16) {
      const a = ((x + y) / 16) % 2 ? 0.7 : -0.7;
      g.save(); g.translate(x + 4, y + 4); g.rotate(a);
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(-5, -1.6, 10, 1.6);
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(-5, 0, 10, 1.6);
      g.restore();
    }
  }
  for (const x0 of [0, w - 28]) {
    g.save(); g.beginPath(); g.rect(x0, 0, 28, h); g.clip();
    g.fillStyle = '#16171a'; g.fillRect(x0, 0, 28, h);
    g.fillStyle = '#f2b705';
    for (let y = -40; y < h + 40; y += 40) { g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + 28, y - 28); g.lineTo(x0 + 28, y - 8); g.lineTo(x0, y + 20); g.closePath(); g.fill(); }
    g.restore();
  }
  g.fillStyle = 'rgba(255,255,255,0.9)';
  for (const y of [110, 250, 390]) { g.beginPath(); g.moveTo(128, y - 50); g.lineTo(196, y + 20); g.lineTo(196, y + 52); g.lineTo(128, y - 18); g.lineTo(60, y + 52); g.lineTo(60, y + 20); g.closePath(); g.fill(); }
});
const RAMP_MAT = new THREE.MeshStandardMaterial({ map: RAMP_TEX, roughness: 0.45, metalness: 0.75, side: THREE.DoubleSide });
const RAMP_STEEL = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.3, metalness: 1 });

function quad(a, b, c, d, uv = [[0, 0], [1, 0], [1, 1], [0, 1]]) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([...uv[0], ...uv[1], ...uv[2], ...uv[0], ...uv[2], ...uv[3]], 2));
  geo.computeVertexNormals();
  return geo;
}

// 跳台：前低后高的钢板坡道，沿局部 +Z 方向上坡；侧板 + 背板是黄黑警示纹，坡顶有一根钢管
function makeRampTemplate(w = 3.2, len = 5, h = 1.3) {
  const x = w / 2, g = new THREE.Group();
  const add = (geo, material) => { const m = new THREE.Mesh(geo, material); m.castShadow = m.receiveShadow = true; g.add(m); return m; };
  add(quad([-x, 0, 0], [x, 0, 0], [x, h, len], [-x, h, len]), RAMP_MAT);
  const sides = [];
  for (const sx of [-x, x]) {
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([sx, 0, 0, sx, 0, len, sx, h, len], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, len / 1.2, 0, len / 1.2, h / 1.2], 2));
    tri.computeVertexNormals();
    sides.push(tri);
  }
  sides.push(quad([-x, 0, len], [x, 0, len], [x, h, len], [-x, h, len], [[0, 0], [w / 1.2, 0], [w / 1.2, h / 1.2], [0, h / 1.2]]));
  add(mergeGeometries(sides), HAZARD_MAT).material.side = THREE.DoubleSide;
  const slope = Math.hypot(len, h), ang = Math.atan2(h, len), rails = [];
  for (const sx of [-x, x]) rails.push(new THREE.BoxGeometry(0.08, 0.1, slope).rotateX(-ang).translate(sx, h / 2 + 0.03, len / 2));
  rails.push(new THREE.CylinderGeometry(0.07, 0.07, w + 0.1, 10).rotateZ(Math.PI / 2).translate(0, h + 0.02, len));
  add(mergeGeometries(rails), RAMP_STEEL);
  return g;
}

/** 方形钢桁架（沿 +Y 方向，底面中心在原点）：4 根立管 + 每节横杆 + 各面斜撑 */
const trussCache = new Map();
function truss(len, w) {
  const key = len.toFixed(2) + '/' + w;
  if (!trussCache.has(key)) {
    const h = w / 2, r = 0.055, parts = [];
    const bar = (a, b, rad) => {
      const d = new THREE.Vector3().subVectors(b, a), m = new THREE.CylinderGeometry(rad, rad, d.length(), 6);
      m.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
      return m.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    };
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const corners = [[-h, -h], [h, -h], [h, h], [-h, h]];
    for (const [x, z] of corners) parts.push(bar(V(x, 0, z), V(x, len, z), r));
    const n = Math.max(2, Math.round(len / 1.0));
    for (let k = 0; k <= n; k++) {
      const y = (k / n) * len;
      for (let c = 0; c < 4; c++) {
        const [x0, z0] = corners[c], [x1, z1] = corners[(c + 1) % 4];
        parts.push(bar(V(x0, y, z0), V(x1, y, z1), r * 0.6));
        if (k < n) {
          const y1 = ((k + 1) / n) * len, flip = (k + c) % 2;
          parts.push(bar(V(x0, flip ? y : y1, z0), V(x1, flip ? y1 : y, z1), r * 0.5));
        }
      }
    }
    trussCache.set(key, mergeGeometries(parts.map((p) => p.index ? p.toNonIndexed() : p)));
  }
  return trussCache.get(key).clone();
}

/**
 * 路上的特殊设施
 *   改装站 station：大门横跨马路，开过去暂停游戏、三选一升级车辆
 *   道具 pickup  ：护盾 / 氮气 / 维修，开过去就吃到
 *   跳台 ramp    ：开上去飞起来，空中不会被撞；有时放在路障前，可以直接飞过路障
 *   终点 finish  ：闯关模式的终点线
 */
export class RoadFeatures {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.rampTemplate = makeRampTemplate();
    this.stations = [];
    this.pickups = [];
    this.ramps = [];
    this.arrows = [];
    this.arrowGeo = new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2);
    this.finish = null;
    onLangChange(() => { this.bannerTex = null; });
    this.reset();
  }

  reset() {
    for (const list of [this.stations, this.pickups, this.ramps, this.arrows, this.boosts ?? []]) {
      for (const o of list) this.scene.remove(o.obj);
      list.length = 0;
    }
    this.boosts = [];
    this.nextBoostZ = 260;
    this.arrowJunction = null;
    if (this.finish) this.scene.remove(this.finish.obj);
    this.finish = null;
    this.finishS = Infinity;
    this.nextPickupZ = F.pickupFirst;
    this.nextRampZ = F.rampFirst;
  }

  // ---------------------------------------------------------------- 生成
  bannerTexture(text, bg, fg = '#fff', led = false) {
    return canvasTexture(512, 128, (g, w, h) => {
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      if (led) { // 显示屏的渐变光泽
        const gr = g.createLinearGradient(0, 0, 0, h);
        gr.addColorStop(0, 'rgba(255,255,255,0.18)'); gr.addColorStop(0.5, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.25)');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      }
      g.fillStyle = fg;
      g.font = 'bold 64px "Arial Black", "PingFang TC", "Microsoft JhengHei", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, w / 2, h / 2 + 4);
      if (led) { // LED 点阵：每 4 像素一道暗缝
        g.fillStyle = 'rgba(0,0,0,0.38)';
        for (let x = 0; x < w; x += 4) g.fillRect(x, 0, 1, h);
        for (let y = 0; y < h; y += 4) g.fillRect(0, y, w, 1);
      }
    });
  }

  /** 横跨马路的大门：两根钢桁架立柱 + 桁架横梁 + LED 显示屏 + 射灯 + 地面发光带 */
  makeGate(s, text, bg, pillarColor) {
    const w = Road.sample(s, 0);
    const g = new THREE.Group();
    g.position.set(w.x, 0, w.z);
    g.rotation.y = w.h;
    const half = ROAD_HALF + 1.4;
    const steel = new THREE.MeshStandardMaterial({ color: pillarColor, roughness: 0.35, metalness: 0.85 });
    const parts = [];
    for (const sx of [-1, 1]) {
      parts.push(truss(7.6, 0.9).translate(sx * half, 0, 0));
      parts.push(new THREE.BoxGeometry(1.5, 0.5, 1.5).translate(sx * half, 0.25, 0)); // 底座
    }
    parts.push(truss(half * 2 + 0.9, 0.9).rotateZ(-Math.PI / 2).translate(-half - 0.45, 7.6, 0));
    const frame = new THREE.Mesh(mergeGeometries(parts.map((p) => p.index ? p.toNonIndexed() : p)), steel);
    frame.castShadow = true;
    g.add(frame);
    const box = new THREE.Mesh(GEO.box, new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.5, metalness: 0.6 }));
    box.scale.set(9.6, 2.7, 0.35);
    box.position.set(0, 6.2, -0.75);
    g.add(box);
    const ledMat = new THREE.MeshBasicMaterial({ map: this.bannerTexture(text, bg, '#fff', true), side: THREE.DoubleSide });
    ledMat.color.setScalar(1.7); // LED 屏比环境亮，配合泛光有发光感
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(9.2, 2.3), ledMat);
    banner.position.set(0, 6.2, -0.95);
    banner.rotation.y = Math.PI; // 面向来车方向
    g.add(banner);
    const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 4.6, 3.8) });
    for (const sx of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.2, 0.3, 14), lampMat);
      lamp.position.set(sx * (half - 1.4), 7.05, -0.55);
      lamp.rotation.x = -0.9;
      g.add(lamp);
    }
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 1.2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: bg, transparent: true, opacity: 0.6, depthWrite: false }));
    strip.position.y = 0.08;
    g.add(strip);
    this.scene.add(g);
    return g;
  }

  addStation(s) {
    this.stations.push({ s, obj: this.makeGate(s, `🔧 ${t('station')}`, '#1f8fff', 0x2b2f36), used: [] }); // used[玩家编号]：每位玩家各自触发一次
  }

  setFinish(s) {
    this.finishS = s;
  }

  addPickup(s, lane, kind) {
    const g = new THREE.Group(), M = glowMaterials(kind);
    const ring = new THREE.Mesh(PICKUP_GEO.ring, M.ring);
    const disc = new THREE.Mesh(PICKUP_GEO.disc, M.disc);
    const beam = new THREE.Mesh(PICKUP_GEO.beam, M.beam);
    const halo = new THREE.Mesh(PICKUP_GEO.halo, M.halo);
    ring.position.y = disc.position.y = 0.09;
    ring.renderOrder = disc.renderOrder = beam.renderOrder = 2;
    const icon = new THREE.Sprite(pickupMaterial(kind));
    icon.scale.setScalar(1.9);
    g.add(ring, disc, beam, halo, icon);
    const w = Road.sample(s, laneOffset(lane));
    g.position.set(w.x, Road.surfaceY(s), w.z);
    this.scene.add(g);
    this.pickups.push({ s, lat: laneOffset(lane), kind, obj: g, icon, halo, ring, phase: Math.random() * 6 });
  }

  addRamp(s, lane) {
    const m = this.rampTemplate.clone();
    const w = Road.sample(s, laneOffset(lane));
    m.position.set(w.x, 0, w.z);
    m.rotation.y = w.h;
    this.scene.add(m);
    this.ramps.push({ s, lat: laneOffset(lane), obj: m });
    this.game.coins?.arc(s, lane, Math.max(18, this.game.leader.speed)); // 跳台后面一道空中金币弧线
  }

  addBoost(s, lane) {
    const m = new THREE.Mesh(BOOST_GEO, BOOST_MAT);
    const w = Road.sample(s, laneOffset(lane));
    m.position.set(w.x, Road.surfaceY(s) + 0.07, w.z);
    m.rotation.y = w.h;
    m.renderOrder = 2;
    this.scene.add(m);
    this.boosts.push({ s, lat: laneOffset(lane), obj: m, used: [] });
  }

  /** 路障生成时调用：有一定概率在被堵车道前放跳台，可以直接飞过去 */
  onBarricade(z, blocked) {
    if (Road.isWater(z - 16)) return; // 海上没有跳台
    if (Math.random() < F.rampBeforeBarricade) this.addRamp(z - 16, blocked[randInt(0, blocked.length - 1)]);
  }

  isNear(list, z, range) {
    return list.some((o) => Math.abs(o.s - z) < range);
  }

  // ---------------------------------------------------------------- 每帧
  update(dt) {
    const g = this.game, p = g.leader, sp = g.spawner;
    const limit = sp.spawnLimit ?? Infinity;

    if (g.state === 'playing') {
      // 道具：每隔一段距离在随机车道放一个
      const pz = p.z + 150;
      if (pz > this.nextPickupZ && this.nextPickupZ < limit) {
        const z = this.nextPickupZ;
        if (!sp.inBarricadeZone(z) && !this.isNear(this.stations, z, 40) && !nearJunction(z) && !nearDock(z, 25)) {
          this.addPickup(z, randInt(0, LANES - 1), PICKUP_POOL[randInt(0, PICKUP_POOL.length - 1)]);
        }
        this.nextPickupZ += rand(F.pickupMinGap, F.pickupMaxGap);
      }
      // 普通跳台
      if (pz > this.nextRampZ && this.nextRampZ < limit) {
        const z = this.nextRampZ;
        if (!sp.inBarricadeZone(z) && !this.isNear(this.stations, z, 60) && !nearJunction(z) && !Road.isWater(z) && !nearDock(z, 40)) this.addRamp(z, randInt(0, LANES - 1));
        this.nextRampZ += rand(F.rampMinGap, F.rampMaxGap);
      }
      // 加速带：每隔一段路在一两条车道上放一块
      if (pz > this.nextBoostZ && this.nextBoostZ < limit) {
        const z = this.nextBoostZ;
        if (!sp.inBarricadeZone(z) && !this.isNear(this.stations, z, 50) && !nearJunction(z) && !nearDock(z, 30)) {
          const lane = randInt(0, LANES - 1);
          this.addBoost(z, lane);
          if (Math.random() < 0.4) this.addBoost(z, lane > 0 ? lane - 1 : lane + 1);
        }
        this.nextBoostZ += rand(260, 420);
      }
      // 终点：路线生成到那里了才放
      if (!this.finish && this.finishS < Infinity && Road.path.length > this.finishS + 20 && this.finishS - p.z < 400) {
        this.finish = { s: this.finishS, obj: this.makeGate(this.finishS, `🏁 ${t('finishLine')}`, '#111', 0xf2f2f2) };
      }
    }

    // 路口前的车道箭头：路口进入视野前画好
    const j = g.levels.junction;
    if (j && !j.committed && j.id !== this.arrowJunction && j.sEntry - p.z < 300) {
      this.arrowJunction = j.id;
      for (let lane = 0; lane < LANES; lane++) {
        const key = j.options[g.levels.optionForLane(lane)].key;
        for (const d of [40, 85]) {
          const m = new THREE.Mesh(this.arrowGeo, arrowMaterial(key));
          const w = Road.sample(j.sEntry - d, laneOffset(lane));
          m.position.set(w.x, 0.065, w.z);
          m.rotation.y = w.h + Math.PI;
          this.scene.add(m);
          this.arrows.push({ s: j.sEntry - d, obj: m });
        }
      }
    }

    // 改装站：开过大门就升级（单人：打开三选一界面；双人对战：自动升级，不暂停）
    for (const st of this.stations) {
      for (const pl of g.players) {
        if (!st.used[pl.index] && g.state === 'playing' && pl.z >= st.s) {
          st.used[pl.index] = true;
          g.onStation(pl);
        }
      }
    }
    // 道具：浮动旋转 + 拾取（双人对战时谁先开到谁拿）
    for (const k of this.pickups) {
      k.phase += dt * 3;
      const w = Road.sample(k.s, k.lat);
      k.obj.position.set(w.x, Road.surfaceY(k.s), w.z);
      k.icon.position.y = k.halo.position.y = 1.7 + Math.sin(k.phase) * 0.3;
      k.halo.rotation.set(Math.PI / 2 + Math.sin(k.phase * 0.7) * 0.5, k.phase * 0.8, 0);
      k.ring.scale.setScalar(1 + Math.sin(k.phase * 2) * 0.06);
      for (const pl of g.players) {
        if (!k.taken && g.state === 'playing' && !pl.airborne && Math.abs(pl.z - k.s) < 2.6 && Math.abs(pl.lateral - k.lat) < 1.6 + pl.width * 0.35) {
          k.taken = true;
          k.obj.visible = false;
          g.onPickup(k.kind, k.icon.getWorldPosition(new THREE.Vector3()), pl);
        }
      }
    }
    // 加速带：箭头往前流动；开上去获得一段爆发加速
    BOOST_TEX.offset.y -= dt * 2.2;
    for (const b of this.boosts) {
      for (const pl of g.players) {
        if (!b.used[pl.index] && g.state === 'playing' && !pl.airborne && Math.abs(pl.z - b.s) < 3.5 && Math.abs(pl.lateral - b.lat) < 1.5 + pl.width * 0.3) {
          b.used[pl.index] = true;
          g.onBoostPad(pl);
        }
      }
    }
    // 跳台：开上斜面就起飞
    for (const r of this.ramps) {
      for (const pl of g.players) {
        if (g.state === 'playing' && !pl.airborne && pl.z > r.s + 1 && pl.z < r.s + 5 && Math.abs(pl.lateral - r.lat) < 1.6 + pl.width * 0.3) {
          if (pl.jump(F.jumpPower)) g.onJump(pl);
        }
      }
    }

    // 清理身后的（双人对战时以落后的玩家为准）
    const behind = (o) => o.s < g.trailZ - 60;
    for (const list of [this.stations, this.pickups, this.ramps, this.arrows, this.boosts]) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (behind(list[i])) { this.scene.remove(list[i].obj); list.splice(i, 1); }
      }
    }
  }
}
