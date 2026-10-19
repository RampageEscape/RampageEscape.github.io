import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GEO, SIREN } from './Models.js';
import { pick } from '../core/utils.js';

// 海上路段的船：全部程序化生成（不需要下载模型）。
//   船壳：V 形船底 + 船头收尖上翘 + 舷弧（船头比船尾高），上半部车漆、下半部防污漆
//   原点在吃水线中心，船头朝 +Z（和汽车一致，所以 AI、碰撞、镜头都不用改）
//   每种船只做一次“模板”，按材质合并成几个网格（每艘船只要几次 draw call），之后直接 clone

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- 材质
const cache = new Map();
const cached = (key, make) => (cache.has(key) ? cache.get(key) : (cache.set(key, make()), cache.get(key)));
/** 船漆：清漆层 + 一点金属感，会反射天空 */
const paint = (color) => cached('p' + color, () => new THREE.MeshPhysicalMaterial({ color, metalness: 0.25, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08, side: THREE.DoubleSide }));
const flat = (color, rough = 0.7, metal = 0) => cached(`f${color}:${rough}:${metal}`, () => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, side: THREE.DoubleSide }));
const GLASS = new THREE.MeshPhysicalMaterial({ color: 0x0d1820, roughness: 0.04, metalness: 0, clearcoat: 1, transparent: true, opacity: 0.55, envMapIntensity: 1.6, depthWrite: false, side: THREE.DoubleSide });
const CHROME = flat(0xd8dde2, 0.18, 1);
const RUBBER = flat(0x1b1c1e, 0.8);
const SEAT = flat(0xf1ede4, 0.6);
const DARK = flat(0x23272c, 0.6);

