// js/grid/editor.js — the EDIT view for GRID mode.
//
// TapeEditor builds all of its DOM inside rootEl (#tape-editor): the paused
// banner, a minimap, the note editor canvas (6 scale notes as rows, bars as
// columns), LOOP / EXPORT / PLAY FROM HERE buttons and the export window.
// It reads grid.tape and calls the GridTransport API (grid.scrubTo,
// grid.stutterStart/Stop, tape.setStep/setLoop). It never starts or stops
// playback itself: main.js owns that through onPlayFromHere.
//

import { STEPS_PER_BAR, makeStep } from './tape.js';
import { SCALE_DEFS, SCRIABIN_COLORS } from '../mapping.js';

const SPB = STEPS_PER_BAR;
const GUT = 40; // note-name gutter, css px
const HDR = 24; // bar-number strip, css px
const CYAN = '#00e5ff';
const RED = '#ff2a2a';
const WHITE = '#f2f2f2';
const FONT = 'VT323, "Courier New", monospace';
const MM_H = 38;
const DEFAULT_TIMBRE = { grainSize: 0.09, density: 12, filterCutoff: 12000 };
const STUTTER_HOLD_MS = 300; // hold a note this long to start the stutter
const STUTTER_FAST_MS = 1000; // ...and this long into it for 1/32
const LONG_PRESS_MS = 450; // touch: long-press on bar numbers, then drag = loop

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const p2 = (n) => String(n).padStart(2, '0');
const p4 = (n) => String(n).padStart(4, '0');

let howShown = false; // the how-to list shows on the first EDIT of a page load only

export class TapeEditor {
  constructor(rootEl, { grid }) {
    this.root = rootEl;
    this.grid = grid;
    this.onPlayFromHere = () => {};
    this.isOpen = false;

    this._scroll = 0;
    this._vel = 0;
    this._sel = null; // global step index of the selected note
    this._ph = 0; // cursor, global step index
    this._gridIdx = -1; // last cursor index seen on grid.playhead
    this._drag = null;
    this._hov = null;
    this._stut = null;
    this._scrubbing = false;
    this._mdrag = false;
    this._lit = {};
    this._flash = {};
    this._ghosts = [];
    this._raf = 0;
    this._last = 0;
    this._toastT = 0;
    this._unsub = null;
    this._returnFocus = null;
    this._mmLayer = null; // cached minimap notes + loop; redrawn only when the tape or size changes
    this._mmDirty = true;

    this._build();
    this._bind();
  }

  get cursorBar() {
    return Math.floor(this._ph / SPB);
  }

  // ---------- DOM ----------

  _build() {
    this.root.innerHTML = `
      <div class="te-top">
        <div class="te-pz">PAUSED · EDIT <span class="k"><span class="key">SPACE</span> = BACK TO PLAY</span></div>
        <ul class="te-how">
          <li><b>▸</b> CLICK EMPTY CELL = ADD NOTE · CLICK NOTE = SELECT</li>
          <li><b>▸</b> DRAG NOTE UP / DOWN = PITCH · HOLD NOTE = STUTTER</li>
          <li><b>▸</b> DRAG RED LINE = SCRUB · DRAG / SWIPE / ← → = SCROLL</li>
          <li><b>▸</b> SHIFT-DRAG BAR NUMBERS = LOOP (TOUCH: LONG-PRESS, DRAG)</li>
          <li><b>▸</b> <span class="key">CTRL</span>/<span class="key">⌘</span> + <span class="key">Z</span> = UNDO · TAB TO THE NOTES, ARROWS + <span class="key">ENTER</span> = ADD NOTE</li>
        </ul>
        <div class="te-sel" aria-live="polite"></div>
      </div>
      <div class="te-panel">
        <div class="te-mmrow"><div class="te-ctr"></div><div class="te-mmw"><canvas class="te-mm" aria-label="TAPE OVERVIEW"></canvas></div></div>
        <div class="te-edwrap"><canvas class="te-ed" tabindex="0" role="application" aria-label="NOTE EDITOR. ARROWS MOVE THE KEYBOARD CURSOR, ENTER ADDS OR SELECTS A NOTE, SHIFT WITH UP OR DOWN CHANGES ITS PITCH, DELETE REMOVES IT, CTRL OR COMMAND Z UNDOES"></canvas></div>
        <div class="te-acts">
          <button type="button" class="btn pri pulse te-play">▸ PLAY FROM HERE <span class="key">SPACE</span></button>
          <button type="button" class="btn te-loop">↻ LOOP</button>
          <button type="button" class="btn te-undo" disabled>↶ UNDO</button>
          <button type="button" class="btn te-export">▸ EXPORT</button>
        </div>
      </div>
      <div class="te-exp" role="dialog" aria-modal="true" aria-label="EXPORT FOR YOUR DAW"><div class="te-win">
        <div class="bar">EXPORT FOR YOUR DAW</div>
        <div class="bd">
          <canvas class="te-pv"></canvas>
          <div class="te-line"></div>
          <div><b>WHAT'S INSIDE:</b> GRID NOTES (CH 3) · TIMBRE AS CC 22–24<span class="te-beat-info"> · BEAT (CH 10)</span></div>
          <div><b>OPENS IN:</b> GARAGEBAND (FREE ON MAC) · LOGIC · ABLETON · REAPER · SIGNAL (FREE, IN THE BROWSER)</div>
          <div><b>NOTE:</b> EVERY NOTE HAS THE SAME VELOCITY (100) AND LASTS ONE STEP, SO SHAPE DYNAMICS AND LENGTHS IN YOUR DAW.</div>
          <label class="te-chk"><input type="checkbox" class="te-beat" checked> INCLUDE BEAT (KICK + HAT, CH 10)</label>
          <div class="row"><button type="button" class="btn pri te-save">▸ SAVE .MID…</button><button type="button" class="btn te-cancel">CANCEL</button></div>
        </div>
      </div></div>
      <div class="te-toast" role="status"></div>`;
    const q = (s) => this.root.querySelector(s);
    this.el = {
      how: q('.te-how'), sel: q('.te-sel'), ctr: q('.te-ctr'), mmw: q('.te-mmw'),
      mm: q('.te-mm'), ed: q('.te-ed'), edwrap: q('.te-edwrap'),
      play: q('.te-play'), loop: q('.te-loop'), undo: q('.te-undo'), exp: q('.te-export'),
      beat: q('.te-beat'), beatInfo: q('.te-beat-info'),
      dlg: q('.te-exp'), pv: q('.te-pv'), line: q('.te-line'),
      save: q('.te-save'), cancel: q('.te-cancel'), toast: q('.te-toast'),
    };
  }

