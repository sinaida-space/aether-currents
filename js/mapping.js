// mapping.js — the conductor: tracker -> engine -> renderer, every rAF tick.
// This is the instrument. Gesture reads happen once per frame; audio params
// are written via setTargetAtTime only when they cross an epsilon, so we
// never spam the audio thread's message/param queues.

import { perfBus } from './midi/perf-bus.js';

const EPS = 1e-3;
const TAU = 0.04; // was 0.05 — trimmed for latency (task 5); still glitch-safe
const TAU_POSITION = 0.06; // was 0.08 — trimmed for latency; playhead motion stays audibly smooth
// Pitch portamento: quantized-band changes should feel like a note attack, not
// a glide, so they get a much shorter time constant. Octave-shift transitions
// (same band, different octave) keep the old gooey tau since a bare semitone
// jump of 12 without any smoothing pops audibly.
const TAU_PITCH_SNAP = 0.025; // band change — snap-fast (task 5 spec)
const TAU_PITCH_GLIDE = 0.08; // same-band re-writes (octave shift) — original portamento

// Scale library — 6 quantized bands each (semitone offsets from root).
// minorPentatonic is the original A minor pentatonic pattern, unchanged.
// naturalMinor drops the 6th degree (keeps 1,2,b3,4,5,b7+octave) to fit
// 6 bands while still reading clearly as "minor" against the pentatonics/blues.
export const SCALE_DEFS = {
  minorPentatonic: [0, 3, 5, 7, 10, 12],
  blues: [0, 3, 5, 6, 7, 10],
  majorPentatonic: [0, 2, 4, 7, 9, 12],
  naturalMinor: [0, 2, 3, 5, 7, 10],
};
export const SCALE_IDS = ['minorPentatonic', 'blues', 'majorPentatonic', 'naturalMinor'];
export const SCALE_LABELS = {
  minorPentatonic: 'MIN PENT',
  blues: 'BLUES',
  majorPentatonic: 'MAJ PENT',
  naturalMinor: 'NAT MIN',
};
// Chromatic root names, C=0 .. B=11 (standard pitch-class order).
export const ROOT_KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const DEFAULT_ROOT_INDEX = 9; // 'A' — matches the original hardcoded A minor pentatonic exactly.

const OCTAVE_COOLDOWN_MS = 600;
const CHORD_ARP_HOLD_MS = 300; // left-hand 3-finger hold to flip chord<->arp

// ---- exponential interpolation helpers ----------------------------------
// lerp(a, b, t) in log-space: a * (b/a)^t
function expLerp(a, b, t) {
  if (a <= 0) a = 1e-4;
  if (b <= 0) b = 1e-4;
  return a * Math.pow(b / a, t);
}

export class Mapper {
  constructor({ engine, tracker, renderer, mode, sampleName }) {
    this.engine = engine;
    this.tracker = tracker;
    this.renderer = renderer;
    this.mode = mode;
    this.sampleName = sampleName;

    this.ctx = engine.ctx;
    this.params = engine.node.parameters;

    // last-written values, to gate setTargetAtTime calls behind an epsilon.
    this._last = {
      position: null,
      pitch: null,
      grainSize: null,
      density: null,
      filterCutoff: null,
      reverbMix: null,
      gain: null,
      chord: null,
    };

    this._frozen = false;
    this._prevBurstCount = 0;

    // debug instrumentation (issue #20) — optional refs wired in by main.js
    this.recorder = null; // Recorder instance, for encodeQueueSize
    this.recordState = null; // { error, errorUntil } shared object from main.js
    this._latencySamples = [];

    // octave-shift gesture state (left-hand index-point rising edge)
    this._octaveShift = 0; // -1 | 0 | +1
    this._octaveArmed = true; // re-armed only after leftIndexPoint returns to null
    this._octaveCooldownUntil = 0;

    this._chordArp = false; // false = simultaneous dyad, true = legacy alternating arpeggio
    this._chordArpArmed = true; // re-armed only once left 3-finger pose releases
    this._chordArpHoldSince = null;
    this._pitchBand = null; // committed/sounding band index, for HUD

    // beat-snap pitch state (task 7): while engine.beatOn, band changes hold
    // until the next 8th-note boundary, then commit the latest band seen.
    this._committedBand = null; // band currently written to the audio param
    this._pendingBand = null; // latest band the hand has moved to since last commit
    this._last8thIndex = null; // absolute 8th-note grid index, to detect boundary crossings

    // scale + key state — defaults reproduce the original hardcoded A minor
    // pentatonic exactly. Persisted/set from main.js (localStorage), like
    // bgMode/osdOn.
    this._scaleId = 'minorPentatonic';
    this._rootKeyIndex = DEFAULT_ROOT_INDEX;

    // held two-hand values (persist when only one hand present)
    this._heldCutoff = 8000;
    this._heldReverb = 0.35;

    // idle-ease state
    this._handsPresent = true;

    this.recording = false;
    this._lastT = performance.now();

    this._rafHandle = null;
    this._running = false;

    this._boundTick = this._tick.bind(this);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastT = performance.now();
    this._rafHandle = requestAnimationFrame(this._boundTick);
  }

