// One-finger controls in four directions.
// A swipe (or drag) moves one cell along its dominant axis. A long drag keeps
// stepping, so the player can slide across the whole grid in one motion, and
// can change direction mid-drag (e.g. up, then right) without lifting.
export class Input {
  constructor(el, { onMove, onPause }) {
    this.el = el;
    this.onMove = onMove; // (dx, dy): dx -1 left / +1 right, dy -1 up / +1 down
    this.enabled = false;
    this.pointerId = null;

    const isUi = (e) => e.target.closest && e.target.closest('button, .overlay');

    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled || isUi(e)) return;
      this.pointerId = e.pointerId;
      this.ax = this.lx = e.clientX;
      this.ay = this.ly = e.clientY;
      this.stepped = false;
    });

    el.addEventListener('pointermove', (e) => {
      if (!this.enabled || e.pointerId !== this.pointerId) return;
      const x = e.clientX;
      const y = e.clientY;
      const dx = x - this.ax;
      const dy = y - this.ay;
      const th = this.threshold();
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= th) {
        // Only step along the dominant axis so diagonal wobble doesn't misfire.
        if (Math.abs(dx) > Math.abs(dy) * 1.1) this.onMove(Math.sign(dx), 0);
        else if (Math.abs(dy) > Math.abs(dx) * 1.1) this.onMove(0, Math.sign(dy));
        else this.onMove(Math.sign(dx), Math.sign(dy));
        this.ax = x;
        this.ay = y;
        this.stepped = true;
      } else {
        // Finger reversed direction on an axis: measure the next step from the turn.
        if (Math.sign(x - this.lx) !== Math.sign(dx) && Math.abs(x - this.lx) > 2) this.ax = this.lx;
        if (Math.sign(y - this.ly) !== Math.sign(dy) && Math.abs(y - this.ly) > 2) this.ay = this.ly;
      }
      this.lx = x;
      this.ly = y;
    });

    const end = (e) => {
      if (e.pointerId !== this.pointerId) return;
      // A very quick flick that didn't reach the threshold still counts.
      if (this.enabled && !this.stepped) {
        const dx = e.clientX - this.ax;
        const dy = e.clientY - this.ay;
        if (Math.max(Math.abs(dx), Math.abs(dy)) > this.threshold() * 0.45) {
          if (Math.abs(dx) > Math.abs(dy)) this.onMove(Math.sign(dx), 0);
          else this.onMove(0, Math.sign(dy));
        }
      }
      this.pointerId = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    // Stop the page from scrolling / bouncing on mobile.
    el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    const keys = {
      ArrowUp: [0, -1], w: [0, -1], W: [0, -1],
      ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
      ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
      ArrowRight: [1, 0], d: [1, 0], D: [1, 0],
    };
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = keys[e.key];
      if (k && this.enabled) {
        this.onMove(k[0], k[1]);
        e.preventDefault();
      } else if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
        onPause && onPause();
      }
    });
  }

  threshold() {
    return Math.max(22, Math.min(46, this.el.clientHeight * 0.042));
  }
}
