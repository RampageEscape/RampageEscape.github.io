import { CONFIG } from '../config.js';
import { Road, laneOffset } from './Road.js';
import { ObjectPool } from '../fx/ObjectPool.js';
import { PoliceAI } from '../ai/PoliceAI.js';
import { Civilian, Obstacle } from '../ai/Traffic.js';
import { TankAI, Shells } from '../ai/TankAI.js';
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
    this.reset();
  }

  get lists() { return [this.police, this.traffic, this.obstacles, this.tanks]; }

  reset() {
    for (const list of this.lists) {
      for (const e of list) this.recycle(e);
      list.length = 0;
    }
    this.shells.reset();
    this.nextBarricadeZ = 320;
    this.nextTankZ = 0;
    this.policeTimer = 2.5;
    this.roleIdx = 0;
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
    this.cull(p);
  }

  spawnLogic(dt, p, stars) {
    const want = Math.min(S.policeMax, S.policeBase + stars * S.policePerStar);
    const chasing = this.police.filter((c) => c.mode === 'chase' && c.collidable).length;
    if ((this.policeTimer -= dt) <= 0 && chasing < want) {
      this.spawnChaser(p, stars);
      this.policeTimer = rand(1.2, 2.5) / (1 + stars * 0.2);
    }
    if (this.traffic.length < S.trafficCount) this.spawnCivilian(p.z + rand(130, 200));
    if (p.z + 170 > this.nextBarricadeZ) {
      this.spawnBarricade(this.nextBarricadeZ, stars);
      const B = CONFIG.barricade;
      this.nextBarricadeZ += rand(B.minGap, B.maxGap) * (1.1 - stars * 0.08);
    }
    const tz = p.z + 170;
    if (stars >= 3 && !this.tanks.length && tz > this.nextTankZ && Road.biomeAt(tz) === 'city') {
      this.spawnTank(tz);
      this.nextTankZ = tz + rand(500, 800);
    }
  }

  spawnChaser(p, stars) {
    const type = stars >= 2 && Math.random() < 0.1 + stars * 0.05 ? 'swat' : 'police';
    const cop = this.pools[type].get();
    const role = ROLES[this.roleIdx++ % ROLES.length];
    cop.spawnChaser(this.scene, p.z - rand(34, 46), laneOffset(randInt(0, LANES - 1)), p.speed + 10, role);
    this.police.push(cop);
    this.rebuild();
  }

  laneFree(z, lat, range) {
    return !this.entities.some((e) => e.collidable && Math.abs(e.z - z) < range && Math.abs(e.lateral - lat) < 2.5);
  }

  spawnCivilian(z) {
    const lane = randInt(0, LANES - 1);
    if (!this.laneFree(z, laneOffset(lane), 14)) return;
    const c = this.pools.civilian.get();
    c.spawnCivilian(this.scene, z, lane, rand(CONFIG.traffic.minSpeed, CONFIG.traffic.maxSpeed));
    this.traffic.push(c);
    this.rebuild();
  }

  /** 路障：警车横停 + 栏杆，留一条缺口；高星级有概率完全封死，只能冲刺撞过去 */
  spawnBarricade(z, stars) {
    const gap = stars >= 4 && Math.random() < 0.4 ? -1 : randInt(0, LANES - 1);
    for (let i = 0; i < LANES; i++) {
      const lat = laneOffset(i);
      if (i === gap) {
        for (const s of [-1, 1]) this.addStatic('cone', z - 5, lat + s * 1.5);
        continue;
      }
      if (Math.random() < 0.65) {
        const type = stars >= 2 && Math.random() < 0.3 ? 'swat' : 'police';
        const cop = this.pools[type].get();
        cop.spawnParked(this.scene, z + rand(-1, 1), lat, (i % 2 ? 1 : -1) * rand(1.1, 1.4));
        this.police.push(cop);
      } else {
        this.addStatic('barrier', z, lat);
      }
    }
    this.rebuild();
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
        const e = list[i], z = e.state === 'wreck' ? e.mesh.position.z : e.z;
        if (e.removeMe || z < p.z - 60 || z > p.z + 320) {
          this.recycle(e);
          list.splice(i, 1);
          changed = true;
        }
      }
    }
    if (changed) this.rebuild();
  }

  copsNear(p, dz, dl) {
    let n = 0;
    for (const c of this.police) {
      if (c.mode === 'chase' && c.collidable && Math.abs(c.z - p.z) < dz && Math.abs(c.lateral - p.lateral) < dl) n++;
    }
    return n;
  }
}
