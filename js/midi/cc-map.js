// cc-map.js — shared MIDI CC/note mapping constants, extracted so
// perf-recorder.js (offline .mid export) and live-out.js (live Web MIDI
// output) share one byte-for-byte identical scheme. A recorded .mid and
// the live stream must always be interchangeable — see docs/midi.md.
//
// ---------------------------------------------------------------------------
// CC MAP (channel 1, fixed CC numbers 20+ — also documented in docs/midi.md):
//   CC20  position       (0..1        -> 0..127)
//   CC21  pitch           (0.25..4x   -> 0..127, log-ish already handled by
//                          mapping.js; we just linearly rescale the raw value)
//   CC22  grainSize       (0..1        -> 0..127)
//   CC23  density         (4..60      -> 0..127)
//   CC24  filterCutoff    (0..1        -> 0..127)
//   CC25  reverbMix       (0..1        -> 0..127)
//   CC26  chord           (0/1         -> 0/127)
//
// Discrete events:
//   channel 10 (index 9)  note-on 36 = beat kick, 42 = beat hi-hat
//   channel 2  (index 1)  note-on 60+laneIndex = sample switched on
//                                    72+laneIndex = sample switched off
//                                    84+laneIndex = sample mute toggled on
//                                    96+laneIndex = sample mute toggled off
// ---------------------------------------------------------------------------

export const CC_THROTTLE_MS = 1000 / 30; // ~30Hz max per param

export const CC_MAP = {
  position: 20,
  pitch: 21,
  grainSize: 22,
  density: 23,
  filterCutoff: 24,
  reverbMix: 25,
  chord: 26,
};

// Rough per-param normalization ranges so values fit 0..127 sensibly.
// (position/grainSize/filterCutoff/reverbMix/chord are already 0..1.)
export const PARAM_RANGES = {
  position: [0, 1],
  pitch: [0.25, 4],
  grainSize: [0, 1],
  density: [4, 60],
  filterCutoff: [0, 1],
  reverbMix: [0, 1],
  chord: [0, 1],
};

export function clamp127(v) {
  return Math.max(0, Math.min(127, Math.round(v)));
}

export function normalizeCC(param, value) {
  const range = PARAM_RANGES[param];
  if (!range) return clamp127(value * 127);
  const [lo, hi] = range;
  const t = hi === lo ? 0 : (value - lo) / (hi - lo);
  return clamp127(t * 127);
}
