import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// 路边道具的精细模型（程序化生成，按“几何体 + 材质”成对导出，方便地图区块用 InstancedMesh 批量摆放）：
//   路灯（渐细灯杆 + 弧形灯臂 + LED 灯头）、松树（多层带锯齿的枝叶，可带积雪）、棕榈树（弯曲环纹树干 + 羽状叶）、
//   瓦楞集装箱（法线贴图做出凹凸）、灯塔、帆船。

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function canvasTexture(w, h, draw, srgb = true) {
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** 给几何体加上统一的顶点颜色（合并不同部件时用） */
function paint(geo, color) {
  const c = new THREE.Color(color), n = geo.attributes.position.count, arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** 合并前统一属性（都转成非索引，只保留 position / normal / uv / color） */
function clean(geo, color) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (color != null || !g.attributes.color) paint(g, color ?? 0xffffff);
  return g;
}

// ---------------------------------------------------------------- 路灯
/** 灯臂朝局部 -X 伸出（摆放时让 -X 指向马路）。灯杆底部在原点，高约 8 米 */
export const LAMP = (() => {
  const parts = [];
  parts.push(new THREE.CylinderGeometry(0.2, 0.24, 0.6, 12).translate(0, 0.3, 0)); // 底座
  parts.push(new THREE.CylinderGeometry(0.07, 0.115, 7.6, 12).translate(0, 4.1, 0)); // 渐细灯杆
  const arm = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 7.6, 0), new THREE.Vector3(-0.5, 8.3, 0), new THREE.Vector3(-2.1, 8.05, 0));
  parts.push(new THREE.TubeGeometry(arm, 20, 0.05, 8));
  const head = new THREE.CapsuleGeometry(0.15, 0.7, 4, 10).rotateZ(Math.PI / 2);
  head.scale(1, 0.55, 1.15);
  parts.push(head.translate(-2.35, 7.98, 0));
  const metal = mergeGeometries(parts.map((g) => clean(g, 0xffffff)));
  const light = new THREE.PlaneGeometry(0.72, 0.22).rotateX(Math.PI / 2).translate(-2.35, 7.9, 0);
  const lightMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  lightMat.color.setRGB(2.2, 2.05, 1.7); // HDR：Bloom 下会发光
  return {
    metal,
    light,
    metalMat: new THREE.MeshStandardMaterial({ color: 0x3e4247, roughness: 0.45, metalness: 0.75, vertexColors: true }),
    lightMat,
  };
})();

// ---------------------------------------------------------------- 松树
/**
 * 多层枝叶：每层是一个边缘带锯齿、往下垂的圆锥，层与层之间错开角度；顶点颜色由内到外由深到浅。
 * snow = true：朝上的枝叶面染成白色（雪地森林）。高约 9 米（缩放系数 1）。
 */
