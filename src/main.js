import * as THREE from '../vendor/three.module.min.js';
import { LANES, POWER_TIME, MAX_SHIELDS, BOOST_MULT, speedAt } from './config.js';
import { clamp, damp, rand, glowTexture, storage } from './utils.js';
import { Player } from './player.js';
import { World } from './world.js';
import { Track } from './track.js';
import { Particles } from './fx.js';
import { Sfx } from './audio.js';
import { Input } from './input.js';

const $ = (id) => document.getElementById(id);

class Game {
  constructor() {
    this.stage = $('stage');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.stage.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 9 / 16, 0.1, 900);
    this.camera.position.set(0, 1.4, 7.4);

    this.world = new World(this.scene);
    this.player = new Player(this.scene);
    const glow = glowTexture();
    this.fx = new Particles(this.scene, 700, 0.32, glow);
    this.bigFx = new Particles(this.scene, 160, 0.9, glow);
    this.track = new Track(this.scene, this.fx);
    this.sfx = new Sfx();

    this.input = new Input(this.stage, {
      onMove: (dx, dy) => this.move(dx, dy),
      onPause: () => this.togglePause(),
    });

    this.best = storage.get('skyrush.best', 0);
    this.bank = storage.get('skyrush.coins', 0);

    this.state = 'menu';
    this.t = 0;
    this.timeScale = 1;
    this.speed = 16;
    this.boostMul = 1;
    this.shake = 0;
    this.fovBase = 62;
    this.tmp = new THREE.Vector3();
    this.resetRun();
    this.bindUi();
    this.layout();
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('orientationchange', () => setTimeout(() => this.layout(), 200));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });

    this.last = performance.now();
    this.renderer.setAnimationLoop((now) => this.frame(now));
  }

  // ---------- setup ----------
  layout() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    let w = W;
    let h = H;
    // Portrait 9:16 play area; tall phones may use the extra height.
    if (W / H > 9 / 16) w = Math.round(H * 9 / 16);
    else if (W / H < 9 / 21) h = Math.round(W * 21 / 9);
    this.stage.style.width = `${w}px`;
    this.stage.style.height = `${h}px`;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // Keep the horizontal field of view constant so obstacles always fill the width.
    const halfH = Math.atan(Math.tan(THREE.MathUtils.degToRad(33.5)) * (9 / 16) / aspect);
    this.fovBase = THREE.MathUtils.radToDeg(halfH * 2);
    this.camera.fov = this.fovBase;
    this.camera.updateProjectionMatrix();
    const phone = window.matchMedia('(pointer: coarse)').matches && Math.min(W, H) < 600;
    document.body.classList.toggle('landscape', W > H && phone);
  }

  bindUi() {
    const tap = (el, fn) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.sfx.unlock();
      this.sfx.click();
      fn();
    });
    tap($('playBtn'), () => this.start());
    tap($('againBtn'), () => this.start());
    tap($('homeBtn'), () => this.toMenu());
    tap($('pauseBtn'), () => this.pause());
    tap($('resumeBtn'), () => this.resume());
    tap($('restartBtn'), () => this.start());
    tap($('quitBtn'), () => this.toMenu());
    for (const id of ['soundBtn', 'soundBtn2']) tap($(id), () => {
      this.sfx.setEnabled(!this.sfx.enabled);
      this.refreshSound();
    });
    $('menu').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      this.sfx.unlock();
      this.start();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        if (this.state === 'menu' || this.state === 'over') {
          this.sfx.unlock();
          this.start();
          e.preventDefault();
        }
      }
    });
    this.refreshSound();
    this.refreshMenu();

    this.ui = {
      score: $('score'), coins: $('coins'), coinBox: $('coinBox'), powers: $('powers'), toast: $('toast'),
    };
    this.chips = {};
    for (const type of ['shield', 'magnet', 'boost']) {
      const el = document.createElement('div');
      el.className = `chip ${type}`;
      el.innerHTML = type === 'shield'
        ? `<span class="chip-icon"></span><span class="pips"><b></b><b></b></span>`
        : `<span class="chip-icon"></span><span class="chip-bar"><i></i></span>`;
      this.ui.powers.appendChild(el);
      this.chips[type] = { el, bar: el.querySelector('i') };
    }
  }

  refreshSound() {
    for (const id of ['soundBtn', 'soundBtn2']) {
      $(id).textContent = this.sfx.enabled ? 'Sound: On' : 'Sound: Off';
    }
  }

  refreshMenu() {
    $('menuBest').textContent = this.best.toLocaleString();
    $('menuBank').textContent = this.bank.toLocaleString();
  }

  show(id, on) {
    $(id).classList.toggle('hidden', !on);
  }

  // ---------- state changes ----------
  resetRun() {
    this.dist = 0;
    this.score = 0;
    this.coins = 0;
    this.powers = { shield: 0, magnet: 0, boost: 0 };
    this.grace = 0;
    this.boostMul = 1;
    this.alive = false;
    this.spawning = false;
    this.milestone = 1000;
    this.shownScore = -1;
    this.shownCoins = -1;
    this.track.reset();
    this.player.reset();
    this.camX = 0;
    this.fx.clear();
    this.bigFx.clear();
    this.world.setDistance(0, true);
  }

  start() {
    this.resetRun();
    this.state = 'playing';
    this.alive = true;
    this.spawning = true;
    this.timeScale = 1;
    this.input.enabled = true;
    this.show('menu', false);
    this.show('over', false);
    this.show('pause', false);
    this.show('hud', true);
    const hint = $('hint');
    hint.classList.remove('fade');
    void hint.offsetWidth;
    hint.classList.add('fade');
  }

  toMenu() {
    this.resetRun();
    this.state = 'menu';
    this.input.enabled = false;
    this.refreshMenu();
    this.show('over', false);
    this.show('pause', false);
    this.show('hud', false);
    this.show('menu', true);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.enabled = false;
    this.show('pause', true);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.input.enabled = true;
    this.show('pause', false);
    this.last = performance.now();
  }

  togglePause() {
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
  }

  move(dx, dy) {
    if (this.state !== 'playing' || !this.alive) return;
    if (this.player.move(dx, dy)) this.sfx.whoosh(dy < 0 || dx > 0);
  }

  // ---------- gameplay events ----------
  onCoin(pos) {
    this.coins++;
    this.sfx.coin();
    this.fx.burst(pos.x, pos.y, pos.z, 0xffd23f, 8, 4, 0.45, 0.6);
    this.ui.coinBox.classList.remove('bump');
    void this.ui.coinBox.offsetWidth;
    this.ui.coinBox.classList.add('bump');
  }

  onPower(type, pos, color) {
    let label = { shield: 'Shield!', magnet: 'Coin Magnet!', boost: 'Turbo Boost!' }[type];
    if (type === 'shield') {
      // Shields stack (up to two) and never time out.
      this.powers.shield = Math.min(MAX_SHIELDS, this.powers.shield + 1);
      if (this.powers.shield === 2) {
        label = 'Double Shield!';
        color = 0xffc23a;
      }
    } else {
      this.powers[type] = POWER_TIME[type];
    }
    if (type === 'boost') {
      this.sfx.boost();
      this.shake = Math.max(this.shake, 0.25);
    } else this.sfx.power();
    this.bigFx.burst(pos.x, pos.y, pos.z, color, 24, 7, 0.6, 0.6);
    this.toast(label, type === 'shield' && this.powers.shield === 2 ? 'shield2' : type);
  }

  onHit(e) {
    const px = this.player.x;
    const py = this.player.y;
    if (this.powers.boost > 0) {
      if (e.smashable) this.smash(e, px, py);
      return;
    }
    if (this.grace > 0) return;
    if (this.powers.shield > 0) {
      // Absorb the hit with one charge; a double shield drops back to blue.
      const wasDouble = this.powers.shield === 2;
      this.powers.shield -= 1;
      this.bigFx.burst(px, py, 0, wasDouble ? 0xffc23a : 0x4fd8ff, 30, 9, 0.7, 0.5);
      this.toast(wasDouble ? 'Shield ×1' : 'Shield down!', wasDouble ? 'shield' : 'warn');
      this.grace = 1.3;
      this.sfx.shieldBreak();
      if (e.smashable) this.smash(e, px, py);
      this.shake = 0.4;
      this.vibrate(40);
      return;
    }
    this.die();
  }

  smash(e, px, py) {
    this.track.smash(e);
    this.sfx.smash();
    this.shake = Math.max(this.shake, 0.3);
    for (const c of e.colliders) {
      if (c.y1 < py - 1.5 || c.y0 > py + 1.5 || c.x1 < px - 1.5 || c.x0 > px + 1.5) continue;
      const cx = clamp(px, c.x0, c.x1);
      const cy = clamp(py, c.y0, c.y1);
      this.bigFx.burst(cx, cy, -0.8, e.color || 0xffffff, 14, 10, 0.7, 1);
      this.fx.burst(cx, cy, -0.8, 0xffffff, 20, 12, 0.5, 1);
    }
  }

  die() {
    this.alive = false;
    this.state = 'dying';
    this.input.enabled = false;
    this.deathTimer = 0;
    this.timeScale = 0.25;
    this.shake = 0.8;
    const px = this.player.x;
    const py = this.player.y;
    this.bigFx.burst(px, py, 0, 0xff7a1a, 50, 10, 1.2, 0.2);
    this.bigFx.burst(px, py, 0, 0xffd23f, 30, 6, 1.0, 0.2);
    this.fx.burst(px, py, 0, 0xffffff, 80, 14, 0.9, 0.2);
    this.sfx.crash();
    this.vibrate([60, 40, 120]);
    this.show('hud', false);
  }

  gameOver() {
    this.state = 'over';
    const newBest = this.score > this.best;
    if (newBest) {
      this.best = this.score;
      storage.set('skyrush.best', this.best);
    }
    this.bank += this.coins;
    storage.set('skyrush.coins', this.bank);
    $('finalScore').textContent = this.score.toLocaleString();
    $('finalCoins').textContent = this.coins.toLocaleString();
    $('finalBest').textContent = this.best.toLocaleString();
    $('newBest').classList.toggle('hidden', !newBest);
    this.show('over', true);
  }

  vibrate(p) {
    try {
      navigator.vibrate && navigator.vibrate(p);
    } catch {
      /* not supported */
    }
  }

  toast(text, cls = '') {
    const el = this.ui.toast;
    el.textContent = text;
    el.className = '';
    void el.offsetWidth;
    el.className = `show ${cls}`;
  }

  // ---------- main loop ----------
  frame(now) {
    const elapsed = Math.max(0, (now - this.last) / 1000);
    const raw = Math.min(0.05, elapsed);
    this.last = now;
    const dt = raw * this.timeScale;
    if (this.state !== 'paused') this.t += dt;
    const t = this.t;

    if (this.state === 'playing') {
      for (const k of ['magnet', 'boost']) {
        if (this.powers[k] > 0) {
          this.powers[k] = Math.max(0, this.powers[k] - dt);
          if (k === 'boost' && this.powers[k] === 0) this.grace = Math.max(this.grace, 1.2);
        }
      }
      this.grace = Math.max(0, this.grace - dt);
      this.boostMul = damp(this.boostMul, this.powers.boost > 0 ? BOOST_MULT : 1, 3, dt);
      this.speed = speedAt(this.dist) * this.boostMul;
      this.dist += this.speed * dt;
      this.score = Math.floor(this.dist);
      if (this.score >= this.milestone) {
        this.toast(`${this.milestone.toLocaleString()} m!`, 'milestone');
        this.milestone += 1000;
      }
    } else if (this.state === 'menu') {
      this.speed = damp(this.speed, 16, 2, dt);
    } else if (this.state === 'dying' || this.state === 'over') {
      this.speed = damp(this.speed, this.state === 'over' ? 6 : 0, 3, dt);
      if (this.state === 'dying') {
        this.deathTimer += Math.min(elapsed, 0.25);
        this.timeScale = damp(this.timeScale, 1, 1.5, raw);
        if (this.deathTimer > 1.1) this.gameOver();
      }
    }

    const running = this.state !== 'paused';
    if (running) {
      if (this.state === 'over' || this.state === 'dying') this.dist += this.speed * dt;
      this.world.setDistance(this.dist);
      this.player.update(dt, t, {
        speed: this.speed,
        boost: this.powers.boost > 0,
        shields: this.state === 'menu' ? 0 : this.powers.shield,
        magnet: this.powers.magnet > 0,
        grace: this.grace > 0 && this.powers.boost <= 0,
        dead: !this.alive && this.state !== 'menu',
      });
      this.track.update(dt, t, this.dist, this.speed, this);
      this.world.update(dt, t, this.speed, this.camera, this.powers.boost > 0);
      this.emitTrail(dt);
      this.fx.update(dt, this.speed);
      this.bigFx.update(dt, this.speed);
      this.updateCamera(dt, raw);
      this.updateHud();
    }

    this.renderer.render(this.scene, this.camera);
  }

  emitTrail(dt) {
    if (!this.player.root.visible) return;
    const boost = this.powers.boost > 0;
    const n = boost ? 3 : 1;
    for (let i = 0; i < 2; i++) {
      const p = this.player.thrusterWorld(i, this.tmp);
      for (let k = 0; k < n; k++) {
        this.fx.emit(
          p.x + rand(-0.05, 0.05), p.y + rand(-0.05, 0.05), p.z,
          rand(-0.4, 0.4), rand(-0.6, 0.2), rand(2, 4),
          boost ? (Math.random() < 0.5 ? 0x7ff3ff : 0xffffff) : Math.random() < 0.6 ? 0xff8a2a : 0xffd23f,
          boost ? 0.5 : 0.32, 1,
        );
      }
    }
  }

  updateCamera(dt, raw) {
    const cam = this.camera;
    const py = this.player.root.position.y;
    const px = this.player.root.position.x;
    // Follow the player partly, so sideways and vertical moves read clearly on screen.
    this.camX = damp(this.camX ?? 0, px * 0.45, 6, dt);
    this.camY = damp(this.camY ?? 1.4, py * 0.35 + 1.4, 6, dt);
    const camX = this.camX;
    const camY = this.camY;
    this.shake = Math.max(0, this.shake - raw * 1.6);
    const s = this.shake * this.shake;
    cam.position.set(camX + rand(-1, 1) * s * 0.6, camY + rand(-1, 1) * s * 0.6, 7.4);
    cam.lookAt(camX * 0.9, camY - 3.0, -12);
    cam.rotation.z += Math.sin(this.t * 0.7) * 0.01 - this.player.vy * 0.004 - this.player.vx * 0.006;
    const fov = this.fovBase + clamp((this.speed - 20) * 0.18, 0, 7) + (this.boostMul - 1) * 12;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = damp(cam.fov, fov, 4, dt);
      cam.updateProjectionMatrix();
    }
  }

  updateHud() {
    if (this.state !== 'playing') return;
    if (this.score !== this.shownScore) {
      this.ui.score.textContent = this.score.toLocaleString();
      this.shownScore = this.score;
    }
    if (this.coins !== this.shownCoins) {
      this.ui.coins.textContent = this.coins.toLocaleString();
      this.shownCoins = this.coins;
    }
    const sh = this.powers.shield;
    const shieldChip = this.chips.shield;
    shieldChip.el.classList.toggle('on', sh > 0);
    shieldChip.el.classList.toggle('double', sh >= 2);
    for (const [type, chip] of Object.entries(this.chips)) {
      if (type === 'shield') continue;
      const v = this.powers[type];
      chip.el.classList.toggle('on', v > 0);
      chip.el.classList.toggle('ending', v > 0 && v < 2);
      if (v > 0) chip.bar.style.transform = `scaleX(${v / POWER_TIME[type]})`;
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  try {
    window.game = new Game();
  } catch (err) {
    console.error(err);
    $('error').classList.remove('hidden');
  }
});

// Keep lane constants reachable for debugging in the console.
window.SKY_RUSH = { LANES };
