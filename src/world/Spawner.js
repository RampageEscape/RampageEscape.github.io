import { CONFIG } from '../config.js';
import { Road, BIOMES, laneOffset } from './Road.js';
import { ObjectPool } from '../fx/ObjectPool.js';
import { PoliceAI } from '../ai/PoliceAI.js';
import { Civilian, Obstacle } from '../ai/Traffic.js';
import { TankAI, Shells } from '../ai/TankAI.js';
import { RoadWarnings } from '../fx/RoadWarnings.js';
import { Helicopter } from '../ai/Helicopter.js';
import { rand, randInt } from '../core/utils.js';

const S = CONFIG.spawn, LANES = CONFIG.road.lanes;
// 依次给新生成的追捕警车分配角色：侧翼、侧翼、拦截、追尾……
const ROLES = [1, -1, 0, 2, 1, -1, 0];

/**
 * 生成器：根据通缉星级（难度）在玩家身后刷追捕警车，前方刷民用车、路障、坦克；
 * 离开视野或残骸飞完的实体回收到对象池。
 */
export class Spawner {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    const pool = (f, n) => new ObjectPool(f, n, { grow: true });
    this.pools = {
      police: pool(() => new PoliceAI('police'), 10),
      swat: pool(() => new PoliceAI('swat'), 3),
      civilian: pool(() => new Civilian(), 12),
      barrier: pool(() => new Obstacle('barrier'), 6),
      cone: pool(() => new Obstacle('cone'), 8),
      tank: pool(() => new TankAI(), 1),
    };
    this.police = [];
    this.traffic = [];
    this.obstacles = [];
    this.tanks = [];
    this.entities = [];
    this.shells = new Shells(game);
    this.warnings = new RoadWarnings(game.scene);
    this.heli = new Helicopter(game);
    this.barricades = []; // { z, blocked: [车道编号], signs: [地面预警] }
    this.reset();
  }

  get lists() { return [this.police, this.traffic, this.obstacles, this.tanks]; }

  reset() {
    for (const list of this.lists) {
      for (const e of list) this.recycle(e);
      list.length = 0;
    }
    this.shells.reset();
    this.heli.reset();
    this.nextHeliZ = 900;
    for (const b of this.barricades) this.clearBarricade(b);
    this.barricades = [];
    this.nextBarricadeZ = 320;
    this.nextTankZ = 0;
    this.policeTimer = 2.5;
    this.roleIdx = 0;
    this.spawnLimit = Infinity;
    this.rebuild();
  }

  recycle(e) {
    e.despawn();
    this.pools[e.type].release(e);
  }

  rebuild() {
    this.entities = [].concat(...this.lists);
  }

  prefill(z) {
    for (let i = 0; i < S.trafficCount; i++) this.spawnCivilian(z + 60 + i * 18 + rand(0, 8));
  }

  update(dt) {
    const g = this.game, p = g.player;
    if (g.state === 'playing') this.spawnLogic(dt, p, g.stars);
    const ctx = { player: p, fx: g.fx, game: g, hazards: this.entities, shells: this.shells };
    for (const e of this.entities) e.update(dt, ctx);
    this.shells.update(dt);
    this.heli.update(dt);
    this.warnings.update(dt);
    this.cull(p);
  }

  spawnLogic(dt, p, stars) {
    const want = Math.min(S.policeMax, S.policeBase + stars * S.policePerStar);
    const chasing = this.police.filter((c) => c.mode === 'chase' && c.collidable).length;
    if ((this.policeTimer -= dt) <= 0 && chasing < want) {
      this.spawnChaser(p, stars);
      this.policeTimer = rand(1.2, 2.5) / (1 + stars * 0.2);
    }
    // 路口还没选定时，路口后面的路线还不存在：所有前方刷新都限制在路口之前
    const j = this.game.levels.junction;
    const limit = j && !j.committed ? j.sEntry - 25 : Infinity;
    if (j && !j.committed && this.nextBarricadeZ > j.sEntry - 170 && this.nextBarricadeZ < j.sEntry + 100) {
      this.nextBarricadeZ = j.sEntry + 100; // 路障不放在路口附近，顺延到路口之后
    }
    this.spawnLimit = limit;
    if (this.game.features?.isNear(this.game.features.stations, this.nextBarricadeZ, 90)) this.nextBarricadeZ += 150; // 不和改装站挤在一起
    if (this.traffic.length < S.trafficCount) this.spawnCivilian(p.z + rand(130, 200));
    if (p.z + 170 > this.nextBarricadeZ && this.nextBarricadeZ < limit) {
      this.spawnBarricade(this.nextBarricadeZ, stars);
      const B = CONFIG.barricade;
      this.nextBarricadeZ += rand(B.minGap, B.maxGap) * (1.1 - stars * 0.08);
    }
    // 直升机 Boss：3 星以后每隔一段距离来一次
    if (stars >= 3 && !this.heli.active && p.z > this.nextHeliZ && limit - p.z > 200) {
      this.heli.enter();
      this.nextHeliZ = p.z + rand(1400, 2000);
    }

    const tz = p.z + 170;
    if (stars >= 3 && !this.tanks.length && tz > this.nextTankZ && tz < limit - 40 && BIOMES[Road.biomeAt(tz)].tanks) {
      this.spawnTank(tz);
      this.nextTankZ = tz + rand(500, 800);
    }
  }

  spawnChaser(p, stars) {
    const type = stars >= 2 && Math.random() < 0.1 + stars * 0.05 ? 'swat' : 'police';
    const cop = this.pools[type].get();
    const role = ROLES[this.roleIdx++ % ROLES.length];
    cop.spawnChaser(this.scene, p.z - rand(34, 46), laneOffset(randInt(0, LANES - 1)), p.speed + 6, role);
    this.police.push(cop);
    this.rebuild();
  }

  laneFree(z, lat, range) {
    return !this.entities.some((e) => e.collidable && Math.abs(e.z - z) < range && Math.abs(e.lateral - lat) < 2.5);
  }

  spawnCivilian(z) {
    if (this.inBarricadeZone(z)) return; // 路障附近不刷民用车，保证安全通道畅通
    if (z > (this.spawnLimit ?? Infinity)) return;
    const lane = randInt(0, LANES - 1);
    if (!this.laneFree(z, laneOffset(lane), 14)) return;
    const c = this.pools.civilian.get();
    c.spawnCivilian(this.scene, z, lane, rand(CONFIG.traffic.minSpeed, CONFIG.traffic.maxSpeed));
    this.traffic.push(c);
    this.rebuild();
  }

  /**
   * 路障生成：四车道里最多堵 maxBlocked（2）条，永远保留至少 2 条安全通道（相邻或分开都行）。
   *   1. 按星级决定堵几条（1 星只堵 1 条），并用 min() 保证不超过上限
   *   2. 洗牌后取前 N 条作为被堵车道 → 剩下的就是安全通道
   *   3. 被堵车道放横停警车 / 栏杆，前面放雪糕筒提示“此路不通”
   *   4. 清掉安全通道附近的民用车，避免通道被慢车堵死
   *   5. 在被堵车道前方的地面放红色感叹号；UI 预警由 Game 根据 nextBarricade() 显示
   */
  spawnBarricade(z, stars) {
    const B = CONFIG.barricade;
    const maxBlocked = Math.min(B.maxBlocked, LANES - 2); // 硬性规则：至少留 2 条
    const want = stars <= 1 ? 1 : Math.random() < 0.35 + stars * 0.1 ? 2 : 1;
    const count = Math.min(want, maxBlocked);

    const lanes = [...Array(LANES).keys()];
    for (let i = lanes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
    }
    const blocked = lanes.slice(0, count).sort((a, b) => a - b);

    for (const i of blocked) {
      const lat = laneOffset(i);
      if (Math.random() < 0.65) {
        const type = stars >= 2 && Math.random() < 0.3 ? 'swat' : 'police';
        const cop = this.pools[type].get();
        cop.spawnParked(this.scene, z + rand(-1, 1), lat, (i % 2 ? 1 : -1) * rand(1.1, 1.4));
        this.police.push(cop);
      } else {
        this.addStatic('barrier', z, lat);
      }
      this.addStatic('cone', z - 5, lat);
    }

    // 清掉这段范围内、还在屏幕外的民用车
    const [c0, c1] = B.clearTraffic;
    for (const c of this.traffic) {
      if (c.z > z + c0 && c.z < z + c1 && c.z > this.game.player.z + 60) c.removeMe = true;
    }

    this.game.features?.onBarricade(z, blocked);
    const signs = [];
    for (const i of blocked) for (const d of B.signOffsets) signs.push(this.warnings.place(z - d, laneOffset(i)));
    this.barricades.push({ z, blocked, signs });
    this.rebuild();
  }

  inBarricadeZone(z) {
    const [c0, c1] = CONFIG.barricade.clearTraffic;
    return this.barricades.some((b) => z > b.z + c0 && z < b.z + c1);
  }

  /** 玩家前方 range 米内最近的路障（给 UI 预警用） */
  nextBarricade(pz, range) {
    let best = null;
    for (const b of this.barricades) if (b.z > pz && b.z - pz < range && (!best || b.z < best.z)) best = b;
    return best;
  }

  clearBarricade(b) {
    for (const m of b.signs) this.warnings.release(m);
    b.signs.length = 0;
  }

  addStatic(kind, z, lat) {
    const o = this.pools[kind].get();
    o.spawnStatic(this.scene, z, lat);
    this.obstacles.push(o);
  }

  spawnTank(z) {
    const t = this.pools.tank.get();
    t.spawnTank(this.scene, z, laneOffset(randInt(1, LANES - 2)));
    this.tanks.push(t);
    this.rebuild();
  }

  cull(p) {
    let changed = false;
    for (const list of this.lists) {
      for (let i = list.length - 1; i >= 0; i--) {
        // 一律用道路里程 e.z 判断（残骸飞行时 e.z 保持在被撞的位置）。
        // 不能用 mesh.position.z：路线转弯后世界 z 和里程不一样，会把刚撞飞的车立刻删掉
        const e = list[i], z = e.z;
        if (e.removeMe || z < p.z - 60 || z > p.z + 320) {
          this.recycle(e);
          list.splice(i, 1);
          changed = true;
        }
      }
    }
    if (changed) this.rebuild();
    for (let i = this.barricades.length - 1; i >= 0; i--) {
      if (this.barricades[i].z < p.z - 30) {
        this.clearBarricade(this.barricades[i]);
        this.barricades.splice(i, 1);
      }
    }
  }

  copsNear(p, dz, dl) {
    let n = 0;
    for (const c of this.police) {
      if (c.mode === 'chase' && c.collidable && Math.abs(c.z - p.z) < dz && Math.abs(c.lateral - p.lateral) < dl) n++;
    }
    return n;
  }
}
