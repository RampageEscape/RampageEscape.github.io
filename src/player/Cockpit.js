import * as THREE from 'three';
import { clamp, damp } from '../core/utils.js';

/**
 * 第一人称驾驶舱（参考 GTA 的车内视角），每种车都有自己的车内：
 *   sports  跑车：碳纤维 + 红色缝线、三辐皮革方向盘、数字 / 指针混合仪表、中控导航屏
 *   muscle  肌肉车：复古木纹方向盘、镀铬圈米色指针表、中控三个小副表、引擎盖进气口 + 橙色赛车条纹
 *   armored 装甲车：橄榄绿钢板仪表台、拨动开关、军用电台、绿色单色显示屏、分体防弹挡风玻璃、加粗 A 柱、撞角
 *   tank    坦克：没有方向盘——从潜望镜观察缝往外看（带瞄准刻度），双手握着两根操纵杆，炮管伸在前面
 *   boat    快艇：白色玻璃钢驾驶台、不锈钢船舵、罗盘、航海图屏、低矮环绕挡风玻璃、船头甲板和栏杆
 * 整个驾驶舱挂在镜头下面（镜头坐标：+X 右、+Y 上、-Z 前方），第一人称时自己的车身对自己的镜头隐藏。
 * 后视镜：每隔一帧往后渲染一张宽画面，中间后视镜和左右车外后视镜各取其中一段（镜像）。
 */

// ---------------------------------------------------------------- 材质
const std = (color, roughness = 0.6, metalness = 0.1, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
const M = {
  leather: std(0x1b1b1d, 0.62, 0.05),
  dash: std(0x1f2023, 0.88, 0.05),
  carbon: std(0x16171a, 0.35, 0.4),
  trim: std(0x2c2e33, 0.5, 0.5),
  metal: std(0x8d9298, 0.3, 0.9),
  chrome: std(0xe6eaee, 0.12, 1),
  stitch: std(0xb3261e, 0.6),
  stitchDark: std(0x5a1c16, 0.7),
  glove: std(0x18191b, 0.55, 0.1),
  cuff: std(0x3a3e45, 0.7),
  sleeve: std(0x1d2026, 0.55, 0.1),
  headliner: std(0x2b2c2f, 0.95),
  wood: std(0x6b3a1e, 0.35, 0.05),
  vinyl: std(0x141416, 0.7),
  olive: std(0x4a5236, 0.75, 0.3),
  oliveDark: std(0x353b27, 0.8, 0.3),
  steel: std(0x50545a, 0.55, 0.8),
  rubber: std(0x121212, 0.9),
  fiberglass: std(0xeceee9, 0.35, 0.05),
  navy: std(0x1d2c44, 0.5, 0.2),
  bolt: std(0x9ea3a8, 0.35, 0.9),
};
const SHEEN = (() => {
  // 镜面上的一道斜向反光（让后视镜看起来是玻璃）
  const c = Object.assign(document.createElement('canvas'), { width: 128, height: 64 });
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 128, 64);
  gr.addColorStop(0, 'rgba(255,255,255,0.18)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.03)');
  gr.addColorStop(0.6, 'rgba(255,255,255,0.0)');
  gr.addColorStop(1, 'rgba(255,255,255,0.08)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 64);
  const t = new THREE.CanvasTexture(c);
  return new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false });
})();

function mesh(geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  return m;
}

/** 两点之间的一根梁（A 柱、支架、操纵杆） */
function beam(a, b, w, d, mat, round = false) {
  const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
  const geo = round ? new THREE.CylinderGeometry(w / 2, d / 2, len, 14) : new THREE.BoxGeometry(w, len, d);
  const m = new THREE.Mesh(geo, mat);
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

/** 圆角矩形（Shape） */
function roundRect(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/**
 * 镜面：圆角矩形，UV 映射到后视画面的 [uLeft, uRight] 区段（uLeft > uRight 就是左右镜像）
 */
function mirrorGlass(w, h, r, uLeft, uRight, material) {
  const geo = new THREE.ShapeGeometry(roundRect(w, h, r), 6);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const fx = (p.getX(i) + w / 2) / w, fy = (p.getY(i) + h / 2) / h;
    uv.setXY(i, uLeft + (uRight - uLeft) * fx, 0.08 + fy * 0.84);
  }
  return new THREE.Mesh(geo, material);
}

/** 带圆角黑框的后视镜（镜框 + 镜面 + 反光） */
function mirrorUnit(w, h, uLeft, uRight, glassMat, frameMat = M.trim) {
  const g = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.ExtrudeGeometry(roundRect(w + 0.014, h + 0.014, h * 0.32), { depth: 0.022, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.004, bevelSegments: 2 }), frameMat);
  frame.position.z = -0.026;
  g.add(frame);
  const glass = mirrorGlass(w, h, h * 0.3, uLeft, uRight, glassMat);
  glass.position.z = 0.0;
  g.add(glass);
  const sheen = new THREE.Mesh(new THREE.ShapeGeometry(roundRect(w, h, h * 0.3), 6), SHEEN);
  sheen.position.z = 0.001;
  g.add(sheen);
  return g;
}

