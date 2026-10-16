/**
 * 双人对战的输入：
 *  - 触屏：左半屏归玩家 1，右半屏归玩家 2。每根手指按下时记住属于哪一边，
 *          两个人可以同时滑动（多点触控），各自快速双击 = 冲刺
 *  - 键盘：玩家 1 = WASD 移动 + 空白键冲刺 + F 开炮
 *          玩家 2 = 方向键移动 + Enter 冲刺 + L 开炮
 * enabled() 返回 false 时（单人模式）什么都不做，单人模式继续用 SwipeInput。
 */
const KEYS = [
  { KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down' },
  { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' },
];
const DASH = [['Space'], ['Enter', 'NumpadEnter', 'ShiftRight', 'Numpad0']];
const FIRE = [['KeyF'], ['KeyL', 'Slash', 'NumpadDecimal']];

export class VersusInput {
  constructor(el, { onSwipe, onDash, onFire, enabled, threshold = 28 }) {
    this.pointers = new Map();
    this.lastTap = [0, 0];

    el.addEventListener('pointerdown', (e) => {
      if (!enabled()) return;
      const side = e.clientX < innerWidth / 2 ? 0 : 1;
      this.pointers.set(e.pointerId, { side, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), fired: false });
      try { el.setPointerCapture?.(e.pointerId); } catch { /* 指针已失效（例如系统手势抢走）时忽略 */ }
    });
    el.addEventListener('pointermove', (e) => {
      const a = this.pointers.get(e.pointerId);
      if (!a || !enabled()) return;
      const dx = e.clientX - a.x, dy = e.clientY - a.y;
      if (Math.hypot(dx, dy) < threshold) return;
      onSwipe(a.side, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
      a.x = e.clientX;
      a.y = e.clientY;
      a.fired = true;
    });
    const end = (e) => {
      const a = this.pointers.get(e.pointerId);
      if (!a) return;
      this.pointers.delete(e.pointerId);
      if (!enabled() || e.type === 'pointercancel') return;
      const tap = !a.fired && Math.hypot(e.clientX - a.sx, e.clientY - a.sy) < 14 && performance.now() - a.t < 260;
      if (!tap) return;
      const now = performance.now();
      if (now - this.lastTap[a.side] < 320) {
        this.lastTap[a.side] = 0;
        onDash(a.side);
      } else {
        this.lastTap[a.side] = now;
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    addEventListener('keydown', (e) => {
      if (!enabled() || e.repeat) return;
      for (let i = 0; i < 2; i++) {
        if (KEYS[i][e.code]) { e.preventDefault(); onSwipe(i, KEYS[i][e.code]); return; }
        if (DASH[i].includes(e.code)) { e.preventDefault(); onDash(i); return; }
        if (FIRE[i].includes(e.code)) { e.preventDefault(); onFire(i); return; }
      }
    });
  }
}
