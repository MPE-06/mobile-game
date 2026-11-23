import * as THREE from '../vendor/three.module.min.js';
import { canvasTexture, glowTexture, rand, randInt, pick, clamp, smoothstep } from './utils.js';

// Sky palettes the run cycles through: day -> sunset -> neon night -> ...
const PALETTES = [
  { top: '#1f6fd6', mid: '#62b4f2', horizon: '#dff3ff', fog: '#b9def8', sun: '#fff3d1',
    hemiSky: '#cfe8ff', hemiGround: '#6b5a8a', light: '#fff4dc', windows: 0.35, stars: 0 },
  { top: '#2a1f6b', mid: '#8a4fc9', horizon: '#ffb07a', fog: '#e89aa6', sun: '#ffd18a',
    hemiSky: '#ffc9b8', hemiGround: '#4a2f6e', light: '#ffc58a', windows: 0.8, stars: 0.15 },
  { top: '#04031a', mid: '#1b1052', horizon: '#6b2a8f', fog: '#3b1d63', sun: '#b8c8ff',
    hemiSky: '#8d7cff', hemiGround: '#1d1240', light: '#a9b6ff', windows: 1.5, stars: 1 },
];
const PHASE_LEN = 1600; // distance per palette
const BLEND = 0.25; // fraction of a phase spent blending

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAG = /* glsl */ `
  uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 fog;
  uniform vec3 sunColor; uniform vec3 sunDir;
  varying vec3 vDir;
  void main() {
    float h = vDir.y;
    vec3 col = mix(horizon, mid, smoothstep(-0.02, 0.28, h));
    col = mix(col, top, smoothstep(0.25, 0.85, h));
    col = mix(col, fog, smoothstep(0.02, -0.12, h));
    float s = max(dot(normalize(vDir), sunDir), 0.0);
    col += sunColor * (pow(s, 600.0) * 2.0 + pow(s, 24.0) * 0.35 + pow(s, 4.0) * 0.08);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const SPAN = 340; // z-range covered by recycled scenery
const NEAR_Z = 24; // scenery past this z wraps to the back

function windowTexture(seed) {
  const palettes = [
    ['#ffe08a', '#fff4c8', '#ffb86b'],
    ['#7ff3ff', '#c4fbff', '#5ad1ff'],
    ['#ff9be8', '#ffd1f4', '#c48bff'],
  ];
  const cols = palettes[seed % palettes.length];
  return canvasTexture(128, 256, (g, w, h) => {
    g.fillStyle = '#1a1c33';
    g.fillRect(0, 0, w, h);
    const cw = w / 4;
    const ch = h / 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 4; x++) {
        const lit = Math.random() < 0.55;
        g.fillStyle = lit ? pick(cols) : '#262a47';
        g.fillRect(x * cw + 6, y * ch + 7, cw - 12, ch - 13);
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.06)';
    for (let x = 0; x < 4; x++) g.fillRect(x * cw, 0, 2, h);
  }, { repeat: true });
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.colors = {
      top: new THREE.Color(), mid: new THREE.Color(), horizon: new THREE.Color(), fog: new THREE.Color(),
      sun: new THREE.Color(), hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), light: new THREE.Color(),
    };
    this.paletteCols = PALETTES.map((p) => {
      const o = {};
      for (const k of Object.keys(this.colors)) o[k] = new THREE.Color(p[k]);
      o.windows = p.windows;
      o.stars = p.stars;
      return o;
    });

    // Sky dome
    this.skyU = {
      top: { value: new THREE.Color() }, mid: { value: new THREE.Color() },
      horizon: { value: new THREE.Color() }, fog: { value: new THREE.Color() },
      sunColor: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0.35, 0.12, -1).normalize() },
    };
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(450, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
        side: THREE.BackSide, depthWrite: false, fog: false,
      }),
    );
    this.sky.renderOrder = -10;
    scene.add(this.sky);

    scene.fog = new THREE.Fog(0xffffff, 45, 240);

    // Stars (visible at night)
    const starGeo = new THREE.BufferGeometry();
    const sp = [];
    for (let i = 0; i < 400; i++) {
      const v = new THREE.Vector3(rand(-1, 1), rand(0.05, 1), rand(-1, 0.3)).normalize().multiplyScalar(420);
      sp.push(v.x, v.y, v.z);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false,
    }));
    scene.add(this.stars);

    // Lights
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 1.6);
    scene.add(this.hemi);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 2.0);
    this.sunLight.position.set(6, 12, 4);
    scene.add(this.sunLight);

    this.buildScenery();
    this.buildSpeedLines();
    this.setDistance(0, true);
  }

  buildScenery() {
    const scene = this.scene;
    this.recyclers = [];

    // --- Futuristic towers on both sides ---
    this.windowMats = [0, 1, 2].map((i) => {
      const tex = windowTexture(i);
      return new THREE.MeshStandardMaterial({
        color: [0x9fb0ff, 0xb6fff7, 0xffc0f0][i], map: tex, emissiveMap: tex, emissive: 0xffffff,
        emissiveIntensity: 0.5, roughness: 0.6, metalness: 0.2,
      });
    });
    this.neonMats = [0x49f2ff, 0xff3fa4, 0xffd23f, 0x9b5bff].map((c) => new THREE.MeshBasicMaterial({ color: c }));
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x2d3150, roughness: 0.7 });
    const redLight = new THREE.MeshBasicMaterial({ color: 0xff3355 });
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const antennaGeo = new THREE.CylinderGeometry(0.06, 0.1, 1, 6);
    const blinkGeo = new THREE.SphereGeometry(0.22, 8, 6);
    this.blinkers = [];

    const perSide = 22;
    for (const side of [-1, 1]) {
      for (let i = 0; i < perSide; i++) {
        const w = rand(3, 6.5);
        const d = rand(3.5, 8);
        const h = 90;
        const geo = new THREE.BoxGeometry(w, h, d);
        // Scale UVs so windows stay the same size regardless of tower size.
        const uv = geo.attributes.uv;
        for (let f = 0; f < 6; f++) {
          const fw = f < 2 ? d : w;
          for (let v = 0; v < 4; v++) {
            const idx = f * 4 + v;
            uv.setXY(idx, uv.getX(idx) * fw / 4, uv.getY(idx) * h / 8);
          }
        }
        const g = new THREE.Group();
        const tower = new THREE.Mesh(geo, pick(this.windowMats));
        tower.position.y = -h / 2;
        g.add(tower);
        const roof = new THREE.Mesh(unit, roofMat);
        roof.scale.set(w * 0.8, 0.6, d * 0.8);
        roof.position.y = 0.3;
        g.add(roof);
        const neon = new THREE.Mesh(unit, pick(this.neonMats));
        neon.scale.set(w + 0.12, 0.18, d + 0.12);
        neon.position.y = -0.6;
        g.add(neon);
        const neon2 = new THREE.Mesh(unit, neon.material);
        neon2.scale.set(w + 0.12, 0.12, d + 0.12);
        neon2.position.y = -rand(6, 14);
        g.add(neon2);
        if (Math.random() < 0.45) {
          const ah = rand(2, 5);
          const ant = new THREE.Mesh(antennaGeo, roofMat);
          ant.scale.y = ah;
          ant.position.y = ah / 2 + 0.6;
          g.add(ant);
          const bl = new THREE.Mesh(blinkGeo, redLight.clone());
          bl.position.y = ah + 0.7;
          g.add(bl);
          this.blinkers.push({ mesh: bl, phase: rand(0, 6) });
        }
        g.userData = { w, side, tower };
        this.placeTower(g, -i * (SPAN / perSide) - rand(0, 6) + NEAR_Z - 10);
        scene.add(g);
        this.recyclers.push({ obj: g, place: (o, z) => this.placeTower(o, z) });
      }
    }

    // --- Floating islands & hover pads (decor) ---
    const grass = new THREE.MeshStandardMaterial({ color: 0x5ccf5a, roughness: 0.9, flatShading: true });
    const rock = new THREE.MeshStandardMaterial({ color: 0x8a6650, roughness: 1, flatShading: true });
    const leaf = new THREE.MeshStandardMaterial({ color: 0x2fae5f, roughness: 0.8, flatShading: true });
    const trunk = new THREE.MeshStandardMaterial({ color: 0x6b4a33 });
    const crystal = new THREE.MeshStandardMaterial({
      color: 0xff7ae6, emissive: 0xc02aa8, emissiveIntensity: 0.8, flatShading: true, roughness: 0.2,
    });
    const padMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ff, roughness: 0.3, metalness: 0.6 });
    const padGlow = new THREE.MeshBasicMaterial({ color: 0x49f2ff });

    for (let i = 0; i < 14; i++) {
      const g = new THREE.Group();
      if (i % 3 !== 2) {
        const r = rand(1.6, 3.4);
        const top = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.92, 0.55, 8), grass);
        g.add(top);
        const under = new THREE.Mesh(new THREE.ConeGeometry(r * 0.95, r * 1.8, 7), rock);
        under.rotation.x = Math.PI;
        under.position.y = -r * 0.9 - 0.27;
        g.add(under);
        const trees = randInt(1, 3);
        for (let t = 0; t < trees; t++) {
          const tr = new THREE.Group();
          const tk = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.6, 6), trunk);
          tk.position.y = 0.3;
          const lf = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 7), leaf);
          lf.position.y = 1.05;
          tr.add(tk, lf);
          tr.position.set(rand(-r, r) * 0.55, 0.27, rand(-r, r) * 0.55);
          tr.scale.setScalar(rand(0.8, 1.4));
          g.add(tr);
        }
        if (Math.random() < 0.5) {
          const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.45, 0), crystal);
          c.scale.y = 1.8;
          c.position.set(rand(-r, r) * 0.4, 0.9, rand(-r, r) * 0.4);
          g.add(c);
        }
      } else {
        const r = rand(1.8, 2.8);
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.7, 0.5, 6), padMat);
        g.add(pad);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.75, 0.07, 6, 6), padGlow);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.27;
        g.add(ring);
        const glowUnder = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.35, r * 0.2, 0.2, 6), padGlow);
        glowUnder.position.y = -0.33;
        g.add(glowUnder);
      }
      g.userData.bob = rand(0, 6);
      g.userData.spin = rand(-0.2, 0.2);
      this.placeIsland(g, -rand(0, SPAN) + NEAR_Z - 20);
      scene.add(g);
      this.recyclers.push({ obj: g, place: (o, z) => this.placeIsland(o, z) });
    }

    // --- Clouds ---
    const cloudTex = canvasTexture(128, 128, (g, w) => {
      for (let i = 0; i < 7; i++) {
        const x = w * (0.25 + Math.random() * 0.5);
        const y = w * (0.4 + Math.random() * 0.25);
        const r = w * (0.15 + Math.random() * 0.15);
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, 'rgba(255,255,255,0.9)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, w, w);
      }
    });
    this.cloudMat = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.75, depthWrite: false });
    for (let i = 0; i < 16; i++) {
      const s = new THREE.Sprite(this.cloudMat);
      this.placeCloud(s, -rand(0, SPAN) + NEAR_Z - 20);
      scene.add(s);
      this.recyclers.push({ obj: s, place: (o, z) => this.placeCloud(o, z) });
    }

    // --- Hover traffic in the side sky-lanes ---
    this.traffic = [];
    const carBody = [0xffffff, 0xffd23f, 0x49f2ff, 0xff5c8a].map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.3, metalness: 0.5 }),
    );
    const head = new THREE.MeshBasicMaterial({ color: 0xfff6c0 });
    const tail = new THREE.MeshBasicMaterial({ color: 0xff2244 });
    const carGeo = new THREE.CapsuleGeometry(0.45, 1.4, 4, 10);
    carGeo.rotateX(Math.PI / 2);
    const lightGeo = new THREE.SphereGeometry(0.16, 8, 6);
    for (let i = 0; i < 8; i++) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(carGeo, pick(carBody)));
      const oncoming = i % 2 === 0;
      for (const s of [-1, 1]) {
        const l = new THREE.Mesh(lightGeo, oncoming ? head : tail);
        l.position.set(0.25 * s, 0, oncoming ? -1.1 : 1.1);
        g.add(l);
      }
      g.userData.rel = oncoming ? rand(12, 25) : -rand(4, 10);
      this.placeCar(g, -rand(0, SPAN) + NEAR_Z - 20);
      scene.add(g);
      this.traffic.push(g);
    }
  }

  placeTower(g, z) {
    const { w, side } = g.userData;
    g.position.set(side * (6.8 + w / 2 + rand(0, 9)), rand(-14, 13), z);
    g.userData.tower.material = pick(this.windowMats);
  }

  placeIsland(g, z) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const center = Math.random() < 0.18;
    if (center) g.position.set(rand(-3, 3), rand(-16, -11), z);
    else g.position.set(side * rand(5.5, 15), rand(-9, 9), z);
    g.userData.baseY = g.position.y;
  }

  placeCloud(s, z) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const below = Math.random() < 0.4;
    s.position.set(below ? rand(-14, 14) : side * rand(9, 30), below ? rand(-22, -12) : rand(-6, 18), z);
    const sc = rand(10, 24);
    s.scale.set(sc, sc * 0.55, 1);
  }

  placeCar(g, z) {
    const side = Math.random() < 0.5 ? -1 : 1;
    g.position.set(side * rand(4.5, 6.5), rand(-6, 7), z);
  }

  buildSpeedLines() {
    const n = 70;
    this.lineCount = n;
    this.lines = [];
    const pos = new Float32Array(n * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.speedMat = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    this.speedLines = new THREE.LineSegments(geo, this.speedMat);
    this.speedLines.frustumCulled = false;
    this.scene.add(this.speedLines);
    for (let i = 0; i < n; i++) {
      const l = { x: 0, y: 0, z: 0 };
      this.resetLine(l, rand(-70, 10));
      this.lines.push(l);
    }
  }

  resetLine(l, z) {
    const a = rand(0, Math.PI * 2);
    const r = rand(2.2, 9);
    l.x = Math.cos(a) * r * 0.8;
    l.y = Math.sin(a) * r;
    l.z = z;
  }

  // Blend the sky / fog / light colours based on distance travelled.
  setDistance(dist, force = false) {
    const phase = dist / PHASE_LEN;
    const i = Math.floor(phase);
    const f = phase - i;
    const a = this.paletteCols[i % PALETTES.length];
    const b = this.paletteCols[(i + 1) % PALETTES.length];
    const t = smoothstep(1 - BLEND, 1, f);
    if (!force && t === this.lastBlend && i === this.lastPhase) return;
    this.lastBlend = t;
    this.lastPhase = i;
    for (const k of Object.keys(this.colors)) this.colors[k].copy(a[k]).lerp(b[k], t);
    const c = this.colors;
    this.skyU.top.value.copy(c.top);
    this.skyU.mid.value.copy(c.mid);
    this.skyU.horizon.value.copy(c.horizon);
    this.skyU.fog.value.copy(c.fog);
    this.skyU.sunColor.value.copy(c.sun);
    this.scene.fog.color.copy(c.fog);
    this.hemi.color.copy(c.hemiSky);
    this.hemi.groundColor.copy(c.hemiGround);
    this.sunLight.color.copy(c.light);
    const win = a.windows + (b.windows - a.windows) * t;
    for (const m of this.windowMats) m.emissiveIntensity = win;
    this.stars.material.opacity = a.stars + (b.stars - a.stars) * t;
    this.night = this.stars.material.opacity;
    this.cloudMat.color.copy(c.horizon).lerp(new THREE.Color(0xffffff), 0.5);
  }

  update(dt, t, speed, camera, boost) {
    const dz = speed * dt;
    for (const r of this.recyclers) {
      r.obj.position.z += dz;
      if (r.obj.position.z > NEAR_Z) r.place(r.obj, r.obj.position.z - SPAN);
      const ud = r.obj.userData;
      if (ud.baseY !== undefined) {
        r.obj.position.y = ud.baseY + Math.sin(t * 0.8 + ud.bob) * 0.4;
        r.obj.rotation.y += ud.spin * dt;
      }
    }
    for (const car of this.traffic) {
      car.position.z += dz + car.userData.rel * dt * (speed > 1 ? 1 : 0.3);
      if (car.position.z > NEAR_Z) this.placeCar(car, car.position.z - SPAN);
      if (car.position.z < NEAR_Z - SPAN - 20) this.placeCar(car, NEAR_Z - 5);
    }
    for (const b of this.blinkers) {
      b.mesh.visible = Math.sin(t * 3 + b.phase) > 0.2;
    }

    this.sky.position.copy(camera.position);
    this.stars.position.copy(camera.position);

    // Speed streaks around the camera.
    const pos = this.speedLines.geometry.attributes.position.array;
    const len = clamp(speed * 0.07, 0.4, 8) * (boost ? 1.8 : 1);
    const streakSpeed = speed * 1.6;
    for (let i = 0; i < this.lineCount; i++) {
      const l = this.lines[i];
      l.z += streakSpeed * dt;
      if (l.z > 9) this.resetLine(l, rand(-75, -50));
      const o = i * 6;
      pos[o] = l.x; pos[o + 1] = l.y + camera.position.y * 0.6; pos[o + 2] = l.z;
      pos[o + 3] = l.x; pos[o + 4] = l.y + camera.position.y * 0.6; pos[o + 5] = l.z - len;
    }
    this.speedLines.geometry.attributes.position.needsUpdate = true;
    const target = clamp((speed - 18) / 40, 0.05, 0.45) + (boost ? 0.35 : 0);
    this.speedMat.opacity += (target - this.speedMat.opacity) * Math.min(1, dt * 4);
  }
}
