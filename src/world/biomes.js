/**
 * 地图（生物群系）定义
 *   curve  : 道路蜿蜒程度（0 = 笔直，1 = 最弯）
 *   tanks  : 这张地图会不会出现敌方坦克
 *   sky    : 天空 / 雾的颜色
 *   ground : 远处地面的颜色（全局地面）
 *   snow   : 是否下雪
 */
export const BIOMES = {
  city: { curve: 0, tanks: true, sky: 0xd8c9b2, ground: 0x9b8f82 },
  forest: { curve: 1, tanks: false, sky: 0xdbe4e9, ground: 0xd8e1e6, snow: true },
  desert: { curve: 0.7, tanks: true, sky: 0xf0d9b0, ground: 0xe3c48d },
  coast: { curve: 0.85, tanks: false, sky: 0xbfe3f2, ground: 0x86a85a },
  harbor: { curve: 0, tanks: true, sky: 0xc9cdd2, ground: 0x8d9096 },
  // 夜晚地图：天光很暗，靠霓虹灯带、发光窗户和 Bloom 照亮
  neon: { curve: 0.3, tanks: true, sky: 0x0b0820, ground: 0x15121f, night: true },
};

export const BIOME_IDS = Object.keys(BIOMES);
