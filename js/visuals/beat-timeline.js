// beat-timeline.js — compact bottom-docked beat timeline strip.
// Canvas-drawn (no per-frame DOM churn), styled to match hud.js: dark,
// monospace, red/white/cyan accents. Docked above the ui-bar (never
// overlapping it — see commit d6c4cea for the mobile overlay bug this
// avoids by measuring the ui-bar's live height every resize/draw).
//
// Boundary: reads only what main.js hands it via draw(state) — no direct
// engine/mapper/library access — so it stays a pure render + hit-test layer.

const WHITE = '#f2f2f2';
const CYAN = '#00e5ff';
const DIM_LINE = 'rgba(242,242,242,0.18)';
const CELL_OFF = 'rgba(242,242,242,0.10)';
const CELL_ON = 'rgba(242,242,242,0.4)';
const CELL_PLAYHEAD = '#ff2a2a';
const LANE_MUTED = 'rgba(242,242,242,0.25)';

const STEPS = 16; // 4 beats x 4 sixteenths
const DRAW_INTERVAL_MS = 1000 / 30; // throttled — this is a visual accent, not the instrument

export class BeatTimeline {
  constructor(canvas, { onToggleMute } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this._onToggleMute = typeof onToggleMute === 'function' ? onToggleMute : null;
    this._lastDraw = -1e9;
    this._laneHitboxes = []; // [{y0, y1, id}] in css px, refreshed every draw
    this._collapsed = false;
    this._uiBarEl = undefined;

    canvas.addEventListener('click', (e) => this._handleClick(e));
    this.resize();
  }

  // css-px height of the fixed bottom ui-bar (mirrors hud.js's approach) so
  // the strip docks directly above it and never overlaps its buttons.
  _measureUiBarHeight() {
    if (this._uiBarEl === undefined) this._uiBarEl = document.getElementById('ui-bar');
    const el = this._uiBarEl;
    if (!el || !el.classList.contains('visible')) return 0;
    const h = el.getBoundingClientRect().height;
    return h > 0 ? Math.round(h) : 58;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    const w = window.innerWidth;
    const portrait = window.innerHeight > window.innerWidth;
    this._collapsed = portrait && w < 480;

    const cssH = this._collapsed ? 34 : 22 + this._laneCount() * 22 + 8;
    this._cssH = cssH;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.style.bottom = `${this._measureUiBarHeight()}px`;

    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this._lastDraw = -1e9;
  }

  _laneCount() {
    return this._lastLanes ? Math.min(4, this._lastLanes.length) : 0;
  }

  _handleClick(e) {
    if (!this._onToggleMute || this._collapsed) return;
    const rect = this.canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    for (const hb of this._laneHitboxes) {
      if (y >= hb.y0 && y < hb.y1) {
        this._onToggleMute(hb.id);
        return;
      }
    }
  }

  // state = { visible, bpm, phase (0..1), beatIndex, lanes: [{id, name, muted}] }
  draw(state, now) {
    const canvas = this.canvas;
    if (!state || !state.visible) {
      if (canvas.style.display !== 'none') canvas.style.display = 'none';
      return;
    }
    if (canvas.style.display === 'none') canvas.style.display = '';

    // Re-sync bottom offset each draw — ui-bar height can change (declutter
    // toggle, mobile wrap) without a window resize event firing.
    const uiBarH = this._measureUiBarHeight();
    const wantBottom = `${uiBarH}px`;
    if (canvas.style.bottom !== wantBottom) canvas.style.bottom = wantBottom;

    const lanesChanged = !this._lastLanes || this._lastLanes.length !== (state.lanes || []).length;
    this._lastLanes = state.lanes || [];
    if (lanesChanged) this.resize();

    if (now - this._lastDraw < DRAW_INTERVAL_MS) return;
    this._lastDraw = now;

    const ctx = this.ctx;
    const dpr = this.dpr;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, H);

    const step = ((state.beatIndex || 0) % 4) * 4 + Math.floor(Math.max(0, Math.min(0.999, state.phase || 0)) * 4);

    const pad = Math.round(10 * dpr);
    const headerH = Math.round((this._collapsed ? 34 : 22) * dpr);

    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(13 * dpr)}px "VT323", "Courier New", monospace`;
    ctx.fillStyle = CYAN;
    ctx.textAlign = 'left';
    ctx.fillText(`BPM ${Math.round(state.bpm || 0)}`, pad, headerH / 2);

    const gridX0 = this._collapsed ? Math.round(70 * dpr) : pad;
    const gridW = W - gridX0 - pad;
    const cellW = gridW / STEPS;

    this._laneHitboxes = [];

    if (this._collapsed) {
      this._drawStepRow(ctx, gridX0, headerH / 2 - Math.round(7 * dpr), cellW, Math.round(14 * dpr), step, true, dpr);
      return;
    }

    // full ruler row (beat markers only, no lane)
    this._drawStepRow(ctx, gridX0, headerH - Math.round(2 * dpr), cellW, Math.round(4 * dpr), step, false, dpr);

    const laneH = Math.round(22 * dpr);
    let y = headerH + Math.round(6 * dpr);
    const labelW = gridX0 - pad;

    for (const lane of this._lastLanes.slice(0, 4)) {
      const cssY0 = y / dpr;
      const cssY1 = (y + laneH) / dpr;
      this._laneHitboxes.push({ y0: cssY0, y1: cssY1, id: lane.id });

      ctx.fillStyle = lane.muted ? LANE_MUTED : WHITE;
      ctx.textAlign = 'left';
      ctx.font = `${Math.round(12 * dpr)}px "VT323", "Courier New", monospace`;
      const label = (lane.name || '—').toUpperCase().slice(0, 12);
      ctx.fillText(lane.muted ? `▪ ${label}` : `▸ ${label}`, pad, y + laneH / 2);

      this._drawStepRow(ctx, gridX0, y + laneH / 2 - Math.round(6 * dpr), cellW, Math.round(12 * dpr), step, !lane.muted, dpr);

      y += laneH;
    }
  }

  _drawStepRow(ctx, x0, y0, cellW, cellH, activeStep, lit, dpr) {
    for (let i = 0; i < STEPS; i++) {
      const x = x0 + i * cellW;
      const isPlayhead = i === activeStep;
      const isBeatStart = i % 4 === 0;
      ctx.fillStyle = isPlayhead ? CELL_PLAYHEAD : (lit ? CELL_ON : CELL_OFF);
      ctx.globalAlpha = isPlayhead ? 1 : (lit ? 0.8 : 0.5);
      ctx.fillRect(x + 1, y0, Math.max(1, cellW - 2), cellH);
      ctx.globalAlpha = 1;
      if (isBeatStart) {
        ctx.strokeStyle = DIM_LINE;
        ctx.lineWidth = Math.max(1, Math.round(dpr));
        ctx.strokeRect(x + 0.5, y0 - 1, 1, cellH + 2);
      }
    }
  }
}
