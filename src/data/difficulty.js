/**
 * 难度设定（每局开始时套用）。数值都是相对“普通”的倍率。
 *   policeMax / policeMul : 同时追捕的警车上限 / 刷新速度倍率
 *   speed     : 警车速度倍率（橡皮筋的最高速、远距离加速都乘它）
 *   dmg       : 玩家受到的伤害倍率
 *   sideRam   : 被警车侧挤时受到的伤害比例（0 = 不扣血，只推一把）
 *   barricade : 路障间隔倍率（越小越密）
 *   stars     : 起始额外星级
 *   heliFrom / tankFrom : 从几星开始出现直升机 / 坦克
 *   heliGap   : 直升机出现间隔倍率
 *   bust      : 被捕条上涨速度倍率
 *   ramCost   : 重型车辆（装甲车 / 坦克）撞爆东西时自己掉的血倍率
 *   traffic   : 民用车数量倍率
 *   reward    : 分数和金币倍率（难度越高奖励越多）
 */
export const DIFFICULTIES = {
  easy: { policeMax: 6, policeMul: 0.85, speed: 0.95, dmg: 0.8, sideRam: 0, barricade: 1.2, stars: 0, heliFrom: 4, tankFrom: 4, heliGap: 1.3, bust: 0.8, ramCost: 1.5, traffic: 0.9, reward: 0.8 },
  normal: { policeMax: 9, policeMul: 1.15, speed: 1.03, dmg: 1.2, sideRam: 0, barricade: 0.9, stars: 0, heliFrom: 3, tankFrom: 3, heliGap: 0.85, bust: 1.2, ramCost: 4, traffic: 1.1, reward: 1 },
  hard: { policeMax: 11, policeMul: 1.5, speed: 1.12, dmg: 1.6, sideRam: 0.6, barricade: 0.7, stars: 1, heliFrom: 2, tankFrom: 2, heliGap: 0.6, bust: 1.5, ramCost: 3.5, traffic: 1.3, reward: 1.6 },
  insane: { policeMax: 15, policeMul: 2.2, speed: 1.25, dmg: 2.3, sideRam: 1, barricade: 0.5, stars: 2, heliFrom: 1, tankFrom: 1, heliGap: 0.35, bust: 2.2, ramCost: 6, traffic: 1.6, reward: 2.5 },
};

export const DIFFICULTY_IDS = Object.keys(DIFFICULTIES);

/** 这一局正在用的难度（startRun 时设置，各系统直接读取） */
export const RUN = { id: 'normal', diff: DIFFICULTIES.normal };
export function setDifficulty(id) {
  RUN.id = DIFFICULTIES[id] ? id : 'normal';
  RUN.diff = DIFFICULTIES[RUN.id];
}
