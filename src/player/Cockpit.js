import * as THREE from 'three';
import { clamp, damp } from '../core/utils.js';

/**
 * 第一人称驾驶舱（参考 GTA 的车内视角）。整个驾驶舱挂在镜头下面（镜头坐标：+X 右、+Y 上、-Z 前方），
 * 所以永远摆在正确的位置，不会和车身模型穿插；第一人称时玩家自己的车身对自己的镜头隐藏。
 *   - 方向盘：三辐皮革方向盘，12 点钟红色标记，跟着变道 / 弯道转动
 *   - 驾驶员的手：戴手套握在 10 点和 2 点位置，跟方向盘一起转；手臂从画面下方伸过来，实时对准双手
 *   - 仪表盘：速度表、转速表（红线区）、档位、数字车速，背光会发光
 *   - 仪表台、空调出风口、中控屏、A 柱、车顶内衬、遮阳板、后视镜（实时照出身后的路和警车）
 *   - 挡风玻璃外看得到自己车的引擎盖（颜色跟着当前车辆 / 船）
 */

const LEATHER = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.62, metalness: 0.05 });
const DASH = new THREE.MeshStandardMaterial({ color: 0x1f2023, roughness: 0.88, metalness: 0.05 });
const TRIM = new THREE.MeshStandardMaterial({ color: 0x2c2e33, roughness: 0.5, metalness: 0.5 });
const METAL = new THREE.MeshStandardMaterial({ color: 0x8d9298, roughness: 0.3, metalness: 0.9 });
const STITCH = new THREE.MeshStandardMaterial({ color: 0xb3261e, roughness: 0.6 });
const STITCH_DARK = new THREE.MeshStandardMaterial({ color: 0x5a1c16, roughness: 0.7 });
const GLOVE = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.55, metalness: 0.1 });
const CUFF = new THREE.MeshStandardMaterial({ color: 0x3a3e45, roughness: 0.7 });
const SLEEVE = new THREE.MeshStandardMaterial({ color: 0x1d2026, roughness: 0.55, metalness: 0.1 }); // 黑色皮夹克
const HEADLINER = new THREE.MeshStandardMaterial({ color: 0x2b2c2f, roughness: 0.95 });

function mesh(geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  return m;
}

/** 两点之间的一根梁（A 柱等） */
function beam(a, b, w, d, mat) {
  const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, d), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

function canvasTex(w, h) {
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return { c, g: c.getContext('2d'), t };
}

// 档位：每档的车速范围（km/h）
const GEARS = [0, 45, 80, 115, 150, 190, 235, 400];

