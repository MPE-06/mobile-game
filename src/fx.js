import * as THREE from '../vendor/three.module.min.js';

// Pooled additive particles. Particles can "drift" with the world so they
// stream past the player like everything else.
export class Particles {
  constructor(scene, count, size, texture) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.base = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.drift = new Float32Array(count);
    this.grav = new Float32Array(count);
    for (let i = 0; i < count; i++) this.pos[i * 3 + 1] = -9999;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size, map: texture, vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.cursor = 0;
    this.tmpColor = new THREE.Color();
  }

  emit(x, y, z, vx, vy, vz, color, life, drift = 1, grav = 0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const o = i * 3;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
    this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz;
    const c = typeof color === 'number' ? this.tmpColor.set(color) : color;
    this.base[o] = c.r; this.base[o + 1] = c.g; this.base[o + 2] = c.b;
    this.life[i] = this.maxLife[i] = life;
    this.drift[i] = drift;
    this.grav[i] = grav;
  }

  burst(x, y, z, color, n, speed = 8, life = 0.8, drift = 1) {
    for (let k = 0; k < n; k++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const s = speed * (0.4 + Math.random() * 0.6);
      this.emit(x, y, z, r * Math.cos(a) * s, u * s, r * Math.sin(a) * s, color, life * (0.6 + Math.random() * 0.6), drift, -6);
    }
  }

  clear() {
    for (let i = 0; i < this.count; i++) {
      this.life[i] = 0;
      this.pos[i * 3 + 1] = -9999;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  update(dt, worldSpeed) {
    const { pos, vel, col, base, life, maxLife } = this;
    for (let i = 0; i < this.count; i++) {
      if (life[i] <= 0) continue;
      const o = i * 3;
      life[i] -= dt;
      if (life[i] <= 0) {
        pos[o + 1] = -9999;
        col[o] = col[o + 1] = col[o + 2] = 0;
        continue;
      }
      vel[o + 1] += this.grav[i] * dt;
      pos[o] += vel[o] * dt;
      pos[o + 1] += vel[o + 1] * dt;
      pos[o + 2] += (vel[o + 2] + worldSpeed * this.drift[i]) * dt;
      const k = life[i] / maxLife[i];
      col[o] = base[o] * k; col[o + 1] = base[o + 1] * k; col[o + 2] = base[o + 2] * k;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}