// ---------------------------------------------------------------- 船壳
/** 两排点 A[i]、B[i]（沿船身的各个截面）连成一条曲面带（共享顶点 → 法线平滑，船身是光滑的曲面） */
function strip(A, B) {
  const pos = [], idx = [], n = A.length;
  for (let i = 0; i < n; i++) pos.push(...A[i], ...B[i]);
  for (let i = 0; i < n - 1; i++) {
    const a0 = i * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
    idx.push(a0, b0, a1, a1, b0, b1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/** 以第一个点为中心的扇形（船尾板） */
function fan(points) {
  const c = points.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / points.length);
  const pos = [];
  for (let i = 0; i < points.length - 1; i++) pos.push(...c, ...points[i], ...points[i + 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/**
 * 船壳几何体：返回 { top, bottom, deck, transom, deckY(z), halfW(z) }
 *   L, W  : 船长、船宽
 *   H     : 船舷高度（吃水线以上）
 *   draft : 吃水深度（吃水线以下，被海面挡住，只在船被炸飞时看得到）
 */
function hull(L, W, H, { draft = 0.45, sheer = 0.22, bowRise = 0.3, deadrise = 0.38, flare = 0.06, bowStart = 0.42 } = {}) {
  const N = 28, gl = [], gr = [], cl = [], cr = [], kl = [], kr = [], deck = [], deckC = [];
  const halfW = (t) => (W / 2) * (t < bowStart ? 1 : Math.cos(((t - bowStart) / (1 - bowStart)) * Math.PI / 2) ** 0.7);
  const deckY = (t) => H * (1 + sheer * t + bowRise * smooth(0.65, 1, t));
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1), z = -L / 2 + t * L, hw = Math.max(halfW(t), 0.001);
    const yd = deckY(t), yk = -draft * (1 - smooth(0.7, 1, t) * 0.9) + smooth(0.8, 1, t) * H * 0.4;
    const yc = Math.min(yd - 0.05, yk + hw * deadrise + 0.06);
    gl.push([hw * (1 + flare), yd, z]); gr.push([-hw * (1 + flare), yd, z]);
    cl.push([hw, yc, z]); cr.push([-hw, yc, z]);
    kl.push([0, yk, z]); kr.push([0, yk, z]);
    deck.push([hw * (1 + flare), yd, z]);
    deckC.push([0, yd + 0.06, z]);
  }
  const top = mergeGeometries([strip(gl, cl), strip(cr, gr)]);
  const bottom = mergeGeometries([strip(cl, kl), strip(kr, cr)]);
  const deckG = mergeGeometries([strip(deck, deckC), strip(deckC, gr)]);
  const transom = fan([gl[0], cl[0], kl[0], cr[0], gr[0]]);
  for (const g of [top, bottom, deckG, transom]) g.computeVertexNormals();
  return {
    top, bottom, deck: deckG, transom,
    deckY: (z) => deckY((z + L / 2) / L),
    halfW: (z) => halfW((z + L / 2) / L),
  };
}

// ---------------------------------------------------------------- 组装工具
function part(parent, geo, material, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0, order = 'XYZ') {
  const m = new THREE.Mesh(geo, material);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz, order);
  m.castShadow = true;
  parent.add(m);
  return m;
}
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const COWL = new THREE.CapsuleGeometry(0.28, 0.32, 4, 10);
const BOX = GEO.box;

/** 外壳 + 甲板 */
function addHull(root, L, W, H, colors, opts) {
  const h = hull(L, W, H, opts);
  root.add(new THREE.Mesh(h.top, paint(colors.top)));
  root.add(new THREE.Mesh(h.bottom, flat(colors.bottom ?? 0xf2f2f0, 0.5)));
  root.add(new THREE.Mesh(h.transom, paint(colors.top)));
  root.add(new THREE.Mesh(h.deck, flat(colors.deck ?? 0xdcd6c8, 0.75)));
  // 舷边护条（黑色橡胶）
  for (const s of [-1, 1]) part(root, BOX, RUBBER, 0.08, 0.08, L * 0.62, s * (W / 2 + 0.03), h.deckY(-L * 0.12) - 0.02, -L * 0.12);
  return h;
}

/** 舷侧彩色腰线（只画在两侧笔直的那一段） */
function addStripe(root, L, W, h, color, y = 0.55) {
  for (const s of [-1, 1]) part(root, BOX, paint(color), 0.03, 0.12, L * 0.5, s * (W / 2 + 0.02), h.deckY(-L * 0.2) * y, -L * 0.2);
}

/** 挡风玻璃：中间一块 + 两侧斜的两块，镀铬边框 */
function addWindshield(root, W, y, z, h = 0.5, lean = 0.6) {
  part(root, BOX, GLASS, W * 0.62, h, 0.03, 0, y + h * 0.45, z, -lean);
  for (const s of [-1, 1]) {
    part(root, BOX, GLASS, W * 0.22, h * 0.9, 0.03, s * W * 0.38, y + h * 0.4, z - 0.12, -lean * 0.8, s * 0.7);
  }
  part(root, CYL, CHROME, 0.04, W * 0.62, 0.04, 0, y + h * 0.9, z - Math.sin(lean) * h * 0.45, 0, 0, Math.PI / 2);
}

/** 舷外机：发动机罩 + 支腿（船尾，可以是一台或两台） */
function addOutboards(root, L, W, y, n = 2, color = 0x15171a) {
  const xs = n === 1 ? [0] : [-W * 0.2, W * 0.2];
  for (const x of xs) {
    part(root, COWL, paint(color), 0.78, 0.5, 0.9, x, y + 0.1, -L / 2 - 0.24, Math.PI / 2 - 0.25, 0, 0); // 圆润的发动机罩（横躺、略微后倾）
    part(root, BOX, DARK, 0.16, 0.5, 0.3, x, y - 0.3, -L / 2 - 0.3);
  }
}

/** 船舱 / 驾驶室：带深色车窗 */
function addCabin(root, w, hgt, len, y, z, color, { windowColor = 0x111820, roof = color } = {}) {
  part(root, BOX, paint(color), w, hgt, len, 0, y + hgt / 2, z);
  part(root, BOX, GLASS, w + 0.02, hgt * 0.42, len * 0.8, 0, y + hgt * 0.62, z);
  part(root, BOX, GLASS, w * 0.86, hgt * 0.42, 0.04, 0, y + hgt * 0.62, z + len / 2 + 0.01);
  part(root, BOX, paint(roof), w * 1.06, 0.08, len * 1.08, 0, y + hgt + 0.04, z);
  return y + hgt + 0.08;
}

/** 船头栏杆 */
function addRails(root, L, W, h) {
  for (const s of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const z = L * (0.08 + k * 0.1), hw = h.halfW(z) * 0.92;
      part(root, CYL, CHROME, 0.03, 0.32, 0.03, s * hw, h.deckY(z) + 0.16, z);
    }
    const z0 = L * 0.08, z1 = L * 0.38, hw0 = h.halfW(z0) * 0.92, hw1 = h.halfW(z1) * 0.92;
    const len = Math.hypot(z1 - z0, hw1 - hw0);
    // 先绕 X 转 90° 让圆柱躺平（沿 Z），再绕 Y 转向船头收窄的方向（YXZ 顺序）
    part(root, CYL, CHROME, 0.03, len, 0.03, s * (hw0 + hw1) / 2, h.deckY((z0 + z1) / 2) + 0.32, (z0 + z1) / 2, Math.PI / 2, -s * Math.atan2(hw0 - hw1, z1 - z0), 0, 'YXZ');
  }
}

/** 侧面文字（警察 / POLICE） */
function label(text, color) {
  return cached('l' + text + color, () => {
    const c = Object.assign(document.createElement('canvas'), { width: 512, height: 96 });
    const g = c.getContext('2d');
    g.font = 'bold 50px "Arial Black", "PingFang TC", "Microsoft JhengHei", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.fillText(text, 256, 52);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  });
}

/** 把同一材质的零件合并成一个网格（转盘等需要单独动的部件放在 keep 里不合并） */
function mergeByMaterial(root, keep = []) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert(), m = new THREE.Matrix4(), groups = new Map(), drop = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p && p !== root; p = p.parent) if (keep.includes(p)) return;
    const geo = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld));
    for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') geo.deleteAttribute(k);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const key = o.material.uuid;
    if (!groups.has(key)) groups.set(key, { material: o.material, list: [] });
    groups.get(key).list.push(geo);
    drop.push(o);
  });
  for (const o of drop) o.parent.remove(o);
  for (const { material, list } of groups.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(list), material);
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}