export class Cockpit {
  /** layer：只让这台镜头看得到（双人分屏时两个驾驶舱互不干扰） */
  constructor(layer) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.wheelAngle = 0;
    this.redraw = 0;
    this.build();
    this.group.traverse((o) => { o.layers.set(layer); o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; });
  }

  build() {
    const G = this.group;
    // ---- 仪表台：主体 + 顶部缝线皮条 + 出风口 + 中控屏
    G.add(mesh(new THREE.BoxGeometry(2.2, 0.42, 0.34), DASH, 0, -0.46, -0.8)); // 不要太深，否则会挡住挡风玻璃外的引擎盖
    G.add(mesh(new THREE.BoxGeometry(2.2, 0.006, 0.012), STITCH_DARK, 0, -0.252, -0.632));
    for (const x of [-0.42, 0.42]) {
      const vent = mesh(new THREE.BoxGeometry(0.16, 0.07, 0.02), TRIM, x, -0.33, -0.625);
      G.add(vent);
      for (let k = -2; k <= 2; k++) G.add(mesh(new THREE.BoxGeometry(0.15, 0.006, 0.025), METAL, x, -0.33 + k * 0.013, -0.62));
    }
    const screen = canvasTex(256, 160);
    this.drawScreen(screen.g);
    screen.t.needsUpdate = true;
    const scrMat = new THREE.MeshBasicMaterial({ map: screen.t });
    scrMat.color.setRGB(1.1, 1.1, 1.1);
    G.add(mesh(new THREE.PlaneGeometry(0.2, 0.125), scrMat, 0.3, -0.44, -0.61, -0.25));
    G.add(mesh(new THREE.BoxGeometry(0.22, 0.14, 0.015), TRIM, 0.3, -0.44, -0.618, -0.25));

    // ---- 仪表罩 + 仪表（Canvas 画的速度表、转速表，每帧更新指针）
    const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.16, 24, 1, true, -Math.PI / 2, Math.PI), DASH);
    hood.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    hood.position.set(0, -0.2, -0.72);
    hood.scale.set(1, 1, 0.45);
    G.add(hood);
    this.gauge = canvasTex(512, 200);
    const gMat = new THREE.MeshBasicMaterial({ map: this.gauge.t });
    gMat.color.setRGB(1.25, 1.25, 1.25); // 背光略微超过 1，夜里会有一点光晕
    G.add(mesh(new THREE.PlaneGeometry(0.4, 0.156), gMat, 0, -0.215, -0.71, -0.12));

    // ---- 方向盘：轮缘、三根辐条、中心盖、12 点钟标记、换挡拨片；转向柱
    const wheel = new THREE.Group();
    wheel.position.set(0, -0.3, -0.52);
    wheel.rotation.x = -0.32; // 上沿往前倾
    G.add(wheel);
    this.wheel = new THREE.Group(); // 只转这一层
    wheel.add(this.wheel);
    const R = 0.175;
    this.wheel.add(mesh(new THREE.TorusGeometry(R, 0.018, 14, 64), LEATHER));
    this.wheel.add(mesh(new THREE.TorusGeometry(R, 0.0185, 6, 10, 0.32), STITCH, 0, 0, 0, 0, 0, Math.PI / 2 - 0.16)); // 12 点钟红色标记
    for (const a of [Math.PI, 0, -Math.PI / 2]) {
      const len = R - 0.045;
      const s = mesh(new THREE.BoxGeometry(len, 0.03, 0.014), METAL, Math.cos(a) * (0.045 + len / 2), Math.sin(a) * (0.045 + len / 2), -0.005, 0, 0, a);
      this.wheel.add(s);
    }
    this.wheel.add(mesh(new THREE.CylinderGeometry(0.058, 0.064, 0.04, 28), LEATHER, 0, 0, -0.005, Math.PI / 2));
    const logo = mesh(new THREE.CircleGeometry(0.022, 24), new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 1, roughness: 0.25 }), 0, 0, 0.0161);
    this.wheel.add(logo);
    for (const s of [-1, 1]) wheel.add(mesh(new THREE.BoxGeometry(0.05, 0.11, 0.008), TRIM, s * 0.13, 0.02, -0.035));
    G.add(beam(new THREE.Vector3(0, -0.33, -0.54), new THREE.Vector3(0, -0.4, -0.7), 0.07, 0.07, DASH));

    // ---- 手：戴手套握在 10 点、2 点位置（是方向盘的子物体，会跟着转）
    this.hands = [-1, 1].map((s) => {
      const a = (50 * Math.PI) / 180, gx = s * R * Math.sin(a), gy = R * Math.cos(a);
      const hand = new THREE.Group();
      hand.position.set(gx, gy, 0);
      hand.rotation.z = -s * a; // 沿着轮缘切线
      this.wheel.add(hand);
      // 手的局部坐标：x = 轮缘切线方向，y = 往外（离开方向盘中心），z = 朝向镜头
      const palm = mesh(new THREE.SphereGeometry(1, 18, 14), GLOVE, 0, -0.004, 0.02);
      palm.scale.set(0.05, 0.034, 0.03);
      hand.add(palm);
      for (let k = 0; k < 4; k++) {
        // 四根手指从前面绕过轮缘外侧（沿 z 方向的胶囊，排在切线方向上）
        hand.add(mesh(new THREE.CapsuleGeometry(0.0105, 0.026, 4, 8), GLOVE, -0.03 + k * 0.019, 0.021, -0.002, Math.PI / 2, 0, 0));
      }
      hand.add(mesh(new THREE.CapsuleGeometry(0.0115, 0.03, 4, 8), GLOVE, -s * 0.004, -0.02, 0.02, 0, 0, Math.PI / 2)); // 拇指压在轮缘内侧
      hand.add(mesh(new THREE.CylinderGeometry(0.03, 0.034, 0.035, 14), CUFF, 0, -0.03, 0.05, -1.0, 0, 0)); // 手套袖口
      const wrist = new THREE.Object3D();
      wrist.position.set(0, -0.045, 0.072);
      hand.add(wrist);
      return wrist;
    });
    // 手臂（袖子）：每帧从肩膀（画面外）连到手腕
    this.arms = [-1, 1].map((s) => {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.042, 1, 16), SLEEVE);
      G.add(arm);
      return { arm, shoulder: new THREE.Vector3(s * 0.36, -0.62, -0.08) }; // 前臂从画面下方两角伸进来
    });

    // ---- A 柱、车顶内衬、遮阳板、后视镜
    for (const s of [-1, 1]) {
      G.add(beam(new THREE.Vector3(s * 0.86, -0.25, -0.66), new THREE.Vector3(s * 0.6, 0.47, -0.2), 0.09, 0.07, HEADLINER));
      G.add(mesh(new THREE.BoxGeometry(0.42, 0.012, 0.2), HEADLINER, s * 0.3, 0.4, -0.3, 0.25, 0, 0));
    }
    G.add(mesh(new THREE.BoxGeometry(1.5, 0.06, 0.3), HEADLINER, 0, 0.46, -0.25));
    this.mirrorRT = new THREE.WebGLRenderTarget(320, 96);
    this.mirrorRT.texture.colorSpace = THREE.SRGBColorSpace;
    const mirrorMat = new THREE.MeshBasicMaterial({ map: this.mirrorRT.texture });
    mirrorMat.map.repeat.x = -1; // 镜子左右颠倒
    mirrorMat.map.offset.x = 1;
    this.mirror = new THREE.Group(); // 竖屏时缩小一点，不要挡住半个画面
    this.mirror.position.set(0, 0.2, -0.47);
    G.add(this.mirror);
    this.mirror.add(mesh(new THREE.BoxGeometry(0.26, 0.082, 0.03), TRIM));
    this.mirror.add(mesh(new THREE.PlaneGeometry(0.24, 0.068), mirrorMat, 0, 0, 0.016));
    this.mirror.add(beam(new THREE.Vector3(0, 0.04, -0.01), new THREE.Vector3(0, 0.24, 0.14), 0.02, 0.02, TRIM));
    this.mirrorCam = new THREE.PerspectiveCamera(32, 320 / 96, 0.5, 260);

    // ---- 引擎盖（挡风玻璃外）：中间微微隆起、往前往下延伸
    // 从仪表台前缘（挡风玻璃底部）一直延伸到车头，坡度平缓，所以在画面里占一条明显的带子
    const hoodGeo = new THREE.PlaneGeometry(1.8, 1.8, 16, 12);
    const p = hoodGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), v = p.getY(i) / 1.8 + 0.5; // v：0 = 靠近玻璃，1 = 车头
      const w = 1 - 0.22 * v * v;
      const crown = 0.045 * Math.cos((x / 0.9) * Math.PI * 0.5) - Math.abs(x) * 0.05; // 中间隆起、两边下垂
      p.setXYZ(i, x * w, -0.25 - v * 0.17 - v * v * 0.05 + crown, -0.97 - v * 2.3);
    }
    hoodGeo.computeVertexNormals();
    this.hoodMat = new THREE.MeshPhysicalMaterial({ color: 0xc81a14, metalness: 0.3, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.08, envMapIntensity: 0.55, side: THREE.DoubleSide });
    G.add(new THREE.Mesh(hoodGeo, this.hoodMat));
  }

  drawScreen(g) {
    // 中控屏：简单的导航地图
    g.fillStyle = '#0c1620';
    g.fillRect(0, 0, 256, 160);
    g.strokeStyle = '#1f3a4d';
    g.lineWidth = 2;
    for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(i * 34 - 20, 0); g.lineTo(i * 34 + 30, 160); g.stroke(); }
    g.strokeStyle = '#3fa9ff';
    g.lineWidth = 9;
    g.beginPath(); g.moveTo(128, 160); g.lineTo(128, 70); g.quadraticCurveTo(128, 40, 170, 30); g.lineTo(256, 20); g.stroke();
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(128, 104); g.lineTo(118, 126); g.lineTo(128, 120); g.lineTo(138, 126); g.closePath(); g.fill();
    g.fillStyle = '#9fd3ff';
    g.font = 'bold 16px system-ui, sans-serif';
    g.fillText('GPS', 10, 22);
  }

  /** 引擎盖颜色跟着当前车辆 */
  setPaint(color) {
    this.hoodMat.color.setHex(color);
  }

  /** 仪表：速度表 + 转速表 + 档位 + 数字车速 */
  drawGauges(kmh, rpm, gear, boost) {
    const { g } = this.gauge;
    g.clearRect(0, 0, 512, 200);
    const bg = g.createLinearGradient(0, 0, 0, 200);
    bg.addColorStop(0, '#07090c');
    bg.addColorStop(1, '#111419');
    g.fillStyle = bg;
    g.fillRect(0, 0, 512, 200);
    const dial = (cx, cy, r, max, value, step, label, red) => {
      const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, ang = (v) => a0 + (a1 - a0) * Math.min(1, v / max);
      g.lineWidth = 3;
      g.strokeStyle = '#2b3542';
      g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
      if (red) { g.strokeStyle = '#ff2e2e'; g.lineWidth = 6; g.beginPath(); g.arc(cx, cy, r - 3, ang(red), a1); g.stroke(); }
      g.fillStyle = '#d7e9ff';
      g.font = 'bold 14px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let v = 0; v <= max; v += step) {
        const a = ang(v), c = Math.cos(a), s = Math.sin(a);
        g.strokeStyle = red && v >= red ? '#ff4a4a' : '#9fc4ff';
        g.lineWidth = 3;
        g.beginPath(); g.moveTo(cx + c * (r - 4), cy + s * (r - 4)); g.lineTo(cx + c * (r - 14), cy + s * (r - 14)); g.stroke();
        g.fillText(String(label(v)), cx + c * (r - 28), cy + s * (r - 28));
      }
      const a = ang(value);
      g.strokeStyle = '#ff3b2a';
      g.lineWidth = 4;
      g.shadowColor = '#ff3b2a';
      g.shadowBlur = 10;
      g.beginPath(); g.moveTo(cx - Math.cos(a) * 10, cy - Math.sin(a) * 10); g.lineTo(cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8)); g.stroke();
      g.shadowBlur = 0;
      g.fillStyle = '#20252c';
      g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.fill();
    };
    dial(110, 104, 88, 280, kmh, 40, (v) => v, 0);
    dial(402, 104, 88, 8, rpm / 1000, 1, (v) => v, 6.5);
    // 中间：档位 + 数字车速
    g.textAlign = 'center';
    g.fillStyle = boost ? '#46e6ff' : '#ffffff';
    g.font = 'bold 54px "Arial Black", system-ui, sans-serif';
    g.fillText(String(gear), 256, 82);
    g.font = 'bold 26px system-ui, sans-serif';
    g.fillStyle = '#cfe4ff';
    g.fillText(String(Math.round(kmh)), 256, 136);
    g.font = '13px system-ui, sans-serif';
    g.fillStyle = '#7f94ad';
    g.fillText('km/h', 256, 160);
    if (boost) {
      g.fillStyle = '#46e6ff';
      g.font = 'bold 13px system-ui, sans-serif';
      g.fillText('NITRO', 256, 30);
    }
    this.gauge.t.needsUpdate = true;
  }

  /**
   * 每帧：方向盘角度、手臂、仪表、驾驶舱随加速度轻微晃动。
   * steer：转向量（变道 + 弯道，正 = 向左），speed：米/秒
   */
  update(dt, cam, { steer, speed, boost, accel }) {
    const narrow = cam.aspect < 0.8;
    this.mirror.scale.setScalar(narrow ? 0.58 : 1);
    this.mirror.position.y = narrow ? 0.25 : 0.2;
    this.wheelAngle = damp(this.wheelAngle, clamp(steer, -1.6, 1.6), 9, dt);
    this.wheel.rotation.z = this.wheelAngle;
    // 加减速时身体前后晃、转弯时左右晃（整个驾驶舱反向轻微移动）
    this.group.position.x = damp(this.group.position.x, clamp(-steer * 0.012, -0.02, 0.02), 6, dt);
    this.group.position.z = damp(this.group.position.z, clamp(accel * 0.0015, -0.02, 0.02), 6, dt);
    this.group.updateMatrixWorld(true);
    // 手臂：肩膀 → 手腕（都换算到驾驶舱坐标）
    const inv = new THREE.Matrix4().copy(this.group.matrixWorld).invert(), w = new THREE.Vector3();
    this.arms.forEach(({ arm, shoulder }, i) => {
      this.hands[i].getWorldPosition(w).applyMatrix4(inv);
      const dir = new THREE.Vector3().subVectors(w, shoulder), len = dir.length();
      arm.position.copy(shoulder).addScaledVector(dir, 0.5);
      arm.scale.set(1, len, 1);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    });
    // 仪表每秒刷新 20 次就够了
    if ((this.redraw -= dt) <= 0) {
      this.redraw = 0.05;
      const kmh = speed * 3.6;
      let gear = 1;
      while (gear < GEARS.length - 2 && kmh > GEARS[gear]) gear++;
      const lo = GEARS[gear - 1], hi = GEARS[gear], f = clamp((kmh - lo) / (hi - lo), 0, 1);
      const rpm = (boost ? 6800 : 1600 + f * 5000) + Math.random() * 120;
      this.drawGauges(kmh, rpm, gear, boost);
    }
  }

  /** 后视镜：从车顶往后看，渲染到一张小贴图（每隔几帧一次，省性能） */
  renderMirror(renderer, scene, pos, heading) {
    const c = this.mirrorCam;
    c.position.set(pos.x - Math.sin(heading) * 0.5, pos.y + 1.35, pos.z - Math.cos(heading) * 0.5);
    c.lookAt(pos.x - Math.sin(heading) * 30, pos.y + 0.8, pos.z - Math.cos(heading) * 30);
    const auto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.mirrorRT);
    renderer.render(scene, c);
    renderer.setRenderTarget(null);
    renderer.shadowMap.autoUpdate = auto;
  }
}