function pineGeometry(snow) {
  const parts = [new THREE.CylinderGeometry(0.1, 0.24, 2.4, 8).translate(0, 1.2, 0)];
  const trunkCount = 1;
  const tiers = 8;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1), r = 2.3 * (1 - t * 0.82) + 0.2, h = 2.0 - t * 0.9, y = 1.6 + t * 6.6;
    const cone = new THREE.ConeGeometry(r, h, 18, 2, true);
    const p = cone.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), z = p.getZ(k), yy = p.getY(k), rim = yy < -h / 2 + 0.01;
      if (rim) {
        // 边缘锯齿 + 下垂
        const a = Math.atan2(z, x), jag = 1 + 0.18 * Math.sin(a * 9 + i) + 0.1 * (rnd() - 0.5);
        p.setXYZ(k, x * jag, yy - 0.35 * jag, z * jag);
      }
    }
    cone.rotateY(rnd() * 6.28);
    cone.translate(0, y + h / 2, 0);
    parts.push(cone);
  }
  const geos = parts.map((g, idx) => clean(g, idx < trunkCount ? 0x4a3426 : 0xffffff));
  // 枝叶的顶点颜色：越靠外、越靠下越深；雪地版朝上的面变白
  for (let gi = trunkCount; gi < geos.length; gi++) {
    const g = geos[gi];
    g.computeVertexNormals();
    const p = g.attributes.position, n = g.attributes.normal, col = g.attributes.color;
    const dark = new THREE.Color(0x1d3b22), light = new THREE.Color(0x3e6a38), white = new THREE.Color(0xeef4f7), c = new THREE.Color();
    for (let k = 0; k < p.count; k++) {
      const radial = Math.min(1, Math.hypot(p.getX(k), p.getZ(k)) / 2.3);
      c.copy(dark).lerp(light, 0.35 + 0.5 * radial + (rnd() - 0.5) * 0.15);
      if (snow && n.getY(k) > 0.45 && rnd() < 0.85) c.lerp(white, 0.7 + rnd() * 0.3);
      col.setXYZ(k, c.r, c.g, c.b);
    }
  }
  return mergeGeometries(geos);
}
const PINE_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.DoubleSide });
export const PINE = { geo: pineGeometry(false), mat: PINE_MAT };
export const PINE_SNOW = { geo: pineGeometry(true), mat: PINE_MAT };

// ---------------------------------------------------------------- 棕榈树
const FROND_TEX = canvasTexture(128, 512, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  g.strokeStyle = '#6b8a3a';
  g.lineWidth = 6;
  g.beginPath(); g.moveTo(w / 2, h); g.lineTo(w / 2, 0); g.stroke();
  for (let y = 12; y < h - 10; y += 9) {
    const len = (w / 2 - 6) * Math.sin(((h - y) / h) * Math.PI) ** 0.6;
    for (const s of [-1, 1]) {
      g.strokeStyle = `hsl(${88 + Math.random() * 18}, ${45 + Math.random() * 15}%, ${26 + Math.random() * 12}%)`;
      g.lineWidth = 4;
      g.beginPath(); g.moveTo(w / 2, y + 8); g.quadraticCurveTo(w / 2 + s * len * 0.6, y + 2, w / 2 + s * len, y - 14); g.stroke();
    }
  }
});
function palmGeometry() {
  // 树干：带环纹的车床旋转体，再往一侧弯
  const prof = [];
  for (let i = 0; i <= 28; i++) {
    const y = (i / 28) * 7.2, ring = 0.025 * (i % 2 ? 1 : -1);
    prof.push(new THREE.Vector2(0.3 - (y / 7.2) * 0.13 + ring, y));
  }
  const trunk = new THREE.LatheGeometry(prof, 10);
  const p = trunk.attributes.position;
  for (let k = 0; k < p.count; k++) { const y = p.getY(k); p.setX(k, p.getX(k) + 0.9 * (y / 7.2) ** 2); }
  trunk.computeVertexNormals();
  const tg = clean(trunk, 0x7a5a3a);
  const tc = tg.attributes.color, tp = tg.attributes.position;
  for (let k = 0; k < tp.count; k++) { const v = Math.floor(tp.getY(k) / 0.257) % 2 ? 0.85 : 1; tc.setXYZ(k, 0.48 * v, 0.36 * v, 0.24 * v); }
  // 叶子：8 片弯垂的长条（带羽状叶贴图），从树顶向四周散开
  const fronds = [];
  for (let i = 0; i < 9; i++) {
    const f = new THREE.PlaneGeometry(1.1, 3.6, 1, 10).rotateX(-Math.PI / 2).translate(0, 0, 1.8);
    const fp = f.attributes.position;
    for (let k = 0; k < fp.count; k++) { const z = fp.getZ(k); fp.setY(k, 0.5 * z - 0.16 * z * z); }
    f.rotateY((i / 9) * Math.PI * 2 + rnd() * 0.3).translate(0.9, 7.15, 0);
    fronds.push(clean(f, 0xffffff));
  }
  return { trunk: tg, fronds: mergeGeometries(fronds) };
}
const palm = palmGeometry();
export const PALM = {
  trunk: palm.trunk,
  trunkMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
  fronds: palm.fronds,
  frondMat: new THREE.MeshStandardMaterial({ map: FROND_TEX, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.8 }),
};

