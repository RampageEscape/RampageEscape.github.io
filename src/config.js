// 所有可调参数集中在这里，方便做数值平衡
export const CONFIG = {
  road: { lanes: 4, laneWidth: 3.6, biomeLength: 800, transition: 120 },
  world: { chunkLength: 40, chunksAhead: 7, chunksBehind: 2 },
  camera: { offset: [-11, 40, -17], minWidth: 26, minHeight: 36, lookAhead: 8 },

  player: {
    length: 4.4, width: 2.0,
    baseSpeed: 30, minSpeed: 14, maxSpeed: 46,
    accel: 16, brake: 34,
    swipeUpBias: 10, swipeDownBias: -14, maxBias: 16, biasDecay: 3,
    laneSharpness: 9,
    maxHp: 100, hitInvuln: 0.7,
    dash: { duration: 1.1, cooldown: 3.2, speedMul: 1.65, extendOnKill: 0.3 },
  },

  police: {
    length: 4.4, width: 2.0, damage: 10,
    catchUp: 14, steerGain: 3.2, maxLatSpeed: 9,
    ramCooldown: 1.6, ramImpulse: 7, lookAhead: 0.35,
    // 橡皮筋机制（距离 = 玩家 z - 警车 z，正数表示警车在后面）
    rubber: {
      near: 10,          // 危险范围：进入后与玩家基本同速
      far: 35,           // 超过这个距离给最大加速
      maxBoost: 13,      // 远距离时比玩家快多少
      nearMaxRel: 1.5,   // 危险范围内最多比玩家快多少（慢慢逼近，不会瞬间超车）
      nearMinRel: -4,    // 危险范围内最多比玩家慢多少
      blockerRel: 3,     // 拦截者超车时的相对速度（缓慢、可预判）
      absMax: 42,        // 绝对最高速：玩家上滑加速（最高 46）就能甩开
      reaction: 1.5,     // 对玩家速度变化的反应快慢（越小越迟钝，越容易被甩开）
      stickTime: 2.5,    // 在危险范围内黏住超过这个秒数……
      backoffTime: 1.4,  // ……就主动退开这么久，给玩家脱战机会
      backoffRel: -5,
    },
  },
  swat: { length: 5.6, width: 2.45, damage: 22, catchUp: 10, ramImpulse: 9 },
  tank: { length: 7.6, width: 3.4, speed: 11, damage: 40, fireInterval: 2.6, shellFlight: 1.3, blastRadius: 3.2, blastDamage: 25 },
  traffic: { minSpeed: 12, maxSpeed: 22, damage: 6 },
  // 被追尾 / 被侧撞（非玩家失误）时：不扣血，只推一把
  bump: { rearBoost: 5, sidePush: 0.6, maxSpeedMul: 1.15 },
  barricade: {
    damage: 28, minGap: 230, maxGap: 380,
    maxBlocked: 2,       // 四车道里最多堵 2 条，永远至少留 2 条安全通道
    warnDistance: 120,   // 路障在前方多远时开始 UI 预警
    signOffsets: [16, 30], // 地面红色感叹号距离路障多远（可多个）
    clearTraffic: [-40, 15], // 生成时清掉这段范围内的民用车，保证安全通道真的畅通
  },

  spawn: { policeBase: 2, policePerStar: 1, policeMax: 8, trafficCount: 9, starDistance: 450, maxStars: 5 },
  score: { perMeter: 1, police: 300, swat: 600, tank: 1500, civilian: 50, prop: 20, comboWindow: 2.5 },
};
