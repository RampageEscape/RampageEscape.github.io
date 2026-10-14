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
  },
  swat: { length: 5.6, width: 2.45, damage: 22, catchUp: 10, ramImpulse: 9 },
  tank: { length: 7.6, width: 3.4, speed: 11, damage: 40, fireInterval: 2.6, shellFlight: 1.3, blastRadius: 3.2, blastDamage: 25 },
  traffic: { minSpeed: 12, maxSpeed: 22, damage: 6 },
  barricade: { damage: 28, minGap: 230, maxGap: 380 },

  spawn: { policeBase: 2, policePerStar: 1, policeMax: 8, trafficCount: 9, starDistance: 450, maxStars: 5 },
  score: { perMeter: 1, police: 300, swat: 600, tank: 1500, civilian: 50, prop: 20, comboWindow: 2.5 },
};
