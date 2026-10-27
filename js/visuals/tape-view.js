// js/visuals/tape-view.js — the PLAY tape for GRID mode.
//
// One canvas (#tape-canvas) docked above the beat timeline / ui-bar. It draws
// the bar counter, the REC lamp, the hint line and the tape itself: a fixed
// red playhead at 30 % of the width, with the written steps scrolling right
// to left under it. Pure render + tap layer: main.js hands it the state via
// draw() and learns about taps through onTap().
//

import { SCRIABIN_COLORS } from '../mapping.js';

const STEPS_PER_BAR = 16;
const RED = '#ff2a2a';
const CYAN = '#00e5ff';
const WHITE = '#f2f2f2';
const DIM = '#8c8c8c'; // secondary text (4.6:1 on black)
const RULE = '#5a5a5a'; // frames only
const FONT = 'VT323, "Courier New", monospace';
const DRAW_INTERVAL_MS = 1000 / 30; // visual accent, not the instrument
const PLAYHEAD_X = 0.3; // fixed playhead at 30 % of the tape width
const FLASH_MS = 350; // landing flash on a freshly written step
const TICK_MS = 250; // bar counter turns red when the bar changes
const HINT = [
  'L', 'PINCH', '=', 'WRITE', '·', 'L', 'FIST', '=', 'ERASE', '·',
  { key: 'SPACE' }, 'OR', 'TAP', 'TAPE', '=', 'EDIT',
];

const p4 = (n) => String(n).padStart(4, '0');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const norm = (v, lo, hi) => clamp((v - lo) / (hi - lo), 0, 1);

// Brightness 0..1: the mean of the three normalised timbre values.
function timbreBrightness(st) {
  return (
    norm(st.grainSize, 0.02, 0.5) +
    norm(st.density, 1, 80) +
    norm(Math.log(Math.max(100, st.filterCutoff)), Math.log(100), Math.log(18000))
  ) / 3;
}

export class TapeView {
  constructor(canvasEl, { onTap } = {}) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this._onTap = typeof onTap === 'function' ? onTap : null;
    this._dpr = 1;
    this._w = 0;
    this._h = 0;
    this._tapeTop = 0;
    this._tapeH = 0;
    this._uiBarEl = undefined;
    this._lastDraw = -1e9;
    this._tape = null;
    this._unsub = null;
    this._flash = new Map(); // global step index -> write time (ms)
    this._pos = null; // displayed playhead position in steps (float)
    this._lastIdx = null;
    this._idxAt = 0;
    this._lastBar = -1;
    this._tickAt = -1e9;

