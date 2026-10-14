export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
// 帧率无关的指数平滑：sharpness 越大跟随越快
export const damp = (a, b, sharpness, dt) => lerp(a, b, 1 - Math.exp(-sharpness * dt));
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const rand = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];

export function dampAngle(a, b, sharpness, dt) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-sharpness * dt));
}

// 可复现的伪随机数（同一个地图区块每次生成都一样）
export function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const vibrate = (pattern) => {
  try { navigator.vibrate?.(pattern); } catch { /* 不支持震动的设备直接忽略 */ }
};
