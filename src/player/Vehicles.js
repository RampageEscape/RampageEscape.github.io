import { makePlayerCar, makeMuscleCar, makeArmoredCar, makePlayerTank } from '../models/Models.js';

/**
 * 玩家车辆进化路线：跑车 → 肌肉车 → 装甲车 → 坦克
 *   hp       : 这一级的基础血量（进化时血量上限按差值增加，并回满）
 *   speed    : 巡航速度加成
 *   ram      : 不冲刺也能把警车撞爆（只掉一点血）
 *   cannon   : 可以开炮
 *   tankKill : 能撞毁敌方坦克（不冲刺时）
 */
export const TIERS = [
  { id: 'sports', hp: 100, speed: 0, length: 4.4, width: 2.0, model: makePlayerCar },
  { id: 'muscle', hp: 140, speed: 3, length: 4.8, width: 2.15, model: makeMuscleCar },
  { id: 'armored', hp: 200, speed: 1, length: 5.4, width: 2.45, model: makeArmoredCar, ram: true },
  { id: 'tank', hp: 280, speed: 0, length: 7.0, width: 3.1, model: makePlayerTank, ram: true, cannon: true, tankKill: true },
];
