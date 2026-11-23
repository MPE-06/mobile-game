// One-finger vertical controls.
// Swiping (or dragging) up/down moves one lane per gesture step. A long drag
// keeps stepping, so the player can slide from top to bottom in one motion.
export class Input {
  constructor(el, { onMove, onPause }) {
    this.el = el;
    this.onMove = onMove;
    this.enabled = false;
    this.pointerId = null;
    this.anchorY = 0;
    this.lastY = 0;
    this.lastT = 0;

    const isUi = (e) => e.target.closest && e.target.closest('button, .overlay');

    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled || isUi(e)) return;
      this.pointerId = e.pointerId;
      this.anchorY = this.lastY = e.clientY;
      this.lastT = performance.now();
      this.stepped = false;
    });

    el.addEventListener('pointermove', (e) => {
      if (!this.enabled || e.pointerId !== this.pointerId) return;
      const y = e.clientY;
      const dy = y - this.anchorY;
      if (Math.abs(dy) >= this.threshold()) {
        this.onMove(dy > 0 ? 1 : -1);
        this.anchorY = y;
        this.stepped = true;
      } else if (Math.sign(y - this.lastY) !== Math.sign(dy) && Math.abs(y - this.lastY) > 2) {
        // Finger reversed direction: measure the next step from here.
        this.anchorY = this.lastY;
      }
      this.lastY = y;
      this.lastT = performance.now();
    });

    const end = (e) => {
      if (e.pointerId !== this.pointerId) return;
      // A very quick flick that didn't reach the threshold still counts.
      if (this.enabled && !this.stepped) {
        const dy = e.clientY - this.anchorY;
        if (Math.abs(dy) > this.threshold() * 0.45) this.onMove(dy > 0 ? 1 : -1);
      }
      this.pointerId = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    // Stop the page from scrolling / bouncing on mobile.
    el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (this.enabled && (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W')) {
        this.onMove(-1);
        e.preventDefault();
      } else if (this.enabled && (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S')) {
        this.onMove(1);
        e.preventDefault();
      } else if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
        onPause && onPause();
      }
    });
  }

  threshold() {
    return Math.max(22, Math.min(48, this.el.clientHeight * 0.045));
  }
}