// ---------------------------------------------------------------- 瓦楞集装箱
const CONTAINER_TEX = canvasTexture(256, 256, (g, w, h) => {
  g.fillStyle = '#e9e9e6';
  g.fillRect(0, 0, w, h);
  for (let x = 0; x < w; x += 10.67) { g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(x, 0, 4, h); g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(x + 5, 0, 3, h); }
  g.fillStyle = 'rgba(30,30,30,0.55)';
  g.fillRect(0, 0, 8, h); g.fillRect(w - 8, 0, 8, h); g.fillRect(0, 0, w, 7); g.fillRect(0, h - 7, w, 7); // 角柱和上下框
  for (let i = 0; i < 40; i++) {
    // 锈迹 / 污渍
    const x = Math.random() * w, y = Math.random() * h, r = 4 + Math.random() * 18, gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(110,60,30,0.28)');
    gr.addColorStop(1, 'rgba(110,60,30,0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
});
const CONTAINER_NOR = canvasTexture(256, 8, (g, w, h) => {
  // 瓦楞的法线：竖条纹的斜面（左边朝左、右边朝右）
  for (let x = 0; x < w; x++) {
    const ph = ((x % 10.67) / 10.67) * Math.PI * 2, nx = Math.cos(ph) * 0.55;
    g.fillStyle = `rgb(${Math.round((nx * 0.5 + 0.5) * 255)},128,${Math.round(Math.sqrt(1 - nx * nx) * 255)})`;
    g.fillRect(x, 0, 1, h);
  }
}, false);
export const CONTAINER = {
  geo: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  mat: new THREE.MeshStandardMaterial({ map: CONTAINER_TEX, normalMap: CONTAINER_NOR, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.55, metalness: 0.45 }),
};

// ---------------------------------------------------------------- 灯塔 / 帆船（海上，整组模型）
/** 灯塔：红白条纹塔身（顶点颜色）、环形观景台、玻璃灯室（发光）、圆顶 */
export function makeLighthouse() {
  const g = new THREE.Group();
  const prof = [];
  for (let i = 0; i <= 20; i++) prof.push(new THREE.Vector2(1.6 - (i / 20) * 0.7, (i / 20) * 12));
  const tower = new THREE.LatheGeometry(prof, 24);
  const tc = clean(tower), tp = tc.attributes.position, col = tc.attributes.color;
  for (let k = 0; k < tp.count; k++) { const red = Math.floor(tp.getY(k) / 2.4) % 2 === 1; col.setXYZ(k, red ? 0.75 : 0.95, red ? 0.12 : 0.95, red ? 0.1 : 0.93); }
  g.add(new THREE.Mesh(tc, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 })));
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.5, metalness: 0.6 });
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 0.15, 24), dark);
  gallery.position.y = 12.1;
  g.add(gallery);
  const rail = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.04, 6, 32), dark);
  rail.rotation.x = Math.PI / 2;
  rail.position.y = 12.7;
  g.add(rail);
  const lamp = new THREE.MeshBasicMaterial();
  lamp.color.setRGB(3, 2.7, 1.8);
  const room = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 1.3, 16), lamp);
  room.position.y = 12.9;
  g.add(room);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.85, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xa8231c, roughness: 0.5 }));
  dome.position.y = 13.55;
  g.add(dome);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