function shell(L, W, H) {
  const g = new THREE.Group(), root = new THREE.Group();
  g.add(root);
  g.userData = { root, boat: true, dims: { L, W, H } };
  return { g, root };
}

// ---------------------------------------------------------------- 各种船
/** 运动快艇：开放式驾驶舱、挡风玻璃、双舷外机（玩家、民用都用） */
function speedboat(L, W, { top, stripe, bottom = 0xf4f4f2, deck = 0xd9d2c3, engines = 0x15171a }) {
  const H = W * 0.36, { g, root } = shell(L, W, H);
  const h = addHull(root, L, W, H, { top, bottom, deck });
  if (stripe) addStripe(root, L, W, h, stripe, 0.62);
  const dy = h.deckY(-L * 0.15);
  // 驾驶舱：深色地板 + 两张白色座椅 + 控制台
  part(root, BOX, DARK, W * 0.78, 0.06, L * 0.42, 0, dy - 0.02, -L * 0.2);
  for (const s of [-1, 1]) {
    part(root, BOX, SEAT, W * 0.26, 0.28, 0.5, s * W * 0.2, dy + 0.14, -L * 0.12);
    part(root, BOX, SEAT, W * 0.26, 0.42, 0.12, s * W * 0.2, dy + 0.35, -L * 0.12 - 0.24, -0.25);
  }
  part(root, BOX, SEAT, W * 0.75, 0.3, 0.45, 0, dy + 0.15, -L * 0.38); // 后排长座
  part(root, BOX, DARK, W * 0.3, 0.4, 0.35, W * 0.2, dy + 0.2, L * 0.02); // 控制台
  addWindshield(root, W, dy, L * 0.07, 0.42);
  addRails(root, L, W, h);
  addOutboards(root, L, W, H * 0.6, 2, engines);
  return g;
}

