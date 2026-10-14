import { CONFIG } from '../config.js';
import { clamp } from '../core/utils.js';
import { Path } from './Path.js';

export { BIOMES, BIOME_IDS } from './biomes.js';

const R = CONFIG.road;
export const ROAD_HALF = (R.lanes * R.laneWidth) / 2;
export const laneOffset = (i) => (i - (R.lanes - 1) / 2) * R.laneWidth;
export const nearestLane = (lat) => clamp(Math.round(lat / R.laneWidth + (R.lanes - 1) / 2), 0, R.lanes - 1);

/**
 * 当前的主路线（玩家正在开的那条）。由 LevelManager 生成和切换。
 * 所有车辆用“道路坐标”(z = 沿路里程, lateral = 横向偏移) 表示位置，
 * 通过 Road.sample() 换算成世界坐标，所以路线怎么拐弯，AI 和碰撞逻辑都不用改。
 */
export const Road = {
  path: new Path().addLine(400, 'city'),

  sample(s, lat = 0, out = {}) {
    return this.path.sample(s, lat, out);
  },
  heading(s) {
    return this.path.heading(s);
  },
  biomeAt(s) {
    return this.path.biomeAt(s);
  },
};