/** 帆船：白色船身（车床旋转的半边）、桅杆、主帆和前帆（微微鼓起的三角帆） */
export function makeSailboat(color = 0xf7f7f2) {
  const g = new THREE.Group();
  const prof = [];
  for (let i = 0; i <= 16; i++) { const t = i / 16; prof.push(new THREE.Vector2(Math.sin(t * Math.PI) * 0.9 + 0.001, (t - 0.5) * 6)); }
  const hull = new THREE.LatheGeometry(prof, 16, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2); // 半个车床体 = 船身（在甲板下面）
  hull.scale(1, 0.55, 1);
  g.add(new THREE.Mesh(hull, new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.4, side: THREE.DoubleSide })));
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 5.4).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xb08a5e, roughness: 0.8 }));
  deck.position.y = 0.02;
  g.add(deck);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 8.5, 8), new THREE.MeshStandardMaterial({ color: 0xc9cdd2, metalness: 0.8, roughness: 0.3 }));
  mast.position.set(0, 4.25, 0.6);
  g.add(mast);
  const sail = (pts, bulge) => {
    const geo = new THREE.BufferGeometry(), seg = 8, pos = [];
    const [a, b, c] = pts;
    for (let i = 0; i < seg; i++) {
      for (let j = 0; j < seg - i; j++) {
        const p = (u, v) => { const w = 1 - u - v; return [a[0] * w + b[0] * u + c[0] * v + bulge * u * v * 4, a[1] * w + b[1] * u + c[1] * v, a[2] * w + b[2] * u + c[2] * v]; };
        const u0 = i / seg, v0 = j / seg, d = 1 / seg;
        pos.push(...p(u0, v0), ...p(u0 + d, v0), ...p(u0, v0 + d));
        if (j < seg - i - 1) pos.push(...p(u0 + d, v0), ...p(u0 + d, v0 + d), ...p(u0, v0 + d));
      }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.7, side: THREE.DoubleSide }));
  };
  g.add(sail([[0, 0.8, 0.5], [0, 8.4, 0.55], [0, 0.9, -2.4]], 0.35)); // 主帆
  g.add(sail([[0, 0.9, 0.7], [0, 7.6, 0.68], [0, 0.7, 2.9]], 0.3)); // 前帆
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

// ---------------------------------------------------------------- 龙门吊
/** 两点之间的一根细钢管 */
function bar(a, b, r, color) {
  const d = new THREE.Vector3().subVectors(b, a), geo = new THREE.CylinderGeometry(r, r, d.length(), 6);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return clean(geo, color);
}
/** 方形桁架梁：沿局部 +X 从 0 到 len，截面 h（高）× w（宽）；四根主弦杆 + 各面 N 形腹杆 */
function trussBeam(len, h, w, color, chord = 0.12) {
  const parts = [], V = (x, y, z) => new THREE.Vector3(x, y, z), n = Math.max(2, Math.round(len / (h * 1.1)));
  const corners = [[0, -w / 2], [0, w / 2], [h, w / 2], [h, -w / 2]];
  for (const [y, z] of corners) parts.push(clean(new THREE.BoxGeometry(len, chord, chord).translate(len / 2, y, z), color));
  for (let k = 0; k <= n; k++) {
    const x = (k / n) * len, x1 = ((k + 1) / n) * len;
    for (let c = 0; c < 4; c++) {
      const [y0, z0] = corners[c], [y1, z1] = corners[(c + 1) % 4];
      parts.push(bar(V(x, y0, z0), V(x, y1, z1), chord * 0.35, color));
      if (k < n) parts.push(bar(V(k % 2 ? x : x1, y0, z0), V(k % 2 ? x1 : x, y1, z1), chord * 0.3, color));
    }
  }
  return parts;
}

/**
 * 轮胎式龙门吊（跨在集装箱堆上）：局部 X = 横跨方向（-9.5 ~ 9.5），Z = 沿马路方向（0 ~ 7），高 17 米
 *   四根桁架立柱 + 门架斜撑、顶部两道桁架大梁、底部行走梁 + 轮组、红色小车 + 司机室、钢缆吊着吊具和一个集装箱
 */
