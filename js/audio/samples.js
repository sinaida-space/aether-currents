// samples.js — self-synthesized granular source library (ES module).
// 10 distinct textures rendered offline. Each is mono, 44.1k, 2–5s, and is
// designed to EVOLVE across its duration so that granular `position` travel is
// audible. Total generation stays well under ~3s on a mid laptop.

const SR = 44100;

// Build an OfflineAudioContext for a mono render of `dur` seconds.
function offline(dur) {
  const Ctx = self.OfflineAudioContext || self.webkitOfflineAudioContext;
  return new Ctx(1, Math.ceil(dur * SR), SR);
}

// A reusable noise buffer generator.
function noiseBuffer(ctx, dur) {
  const b = ctx.createBuffer(1, Math.ceil(dur * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

// ---- 1. DEEP DRONE — detuned saw stack through a slow LP sweep ----
async function genDrone() {
  const dur = 5;
  const ctx = offline(dur);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 6;
  lp.frequency.setValueAtTime(120, 0);
  lp.frequency.linearRampToValueAtTime(2600, dur * 0.7);
  lp.frequency.linearRampToValueAtTime(300, dur);
  lp.connect(ctx.destination);

  const base = 55; // A1
  const detune = [-8, -3, 0, 4, 9, 12];
  for (const c of detune) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = base;
    o.detune.value = c;
    const g = ctx.createGain();
    g.gain.value = 0.14;
    o.connect(g).connect(lp);
    o.start(0);
    o.stop(dur);
  }
  return ctx.startRendering();
}

// ---- 2. FM BELL — 2-op FM, inharmonic ratio, long decay ----
async function genBell() {
  const dur = 4;
  const ctx = offline(dur);
  const carrier = ctx.createOscillator();
  carrier.frequency.value = 440;
  const mod = ctx.createOscillator();
  mod.frequency.value = 440 * 1.414; // inharmonic ratio
  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(900, 0);
  modGain.gain.exponentialRampToValueAtTime(20, dur);
  mod.connect(modGain).connect(carrier.frequency);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, 0);
  amp.gain.exponentialRampToValueAtTime(0.9, 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0005, dur);
  carrier.connect(amp).connect(ctx.destination);
  carrier.start(0); carrier.stop(dur);
  mod.start(0); mod.stop(dur);
  return ctx.startRendering();
}

// ---- 3. GHOST CHOIR — filtered noise through parallel formant bandpasses ----
async function genChoir() {
  const dur = 5;
  const ctx = offline(dur);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, dur);

  // Slow vibrato on the formant centers via an LFO into detune.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 4.5;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 25;
  lfo.connect(lfoGain);
  lfo.start(0); lfo.stop(dur);

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, 0);
  master.gain.exponentialRampToValueAtTime(0.8, 0.6);
  master.gain.setValueAtTime(0.8, dur - 0.6);
  master.gain.exponentialRampToValueAtTime(0.0005, dur);
  master.connect(ctx.destination);

  const formants = [420, 800, 2600]; // "ah"-ish vowel
  formants.forEach((f, idx) => {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f;
    bp.Q.value = 12;
    lfoGain.connect(bp.detune);
    // Slow vowel morph across duration for evolving spectrum.
    bp.frequency.setValueAtTime(f, 0);
    bp.frequency.linearRampToValueAtTime(f * (idx === 0 ? 1.4 : 0.7), dur);
    const g = ctx.createGain();
    g.gain.value = 0.5 / (idx + 1);
    src.connect(bp).connect(g).connect(master);
  });
  src.start(0); src.stop(dur);
  return ctx.startRendering();
}

// ---- 4. SUB PULSE — sine sub with pitch-drop transient + rhythmic amp pulses ----
async function genSub() {
  const dur = 4;
  const ctx = offline(dur);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(180, 0);
  o.frequency.exponentialRampToValueAtTime(42, 0.4); // drop transient
  const amp = ctx.createGain();
  // Rhythmic pulses at ~4 Hz.
  amp.gain.setValueAtTime(0.0001, 0);
  const step = 0.25;
  for (let t = 0; t < dur - step; t += step) {
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(0.95, t + 0.02);
    amp.gain.exponentialRampToValueAtTime(0.05, t + step * 0.9);
  }
  o.connect(amp).connect(ctx.destination);
  o.start(0); o.stop(dur);
  return ctx.startRendering();
}

