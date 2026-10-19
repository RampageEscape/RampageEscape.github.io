/**
 * 速度线：高速、冲刺、加速带时，从画面中心往四周飞出的白色细线（2D 画布叠在 3D 画面上，半分辨率，很省）。
 * intensity：0 = 没有，1 = 很强
 */
export class SpeedLines {
  constructor() {
    this.c = document.getElementById('speedlines');
    this.g = this.c.getContext('2d');
    this.lines = [];
    this.on = false;
    const fit = () => { this.c.width = Math.ceil(innerWidth / 2); this.c.height = Math.ceil(innerHeight / 2); };
    addEventListener('resize', fit);
    fit();
  }

  update(dt, intensity) {
    const { c, g } = this, w = c.width, h = c.height, cx = w / 2, cy = h * 0.45, diag = Math.hypot(w, h) / 2;
    if (intensity < 0.02 && !this.lines.length) {
      if (this.on) { g.clearRect(0, 0, w, h); this.on = false; }
      return;
    }
    this.on = true;
    for (let i = Math.floor(intensity * 90 * dt + Math.random()); i > 0; i--) {
      const a = Math.random() * Math.PI * 2;
      this.lines.push({ a, r: diag * (0.3 + Math.random() * 0.3), len: diag * (0.08 + Math.random() * 0.18), v: diag * (1.6 + Math.random() * 1.6), life: 0.35, alpha: 0.25 + Math.random() * 0.45 * intensity });
    }
    g.clearRect(0, 0, w, h);
    g.lineCap = 'round';
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      l.life -= dt;
      l.r += l.v * dt;
      if (l.life <= 0 || l.r > diag * 1.3) { this.lines.splice(i, 1); continue; }
      const ca = Math.cos(l.a), sa = Math.sin(l.a);
      g.strokeStyle = `rgba(255,255,255,${(l.alpha * Math.min(1, l.life / 0.15)).toFixed(3)})`;
      g.lineWidth = 1 + (l.r / diag) * 1.6;
      g.beginPath();
      g.moveTo(cx + ca * l.r, cy + sa * l.r);
      g.lineTo(cx + ca * (l.r + l.len), cy + sa * (l.r + l.len));
      g.stroke();
    }
  }
}
