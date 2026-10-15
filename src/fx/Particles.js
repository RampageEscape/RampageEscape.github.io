import * as THREE from 'three';

// ---------------------------------------------------------------- 贴图（canvas 生成，不需要图片文件）
function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** 柔和发光点：中心很亮、边缘渐隐（火焰、余烬、闪光、拖尾都用它，颜色由粒子决定） */
export const GLOW_TEX = canvasTex(64, (g, s) => {
  const r = s / 2, grd = g.createRadialGradient(r, r, 0, r, r, r);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
});

/** 烟团：几个随机的柔和圆叠在一起，边缘不规则 */
export const SMOKE_TEX = canvasTex(128, (g, s) => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 14; i++) {
    const x = s * (0.3 + rnd() * 0.4), y = s * (0.3 + rnd() * 0.4), r = s * (0.16 + rnd() * 0.2);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.32)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }
});

/** 冲击波光环 */
export const RING_TEX = canvasTex(128, (g, s) => {
  const r = s / 2, grd = g.createRadialGradient(r, r, r * 0.55, r, r, r);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.7, 'rgba(255,255,255,0.9)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
});

/** 地面焦痕 */
export const SCORCH_TEX = canvasTex(128, (g, s) => {
  const r = s / 2, grd = g.createRadialGradient(r, r, 0, r, r, r);
  grd.addColorStop(0, 'rgba(0,0,0,0.85)');
  grd.addColorStop(0.5, 'rgba(10,6,4,0.55)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
});

// ---------------------------------------------------------------- GPU 点精灵层
const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aAngle;
  attribute vec3 aColor;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vAngle;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vAngle = aAngle;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale; // 正交相机：大小按“每米多少像素”换算
  }
`;
const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vAngle;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float c = cos(vAngle), s = sin(vAngle);
    vec2 uv = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
    vec4 t = texture2D(uMap, uv);
    gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
  }
`;

/**
 * 一层粒子 = 一个 THREE.Points（整层只要一次 draw call）。
 * 粒子数据放在 JS 对象里（方便写逻辑），每帧把活着的粒子写进 GPU 缓冲区。
 * 颜色可以大于 1（HDR）：配合 Bloom，火焰和火花会真的“发光”。
 */
export class ParticleLayer {
  constructor(scene, { capacity, map, additive }) {
    this.capacity = capacity;
    this.list = [];
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.angle = new Float32Array(capacity);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAngle', new THREE.BufferAttribute(this.angle, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uScale: { value: 20 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    scene.add(this.points);
  }

  /** 加一个粒子；满了就挤掉最老的（宁可少一点也不掉帧） */
  add(p) {
    if (this.list.length >= this.capacity) this.list.shift();
    this.list.push(p);
    return p;
  }

  /** 把粒子写进缓冲区（update 时由 Effects 调用） */
  flush() {
    const n = this.list.length;
    for (let i = 0; i < n; i++) {
      const p = this.list[i];
      this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
      this.col[i * 3] = p.r; this.col[i * 3 + 1] = p.g; this.col[i * 3 + 2] = p.b;
      this.size[i] = p.s;
      this.alpha[i] = p.a;
      this.angle[i] = p.rot;
    }
    for (const k of ['position', 'aColor', 'aSize', 'aAlpha', 'aAngle']) this.geo.attributes[k].needsUpdate = true;
    this.geo.setDrawRange(0, n);
  }
}

/** 火花拖尾：每颗火花画成一条从“现在位置”到“稍早位置”的发光线段（LineSegments，一次 draw call） */
export class StreakLayer {
  constructor(scene, capacity) {
    this.capacity = capacity;
    this.list = [];
    this.pos = new Float32Array(capacity * 6);
    this.col = new Float32Array(capacity * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
    scene.add(this.lines);
  }

  add(p) {
    if (this.list.length >= this.capacity) this.list.shift();
    this.list.push(p);
  }

  flush() {
    const n = this.list.length;
    for (let i = 0; i < n; i++) {
      const p = this.list[i], k = i * 6, len = 0.045, fade = p.a;
      this.pos[k] = p.x; this.pos[k + 1] = p.y; this.pos[k + 2] = p.z;
      this.pos[k + 3] = p.x - p.vx * len; this.pos[k + 4] = p.y - p.vy * len; this.pos[k + 5] = p.z - p.vz * len;
      this.col[k] = p.r * fade; this.col[k + 1] = p.g * fade; this.col[k + 2] = p.b * fade;
      this.col[k + 3] = 0; this.col[k + 4] = 0; this.col[k + 5] = 0; // 尾端渐隐
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.setDrawRange(0, n * 2);
  }
}
