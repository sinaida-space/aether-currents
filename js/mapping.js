// mapping.js — the conductor: tracker -> engine -> renderer, every rAF tick.
// This is the instrument. Gesture reads happen once per frame; audio params
// are written via setTargetAtTime only when they cross an epsilon, so we
// never spam the audio thread's message/param queues.

const EPS = 1e-3;
const TAU = 0.05;
const TAU_POSITION = 0.08;
const TAU_PITCH = 0.08; // gooey portamento between quantized pitch bands

// A minor pentatonic + octave, 6 quantized bands (semitone offsets).
const SCALE = [0, 3, 5, 7, 10, 12];
const OCTAVE_COOLDOWN_MS = 600;

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

    // octave-shift gesture state (left-hand index-point rising edge)
    this._octaveShift = 0; // -1 | 0 | +1
    this._octaveArmed = true; // re-armed only after leftIndexPoint returns to null
    this._octaveCooldownUntil = 0;
    this._pitchBand = null; // last computed band index, for HUD

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

  _setParam(key, audioParamName, value) {
    const last = this._last[key];
    if (last !== null && Math.abs(value - last) < EPS) return;
    this._last[key] = value;
    const p = this.params.get(audioParamName);
    const tau = key === 'position' ? TAU_POSITION : key === 'pitch' ? TAU_PITCH : TAU;
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
      this._pitchBand = band;
      const semitones = SCALE[band] + 12 * this._octaveShift;
      const pitch = Math.max(0.25, Math.min(4, Math.pow(2, semitones / 12)));
      this._setParam('pitch', 'pitch', pitch);

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
      chordOn: gestures.chordOn,
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