/** 引擎盖曲面：从挡风玻璃底部往前延伸，中间隆起、两边下垂 */
function hoodGeometry({ width = 1.8, length = 2.3, y0 = -0.25, drop = 0.22, z0 = -0.97, crown = 0.045, scoop = 0 }) {
  const geo = new THREE.PlaneGeometry(width, width, 18, 14);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), v = p.getY(i) / width + 0.5;
    const w = 1 - 0.22 * v * v;
    let y = y0 - v * drop * 0.77 - v * v * drop * 0.23 + crown * Math.cos((x / (width / 2)) * Math.PI * 0.5) - Math.abs(x) * 0.05;
    if (scoop) y += scoop * Math.max(0, 1 - Math.abs(x) / 0.28) * Math.sin(Math.min(1, v / 0.55) * Math.PI) * (v < 0.55 ? 1 : 0); // 进气口隆起
    p.setXYZ(i, x * w, y, z0 - v * length);
  }
  geo.computeVertexNormals();
  return geo;
}

// 档位：每档的车速范围（km/h）
const GEARS = [0, 45, 80, 115, 150, 190, 235, 400];

// ---------------------------------------------------------------- 仪表画法
function dial(g, cx, cy, r, max, value, step, { red = 0, face = null, tick = '#9fc4ff', text = '#d7e9ff', needle = '#ff3b2a', font = 14, label = (v) => v } = {}) {
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, ang = (v) => a0 + (a1 - a0) * Math.min(1, v / max);
  if (face) { g.fillStyle = face; g.beginPath(); g.arc(cx, cy, r + 4, 0, Math.PI * 2); g.fill(); }
  if (red) { g.strokeStyle = '#ff2e2e'; g.lineWidth = 6; g.beginPath(); g.arc(cx, cy, r - 3, ang(red), a1); g.stroke(); }
  g.font = `bold ${font}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let v = 0; v <= max + 1e-6; v += step) {
    const a = ang(v), c = Math.cos(a), s = Math.sin(a);
    g.strokeStyle = red && v >= red ? '#ff4a4a' : tick;
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(cx + c * (r - 4), cy + s * (r - 4)); g.lineTo(cx + c * (r - 14), cy + s * (r - 14)); g.stroke();
    for (let k = 1; k < 4 && v + (step * k) / 4 <= max; k++) {
      const b = ang(v + (step * k) / 4);
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(cx + Math.cos(b) * (r - 4), cy + Math.sin(b) * (r - 4)); g.lineTo(cx + Math.cos(b) * (r - 9), cy + Math.sin(b) * (r - 9)); g.stroke();
    }
    g.fillStyle = text;
    g.fillText(String(label(v)), cx + c * (r - 27), cy + s * (r - 27));
  }
  const a = ang(value);
  g.strokeStyle = needle;
  g.lineWidth = 4;
  g.shadowColor = needle;
  g.shadowBlur = 8;
  g.beginPath(); g.moveTo(cx - Math.cos(a) * 10, cy - Math.sin(a) * 10); g.lineTo(cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8)); g.stroke();
  g.shadowBlur = 0;
  g.fillStyle = '#20252c';
  g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.fill();
}

const GAUGES = {
  /** 跑车：深色表盘、蓝色刻度、中间档位 + 数字车速 */
  sport(g, { kmh, rpm, gear, boost }) {
    const bg = g.createLinearGradient(0, 0, 0, 200);
    bg.addColorStop(0, '#07090c'); bg.addColorStop(1, '#111419');
    g.fillStyle = bg; g.fillRect(0, 0, 512, 200);
    dial(g, 110, 104, 88, 280, kmh, 40);
    dial(g, 402, 104, 88, 8, rpm / 1000, 1, { red: 6.5 });
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
    if (boost) { g.fillStyle = '#46e6ff'; g.font = 'bold 13px system-ui, sans-serif'; g.fillText('NITRO', 256, 30); }
  },
  /** 肌肉车：米色表盘、黑色数字、橙色指针（复古） */
  classic(g, { kmh, rpm }) {
    g.fillStyle = '#0d0d0e'; g.fillRect(0, 0, 512, 200);
    dial(g, 128, 100, 84, 160, kmh * 0.62, 20, { face: '#efe6cf', tick: '#1d1d1d', text: '#1d1d1d', needle: '#e8601a', font: 13, label: (v) => v }); // MPH
    dial(g, 384, 100, 84, 8, rpm / 1000, 1, { face: '#efe6cf', tick: '#1d1d1d', text: '#1d1d1d', needle: '#e8601a', red: 6.5 });
    g.fillStyle = '#5a5246'; g.font = 'bold 12px serif'; g.textAlign = 'center';
    g.fillText('MPH', 128, 150); g.fillText('RPM x1000', 384, 150);
  },
  /** 装甲车：绿色单色屏（军用），数字车速 + 转速条 + 状态 */
  military(g, { kmh, rpm, gear }) {
    g.fillStyle = '#031006'; g.fillRect(0, 0, 512, 200);
    g.fillStyle = '#39ff6a';
    g.font = 'bold 76px "Courier New", monospace';
    g.textAlign = 'left';
    g.fillText(String(Math.round(kmh)).padStart(3, '0'), 24, 108);
    g.font = 'bold 18px "Courier New", monospace';
    g.fillText('KM/H', 196, 108);
    g.fillText(`GEAR ${gear}`, 300, 52);
    g.fillText('ARMOR  OK', 300, 84);
    g.fillText('FUEL', 300, 116);
    g.strokeStyle = '#39ff6a'; g.lineWidth = 2; g.strokeRect(360, 102, 120, 16);
    g.fillRect(362, 104, 92, 12);
    for (let i = 0; i < 20; i++) {
      g.fillStyle = i / 20 < rpm / 8000 ? (i > 15 ? '#ff5a3a' : '#39ff6a') : '#0c3016';
      g.fillRect(24 + i * 22, 146, 18, 30);
    }
    g.fillStyle = 'rgba(0,0,0,0.25)';
    for (let y = 0; y < 200; y += 3) g.fillRect(0, y, 512, 1); // 扫描线
  },
  /** 快艇：白色表盘的节数（knots）和转速，中间水深 */
  marine(g, { kmh, rpm }) {
    g.fillStyle = '#0d1116'; g.fillRect(0, 0, 512, 200);
    dial(g, 110, 100, 84, 60, kmh * 0.54, 10, { face: '#f4f6f8', tick: '#1a2a3a', text: '#1a2a3a', needle: '#e8410f', label: (v) => v });
    dial(g, 402, 100, 84, 6, rpm / 1000, 1, { face: '#f4f6f8', tick: '#1a2a3a', text: '#1a2a3a', needle: '#e8410f', red: 5 });
    g.fillStyle = '#46e6ff'; g.font = 'bold 24px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText(`${(12 + Math.sin(performance.now() * 0.0005) * 3).toFixed(1)} m`, 256, 92);
    g.fillStyle = '#7fa6c4'; g.font = '13px system-ui, sans-serif';
    g.fillText('DEPTH', 256, 116); g.fillText('KNOTS', 110, 150); g.fillText('RPM', 402, 150);
  },
};

// ---------------------------------------------------------------- 驾驶员的手
/** 在方向盘（或握把）上做一只戴手套的手；返回手腕（手臂连到这里） */
function gloveHand(parent, s, gripX, gripY, tangentAngle) {
  const hand = new THREE.Group();
  hand.position.set(gripX, gripY, 0);
  hand.rotation.z = tangentAngle;
  parent.add(hand);
  // 手的局部坐标：x = 握的杆子方向，y = 往外，z = 朝向镜头
  const palm = mesh(new THREE.SphereGeometry(1, 18, 14), M.glove, 0, -0.004, 0.02);
  palm.scale.set(0.05, 0.034, 0.03);
  hand.add(palm);
  for (let k = 0; k < 4; k++) hand.add(mesh(new THREE.CapsuleGeometry(0.0105, 0.026, 4, 8), M.glove, -0.03 + k * 0.019, 0.021, -0.002, Math.PI / 2, 0, 0));
  for (let k = 0; k < 4; k++) hand.add(mesh(new THREE.SphereGeometry(0.0095, 8, 6), M.cuff, -0.03 + k * 0.019, 0.016, 0.03)); // 指节上的护垫
  hand.add(mesh(new THREE.CapsuleGeometry(0.0115, 0.03, 4, 8), M.glove, -s * 0.004, -0.02, 0.02, 0, 0, Math.PI / 2));
  hand.add(mesh(new THREE.CylinderGeometry(0.03, 0.034, 0.035, 14), M.cuff, 0, -0.03, 0.05, -1.0, 0, 0));
  const wrist = new THREE.Object3D();
  wrist.position.set(0, -0.045, 0.072);
  hand.add(wrist);
  return wrist;
}

/** 方向盘：返回 { mount（固定）, spin（转动层）, wrists } */
function steeringWheel(G, { x = 0, y = -0.3, z = -0.52, tilt = -0.32, R = 0.175, tube = 0.018, rim = M.leather, spokes = 3, spokeMat = M.metal, hub = M.leather, marker = M.stitch, gripDeg = 50 }) {
  const mount = new THREE.Group();
  mount.position.set(x, y, z);
  mount.rotation.x = tilt;
  G.add(mount);
  const spin = new THREE.Group();
  mount.add(spin);
  spin.add(mesh(new THREE.TorusGeometry(R, tube, 14, 72), rim));
  if (marker) spin.add(mesh(new THREE.TorusGeometry(R, tube * 1.03, 6, 10, 0.32), marker, 0, 0, 0, 0, 0, Math.PI / 2 - 0.16));
  const angles = spokes === 3 ? [Math.PI, 0, -Math.PI / 2] : spokes === 4 ? [Math.PI * 0.85, Math.PI * 0.15, -Math.PI * 0.35, -Math.PI * 0.65] : [Math.PI, 0];
  for (const a of angles) {
    const len = R - 0.045;
    spin.add(mesh(new THREE.BoxGeometry(len, 0.03, 0.014), spokeMat, Math.cos(a) * (0.045 + len / 2), Math.sin(a) * (0.045 + len / 2), -0.005, 0, 0, a));
  }
  spin.add(mesh(new THREE.CylinderGeometry(0.058, 0.064, 0.04, 28), hub, 0, 0, -0.005, Math.PI / 2));
  const a = (gripDeg * Math.PI) / 180;
  const wrists = [-1, 1].map((s) => gloveHand(spin, s, s * R * Math.sin(a), R * Math.cos(a), -s * a));
  return { mount, spin, wrists };
}

// ---------------------------------------------------------------- 各种车内
/** 轿车类（跑车 / 肌肉车 / 装甲车）共用的框架：A 柱、车顶、遮阳板、车内后视镜、两边车外后视镜 */
function cabinFrame(G, mirrorMat, { pillarW = 0.09, pillarMat = M.headliner, roofY = 0.47, wing = 'sport', wingMat }) {
  for (const s of [-1, 1]) {
    G.add(beam(new THREE.Vector3(s * 0.86, -0.25, -0.66), new THREE.Vector3(s * 0.6, roofY, -0.2), pillarW, 0.07, pillarMat));
    G.add(mesh(new THREE.BoxGeometry(0.42, 0.012, 0.2), M.headliner, s * 0.3, roofY - 0.07, -0.3, 0.25, 0, 0));
  }
  G.add(mesh(new THREE.BoxGeometry(1.5, 0.06, 0.3), M.headliner, 0, roofY - 0.01, -0.25));
  // 车内后视镜（取后视画面中间一段）
  const inner = mirrorUnit(0.25, 0.072, 0.74, 0.26, mirrorMat);
  inner.position.set(0, 0.2, -0.47);
  inner.rotation.x = 0.08;
  G.add(inner);
  G.add(beam(new THREE.Vector3(0, 0.24, -0.49), new THREE.Vector3(0, roofY - 0.03, -0.33), 0.018, 0.018, M.trim));
  // 车外后视镜（左边取画面右段、右边取画面左段，镜像）
  const wings = [];
  for (const s of [-1, 1]) {
    const big = wing === 'truck';
    const w = big ? 0.16 : 0.15, h = big ? 0.2 : 0.085;
    const unit = mirrorUnit(w, h, s < 0 ? 1.0 : 0.36, s < 0 ? 0.64 : 0.0, mirrorMat, wingMat);
    unit.position.set(s * 0.98, big ? -0.08 : -0.16, -0.78);
    unit.rotation.y = -s * 0.32;
    G.add(unit);
    if (big) G.add(beam(new THREE.Vector3(s * 0.84, -0.2, -0.74), new THREE.Vector3(s * 0.96, -0.12, -0.78), 0.02, 0.02, M.steel, true));
    wings.push(unit);
  }
  return { inner, wings };
}

export class Cockpit {
  /** layer：只让这台镜头看得到（双人分屏时两个驾驶舱互不干扰） */
  constructor(layer) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.wheelAngle = 0;
    this.redraw = 0;
    // 后视画面（宽）：中间给车内后视镜，左右两段给车外后视镜
    this.mirrorRT = new THREE.WebGLRenderTarget(768, 220);
    this.mirrorRT.texture.colorSpace = THREE.SRGBColorSpace;
    this.mirrorMat = new THREE.MeshBasicMaterial({ map: this.mirrorRT.texture });
    this.mirrorMat.color.setRGB(0.92, 0.96, 1.0); // 防眩光镜片略带蓝
    this.mirrorCam = new THREE.PerspectiveCamera(30, 768 / 220, 0.5, 280);
    this.hoodMats = [];
    this.styles = {
      sports: this.buildSports(),
      muscle: this.buildMuscle(),
      armored: this.buildArmored(),
      tank: this.buildTank(),
      boat: this.buildBoat(),
    };
    for (const st of Object.values(this.styles)) { st.group.visible = false; this.group.add(st.group); }
    this.setStyle('sports');
    this.group.traverse((o) => { o.layers.set(layer); o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; });
  }

  /** 每种车内共用：仪表贴图、手臂 */
  base(gaugeKind) {
    const group = new THREE.Group();
    const gauge = canvasTex(512, 200);
    const arms = [-1, 1].map((s) => {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.042, 1, 16), M.sleeve);
      group.add(arm);
      return { arm, shoulder: new THREE.Vector3(s * 0.36, -0.62, -0.08) };
    });
    const hoodMat = new THREE.MeshPhysicalMaterial({ color: 0xc81a14, metalness: 0.3, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.08, envMapIntensity: 0.55, side: THREE.DoubleSide });
    this.hoodMats.push(hoodMat);
    return { group, gauge, gaugeKind, arms, hoodMat, eye: 1.15, fov: 70 };
  }

  gaugePlane(st, w, h, x, y, z, rx) {
    const mat = new THREE.MeshBasicMaterial({ map: st.gauge.t });
    mat.color.setRGB(1.25, 1.25, 1.25); // 背光略微超过 1，夜里会有一点光晕
    st.group.add(mesh(new THREE.PlaneGeometry(w, h), mat, x, y, z, rx));
  }

  buildSports() {
    const st = this.base('sport'), G = st.group;
    G.add(mesh(new THREE.BoxGeometry(2.2, 0.42, 0.34), M.dash, 0, -0.46, -0.8));
    G.add(mesh(new THREE.BoxGeometry(2.2, 0.006, 0.012), M.stitchDark, 0, -0.252, -0.632));
    G.add(mesh(new THREE.BoxGeometry(1.4, 0.04, 0.012), M.carbon, 0, -0.29, -0.632)); // 碳纤维饰条
    for (const x of [-0.42, 0.42]) {
      G.add(mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 24), M.trim, x, -0.33, -0.625, Math.PI / 2));
      for (let k = -1; k <= 1; k++) G.add(mesh(new THREE.BoxGeometry(0.08, 0.006, 0.02), M.metal, x, -0.33 + k * 0.016, -0.616));
    }
    const screen = canvasTex(256, 160);
    drawNav(screen.g);
    screen.t.needsUpdate = true;
    const scr = new THREE.MeshBasicMaterial({ map: screen.t });
    scr.color.setRGB(1.1, 1.1, 1.1);
    G.add(mesh(new THREE.PlaneGeometry(0.2, 0.125), scr, 0.3, -0.44, -0.61, -0.25));
    G.add(mesh(new THREE.BoxGeometry(0.22, 0.14, 0.015), M.trim, 0.3, -0.44, -0.618, -0.25));
    const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.16, 24, 1, true, -Math.PI / 2, Math.PI), M.carbon);
    hood.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    hood.position.set(0, -0.2, -0.72);
    hood.scale.set(1, 1, 0.45);
    G.add(hood);
    this.gaugePlane(st, 0.4, 0.156, 0, -0.215, -0.71, -0.12);
    const wheel = steeringWheel(G, {});
    for (const s of [-1, 1]) wheel.mount.add(mesh(new THREE.BoxGeometry(0.05, 0.11, 0.008), M.carbon, s * 0.13, 0.02, -0.035)); // 换挡拨片
    G.add(beam(new THREE.Vector3(0, -0.33, -0.54), new THREE.Vector3(0, -0.4, -0.7), 0.07, 0.07, M.dash));
    Object.assign(st, { spin: wheel.spin, wrists: wheel.wrists });
    st.mirrors = cabinFrame(G, this.mirrorMat, { wingMat: st.hoodMat });
    G.add(new THREE.Mesh(hoodGeometry({}), st.hoodMat));
    return st;
  }

  buildMuscle() {
    const st = this.base('classic'), G = st.group;
    st.eye = 1.2;
    G.add(mesh(new THREE.BoxGeometry(2.2, 0.42, 0.34), M.vinyl, 0, -0.46, -0.8));
    G.add(mesh(new THREE.BoxGeometry(2.0, 0.07, 0.01), M.metal, 0, -0.33, -0.634)); // 拉丝铝饰板
    // 两个大表：镀铬圈
    this.gaugePlane(st, 0.42, 0.164, 0, -0.215, -0.71, -0.12);
    for (const x of [-0.105, 0.105]) G.add(mesh(new THREE.TorusGeometry(0.07, 0.006, 8, 40), M.chrome, x, -0.215, -0.705, -0.12));
    const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.17, 24, 1, true, -Math.PI / 2, Math.PI), M.vinyl);
    hood.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    hood.position.set(0, -0.2, -0.72);
    hood.scale.set(1, 1, 0.45);
    G.add(hood);
    // 中控三个小副表（油压 / 水温 / 电压）
    for (let k = 0; k < 3; k++) {
      const x = 0.24 + k * 0.075;
      G.add(mesh(new THREE.CircleGeometry(0.028, 24), std(0xefe6cf, 0.5), x, -0.38, -0.626));
      G.add(mesh(new THREE.TorusGeometry(0.029, 0.004, 6, 24), M.chrome, x, -0.38, -0.624));
      G.add(mesh(new THREE.BoxGeometry(0.003, 0.022, 0.002), std(0xe8601a), x, -0.375, -0.622, 0, 0, -0.6 + k * 0.5));
    }
    // 木纹方向盘 + 镀铬辐条
    const wheel = steeringWheel(G, { R: 0.185, tube: 0.016, rim: M.wood, spokeMat: M.chrome, hub: M.chrome, marker: null, gripDeg: 55 });
    G.add(beam(new THREE.Vector3(0, -0.33, -0.54), new THREE.Vector3(0, -0.4, -0.7), 0.06, 0.06, M.chrome, true));
    Object.assign(st, { spin: wheel.spin, wrists: wheel.wrists });
    st.mirrors = cabinFrame(G, this.mirrorMat, { pillarW: 0.07, pillarMat: M.chrome, wingMat: M.chrome });
    // 引擎盖：进气口隆起 + 两条橙色赛车条纹
    const hoodGeo = hoodGeometry({ scoop: 0.07, length: 2.5 });
    G.add(new THREE.Mesh(hoodGeo, st.hoodMat));
    const stripes = canvasTex(128, 128);
    stripes.g.clearRect(0, 0, 128, 128);
    stripes.g.fillStyle = '#ff7a1a';
    stripes.g.fillRect(44, 0, 14, 128);
    stripes.g.fillRect(70, 0, 14, 128);
    stripes.t.needsUpdate = true;
    const stripeMesh = new THREE.Mesh(hoodGeo, new THREE.MeshStandardMaterial({ map: stripes.t, transparent: true, roughness: 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    G.add(stripeMesh);
    return st;
  }

  buildArmored() {
    const st = this.base('military'), G = st.group;
    st.eye = 1.5;
    G.add(mesh(new THREE.BoxGeometry(2.2, 0.46, 0.36), M.olive, 0, -0.47, -0.8));
    for (let x = -0.95; x <= 0.95; x += 0.19) G.add(mesh(new THREE.SphereGeometry(0.008, 8, 6), M.bolt, x, -0.255, -0.62)); // 螺栓
    // 拨动开关一排 + 军用电台
    for (let k = 0; k < 6; k++) {
      G.add(mesh(new THREE.BoxGeometry(0.03, 0.03, 0.012), M.steel, 0.22 + k * 0.045, -0.36, -0.622));
      G.add(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.035, 6), M.chrome, 0.22 + k * 0.045, -0.35, -0.61, 0.6));
    }
    G.add(mesh(new THREE.BoxGeometry(0.26, 0.09, 0.05), M.oliveDark, -0.36, -0.37, -0.64));
    G.add(mesh(new THREE.PlaneGeometry(0.1, 0.03), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2.2, 0.6) }), -0.4, -0.355, -0.614));
    this.gaugePlane(st, 0.36, 0.14, 0, -0.22, -0.7, -0.15);
    G.add(mesh(new THREE.BoxGeometry(0.42, 0.2, 0.06), M.oliveDark, 0, -0.22, -0.735));
    // 四辐粗方向盘
    const wheel = steeringWheel(G, { R: 0.19, tube: 0.024, rim: M.rubber, spokes: 4, spokeMat: M.steel, hub: M.rubber, marker: null, y: -0.31 });
    G.add(beam(new THREE.Vector3(0, -0.34, -0.54), new THREE.Vector3(0, -0.42, -0.72), 0.08, 0.08, M.oliveDark));
    Object.assign(st, { spin: wheel.spin, wrists: wheel.wrists });
    st.mirrors = cabinFrame(G, this.mirrorMat, { pillarW: 0.16, pillarMat: M.oliveDark, roofY: 0.42, wing: 'truck', wingMat: M.oliveDark });
    G.add(mesh(new THREE.BoxGeometry(0.05, 0.75, 0.05), M.oliveDark, 0, 0.08, -0.62, -0.38)); // 分体防弹玻璃的中间立柱
    // 车顶扶手
    G.add(beam(new THREE.Vector3(-0.55, 0.36, -0.3), new THREE.Vector3(-0.25, 0.36, -0.36), 0.02, 0.02, M.rubber, true));
    // 平直的橄榄绿引擎盖 + 前方撞角
    G.add(new THREE.Mesh(hoodGeometry({ crown: 0.012, drop: 0.12, length: 2.0, width: 2.0 }), st.hoodMat));
    G.add(mesh(new THREE.BoxGeometry(2.0, 0.16, 0.14), M.steel, 0, -0.4, -3.05));
    return st;
  }

  buildTank() {
    const st = this.base(null), G = st.group;
    st.eye = 2.35;
    st.fov = 62;
    // 潜望镜观察口：四周是带铆钉的钢板，中间一条横向的观察缝
    const plate = new THREE.Shape();
    plate.moveTo(-2, -1.4); plate.lineTo(2, -1.4); plate.lineTo(2, 1.4); plate.lineTo(-2, 1.4); plate.closePath();
    plate.holes.push(roundRect(1.25, 0.32, 0.05));
    const plateMesh = mesh(new THREE.ShapeGeometry(plate, 8), M.steel, 0, 0.04, -0.62);
    G.add(plateMesh);
    const rim = roundRect(1.33, 0.4, 0.07);
    rim.holes.push(roundRect(1.25, 0.32, 0.05));
    G.add(mesh(new THREE.ExtrudeGeometry(rim, { depth: 0.08, bevelEnabled: false }), M.oliveDark, 0, 0.04, -0.7)); // 观察缝的厚边框
    for (let x = -0.62; x <= 0.62; x += 0.155) for (const y of [-0.17, 0.25]) G.add(mesh(new THREE.SphereGeometry(0.012, 8, 6), M.bolt, x, y, -0.615));
    // 观察缝里的绿色厚玻璃 + 瞄准刻度
    const ret = canvasTex(512, 128);
    drawReticle(ret.g);
    ret.t.needsUpdate = true;
    G.add(mesh(new THREE.PlaneGeometry(1.25, 0.32), new THREE.MeshBasicMaterial({ map: ret.t, transparent: true, depthWrite: false }), 0, 0.04, -0.63));
    G.add(mesh(new THREE.PlaneGeometry(1.25, 0.32), new THREE.MeshBasicMaterial({ color: 0x2a6a3a, transparent: true, opacity: 0.18, depthWrite: false }), 0, 0.04, -0.632));
    // 下方仪表：一个指针表（速度）
    this.gaugePlane(st, 0.28, 0.11, 0, -0.32, -0.6, -0.3);
    st.gaugeKind = 'military';
    // 两根操纵杆 + 握着的手
    st.levers = [-1, 1].map((s) => {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.2, -0.62, -0.5);
      G.add(pivot);
      pivot.add(beam(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.3, 0.06), 0.03, 0.03, M.steel, true));
      pivot.add(mesh(new THREE.CapsuleGeometry(0.022, 0.06, 4, 10), M.rubber, 0, 0.32, 0.065, 0.2, 0, 0));
      return pivot;
    });
    st.wrists = st.levers.map((pivot, i) => gloveHand(pivot, i ? 1 : -1, 0, 0.32, i ? -1.5 : 1.5));
    st.arms.forEach((a, i) => a.shoulder.set(i ? 0.3 : -0.3, -0.75, 0.1));
    // 炮管从观察口上方伸向前方
    G.add(mesh(new THREE.CylinderGeometry(0.07, 0.08, 4.5, 16), M.oliveDark, 0, 0.42, -3.2, Math.PI / 2));
    G.add(mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.4, 16), M.steel, 0, 0.42, -5.4, Math.PI / 2)); // 炮口制退器
    return st;
  }

  buildBoat() {
    const st = this.base('marine'), G = st.group;
    st.eye = 1.55;
    // 白色玻璃钢驾驶台（弧形）
    G.add(mesh(new THREE.BoxGeometry(1.8, 0.5, 0.42), M.fiberglass, 0, -0.52, -0.84));
    G.add(mesh(new THREE.CapsuleGeometry(0.03, 1.7, 4, 12), M.fiberglass, 0, -0.27, -0.64, 0, 0, Math.PI / 2)); // 圆润的台面前缘
    G.add(mesh(new THREE.BoxGeometry(0.7, 0.2, 0.05), M.navy, 0, -0.33, -0.66)); // 仪表面板
    this.gaugePlane(st, 0.42, 0.164, 0, -0.32, -0.63, -0.25);
    // 罗盘（玻璃罩）+ 航海图屏
    G.add(mesh(new THREE.SphereGeometry(0.05, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: 0x9fd3ff, transparent: true, opacity: 0.4, roughness: 0.05 }), 0, -0.25, -0.72));
    const chart = canvasTex(256, 160);
    drawChart(chart.g);
    chart.t.needsUpdate = true;
    const chartMat = new THREE.MeshBasicMaterial({ map: chart.t });
    chartMat.color.setRGB(1.1, 1.1, 1.1);
    G.add(mesh(new THREE.PlaneGeometry(0.22, 0.14), chartMat, 0.42, -0.36, -0.62, -0.35));
    // 不锈钢五辐船舵（细轮缘 + 外圈把手）
    const wheel = steeringWheel(G, { R: 0.2, tube: 0.011, rim: M.chrome, spokes: 3, spokeMat: M.chrome, hub: M.chrome, marker: null, y: -0.29, tilt: -0.55, gripDeg: 60 });
    wheel.spin.add(mesh(new THREE.SphereGeometry(0.018, 10, 8), M.chrome, 0, 0.215, 0)); // 舵把
    G.add(beam(new THREE.Vector3(0, -0.32, -0.54), new THREE.Vector3(0, -0.4, -0.68), 0.05, 0.05, M.chrome, true));
    Object.assign(st, { spin: wheel.spin, wrists: wheel.wrists });
    // 油门手柄（右边）
    G.add(beam(new THREE.Vector3(0.45, -0.32, -0.55), new THREE.Vector3(0.48, -0.2, -0.5), 0.022, 0.022, M.chrome, true));
    G.add(mesh(new THREE.SphereGeometry(0.03, 12, 10), M.rubber, 0.48, -0.19, -0.5));
    // 低矮的环绕挡风玻璃（镀铬框）
    const glass = new THREE.CylinderGeometry(1.05, 1.0, 0.32, 40, 1, true, -Math.PI * 0.3, Math.PI * 0.6);
    G.add(mesh(glass, new THREE.MeshPhysicalMaterial({ color: 0x1a2a36, transparent: true, opacity: 0.18, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false }), 0, -0.1, 0.2, 0, Math.PI, 0));
    G.add(mesh(new THREE.TorusGeometry(1.03, 0.008, 6, 40, Math.PI * 0.6), M.chrome, 0, 0.06, 0.2, Math.PI / 2, 0, Math.PI * 0.2 + Math.PI));
    // 船头甲板（白色）+ 两边护栏
    G.add(new THREE.Mesh(hoodGeometry({ width: 2.0, length: 2.8, y0: -0.3, drop: 0.08, crown: 0.06 }), st.hoodMat));
    for (const s of [-1, 1]) {
      const pts = [];
      for (let k = 0; k <= 6; k++) {
        const v = k / 6;
        pts.push(new THREE.Vector3(s * 0.85 * (1 - 0.55 * v * v), -0.08 - v * 0.08, -1.0 - v * 2.6));
      }
      G.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.012, 6), M.chrome));
      for (let k = 1; k <= 5; k += 2) G.add(beam(pts[k], pts[k].clone().setY(pts[k].y - 0.15), 0.012, 0.012, M.chrome, true));
    }
    return st;
  }

  /** 切换到当前车辆的车内（color：引擎盖 / 船头颜色） */
  setStyle(key, color) {
    if (key !== this.key) {
      for (const [k, st] of Object.entries(this.styles)) st.group.visible = k === key;
      this.key = key;
      this.style = this.styles[key];
    }
    if (color != null) this.style.hoodMat.color.setHex(color);
  }

  get hasMirror() { return !!this.style.mirrors; }

  /**
   * 每帧：方向盘 / 操纵杆、手臂、仪表、驾驶舱随加速度轻微晃动。
   * steer：转向量（变道 + 弯道，正 = 向左），speed：米/秒
   */
  update(dt, cam, { steer, speed, boost, accel }) {
    const st = this.style;
    const narrow = cam.aspect < 0.8;
    if (st.mirrors) {
      st.mirrors.inner.scale.setScalar(narrow ? 0.6 : 1);
      st.mirrors.inner.position.y = narrow ? 0.25 : 0.2;
    }
    this.wheelAngle = damp(this.wheelAngle, clamp(steer, -1.6, 1.6), 9, dt);
    if (st.spin) st.spin.rotation.z = this.wheelAngle;
    if (st.levers) {
      // 坦克：转向时一根杆往后拉、一根往前推
      st.levers[0].rotation.x = damp(st.levers[0].rotation.x, clamp(this.wheelAngle * 0.35, -0.4, 0.4) - 0.1, 8, dt);
      st.levers[1].rotation.x = damp(st.levers[1].rotation.x, clamp(-this.wheelAngle * 0.35, -0.4, 0.4) - 0.1, 8, dt);
    }
    this.group.position.x = damp(this.group.position.x, clamp(-steer * 0.012, -0.02, 0.02), 6, dt);
    this.group.position.z = damp(this.group.position.z, clamp(accel * 0.0015, -0.02, 0.02), 6, dt);
    this.group.updateMatrixWorld(true);
    // 手臂：肩膀 → 手腕（换算到这套车内的坐标）
    const inv = new THREE.Matrix4().copy(st.group.matrixWorld).invert(), w = new THREE.Vector3();
    st.arms.forEach(({ arm, shoulder }, i) => {
      st.wrists[i].getWorldPosition(w).applyMatrix4(inv);
      const dir = new THREE.Vector3().subVectors(w, shoulder), len = dir.length();
      arm.position.copy(shoulder).addScaledVector(dir, 0.5);
      arm.scale.set(1, len, 1);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    });
    // 仪表每秒刷新 20 次就够了
    if (st.gaugeKind && (this.redraw -= dt) <= 0) {
      this.redraw = 0.05;
      const kmh = speed * 3.6;
      let gear = 1;
      while (gear < GEARS.length - 2 && kmh > GEARS[gear]) gear++;
      const lo = GEARS[gear - 1], hi = GEARS[gear], f = clamp((kmh - lo) / (hi - lo), 0, 1);
      const rpm = (boost ? 6800 : 1600 + f * 5000) + Math.random() * 120;
      const g = st.gauge.g;
      g.clearRect(0, 0, 512, 200);
      GAUGES[st.gaugeKind](g, { kmh, rpm, gear, boost });
      st.gauge.t.needsUpdate = true;
    }
  }

  /** 后视画面：从车顶往后看，渲染一张宽贴图（车内后视镜和两边车外后视镜共用） */
  renderMirror(renderer, scene, pos, heading) {
    const c = this.mirrorCam;
    c.position.set(pos.x - Math.sin(heading) * 0.8, pos.y + 1.3, pos.z - Math.cos(heading) * 0.8);
    c.lookAt(pos.x - Math.sin(heading) * 30, pos.y + 0.9, pos.z - Math.cos(heading) * 30);
    const auto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.mirrorRT);
    renderer.render(scene, c);
    renderer.setRenderTarget(null);
    renderer.shadowMap.autoUpdate = auto;
  }
}

// ---------------------------------------------------------------- 屏幕画面
function drawNav(g) {
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

function drawChart(g) {
  // 航海图：深浅不同的蓝色水域 + 等深线 + 航线
  g.fillStyle = '#0d3a5c';
  g.fillRect(0, 0, 256, 160);
  g.strokeStyle = '#2a6f9c';
  g.lineWidth = 2;
  for (let k = 0; k < 6; k++) { g.beginPath(); g.ellipse(200, 140, 40 + k * 26, 30 + k * 18, 0, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = '#c9b77a';
  g.beginPath(); g.ellipse(230, 150, 50, 30, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#ffd23a';
  g.setLineDash([8, 6]);
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(40, 150); g.lineTo(90, 70); g.lineTo(180, 20); g.stroke();
  g.setLineDash([]);
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(90, 66); g.lineTo(82, 84); g.lineTo(90, 79); g.lineTo(98, 84); g.closePath(); g.fill();
}

function drawReticle(g) {
  // 坦克观察缝里的瞄准刻度（绿色）
  g.clearRect(0, 0, 512, 128);
  g.strokeStyle = 'rgba(80,255,120,0.85)';
  g.fillStyle = 'rgba(80,255,120,0.85)';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(256, 30); g.lineTo(256, 98); g.moveTo(206, 64); g.lineTo(306, 64); g.stroke();
  g.beginPath(); g.arc(256, 64, 18, 0, Math.PI * 2); g.stroke();
  for (let k = -5; k <= 5; k++) if (k) { g.beginPath(); g.moveTo(256 + k * 34, 60); g.lineTo(256 + k * 34, 68); g.stroke(); }
  g.font = 'bold 12px "Courier New", monospace';
  g.fillText('RNG 0450', 20, 20);
  g.fillText('AP  ■■■', 420, 20);
}