/** 水警巡逻艇：白色船身 + 深蓝腰线 + 驾驶室 + 警灯 + 侧面“水警 POLICE”字样 */
function policeBoat(L, W, swat = false) {
  const H = W * 0.42, { g, root } = shell(L, W, H);
  const top = swat ? 0x2b3038 : 0xf1f3f6, band = swat ? 0x15181d : 0x1f3f8f;
  const h = addHull(root, L, W, H, { top, bottom: band, deck: swat ? 0x3a3f46 : 0xc9ccd0 });
  addStripe(root, L, W, h, swat ? 0xd0a020 : 0x2f6fe0, 0.5);
  const dy = h.deckY(-L * 0.1);
  const roofY = addCabin(root, W * 0.62, 0.95, L * 0.32, dy, -L * 0.08, swat ? 0x1d2026 : 0xf4f6f8);
  // 警灯
  part(root, BOX, SIREN.red, W * 0.2, 0.16, 0.34, -W * 0.13, roofY + 0.08, -L * 0.08);
  part(root, BOX, SIREN.blue, W * 0.2, 0.16, 0.34, W * 0.13, roofY + 0.08, -L * 0.08);
  part(root, CYL, DARK, 0.05, 0.7, 0.05, 0, roofY + 0.35, -L * 0.2); // 天线
  addOutboards(root, L, W, H * 0.6, 2, swat ? 0x0f1012 : 0xe8eaed);
  // 侧面文字
  const lab = label(swat ? 'SWAT 特警' : 'POLICE 水警', swat ? '#ffd23a' : '#1f3f8f');
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(L * 0.42, L * 0.08), lab);
    m.position.set(s * (h.halfW(L * 0.12) + 0.05), h.deckY(L * 0.12) * 0.62, L * 0.12);
    m.rotation.y = s * Math.PI / 2;
    root.add(m);
  }
  return g;
}

/** 小型游艇：船头船舱（带窗户）+ 上层驾驶台 */
function cruiser(L, W, color) {
  const H = W * 0.45, { g, root } = shell(L, W, H);
  const h = addHull(root, L, W, H, { top: 0xf5f5f3, bottom: 0x1c2a3a, deck: 0xb08a5e });
  addStripe(root, L, W, h, color, 0.55);
  const dy = h.deckY(0);
  const r1 = addCabin(root, W * 0.72, 0.8, L * 0.42, dy, L * 0.02, 0xf7f7f5);
  addCabin(root, W * 0.5, 0.5, L * 0.18, r1, -L * 0.05, 0xf7f7f5, { roof: color });
  addRails(root, L, W, h);
  addOutboards(root, L, W, H * 0.6, 1, 0xe8e8e6);
  return g;
}

/** 渔船：船尾驾驶室、船头空甲板、桅杆 */
function fishing(L, W, color) {
  const H = W * 0.48, { g, root } = shell(L, W, H);
  const h = addHull(root, L, W, H, { top: color, bottom: 0x8a2a20, deck: 0x8f7a5c }, { sheer: 0.3, bowRise: 0.4 });
  const dy = h.deckY(-L * 0.2);
  const r = addCabin(root, W * 0.6, 1.0, L * 0.26, dy, -L * 0.22, 0xf0ece2, { roof: 0x3a3a3a });
  part(root, CYL, DARK, 0.07, 2.2, 0.07, 0, r + 1.1, -L * 0.22);
  part(root, CYL, DARK, 0.05, 1.6, 0.05, 0, r + 1.6, -L * 0.22, 0, 0, Math.PI / 2);
  part(root, BOX, flat(0xe0a020, 0.8), W * 0.5, 0.35, 0.6, 0, dy + 0.18, L * 0.18); // 渔获箱
  return g;
}

/** 玩家装甲巡逻艇：灰绿装甲、船头撞角、带射击孔的驾驶室 */
function armoredBoat(L, W, p2 = false) {
  const H = W * 0.42, { g, root } = shell(L, W, H);
  const h = addHull(root, L, W, H, { top: p2 ? 0x3c5a8c : 0x4f5a3c, bottom: 0x2b2f26, deck: 0x3c4232 });
  addStripe(root, L, W, h, p2 ? 0xf2f2f2 : 0xd8261d, 0.6);
  const dy = h.deckY(-L * 0.1);
  part(root, BOX, paint(p2 ? 0x324d7a : 0x434c33), W * 0.7, 0.9, L * 0.34, 0, dy + 0.45, -L * 0.1);
  part(root, BOX, GLASS, W * 0.6, 0.14, 0.04, 0, dy + 0.72, L * 0.07 + 0.01);
  part(root, BOX, paint(0x3a3d40), W * 0.9, 0.45, 0.35, 0, h.deckY(L * 0.45) - 0.2, L * 0.47); // 撞角
  addOutboards(root, L, W, H * 0.6, 2, 0x1a1c18);
  return g;
}

