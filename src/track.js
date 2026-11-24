import * as THREE from '../vendor/three.module.min.js';
import {
  LANES, COLS, BAND, BAND_X, PLAYER_HALF_X, PLAYER_HALF_Y, PLAYER_HALF_Z, SPAWN_AHEAD, DESPAWN_BEHIND,
  difficultyAt,
} from './config.js';
import { canvasTexture, rand, randInt, pick, lerp, smoothstep, weightedPick } from './utils.js';

// The flight area is a 3x3 grid. Cells are indexed row-major: i = row * 3 + col.
const TOP = LANES[0] + BAND; // top edge of the grid
const BOTTOM = LANES[2] - BAND;
const RIGHT = COLS[2] + BAND_X; // right edge of the grid
const WIDTH = RIGHT * 2; // full-width obstacles span every column
const HEIGHT = TOP - BOTTOM;
const CELL_W = BAND_X * 2 - 0.08; // small seam between neighbouring panels
const CELL_H = BAND * 2 - 0.1;
const TUNNEL_GAP = 1.15; // half-size of a tunnel's open corridor
const ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const rowOf = (i) => Math.floor(i / 3);
const colOf = (i) => i % 3;
const cellX = (i) => COLS[colOf(i)];
const cellY = (i) => LANES[rowOf(i)];
const dist = (a, b) => Math.abs(rowOf(a) - rowOf(b)) + Math.abs(colOf(a) - colOf(b));
const rowCells = (r) => [r * 3, r * 3 + 1, r * 3 + 2];
const colCells = (c) => [c, c + 3, c + 6];
const without = (cells) => ALL.filter((i) => !cells.includes(i));

// Coins are a reward, not wallpaper: trails are optional and spaced out.
const COIN_TRAIL_CHANCE = 0.6;
const COIN_SPACING = 3.4;

// ---------- shared textures / materials / geometry ----------
function makeAssets() {
  const stripes = (bg, fg, border) =>
    canvasTexture(256, 128, (g, w, h) => {
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      g.fillStyle = fg;
      for (let x = -h; x < w + h; x += 48) {
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x + 24, 0);
        g.lineTo(x + 24 - h, h);
        g.lineTo(x - h, h);
        g.closePath();
        g.fill();
      }
      g.strokeStyle = border;
      g.lineWidth = 10;
      g.strokeRect(5, 5, w - 10, h - 10);
    });

  const hazard = stripes('#1b1446', '#ff2d95', '#49f2ff');
  const yellow = stripes('#16131f', '#ffcc1f', '#ff5a3c');
  const chevron = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#121029';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#ffcc1f';
    g.lineWidth = 22;
    for (let y = 30; y < h; y += 70) {
      g.beginPath();
      g.moveTo(40, y + 30);
      g.lineTo(w / 2, y);
      g.lineTo(w - 40, y + 30);
      g.stroke();
    }
  });
  const panel = canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#23264a';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(73,242,255,0.35)';
    g.lineWidth = 3;
    g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = 'rgba(255,63,164,0.6)';
    g.fillRect(14, h / 2 - 3, w - 28, 6);
  }, { repeat: true });

  const std = (o) => new THREE.MeshStandardMaterial(o);
  const basic = (c, extra = {}) => new THREE.MeshBasicMaterial({ color: c, ...extra });
  const add = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false };

  return {
    hazard: std({ map: hazard, emissiveMap: hazard, emissive: 0xffffff, emissiveIntensity: 0.7, roughness: 0.4 }),
    yellow: std({ map: yellow, emissiveMap: yellow, emissive: 0xffffff, emissiveIntensity: 0.45, roughness: 0.5 }),
    chevron: std({ map: chevron, emissiveMap: chevron, emissive: 0xffffff, emissiveIntensity: 0.8 }),
    panel: std({ map: panel, emissiveMap: panel, emissive: 0xffffff, emissiveIntensity: 0.5, roughness: 0.6, metalness: 0.3 }),
    metal: std({ color: 0x2b2f4a, roughness: 0.4, metalness: 0.7 }),
    glass: std({ color: 0x8fe8ff, transparent: true, opacity: 0.14, roughness: 0.1, depthWrite: false, side: THREE.DoubleSide }),
    cyan: basic(0x49f2ff),
    pink: basic(0xff3fa4),
    red: basic(0xff2a4a),
    amber: basic(0xffb020),
    laserCore: basic(0xffe1e6),
    laserGlow: basic(0xff2a4a, { ...add, opacity: 0.35 }),
    ribGlow: basic(0x49f2ff, { ...add, opacity: 0.85 }),
    rock: std({ color: 0x8a6650, roughness: 1, flatShading: true }),
    grass: std({ color: 0x5ccf5a, roughness: 0.9, flatShading: true }),
    flower: basic(0xffe14d),
    droneCore: std({ color: 0xff2a4a, emissive: 0xff1a3a, emissiveIntensity: 1.2, roughness: 0.3 }),
    coin: std({ color: 0xffc93c, emissive: 0xb37400, emissiveIntensity: 0.55, metalness: 0.6, roughness: 0.25 }),
    coinRim: std({ color: 0xffe9a0, emissive: 0x7a5200, emissiveIntensity: 0.5, metalness: 0.6, roughness: 0.3 }),
    bubble: basic(0xffffff, { ...add, opacity: 0.22, side: THREE.DoubleSide }),
    unit: new THREE.BoxGeometry(1, 1, 1),
    geoCache: new Map(),
  };
}

