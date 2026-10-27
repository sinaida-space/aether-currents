// tape.js — the GRID tape: a growing list of 16-step bars.
//
// Every bar that plays is kept. A step is null (silent) or one voice-2 note:
//   { band, octave, semitones, pc, pitch, grainSize, density, filterCutoff }
// band/octave are the hand's choice; semitones, pc and pitch follow from the
// scale and key that were active when the step was written, so a step sounds
// the same later even if the player changes scale.

import { SCALE_DEFS, DEFAULT_ROOT_INDEX } from '../mapping.js';

export const STEPS_PER_BAR = 16;
export const MAX_BARS = 256;
const UNDO_LIMIT = 100;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// pose: { band 0..5, octave -1..1, grainSize, density, filterCutoff }
// scale: { scaleId, rootIndex }
export function makeStep({ band, octave = 0, grainSize, density, filterCutoff }, { scaleId, rootIndex }) {
  const def = SCALE_DEFS[scaleId] || SCALE_DEFS.minorPentatonic;
  const b = clamp(Math.round(band), 0, def.length - 1);
  const o = clamp(Math.round(octave), -1, 1);
  const semitones = def[b] + (rootIndex - DEFAULT_ROOT_INDEX) + 12 * o;
  return {
    band: b,
    octave: o,
    semitones,
    pc: (((rootIndex + def[b]) % 12) + 12) % 12,
    pitch: clamp(Math.pow(2, semitones / 12), 0.25, 4),
    grainSize,
    density,
    filterCutoff,
  };
}

const emptyBar = () => new Array(STEPS_PER_BAR).fill(null);
const copyBar = (bar) => bar.map((s) => (s ? { ...s } : null));

export class Tape {
  constructor() {
    this.bars = [emptyBar()];
    this.loop = null; // null | { start, end } inclusive bar indexes
    this._listeners = new Set();
    this._undo = [];
    this._redo = [];
  }

  get barCount() {
    return this.bars.length;
  }

  getStep(bar, i) {
    const b = this.bars[bar];
    return b ? b[i] || null : null;
  }

  setStep(bar, i, step) {
    const b = this.bars[bar];
    if (!b || i < 0 || i >= STEPS_PER_BAR) return;
    b[i] = step ? { ...step } : null;
    this._emit(bar, i);
  }

  // Appends copies of the last bar until `bar` exists (capped at MAX_BARS).
  ensureBar(bar) {
    const first = this.bars.length;
    while (this.bars.length <= bar && this.bars.length < MAX_BARS) {
      this.bars.push(copyBar(this.bars[this.bars.length - 1]));
    }
    if (this.bars.length > first) this._emit(first, 0);
  }

  setLoop(start, end) {
    let s = clamp(Math.floor(start), 0, MAX_BARS - 1);
    let e = clamp(Math.floor(end), 0, MAX_BARS - 1);
    if (e < s) [s, e] = [e, s];
    this.ensureBar(e);
    this.loop = { start: s, end: Math.min(e, this.bars.length - 1) };
    this._emit(this.loop.start, 0);
  }

  clearLoop() {
    if (!this.loop) return;
    const at = this.loop.start;
    this.loop = null;
    this._emit(at, 0);
  }

  hasNotes() {
    return this.bars.some((bar) => bar.some((s) => s !== null));
  }

  noteCount() {
    let n = 0;
    for (const bar of this.bars) for (const s of bar) if (s) n++;
    return n;
  }

  // ---- undo / redo ----
  // Steps are never mutated in place (setStep stores a copy), so a snapshot
  // only copies the bar arrays and shares the step objects.

  _snapshot() {
    return { bars: this.bars.map((b) => b.slice()), loop: this.loop ? { ...this.loop } : null };
  }

  _restore(snap) {
    this.bars = snap.bars.map((b) => b.slice());
    this.loop = snap.loop ? { ...snap.loop } : null;
    this._emit(0, 0, true);
  }

  // Call before a change the player may want to take back.
  checkpoint() {
    this._undo.push(this._snapshot());
    if (this._undo.length > UNDO_LIMIT) this._undo.shift();
    this._redo.length = 0;
  }

  get canUndo() {
    return this._undo.length > 0;
  }

  undo() {
    if (!this._undo.length) return false;
    this._redo.push(this._snapshot());
    this._restore(this._undo.pop());
    return true;
  }

  redo() {
    if (!this._redo.length) return false;
    this._undo.push(this._snapshot());
    this._restore(this._redo.pop());
    return true;
  }

  // ---- autosave format: notes only, one [index, ...values] entry per step ----

  toJSON() {
    return {
      v: 1,
      loop: this.loop,
      bars: this.bars.map((bar) => {
        const out = [];
        bar.forEach((s, i) => {
          if (s) out.push([i, s.band, s.octave, s.semitones, s.pc, s.pitch, s.grainSize, s.density, s.filterCutoff]);
        });
        return out;
      }),
    };
  }

  // Replaces the tape with saved data (checked value by value); false when
  // the data is unusable. The current tape goes on the undo stack first.
  load(data) {
    if (!data || data.v !== 1 || !Array.isArray(data.bars) || !data.bars.length) return false;
    const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) ? clamp(v, lo, hi) : null);
    const bars = [];
    for (const raw of data.bars.slice(0, MAX_BARS)) {
      const bar = emptyBar();
      if (Array.isArray(raw)) {
        for (const e of raw) {
          if (!Array.isArray(e) || e.length < 9) continue;
          const i = num(e[0], 0, STEPS_PER_BAR - 1);
          const step = {
            band: num(e[1], 0, 5),
            octave: num(e[2], -1, 1),
            semitones: num(e[3], -48, 48),
            pc: num(e[4], 0, 11),
            pitch: num(e[5], 0.25, 4),
            grainSize: num(e[6], 0.02, 0.5),
            density: num(e[7], 1, 80),
            filterCutoff: num(e[8], 100, 18000),
          };
          if (i === null || Object.values(step).some((v) => v === null)) continue;
          step.band = Math.round(step.band);
          step.octave = Math.round(step.octave);
          bar[Math.round(i)] = step;
        }
      }
      bars.push(bar);
    }
    this.checkpoint();
    this.bars = bars;
    const l = data.loop;
    const s = l ? num(l.start, 0, bars.length - 1) : null;
    const e = l ? num(l.end, 0, bars.length - 1) : null;
    this.loop = s !== null && e !== null ? { start: Math.min(s, e) | 0, end: Math.max(s, e) | 0 } : null;
    this._emit(0, 0, true);
    return true;
  }

  // cb({ bar, step, reset }) -> unsubscribe. Loop and growth changes report
  // the first affected bar with step 0; undo, redo and load report reset.
  onChange(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  _emit(bar, step, reset = false) {
    for (const cb of this._listeners) cb({ bar, step, reset });
  }
}

// Je suis le spectre d'une rose que tu portais hier au bal. Théophile Gautier, 1837
