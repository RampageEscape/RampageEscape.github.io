import * as THREE from 'three';
import { damp, lerp, vibrate } from '../core/utils.js';

// 平滑的伪随机噪声（多个正弦叠加），范围约 [-1, 1]
const noise = (x, seed) => Math.sin(x + seed) * 0.5 + Math.sin(x * 2.17 + seed * 1.7) * 0.3 + Math.sin(x * 4.73 + seed * 2.3) * 0.2;

/**
 * 基于“创伤值 trauma”的镜头震动：
 *   - 每次冲击往 trauma 里加一点（上限 1），trauma 线性衰减
 *   - 实际震幅 = trauma²，小冲击几乎察觉不到，大冲击很猛，叠加起来手感自然
 *   - 用平滑噪声而不是纯随机，镜头是“晃”而不是“抖”
 *   - 用真实时间更新，所以顿帧（Hit Stop）期间镜头仍在震
 */
export class CameraShake {
  constructor({ maxOffset = 1.4, maxRoll = 0.05, frequency = 24, decay = 1.6 } = {}) {
    Object.assign(this, { maxOffset, maxRoll, frequency, decay });
    this.trauma = 0;
    this.t = 0;
    this.offset = new THREE.Vector3();
    this.roll = 0;
  }
  add(amount) { this.trauma = Math.min(1, this.trauma + amount); }
  update(realDt) {
    this.t += realDt;
    this.trauma = Math.max(0, this.trauma - this.decay * realDt);
    const s = this.trauma * this.trauma, f = this.t * this.frequency;
    this.offset.set(noise(f, 1.3), noise(f, 7.1) * 0.5, noise(f, 3.7)).multiplyScalar(this.maxOffset * s);
    this.roll = this.maxRoll * s * noise(f, 11.9);
  }
}

/**
 * 打击感总控：顿帧 + 慢动作 + 镜头震动 + 镜头缩放冲击 + 手机震动
 * 所有“手感”数值集中在这里调。
 */
export class GameFeel {
  constructor() {
    this.shake = new CameraShake();
    this.timeScale = 1;
    this.freezeT = 0;
    this.freezeScale = 0.03;
    this.recoverT = 0;
    this.slowT = 0;
    this.slowScale = 1;
    this.zoomKick = 0;
    this.zoom = 1;
  }

  /** 顿帧：几乎冻结游戏时间（不是完全 0，爆炸会极慢地继续，画面更有张力） */
  hitStop(duration, scale = 0.03) {
    if (this.versus) return; // 双人对战：一个人的顿帧/慢动作不能拖慢另一个人
    this.freezeT = Math.max(this.freezeT, duration);
    this.freezeScale = scale;
    this.recoverT = 0.12;
  }

  slowMo(scale, duration) {
    if (this.versus) return;
    this.slowScale = Math.min(this.slowScale, scale);
    this.slowT = Math.max(this.slowT, duration);
  }

  update(realDt) {
    this.shake.update(realDt);
    if (this.freezeT > 0) {
      this.freezeT -= realDt;
      this.timeScale = this.freezeScale;
    } else if (this.recoverT > 0) {
      // 顿帧结束后 0.12 秒内从 0.25 倍速缓动回 1 倍速，避免“卡一下”的生硬感
      this.recoverT -= realDt;
      const k = 1 - Math.max(0, this.recoverT) / 0.12;
      this.timeScale = lerp(0.25, 1, k * k);
    } else {
      this.timeScale = 1;
    }
    if (this.slowT > 0) {
      this.slowT -= realDt;
      this.timeScale = Math.min(this.timeScale, this.slowScale);
    } else {
      this.slowScale = 1;
    }
    this.zoomKick = damp(this.zoomKick, 0, 7, realDt);
    this.zoom = 1 + this.zoomKick;
  }

  // ---------------- 事件 → 手感配方 ----------------
  onEnemyDestroyed(power, combo) {
    this.hitStop(0.045 + 0.025 * power + 0.01 * Math.min(combo, 5));
    this.shake.add(0.35 + 0.15 * power);
    this.zoomKick += 0.06 * power; // 镜头往里推一下
    if (combo >= 3) this.slowMo(0.35, 0.35); // 连击时短暂慢动作
    vibrate(Math.round(25 * power));
  }

  onPlayerHit(damage) {
    this.hitStop(0.035, 0.1);
    this.shake.add(0.25 + damage / 60);
    this.zoomKick -= 0.03;
    vibrate(60);
  }

  onDashStart() {
    this.shake.add(0.12);
    this.zoomKick -= 0.08; // 镜头拉远 → 速度感
    vibrate(15);
  }

  onBlast() {
    this.shake.add(0.3);
    vibrate(30);
  }
}
