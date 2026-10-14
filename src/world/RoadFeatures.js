import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Road, ROAD_HALF, laneOffset } from './Road.js';
import { mat, GEO } from '../models/Models.js';
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
};
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

// 跳台：楔形（前低后高），沿局部 +Z 方向上坡
function rampGeometry(w = 3.2, len = 5, h = 1.3) {
  const x = w / 2;
  const v = [
    [-x, 0, 0], [x, 0, 0], [x, h, len], [-x, h, len], // 斜面
    [-x, 0, len], [x, 0, len], // 背面底边
  ];
  const tri = (a, b, c) => [...v[a], ...v[b], ...v[c]];
  const pos = [
    ...tri(0, 2, 1), ...tri(0, 3, 2), // 斜面
    ...tri(4, 5, 2), ...tri(4, 2, 3), // 背面
    ...tri(0, 4, 3), ...tri(1, 2, 5), // 两侧
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
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
    this.rampGeo = rampGeometry();
    this.rampMat = new THREE.MeshLambertMaterial({ color: 0xffc21a, flatShading: true, side: THREE.DoubleSide });
    this.stations = [];
    this.pickups = [];
    this.ramps = [];
    this.finish = null;
    onLangChange(() => { this.bannerTex = null; });
    this.reset();
  }

  reset() {
    for (const list of [this.stations, this.pickups, this.ramps]) {
      for (const o of list) this.scene.remove(o.obj);
      list.length = 0;
    }
    if (this.finish) this.scene.remove(this.finish.obj);
    this.finish = null;
    this.finishS = Infinity;
    this.nextPickupZ = F.pickupFirst;
    this.nextRampZ = F.rampFirst;
  }

  // ---------------------------------------------------------------- 生成
  bannerTexture(text, bg, fg = '#fff') {
    return canvasTexture(512, 128, (g, w, h) => {
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      g.fillStyle = fg;
      g.font = 'bold 64px "Arial Black", "PingFang TC", "Microsoft JhengHei", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, w / 2, h / 2 + 4);
    });
  }

  /** 横跨马路的大门：两根柱子 + 横梁 + 文字横幅 + 地面发光带 */
  makeGate(s, text, bg, pillarColor) {
    const w = Road.sample(s, 0);
    const g = new THREE.Group();
    g.position.set(w.x, 0, w.z);
    g.rotation.y = w.h;
    const half = ROAD_HALF + 1.4;
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(GEO.boxBase, mat(pillarColor));
      p.scale.set(0.9, 7, 0.9);
      p.position.x = sx * half;
      p.castShadow = true;
      g.add(p);
    }
    const beam = new THREE.Mesh(GEO.boxBase, mat(pillarColor));
    beam.scale.set(half * 2 + 0.9, 0.7, 0.9);
    beam.position.y = 7;
    beam.castShadow = true;
    g.add(beam);
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.25), new THREE.MeshBasicMaterial({ map: this.bannerTexture(text, bg), side: THREE.DoubleSide }));
    banner.position.set(0, 6, -0.5);
    banner.rotation.y = Math.PI; // 面向来车方向
    g.add(banner);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 1.2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: bg, transparent: true, opacity: 0.6, depthWrite: false }));
    strip.position.y = 0.08;
    g.add(strip);
    this.scene.add(g);
    return g;
  }

  addStation(s) {
    this.stations.push({ s, obj: this.makeGate(s, `🔧 ${t('station')}`, '#1f8fff', 0x2b2f36), used: false });
  }

  setFinish(s) {
    this.finishS = s;
  }

  addPickup(s, lane, kind) {
    const sp = new THREE.Sprite(pickupMaterial(kind));
    sp.scale.setScalar(2.4);
    const w = Road.sample(s, laneOffset(lane));
    sp.position.set(w.x, 1.6, w.z);
    this.scene.add(sp);
    this.pickups.push({ s, lat: laneOffset(lane), kind, obj: sp, phase: Math.random() * 6 });
  }

  addRamp(s, lane) {
    const m = new THREE.Mesh(this.rampGeo, this.rampMat);
    const w = Road.sample(s, laneOffset(lane));
    m.position.set(w.x, 0, w.z);
    m.rotation.y = w.h;
    m.castShadow = true;
    m.receiveShadow = true;
    this.scene.add(m);
    this.ramps.push({ s, lat: laneOffset(lane), obj: m });
  }

  /** 路障生成时调用：有一定概率在被堵车道前放跳台，可以直接飞过去 */
  onBarricade(z, blocked) {
    if (Math.random() < F.rampBeforeBarricade) this.addRamp(z - 16, blocked[randInt(0, blocked.length - 1)]);
  }

  isNear(list, z, range) {
    return list.some((o) => Math.abs(o.s - z) < range);
  }

  // ---------------------------------------------------------------- 每帧
  update(dt) {
    const g = this.game, p = g.player, sp = g.spawner;
    const limit = sp.spawnLimit ?? Infinity;

    if (g.state === 'playing') {
      // 道具：每隔一段距离在随机车道放一个
      const pz = p.z + 150;
      if (pz > this.nextPickupZ && this.nextPickupZ < limit) {
        const z = this.nextPickupZ;
        if (!sp.inBarricadeZone(z) && !this.isNear(this.stations, z, 40) && !nearJunction(z)) {
          const kinds = Object.keys(PICKUPS);
          this.addPickup(z, randInt(0, LANES - 1), kinds[randInt(0, kinds.length - 1)]);
        }
        this.nextPickupZ += rand(F.pickupMinGap, F.pickupMaxGap);
      }
      // 普通跳台
      if (pz > this.nextRampZ && this.nextRampZ < limit) {
        const z = this.nextRampZ;
        if (!sp.inBarricadeZone(z) && !this.isNear(this.stations, z, 60) && !nearJunction(z)) this.addRamp(z, randInt(0, LANES - 1));
        this.nextRampZ += rand(F.rampMinGap, F.rampMaxGap);
      }
      // 终点：路线生成到那里了才放
      if (!this.finish && this.finishS < Infinity && Road.path.length > this.finishS + 20 && this.finishS - p.z < 400) {
        this.finish = { s: this.finishS, obj: this.makeGate(this.finishS, `🏁 ${t('finishLine')}`, '#111', 0xf2f2f2) };
      }
    }

    // 改装站：开过大门就打开升级界面
    for (const st of this.stations) {
      if (!st.used && g.state === 'playing' && p.z >= st.s) {
        st.used = true;
        g.openUpgrade();
      }
    }
    // 道具：浮动旋转 + 拾取
    for (const k of this.pickups) {
      k.phase += dt * 3;
      const w = Road.sample(k.s, k.lat);
      k.obj.position.set(w.x, 1.6 + Math.sin(k.phase) * 0.3, w.z);
      if (!k.taken && g.state === 'playing' && !p.airborne && Math.abs(p.z - k.s) < 2.6 && Math.abs(p.lateral - k.lat) < 1.6 + p.width * 0.35) {
        k.taken = true;
        k.obj.visible = false;
        g.onPickup(k.kind, k.obj.position);
      }
    }
    // 跳台：开上斜面就起飞
    for (const r of this.ramps) {
      if (g.state === 'playing' && !p.airborne && p.z > r.s + 1 && p.z < r.s + 5 && Math.abs(p.lateral - r.lat) < 1.6 + p.width * 0.3) {
        if (p.jump(F.jumpPower)) g.onJump();
      }
    }

    // 清理身后的
    const behind = (o) => o.s < p.z - 60;
    for (const list of [this.stations, this.pickups, this.ramps]) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (behind(list[i])) { this.scene.remove(list[i].obj); list.splice(i, 1); }
      }
    }
  }
}
