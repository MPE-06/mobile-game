import { storage } from './utils.js';

// Tiny synthesized sound effects (no audio files needed).
export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = storage.get('skyrush.sound', true);
    this.coinStreak = 0;
    this.lastCoin = 0;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.45;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    storage.set('skyrush.sound', on);
  }

  get ready() {
    return this.enabled && this.ctx && this.ctx.state === 'running';
  }

  tone(freq, dur, { type = 'sine', vol = 0.25, slide = null, delay = 0 } = {}) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  noise(dur, { vol = 0.3, freq = 1200, to = null, type = 'lowpass', delay = 0 } = {}) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  coin() {
    const now = performance.now();
    this.coinStreak = now - this.lastCoin < 450 ? Math.min(this.coinStreak + 1, 12) : 0;
    this.lastCoin = now;
    const base = 988 * Math.pow(2, this.coinStreak / 24);
    this.tone(base, 0.07, { type: 'square', vol: 0.08 });
    this.tone(base * 1.5, 0.14, { type: 'square', vol: 0.08, delay: 0.05 });
  }

  whoosh(up) {
    this.noise(0.18, { vol: 0.12, freq: up ? 600 : 2200, to: up ? 2400 : 500, type: 'bandpass' });
  }

  power() {
    [523, 659, 784, 1047].forEach((f, i) =>
      this.tone(f, 0.16, { type: 'triangle', vol: 0.18, delay: i * 0.06 }),
    );
  }

  boost() {
    this.noise(0.9, { vol: 0.25, freq: 300, to: 3000, type: 'bandpass' });
    this.tone(180, 0.6, { type: 'sawtooth', vol: 0.08, slide: 720 });
  }

  smash() {
    this.noise(0.35, { vol: 0.35, freq: 3000, to: 200 });
    this.tone(220, 0.25, { type: 'square', vol: 0.08, slide: 60 });
  }

  shieldBreak() {
    this.tone(1400, 0.3, { type: 'triangle', vol: 0.15, slide: 300 });
    this.noise(0.3, { vol: 0.25, freq: 5000, to: 800, type: 'highpass' });
  }

  crash() {
    this.noise(0.9, { vol: 0.5, freq: 1800, to: 80 });
    this.tone(160, 0.8, { type: 'sawtooth', vol: 0.18, slide: 40 });
  }

  click() {
    this.tone(660, 0.06, { type: 'triangle', vol: 0.12 });
  }
}
