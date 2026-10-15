/**
 * 音频引擎：全部用 Web Audio 实时合成，不需要音频文件。
 *   - 持续音：引擎（随车速变调）、警笛（随警车距离变大小）、直升机旋翼、风声、轮胎尖叫
 *   - 一次性音效：爆炸、碰撞、擦边、冲刺、道具、改装、飞跃、护盾、暴走、任务、炸弹、主炮……
 *   - 背景音乐：合成器风格（Synthwave）的小编曲器，菜单 / 游戏 / 暴走三种强度
 * 手机浏览器要求“用户点击后”才能出声：第一次点击时调用 unlock()。
 */
const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI 音高 → 频率

export class AudioEngine {
  constructor() {
    this.ctx = null;
    let s = {};
    try { s = JSON.parse(localStorage.getItem('rampage-escape.audio')) || {}; } catch { /* ignore */ }
    this.musicOn = s.music !== false;
    this.sfxOn = s.sfx !== false;
    this.mode = 'menu';
    this.intensity = 0;
    this.lastHit = {};
  }

  saveSettings() {
    try { localStorage.setItem('rampage-escape.audio', JSON.stringify({ music: this.musicOn, sfx: this.sfxOn })); } catch { /* ignore */ }
  }

  toggleMusic() { this.musicOn = !this.musicOn; this.saveSettings(); this.applyVolumes(); }
  toggleSfx() { this.sfxOn = !this.sfxOn; this.saveSettings(); this.applyVolumes(); }

  /** 第一次用户点击时调用：建立音频图、启动持续音和音乐编曲器 */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor(); // 防止爆炸叠在一起爆音
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.music = ctx.createGain();
    this.sfx.connect(this.master);
    this.music.connect(this.master);
    this.master.gain.value = 0.9;

