import * as THREE from '../vendor/three.module.min.js';
import { LANES } from './config.js';
import { clamp, damp } from './utils.js';

const FRESNEL_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const FRESNEL_FRAG = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  uniform float time;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float f = pow(1.0 - abs(dot(vN, vV)), 2.2);
    float bands = 0.5 + 0.5 * sin(vN.y * 18.0 + time * 5.0);
    float a = (f * 0.95 + 0.06 + bands * 0.05) * opacity;
    gl_FragColor = vec4(color * (f * 1.3 + 0.05), a);
  }
`;

// "Zip" — a little jetpack pilot in an orange flight suit.
export class Player {
  constructor(scene) {
    this.root = new THREE.Group();
    scene.add(this.root);
    this.body = new THREE.Group();
    this.root.add(this.body);

    const suit = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.55 });
    const suitDark = new THREE.MeshStandardMaterial({ color: 0xd9480f, roughness: 0.6 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf4f6ff, roughness: 0.3, metalness: 0.1 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f45, roughness: 0.5, metalness: 0.4 });
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0x29e6ff, emissive: 0x13a3d6, emissiveIntensity: 1.0, roughness: 0.1, metalness: 0.3,
    });
    const wingMat = new THREE.MeshStandardMaterial({
      color: 0x2ad1c9, roughness: 0.35, metalness: 0.25, emissive: 0x0b5f5a, emissiveIntensity: 0.6,
    });
    const glowCyan = new THREE.MeshBasicMaterial({ color: 0x6ff7ff });
    const glowOrange = new THREE.MeshBasicMaterial({ color: 0xffb347 });

    const b = this.body;
    const add = (parent, geo, mat, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };

    // Torso + belt
    add(b, new THREE.CapsuleGeometry(0.3, 0.55, 6, 16), suit);
    add(b, new THREE.CylinderGeometry(0.315, 0.315, 0.1, 18), dark, 0, -0.22, 0);
    add(b, new THREE.BoxGeometry(0.12, 0.08, 0.05), glowCyan, 0, -0.22, -0.31);

    // Head / helmet
    const head = new THREE.Group();
    head.position.y = 0.7;
    b.add(head);
    this.head = head;
    add(head, new THREE.SphereGeometry(0.29, 22, 16), white);
    const visor = add(
      head,
      new THREE.SphereGeometry(0.297, 22, 12, Math.PI * 1.5 - 0.95, 1.9, Math.PI / 2 - 0.5, 0.85),
      visorMat,
    );
    visor.position.y = 0.02;
    const fin = add(head, new THREE.BoxGeometry(0.06, 0.12, 0.42), suit, 0, 0.27, 0.02);
    fin.rotation.x = 0.1;
    add(head, new THREE.SphereGeometry(0.05, 10, 8), glowOrange, 0, 0.18, 0.25);

    // Arms reaching forward in a "V" (superhero pose)
    this.arms = [];
    for (const s of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(0.3 * s, 0.38, -0.02);
      arm.rotation.z = -0.38 * s;
      b.add(arm);
      add(arm, new THREE.CapsuleGeometry(0.09, 0.42, 4, 10), suit, 0, 0.27, 0);
      add(arm, new THREE.SphereGeometry(0.11, 12, 10), white, 0, 0.56, 0);
      this.arms.push(arm);
    }

    // Legs (pivot at the hip so they can kick)
    this.legs = [];
    for (const s of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(0.14 * s, -0.38, 0);
      b.add(leg);
      add(leg, new THREE.CapsuleGeometry(0.11, 0.42, 4, 10), suitDark, 0, -0.3, 0);
      const boot = add(leg, new THREE.CapsuleGeometry(0.12, 0.14, 4, 10), white, 0, -0.62, 0.03);
      boot.rotation.x = 0.4;
      this.legs.push(leg);
    }

    // Jetpack on the back (+z in body space faces the camera)
    const pack = new THREE.Group();
    pack.position.set(0, 0.06, 0.33);
    b.add(pack);
    add(pack, new THREE.BoxGeometry(0.54, 0.64, 0.26), white);
    add(pack, new THREE.BoxGeometry(0.08, 0.5, 0.02), glowCyan, 0, 0, 0.135);
    add(pack, new THREE.BoxGeometry(0.4, 0.06, 0.28), dark, 0, 0.28, 0);

    // Wings with glowing tips
    this.wings = [];
    for (const s of [-1, 1]) {
      const wing = new THREE.Group();
      wing.position.set(0.26 * s, 0.12, 0.02);
      pack.add(wing);
      const w = add(wing, new THREE.BoxGeometry(0.62, 0.04, 0.22), wingMat, 0.31 * s, 0, 0);
      w.rotation.y = 0.35 * s;
      add(wing, new THREE.SphereGeometry(0.06, 10, 8), s < 0 ? glowOrange : glowCyan, 0.6 * s, 0, 0.1);
      this.wings.push(wing);
    }

    // Thrusters + flames
    this.flames = [];
    const flameOuter = new THREE.MeshBasicMaterial({
      color: 0xff6a1a, transparent: true, opacity: 0.85, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const flameInner = new THREE.MeshBasicMaterial({
      color: 0xfff2a8, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const flameGeo = new THREE.ConeGeometry(0.11, 0.7, 12, 1, true);
    flameGeo.rotateX(Math.PI); // tip points down (-y), base at the nozzle
    flameGeo.translate(0, -0.35, 0);
    this.thrusterAnchors = [];
    for (const s of [-1, 1]) {
      const t = new THREE.Group();
      t.position.set(0.17 * s, -0.3, 0.08);
      pack.add(t);
      add(t, new THREE.CylinderGeometry(0.09, 0.12, 0.34, 14), dark);
      add(t, new THREE.TorusGeometry(0.1, 0.025, 6, 16), glowOrange, 0, -0.17, 0).rotation.x = Math.PI / 2;
      const flame = new THREE.Group();
      flame.position.y = -0.18;
      t.add(flame);
      const outer = add(flame, flameGeo, flameOuter);
      const inner = add(flame, flameGeo, flameInner);
      inner.scale.set(0.55, 0.65, 0.55);
      this.flames.push(flame);
      const anchor = new THREE.Object3D();
      anchor.position.y = -0.55;
      t.add(anchor);
      this.thrusterAnchors.push(anchor);
    }

    // Scarf ribbon trailing from the neck
    const scarfGeo = new THREE.PlaneGeometry(0.17, 1.25, 1, 14);
    scarfGeo.translate(0, -0.62, 0);
    this.scarfBase = Float32Array.from(scarfGeo.attributes.position.array);
    this.scarf = add(
      b,
      scarfGeo,
      new THREE.MeshStandardMaterial({ color: 0xff2e63, side: THREE.DoubleSide, roughness: 0.7 }),
      0.08, 0.45, 0.3,
    );
    add(b, new THREE.TorusGeometry(0.2, 0.06, 8, 18), new THREE.MeshStandardMaterial({ color: 0xff2e63 }), 0, 0.44, 0)
      .rotation.x = Math.PI / 2;

    // Shield bubble
    this.shieldUniforms = {
      color: { value: new THREE.Color(0x4fd8ff) },
      opacity: { value: 0 },
      time: { value: 0 },
    };
    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(1.25, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: this.shieldUniforms,
        vertexShader: FRESNEL_VERT,
        fragmentShader: FRESNEL_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.shield.scale.set(1, 1, 1.3);
    this.root.add(this.shield);

    // Magnet aura: two counter-rotating rings
    this.magnet = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff4d6d, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.035, 6, 48), ringMat);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.03, 6, 48), ringMat.clone());
    r2.material.color.set(0xffffff);
    this.magnet.add(r1, r2);
    this.magnetRings = [r1, r2];
    this.root.add(this.magnet);

    this.tmp = new THREE.Vector3();
    this.reset();
  }

  reset() {
    this.lane = 1;
    this.y = LANES[1];
    this.vy = 0;
    this.root.position.set(0, this.y, 0);
    this.root.visible = true;
    this.shield.visible = false;
    this.magnet.visible = false;
    this.shieldUniforms.opacity.value = 0;
  }

  moveLane(delta) {
    const next = clamp(this.lane + delta, 0, LANES.length - 1);
    if (next === this.lane) return false;
    this.lane = next;
    return true;
  }

  get targetY() {
    return LANES[this.lane];
  }

  update(dt, t, o) {
    // Smooth, springy vertical motion toward the target lane.
    const prev = this.y;
    this.y = damp(this.y, this.targetY, 13, dt);
    this.vy = dt > 0 ? (this.y - prev) / dt : 0;

    const bob = Math.sin(t * 5.2) * 0.07;
    this.root.position.y = this.y + bob;

    // Pitch with vertical velocity, gentle roll for a lively hover.
    const tilt = clamp(this.vy * 0.045, -0.45, 0.45);
    this.body.rotation.x = damp(this.body.rotation.x, -1.22 + tilt, 10, dt);
    this.body.rotation.z = Math.sin(t * 2.1) * 0.07;
    this.body.rotation.y = Math.sin(t * 1.3) * 0.05;

    const boost = o.boost ? 1 : 0;
    // Legs flutter, arms sway, wings flex.
    this.legs[0].rotation.x = Math.sin(t * 9) * 0.22 + 0.15;
    this.legs[1].rotation.x = Math.sin(t * 9 + Math.PI) * 0.22 + 0.15;
    this.arms[0].rotation.x = Math.sin(t * 3) * 0.08;
    this.arms[1].rotation.x = Math.sin(t * 3 + 1) * 0.08;
    this.wings[0].rotation.z = -0.12 + Math.sin(t * 7) * 0.08;
    this.wings[1].rotation.z = 0.12 - Math.sin(t * 7) * 0.08;
    this.head.rotation.x = -tilt * 0.5 + 0.35;

    // Flames flicker; much bigger while boosting.
    for (const f of this.flames) {
      const s = (0.85 + Math.random() * 0.35) * (1 + boost * 1.4) * (1 + Math.max(0, this.vy) * 0.04);
      f.scale.set(1 + boost * 0.4, s, 1 + boost * 0.4);
    }

    // Scarf waves in the wind.
    const pos = this.scarf.geometry.attributes.position;
    const base = this.scarfBase;
    const wind = 10 + o.speed * 0.25;
    for (let i = 0; i < pos.count; i++) {
      const by = base[i * 3 + 1];
      const k = -by / 1.25; // 0 at the neck, 1 at the tip
      pos.array[i * 3] = base[i * 3] + Math.sin(t * wind * 0.7 - k * 5) * 0.08 * k;
      pos.array[i * 3 + 2] = base[i * 3 + 2] + Math.sin(t * wind - k * 7) * 0.14 * k + k * 0.15;
    }
    pos.needsUpdate = true;

    // Shield bubble
    this.shieldUniforms.time.value = t;
    const so = this.shieldUniforms.opacity;
    so.value = damp(so.value, o.shield ? (o.shieldEnding ? 0.4 + 0.6 * (Math.sin(t * 20) > 0) : 1) : 0, 10, dt);
    this.shield.visible = so.value > 0.02;

    // Magnet aura
    this.magnet.visible = o.magnet;
    if (o.magnet) {
      this.magnetRings[0].rotation.set(t * 2.2, t * 1.4, 0);
      this.magnetRings[1].rotation.set(-t * 1.6, 0, t * 2.4);
      const p = 1 + Math.sin(t * 8) * 0.05;
      this.magnet.scale.setScalar(p);
    }

    // Flicker while temporarily invulnerable.
    this.root.visible = o.dead ? false : !(o.grace && Math.sin(t * 45) > 0.3);
  }

  thrusterWorld(i, out) {
    return this.thrusterAnchors[i].getWorldPosition(out);
  }
}
