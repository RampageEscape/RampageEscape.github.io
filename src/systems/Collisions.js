/**
 * 碰撞检测：所有车辆都在道路坐标系 (z, lateral) 里，用轴对齐矩形重叠判定就够了，
 * 比通用物理引擎便宜得多，弯道上也成立。
 */
export function overlaps(a, b, k = 0.9) {
  return Math.abs(a.z - b.z) < (a.colL + b.colL) * 0.5 * k && Math.abs(a.lateral - b.lateral) < (a.colW + b.colW) * 0.5 * k;
}

export function resolveCollisions(game) {
  const { player, spawner } = game;
  const all = spawner.entities;

  // 玩家 vs 一切：具体结果由各实体的 onPlayerCollision 决定（会读取 player.collisionTag）
  if (player.alive) {
    for (const e of all) if (e.collidable && overlaps(player, e)) e.onPlayerCollision(player, game);
  }

  // 追捕中的警车 vs 其他：警车之间互相挤开，撞上别的东西就炸（玩家可以引诱警车撞车）
  for (const cop of spawner.police) {
    if (!cop.collidable || cop.mode !== 'chase') continue;
    for (const o of all) {
      if (o === cop || !o.collidable || !overlaps(cop, o, 0.85)) continue;
      if (o.mode === 'chase') separate(cop, o);
      else cop.crashInto(o, game);
      if (!cop.collidable) break;
    }
  }
}

function separate(a, b) {
  const push = (Math.sign(a.lateral - b.lateral) || 1) * 2.5;
  a.latVel += push;
  b.latVel -= push;
  const rear = a.z < b.z ? a : b;
  rear.speed -= 3;
}