export function makeGantryCrane() {
  const Y = 0xe2b21c, RED = 0xc23a2b, DARK = 0x2a2b2e, parts = [];
  const legX = [-8.75, 8.75], legZ = [0, 7], H = 16;
  for (const x of legX) {
    for (const z of legZ) parts.push(...trussBeam(H, 0.9, 0.9, Y).map((g) => g.rotateZ(Math.PI / 2).translate(x + 0.45, 0, z)));
    parts.push(clean(new THREE.BoxGeometry(1.2, 1.0, 9.2).translate(x, 0.9, 3.5), Y)); // 行走梁
    for (const z of [-0.6, 7.6]) {
      parts.push(clean(new THREE.BoxGeometry(1.0, 0.7, 1.6).translate(x, 0.35, z), DARK));
      for (const dz of [-0.45, 0.45]) parts.push(clean(new THREE.CylinderGeometry(0.42, 0.42, 0.5, 14).rotateZ(Math.PI / 2).translate(x, 0.42, z + dz), 0x151515)); // 轮胎
    }
    parts.push(bar(new THREE.Vector3(x, 1.4, 0.3), new THREE.Vector3(x, H - 1, 6.7), 0.12, Y)); // 侧面斜撑
    parts.push(bar(new THREE.Vector3(x, 1.4, 6.7), new THREE.Vector3(x, H - 1, 0.3), 0.12, Y));
  }
  for (const z of legZ) {
    parts.push(...trussBeam(19.5, 1.4, 1.0, Y, 0.16).map((g) => g.translate(-9.75, H, z)));
    parts.push(...[-1, 1].map((s) => bar(new THREE.Vector3(s * 8.75, H - 3, z), new THREE.Vector3(s * 5.5, H, z), 0.14, Y))); // 门架角撑
  }
  for (const x of legX) parts.push(clean(new THREE.BoxGeometry(1.0, 1.0, 7.9).translate(x, H + 0.7, 3.5), Y)); // 顶部纵梁
  // 小车 + 司机室
  const tx = -3.2;
  parts.push(clean(new THREE.BoxGeometry(3.2, 1.5, 8.4).translate(tx, H + 2.1, 3.5), RED));
  parts.push(clean(new THREE.BoxGeometry(3.4, 0.25, 8.6).translate(tx, H + 2.95, 3.5), 0xf2f2f2));
  parts.push(clean(new THREE.BoxGeometry(1.8, 1.8, 2.0).translate(tx - 1.0, H - 1.1, 0.9), 0xf2f2f2));
  parts.push(clean(new THREE.BoxGeometry(1.84, 0.9, 1.6).translate(tx - 1.0, H - 1.0, 0.9), 0x1d2a36)); // 司机室玻璃
  // 钢缆 + 吊具 + 集装箱
  const hookY = 7.4;
  for (const dx of [-0.9, 0.9]) for (const dz of [2.0, 5.0]) parts.push(bar(new THREE.Vector3(tx + dx, H + 1.4, 3.5 + (dz - 3.5) * 0.4), new THREE.Vector3(tx + dx, hookY + 0.4, dz), 0.03, DARK));
  parts.push(clean(new THREE.BoxGeometry(2.5, 0.35, 6.2).translate(tx, hookY + 0.2, 3.5), Y));
  parts.push(clean(new THREE.BoxGeometry(2.44, 2.55, 6.06).translate(tx, hookY - 2.55, 3.5), 0x1f5fa8));
  const geo = mergeGeometries(parts);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.55 }));
  mesh.castShadow = true;
  const g = new THREE.Group();
  g.add(mesh);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.4, 0.2) }));
  beacon.position.set(-9.2, H + 1.7, 0);
  const b2 = beacon.clone();
  b2.position.set(9.2, H + 1.7, 7);
  g.add(beacon, b2);
  return g;
}