    canvasEl.addEventListener('click', (e) => this._handleTap(e));
    canvasEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this._onTap) this._onTap();
      }
    });
  }

  _handleTap(e) {
    const r = this.canvas.getBoundingClientRect();
    if (e.clientY - r.top < this._tapeTop - 4) return; // hint / counter area is not the tape
    if (this._onTap) this._onTap();
  }

  // Keep the canvas docked above the beat timeline and the ui-bar, whatever
  // their current visibility (re-measured every draw, like beat-timeline.js).
  _dockOffset() {
    if (this._uiBarEl === undefined) this._uiBarEl = document.getElementById('ui-bar');
    let off = 0;
    const ui = this._uiBarEl;
    if (ui && ui.classList.contains('visible')) off += Math.round(ui.getBoundingClientRect().height) || 58;
    const bt = document.getElementById('beat-timeline');
    if (bt && bt.style.display !== 'none' && getComputedStyle(bt).display !== 'none') {
      off += Math.round(bt.getBoundingClientRect().height) || 0;
    }
    return off;
  }

  // Greedy word wrap of the hint line; returns lines of {x offsets, width}.
  _layoutHint(ctx, maxW, size) {
    ctx.font = `${size}px ${FONT}`;
    const space = ctx.measureText(' ').width;
    const lines = [[]];
    let x = 0;
    for (const w of HINT) {
      const label = typeof w === 'string' ? w : w.key;
      const keyPad = typeof w === 'string' ? 0 : 12;
      const ww = ctx.measureText(label).width + keyPad;
      if (x > 0 && x + ww > maxW) {
        lines.push([]);
        x = 0;
      }
      lines[lines.length - 1].push({ w, label, x, ww });
      x += ww + space;
    }
    return lines.map((ln) => {
      const last = ln[ln.length - 1];
      return { items: ln, width: last.x + last.ww };
    });
  }

  _resize(ctx0) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, document.documentElement.clientWidth);
    const narrow = W < 640;
    const ctxM = ctx0 || this.ctx;
    const ctrSize = narrow ? 36 : 46;
    const hintSize = narrow ? 18 : 19;
    const pad = 12;
    ctxM.setTransform(1, 0, 0, 1, 0, 0);
    ctxM.font = `${ctrSize}px ${FONT}`;
    const ctrW = ctxM.measureText('BAR 0000').width + 70; // + room for the REC lamp
    // wide: hint sits right of the counter; narrow: under it
    const hintMaxW = narrow ? W - pad * 2 : Math.max(220, W - ctrW - pad * 3);
    const lines = this._layoutHint(ctxM, hintMaxW, hintSize);
    const lineH = Math.round(hintSize * 1.25);
    const ctrH = Math.round(ctrSize * 0.9) + 16; // counter + "THE TAPE" caption
    const hintH = lines.length * lineH;
    const headH = narrow ? ctrH + hintH + 2 : Math.max(ctrH, hintH);
    const tapeH = narrow ? 112 : 132;

    this._narrow = narrow;
    this._ctrSize = ctrSize;
    this._hintSize = hintSize;
    this._hintLines = lines;
    this._lineH = lineH;
    this._ctrH = ctrH;
    this._ctrW = ctrW;
    this._headH = headH;
    this._pad = pad;
    this._hintMaxW = hintMaxW;
    this._tapeTop = headH + 6;
    this._tapeH = tapeH;
    this._cw = narrow ? 14 : 22;
    this._dpr = dpr;
    this._w = W;
    this._h = this._tapeTop + tapeH + 8;
    const cv = this.canvas;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(this._h * dpr);
    cv.style.height = `${this._h}px`;
    this._lastDraw = -1e9;
  }

  // Interpolated playhead position in steps. The audio playhead jumps from
  // step to step; between jumps the tape glides on at the tempo.
  _position(playhead, bpm, now) {
    const idx = playhead.bar * STEPS_PER_BAR + playhead.step;
    if (this._lastIdx !== idx) {
      this._lastIdx = idx;
      this._idxAt = now;
    }
    const stepMs = 60000 / Math.max(30, bpm || 116) / 4;
    const target = idx + clamp((now - this._idxAt) / stepMs, 0, 1);
    if (this._pos === null || Math.abs(target - this._pos) > 6) this._pos = target;
    else this._pos += (target - this._pos) * 0.55;
    return this._pos;
  }

  _watchTape(tape, now) {
    if (this._tape === tape) return;
    if (this._unsub) this._unsub();
    this._tape = tape;
    this._flash.clear();
    this._unsub = tape && tape.onChange
      ? tape.onChange(({ bar, step, reset }) => {
        if (!reset && tape.getStep(bar, step)) {
          this._flash.set(bar * STEPS_PER_BAR + step, performance.now());
        }
      })
      : null;
  }

  draw(state, nowMs) {
    const { tape, playhead, armed, bpm, mode } = state;
    const now = typeof nowMs === 'number' ? nowMs : performance.now();
    const cv = this.canvas;
    if (mode === 'edit') {
      cv.classList.add('is-off'); // the editor takes over the screen
      return;
    }
    cv.classList.remove('is-off');
    if (!tape || !playhead) return;
    this._watchTape(tape, now);

    const dockBottom = `${this._dockOffset()}px`;
    if (cv.style.bottom !== dockBottom) cv.style.bottom = dockBottom;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, document.documentElement.clientWidth);
    if (W !== this._w || dpr !== this._dpr || !this._h) this._resize();

    const pos = this._position(playhead, bpm, now);
    if (now - this._lastDraw < DRAW_INTERVAL_MS) return;
    this._lastDraw = now;

    const c = this.ctx;
    const H = this._h;
    c.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    this._drawHead(c, playhead, armed, now);
    this._drawTape(c, tape, playhead, pos, armed, now);
  }

  _drawHead(c, playhead, armed, now) {
    const pad = this._pad;
    const bar = playhead.bar + 1;
    if (bar !== this._lastBar) {
      if (this._lastBar !== -1) this._tickAt = now;
      this._lastBar = bar;
    }
    const ticking = now - this._tickAt < TICK_MS;
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    // counter
    c.font = `${this._ctrSize}px ${FONT}`;
    const baseY = Math.round(this._ctrSize * 0.82);
    c.save();
    c.shadowColor = RED;
    c.shadowBlur = 8;
    c.fillStyle = ticking ? RED : WHITE;
    c.fillText(`BAR ${p4(bar)}`, pad, baseY);
    c.restore();
    c.font = `17px ${FONT}`;
    c.fillStyle = DIM;
    c.fillText('THE TAPE · 16 STEPS A BAR', pad, baseY + 15);
    // REC lamp, lit while a left pinch writes
    const recOn = armed === 'write';
    const cw0 = this._ctrW - 52;
    c.font = `${Math.round(this._ctrSize * 0.55)}px ${FONT}`;
    c.save();
    if (recOn) {
      c.shadowColor = RED;
      c.shadowBlur = 8;
    }
    c.fillStyle = recOn ? RED : DIM;
    const lx = pad + cw0 + 8;
    const ly = baseY - this._ctrSize * 0.28;
    c.beginPath();
    c.arc(lx, ly, 7, 0, Math.PI * 2);
    if (recOn) c.fill();
    else {
      c.strokeStyle = DIM;
      c.lineWidth = 2;
      c.stroke();
    }
    c.fillText('REC', lx + 14, ly + this._ctrSize * 0.17);
    c.restore();

    // hint line (right aligned beside the counter, or under it on phones)
    const lines = this._hintLines;
    const size = this._hintSize;
    c.font = `${size}px ${FONT}`;
    const keyPulse = (Math.sin(now / 1600 * Math.PI * 2) + 1) / 2 > 0.6;
    const top = this._narrow ? this._ctrH : 0;
    const bottomAlign = this._narrow ? 0 : Math.max(0, this._headH - lines.length * this._lineH);
    lines.forEach((ln, li) => {
      const y = top + bottomAlign + li * this._lineH + size * 0.85;
      const x0 = this._narrow ? pad : this._w - pad - ln.width;
      for (const it of ln.items) {
        const x = x0 + it.x;
        if (typeof it.w === 'string') {
          c.fillStyle = DIM;
          c.fillText(it.label, x, y);
        } else {
          const col = keyPulse ? CYAN : WHITE;
          c.save();
          if (keyPulse) {
            c.shadowColor = CYAN;
            c.shadowBlur = 8;
          }
          c.fillStyle = '#111';
          c.fillRect(x, y - size * 0.78, it.ww, size * 0.95);
          c.strokeStyle = col;
          c.lineWidth = 1;
          c.strokeRect(x + 0.5, y - size * 0.78 + 0.5, it.ww - 1, size * 0.95 - 1);
          c.fillRect(x, y + size * 0.17 - 2, it.ww, 2); // heavier bottom edge
          c.restore();
          c.fillStyle = col;
          c.fillText(it.label, x + 6, y);
        }
      }
    });
  }

  _drawTape(c, tape, playhead, pos, armed, now) {
    const W = this._w;
    const top0 = this._tapeTop;
    const H = this._tapeH;
    const cw = this._cw;
    const playX = W * PLAYHEAD_X;
    const lblH = 20; // bar-number strip
    const ch = H - lblH - 6; // note area height
    const total = tape.barCount * STEPS_PER_BAR;

    c.save();
    c.translate(0, top0);
    c.fillStyle = 'rgba(0,0,0,0.92)';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = RULE;
    c.lineWidth = 1;
    c.strokeRect(0.5, 0.5, W - 1, H - 1);
    c.beginPath();
    c.rect(1, 1, W - 2, H - 2);
    c.clip();

    c.font = `17px ${FONT}`;
    c.textBaseline = 'top';
    c.textAlign = 'left';
    const curIdx = Math.floor(pos);
    const i0 = Math.max(0, Math.floor(pos - playX / cw) - 1);
    const i1 = Math.min(total, Math.ceil(pos + (W - playX) / cw) + 1);

    for (let i = i0; i <= i1; i++) {
      const x = playX + (i - pos) * cw;
      const past = x + cw < playX;
      const fade = x < playX ? Math.max(0.15, 1 - ((playX - x) / playX) * 0.85) : 1;
      const future = i > curIdx;
      const bar = i % STEPS_PER_BAR === 0;
      const beat = i % 4 === 0;

      // bar and beat lines (heavy bar lines with their numbers)
      c.globalAlpha = bar ? (past ? fade : future ? 0.7 : 1) : 1;
      c.fillStyle = bar ? 'rgba(242,242,242,0.9)' : beat ? 'rgba(242,242,242,0.28)' : 'rgba(242,242,242,0.1)';
      c.fillRect(x, bar ? 0 : lblH, bar ? 3 : 1, bar ? H : ch + 6);
      if (bar && i < total) {
        c.fillStyle = WHITE;
        c.globalAlpha = past ? fade : future ? 0.65 : 1;
        c.fillText(String(i / STEPS_PER_BAR + 1), x + 7, 2);
      }
      c.globalAlpha = 1;

      if (i >= total) continue;
      const st = tape.getStep(Math.floor(i / STEPS_PER_BAR), i % STEPS_PER_BAR);
      if (!st) continue;
      // height: band within octave, octaves stacked (18 levels)
      const level = (st.octave + 1) * 6 + st.band + 1;
      const h = Math.max(3, (ch * level) / 18);
      const bright = 0.35 + 0.65 * timbreBrightness(st);
      const a = bright * (past ? fade : future ? 0.5 : 1);
      const y = lblH + 4 + ch - h;
      c.globalAlpha = a;
      c.fillStyle = SCRIABIN_COLORS[((st.pc % 12) + 12) % 12] || WHITE;
      c.fillRect(x + 1, y, cw - 2, h);
      c.globalAlpha = 1;
      const wrote = this._flash.get(i);
      if (wrote !== undefined) {
        const age = now - wrote;
        if (age < FLASH_MS) {
          const f = 1 - age / FLASH_MS;
          c.fillStyle = `rgba(255,255,255,${f * 0.9})`;
          c.fillRect(x - 1 - 3 * f, y - 3 * f, cw + 2 + 6 * f, h + 6 * f);
        } else this._flash.delete(i);
      }
    }

    if (armed === 'write') {
      const g = c.createLinearGradient(playX, 0, playX + cw * 2, 0);
      g.addColorStop(0, 'rgba(255,42,42,0.35)');
      g.addColorStop(1, 'rgba(255,42,42,0)');
      c.fillStyle = g;
      c.fillRect(playX, lblH, cw * 2, ch + 6);
    }
    // fixed red playhead
    c.shadowColor = RED;
    c.shadowBlur = 10;
    c.fillStyle = RED;
    c.fillRect(playX - 1, 0, 3, H);
    c.beginPath();
    c.moveTo(playX - 7, 0);
    c.lineTo(playX + 8, 0);
    c.lineTo(playX, 9);
    c.fill();
    c.restore();
  }

  destroy() {
    if (this._unsub) this._unsub();
    this._unsub = null;
    this._tape = null;
  }
}

// Je suis le spectre d'une rose que tu portais hier au bal. Théophile Gautier, 1837