  _bind() {
    const { ed, mm, play, loop, undo, exp, save, cancel, dlg, beat, beatInfo } = this.el;
    ed.addEventListener('pointerdown', (e) => this._down(e));
    ed.addEventListener('pointermove', (e) => this._move(e));
    ed.addEventListener('pointerup', () => this._end());
    ed.addEventListener('pointercancel', () => this._end());
    ed.addEventListener('pointerleave', () => { if (!this._drag) this._hov = null; });
    ed.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this._scroll = clamp(this._scroll + d, 0, this._maxScroll());
      this._vel = 0;
    }, { passive: false });
    mm.addEventListener('pointerdown', (e) => {
      try { mm.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or ended pointer */ }
      this._mdrag = true;
      this._mmTo(e);
    });
    mm.addEventListener('pointermove', (e) => { if (this._mdrag) this._mmTo(e); });
    mm.addEventListener('pointerup', () => { this._mdrag = false; });
    mm.addEventListener('pointercancel', () => { this._mdrag = false; });

    play.addEventListener('click', () => { play.blur(); this.onPlayFromHere(this.cursorBar); });
    loop.addEventListener('click', () => this._toggleLoop());
    undo.addEventListener('click', () => this._undo(false));
    beat.addEventListener('change', () => { beatInfo.hidden = !beat.checked; });
    ed.addEventListener('focus', () => { this._kfocus = true; this._kcFromCursor(); });
    ed.addEventListener('blur', () => { this._kfocus = false; });
    exp.addEventListener('click', () => this._openExport());
    cancel.addEventListener('click', () => this._closeExport());
    save.addEventListener('click', () => this._save());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) this._closeExport(); });

    this._onKey = (e) => this._key(e);
    this._onKeyUp = (e) => { if (e.code === 'Space' && !this.el.dlg.classList.contains('on')) e.preventDefault(); };
    this._onResize = () => this._size();
    this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._size()) : null;
  }

  // ---------- open / close ----------

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.root.hidden = false;
    this.root.classList.add('open');
    if (howShown) this.el.how.hidden = true;
    howShown = true;
    this._sel = null;
    this._drag = null;
    this._stut = null;
    this._vel = 0;
    this._ph = this._gridPos();
    this._gridIdx = this._ph;
    this._mmDirty = true;
    this._size(true);
    this._scroll = clamp(this._ph * this._cw - (this._ew - GUT) / 2, 0, this._maxScroll());
    this._selInfo();
    this._syncLoop();
    this._unsub = this.grid.tape.onChange(({ bar, step, reset }) => this._changed(bar, step, reset));
    this._syncUndo();
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('resize', this._onResize);
    if (this._ro) { this._ro.observe(this.el.edwrap); this._ro.observe(this.el.mmw); }
    this._last = performance.now();
    this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this._endStutter();
    this._drag = null;
    this._closeExport(true);
    cancelAnimationFrame(this._raf);
    if (this._unsub) this._unsub();
    this._unsub = null;
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('resize', this._onResize);
    if (this._ro) this._ro.disconnect();
    this.root.classList.remove('open');
    this.root.hidden = true;
  }

  // ---------- model helpers ----------

  get _tape() { return this.grid.tape; }
  get _total() { return this._tape.barCount * SPB; }
  _stepAt(s) { return this._tape.getStep(Math.floor(s / SPB), s % SPB); }
  _setStepAt(s, v) { this._tape.setStep(Math.floor(s / SPB), s % SPB, v); }
  _gridPos() {
    const p = this.grid.playhead || { bar: 0, step: 0 };
    return clamp(p.bar * SPB + p.step, 0, Math.max(0, this._total - 1));
  }

  _timbreNear(s) {
    // copy the timbre of the nearest note in the same bar, else the defaults
    const bar = Math.floor(s / SPB);
    let best = null;
    let bd = 1e9;
    for (let i = 0; i < SPB; i++) {
      const st = this._tape.getStep(bar, i);
      const d = Math.abs(bar * SPB + i - s);
      if (st && d < bd) { best = st; bd = d; }
    }
    const t = best || DEFAULT_TIMBRE;
    return { grainSize: t.grainSize, density: t.density, filterCutoff: t.filterCutoff };
  }

  _make(band, octave, timbre) {
    const sc = this.grid.getScaleState();
    return makeStep({ band, octave, ...timbre }, { scaleId: sc.scaleId, rootIndex: sc.rootIndex });
  }

  _changed(bar, step, reset) {
    const s = bar * SPB + step;
    this._mmDirty = true;
    if (reset) { if (this._sel !== null && !this._stepAt(this._sel)) this._sel = null; }
    else if (this._stepAt(s)) this._flash[s] = performance.now();
    this._syncUndo();
    if (this._sel === s && !this._stepAt(s)) this._sel = null;
    this._selInfo();
    this._syncLoop();
    this._size(); // bar count may have changed
  }

  _addNote(s, band) {
    this._tape.checkpoint();
    this._setStepAt(s, this._make(band, 0, this._timbreNear(s)));
    this._sel = s;
    this._flash[s] = performance.now();
    this._selInfo();
  }

  _deleteSel() {
    const s = this._sel;
    if (s === null || !this._stepAt(s)) return;
    this._ghosts.push({ s, band: this._stepAt(s).band, t: performance.now() });
    if (this._stut && this._stut.s === s) this._endStutter();
    this._sel = null;
    this._tape.checkpoint();
    this._setStepAt(s, null);
    this._selInfo();
  }

  _selInfo() {
    const st = this._sel !== null ? this._stepAt(this._sel) : null;
    if (!st) { this.el.sel.textContent = 'NO NOTE SELECTED'; return; }
    const names = this.grid.getScaleState().noteNames;
    const oct = st.octave ? ` ${st.octave > 0 ? '+' : '-'}${Math.abs(st.octave)} OCT` : '';
    this.el.sel.innerHTML =
      `SELECTED ▸ ${names[st.band]}${oct} · BAR ${p2(Math.floor(this._sel / SPB) + 1)} · STEP ${p2(this._sel % SPB + 1)} &nbsp; <span class="key">DEL</span> OR × = REMOVE`;
  }

  // ---------- layout ----------

  _size(force) {
    if (!this.isOpen) return;
    const w = this.el.edwrap;
    const narrow = window.innerWidth < 640;
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._cw = narrow ? 32 : 26;
    this._ew = Math.max(100, w.clientWidth - 24);
    this._rh = clamp(Math.floor((w.clientHeight - HDR) / 6), 22, 56);
    this._eh = HDR + 6 * this._rh;
    const mmw = this.el.mmw;
    this._mw = Math.max(50, mmw.clientWidth - 2);
    const key = `${this._ew}x${this._eh}x${this._mw}x${this._dpr}`;
    if (force || key !== this._sizeKey) {
      this._sizeKey = key;
      this._ex = this._fit(this.el.ed, this._ew, this._eh);
      this._mx = this._fit(this.el.mm, this._mw, MM_H);
      this._mmDirty = true;
    }
    this._scroll = clamp(this._scroll, 0, this._maxScroll());
  }

  _fit(c, w, h) {
    c.width = Math.round(w * this._dpr);
    c.height = Math.round(h * this._dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const x = c.getContext('2d');
    x.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    return x;
  }

  _maxScroll() { return Math.max(0, this._total * this._cw - (this._ew - GUT)); }
  _stepX(s) { return GUT + s * this._cw - this._scroll; }
  _rowOf(y) { return 5 - Math.floor((y - HDR) / this._rh); }

  _nrect(s, band) {
    return { x: this._stepX(s) + 2, y: HDR + (5 - band) * this._rh + 2, w: this._cw - 4, h: this._rh - 4 };
  }

  _xbox(s, band) {
    const r = this._nrect(s, band);
    const sz = window.innerWidth < 640 ? 20 : 16;
    const up = r.y - sz - 2 >= HDR;
    return { x: r.x + r.w / 2 - sz / 2, y: up ? r.y - sz - 2 : r.y + r.h + 2, s: sz };
  }

  _hitX(x, y) {
    const st = this._sel !== null ? this._stepAt(this._sel) : null;
    if (!st) return false;
    const b = this._xbox(this._sel, st.band);
    return x >= b.x - 4 && x <= b.x + b.s + 4 && y >= b.y - 4 && y <= b.y + b.s + 4;
  }

  // ---------- pointer ----------

  _scrubTo(x) {
    const s = clamp(Math.round((x - GUT + this._scroll) / this._cw), 0, this._total - 1);
    if (s === this._ph) return;
    const now = performance.now();
    for (let k = Math.min(s, this._ph); k <= Math.max(s, this._ph); k++) this._lit[k] = now;
    this._ph = s;
    this.grid.scrubTo(Math.floor(s / SPB), s % SPB);
    this._gridIdx = this._gridPos();
  }

  _loopTo(x) {
    const d = this._drag;
    const b = clamp(Math.floor((x - GUT + this._scroll) / (SPB * this._cw)), 0, this._tape.barCount - 1);
    this._tape.setLoop(Math.min(d.lb, b), Math.max(d.lb, b));
  }

  _local(e) {
    const r = this.el.ed.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _down(e) {
    const ed = this.el.ed;
    try { ed.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or ended pointer */ }
    const { x, y } = this._local(e);
    const touch = e.pointerType === 'touch';
    const d = { x0: x, y0: y, sx: this._scroll, moved: false, type: 'cell', hist: [{ x, t: performance.now() }], lb: 0, timer: 0 };
    this._drag = d;
    this._vel = 0;
    if (x < GUT) { this._drag = null; return; }
    if (this._hitX(x, y)) { this._deleteSel(); this._drag = null; return; }
    if (!e.shiftKey && Math.abs(x - this._stepX(this._ph)) <= (touch ? 16 : 10)) {
      d.type = 'scrub';
      this._scrubbing = true;
      this._scrubTo(x);
      return;
    }
    if (y < HDR) {
      d.lb = clamp(Math.floor((x - GUT + this._scroll) / (SPB * this._cw)), 0, this._tape.barCount - 1);
      d.type = 'scroll';
      if (e.shiftKey) { d.type = 'loop'; this._tape.checkpoint(); this._loopTo(x); }
      else if (touch) {
        d.timer = setTimeout(() => {
          if (this._drag === d && !d.moved) {
            d.type = 'loop';
            this._tape.checkpoint();
            this._loopTo(d.x0);
            if (navigator.vibrate) navigator.vibrate(15);
          }
        }, LONG_PRESS_MS);
      }
      return;
    }
    const s = Math.floor((x - GUT + this._scroll) / this._cw);
    const band = this._rowOf(y);
    if (s < 0 || s >= this._total || band < 0 || band > 5) return;
    const st = this._stepAt(s);
    if (st && st.band === band) {
      d.type = 'note';
      d.s = s;
      d.level0 = st.octave * 6 + st.band;
      d.row0 = band;
      this._sel = s;
      this._flash[s] = performance.now();
      this._selInfo();
      d.timer = setTimeout(() => {
        if (this._drag === d && !d.moved) this._startStutter(s);
      }, STUTTER_HOLD_MS);
    }
  }

  _move(e) {
    const { x, y } = this._local(e);
    const d = this._drag;
    const cur = this.el.ed.style;
    if (!d) {
      const s = Math.floor((x - GUT + this._scroll) / this._cw);
      const band = this._rowOf(y);
      this._hov = x >= GUT && y >= HDR && band >= 0 && band <= 5 && s >= 0 && s < this._total ? { s, band } : null;
      const st = this._hov ? this._stepAt(s) : null;
      cur.cursor = Math.abs(x - this._stepX(this._ph)) < 10 ? 'ew-resize'
        : y < HDR ? 'col-resize'
          : st && st.band === band ? 'ns-resize' : 'pointer';
      return;
    }
    const dx = x - d.x0;
    const dy = y - d.y0;
    if (!d.moved && Math.hypot(dx, dy) > 6) {
      d.moved = true;
      if (d.timer && d.type !== 'loop') clearTimeout(d.timer);
      if (d.type === 'note' && Math.abs(dx) > Math.abs(dy) * 1.5) d.type = 'cell';
    }
    if (!d.moved) return;
    if (this._stut && d.type === 'note') this._endStutter();
    if (d.type === 'cell') d.type = 'scroll';
    if (d.type === 'scroll') {
      this._scroll = clamp(d.sx - dx, 0, this._maxScroll());
      d.hist.push({ x, t: performance.now() });
      if (d.hist.length > 6) d.hist.shift();
    } else if (d.type === 'scrub') this._scrubTo(x);
    else if (d.type === 'loop') this._loopTo(x);
    else if (d.type === 'note') {
      // pitch drag: rows are the 6 scale notes, passing the top or bottom
      // row moves into the next octave (shown as a +/- tag on the note)
      const st = this._stepAt(d.s);
      if (!st) return;
      const level = clamp(d.level0 + (this._rowOf(y) - d.row0), -6, 11);
      const band = ((level % 6) + 6) % 6;
      const octave = Math.floor(level / 6);
      if (band !== st.band || octave !== st.octave) {
        if (!d.cp) { d.cp = true; this._tape.checkpoint(); } // one undo step per pitch drag
        this._setStepAt(d.s, this._make(band, octave, { grainSize: st.grainSize, density: st.density, filterCutoff: st.filterCutoff }));
        this._flash[d.s] = performance.now();
        this._selInfo();
      }
    }
  }

  _end() {
    const d = this._drag;
    if (!d) return;
    clearTimeout(d.timer);
    if (d.type === 'cell' && !d.moved) {
      const s = Math.floor((d.x0 - GUT + this._scroll) / this._cw);
      const band = this._rowOf(d.y0);
      if (band >= 0 && band <= 5 && s >= 0 && s < this._total) this._addNote(s, band);
    }
    if (d.type === 'scroll' && d.hist.length > 1) {
      const a = d.hist[0];
      const b = d.hist[d.hist.length - 1];
      const dt = b.t - a.t;
      if (dt > 0 && performance.now() - b.t < 80) this._vel = -((b.x - a.x) / dt) * 16;
    }
    this._endStutter();
    this._scrubbing = false;
    this._drag = null;
  }

  _startStutter(s) {
    const stut = { s, t0: performance.now(), timer: 0 };
    this._stut = stut;
    this.grid.stutterStart(Math.floor(s / SPB), s % SPB, '1/16');
    // after 1 s of holding, the stutter doubles to 1/32
    stut.timer = setTimeout(() => {
      if (this._stut === stut) this.grid.stutterStart(Math.floor(s / SPB), s % SPB, '1/32');
    }, STUTTER_FAST_MS);
  }

  _endStutter() {
    if (!this._stut) return;
    clearTimeout(this._stut.timer);
    this._stut = null;
    this.grid.stutterStop();
  }

  _mmTo(e) {
    const r = this.el.mm.getBoundingClientRect();
    const sx = this._mw / this._total;
    this._scroll = clamp(((e.clientX - r.left) / sx) * this._cw - (this._ew - GUT) / 2, 0, this._maxScroll());
    this._vel = 0;
  }

  // ---------- keys, loop, export ----------

  _key(e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
      if (this.el.dlg.classList.contains('on')) return;
      e.preventDefault();
      this._undo(e.shiftKey);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (this.el.dlg.classList.contains('on')) {
      if (e.key === 'Escape') { e.preventDefault(); this._closeExport(); }
      else if (e.key === 'Tab') { // keep focus inside the export window
        const f = [this.el.beat, this.el.save, this.el.cancel];
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
      }
      return;
    }
    if (document.activeElement === this.el.ed) {
      if (!this._kc) this._kcFromCursor();
      this._kfocus = true;
      if (this._kcKey(e)) return;
    }
    if (e.key === 'ArrowRight') { e.preventDefault(); this._vel += this._cw * 0.35; }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this._vel -= this._cw * 0.35; }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this._sel !== null) {
      e.preventDefault();
      this._deleteSel();
    }
  }

  _syncLoop() { this.el.loop.classList.toggle('on', !!this._tape.loop); }

  _syncUndo() { this.el.undo.disabled = !this._tape.canUndo; }

  // redo: Shift with the undo shortcut
  _undo(redo) {
    const ok = redo ? this._tape.redo() : this._tape.undo();
    this._syncUndo();
    this._toast(ok ? (redo ? 'REDONE' : 'UNDONE') : (redo ? 'NOTHING TO REDO' : 'NOTHING TO UNDO'));
  }

  // ---------- keyboard cursor (note editor canvas focused) ----------
  // Arrows move a dashed cell; Enter adds a note there or selects the one
  // that is there; Shift + Up/Down moves the selected note's pitch.

  _kcFromCursor() {
    if (!this._kc) this._kc = { s: this._ph, band: 2 };
    this._kc.s = clamp(this._kc.s, 0, this._total - 1);
    this._kcShow();
  }

  _kcShow() {
    const k = this._kc;
    const x = k.s * this._cw;
    const vw = this._ew - GUT;
    if (x < this._scroll) this._scroll = clamp(x - this._cw, 0, this._maxScroll());
    else if (x + this._cw > this._scroll + vw) this._scroll = clamp(x + 2 * this._cw - vw, 0, this._maxScroll());
    this._vel = 0;
    const names = this.grid.getScaleState().noteNames;
    if (this._sel === null) {
      this.el.sel.textContent = `CURSOR ▸ ${names[k.band]} · BAR ${p2(Math.floor(k.s / SPB) + 1)} · STEP ${p2(k.s % SPB + 1)} · ENTER = ADD NOTE`;
    }
  }

  _kcKey(e) {
    const k = this._kc;
    if (!k) return false;
    const st = this._stepAt(k.s);
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && this._sel !== null && this._stepAt(this._sel)) {
      e.preventDefault();
      const cur = this._stepAt(this._sel);
      const level = clamp(cur.octave * 6 + cur.band + (e.key === 'ArrowUp' ? 1 : -1), -6, 11);
      const band = ((level % 6) + 6) % 6;
      this._tape.checkpoint();
      this._setStepAt(this._sel, this._make(band, Math.floor(level / 6), { grainSize: cur.grainSize, density: cur.density, filterCutoff: cur.filterCutoff }));
      this._flash[this._sel] = performance.now();
      k.s = this._sel;
      k.band = band;
      this._selInfo();
      return true;
    }
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (moves[e.key]) {
      e.preventDefault();
      const [ds, db] = moves[e.key];
      k.s = clamp(k.s + ds * (e.shiftKey ? SPB : 1), 0, this._total - 1);
      k.band = clamp(k.band + db, 0, 5);
      this._sel = null;
      this._kcShow();
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (st && st.band === k.band) {
        this._sel = k.s;
        this._flash[k.s] = performance.now();
        this._selInfo();
      } else this._addNote(k.s, k.band);
      return true;
    }
    if (e.key === 'Escape' && this._sel !== null) {
      e.preventDefault();
      this._sel = null;
      this._kcShow();
      return true;
    }
    return false;
  }

  _toggleLoop() {
    const t = this._tape;
    t.checkpoint();
    if (t.loop) t.clearLoop();
    else {
      const b = clamp(this.cursorBar, 0, t.barCount - 1);
      t.setLoop(b, clamp(b + 3, 0, t.barCount - 1));
    }
    this._syncLoop();
    const l = t.loop;
    this._toast(l ? `LOOP ${l.start + 1}–${l.end + 1} · ON` : 'LOOP OFF');
  }

  _range() {
    const l = this._tape.loop;
    return l ? { start: l.start, end: l.end } : null;
  }

  _openExport() {
    const t = this._tape;
    const r = this._range();
    const a = r ? r.start : 0;
    const b = r ? r.end : t.barCount - 1;
    const n = b - a + 1;
    const sc = this.grid.getScaleState();
    this.el.line.textContent = `${n} BARS · ${Math.round(this.grid.bpm)} BPM · ${sc.scaleLabel}${r ? ` · LOOP ${a + 1}–${b + 1}` : ''}`;
    this._returnFocus = document.activeElement;
    this.el.dlg.classList.add('on');
    // preview of the range
    const pv = this.el.pv;
    const W = pv.clientWidth || 400;
    const H = 76;
    const dpr = this._dpr || 1;
    pv.width = Math.round(W * dpr);
    pv.height = Math.round(H * dpr);
    pv.style.height = `${H}px`;
    const c = pv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const tot = n * SPB;
    c.fillStyle = 'rgba(242,242,242,0.2)';
    for (let i = 0; i <= n; i++) c.fillRect(Math.min(W - 1, (i * W) / n), 0, 1, H);
    for (let s = 0; s < tot; s++) {
      const st = t.getStep(a + Math.floor(s / SPB), s % SPB);
      if (!st) continue;
      c.fillStyle = SCRIABIN_COLORS[((st.pc % 12) + 12) % 12] || WHITE;
      c.fillRect((s * W) / tot, 4 + (5 - st.band) * 11, Math.max(1.5, W / tot), 9);
    }
    this.el.save.focus();
  }

  _closeExport(silent) {
    if (!this.el.dlg.classList.contains('on')) return;
    this.el.dlg.classList.remove('on');
    if (!silent && this._returnFocus && this._returnFocus.focus) this._returnFocus.focus();
  }

  async _save() {
    const r = this._range();
    const t = this._tape;
    const n = r ? r.end - r.start + 1 : t.barCount;
    const sc = this.grid.getScaleState();
    const d = new Date();
    const yy = String(d.getFullYear()).slice(2);
    const name = `aether-grid-${yy}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.mid`;
    const bpm = this.grid.bpm;
    this._closeExport(true);
    try {
      const m = await import('../midi/tape-export.js');
      const beat = this.el.beat.checked;
      const res = await m.saveMidi(m.tapeToMidi(t, { bpm, range: r, scaleLabel: sc.scaleLabel, beat }), name);
      if (res && res.method === 'cancelled') return;
      this._toast(`SAVED <i>${(res && res.name) || name}</i> · ${n} BARS`, true);
    } catch (err) {
      this._toast('EXPORT FAILED');
    }
  }

  _toast(text, html) {
    const t = this.el.toast;
    if (html) t.innerHTML = text;
    else t.textContent = text;
    t.classList.add('on');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('on'), 3000);
  }

  // ---------- frame ----------

  _frame(now) {
    if (!this.isOpen) return;
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    // follow the transport's cursor when something else moved it
    const gp = this._gridPos();
    if (gp !== this._gridIdx) { this._gridIdx = gp; this._ph = gp; }
    if (this._ph >= this._total) this._ph = this._total - 1;
    if (this._vel) {
      this._scroll += this._vel * dt * 60;
      this._vel *= Math.pow(0.93, dt * 60);
      if (Math.abs(this._vel) < 0.05) this._vel = 0;
      const m = this._maxScroll();
      if (this._scroll < 0 || this._scroll > m) { this._scroll = clamp(this._scroll, 0, m); this._vel = 0; }
    }
    this._syncLoop();
    this._drawEd(now);
    this._drawMini();
    this._wrapRaf();
  }

  _wrapRaf() { this._raf = requestAnimationFrame((t) => this._frame(t)); }

  // Notes, bar lines and loop of the minimap, painted into a cached layer:
  // with 256 full bars that is 4096 rects, too many to repeat every frame.
  _paintMiniLayer() {
    const W = this._mw;
    const H = MM_H;
    const lay = this._mmLayer || (this._mmLayer = document.createElement('canvas'));
    lay.width = Math.round(W * this._dpr);
    lay.height = Math.round(H * this._dpr);
    const c = lay.getContext('2d');
    c.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    const total = this._total;
    const sx = W / total;
    const rr = (H - 8) / 6;
    const loop = this._tape.loop;
    if (loop) {
      c.fillStyle = 'rgba(0,229,255,0.18)';
      c.fillRect(loop.start * SPB * sx, 0, (loop.end - loop.start + 1) * SPB * sx, H);
    }
    c.fillStyle = 'rgba(242,242,242,0.22)';
    for (let b = 0; b < this._tape.barCount; b++) c.fillRect(b * SPB * sx, 0, 1, H);
    for (let s = 0; s < total; s++) {
      const st = this._stepAt(s);
      if (!st) continue;
      c.fillStyle = SCRIABIN_COLORS[((st.pc % 12) + 12) % 12] || WHITE;
      c.fillRect(s * sx, 4 + (5 - st.band) * rr, Math.max(1.5, sx), Math.max(2, rr - 1));
    }
    this._mmDirty = false;
  }

  _drawMini() {
    const c = this._mx;
    const W = this._mw;
    const H = MM_H;
    const sx = W / this._total;
    if (this._mmDirty || !this._mmLayer) this._paintMiniLayer();
    c.clearRect(0, 0, W, H);
    c.drawImage(this._mmLayer, 0, 0, W, H);
    const vx0 = (this._scroll / this._cw) * sx;
    const vw = ((this._ew - GUT) / this._cw) * sx;
    c.fillStyle = 'rgba(0,229,255,0.12)';
    c.fillRect(vx0, 0, vw, H);
    c.strokeStyle = CYAN;
    c.lineWidth = 2;
    c.strokeRect(vx0 + 1, 1, Math.max(2, vw - 2), H - 2);
    c.fillStyle = RED;
    c.fillRect(this._ph * sx - 1, 0, 2, H);
  }

  _drawEd(now) {
    const c = this._ex;
    const W = this._ew;
    const H = this._eh;
    const rh = this._rh;
    const cw = this._cw;
    const vw = W - GUT;
    const total = this._total;
    const tape = this._tape;
    const loop = tape.loop;
    const s0 = Math.max(0, Math.floor(this._scroll / cw));
    const s1 = Math.min(total, Math.ceil((this._scroll + vw) / cw));
    const sc = this.grid.getScaleState();
    c.clearRect(0, 0, W, H);
    c.font = `20px ${FONT}`;
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.save();
    c.beginPath();
    c.rect(GUT, 0, vw, H);
    c.clip();
    for (let dr = 0; dr < 6; dr++) {
      c.fillStyle = dr % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0)';
      c.fillRect(GUT, HDR + dr * rh, vw, rh);
    }
    if (loop) {
      const x1 = this._stepX(loop.start * SPB);
      const x2 = this._stepX((loop.end + 1) * SPB);
      c.fillStyle = 'rgba(0,229,255,0.09)';
      c.fillRect(x1, HDR, x2 - x1, H - HDR);
    }
    for (const k in this._lit) {
      const a = 1 - (now - this._lit[k]) / 500;
      if (a <= 0) { delete this._lit[k]; continue; }
      c.fillStyle = `rgba(0,229,255,${a * 0.4})`;
      c.fillRect(this._stepX(+k), HDR, cw, H - HDR);
    }
    // grid lines + bar numbers
    for (let s = s0; s <= s1; s++) {
      const x = this._stepX(s);
      const bar = s % SPB === 0;
      const beat = s % 4 === 0;
      c.fillStyle = bar ? 'rgba(242,242,242,0.9)' : beat ? 'rgba(242,242,242,0.26)' : 'rgba(242,242,242,0.1)';
      c.fillRect(bar ? x - 1 : x, bar ? 0 : HDR, bar ? 3 : 1, bar ? H : H - HDR);
      if (bar && s < total) {
        const b = s / SPB;
        c.fillStyle = loop && b >= loop.start && b <= loop.end ? CYAN : WHITE;
        c.fillText(p2(b + 1), x + 7, HDR / 2);
      }
    }
    if (loop) {
      const x1 = this._stepX(loop.start * SPB) + 3;
      const x2 = this._stepX((loop.end + 1) * SPB) - 3;
      const t = `LOOP ${loop.start + 1}–${loop.end + 1}`;
      const w = c.measureText(t).width;
      c.strokeStyle = CYAN;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x1, HDR - 2); c.lineTo(x1, HDR - 7); c.lineTo(x2, HDR - 7); c.lineTo(x2, HDR - 2);
      c.stroke();
      const lx = Math.max(x1 + 4, Math.min(x2 - w - 8, W - w - 4));
      c.fillStyle = '#000';
      c.fillRect(lx - 3, 2, w + 6, HDR - 12);
      c.fillStyle = CYAN;
      c.fillText(t, lx, HDR / 2 - 2);
    }
    // hover ghost cell
    const h = this._hov;
    if (h && !this._drag && h.s >= 0 && h.s < total) {
      const st = this._stepAt(h.s);
      if (!st || st.band !== h.band) {
        const r = this._nrect(h.s, h.band);
        c.strokeStyle = 'rgba(0,229,255,0.6)';
        c.lineWidth = 1;
        c.setLineDash([3, 3]);
        c.strokeRect(r.x, r.y, r.w, r.h);
        c.setLineDash([]);
        c.fillStyle = 'rgba(0,229,255,0.7)';
        c.textAlign = 'center';
        c.fillText('+', r.x + r.w / 2, r.y + r.h / 2);
        c.textAlign = 'left';
      }
    }
    for (let i = this._ghosts.length - 1; i >= 0; i--) {
      const g = this._ghosts[i];
      const a = 1 - (now - g.t) / 350;
      if (a <= 0) { this._ghosts.splice(i, 1); continue; }
      const r = this._nrect(g.s, g.band);
      c.strokeStyle = `rgba(255,42,42,${a})`;
      c.lineWidth = 2;
      c.strokeRect(r.x - 4 * (1 - a), r.y - 4 * (1 - a), r.w + 8 * (1 - a), r.h + 8 * (1 - a));
    }
    // notes
    let stLab = null;
    for (let s = s0; s < s1; s++) {
      const st = this._stepAt(s);
      if (!st) continue;
      const r = this._nrect(s, st.band);
      let a = 1;
      if (this._stut && this._stut.s === s) {
        const fast = now - this._stut.t0 > STUTTER_FAST_MS;
        const per = fast ? 55 : 110;
        a = ((now - this._stut.t0) % per) / per < 0.5 ? 1 : 0.3;
        stLab = { r, t: fast ? '1/32' : '1/16' };
      }
      c.globalAlpha = a;
      c.fillStyle = SCRIABIN_COLORS[((st.pc % 12) + 12) % 12] || WHITE;
      c.fillRect(r.x, r.y, r.w, r.h);
      c.globalAlpha = 1;
      if (st.octave) { // octave tag: small + / - on the note
        c.font = `16px ${FONT}`;
        c.textAlign = 'center';
        c.fillStyle = '#000';
        c.fillText(st.octave > 0 ? '+' : '–', r.x + r.w / 2, r.y + 9);
        c.font = `20px ${FONT}`;
        c.textAlign = 'left';
      }
      const f = this._flash[s] ? 1 - (now - this._flash[s]) / 350 : 0;
      if (f > 0) {
        c.fillStyle = `rgba(255,255,255,${f * 0.9})`;
        c.fillRect(r.x - 3 * f, r.y - 3 * f, r.w + 6 * f, r.h + 6 * f);
      } else if (this._flash[s]) delete this._flash[s];
      if (this._lit[s] !== undefined) {
        c.fillStyle = 'rgba(255,255,255,0.7)';
        c.fillRect(r.x, r.y, r.w, r.h);
      }
      if (s === this._sel) {
        c.strokeStyle = '#fff';
        c.lineWidth = 2;
        c.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
        const b = this._xbox(s, st.band);
        c.fillStyle = '#000';
        c.fillRect(b.x, b.y, b.s, b.s);
        c.strokeStyle = '#fff';
        c.lineWidth = 1;
        c.strokeRect(b.x + 0.5, b.y + 0.5, b.s - 1, b.s - 1);
        c.fillStyle = '#fff';
        c.textAlign = 'center';
        c.fillText('×', b.x + b.s / 2, b.y + b.s / 2);
        c.textAlign = 'left';
      }
    }
    if (stLab) {
      const w = c.measureText(stLab.t).width + 8;
      const y = stLab.r.y < HDR + 22 ? stLab.r.y + stLab.r.h + 2 : stLab.r.y - 18;
      c.fillStyle = '#000';
      c.fillRect(stLab.r.x, y, w, 16);
      c.strokeStyle = RED;
      c.lineWidth = 1;
      c.strokeRect(stLab.r.x + 0.5, y + 0.5, w - 1, 15);
      c.fillStyle = RED;
      c.fillText(stLab.t, stLab.r.x + 4, y + 9);
    }
    // keyboard cursor (only while the canvas has focus)
    if (this._kfocus && this._kc) {
      const r = this._nrect(this._kc.s, this._kc.band);
      c.strokeStyle = WHITE;
      c.lineWidth = 2;
      c.setLineDash([4, 3]);
      c.strokeRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
      c.setLineDash([]);
    }
    // cursor / playhead
    const px = this._stepX(this._ph);
    if (px >= GUT - 8 && px <= W + 8) {
      c.save();
      c.shadowColor = RED;
      c.shadowBlur = 10;
      c.fillStyle = RED;
      c.fillRect(px - 1, 0, 3, H);
      c.beginPath();
      c.moveTo(px - 8, 0); c.lineTo(px + 8, 0); c.lineTo(px, 10);
      c.fill();
      c.fillRect(px - 6, HDR + rh * 3 - 14, 13, 28); // grab handle
      c.restore();
      c.fillStyle = '#000';
      for (let i = -1; i <= 1; i++) c.fillRect(px - 3, HDR + rh * 3 + i * 7 - 1, 7, 2);
      if (this._scrubbing) {
        const t = 'SCRUB';
        const w = c.measureText(t).width + 10;
        c.fillStyle = RED;
        c.fillRect(px + 10, HDR + 2, w, 18);
        c.fillStyle = '#000';
        c.fillText(t, px + 15, HDR + 11);
      }
    }
    c.restore();
    // note-name gutter (colour = Scriabin pitch class of the row)
    const names = sc.noteNames;
    const def = SCALE_DEFS[sc.scaleId] || [];
    for (let dr = 0; dr < 6; dr++) {
      const band = 5 - dr;
      c.fillStyle = '#000';
      c.fillRect(0, HDR + dr * rh, GUT - 1, rh);
      const pc = (((sc.rootIndex + (def[band] || 0)) % 12) + 12) % 12;
      c.fillStyle = SCRIABIN_COLORS[pc] || WHITE;
      c.fillText(names[band], 10, HDR + dr * rh + rh / 2);
    }
    c.fillStyle = 'rgba(242,242,242,0.5)';
    c.fillRect(GUT - 1, 0, 1, H);
    const b = clamp(Math.round(this._scroll / (SPB * cw)) + 1, 1, tape.barCount);
    const txt = `BAR ${p4(b)} / ${p4(tape.barCount)}`;
    if (txt !== this._ctrTxt) { this._ctrTxt = txt; this.el.ctr.textContent = txt; }
  }
}

// Je suis le spectre d'une rose que tu portais hier au bal. Théophile Gautier, 1837