// ---- 5. GLASS SHARDS — short sine partial clusters at random strike times ----
async function genGlass() {
  const dur = 4;
  const ctx = offline(dur);
  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);

  const strikes = 46;
  for (let s = 0; s < strikes; s++) {
    const t = Math.random() * (dur - 0.3);
    const root = 800 + Math.random() * 2600;
    const partials = [1, 2.76, 5.4]; // inharmonic glass cluster
    partials.forEach((r, pi) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = root * r;
      const g = ctx.createGain();
      const peak = 0.4 / (pi + 1);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.25);
      o.connect(g).connect(master);
      o.start(t); o.stop(t + 0.3);
    });
  }
  return ctx.startRendering();
}

// ---- 6. STATIC RAIN — bandpassed noise bursts, many small grains baked in ----
async function genRain() {
  const dur = 4;
  const ctx = offline(dur);
  const master = ctx.createGain();
  master.gain.value = 0.7;
  master.connect(ctx.destination);

  const bursts = 260;
  for (let s = 0; s < bursts; s++) {
    const t = Math.random() * (dur - 0.1);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.06);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    // Sweep the band center across the duration -> evolving spectrum.
    bp.frequency.value = 1200 + (t / dur) * 6000 + Math.random() * 800;
    bp.Q.value = 8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 + Math.random() * 0.4, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.05);
    src.connect(bp).connect(g).connect(master);
    src.start(t); src.stop(t + 0.06);
  }
  return ctx.startRendering();
}

// ---- 7. METAL SCRAPE — comb-ish noise through inharmonic IIR peaks ----
async function genMetal() {
  const dur = 4;
  const ctx = offline(dur);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, dur);
  const drive = ctx.createGain();
  drive.gain.value = 0.6;
  src.connect(drive);

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, 0);
  master.gain.exponentialRampToValueAtTime(0.7, 0.1);
  master.gain.setValueAtTime(0.7, dur - 0.3);
  master.gain.exponentialRampToValueAtTime(0.0005, dur);
  master.connect(ctx.destination);

  // Inharmonic resonant peaks that drift -> scraping, evolving metal.
  const peaks = [1300, 2110, 3470, 5230, 7900];
  peaks.forEach((f, i) => {
    const pk = ctx.createBiquadFilter();
    pk.type = 'peaking';
    pk.Q.value = 24;
    pk.gain.value = 22;
    pk.frequency.setValueAtTime(f, 0);
    pk.frequency.linearRampToValueAtTime(f * (1 + 0.15 * Math.sin(i)), dur);
    const g = ctx.createGain();
    g.gain.value = 0.5 / (i + 1);
    drive.connect(pk).connect(g).connect(master);
  });
  src.start(0); src.stop(dur);
  return ctx.startRendering();
}

// ---- 8. WIRE PLUCK — Karplus-Strong style plucks at several pitches ----
async function genPluck() {
  const dur = 4;
  const ctx = offline(dur);
  const out = ctx.createBuffer(1, Math.ceil(dur * SR), SR);
  const d = out.getChannelData(0);

  const freqs = [110, 147, 196, 262, 330, 220];
  freqs.forEach((f, i) => {
    const startT = i * 0.6 + Math.random() * 0.1;
    const start = Math.floor(startT * SR);
    const N = Math.floor(SR / f); // delay line length
    const line = new Float32Array(N);
    for (let j = 0; j < N; j++) line[j] = Math.random() * 2 - 1; // noise burst excitation
    let idx = 0;
    const decay = 0.996;
    const len = Math.floor(1.2 * SR);
    for (let n = 0; n < len && start + n < d.length; n++) {
      const cur = line[idx];
      const nextIdx = (idx + 1) % N;
      const avg = 0.5 * (cur + line[nextIdx]) * decay; // one-zero lowpass feedback
      line[idx] = avg;
      idx = nextIdx;
      d[start + n] += cur * 0.6;
    }
  });
  return out; // already a rendered AudioBuffer
}