// ---------- the track ----------
export class Track {
  constructor(scene, fx) {
    this.scene = scene;
    this.fx = fx;
    this.a = makeAssets();
    this.entities = [];
    this.coins = [];
    this.powers = [];
    this.coinPool = [];
    this.buildPrototypes();
    this.reset();
  }

  geo(key, make) {
    let g = this.a.geoCache.get(key);
    if (!g) {
      g = make();
      this.a.geoCache.set(key, g);
    }
    return g;
  }

  box(parent, mat, w, h, d, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(this.geo(`box${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d)), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  buildPrototypes() {
    const a = this.a;
    // Coin
    const coinGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.1, 24);
    coinGeo.rotateX(Math.PI / 2);
    const rimGeo = new THREE.TorusGeometry(0.42, 0.05, 6, 24);
    const starGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.14, 5);
    starGeo.rotateX(Math.PI / 2);
    this.makeCoinMesh = () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(coinGeo, a.coin));
      g.add(new THREE.Mesh(rimGeo, a.coinRim));
      g.add(new THREE.Mesh(starGeo, a.coinRim));
      return g;
    };

    // Power-up icons inside a glowing bubble
    const bubbleGeo = new THREE.SphereGeometry(0.75, 20, 14);
    const icon = {
      shield: () => {
        const g = new THREE.Group();
        const m = new THREE.MeshStandardMaterial({ color: 0x4fd8ff, emissive: 0x1a8fd0, emissiveIntensity: 0.9, metalness: 0.4, roughness: 0.3 });
        const s = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.12, 6), m);
        s.rotation.x = Math.PI / 2;
        g.add(s);
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        c.rotation.x = Math.PI / 2;
        g.add(c);
        return { g, color: 0x4fd8ff };
      },
      magnet: () => {
        const g = new THREE.Group();
        const m = new THREE.MeshStandardMaterial({ color: 0xff3355, emissive: 0xa0102a, emissiveIntensity: 0.8, roughness: 0.35 });
        const tip = new THREE.MeshStandardMaterial({ color: 0xe8ecff, metalness: 0.7, roughness: 0.2 });
        const arc = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.1, 8, 20, Math.PI), m);
        arc.rotation.z = Math.PI;
        g.add(arc);
        for (const s of [-1, 1]) {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.22, 10), m);
          leg.position.set(0.28 * s, 0.11, 0);
          g.add(leg);
          const t = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.12, 10), tip);
          t.position.set(0.28 * s, 0.28, 0);
          g.add(t);
        }
        g.position.y = -0.05;
        return { g, color: 0xff4d6d };
      },
      boost: () => {
        const g = new THREE.Group();
        const m = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.3, roughness: 0.3 });
        const fin = new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xc04a00, emissiveIntensity: 0.6 });
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.45, 12), m);
        g.add(body);
        const nose = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.25, 12), fin);
        nose.position.y = 0.35;
        g.add(nose);
        for (const s of [-1, 1]) {
          const f = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.04), fin);
          f.position.set(0.17 * s, -0.17, 0);
          g.add(f);
        }
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 10), new THREE.MeshBasicMaterial({ color: 0xffd23f }));
        flame.rotation.x = Math.PI;
        flame.position.y = -0.38;
        g.add(flame);
        g.rotation.z = -0.6;
        return { g, color: 0xffa21a };
      },
    };
    this.makePowerMesh = (type) => {
      const root = new THREE.Group();
      const { g, color } = icon[type]();
      const holder = new THREE.Group();
      holder.add(g);
      root.add(holder);
      const bubble = new THREE.Mesh(bubbleGeo, a.bubble.clone());
      bubble.material.color.set(color);
      root.add(bubble);
      root.userData = { holder, color };
      return root;
    };
  }


  reset() {
    for (const e of this.entities) this.scene.remove(e.group);
    for (const c of this.coins) this.releaseCoin(c);
    for (const p of this.powers) this.scene.remove(p.mesh);
    this.entities = [];
    this.coins = [];
    this.powers = [];
    this.cursor = 75; // where the next pattern starts (absolute distance)
    this.trailStart = 14;
    this.trailCell = 4; // centre cell
    this.count = 0;
    this.nextPowerD = rand(380, 520);
    this.lastType = null;
  }

  // ---------- spawning helpers ----------
  addEntity(absD, len, group, colliders, opts = {}) {
    const e = { absD, len, group, colliders, smashable: true, dead: false, ...opts };
    group.position.z = -1e4; // positioned on the next update
    this.scene.add(group);
    this.entities.push(e);
    return e;
  }

  acquireCoin() {
    const m = this.coinPool.pop() || this.makeCoinMesh();
    m.visible = true;
    m.scale.setScalar(1);
    this.scene.add(m);
    return m;
  }

  releaseCoin(c) {
    this.scene.remove(c.mesh);
    this.coinPool.push(c.mesh);
  }

  addCoin(absD, x, y) {
    const mesh = this.acquireCoin();
    mesh.position.set(x, y, -1e4);
    this.coins.push({ absD, x, y, mesh, pulled: false });
  }

  addPower(absD, cell, type) {
    const mesh = this.makePowerMesh(type);
    mesh.position.set(cellX(cell), cellY(cell), -1e4);
    this.scene.add(mesh);
    this.powers.push({ absD, x: cellX(cell), y: cellY(cell), mesh, type });
  }

  // Coins that guide the player from one cell to the next.
  coinTrail(a, b, ca, cb, { force = false, spacing = COIN_SPACING, chance = COIN_TRAIL_CHANCE } = {}) {
    if (b - a < 5) return;
    const wantPower = a + (b - a) / 2 > this.nextPowerD && b - a > 14;
    if (!force && !wantPower && Math.random() > chance) return;
    const n = Math.max(1, Math.floor((b - a) / spacing));
    const xa = cellX(ca);
    const xb = cellX(cb);
    const ya = cellY(ca);
    const yb = cellY(cb);
    const powerAt = wantPower ? Math.floor(n * 0.65) : -1;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const d = a + (b - a) * f;
      const k = smoothstep(0.05, 0.5, f);
      if (i === powerAt && k === 1) {
        const types = [['shield', 0.4], ['magnet', 0.35], ['boost', 0.25]];
        this.addPower(d, cb, weightedPick(types));
        this.nextPowerD = d + rand(520, 900);
        continue;
      }
      this.addCoin(d, lerp(xa, xb, k), lerp(ya, yb, k));
    }
  }

  // ---------- obstacle builders ----------
  // Energy panels / floating rocks on individual cells.
  buildCells(blocked, style) {
    const g = new THREE.Group();
    const colliders = [];
    const rock = style === 'rock';
    const rockGeo = this.geo('rock', () => new THREE.DodecahedronGeometry(1, 0));
    const capGeo = this.geo('cap', () => new THREE.CylinderGeometry(1, 0.9, 0.3, 8));
    for (const i of blocked) {
      const x = cellX(i);
      const y = cellY(i);
      if (rock) {
        const r = new THREE.Mesh(rockGeo, this.a.rock);
        r.scale.set(BAND_X * 1.05, 0.95, 1.3);
        r.rotation.y = rand(0, Math.PI);
        r.position.set(x, y - 0.12, 0);
        g.add(r);
        const cap = new THREE.Mesh(capGeo, this.a.grass);
        cap.scale.set(BAND_X * 0.9, 1, 1.1);
        cap.position.set(x, y + 0.72, 0);
        g.add(cap);
        for (let f = 0; f < 2; f++) this.box(g, this.a.flower, 0.12, 0.12, 0.12, x + rand(-0.6, 0.6), y + 0.92, rand(-0.6, 0.6));
        colliders.push({ x0: x - BAND_X + 0.1, x1: x + BAND_X - 0.1, y0: y - BAND + 0.1, y1: y + BAND - 0.15, d0: -1.1, d1: 1.1 });
      } else {
        this.box(g, this.a.hazard, CELL_W, CELL_H, 0.5, x, y, 0);
        colliders.push({ x0: x - BAND_X, x1: x + BAND_X, y0: y - BAND, y1: y + BAND, d0: -0.3, d1: 0.3 });
      }
    }
    if (!rock) {
      // Neon frame around the whole wall so it reads as one structure.
      this.box(g, this.a.cyan, WIDTH + 0.2, 0.12, 0.55, 0, TOP + 0.06, 0);
      this.box(g, this.a.cyan, WIDTH + 0.2, 0.12, 0.55, 0, BOTTOM - 0.06, 0);
      this.box(g, this.a.pink, 0.14, HEIGHT + 0.24, 0.57, -RIGHT - 0.07, 0, 0);
      this.box(g, this.a.pink, 0.14, HEIGHT + 0.24, 0.57, RIGHT + 0.07, 0, 0);
    }
    const update = rock ? (t) => (g.rotation.z = Math.sin(t * 1.1) * 0.02) : null;
    return { g, colliders, color: rock ? 0x8a6650 : 0xff2d95, update };
  }

  // Laser gate: beams across whole rows and/or down whole columns.
  buildLaser(rows, cols) {
    const g = new THREE.Group();
    const colliders = [];
    // Frame
    for (const s of [-1, 1]) {
      this.box(g, this.a.metal, 0.4, HEIGHT + 1.2, 0.4, (RIGHT + 0.25) * s, 0, 0);
      this.box(g, this.a.metal, WIDTH + 0.9, 0.4, 0.4, 0, s > 0 ? TOP + 0.35 : BOTTOM - 0.35, 0);
    }
    this.box(g, this.a.red, 0.1, HEIGHT + 1.2, 0.42, -RIGHT - 0.07, 0, 0);
    this.box(g, this.a.red, 0.1, HEIGHT + 1.2, 0.42, RIGHT + 0.07, 0, 0);
    const hCore = this.geo('laserCoreH', () => new THREE.CylinderGeometry(0.05, 0.05, WIDTH + 0.4, 6).rotateZ(Math.PI / 2));
    const hGlow = this.geo('laserGlowH', () => new THREE.CylinderGeometry(0.12, 0.12, WIDTH + 0.4, 8).rotateZ(Math.PI / 2));
    const vCore = this.geo('laserCoreV', () => new THREE.CylinderGeometry(0.05, 0.05, HEIGHT + 0.6, 6));
    const vGlow = this.geo('laserGlowV', () => new THREE.CylinderGeometry(0.12, 0.12, HEIGHT + 0.6, 8));
    const beams = [];
    const beam = (core, glow, x, y) => {
      const c = new THREE.Mesh(core, this.a.laserCore);
      const gl = new THREE.Mesh(glow, this.a.laserGlow);
      c.position.set(x, y, 0);
      gl.position.set(x, y, 0);
      gl.userData.horizontal = glow === hGlow;
      g.add(c, gl);
      beams.push(gl);
    };
    for (const r of rows) {
      for (const off of [-0.72, 0, 0.72]) beam(hCore, hGlow, 0, LANES[r] + off);
      for (const s of [-1, 1]) this.box(g, this.a.red, 0.55, 0.3, 0.55, (RIGHT + 0.25) * s, LANES[r], 0);
      colliders.push({ x0: -RIGHT, x1: RIGHT, y0: LANES[r] - BAND + 0.15, y1: LANES[r] + BAND - 0.15, d0: -0.25, d1: 0.25 });
    }
    for (const c of cols) {
      for (const off of [-0.66, 0, 0.66]) beam(vCore, vGlow, COLS[c] + off, 0);
      for (const s of [-1, 1]) this.box(g, this.a.red, 0.3, 0.55, 0.55, COLS[c], (s > 0 ? TOP + 0.35 : BOTTOM - 0.35), 0);
      colliders.push({ x0: COLS[c] - BAND_X + 0.12, x1: COLS[c] + BAND_X - 0.12, y0: BOTTOM, y1: TOP, d0: -0.25, d1: 0.25 });
    }
    const update = (t) => {
      const k = 1 + Math.sin(t * 30) * 0.15;
      for (const b of beams) {
        if (b.userData.horizontal) b.scale.set(1, k, k);
        else b.scale.set(k, 1, k);
      }
    };
    return { g, colliders, color: 0xff2a4a, update };
  }

  // A bar (or spiky drone) that slides between two adjacent rows ('y'),
  // or a pillar that slides between two adjacent columns ('x').
  buildMover(axis, pair, drone) {
    const g = new THREE.Group();
    const vert = axis === 'y';
    const P = vert ? LANES : COLS;
    const a = P[pair[0]];
    const b = P[pair[1]];
    const mid = (a + b) / 2;
    const amp = (a - b) / 2;
    const span = Math.abs(a - b);
    // Rails that telegraph the travel range.
    for (const s of [-1, 1]) {
      if (vert) {
        this.box(g, this.a.metal, 0.3, span + 2.4, 0.3, (RIGHT + 0.2) * s, mid, 0);
        this.box(g, this.a.amber, 0.08, span + 2.2, 0.32, (RIGHT + 0.2) * s - 0.12 * s, mid, 0);
      } else {
        this.box(g, this.a.metal, span + 2.4, 0.3, 0.3, mid, s > 0 ? TOP + 0.2 : BOTTOM - 0.2, 0);
        this.box(g, this.a.amber, span + 2.2, 0.08, 0.32, mid, s > 0 ? TOP + 0.08 : BOTTOM - 0.08, 0);
      }
    }
    const mover = new THREE.Group();
    g.add(mover);
    let half;
    const lights = [];
    if (drone) {
      half = 0.85;
      const core = new THREE.Mesh(this.geo('droneCore', () => new THREE.IcosahedronGeometry(0.7, 1)), this.a.droneCore);
      mover.add(core);
      const spikeGeo = this.geo('spike', () => new THREE.ConeGeometry(0.16, 0.6, 6));
      const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
        [0.7, 0.7, 0], [-0.7, 0.7, 0], [0.7, -0.7, 0], [-0.7, -0.7, 0]];
      for (const [x, y, z] of dirs) {
        const sp = new THREE.Mesh(spikeGeo, this.a.metal);
        const v = new THREE.Vector3(x, y, z).normalize();
        sp.position.copy(v).multiplyScalar(0.85);
        sp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v);
        mover.add(sp);
      }
      // Arms that connect it to the rails
      if (vert) this.box(mover, this.a.metal, WIDTH, 0.14, 0.14, 0, 0, 0);
      else this.box(mover, this.a.metal, 0.14, HEIGHT, 0.14, 0, 0, 0);
    } else {
      half = 0.75;
      if (vert) this.box(mover, this.a.yellow, WIDTH, 1.5, 0.7, 0, 0, 0);
      else this.box(mover, this.a.yellow, 1.5, HEIGHT, 0.7, 0, 0, 0);
      for (const s of [-1, 1]) {
        const off = vert ? [(RIGHT - 0.4) * s, 0] : [0, (TOP - 0.4) * s];
        lights.push(this.box(mover, this.a.red, 0.3, 0.3, 0.75, off[0], off[1], 0));
      }
    }
    // Drones only block their own cell on the cross axis: they sit in the centre.
    const omega = rand(2.6, 3.4);
    const phase = rand(0, Math.PI * 2);
    const col = vert
      ? { x0: drone ? -half : -RIGHT, x1: drone ? half : RIGHT, y0: 0, y1: 0, d0: -0.5, d1: 0.5 }
      : { x0: 0, x1: 0, y0: drone ? -half : BOTTOM, y1: drone ? half : TOP, d0: -0.5, d1: 0.5 };
    const armCol = drone
      ? (vert ? { x0: -RIGHT, x1: RIGHT, y0: 0, y1: 0, d0: -0.1, d1: 0.1 } : { x0: 0, x1: 0, y0: BOTTOM, y1: TOP, d0: -0.1, d1: 0.1 })
      : null;
    const update = (t) => {
      const p = mid + amp * Math.sin(t * omega + phase);
      if (vert) {
        mover.position.y = p;
        col.y0 = p - half;
        col.y1 = p + half;
        if (armCol) { armCol.y0 = p - 0.07; armCol.y1 = p + 0.07; }
      } else {
        mover.position.x = p;
        col.x0 = p - half;
        col.x1 = p + half;
        if (armCol) { armCol.x0 = p - 0.07; armCol.x1 = p + 0.07; }
      }
      if (drone) mover.children[0].rotation.set(t * 2, t * 3, 0);
      for (const l of lights) l.visible = Math.sin(t * 14) > 0;
    };
    update(0);
    const colliders = armCol ? [col, armCol] : [col];
    return { g, colliders, color: drone ? 0xff2a4a : 0xffcc1f, update };
  }

  // Enclosed tunnel where only one cell is open.
  buildTunnel(open, len) {
    const g = new THREE.Group();
    const colliders = [];
    const a = this.a;
    const ox = cellX(open);
    const oy = cellY(open);
    const roof = TOP + 0.4;
    const floor = BOTTOM - 0.4;
    const wall = RIGHT + 0.4;
    const fills = []; // [x0, x1, y0, y1]
    if (oy + TUNNEL_GAP < roof) fills.push([-wall, wall, oy + TUNNEL_GAP, roof]);
    if (oy - TUNNEL_GAP > floor) fills.push([-wall, wall, floor, oy - TUNNEL_GAP]);
    if (ox - TUNNEL_GAP > -wall) fills.push([-wall, ox - TUNNEL_GAP, oy - TUNNEL_GAP, oy + TUNNEL_GAP]);
    if (ox + TUNNEL_GAP < wall) fills.push([ox + TUNNEL_GAP, wall, oy - TUNNEL_GAP, oy + TUNNEL_GAP]);
    for (const [x0, x1, y0, y1] of fills) {
      const w = x1 - x0;
      const h = y1 - y0;
      const m = new THREE.Mesh(this.geo(`slab${w.toFixed(2)}|${h.toFixed(2)}|${len.toFixed(1)}`, () => {
        const geo = new THREE.BoxGeometry(w, h, len);
        const uv = geo.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.max(1, Math.round(len / 4)), uv.getY(i));
        return geo;
      }), a.panel);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, -len / 2);
      g.add(m);
      // Chevron warning on the entrance face
      const face = new THREE.Mesh(this.geo(`face${w.toFixed(2)}|${h.toFixed(2)}`, () => new THREE.PlaneGeometry(w, h)), a.chevron);
      face.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0.02);
      g.add(face);
      colliders.push({ x0, x1, y0, y1, d0: 0, d1: len });
    }
    // Roof & floor plates (always present so it reads as a tunnel)
    this.box(g, a.metal, wall * 2 + 0.3, 0.35, len, 0, roof + 0.17, -len / 2);
    this.box(g, a.metal, wall * 2 + 0.3, 0.35, len, 0, floor - 0.17, -len / 2);
    // Glass side walls
    for (const s of [-1, 1]) {
      const glass = new THREE.Mesh(this.geo(`glass${len.toFixed(1)}`, () => new THREE.PlaneGeometry(len, roof - floor)), a.glass);
      glass.rotation.y = Math.PI / 2;
      glass.position.set((wall + 0.05) * s, (roof + floor) / 2, -len / 2);
      g.add(glass);
    }
    // Guide lights along the four edges of the open corridor
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        this.box(g, a.cyan, 0.08, 0.08, len, ox + (TUNNEL_GAP - 0.05) * sx, oy + (TUNNEL_GAP - 0.05) * sy, -len / 2);
      }
    }
    // Glowing ribs
    const ribGeo = this.geo('rib', () => new THREE.RingGeometry(0.93, 1, 4, 1).rotateZ(Math.PI / 4));
    for (let z = 0; z <= len; z += 5) {
      const rib = new THREE.Mesh(ribGeo, a.ribGlow);
      rib.scale.set((wall * 2 + 0.8) / 1.41, (roof - floor + 0.8) / 1.41, 1);
      rib.position.set(0, (roof + floor) / 2, -z);
      g.add(rib);
    }
    return { g, colliders, color: 0x49f2ff, smashable: false };
  }

  // ---------- pattern generation ----------
  placeWall(absD, blocked, style) {
    const built = this.buildCells(blocked, style || (Math.random() < 0.3 ? 'rock' : 'barrier'));
    this.addEntity(absD, 1.2, built.g, built.colliders, { color: built.color, update: built.update });
  }

  // Full rows / columns can be walls or laser gates.
  placeLines(absD, rows, cols, style) {
    const s = style || (Math.random() < 0.5 ? 'laser' : 'barrier');
    if (s === 'laser') {
      const built = this.buildLaser(rows, cols);
      this.addEntity(absD, 1.2, built.g, built.colliders, { color: built.color, update: built.update });
    } else {
      const blocked = new Set();
      for (const r of rows) rowCells(r).forEach((i) => blocked.add(i));
      for (const c of cols) colCells(c).forEach((i) => blocked.add(i));
      this.placeWall(absD, [...blocked], 'barrier');
    }
  }

  // Pick a free cell to aim for. Sometimes stay put, but usually make the
  // player move; never ask for more than `maxDist` steps at once.
  chooseCell(free, maxDist = 2) {
    if (free.includes(this.trailCell) && Math.random() < 0.3) return this.trailCell;
    let near = free.filter((i) => i !== this.trailCell && dist(i, this.trailCell) <= maxDist);
    if (!near.length) near = free.filter((i) => dist(i, this.trailCell) <= maxDist);
    if (!near.length) near = free;
    return pick(near);
  }

  enter(cell) {
    this.coinTrail(this.trailStart + 2.5, this.cursor - 2.5, this.trailCell, cell);
  }

  finish(endD, cell, gapDist) {
    this.trailStart = endD;
    this.trailCell = cell;
    this.cursor = endD + gapDist;
  }

  // Random holes for a wall: the first one is always within reach.
  holes(count, maxDist = 2) {
    const first = this.chooseCell(ALL, maxDist);
    const rest = ALL.filter((i) => i !== first).sort(() => Math.random() - 0.5);
    return [first, ...rest.slice(0, count - 1)];
  }

  generate(speed) {
    const d = difficultyAt(this.cursor);
    const n = this.count++;
    let type;
    if (n < 2) type = 'row';
    else if (n === 2) type = 'column';
    else {
      type = weightedPick([
        ['row', Math.max(0.25, 0.8 - 0.5 * d)],
        ['column', Math.max(0.25, 0.7 - 0.4 * d)],
        ['double', 0.3 + 0.5 * d],
        ['wall', n > 3 ? 0.35 + 0.6 * d : 0],
        ['mover', n > 4 ? 0.25 + 0.4 * d : 0],
        ['tunnel', n > 5 ? 0.2 + 0.25 * d : 0],
        ['chain', d > 0.2 ? 0.5 * d : 0],
        ['zigzag', d > 0.35 ? 0.4 * d : 0],
        ['rest', this.lastType === 'rest' ? 0 : 0.12],
      ]);
    }
    this.lastType = type;
    const gapT = lerp(1.25, 0.65, d) + rand(0, 0.3);
    const gap = Math.max(14, speed * gapT);

    switch (type) {
      case 'row':
      case 'column': {
        const k = randInt(0, 2);
        const line = type === 'row' ? rowCells(k) : colCells(k);
        const cell = this.chooseCell(without(line));
        this.enter(cell);
        this.placeLines(this.cursor, type === 'row' ? [k] : [], type === 'column' ? [k] : []);
        this.finish(this.cursor + 1, cell, gap);
        break;
      }
      case 'double': {
        // Two rows or two columns blocked: one line of three cells stays open.
        const cell = this.chooseCell(ALL);
        const byRow = Math.random() < 0.5;
        const keep = byRow ? rowOf(cell) : colOf(cell);
        const lines = [0, 1, 2].filter((l) => l !== keep);
        this.enter(cell);
        this.placeLines(this.cursor, byRow ? lines : [], byRow ? [] : lines);
        this.finish(this.cursor + 1, cell, gap);
        break;
      }
      case 'wall': {
        const count = d < 0.35 ? randInt(3, 4) : d < 0.7 ? randInt(2, 3) : randInt(1, 2);
        const open = this.holes(count);
        const cell = open[0];
        this.enter(cell);
        this.placeWall(this.cursor, without(open));
        this.finish(this.cursor + 1, cell, gap);
        break;
      }
      case 'chain': {
        const k = randInt(2, 3 + Math.round(d));
        const rowGap = Math.max(14, speed * lerp(0.9, 0.62, d));
        const style = Math.random() < 0.3 ? 'rock' : 'barrier';
        let open = this.holes(randInt(1, 2));
        this.enter(open[0]);
        for (let i = 0; i < k; i++) {
          this.placeWall(this.cursor, without(open), style);
          if (i === k - 1) break;
          const from = open[0];
          this.trailCell = from;
          open = this.holes(randInt(1, 2));
          if (open[0] === from) open[0] = pick(ALL.filter((c) => dist(c, from) === 1));
          this.coinTrail(this.cursor + 2, this.cursor + rowGap - 2, from, open[0], { force: true });
          this.cursor += rowGap;
        }
        this.finish(this.cursor + 1, open[0], gap);
        break;
      }
      case 'mover': {
        const axis = Math.random() < 0.5 ? 'y' : 'x';
        const pair = Math.random() < 0.5 ? [0, 1] : [1, 2];
        const freeLine = [0, 1, 2].find((l) => !pair.includes(l));
        const cell = this.chooseCell(axis === 'y' ? rowCells(freeLine) : colCells(freeLine));
        this.enter(cell);
        const built = this.buildMover(axis, pair, Math.random() < 0.45);
        this.addEntity(this.cursor, 1, built.g, built.colliders, { color: built.color, update: built.update });
        this.finish(this.cursor + 1, cell, gap);
        break;
      }
      case 'tunnel': {
        const cell = this.chooseCell(ALL);
        const len = Math.round(Math.max(24, speed * lerp(0.9, 1.5, d)));
        this.enter(cell);
        const built = this.buildTunnel(cell, len);
        this.addEntity(this.cursor, len, built.g, built.colliders, { color: built.color, smashable: false });
        this.coinTrail(this.cursor + 2, this.cursor + len - 1, cell, cell, { chance: 0.7 });
        this.finish(this.cursor + len, cell, gap);
        break;
      }
      case 'zigzag': {
        const k = randInt(3, 4);
        const secLen = Math.round(Math.max(12, speed * 0.42));
        const between = Math.max(13, speed * lerp(0.65, 0.5, d));
        let cell = this.chooseCell(ALL);
        this.enter(cell);
        for (let i = 0; i < k; i++) {
          const built = this.buildTunnel(cell, secLen);
          this.addEntity(this.cursor, secLen, built.g, built.colliders, { color: built.color, smashable: false });
          if (i === k - 1) break;
          const next = pick(ALL.filter((c) => dist(c, cell) === 1));
          const s = this.cursor + secLen;
          // Coins mark each turn of the passage.
          this.coinTrail(s + 1.5, s + between - 1.5, cell, next, { force: true });
          this.cursor = s + between;
          cell = next;
        }
        this.finish(this.cursor + secLen, cell, gap);
        break;
      }
      default: {
        // Breather: a sweeping line of coins.
        const len = Math.max(30, speed * 1.2);
        const cell = this.chooseCell(ALL);
        this.coinTrail(this.trailStart + 2.5, this.cursor + len, this.trailCell, cell, { force: true });
        this.trailStart = this.cursor + len;
        this.trailCell = cell;
        this.cursor += len + 8;
      }
    }
  }

  // ---------- per-frame ----------
  update(dt, t, dist, speed, game) {
    if (game.spawning) {
      while (this.cursor < dist + SPAWN_AHEAD) this.generate(speed);
    }
    const px = game.player.x;
    const py = game.player.y;
    const pz0 = dist - PLAYER_HALF_Z;
    const pz1 = dist + PLAYER_HALF_Z;

    // Obstacles
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      e.group.position.z = dist - e.absD;
      if (dist - (e.absD + e.len) > DESPAWN_BEHIND) {
        this.scene.remove(e.group);
        this.entities.splice(i, 1);
        continue;
      }
      // Hide things once they are behind the player so they don't block the camera.
      e.group.visible = !e.dead && dist - (e.absD + e.len) < 1.5;
      if (e.dead) continue;
      if (e.update) e.update(t);
      if (!game.alive) continue;
      if (e.absD - 3 > pz1 || e.absD + e.len + 3 < pz0) continue;
      for (const c of e.colliders) {
        if (e.absD + c.d1 < pz0 || e.absD + c.d0 > pz1) continue;
        if (c.y1 < py - PLAYER_HALF_Y || c.y0 > py + PLAYER_HALF_Y) continue;
        if (c.x1 < px - PLAYER_HALF_X || c.x0 > px + PLAYER_HALF_X) continue;
        game.onHit(e);
        break;
      }
    }

    // Coins
    const magnet = game.powers.magnet > 0;
    for (let i = this.coins.length - 1; i >= 0; i--) {
      const c = this.coins[i];
      let rel = c.absD - dist;
      if (magnet && game.alive && !c.pulled && rel < 16 && rel > -1) c.pulled = true;
      if (c.pulled) {
        const k = 1 - Math.exp(-dt * 9);
        c.absD -= rel * k;
        c.x += (px - c.x) * k;
        c.y += (py - c.y) * k;
        rel = c.absD - dist;
      }
      c.mesh.position.set(c.x, c.y + Math.sin(t * 3 + c.absD * 0.3) * 0.08, -rel);
      c.mesh.visible = rel > -1;
      c.mesh.rotation.y = t * 4 + c.absD * 0.2;
      if (game.alive && Math.abs(rel) < 0.85 && Math.abs(c.y - py) < 0.95 && Math.abs(c.x - px) < 0.95) {
        game.onCoin(c.mesh.position);
        this.releaseCoin(c);
        this.coins.splice(i, 1);
      } else if (rel < -DESPAWN_BEHIND) {
        this.releaseCoin(c);
        this.coins.splice(i, 1);
      }
    }

    // Power-ups
    for (let i = this.powers.length - 1; i >= 0; i--) {
      const p = this.powers[i];
      const rel = p.absD - dist;
      p.mesh.position.set(p.x, p.y + Math.sin(t * 2.5) * 0.15, -rel);
      p.mesh.visible = rel > -1;
      p.mesh.userData.holder.rotation.y = t * 2.5;
      const pulse = 1 + Math.sin(t * 6) * 0.06;
      p.mesh.scale.setScalar(pulse);
      if (game.alive && Math.abs(rel) < 1.1 && Math.abs(p.y - py) < 1.1 && Math.abs(p.x - px) < 1.1) {
        game.onPower(p.type, p.mesh.position, p.mesh.userData.color);
        this.scene.remove(p.mesh);
        this.powers.splice(i, 1);
      } else if (rel < -DESPAWN_BEHIND) {
        this.scene.remove(p.mesh);
        this.powers.splice(i, 1);
      }
    }
  }

  smash(e) {
    e.dead = true;
  }
}
