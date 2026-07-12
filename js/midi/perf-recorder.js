// perf-recorder.js — records a live performance (gesture params + beat/sample
// events, via perfBus) and exports it as a Standard MIDI File (.mid), hand-
// written with no dependencies (variable-length quantities + track chunks).
//
// ---------------------------------------------------------------------------
// CC MAP (channel 1, fixed CC numbers 20+ — also documented in the PR body):
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

import { perfBus } from './perf-bus.js';

const PPQ = 480; // ticks per quarter note
const CC_THROTTLE_MS = 1000 / 30; // ~30Hz max per param

const CC_MAP = {
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
const PARAM_RANGES = {
  position: [0, 1],
  pitch: [0.25, 4],
  grainSize: [0, 1],
  density: [4, 60],
  filterCutoff: [0, 1],
  reverbMix: [0, 1],
  chord: [0, 1],
};

function clamp127(v) {
  return Math.max(0, Math.min(127, Math.round(v)));
}

function normalizeCC(param, value) {
  const range = PARAM_RANGES[param];
  if (!range) return clamp127(value * 127);
  const [lo, hi] = range;
  const t = hi === lo ? 0 : (value - lo) / (hi - lo);
  return clamp127(t * 127);
}

// ---- variable-length quantity ---------------------------------------------
function writeVLQ(value) {
  let buffer = value & 0x7f;
  const bytes = [];
  // Build from the low 7 bits up, then reverse — standard VLQ construction.
  let v = value >>> 7;
  while (v > 0) {
    buffer = (buffer << 8) | 0x80 | (v & 0x7f);
    v >>>= 7;
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>>= 8;
    else break;
  }
  return bytes;
}

function u32be(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function u16be(n) {
  return [(n >>> 8) & 0xff, n & 0xff];
}

// Builds one MTrk chunk from a list of { tick, bytes: number[] } events,
// already sorted ascending by tick. Appends End-of-Track.
function buildTrack(events) {
  const body = [];
  let lastTick = 0;
  for (const ev of events) {
    const delta = Math.max(0, ev.tick - lastTick);
    lastTick = ev.tick;
    body.push(...writeVLQ(delta));
    body.push(...ev.bytes);
  }
  // End of track meta event, delta 0.
  body.push(...writeVLQ(0), 0xff, 0x2f, 0x00);

  return [
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    ...u32be(body.length),
    ...body,
  ];
}

function buildTempoTrack(bpm) {
  const usPerQuarter = Math.round(60000000 / Math.max(1, bpm));
  const events = [
    {
      tick: 0,
      bytes: [
        0xff, 0x51, 0x03,
        (usPerQuarter >> 16) & 0xff,
        (usPerQuarter >> 8) & 0xff,
        usPerQuarter & 0xff,
      ],
    },
  ];
  return buildTrack(events);
}

export class PerfRecorder {
  constructor({ getBpm } = {}) {
    this._getBpm = typeof getBpm === 'function' ? getBpm : () => 120;
    this.recording = false;
    this._startMs = 0;
    this._events = []; // { tick, bytes }
    this._lastCcMs = {}; // param -> last-emitted ms, for throttling
    this._lastCcValue = {}; // param -> last-emitted normalized value, skip-unchanged
    this._unsubs = [];
  }

  _msToTick(ms) {
    const bpm = this._bpmAtStart;
    const quarterMs = 60000 / bpm;
    return Math.round((ms / quarterMs) * PPQ);
  }

  _push(ms, bytes) {
    this._events.push({ tick: this._msToTick(ms), bytes });
  }

  _now() {
    return performance.now() - this._startMs;
  }

  start() {
    if (this.recording) return;
    this.recording = true;
    this._startMs = performance.now();
    this._bpmAtStart = this._getBpm() || 120;
    this._events = [];
    this._lastCcMs = {};
    this._lastCcValue = {};

    const onCc = ({ param, value }) => {
      const cc = CC_MAP[param];
      if (cc === undefined) return;
      const nowMs = this._now();
      const last = this._lastCcMs[param];
      if (last !== undefined && nowMs - last < CC_THROTTLE_MS) return;
      const norm = normalizeCC(param, value);
      if (this._lastCcValue[param] === norm) return; // skip unchanged
      this._lastCcMs[param] = nowMs;
      this._lastCcValue[param] = norm;
      // Channel 1 (status nibble 0xB0 = CC on channel index 0).
      this._push(nowMs, [0xb0, cc, norm]);
    };

    const onKick = () => this._push(this._now(), [0x99, 36, 100]); // ch10 idx9, note 36
    const onHat = () => this._push(this._now(), [0x99, 42, 90]); // ch10 idx9, note 42

    const onSampleSwitch = ({ laneIndex, on }) => {
      if (laneIndex == null) return;
      const note = (on ? 60 : 72) + Math.max(0, Math.min(3, laneIndex));
      this._push(this._now(), [0x91, note, 100]); // ch2 idx1
    };
    const onSampleMute = ({ laneIndex, muted }) => {
      if (laneIndex == null) return;
      const note = (muted ? 84 : 96) + Math.max(0, Math.min(3, laneIndex));
      this._push(this._now(), [0x91, note, 100]); // ch2 idx1
    };

    this._unsubs = [
      perfBus.on('cc', onCc),
      perfBus.on('kick', onKick),
      perfBus.on('hat', onHat),
      perfBus.on('sampleSwitch', onSampleSwitch),
      perfBus.on('sampleMute', onSampleMute),
    ];
  }

  // Stops recording and returns a Blob (audio/midi-ish) containing a type-1
  // SMF: track 0 is tempo-only, track 1 holds every captured CC/note event.
  stop() {
    if (!this.recording) return null;
    this.recording = false;
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];

    const sorted = this._events.slice().sort((a, b) => a.tick - b.tick);
    const track0 = buildTempoTrack(this._bpmAtStart);
    const track1 = buildTrack(sorted);

    const header = [
      0x4d, 0x54, 0x68, 0x64, // "MThd"
      ...u32be(6),
      ...u16be(1), // format 1
      ...u16be(2), // 2 tracks
      ...u16be(PPQ),
    ];

    const bytes = new Uint8Array([...header, ...track0, ...track1]);
    return new Blob([bytes], { type: 'audio/midi' });
  }
}