// ---- 9. SOLAR WIND — slowly LFO-swept resonant noise, wide and airy ----
async function genWind() {
  const dur = 5;
  const ctx = offline(dur);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, dur);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 4;
  bp.frequency.value = 700;

  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.15;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 600;
  lfo.connect(lfoGain).connect(bp.frequency);
  lfo.start(0); lfo.stop(dur);

  // Slow overall center drift for evolving spectrum.
  bp.frequency.setValueAtTime(400, 0);
  bp.frequency.linearRampToValueAtTime(1800, dur);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, 0);
  amp.gain.exponentialRampToValueAtTime(0.85, 1.2);
  amp.gain.setValueAtTime(0.85, dur - 1.2);
  amp.gain.exponentialRampToValueAtTime(0.0005, dur);
  src.connect(bp).connect(amp).connect(ctx.destination);
  src.start(0); src.stop(dur);
  return ctx.startRendering();
}

// ---- 10. VOXEL GLITCH — square chirps, sample-&-hold pitch jumps, waveshape ----
async function genVoxel() {
  const dur = 3;
  const ctx = offline(dur);

  // Bit-crush-ish waveshaper.
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * 2 - 1;
    curve[i] = Math.round(x * 4) / 4; // quantize to 3-bit-ish steps
  }
  shaper.curve = curve;
  const master = ctx.createGain();
  master.gain.value = 0.5;
  shaper.connect(master).connect(ctx.destination);

  const o = ctx.createOscillator();
  o.type = 'square';
  o.frequency.setValueAtTime(220, 0);
  // Sample-and-hold pitch jumps.
  const step = 0.09;
  for (let t = 0; t < dur; t += step) {
    const f = 120 + Math.floor(Math.random() * 12) * 90; // stepped pitches
    o.frequency.setValueAtTime(f, t);
  }
  const amp = ctx.createGain();
  amp.gain.value = 0.6;
  o.connect(amp).connect(shaper);
  o.start(0); o.stop(dur);
  return ctx.startRendering();
}

const GENERATORS = [
  { id: 'drone', name: 'DEEP DRONE', gen: genDrone },
  { id: 'bell', name: 'FM BELL', gen: genBell },
  { id: 'choir', name: 'GHOST CHOIR', gen: genChoir },
  { id: 'sub', name: 'SUB PULSE', gen: genSub },
  { id: 'glass', name: 'GLASS SHARDS', gen: genGlass },
  { id: 'rain', name: 'STATIC RAIN', gen: genRain },
  { id: 'metal', name: 'METAL SCRAPE', gen: genMetal },
  { id: 'pluck', name: 'WIRE PLUCK', gen: genPluck },
  { id: 'wind', name: 'SOLAR WIND', gen: genWind },
  { id: 'voxel', name: 'VOXEL GLITCH', gen: genVoxel },
];

const VOICE_ASSET_URL = new URL('../../assets/audio/open-your-heart.m4a', import.meta.url);

// Fetch + decode the built-in voice asset. Unlike the synths above this is a
// real file, decoded through the live AudioContext (not offline-rendered).
// Decode/fetch failure is non-fatal — the caller just skips this entry.
async function loadVoiceSample(audioContext) {
  const res = await fetch(VOICE_ASSET_URL);
  if (!res.ok) throw new Error(`voice asset fetch failed: ${res.status}`);
  const arr = await res.arrayBuffer();
  const buffer = await audioContext.decodeAudioData(arr);
  return { id: 'voice', name: 'OPEN YOUR HEART ▸ VOICE', buffer };
}

// Render all 10 synths in sequence, then append the built-in voice sample.
// Returns [{id, name, buffer}].
export async function generateLibrary(audioContext) {
  const out = [];
  for (const g of GENERATORS) {
    const buffer = await g.gen();
    out.push({ id: g.id, name: g.name, buffer });
  }
  if (audioContext) {
    try {
      out.push(await loadVoiceSample(audioContext));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[AETHER CURRENTS] voice sample load failed, skipping:', err);
    }
  }
  return out;
}