    // 2 秒白噪声，所有“嘶嘶 / 轰隆”类声音都从它滤波出来
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.buildLoops();
    this.applyVolumes();
    this.startMusic();
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.sfx.gain.setTargetAtTime(this.sfxOn ? 1 : 0, t, 0.05);
    this.music.gain.setTargetAtTime(this.musicOn ? (this.paused ? 0.2 : 0.5) : 0, t, 0.2);
  }

  setPaused(p) {
    this.paused = p;
    if (!this.ctx) return;
    if (p) for (const g of [this.engGain, this.sirenGain, this.rotorGain, this.windGain, this.screechGain]) g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    this.applyVolumes();
  }

  // ---------------------------------------------------------------- 工具
  noiseSrc(loop = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = loop;
    if (!loop) s.playbackRate.value = 0.8 + Math.random() * 0.4;
    return s;
  }

  env(gainNode, t, peak, attack, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  /** 同类音效在 minGap 秒内只响一次（避免十辆车同时爆炸时声音糊成一团） */
  gate(key, minGap) {
    const now = this.ctx.currentTime;
    if (now - (this.lastHit[key] ?? -1) < minGap) return false;
    this.lastHit[key] = now;
    return true;
  }

  out(vol = 1, pan = 0) {
    const g = this.ctx.createGain();
    g.gain.value = vol;
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.sfx);
    } else g.connect(this.sfx);
    return g;
  }

  tone(type, freq, t, dur, vol, dest, freqEnd) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    this.env(g, t, vol, 0.005, dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // ---------------------------------------------------------------- 持续音
  buildLoops() {
    const ctx = this.ctx;
    // 引擎：锯齿波 + 低一个八度的方波 → 低通 → 音量
    this.engA = ctx.createOscillator();
    this.engB = ctx.createOscillator();
    this.engA.type = 'sawtooth';
    this.engB.type = 'square';
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 4;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    const bGain = ctx.createGain();
    bGain.gain.value = 0.5;
    this.engA.connect(this.engFilter);
    this.engB.connect(bGain).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.sfx);
    this.engA.start();
    this.engB.start();

    // 警笛：三角波，频率被慢速正弦 LFO 拉高拉低（美式“呜哇”）
    this.siren = ctx.createOscillator();
    this.siren.type = 'triangle';
    this.siren.frequency.value = 800;
    const lfo = ctx.createOscillator(), lfoAmt = ctx.createGain();
    lfo.frequency.value = 0.55;
    lfoAmt.gain.value = 260;
    lfo.connect(lfoAmt).connect(this.siren.frequency);
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.siren.connect(this.sirenGain).connect(this.sfx);
    this.siren.start();
    lfo.start();

    // 直升机旋翼：低频带通噪声，被 14Hz 方波调制成“哒哒哒”
    const rn = this.noiseSrc(true), rf = ctx.createBiquadFilter();
    rf.type = 'bandpass';
    rf.frequency.value = 140;
    rf.Q.value = 1.2;
    const chop = ctx.createGain(), chopLfo = ctx.createOscillator(), chopAmt = ctx.createGain();
    chopLfo.type = 'square';
    chopLfo.frequency.value = 14;
    chopAmt.gain.value = 0.5;
    chop.gain.value = 0.5;
    chopLfo.connect(chopAmt).connect(chop.gain);
    this.rotorGain = ctx.createGain();
    this.rotorGain.gain.value = 0;
    rn.connect(rf).connect(chop).connect(this.rotorGain).connect(this.sfx);
    rn.start();
    chopLfo.start();

    // 风声（高速 / 冲刺时）
    const wn = this.noiseSrc(true), wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 900;
    wf.Q.value = 0.6;
    this.windFilter = wf;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wn.connect(wf).connect(this.windGain).connect(this.sfx);
    wn.start();

    // 轮胎尖叫（转弯 / 急变道）：窄带通噪声
    const sn = this.noiseSrc(true), sf = ctx.createBiquadFilter();
    sf.type = 'bandpass';
    sf.frequency.value = 2400;
    sf.Q.value = 9;
    this.screechGain = ctx.createGain();
    this.screechGain.gain.value = 0;
    sn.connect(sf).connect(this.screechGain).connect(this.sfx);
    sn.start();
  }

  /** 每帧调用：s = { speed01, dashing, rampage, heavy, siren 0~1, rotor 0~1, screech 0~1, playing } */
  update(s) {
    if (!this.ctx || this.paused) return;
    const t = this.ctx.currentTime, k = 0.08;
    const base = s.heavy ? 38 : 55, f = base + s.speed01 * (s.heavy ? 70 : 150) + (s.dashing ? 40 : 0);
    this.engA.frequency.setTargetAtTime(f, t, k);
    this.engB.frequency.setTargetAtTime(f / 2, t, k);
    this.engFilter.frequency.setTargetAtTime(500 + s.speed01 * 2200 + (s.dashing ? 1200 : 0), t, k);
    this.engGain.gain.setTargetAtTime(s.playing ? 0.022 + s.speed01 * 0.018 : 0.012, t, 0.15);
    this.sirenGain.gain.setTargetAtTime(s.siren * 0.045, t, 0.2);
    this.rotorGain.gain.setTargetAtTime(s.rotor * 0.5, t, 0.3);
    this.windGain.gain.setTargetAtTime((s.speed01 * 0.03 + (s.dashing || s.rampage ? 0.09 : 0)) * (s.playing ? 1 : 0), t, 0.2);
    this.windFilter.frequency.setTargetAtTime(700 + s.speed01 * 1500, t, 0.2);
    this.screechGain.gain.setTargetAtTime(s.screech * 0.07, t, 0.05);
    this.intensity = s.rampage ? 2 : s.playing ? 1 : 0;
  }

  // ---------------------------------------------------------------- 一次性音效
  /** 爆炸：低频冲击（正弦下滑）+ 轰隆（低通噪声）+ 碎裂声（高通噪声） */
  explosion(power = 1, vol = 1) {
    if (!this.ctx || !this.sfxOn || vol < 0.05 || !this.gate('boom', 0.06)) return;
    const ctx = this.ctx, t = ctx.currentTime, out = this.out(Math.min(1.2, vol * (0.6 + power * 0.3)));
    this.tone('sine', 95, t, 0.7, 0.9, out, 28);
    const n = this.noiseSrc(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(4000, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 1.1);
    this.env(g, t, 0.9, 0.004, 1.2 + power * 0.2);
    n.connect(lp).connect(g).connect(out);
    n.start(t);
    n.stop(t + 1.6);
    const c = this.noiseSrc(), hp = ctx.createBiquadFilter(), cg = ctx.createGain();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    this.env(cg, t + 0.02, 0.25, 0.002, 0.35);
    c.connect(hp).connect(cg).connect(out);
    c.start(t);
    c.stop(t + 0.5);
  }

  /** 金属碰撞：短促噪声 + 金属“铛” */
  impact(strength = 1, vol = 1) {
    if (!this.ctx || !this.sfxOn || vol < 0.05 || !this.gate('impact', 0.05)) return;
    const ctx = this.ctx, t = ctx.currentTime, out = this.out(vol * 0.7 * Math.min(1, strength + 0.3));
    const n = this.noiseSrc(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.8;
    this.env(g, t, 0.8, 0.002, 0.25);
    n.connect(bp).connect(g).connect(out);
    n.start(t);
    n.stop(t + 0.35);
    this.tone('square', 210 + Math.random() * 60, t, 0.18, 0.12, out, 160);
    this.tone('triangle', 620 + Math.random() * 200, t, 0.3, 0.1, out);
  }

  /** 擦边：带通噪声快速扫频，左右声道按车的方向 */
  whoosh(pan = 0, vol = 1) {
    if (!this.ctx || !this.sfxOn || !this.gate('whoosh', 0.08)) return;
    const ctx = this.ctx, t = ctx.currentTime, out = this.out(vol * 0.8, pan);
    const n = this.noiseSrc(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    bp.type = 'bandpass';
    bp.Q.value = 2;
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(3200, t + 0.15);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.4);
    this.env(g, t, 0.9, 0.05, 0.4);
    n.connect(bp).connect(g).connect(out);
    n.start(t);
    n.stop(t + 0.5);
  }

  dash() {
    if (!this.ctx || !this.sfxOn) return;
    const t = this.ctx.currentTime, out = this.out(0.6);
    this.tone('sawtooth', 180, t, 0.45, 0.25, out, 1400);
    this.tone('sine', 120, t + 0.05, 0.4, 0.5, out, 50);
    this.whoosh(0, 0.8);
  }

  pickup(kind) {
    if (!this.ctx || !this.sfxOn) return;
    const t = this.ctx.currentTime, out = this.out(0.5);
    const root = kind === 'shield' ? 76 : kind === 'nitro' ? 79 : 72;
    [0, 4, 7, 12].forEach((iv, i) => this.tone('triangle', NOTE(root + iv), t + i * 0.055, 0.22, 0.35, out));
  }

  /** 开进改装站：棘轮 + 气动扳手 */
  garage() {
    if (!this.ctx || !this.sfxOn) return;
    const t = this.ctx.currentTime, out = this.out(0.5);
    for (let i = 0; i < 6; i++) this.tone('square', 900 + i * 40, t + i * 0.05, 0.03, 0.2, out);
    this.tone('sawtooth', 300, t + 0.35, 0.4, 0.15, out, 700);
  }

  /** 选好升级：上扬的和弦 */
  upgrade(big = false) {
    if (!this.ctx || !this.sfxOn) return;
    const t = this.ctx.currentTime, out = this.out(0.55);
    const chord = big ? [60, 64, 67, 72, 76] : [62, 66, 69, 74];
    chord.forEach((n, i) => this.tone('sawtooth', NOTE(n), t + i * 0.04, 0.6, 0.12, out));
    this.tone('sine', 110, t, 0.6, 0.4, out, 220);
  }

  ui() {
    if (!this.ctx || !this.sfxOn) return;
    this.tone('triangle', 1200, this.ctx.currentTime, 0.05, 0.15, this.out(0.5), 900);
  }

  jump() {
    if (!this.ctx || !this.sfxOn) return;
    const t = this.ctx.currentTime, out = this.out(0.5);
    this.tone('sine', 220, t, 0.35, 0.4, out, 660);
    this.whoosh(0, 0.6);
  }

  land(power = 1) {
    if (!this.ctx || !this.sfxOn) return;
    const t = this.ctx.currentTime, out = this.out(Math.min(1, 0.4 + power * 0.04));
    this.tone('sine', 80, t, 0.3, 0.8, out, 35);
    this.impact(0.4, 0.6);
  }

  shield() {
    if (!this.ctx || !this.sfxOn) return;
    const t = this.ctx.currentTime, out = this.out(0.5);
    [96, 91, 88, 84].forEach((n, i) => this.tone('triangle', NOTE(n), t + i * 0.03, 0.25, 0.25, out));
  }

  rampage() {
    if (!this.ctx || !this.sfxOn) return;
    const t = this.ctx.currentTime, out = this.out(0.7);
    this.tone('sawtooth', 110, t, 0.8, 0.3, out, 880);
    this.tone('sine', 60, t + 0.6, 0.8, 0.9, out, 30);
    this.explosion(0.6, 0.5);
  }

  mission() {
    if (!this.ctx || !this.sfxOn) return;
    const t = this.ctx.currentTime, out = this.out(0.5);
    [72, 76, 79, 84, 79, 84].forEach((n, i) => this.tone('square', NOTE(n), t + i * 0.07, 0.15, 0.12, out));
  }

  /** 炸弹 / 炮弹下落的呼啸 */
  whistle(duration) {
    if (!this.ctx || !this.sfxOn || !this.gate('whistle', 0.2)) return;
    const t = this.ctx.currentTime, out = this.out(0.25);
    this.tone('sine', 1800, t, duration, 0.3, out, 380);
  }

  cannon() {
    if (!this.ctx || !this.sfxOn) return;
    const ctx = this.ctx, t = ctx.currentTime, out = this.out(0.9);
    this.tone('sine', 120, t, 0.5, 1, out, 35);
    const n = this.noiseSrc(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    this.env(g, t, 0.8, 0.002, 0.4);
    n.connect(lp).connect(g).connect(out);
    n.start(t);
    n.stop(t + 0.5);
  }

  alert() {
    if (!this.ctx || !this.sfxOn) return;
    const t = this.ctx.currentTime, out = this.out(0.4);
    for (let i = 0; i < 3; i++) this.tone('square', 980, t + i * 0.22, 0.12, 0.2, out);
  }

  /** 结束音乐：被捕 / 车毁 → 下行小调；过关 → 上行大调 */
  sting(win) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, out = this.ctx.createGain();
    out.gain.value = this.musicOn || this.sfxOn ? 0.45 : 0;
    out.connect(this.master);
    const seq = win ? [60, 64, 67, 72, 76, 79, 84] : [69, 67, 64, 60, 57];
    seq.forEach((n, i) => this.tone(win ? 'square' : 'sawtooth', NOTE(n), t + i * (win ? 0.09 : 0.16), win ? 0.25 : 0.4, 0.12, out));
  }

  // ---------------------------------------------------------------- 背景音乐
  setMode(mode) { this.mode = mode; }

  startMusic() {
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.1;
    // 每 25ms 检查一次，把接下来 0.15 秒内的音符排进时间表（标准的 Web Audio 编曲做法，不会因为掉帧而走调）
    this.timer = setInterval(() => this.schedule(), 25);
  }

  schedule() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    while (this.nextTime < ctx.currentTime + 0.15) {
      this.playStep(this.step, this.nextTime);
      const bpm = this.mode === 'menu' ? 100 : 124;
      this.nextTime += 60 / bpm / 4; // 16 分音符
      this.step = (this.step + 1) % 64;
    }
  }

  playStep(step, t) {
    if (!this.musicOn) return;
    const lvl = this.mode === 'menu' ? 0 : this.intensity; // 0 菜单 1 游戏 2 暴走
    const bar = Math.floor(step / 16), s = step % 16;
    const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
    const chord = CHORDS[bar];
    const m = this.music;

    // 铺底和弦（每小节一次，慢起慢落）
    if (s === 0) {
      for (const n of chord) {
        for (const det of [-6, 6]) {
          const o = this.ctx.createOscillator(), g = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
          o.type = 'sawtooth';
          o.frequency.value = NOTE(n);
          o.detune.value = det;
          f.type = 'lowpass';
          f.frequency.value = lvl === 2 ? 2600 : 1100;
          const dur = (60 / (this.mode === 'menu' ? 100 : 124)) * 4;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(0.035, t + dur * 0.3);
          g.gain.linearRampToValueAtTime(0.0001, t + dur);
          o.connect(f).connect(g).connect(m);
          o.start(t);
          o.stop(t + dur + 0.05);
        }
      }
    }
    // 贝斯：八分音符根音
    if (lvl >= 1 && s % 2 === 0) this.tone('sawtooth', NOTE(chord[0] - 24 + (s % 8 === 6 ? 12 : 0)), t, 0.16, 0.2, this.bassFilter());
    // 琶音
    if (s % 2 === 0 || lvl === 2) {
      const n = chord[(s / (lvl === 2 ? 1 : 2)) % 3 | 0] + 12 + (s % 8 >= 4 ? 12 : 0);
      this.tone('square', NOTE(n), t, 0.09, lvl === 0 ? 0.035 : 0.045, m);
    }
    // 鼓：底鼓 / 军鼓 / 踩镲
    if (lvl >= 1 || (this.mode === 'menu' && s % 8 === 0)) {
      if (s % 4 === 0) this.tone('sine', 140, t, 0.25, lvl === 0 ? 0.25 : 0.6, m, 40);
      if (lvl >= 1 && s % 8 === 4) this.drumNoise(t, 1800, 0.18, 0.35);
      if (lvl >= 1 && (s % 2 === 1 || lvl === 2)) this.drumNoise(t, 8000, 0.04, 0.12, 'highpass');
    }
    // 暴走：加一条主旋律
    if (lvl === 2 && s % 4 === 0) this.tone('sawtooth', NOTE([81, 79, 76, 79][(s / 4) % 4] - (bar % 2 ? 3 : 0)), t, 0.22, 0.06, m);
  }

  bassFilter() {
    if (!this._bass) {
      this._bass = this.ctx.createBiquadFilter();
      this._bass.type = 'lowpass';
      this._bass.frequency.value = 700;
      this._bass.connect(this.music);
    }
    return this._bass;
  }

  drumNoise(t, freq, dur, vol, type = 'bandpass') {
    const n = this.noiseSrc(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    f.type = type;
    f.frequency.value = freq;
    this.env(g, t, vol, 0.002, dur);
    n.connect(f).connect(g).connect(this.music);
    n.start(t);
    n.stop(t + dur + 0.05);
  }
}