  stop() {
    this._running = false;
    if (this._rafHandle != null) cancelAnimationFrame(this._rafHandle);
    this._rafHandle = null;
  }

  setSampleName(name) {
    this.sampleName = name;
  }

  // ---- scale + key -------------------------------------------------------

  setScale(id) {
    if (SCALE_DEFS[id]) this._scaleId = id;
  }

  cycleScale() {
    const i = SCALE_IDS.indexOf(this._scaleId);
    this.setScale(SCALE_IDS[(i + 1) % SCALE_IDS.length]);
  }

  getScaleId() {
    return this._scaleId;
  }

  setRootKey(index) {
    this._rootKeyIndex = ((index % 12) + 12) % 12;
  }

  cycleRootKey() {
    this.setRootKey(this._rootKeyIndex + 1);
  }

  getRootKeyIndex() {
    return this._rootKeyIndex;
  }

  // Live note names for the active scale+key, one per band (low->high).
  _noteNames() {
    const def = SCALE_DEFS[this._scaleId];
    return def.map((offset) => ROOT_KEYS[(this._rootKeyIndex + offset) % 12]);
  }

  _setParam(key, audioParamName, value, tauOverride) {
    const last = this._last[key];
    if (last !== null && Math.abs(value - last) < EPS) return;
    this._last[key] = value;
    // Task 5 — publish every genuinely-changed gesture param onto perfBus;
    // perf-recorder.js (when armed) throttles this to ~30Hz and maps it to
    // a fixed CC number. No-op when nothing is subscribed.
    perfBus.emit('cc', { param: key, value });
    const p = this.params.get(audioParamName);
    const tau =
      tauOverride !== undefined
        ? tauOverride
        : key === 'position'
          ? TAU_POSITION
          : key === 'pitch'
            ? TAU_PITCH_GLIDE
            : TAU;
    p.setTargetAtTime(value, this.ctx.currentTime, tau);
  }