// ---------------------------------------------------------------- 货轮
const SHIP_BOXES = [0xc0392b, 0x2e86c1, 0x27ae60, 0xd68910, 0x7d3c98, 0x839192, 0x1f618d, 0xa04000, 0xe8e8e8];
/**
 * 远处的集装箱货轮（长 64 米，船身底部在 y = 0，吃水约 2 米）
 *   船身：俯视轮廓挤出（方尾 + 尖船头），下半部内收、船头前倾，水线以下红色防污漆；
 *   甲板上一排排集装箱（2~4 层），船尾白色驾驶楼（窗带 + 两翼）、烟囱，船头桅杆
 */
export function makeCargoShip(hullColor = 0x2b3f5c, seedValue = 1) {
  let s0 = seedValue * 9973;
  const r = () => ((s0 = (s0 * 16807) % 2147483647) / 2147483647);
  const D = 6, parts = [];
  const top = new THREE.Shape();
  top.moveTo(-5.5, -31); top.lineTo(5.5, -31); top.lineTo(5.5, 16);
  top.quadraticCurveTo(5.4, 26, 0, 33); top.quadraticCurveTo(-5.4, 26, -5.5, 16); top.closePath();
  const hull = new THREE.ExtrudeGeometry(top, { depth: D, steps: 6, bevelEnabled: false, curveSegments: 10 }).rotateX(Math.PI / 2).translate(0, D, 0);
  const p = hull.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), t = 1 - y / D; // 越往下越收窄
    let z = p.getZ(i);
    if (z > 14) z -= t * t * 5; // 船头前倾
    p.setXYZ(i, p.getX(i) * (1 - t * t * 0.28), y, z);
  }
  hull.computeVertexNormals();
  const hc = new THREE.Color(hullColor), red = new THREE.Color(0x8e2b22), cols = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) (p.getY(i) < 2.2 ? red : hc).toArray(cols, i * 3);
  hull.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  parts.push(clean(hull));
  parts.push(clean(new THREE.BoxGeometry(10.6, 0.3, 46).translate(0, D + 0.15, -4), 0xb8b2a6)); // 甲板
  parts.push(clean(new THREE.BoxGeometry(11.2, 1.0, 0.4).translate(0, D + 0.5, 15.5), hullColor)); // 船头挡浪板
  // 集装箱：沿船长 7 排 × 横向 4 列，2~4 层
  for (let row = 0; row < 7; row++) {
    const z = -19 + row * 6.3;
    for (let col = 0; col < 4; col++) {
      const tiers = 2 + Math.floor(r() * 3);
      for (let k = 0; k < tiers; k++) {
        parts.push(clean(new THREE.BoxGeometry(2.4, 2.5, 6.0).translate(-3.75 + col * 2.5, D + 0.3 + 1.25 + k * 2.55, z), SHIP_BOXES[Math.floor(r() * SHIP_BOXES.length)]));
      }
    }
  }
  // 驾驶楼 + 窗带 + 两翼 + 烟囱
  parts.push(clean(new THREE.BoxGeometry(10, 10, 6).translate(0, D + 5, -25), 0xf2f2ee));
  parts.push(clean(new THREE.BoxGeometry(10.1, 1.1, 6.1).translate(0, D + 8.6, -25), 0x1c2733));
  parts.push(clean(new THREE.BoxGeometry(14, 0.4, 3).translate(0, D + 9.6, -23.5), 0xf2f2ee));
  parts.push(clean(new THREE.BoxGeometry(3, 6, 3).translate(0, D + 12, -28.5), 0xf2f2ee));
  parts.push(clean(new THREE.BoxGeometry(3.05, 1.4, 3.05).translate(0, D + 13.8, -28.5), hullColor));
  parts.push(clean(new THREE.CylinderGeometry(0.15, 0.15, 7, 6).translate(0, D + 3.5, 22), 0xe8e8e8)); // 船头桅杆
  const mesh = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.25 }));
  mesh.receiveShadow = true;
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}
