import * as THREE from '../vendor/three.module.min.js';
import {
  LANES, BAND, PLAYER_HALF_Y, PLAYER_HALF_Z, SPAWN_AHEAD, DESPAWN_BEHIND, difficultyAt,
} from './config.js';
import { canvasTexture, rand, randInt, pick, lerp, smoothstep, weightedPick } from './utils.js';

const TOP = LANES[0] + BAND; // top edge of the playfield's obstacles
const BOTTOM = LANES[2] - BAND;
const WIDTH = 5.6; // obstacles span the whole view horizontally
const TUNNEL_GAP = 1.15; // half-height of a tunnel's open corridor

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
    this.trailLane = 1;
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

  addCoin(absD, y) {
    const mesh = this.acquireCoin();
    mesh.position.set(0, y, -1e4);
    this.coins.push({ absD, y, mesh, pulled: false });
  }

  addPower(absD, lane, type) {
    const mesh = this.makePowerMesh(type);
    mesh.position.set(0, LANES[lane], -1e4);
    this.scene.add(mesh);
    this.powers.push({ absD, y: LANES[lane], mesh, type });
  }

  // Coins that guide the player from one lane to the next.
  coinTrail(a, b, la, lb, { force = false, spacing = 3 } = {}) {
    if (b - a < 5) return;
    const wantPower = a + (b - a) / 2 > this.nextPowerD && b - a > 14;
    if (!force && !wantPower && Math.random() > 0.7) return;
    const n = Math.floor((b - a) / spacing);
    const ya = LANES[la];
    const yb = LANES[lb];
    const powerAt = wantPower ? Math.floor(n * 0.65) : -1;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const d = a + (b - a) * f;
      const y = lerp(ya, yb, smoothstep(0.05, 0.5, f));
      if (i === powerAt) {
        const types = [['shield', 0.4], ['magnet', 0.35], ['boost', 0.25]];
        if (Math.abs(y - yb) < 0.01) {
          this.addPower(d, lb, weightedPick(types));
          this.nextPowerD = d + rand(520, 900);
          continue;
        }
      }
      this.addCoin(d, y);
    }
  }

  // ---------- obstacle builders ----------
  // Group blocked lanes into contiguous spans: [0,1] -> [[0,1]], [0,2] -> [[0],[2]].
  spans(blocked) {
    const s = [...blocked].sort();
    const out = [];
    for (const l of s) {
      const last = out[out.length - 1];
      if (last && last[last.length - 1] === l - 1) last.push(l);
      else out.push([l]);
    }
    return out;
  }

  spanRange(span) {
    return [LANES[span[span.length - 1]] - BAND, LANES[span[0]] + BAND]; // [y0, y1]
  }

  buildBarrier(blocked) {
    const g = new THREE.Group();
    const colliders = [];
    for (const span of this.spans(blocked)) {
      const [y0, y1] = this.spanRange(span);
      const h = y1 - y0;
      const cy = (y0 + y1) / 2;
      const panel = this.box(g, this.a.hazard, WIDTH, h, 0.5, 0, cy, 0);
      panel.material = this.a.hazard;
      this.box(g, this.a.cyan, WIDTH + 0.2, 0.14, 0.6, 0, y1, 0);
      this.box(g, this.a.cyan, WIDTH + 0.2, 0.14, 0.6, 0, y0, 0);
      this.box(g, this.a.pink, 0.16, h, 0.62, -WIDTH / 2, cy, 0);
      this.box(g, this.a.pink, 0.16, h, 0.62, WIDTH / 2, cy, 0);
      colliders.push({ y0, y1, d0: -0.3, d1: 0.3 });
    }
    return { g, colliders, color: 0xff2d95 };
  }

  buildLaser(blocked) {
    const g = new THREE.Group();
    const colliders = [];
    const ph = TOP - BOTTOM + 1.2;
    for (const s of [-1, 1]) {
      this.box(g, this.a.metal, 0.45, ph, 0.45, (WIDTH / 2 + 0.25) * s, 0, 0);
      this.box(g, this.a.red, 0.1, ph, 0.47, (WIDTH / 2 + 0.25) * s - 0.18 * s, 0, 0);
    }
    const coreGeo = this.geo('laserCore', () => new THREE.CylinderGeometry(0.05, 0.05, WIDTH + 0.4, 6).rotateZ(Math.PI / 2));
    const glowGeo = this.geo('laserGlow', () => new THREE.CylinderGeometry(0.12, 0.12, WIDTH + 0.4, 8).rotateZ(Math.PI / 2));
    const beams = [];
    for (const l of blocked) {
      for (const off of [-0.72, 0, 0.72]) {
        const core = new THREE.Mesh(coreGeo, this.a.laserCore);
        const glow = new THREE.Mesh(glowGeo, this.a.laserGlow);
        core.position.y = glow.position.y = LANES[l] + off;
        g.add(core, glow);
        beams.push(glow);
      }
      // Emitter nodes on the pylons
      for (const s of [-1, 1]) this.box(g, this.a.red, 0.55, 0.3, 0.55, (WIDTH / 2 + 0.25) * s, LANES[l], 0);
      colliders.push({ y0: LANES[l] - BAND + 0.15, y1: LANES[l] + BAND - 0.15, d0: -0.25, d1: 0.25 });
    }
    const update = (t) => {
      const k = 1 + Math.sin(t * 30) * 0.15;
      for (const b of beams) b.scale.set(1, k, k);
    };
    return { g, colliders, color: 0xff2a4a, update };
  }

  buildRock(blocked) {
    const g = new THREE.Group();
    const colliders = [];
    const rockGeo = this.geo('rock', () => new THREE.DodecahedronGeometry(1, 0));
    const capGeo = this.geo('cap', () => new THREE.CylinderGeometry(1, 0.9, 0.3, 8));
    for (const l of blocked) {
      const y = LANES[l];
      const r = new THREE.Mesh(rockGeo, this.a.rock);
      r.scale.set(WIDTH / 2, 0.95, 1.4);
      r.rotation.y = rand(0, Math.PI);
      r.position.y = y - 0.12;
      g.add(r);
      const cap = new THREE.Mesh(capGeo, this.a.grass);
      cap.scale.set(WIDTH / 2 - 0.25, 1, 1.25);
      cap.position.y = y + 0.72;
      g.add(cap);
      for (let i = 0; i < 4; i++) this.box(g, this.a.flower, 0.12, 0.12, 0.12, rand(-2, 2), y + 0.92, rand(-0.8, 0.8));
      colliders.push({ y0: y - BAND + 0.1, y1: y + BAND - 0.15, d0: -1.2, d1: 1.2 });
    }
    return { g, colliders, color: 0x8a6650, update: (t) => (g.rotation.z = Math.sin(t * 1.1) * 0.03) };
  }

  // A bar (or spiky drone) that slides between two adjacent lanes.
  buildMover(pair, drone) {
    const g = new THREE.Group();
    const yTop = LANES[pair[0]];
    const yBot = LANES[pair[1]];
    const mid = (yTop + yBot) / 2;
    const amp = (yTop - yBot) / 2;
    // Rails that telegraph the travel range.
    for (const s of [-1, 1]) {
      this.box(g, this.a.metal, 0.3, yTop - yBot + 2.4, 0.3, (WIDTH / 2 + 0.2) * s, mid, 0);
      this.box(g, this.a.amber, 0.08, yTop - yBot + 2.2, 0.32, (WIDTH / 2 + 0.2) * s - 0.12 * s, mid, 0);
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
      this.box(mover, this.a.metal, WIDTH, 0.14, 0.14, 0, 0, 0);
    } else {
      half = 0.75;
      this.box(mover, this.a.yellow, WIDTH, 1.5, 0.7, 0, 0, 0);
      for (const s of [-1, 1]) lights.push(this.box(mover, this.a.red, 0.3, 0.3, 0.75, (WIDTH / 2 - 0.4) * s, 0, 0));
    }
    const omega = rand(2.6, 3.4);
    const phase = rand(0, Math.PI * 2);
    const col = { y0: 0, y1: 0, d0: -0.5, d1: 0.5 };
    const update = (t) => {
      const y = mid + amp * Math.sin(t * omega + phase);
      mover.position.y = y;
      col.y0 = y - half;
      col.y1 = y + half;
      if (drone) mover.rotation.set(t * 2, t * 3, 0);
      for (const l of lights) l.visible = Math.sin(t * 14) > 0;
    };
    update(0);
    return { g, colliders: [col], color: drone ? 0xff2a4a : 0xffcc1f, update, range: [yBot - half, yTop + half] };
  }

  // Enclosed tunnel where only one lane is open.
  buildTunnel(open, len) {
    const g = new THREE.Group();
    const colliders = [];
    const a = this.a;
    const oy = LANES[open];
    const roof = TOP + 0.4;
    const floor = BOTTOM - 0.4;
    const fills = [];
    if (oy + TUNNEL_GAP < roof) fills.push([oy + TUNNEL_GAP, roof]);
    if (oy - TUNNEL_GAP > floor) fills.push([floor, oy - TUNNEL_GAP]);
    for (const [y0, y1] of fills) {
      const h = y1 - y0;
      const m = new THREE.Mesh(this.geo(`slab${h.toFixed(2)}|${len.toFixed(1)}`, () => {
        const geo = new THREE.BoxGeometry(WIDTH, h, len);
        const uv = geo.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.max(1, Math.round(len / 4)), uv.getY(i));
        return geo;
      }), a.panel);
      m.position.set(0, (y0 + y1) / 2, -len / 2);
      g.add(m);
      // Chevron warning on the entrance face
      const face = new THREE.Mesh(this.geo(`face${h.toFixed(2)}`, () => new THREE.PlaneGeometry(WIDTH, h)), a.chevron);
      face.position.set(0, (y0 + y1) / 2, 0.02);
      g.add(face);
      colliders.push({ y0, y1, d0: 0, d1: len });
    }
    // Roof & floor plates (always present so it reads as a tunnel)
    this.box(g, a.metal, WIDTH + 0.6, 0.35, len, 0, roof + 0.17, -len / 2);
    this.box(g, a.metal, WIDTH + 0.6, 0.35, len, 0, floor - 0.17, -len / 2);
    // Glass side walls
    for (const s of [-1, 1]) {
      const wall = new THREE.Mesh(this.geo(`glass${len.toFixed(1)}`, () => new THREE.PlaneGeometry(len, roof - floor)), a.glass);
      wall.rotation.y = Math.PI / 2;
      wall.position.set((WIDTH / 2 + 0.25) * s, (roof + floor) / 2, -len / 2);
      g.add(wall);
      // Guide lights along the open corridor
      this.box(g, a.cyan, 0.08, 0.08, len, (WIDTH / 2) * s, oy + TUNNEL_GAP - 0.05, -len / 2);
      this.box(g, a.cyan, 0.08, 0.08, len, (WIDTH / 2) * s, oy - TUNNEL_GAP + 0.05, -len / 2);
    }
    // Glowing ribs
    const ribGeo = this.geo('rib', () => new THREE.RingGeometry(0.93, 1, 4, 1).rotateZ(Math.PI / 4));
    const ribs = [];
    for (let z = 0; z <= len; z += 5) {
      const rib = new THREE.Mesh(ribGeo, a.ribGlow);
      rib.scale.set((WIDTH + 0.8) / 1.41, (roof - floor + 0.8) / 1.41, 1);
      rib.position.set(0, (roof + floor) / 2, -z);
      g.add(rib);
      ribs.push(rib);
    }
    return { g, colliders, color: 0x49f2ff, smashable: false };
  }

  // ---------- pattern generation ----------
  placeRow(absD, blocked, style) {
    const s = style || this.rowStyle(blocked);
    const built = s === 'laser' ? this.buildLaser(blocked) : s === 'rock' ? this.buildRock(blocked) : this.buildBarrier(blocked);
    this.addEntity(absD, 1.2, built.g, built.colliders, { color: built.color, update: built.update });
  }

  rowStyle(blocked) {
    if (blocked.length === 1 && Math.random() < 0.3) return 'rock';
    return Math.random() < 0.45 ? 'laser' : 'barrier';
  }

  // Pick a free lane, sometimes staying put but usually making the player move.
  chooseLane(free) {
    const stay = free.includes(this.trailLane) && Math.random() < 0.35;
    if (stay) return this.trailLane;
    const others = free.filter((l) => l !== this.trailLane);
    return others.length ? pick(others) : this.trailLane;
  }

  enter(lane) {
    this.coinTrail(this.trailStart + 2.5, this.cursor - 2.5, this.trailLane, lane);
  }

  finish(endD, lane, gapDist) {
    this.trailStart = endD;
    this.trailLane = lane;
    this.cursor = endD + gapDist;
  }

  generate(speed) {
    const d = difficultyAt(this.cursor);
    const n = this.count++;
    let type;
    if (n < 3) type = 'single';
    else {
      type = weightedPick([
        ['single', Math.max(0.3, 1 - 0.8 * d)],
        ['double', 0.35 + 0.8 * d],
        ['mover', n > 4 ? 0.25 + 0.45 * d : 0],
        ['tunnel', n > 5 ? 0.22 + 0.25 * d : 0],
        ['chain', d > 0.2 ? 0.6 * d : 0],
        ['zigzag', d > 0.35 ? 0.45 * d : 0],
        ['rest', this.lastType === 'rest' ? 0 : 0.12],
      ]);
    }
    this.lastType = type;
    const gapT = lerp(1.25, 0.62, d) + rand(0, 0.3);
    const gap = Math.max(14, speed * gapT);
    const all = [0, 1, 2];

    switch (type) {
      case 'single': {
        const blocked = randInt(0, 2);
        const lane = this.chooseLane(all.filter((l) => l !== blocked));
        this.enter(lane);
        this.placeRow(this.cursor, [blocked]);
        this.finish(this.cursor + 1, lane, gap);
        break;
      }
      case 'double': {
        const lane = this.chooseLane(all);
        this.enter(lane);
        this.placeRow(this.cursor, all.filter((l) => l !== lane));
        this.finish(this.cursor + 1, lane, gap);
        break;
      }
      case 'chain': {
        const k = randInt(2, 3 + Math.round(d));
        const rowGap = Math.max(13, speed * lerp(0.9, 0.58, d));
        const style = Math.random() < 0.5 ? 'laser' : 'barrier';
        let lane = this.chooseLane(all);
        this.enter(lane);
        for (let i = 0; i < k; i++) {
          this.placeRow(this.cursor, all.filter((l) => l !== lane), style);
          if (i === k - 1) break;
          const next = pick(all.filter((l) => l !== lane));
          this.coinTrail(this.cursor + 2, this.cursor + rowGap - 2, lane, next, { force: true });
          this.cursor += rowGap;
          lane = next;
        }
        this.finish(this.cursor + 1, lane, gap);
        break;
      }
      case 'mover': {
        const pair = Math.random() < 0.5 ? [0, 1] : [1, 2];
        const lane = all.find((l) => !pair.includes(l));
        this.enter(lane);
        const built = this.buildMover(pair, Math.random() < 0.45);
        this.addEntity(this.cursor, 1, built.g, built.colliders, { color: built.color, update: built.update, range: built.range });
        this.finish(this.cursor + 1, lane, gap);
        break;
      }
      case 'tunnel': {
        const lane = this.chooseLane(all);
        const len = Math.round(Math.max(24, speed * lerp(0.9, 1.5, d)));
        this.enter(lane);
        const built = this.buildTunnel(lane, len);
        this.addEntity(this.cursor, len, built.g, built.colliders, { color: built.color, smashable: false });
        this.coinTrail(this.cursor + 2, this.cursor + len - 1, lane, lane, { force: true, spacing: 2.6 });
        this.finish(this.cursor + len, lane, gap);
        break;
      }
      case 'zigzag': {
        const k = randInt(3, 4);
        const secLen = Math.round(Math.max(12, speed * 0.42));
        const between = Math.max(13, speed * lerp(0.6, 0.45, d));
        let lane = this.chooseLane(all);
        this.enter(lane);
        for (let i = 0; i < k; i++) {
          const built = this.buildTunnel(lane, secLen);
          this.addEntity(this.cursor, secLen, built.g, built.colliders, { color: built.color, smashable: false });
          this.coinTrail(this.cursor + 1.5, this.cursor + secLen - 1, lane, lane, { force: true, spacing: 2.6 });
          if (i === k - 1) break;
          const next = lane === 1 ? pick([0, 2]) : 1;
          const s = this.cursor + secLen;
          this.coinTrail(s + 1.5, s + between - 1.5, lane, next, { force: true, spacing: 2.6 });
          this.cursor = s + between;
          lane = next;
        }
        this.finish(this.cursor + secLen, lane, gap);
        break;
      }
      default: {
        // Breather: a wavy line of coins.
        const len = Math.max(30, speed * 1.2);
        const lane = pick(all.filter((l) => l !== this.trailLane));
        this.coinTrail(this.trailStart + 2.5, this.cursor + len, this.trailLane, lane, { force: true });
        this.trailStart = this.cursor + len;
        this.trailLane = lane;
        this.cursor += len + 8;
      }
    }
  }

  // ---------- per-frame ----------
  update(dt, t, dist, speed, game) {
    if (game.spawning) {
      while (this.cursor < dist + SPAWN_AHEAD) this.generate(speed);
    }
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
        c.y += (py - c.y) * k;
        rel = c.absD - dist;
      }
      c.mesh.position.set(0, c.y + Math.sin(t * 3 + c.absD * 0.3) * 0.08, -rel);
      c.mesh.visible = rel > -1;
      c.mesh.rotation.y = t * 4 + c.absD * 0.2;
      if (game.alive && Math.abs(rel) < 0.85 && Math.abs(c.y - py) < 0.95) {
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
      p.mesh.position.set(0, p.y + Math.sin(t * 2.5) * 0.15, -rel);
      p.mesh.visible = rel > -1;
      p.mesh.userData.holder.rotation.y = t * 2.5;
      const pulse = 1 + Math.sin(t * 6) * 0.06;
      p.mesh.scale.setScalar(pulse);
      if (game.alive && Math.abs(rel) < 1.1 && Math.abs(p.y - py) < 1.1) {
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
