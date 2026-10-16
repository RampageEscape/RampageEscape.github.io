/**
 * 移动端滑动输入：
 *  - 手指移动超过阈值就立刻触发（不用等抬手），连续滑可以连续变道
 *  - 快速双击 = 冲刺
 *  - 桌面调试：方向键 / WASD，空格 = 冲刺；鼠标拖动同样当作滑动
 */
const KEYS = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
};

export class SwipeInput {
  constructor(el, { onSwipe, onDash, threshold = 30 }) {
    this.onSwipe = onSwipe;
    this.onDash = onDash;
    this.threshold = threshold;
    this.active = null;
    this.lastTap = 0;

    el.addEventListener('pointerdown', (e) => {
      this.active = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), fired: false };
      try { el.setPointerCapture?.(e.pointerId); } catch { /* 指针已失效（例如系统手势抢走）时忽略 */ }
    });
    el.addEventListener('pointermove', (e) => {
      const a = this.active;
      if (!a || a.id !== e.pointerId) return;
      const dx = e.clientX - a.x, dy = e.clientY - a.y;
      if (Math.hypot(dx, dy) < this.threshold) return;
      this.onSwipe(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
      a.x = e.clientX; // 以当前位置为新起点，支持一次拖动连续触发
      a.y = e.clientY;
      a.fired = true;
    });
    el.addEventListener('pointerup', (e) => {
      const a = this.active;
      if (!a || a.id !== e.pointerId) return;
      this.active = null;
      const isTap = !a.fired && Math.hypot(e.clientX - a.sx, e.clientY - a.sy) < 12 && performance.now() - a.t < 250;
      if (!isTap) return;
      const now = performance.now();
      if (now - this.lastTap < 300) { this.lastTap = 0; this.onDash(); }
      else this.lastTap = now;
    });
    el.addEventListener('pointercancel', () => { this.active = null; });

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (KEYS[e.code]) { e.preventDefault(); this.onSwipe(KEYS[e.code]); }
      else if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') { e.preventDefault(); this.onDash(); }
    });
  }
}