  _tick(nowMs) {
    if (!this._running) return;
    const dt = Math.max((nowMs - this._lastT) / 1000, 0.001);
    this._lastT = nowMs;

    const state = this.tracker.getState();
    const { hands, gestures } = state;

    // --- freeze ---
    if (gestures.freeze !== this._frozen) {
      this._frozen = gestures.freeze;
      this.engine.freeze(this._frozen);
    }

    // --- octave shift (left-hand index-point rising edge, 600ms cooldown) ---
    // Re-arms only once leftIndexPoint returns to null, so a held point
    // triggers one shift, not a repeat-fire.
    const lip = gestures.leftIndexPoint;
    if (lip == null) {
      this._octaveArmed = true;
    } else if (this._octaveArmed && nowMs >= this._octaveCooldownUntil) {
      const delta = lip === 'up' ? 1 : -1;
      this._octaveShift = Math.max(-1, Math.min(1, this._octaveShift + delta));
      this._octaveCooldownUntil = nowMs + OCTAVE_COOLDOWN_MS;
      this._octaveArmed = false;
    }

    // --- chord/arp toggle (left-hand 3-finger pose held 300ms, edge-triggered) ---
    // Distinct hand+timing from the right-hand chordOn (which just enables the
    // dyad), so playing a right-hand chord never accidentally flips the mode.
    const lfc = gestures.leftFingerCount;
    if (lfc !== 3) {
      this._chordArpArmed = true;
      this._chordArpHoldSince = null;
    } else {
      if (this._chordArpHoldSince == null) this._chordArpHoldSince = nowMs;
      if (this._chordArpArmed && nowMs - this._chordArpHoldSince >= CHORD_ARP_HOLD_MS) {
        this._chordArp = !this._chordArp;
        this.engine.setChordMode(this._chordArp);
        this._chordArpArmed = false;
      }
    }

    // --- position (right.x) + quantized pitch band (right.y) ---
    // Freeze holds only the playhead position; pitch stays live so the
    // frozen cloud can still be bent (engine contract, issue #2).
    if (hands.right) {
      if (!this._frozen) {
        const position = Math.max(0, Math.min(1, hands.right.x));
        this._setParam('position', 'position', position);
      }
      const y = Math.max(0, Math.min(1, hands.right.y));
      const band = Math.min(5, Math.floor((1 - y) * 6)); // top(y=0)->band5 (highest)

      if (!this.engine.beatOn) {
        // free-running (task 5 snap-fast behavior): band commits instantly.
        this._committedBand = band;
        this._pendingBand = null;
        this._last8thIndex = null; // re-init cleanly if BEAT re-engages later
      } else {
        this._pendingBand = band;
        if (this._committedBand == null) this._committedBand = band; // first frame under BEAT
        const bp = this.engine.getBeatPhase(); // { bpm, phase (0..1 within beat), beatIndex }
        const phase = bp && bp.phase != null ? bp.phase : 0;
        const beatIndex = bp && bp.beatIndex != null ? bp.beatIndex : 0;
        // 8 subdivisions/beat -> absolute 8th-note grid index since beat start.
        const idx8 = beatIndex * 8 + Math.floor(phase * 8 + 1e-9);
        if (this._last8thIndex == null) {
          // Just started tracking (BEAT freshly on, or first tick) — don't
          // force a commit mid-gesture; wait for the next real boundary.
          this._last8thIndex = idx8;
        } else if (idx8 !== this._last8thIndex) {
          this._last8thIndex = idx8;
          this._committedBand = this._pendingBand; // commit the latest band seen
        }
      }

      const bandChanged = this._pitchBand !== null && this._committedBand !== this._pitchBand;
      this._pitchBand = this._committedBand; // HUD: committed/sounding band
      const rootOffset = this._rootKeyIndex - DEFAULT_ROOT_INDEX; // transposes vs. the original A-rooted scale
      const semitones = SCALE_DEFS[this._scaleId][this._committedBand] + rootOffset + 12 * this._octaveShift;
      const pitch = Math.max(0.25, Math.min(4, Math.pow(2, semitones / 12)));
      // Snap-fast on a band change (new note = attack), glide within the same
      // band (octave-shift re-write only) to avoid an audible pop (task 5).
      this._setParam('pitch', 'pitch', pitch, bandChanged ? TAU_PITCH_SNAP : TAU_PITCH_GLIDE);

      // --- chord (3 extended right-hand fingers -> perfect-5th alternation) ---
      this._setParam('chord', 'chord', gestures.chordOn ? 1 : 0);
    }

    // --- grain size (right pinch, exponential 0.25s open -> 0.03s pinched) ---
    if (hands.right) {
      const pinch = Math.max(0, Math.min(1, gestures.pinch));
      const grainSize = expLerp(0.25, 0.03, pinch);
      this._setParam('grainSize', 'grainSize', grainSize);
    }

    // --- density (left.y, exponential, bottom=4 top=60) — overridden by idle ease below ---
    let densityFromHand = null;
    if (hands.left) {
      const y = Math.max(0, Math.min(1, hands.left.y));
      // top (y=0) -> 60, bottom (y=1) -> 4
      densityFromHand = expLerp(4, 60, 1 - y);
    }

    // --- two-hand distance -> filterCutoff + reverbMix (hold last if one hand only) ---
    if (gestures.twoHandDistance != null) {
      const d = Math.max(0, Math.min(1, gestures.twoHandDistance));
      this._heldCutoff = expLerp(800, 16000, d);
      this._heldReverb = 0.15 + d * (0.55 - 0.15);
    }
    this._setParam('filterCutoff', 'filterCutoff', this._heldCutoff);
    this._setReverb(this._heldReverb);

    // --- burst ---
    if (gestures.burstCount !== this._prevBurstCount) {
      this._prevBurstCount = gestures.burstCount;
      this.engine.burst();
    }

    // --- no-hands idle bed vs. active density/gain ---
    const anyHand = !!(hands.left || hands.right);
    const targetDensity = anyHand ? (densityFromHand != null ? densityFromHand : this._last.density || 12) : 6;
    const targetGain = anyHand ? 0.8 : 0.35;

    // ease density/gain over ~2s (one-pole toward target, tau ~= 2s/3)
    const easeTau = 2 / 3;
    const alpha = 1 - Math.exp(-dt / easeTau);
    const curDensity = this._last.density != null ? this._last.density : targetDensity;
    const easedDensity = anyHand && densityFromHand != null
      ? densityFromHand // direct control when hand present
      : curDensity + (targetDensity - curDensity) * alpha;
    this._setParam('density', 'density', easedDensity);

    const curGain = this._last.gain != null ? this._last.gain : targetGain;
    const easedGain = curGain + (targetGain - curGain) * alpha;
    this._setParam('gain', 'gain', easedGain);

    this._handsPresent = anyHand;

    // --- motion->sound latency estimate (proxy: gesture-result timestamp to
    // this setTargetAtTime-driving tick; not a measurement of the real audio
    // graph, no AudioParam read-back exists) ---
    const latencyMs = this.tracker.lastResultTs != null
      ? Math.max(0, nowMs - this.tracker.lastResultTs)
      : null;
    if (latencyMs != null) {
      this._latencySamples.push(latencyMs);
      if (this._latencySamples.length > 60) this._latencySamples.shift();
    }
    const latencyMaxMs = this._latencySamples.length
      ? Math.max(...this._latencySamples)
      : null;

    // --- build renderer state ---
    const beatPhase = this.engine.getBeatPhase();
    const rendererState = {
      hands,
      audio: {
        level: this.engine.getLevel(),
        centroid: this.engine.getCentroid(),
      },
      octaveShift: this._octaveShift,
      pitchBand: this._pitchBand,
      pendingPitchBand:
        this.engine.beatOn && this._pendingBand != null && this._pendingBand !== this._committedBand
          ? this._pendingBand
          : null,
      scaleId: this._scaleId,
      scaleLabel: SCALE_LABELS[this._scaleId],
      rootKeyName: ROOT_KEYS[this._rootKeyIndex],
      noteNames: this._noteNames(),
      chordOn: gestures.chordOn,
      chordArp: this._chordArp,
      beatOn: this.engine.beatOn,
      beatPhase,
      params: {
        position: this._last.position != null ? this._last.position : 0.25,
        pitch: this._last.pitch != null ? this._last.pitch : 1,
        grainSize: this._last.grainSize != null ? this._last.grainSize : 0.09,
        density: this._last.density != null ? this._last.density : 12,
        space: this._heldReverb, // 0..1, used by renderer for feedback decay shaping
      },
      frozen: this._frozen,
      burstCount: gestures.burstCount,
      modeLabel: this.mode === 'full' ? 'FULL MODE' : 'LIGHT MODE',
      sampleName: this.sampleName,
      recording: this.recording,
      trackingFps: this.tracker.trackingFps,
      stale: state.stale,
      latencyMs,
      latencyMaxMs,
      encodeQueueSize: this.recorder ? this.recorder.encodeQueueSize : 0,
      recordError: this.recordState ? this.recordState.error : null,
      recordErrorUntil: this.recordState ? this.recordState.errorUntil : 0,
    };

    this.renderer.frame(dt, rendererState);

    this._rafHandle = requestAnimationFrame(this._boundTick);
  }

  _setReverb(target) {
    const last = this._last.reverbMix;
    if (last !== null && Math.abs(target - last) < EPS) return;
    this._last.reverbMix = target;
    this.engine.reverbMix = target;
  }
}
