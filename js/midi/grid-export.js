// grid-export.js — exports the 16-step grid loop as a one-bar Standard MIDI
// File (type 0). Per non-null step: CC 22/23/24 (grainSize, density,
// filterCutoff) then a note lasting one sixteenth, all on channel 3.

import { PPQ, buildTrack, u32be, u16be } from './perf-recorder.js';

const GRID_STEPS = 16;
const STEP_TICKS = PPQ / 4; // one sixteenth
const cc7 = (v) => Math.max(0, Math.min(127, Math.round(v)));

export function gridToMidi(steps, { bpm } = {}) {
  const usPerQuarter = Math.round(60000000 / Math.max(1, bpm || 120));
  const events = [
    { tick: 0, bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] },
  ];
  for (let i = 0; i < GRID_STEPS; i++) {
    const st = steps && steps[i];
    if (!st) continue;
    const tick = i * STEP_TICKS;
    const note = Math.max(0, Math.min(127, Math.round(57 + st.semitones)));
    events.push({ tick, bytes: [0xb2, 22, cc7(((st.grainSize - 0.02) / 0.48) * 127)] });
    events.push({ tick, bytes: [0xb2, 23, cc7(((st.density - 1) / 79) * 127)] });
    events.push({ tick, bytes: [0xb2, 24, cc7((Math.log(st.filterCutoff / 100) / Math.log(180)) * 127)] });
    events.push({ tick, bytes: [0x92, note, 100] });
    // Off at the very end of the step; sorted after the next step's on only
    // by tick, so order offs before ons at equal ticks (stable sort below).
    events.push({ tick: tick + STEP_TICKS, bytes: [0x82, note, 0], off: true });
  }
  // End of bar: an empty text meta event pins the track length to the full
  // bar (buildTrack appends End-of-Track right after the last event, which
  // would otherwise sit at tick 0 for an empty grid).
  events.push({ tick: GRID_STEPS * STEP_TICKS, bytes: [0xff, 0x01, 0x00] });
  events.sort((a, b) => a.tick - b.tick || (b.off ? 1 : 0) - (a.off ? 1 : 0));
  const header = [0x4d, 0x54, 0x68, 0x64, ...u32be(6), ...u16be(0), ...u16be(1), ...u16be(PPQ)];
  return new Uint8Array([...header, ...buildTrack(events)]);
}

// Je suis le spectre d'une rose que tu portais hier au bal.
