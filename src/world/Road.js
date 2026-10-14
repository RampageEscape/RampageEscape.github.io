import { CONFIG } from '../config.js';
import { clamp, smoothstep } from '../core/utils.js';

const R = CONFIG.road;
export const ROAD_HALF = (R.lanes * R.laneWidth) / 2;
export const laneOffset = (i) => (i - (R.lanes - 1) / 2) * R.laneWidth;
export const nearestLane = (lat) => clamp(Math.round(lat / R.laneWidth + (R.lanes - 1) / 2), 0, R.lanes - 1);

/**
 * 道路中心线。所有车辆都用 (z, lateral) 的“道路坐标”表示：
 *   z       = 沿前进方向的距离
 *   lateral = 相对中心线的横向偏移（+X 是车头朝 +Z 时的左侧）
 * 城市段是直路，森林段的中心线是平滑的正弦曲线（蜿蜒山路）。
 */
export const Road = {
  biomeAt(z) {
    return Math.floor(Math.max(z, 0) / R.biomeLength) % 2 === 0 ? 'city' : 'forest';
  },
  // 0 = 直路，1 = 完全弯曲；在生物群系边界平滑过渡
  curveWeight(z) {
    const L = R.biomeLength, T = R.transition;
    const t = ((z % (2 * L)) + 2 * L) % (2 * L);
    return smoothstep(L, L + T, t) * (1 - smoothstep(2 * L - T, 2 * L, t));
  },
  centerX(z) {
    const w = this.curveWeight(z);
    if (w === 0) return 0;
    return w * (16 * Math.sin(z * 0.011) + 7 * Math.sin(z * 0.027 + 1.3));
  },
  heading(z) {
    return Math.atan2(this.centerX(z + 1) - this.centerX(z - 1), 2);
  },
};
