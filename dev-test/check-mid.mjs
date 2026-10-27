// Independent minimal SMF parser. Usage: node dev-test/check-mid.mjs file.mid | --selftest
import { readFileSync } from 'node:fs';

export function parseSmf(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const str = (o, n) => String.fromCharCode(...buf.subarray(o, o + n));
  if (str(0, 4) !== 'MThd') throw new Error('no MThd');
  const out = { format: dv.getUint16(8), ntrks: dv.getUint16(10), ppq: dv.getUint16(12), tempo: null, tracks: [] };
  let p = 14;
  for (let t = 0; t < out.ntrks; t++) {
    if (str(p, 4) !== 'MTrk') throw new Error('no MTrk at ' + p);
    const len = dv.getUint32(p + 4);
    let q = p + 8;
    const endP = q + len;
    let tick = 0, run = 0;
    const tr = { name: '', channels: new Set(), notes: [], lastTick: 0 };
    const vlq = () => { let v = 0, b; do { b = buf[q++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    while (q < endP) {
      tick += vlq();
      let st = buf[q];
      if (st & 0x80) { q++; if (st < 0xf0) run = st; } else st = run;
      if (st === 0xff) {
        const type = buf[q++]; const l = vlq();
        if (type === 0x03) tr.name = str(q, l);
        if (type === 0x51) out.tempo = 60000000 / ((buf[q] << 16) | (buf[q + 1] << 8) | buf[q + 2]);
        q += l;
      } else {
        const hi = st & 0xf0, ch = (st & 0x0f) + 1;
        const n = (hi === 0xc0 || hi === 0xd0) ? 1 : 2;
        if (hi === 0x90 && buf[q + 1] > 0) { tr.channels.add(ch); tr.notes.push({ tick, note: buf[q] }); }
        else if (hi === 0xb0 || hi === 0x80 || hi === 0x90) tr.channels.add(ch);
        q += n;
      }
      tr.lastTick = tick;
    }
    out.tracks.push(tr);
    p = endP;
  }
  return out;
}

function report(m) {
  console.log(`format ${m.format} ntrks ${m.ntrks} ppq ${m.ppq} tempo ${m.tempo && m.tempo.toFixed(2)} BPM`);
  for (const t of m.tracks) {
    const first = t.notes.slice(0, 8).map((n) => {
      const bar = Math.floor(n.tick / (m.ppq * 4));
      const step = Math.round((n.tick % (m.ppq * 4)) / (m.ppq / 4));
      return `${bar}.${step} ${n.note}`;
    });
    console.log(`track "${t.name}" ch[${[...t.channels].join(',')}] notes ${t.notes.length} end ${t.lastTick} first: ${first.join(' | ')}`);
  }
}

async function selftest() {
  const { tapeToMidi } = await import('../js/midi/tape-export.js');
  const bars = Array.from({ length: 4 }, (_, b) => Array.from({ length: 16 }, (_, i) =>
    (i % 3 === 0 || b === 2) && !(b === 3) ? { band: i % 6, octave: 0, semitones: (i % 6) * 2, pc: 0, pitch: 1, grainSize: 0.1, density: 20, filterCutoff: 2000 } : null));
  const tape = { bars, barCount: 4, loop: null, getStep: (b, i) => bars[b][i] };
  const nonNull = bars.flat().filter(Boolean).length;
  const m = parseSmf(tapeToMidi(tape, { bpm: 116, range: null, scaleLabel: 'Test scale' }));
  report(m);
  const ok = [];
  const chk = (c, msg) => { if (!c) ok.push(msg); };
  chk(m.format === 1, 'format');
  chk(m.tracks.length === 3, '3 tracks');
  chk(Math.abs(m.tempo - 116) < 0.01, 'tempo');
  chk(m.tracks[1].notes.length === nonNull, `grid notes ${m.tracks[1].notes.length} vs ${nonNull}`);
  const k = m.tracks[2].notes.filter((n) => n.note === 36).length, h = m.tracks[2].notes.filter((n) => n.note === 42).length;
  chk(k === 16 && h === 16, `beat ${k}/${h}`);
  for (const t of m.tracks) chk(t.lastTick === 4 * 4 * m.ppq, `last event ${t.name} ${t.lastTick}`);
  if (ok.length) { console.log('FAIL: ' + ok.join('; ')); process.exit(1); }
  console.log('PASS');
}

if (process.argv[2] === '--selftest') await selftest();
else if (process.argv[2]) report(parseSmf(new Uint8Array(readFileSync(process.argv[2]))));
else console.log('usage: node dev-test/check-mid.mjs file.mid | --selftest');