/** 玩家炮艇：灰色军舰涂装 + 可旋转炮塔（Cannon 系统用 turret / muzzle） */
function gunboat(L, W, p2 = false) {
  const H = W * 0.4, { g, root } = shell(L, W, H);
  const h = addHull(root, L, W, H, { top: p2 ? 0x2a4f8c : 0x8c2a22, bottom: 0x2a2b2d, deck: 0x55595e });
  addStripe(root, L, W, h, 0xf2f2f2, 0.55);
  const dy = h.deckY(-L * 0.15);
  part(root, BOX, paint(p2 ? 0x203d6e : 0x6f2019), W * 0.55, 1.1, L * 0.22, 0, dy + 0.55, -L * 0.25);
  part(root, BOX, GLASS, W * 0.5, 0.2, 0.04, 0, dy + 0.85, -L * 0.14 + 0.01);
  part(root, CYL, DARK, 0.08, 1.8, 0.08, 0, dy + 1.9, -L * 0.28);
  const turret = new THREE.Group();
  turret.position.set(0, h.deckY(L * 0.12), L * 0.12);
  root.add(turret);
  part(turret, BOX, paint(p2 ? 0x3a6fd0 : 0xa8342a), 1.5, 0.7, 1.8, 0, 0.35, 0);
  part(turret, CYL, DARK, 0.26, 2.6, 0.26, 0, 0.4, 1.6, Math.PI / 2, 0, 0);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.4, 2.95);
  turret.add(muzzle);
  addOutboards(root, L, W, H * 0.6, 2, 0x1a1a1a);
  g.userData.turret = turret;
  g.userData.muzzle = muzzle;
  g.userData.keep = [turret];
  return g;
}

/** 浮标（代替雪糕筒）：红白相间，顶上有闪灯 */
function buoy() {
  const { g, root } = shell(0.7, 0.7, 1);
  part(root, CYL, paint(0xd62a1e), 0.8, 0.8, 0.8, 0, 0.1, 0);
  part(root, CYL, paint(0xf2f2f2), 0.55, 0.45, 0.55, 0, 0.7, 0);
  part(root, new THREE.ConeGeometry(0.5, 1, 10), paint(0xd62a1e), 0.5, 0.5, 0.5, 0, 1.15, 0);
  part(root, new THREE.SphereGeometry(0.5, 10, 8), flat(0xffd34d, 0.3), 0.18, 0.18, 0.18, 0, 1.45, 0).material.emissive = new THREE.Color(0xffb000);
  return g;
}

/** 浮动路障（代替路障栏杆）：一排橙色浮筒 + 红白警示板 */
function floatBarrier() {
  const { g, root } = shell(0.7, 3.2, 1);
  for (let i = 0; i < 4; i++) part(root, CYL, paint(0xf06a12), 0.55, 0.78, 0.55, -1.2 + i * 0.8, 0.05, 0, 0, 0, Math.PI / 2);
  for (let i = 0; i < 4; i++) part(root, BOX, paint(i % 2 ? 0xf2f2f2 : 0xd0201b), 0.8, 0.32, 0.08, -1.2 + i * 0.8, 0.75, 0);
  for (const s of [-1.3, 1.3]) part(root, BOX, flat(0xdadada), 0.1, 0.8, 0.1, s, 0.45, 0);
  return g;
}

