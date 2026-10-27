// Tape -> Standard MIDI File (type 1) and a save helper.
// Track 0: tempo, 4/4, name, scale label. Track 1 "GRID" ch3: CC22/23/24 + note.
// Track 2 "BEAT" ch10: kick on every quarter, closed hat on every off-beat 8th
// (left out with { beat: false }).
import { PPQ, writeVLQ, u32be, u16be } from './perf-recorder.js';

const STEP_TICKS = PPQ / 4;       // one 16th
const BAR_TICKS = PPQ * 4;
const BASE_NOTE = 57;
const GRID_CH = 2;                // channel 3
const BEAT_CH = 9;                // channel 10
const KICK = 36;
const HAT = 42;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const to127 = (t) => Math.round(clamp(t, 0, 1) * 127);

const metaText = (type, str) => {
  const b = Array.from(new TextEncoder().encode(str));
  return [0xff, type, ...writeVLQ(b.length), ...b];
};

// Like buildTrack, but End-of-Track sits at endTick so every track spans the range.
function trackChunk(events, endTick) {
  const sorted = events
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => a.tick - b.tick || (a.order ?? 1) - (b.order ?? 1) || a.i - b.i);
  const body = [];
  let last = 0;
  for (const ev of sorted) {
    body.push(...writeVLQ(ev.tick - last), ...ev.bytes);
    last = ev.tick;
  }
  body.push(...writeVLQ(Math.max(0, endTick - last)), 0xff, 0x2f, 0x00);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32be(body.length), ...body];
}

export function tapeToMidi(tape, { bpm = 116, range = null, scaleLabel = '', beat: withBeat = true } = {}) {
  const last = tape.barCount - 1;
  const start = clamp(range ? range.start : 0, 0, last);
  const end = clamp(range ? range.end : last, start, last);
  const bars = end - start + 1;
  const endTick = bars * BAR_TICKS;

  const us = Math.round(60000000 / Math.max(1, bpm));
  const t0 = [
    { tick: 0, bytes: metaText(0x03, 'AETHER CURRENTS') },
    { tick: 0, bytes: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] },
    { tick: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] },
    { tick: 0, bytes: metaText(0x01, scaleLabel || 'scale') },
  ];

  const grid = [{ tick: 0, bytes: metaText(0x03, 'GRID') }];
  const beat = [{ tick: 0, bytes: metaText(0x03, 'BEAT') }];
  for (let b = 0; b < bars; b++) {
    const base = b * BAR_TICKS;
    for (let i = 0; i < 16; i++) {
      const s = tape.getStep(start + b, i);
      if (!s) continue;
      const tick = base + i * STEP_TICKS;
      const cc = (n, v) => grid.push({ tick, order: 1, bytes: [0xb0 | GRID_CH, n, v] });
      cc(22, to127((s.grainSize - 0.02) / (0.5 - 0.02)));
      cc(23, to127((s.density - 1) / (80 - 1)));
      cc(24, to127(Math.log(clamp(s.filterCutoff, 100, 18000) / 100) / Math.log(180)));
      const note = clamp(Math.round(BASE_NOTE + s.semitones), 0, 127);
      grid.push({ tick, order: 2, bytes: [0x90 | GRID_CH, note, 100] });
      grid.push({ tick: tick + STEP_TICKS, order: 0, bytes: [0x80 | GRID_CH, note, 0] });
    }
    for (let q = 0; withBeat && q < 4; q++) {
      const kt = base + q * PPQ;
      const ht = kt + PPQ / 2;
      const len = PPQ / 8; // 32nd
      beat.push({ tick: kt, order: 2, bytes: [0x90 | BEAT_CH, KICK, 100] });
      beat.push({ tick: kt + len, order: 0, bytes: [0x80 | BEAT_CH, KICK, 0] });
      beat.push({ tick: ht, order: 2, bytes: [0x90 | BEAT_CH, HAT, 80] });
      beat.push({ tick: ht + len, order: 0, bytes: [0x80 | BEAT_CH, HAT, 0] });
    }
  }

  const tracks = [trackChunk(t0, endTick), trackChunk(grid, endTick)];
  if (withBeat) tracks.push(trackChunk(beat, endTick));
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, ...u32be(6), ...u16be(1), ...u16be(tracks.length), ...u16be(PPQ),
    ...tracks.flat(),
  ]);
}

export async function saveMidi(bytes, suggestedName = 'aether-currents.mid') {
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'MIDI', accept: { 'audio/midi': ['.mid'] } }],
      });
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
      return { name: handle.name, method: 'picker' };
    } catch (e) {
      if (e && e.name === 'AbortError') return { method: 'cancelled' };
      throw e;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return { name: suggestedName, method: 'download' };
}

// Je suis le spectre d'une rose que tu portais hier au bal. Théophile Gautier, 1837
