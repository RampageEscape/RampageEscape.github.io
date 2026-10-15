import { TIERS } from './Vehicles.js';

/**
 * 改装站的升级卡（每次三选一）
 *   max       : 一局最多拿几次
 *   available : 额外条件（例如开炮升级只有坦克能拿）
 */
export const UPGRADES = {
  evolve: { icon: '🚀', max: TIERS.length - 1, available: (p) => p.tierIndex < TIERS.length - 1, apply: (p) => p.evolve() },
  armor: { icon: '🔩', max: 4, apply: (p) => { p.stats.maxHp += 30; p.heal(30); } },
  repair: { icon: '🔧', max: 99, available: (p) => p.hp < p.maxHp * 0.85, apply: (p) => p.heal(p.maxHp * 0.6) },
  shield: { icon: '🛡️', max: 99, available: (p) => p.shields < 3, apply: (p) => { p.shields = Math.min(3, p.shields + 1); } },
  nitro: { icon: '⚡', max: 3, apply: (p) => { p.stats.dashCooldown *= 0.75; p.stats.dashDuration += 0.25; p.dashCooldown = 0; } },
  engine: { icon: '⚙️', max: 3, apply: (p) => { p.stats.baseSpeed += 3; p.stats.maxSpeed += 3; } },
  cannon: { icon: '💥', max: 3, available: (p) => !!p.tier.cannon, apply: (p) => { p.stats.cannonCooldown *= 0.7; p.stats.cannonRadius += 0.6; } },
};

function canTake(player, id) {
  const u = UPGRADES[id];
  return (player.upgradeLevels[id] ?? 0) < u.max && (!u.available || u.available(player));
}

/** 抽 n 张卡。还能进化时，进化卡一定会出现——保证每局都有机会一路升到坦克 */
export function rollUpgrades(player, n = 3) {
  const pool = Object.keys(UPGRADES).filter((id) => id !== 'evolve' && canTake(player, id));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return canTake(player, 'evolve') ? ['evolve', ...pool.slice(0, n - 1)] : pool.slice(0, n);
}

export function applyUpgrade(player, id) {
  UPGRADES[id].apply(player);
  player.upgradeLevels[id] = (player.upgradeLevels[id] ?? 0) + 1;
}
