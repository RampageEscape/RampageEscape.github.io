/**
 * 闯关模式的关卡
 *   length     : 终点在多少米
 *   pool       : 这一关的路口会通往哪些地图（第一张是起点）
 *   startStars : 起始通缉星级（越高警察越多、越早出现坦克）
 *   kills      : ★★ 需要摧毁的警车数量
 * 星级：★ 抵达终点；★★ 摧毁足够多的警车；★★★ 抵达终点时血量 ≥ 50%
 * 每过一个路口就有一个改装站，后面的关卡路口更多，可以一路进化到坦克。
 */
export const LEVELS = [
  { id: 1, length: 1500, pool: ['city', 'forest'], startStars: 1, kills: 6 },
  { id: 2, length: 2100, pool: ['forest', 'city', 'desert'], startStars: 1, kills: 12 },
  { id: 3, length: 2700, pool: ['desert', 'coast', 'city'], startStars: 2, kills: 18 },
  { id: 4, length: 3300, pool: ['coast', 'sea', 'harbor', 'forest', 'desert'], startStars: 2, kills: 25 },
  { id: 5, length: 4000, pool: ['harbor', 'sea', 'city', 'desert', 'coast', 'forest'], startStars: 3, kills: 35 },
];