/** 水雷（海上的钉刺带）：黑色圆球 + 一圈触发角，半浮在水面 */
function seaMine() {
  const { g, root } = shell(1.2, 3.2, 1);
  for (const x of [-1, 0, 1]) {
    part(root, new THREE.SphereGeometry(0.5, 16, 12), paint(0x1d1f22), 0.9, 0.9, 0.9, x, 0.15, 0);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      part(root, CYL, CHROME, 0.06, 0.32, 0.06, x + Math.cos(a) * 0.45, 0.25 + Math.sin(a) * 0.45, 0, 0, 0, a - Math.PI / 2);
    }
    part(root, new THREE.SphereGeometry(0.5, 8, 6), flat(0xff3b2a, 0.4), 0.12, 0.12, 0.12, x, 0.68, 0).material.emissive = new THREE.Color(0xff2010);
  }
  return g;
}

// ---------------------------------------------------------------- 对外接口
// 模板：{ g, meta }。meta 里放对象引用（root / turret），不能放进 userData——clone() 会把 userData 转成 JSON
const templates = new Map();
function template(key, build) {
  if (!templates.has(key)) {
    const g = build(), meta = g.userData;
    g.userData = {};
    mergeByMaterial(meta.root, meta.keep ?? []);
    meta.turretIndex = meta.turret ? meta.root.children.indexOf(meta.turret) : -1;
    templates.set(key, { g, meta });
  }
  return templates.get(key);
}

/** 克隆一艘船（几何体、材质共享）；turret / muzzle 重新指向克隆里的对象 */
function instance(key, build) {
  const { g: src, meta } = template(key, build);
  const g = src.clone(true), root = g.children[0];
  g.userData = { root, boat: true, dims: meta.dims };
  if (meta.turretIndex >= 0) {
    g.userData.turret = root.children[meta.turretIndex];
    g.userData.muzzle = g.userData.turret.children.find((c) => !c.isMesh);
  }
  return g;
}

/** 玩家的船：每个进化等级一种 */
export function makePlayerBoat(tierId, L, W, skin) {
  const p2 = skin === 'p2';
  if (tierId === 'armored') return instance(`pb-armored${p2}`, () => armoredBoat(L, W, p2));
  if (tierId === 'tank') return instance(`pb-tank${p2}`, () => gunboat(L, W, p2));
  if (p2) return instance(`pb-p2-${tierId}`, () => speedboat(L, W, { top: 0xf4f6f8, stripe: 0x1f6fe0, bottom: 0x1d3f7a, engines: 0x1f6fe0 }));
  if (tierId === 'muscle') return instance('pb-muscle', () => speedboat(L, W, { top: 0x1c1e22, stripe: 0xff7a1a, bottom: 0x2a2c30, deck: 0x3a3c40 }));
  return instance('pb-sports', () => speedboat(L, W, { top: 0xc81a14, stripe: 0xf5f5f5, engines: 0xeeeeee }));
}

export function makePoliceBoat(swat, L, W) {
  return instance(swat ? 'swat-boat' : 'police-boat', () => policeBoat(L, W, swat));
}

const CIV_COLORS = [0x2f6fb0, 0xd84a1e, 0x2e8a57, 0xe0b020, 0x7a3fa0, 0x1f9aa8, 0xb02a4a];
/** 民用船：按尺寸挑船型（小的是快艇 / 渔船，大的是游艇） */
export function makeCivilianBoat(L, W) {
  const color = pick(CIV_COLORS), r = Math.random();
  const Lr = Math.round(L * 2) / 2, Wr = Math.round(W * 4) / 4;
  if (L > 5.7) return instance(`yacht:${Lr}:${Wr}:${color}`, () => cruiser(L, W, color));
  if (r < 0.4) return instance(`civ-speed:${Lr}:${Wr}:${color}`, () => speedboat(L, W, { top: color, stripe: 0xf5f5f5 }));
  if (r < 0.7) return instance(`civ-fish:${Lr}:${Wr}:${color}`, () => fishing(L, W, color));
  return instance(`civ-cruiser:${Lr}:${Wr}:${color}`, () => cruiser(L, W, color));
}

export function makeBuoy() {
  return instance('buoy', buoy);
}

export function makeSeaMine() {
  return instance('sea-mine', seaMine);
}

export function makeFloatBarrier() {
  return instance('float-barrier', floatBarrier);
}
