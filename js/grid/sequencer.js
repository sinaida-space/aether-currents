// sequencer.js — GRID transport: a tape recorder around voice 2.
//
// PLAY: every bar is kept on the tape (js/grid/tape.js). The left hand writes
// into the bar under the playhead; at each bar boundary the next bar is either
// a copy of the last one (the tape grows), the loop start, or bar 0 at
// MAX_BARS. EDIT: beat, grid and voice 1 are paused; the tape can be scrubbed,
// stuttered and resumed from any bar.
//
// Clock: no clock of its own. The beat scheduler calls onStep8 for every 8th
// it schedules; each 8th becomes two 16ths here, so the grid shares the
// beat's lookahead and tempo changes exactly (step8 0 = start of the bar).
// Params are scheduled with setValueAtTime at the exact step time; nothing is
// ever scheduled from requestAnimationFrame.
//
// "Time is the cursor": while armed === 'write', the pose handed to
// setInput() lands in the step that is sounding right now; 'erase' clears it.
// A write is heard on the next pass of the bar.

import { perfBus } from '../midi/perf-bus.js';
import { Tape, makeStep, STEPS_PER_BAR, MAX_BARS } from './tape.js';
import { SCALE_DEFS, SCALE_LABELS, ROOT_KEYS, DEFAULT_ROOT_INDEX } from '../mapping.js';

export const GRID_STEPS = STEPS_PER_BAR; // one bar of 16ths

// Left-pinch write gate, shared by play (main.js feedGrid) and the GRID
// tutorial so a step only passes with a pinch that really writes.
export const WRITE_PINCH_ON = 0.7;
export const WRITE_PINCH_OFF = 0.5;

// Next write state from the last one: on above WRITE_PINCH_ON, off below
// WRITE_PINCH_OFF or when the left hand is not in view.
export function writeGate(wasOn, leftPinch, leftInView) {
  if (!leftInView) return false;
  if (leftPinch > WRITE_PINCH_ON) return true;
  if (leftPinch < WRITE_PINCH_OFF) return false;
  return wasOn;
}

