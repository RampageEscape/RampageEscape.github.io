/**
 * 碰撞检测：所有车辆都在道路坐标系 (z, lateral) 里，用轴对齐矩形重叠判定就够了，
 * 比通用物理引擎便宜得多，弯道上也成立。
 */
export function overlaps(a, b, k = 0.9) {
  return Math.abs(a.z - b.z) < (a.colL + b.colL) * 0.5 * k && Math.abs(a.lateral - b.lateral) < (a.colW + b.colW) * 0.5 * k;
}

/**
 * 判断玩家和另一个物体是怎么撞上的（“只惩罚主动失误”的核心）。
 *
 * 原理：两个矩形重叠时，“穿透深度最小的那个轴”就是碰撞法线方向。
 *   - 纵向穿透更浅 → 前后碰撞：对方在前面 = 'front'（玩家正面撞上去），对方在后面 = 'rear'（玩家被追尾）
 *   - 横向穿透更浅 → 侧面碰撞：再比较双方的横向速度，谁朝对方移动得更快，谁就是肇事方
 *
 * 返回 { type: 'front' | 'rear' | 'side', side: ±1（对方在玩家哪一侧）, playerAtFault: boolean }
 */
export function classifyContact(player, other) {
  const dz = other.z - player.z; // >0：对方在玩家前面
  const dl = other.lateral - player.lateral; // >0：对方在玩家 +X 一侧
  const side = Math.sign(dl) || 1;
  const penZ = (player.colL + other.colL) / 2 - Math.abs(dz);
  const penL = (player.colW + other.colW) / 2 - Math.abs(dl);

  if (penZ <= penL) {
    // 前后碰撞：只有玩家撞上前方物体才算玩家失误；被后面追尾不算
    return dz > 0 ? { type: 'front', side, playerAtFault: true } : { type: 'rear', side, playerAtFault: false };
  }
  // 侧面碰撞：比较“朝对方靠近的速度”
  const playerClosing = player.latVel * side; // >0：玩家正往对方那边变道
  const otherClosing = -(other.latVel || 0) * side; // >0：对方正往玩家这边挤
  return { type: 'side', side, playerAtFault: playerClosing > otherClosing + 0.5 };
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

/** 把对方推到刚好不和玩家重叠的位置，避免同一次碰撞每帧重复触发 */
export function pushApart(player, other, contact) {
  if (contact.type === 'side') {
    other.lateral = player.lateral + contact.side * ((player.colW + other.colW) / 2 + 0.05);
  } else if (contact.type === 'rear') {
    other.z = player.z - (player.colL + other.colL) / 2 - 0.3;
  } else {
    other.z = player.z + (player.colL + other.colL) / 2 + 0.3;
  }
}

function separate(a, b) {
  const push = (Math.sign(a.lateral - b.lateral) || 1) * 2.5;
  a.latVel += push;
  b.latVel -= push;
  const rear = a.z < b.z ? a : b;
  rear.speed -= 3;
}