const TIMER_MS = 25; // housekeeping only: BEAT-off detection, log trimming
const GATE_LEVEL = 0.8; // voice-2 gain while a step sounds
const GATE_ATTACK_TAU = 0.008;
const GATE_RELEASE_TAU = 0.02;
const GATE_RELEASE_AT = 0.85; // fraction of the step before the gate closes
const SCRUB_GATE_S = 0.12; // a scrubbed step sounds this long
const STUTTER_GATE = 0.7; // fraction of the stutter period the gate stays open
const MIDI_BASE_NOTE = 57; // A3

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class GridTransport {
  // getScale: () => ({ scaleId, rootIndex }); setVoice1Muted: (bool) => void
  constructor({ engine, tape = new Tape(), getScale = null, setVoice1Muted = null }) {
    this.engine = engine;
    this.tape = tape;
    this.mode = 'play'; // 'play' | 'edit'
    this.armed = null; // 'write' | 'erase' | null
    this.running = false;
    // Optional (stepIndex, audioTime, bar) callback, fired as each step is scheduled.
    this.onStep = null;
    // Optional ({ steps }) callback, fired when an erase run in PLAY ends.
    this.onErase = null;
    this._eraseRun = null;

    this._getScale = getScale || (() => ({ scaleId: 'minorPentatonic', rootIndex: DEFAULT_ROOT_INDEX }));
    this._setVoice1Muted = setVoice1Muted;
    this._timer = null;
    this._beatWasOn = false;
    this._played = []; // [{ time, bar, step }] scheduled, newest last; drives playhead
    this._startBar = 0;
    this._bar = 0; // bar of the latest scheduled step
    this._lastBar8 = null;
    this._lastStep8 = -1;
    this._last = { bar: 0, step: 0 }; // last sounding position
    this._cursor = { bar: 0, step: 0 }; // EDIT cursor
    this._stutter = null;
    this._modeListeners = new Set();
  }

  get _beat() {
    return this.engine._beat;
  }

  get bpm() {
    return this.engine.getBeatPhase().bpm;
  }

  getScaleState() {
    const { scaleId, rootIndex } = this._getScale();
    const def = SCALE_DEFS[scaleId] || SCALE_DEFS.minorPentatonic;
    return {
      scaleId,
      rootIndex,
      scaleLabel: SCALE_LABELS[scaleId] || '',
      noteNames: def.map((o) => ROOT_KEYS[(((rootIndex + o) % 12) + 12) % 12]),
    };
  }

  // The scheduled entry sounding right now, or null.
  _sounding() {
    if (!this.running || !this._beat.running) return null;
    const now = this.engine.ctx.currentTime;
    let cur = null;
    for (const e of this._played) {
      if (e.time <= now) cur = e;
      else break;
    }
    return cur;
  }

  // PLAY: the step sounding now (the last one while nothing sounds yet).
  // EDIT: the cursor. Derived from what was scheduled, not wall time.
  get playhead() {
    if (this.mode === 'edit') return { ...this._cursor };
    const cur = this._sounding();
    if (cur) this._last = { bar: cur.bar, step: cur.step };
    return { ...this._last };
  }

  // Step index sounding right now (0..15), or -1 when not running or the beat is off.
  get currentStep() {
    const cur = this._sounding();
    return cur ? cur.step : -1;
  }

  get currentBar() {
    const cur = this._sounding();
    return cur ? cur.bar : -1;
  }

  onModeChange(cb) {
    this._modeListeners.add(cb);
    return () => this._modeListeners.delete(cb);
  }

  _setMode(mode) {
    this.mode = mode;
    for (const cb of this._modeListeners) cb(mode);
  }

  start() {
    if (this.running) return;
    const params = this.engine.mediumParams;
    if (params) {
      const t = this.engine.ctx.currentTime;
      params.get('gain').cancelScheduledValues(t);
      params.get('gain').setValueAtTime(0, t);
    }
    this.running = true;
    this._played.length = 0;
    this._bar = this._startBar;
    this._lastBar8 = null;
    this._lastStep8 = -1;
    this._last = { bar: this._startBar, step: 0 };
    this._beatWasOn = this._beat.running;
    this._beat.onStep8 = (step8, t, sec8th) => this._onBeatStep(step8, t, sec8th);
    this._tick();
    this._timer = setInterval(() => this._tick(), TIMER_MS);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this._beat.onStep8 = null;
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._played.length = 0;
    this.armed = null;
    this._closeGate(this.engine.ctx.currentTime);
  }

  // ---- EDIT ----------------------------------------------------------------

  // Pauses beat + grid and silences voice 1; voice 2 stays for scrub/stutter.
  enterEdit() {
    if (this.mode === 'edit') return;
    const ph = this.playhead;
    this._endEraseRun();
    this.stop();
    this.engine.setBeat(false);
    this._cursor = { bar: ph.bar, step: ph.step };
    this.armed = null;
    if (this._setVoice1Muted) this._setVoice1Muted(true);
    this._setMode('edit');
  }

  // Plays again from `fromBar`, step 0, on a fresh beat bar.
  exitEdit(fromBar = this._cursor.bar) {
    if (this.mode !== 'edit') return;
    this.stutterStop();
    this._closeGate(this.engine.ctx.currentTime);
    const bar = clamp(Math.floor(fromBar) || 0, 0, this.tape.barCount - 1);
    if (this._setVoice1Muted) this._setVoice1Muted(false);
    this._startBar = bar;
    this._cursor = { bar, step: 0 };
    this._setMode('play');
    // The hook goes in before the beat starts so step8 0 is not missed.
    if (this._beat.running) this.engine.setBeat(false);
    this.start();
    Promise.resolve(this.engine.setBeat(true)).catch((err) => {
      console.error('[AETHER CURRENTS] beat restart failed:', err);
    });
  }

  // EDIT only: move the cursor and sound that step briefly.
  scrubTo(bar, step) {
    if (this.mode !== 'edit') return;
    const b = clamp(Math.floor(bar) || 0, 0, this.tape.barCount - 1);
    const s = clamp(Math.floor(step) || 0, 0, STEPS_PER_BAR - 1);
    this._cursor = { bar: b, step: s };
    const st = this.tape.getStep(b, s);
    if (!st) return;
    const now = this.engine.ctx.currentTime;
    this._applyStep(st, now);
    this._openGate(now, SCRUB_GATE_S);
  }

  // EDIT only: retrigger a step at 1/16 (60/bpm/4) or 1/32 (60/bpm/8).
  stutterStart(bar, step, rate = '1/16') {
    if (this.mode !== 'edit') return;
    this.stutterStop();
    const b = clamp(Math.floor(bar) || 0, 0, this.tape.barCount - 1);
    const s = clamp(Math.floor(step) || 0, 0, STEPS_PER_BAR - 1);
    this._cursor = { bar: b, step: s };
    const period = 60 / this.bpm / (rate === '1/32' ? 8 : 4);
    const fire = () => {
      const st = this.tape.getStep(b, s);
      if (!st) return;
      const now = this.engine.ctx.currentTime;
      this._applyStep(st, now);
      this._openGate(now, period * STUTTER_GATE);
    };
    fire();
    this._stutter = setInterval(fire, period * 1000);
  }

  stutterStop() {
    if (this._stutter === null) return;
    clearInterval(this._stutter);
    this._stutter = null;
    this._closeGate(this.engine.ctx.currentTime);
  }

  // ---- PLAY ----------------------------------------------------------------

  // write / erase: booleans (erase wins). pose: { band, octave, grainSize,
  // density, filterCutoff } from the mapper, or null. Ignored in EDIT.
  setInput({ write = false, erase = false, pose = null } = {}) {
    if (this.mode !== 'play') {
      this.armed = null;
      this._endEraseRun();
      return;
    }
    this.armed = erase ? 'erase' : write ? 'write' : null;
    if (this.armed !== 'erase') this._endEraseRun();
    const cur = this._sounding();
    if (!cur) return;
    if (this.armed === 'erase') {
      if (this.tape.getStep(cur.bar, cur.step)) {
        // one undo snapshot per erase run, taken before its first cleared step
        if (!this._eraseRun) {
          this.tape.checkpoint();
          this._eraseRun = { steps: 0 };
        }
        this._eraseRun.steps++;
        this.tape.setStep(cur.bar, cur.step, null);
      }
    } else if (this.armed === 'write' && pose && typeof pose.band === 'number') {
      this.tape.setStep(cur.bar, cur.step, makeStep(pose, this._getScale()));
    }
  }

  // An erase run ends when the fist opens (or EDIT starts); onErase hears
  // how many steps it cleared.
  _endEraseRun() {
    const run = this._eraseRun;
    if (!run) return;
    this._eraseRun = null;
    if (this.onErase) this.onErase(run);
  }

  // Next bar after `bar` in playback order (loop and MAX_BARS aware).
  _nextBar(bar) {
    const n = bar + 1;
    const loop = this.tape.loop;
    if (loop && n > loop.end) return loop.start;
    if (n >= MAX_BARS) return 0;
    return n;
  }

  // One beat-scheduler 8th = two grid 16ths.
  _onBeatStep(step8, t, sec8th) {
    if (!this.running) return;
    const bar8 = Math.floor(step8 / 8);
    if (this._lastBar8 === null || step8 < this._lastStep8) {
      this._bar = this._startBar; // first step, or the beat restarted
    } else if (bar8 !== this._lastBar8) {
      this._bar = this._nextBar(this._bar);
      this.tape.ensureBar(this._bar);
    }
    this._lastBar8 = bar8;
    this._lastStep8 = step8;
    const half = sec8th / 2;
    const index = (step8 % 8) * 2;
    this._schedule(this._bar, index, t, half);
    this._schedule(this._bar, index + 1, t + half, half);
  }

  _tick() {
    if (!this.running) return;
    const ph = this.playhead; // refreshes the last sounding position
    const beatOn = this._beat.running;
    if (this._beatWasOn && !beatOn) {
      // BEAT toggled off: drop pending steps and close the gate; the beat
      // scheduler restarts at step8 0 (bar start) when it comes back, and
      // the tape resumes from the bar we stopped in.
      this._startBar = ph.bar;
      this._closeGate(this.engine.ctx.currentTime);
      this._played.length = 0;
      this._lastBar8 = null;
    }
    this._beatWasOn = beatOn;
    // Keep the played log short.
    const now = this.engine.ctx.currentTime;
    while (this._played.length > 2 && this._played[1].time <= now) this._played.shift();
  }

  // The step that follows (bar, index) in playback order.
  _stepAfter(bar, index) {
    if (index < STEPS_PER_BAR - 1) return this.tape.getStep(bar, index + 1);
    const nb = this._nextBar(bar);
    return this.tape.getStep(nb < this.tape.barCount ? nb : bar, 0); // a new bar starts as a copy
  }

  _schedule(bar, index, t, dur) {
    this._played.push({ time: t, bar, step: index });
    if (this.onStep) this.onStep(index, t, bar);
    const step = this.tape.getStep(bar, index);
    const params = this.engine.mediumParams;
    if (!step || !params) return;

    this._applyStep(step, t);

    // Gate: open at step start; close late in the step unless the next step
    // sounds too (consecutive steps hold = legato).
    const gain = params.get('gain');
    gain.setTargetAtTime(GATE_LEVEL, t, GATE_ATTACK_TAU);
    if (!this._stepAfter(bar, index)) {
      gain.setTargetAtTime(0, t + GATE_RELEASE_AT * dur, GATE_RELEASE_TAU);
    }

    perfBus.emit('gridNote', {
      note: Math.max(0, Math.min(127, Math.round(MIDI_BASE_NOTE + step.semitones))),
      step,
      bar,
      index,
    });
  }

  _applyStep(step, t) {
    const params = this.engine.mediumParams;
    if (!params) return;
    params.get('pitch').setValueAtTime(step.pitch, t);
    params.get('grainSize').setValueAtTime(step.grainSize, t);
    params.get('density').setValueAtTime(step.density, t);
    params.get('filterCutoff').setValueAtTime(step.filterCutoff, t);
  }

  // Open the voice-2 gate at t and close it again `holdS` seconds later.
  _openGate(t, holdS) {
    const params = this.engine.mediumParams;
    if (!params) return;
    const gain = params.get('gain');
    gain.cancelScheduledValues(t);
    gain.setTargetAtTime(GATE_LEVEL, t, GATE_ATTACK_TAU);
    gain.setTargetAtTime(0, t + holdS, GATE_RELEASE_TAU);
  }

  _closeGate(t) {
    const params = this.engine.mediumParams;
    if (!params) return;
    const gain = params.get('gain');
    gain.cancelScheduledValues(t);
    gain.setTargetAtTime(0, t, GATE_RELEASE_TAU);
  }
}

// Alias for modules that import the transport by this name.
export { GridTransport as GridSequencer };

// Je suis le spectre d'une rose que tu portais hier au bal. Théophile Gautier, 1837
