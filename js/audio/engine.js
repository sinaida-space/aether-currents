// engine.js — main-thread wrapper around the granular AudioWorklet (ES module).
// Builds the audio graph, generates a synthetic reverb impulse, and exposes a
// gesture-rate control surface plus analysis getters for the visual layer.

import { generateLibrary as _generateLibrary } from './samples.js';

// Re-export so Task 5 can pull the library straight from the engine module.
export async function generateLibrary(audioContext) {
  return _generateLibrary(audioContext);
}

// Decode a user-uploaded file into an AudioBuffer.
export async function loadUserFile(audioContext, file) {
  const arr = await file.arrayBuffer();
  return await audioContext.decodeAudioData(arr);
}

// Capture `seconds` of mono audio from the microphone -> AudioBuffer.
// Uses MediaRecorder so we avoid a second worklet; result is decoded back.
export async function captureMic(audioContext, seconds = 4) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false },
    video: false,
  });
  try {
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start();
    await new Promise((res) => setTimeout(res, seconds * 1000));
    rec.stop();
    await done;
    const blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'audio/webm' });
    const arr = await blob.arrayBuffer();
    return await audioContext.decodeAudioData(arr);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

// Render a 2.5s stereo-decorrelated exponentially-decaying-noise impulse response.
async function makeImpulse(audioContext) {
  const dur = 2.5;
  const rate = audioContext.sampleRate;
  const len = Math.ceil(dur * rate);
  const Off = self.OfflineAudioContext || self.webkitOfflineAudioContext;
  const off = new Off(2, len, rate);
  const ir = off.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, 2.4); // exponential-ish decay
      d[i] = (Math.random() * 2 - 1) * env; // independent per channel -> decorrelated
    }
  }
  const src = off.createBufferSource();
  src.buffer = ir;
  src.connect(off.destination);
  src.start(0);
  return await off.startRendering();
}

// Internal four-on-the-floor beat with sidechain pump. Standard main-thread
// lookahead scheduler: a setInterval tick schedules audio events ~120ms ahead
// on the sample-accurate audio clock. Kick on every beat, hat on offbeat 8ths.
class BeatScheduler {
  constructor(ctx, output, duck, noise) {
    this.ctx = ctx;
    this.output = output; // kick/hat route here (un-ducked)
    this.duck = duck; // sidechain target
    this.noise = noise; // precomputed hi-hat noise buffer
    this.bpm = 116;
    this.running = false;
    this.startTime = 0;
    this._interval = null;
    this._step = 0; // 8th-note counter
    this._nextTime = 0; // audio-clock time of the next 8th note
    this._voices = []; // scheduled osc/source nodes pending stop
    this._lookahead = 0.35; // seconds scheduled ahead (stall-proof horizon)
    this._tick = 0.05; // scheduler wake interval (s)
    this._sec8th = 60 / this.bpm / 2;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._step = 0;
    this._voices.length = 0;
    // Align the grid a hair into the future so the first kick isn't clipped.
    this.startTime = this.ctx.currentTime + 0.06;
    this._nextTime = this.startTime;
    this._scheduler();
    this._interval = setInterval(() => this._scheduler(), this._tick * 1000);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._interval !== null) {
      clearInterval(this._interval);
      this._interval = null;
    }
    // Cancel any voices scheduled but not yet started/still playing so the
    // widened 0.35s lookahead doesn't leave beat audio hanging after BEAT off.
    const now = this.ctx.currentTime;
    for (const v of this._voices) {
      try { v.stop(now); } catch (_) { /* already stopped */ }
      try { v.disconnect(); } catch (_) { /* already disconnected */ }
    }
    this._voices.length = 0;
    // Return the duck gain smoothly to unity.
    const g = this.duck.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(1, now, 0.05);
  }

  _scheduler() {
    const now = this.ctx.currentTime;
    // Stall recovery: if a main-thread stall let _nextTime fall behind the
    // audio clock, jump forward to the next grid point strictly in the
    // future instead of machine-gunning every missed beat.
    if (this._nextTime < now) {
      const missed = Math.ceil((now - this._nextTime) / this._sec8th);
      this._nextTime += missed * this._sec8th;
      this._step += missed;
    }
    const horizon = now + this._lookahead;
    while (this._nextTime < horizon) {
      this._schedule(this._step, this._nextTime);
      this._nextTime += this._sec8th;
      this._step++;
    }
  }

  _schedule(step, t) {
    if ((step & 1) === 0) {
      this._kick(t);
      this._sidechain(t);
    } else {
      this._hat(t);
    }
  }

  _kick(t) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(g).connect(this.output);
    osc.start(t);
    osc.stop(t + 0.3);
    this._track(osc);
  }

  _hat(t) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.95 + Math.random() * 0.1;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    const peak = 0.9 * Math.pow(10, -12 / 20); // -12 dB vs kick
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    src.connect(hp).connect(g).connect(this.output);
    src.start(t);
    src.stop(t + 0.06);
    this._track(src);
  }

  _sidechain(t) {
    const g = this.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(0.4, t + 0.02);
    g.setTargetAtTime(1, t + 0.06, 0.12);
  }

  // Track a scheduled voice so stop() can cancel it; self-prune on end.
  _track(node) {
    this._voices.push(node);
    node.onended = () => {
      const i = this._voices.indexOf(node);
      if (i >= 0) this._voices.splice(i, 1);
    };
  }
}

export class GranularEngine {
  static async create(audioContext) {
    const eng = new GranularEngine();
    eng.ctx = audioContext;

    // Load the worklet module (relative to this file; static hosting friendly).
    await audioContext.audioWorklet.addModule(new URL('./granular-worklet.js', import.meta.url));

    const node = new AudioWorkletNode(audioContext, 'aether-granular', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    eng.node = node;

    // --- Reverb send (convolver with a synthetic IR) ---
    const convolver = audioContext.createConvolver();
    convolver.buffer = await makeImpulse(audioContext);
    eng._convolver = convolver;

    const dry = audioContext.createGain();
    dry.gain.value = 1;
    const wet = audioContext.createGain();
    wet.gain.value = 0.25; // reverbMix default
    eng._wet = wet;

    const output = audioContext.createGain();
    output.gain.value = 1;
    eng.output = output;

    // Sidechain duck bus: the granular dry+wet signal passes through `duck`
    // before `output`, so the beat scheduler can pump it under each kick.
    // The kick/hat voices connect to `output` directly and are NOT ducked.
    const duck = audioContext.createGain();
    duck.gain.value = 1;
    eng._duck = duck;

    // Graph: node -> dry -> duck -> output ; node -> convolver -> wet -> duck -> output
    node.connect(dry).connect(duck).connect(output);
    node.connect(convolver).connect(wet).connect(duck);

    // Analyser tap on output, then out to speakers.
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    eng.analyser = analyser;
    output.connect(analyser);
    output.connect(audioContext.destination);

    // Analysis scratch buffers (reused — no per-call allocation).
    eng._timeBuf = new Float32Array(analyser.fftSize);
    eng._freqBuf = new Uint8Array(analyser.frequencyBinCount);
    eng._level = 0;

    // Precomputed noise buffer for hi-hats (0.2s mono white noise, reused per hit).
    const nlen = Math.ceil(0.2 * audioContext.sampleRate);
    const noise = audioContext.createBuffer(1, nlen, audioContext.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;
    eng._hatNoise = noise;

    // Internal beat scheduler (kick + hat + sidechain). Off until setBeat(true).
    eng._beat = new BeatScheduler(audioContext, output, duck, noise);

    return eng;
  }

  // Downmix an AudioBuffer to a fresh mono Float32Array.
  _downmix(audioBuffer) {
    const ch = audioBuffer.numberOfChannels;
    const len = audioBuffer.length;
    const mono = new Float32Array(len);
    if (ch === 1) {
      mono.set(audioBuffer.getChannelData(0));
    } else {
      for (let c = 0; c < ch; c++) {
        const d = audioBuffer.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += d[i] / ch;
      }
    }
    return mono;
  }

  // --- Sample loading: downmix to mono Float32Array and transfer to the worklet ---
  setSample(audioBuffer) {
    const mono = this._downmix(audioBuffer);
    this.node.port.postMessage({ type: 'setSample', buffer: mono }, [mono.buffer]);
  }

  // Set the active granular set (1..4 AudioBuffers). Each is downmixed to mono
  // and transferred; the worklet interleaves grains across the set.
  setActiveSamples(audioBuffers) {
    const list = Array.isArray(audioBuffers) ? audioBuffers : [audioBuffers];
    const buffers = [];
    const transfer = [];
    for (let i = 0; i < list.length && buffers.length < 4; i++) {
      if (!list[i]) continue;
      const mono = this._downmix(list[i]);
      buffers.push(mono);
      transfer.push(mono.buffer);
    }
    this.node.port.postMessage({ type: 'setSamples', buffers }, transfer);
  }

  freeze(on) {
    this.node.port.postMessage({ type: 'freeze', value: !!on });
  }

  // Chord mode: 'arp' (legacy alternating dyad) vs simultaneous (default).
  // Latent — no UI/gesture wired yet (v3.2).
  setChordMode(arp) {
    this.node.port.postMessage({ type: 'chordMode', arp: !!arp });
  }

  // Fire a grain burst. When the beat runs, quantize the port message to the
  // next 8th-note grid point (grain spawning tolerates the small setTimeout jitter).
  burst() {
    const beat = this._beat;
    if (beat && beat.running) {
      const now = this.ctx.currentTime;
      const sec8th = 60 / beat.bpm / 2;
      const elapsed = now - beat.startTime;
      const nextGrid = Math.ceil(elapsed / sec8th) * sec8th + beat.startTime;
      const deltaMs = Math.max(0, nextGrid - now) * 1000;
      setTimeout(() => this.node.port.postMessage({ type: 'burst' }), deltaMs);
    } else {
      this.node.port.postMessage({ type: 'burst' });
    }
  }

  // --- Beat backbone (four-on-the-floor + sidechain) ---
  setBeat(on) {
    if (on) this._beat.start();
    else this._beat.stop();
  }
  get beatOn() {
    return this._beat ? this._beat.running : false;
  }

  // Beat clock for visuals/HUD, derived from the audio clock.
  getBeatPhase() {
    const beat = this._beat;
    const bpm = beat ? beat.bpm : 116;
    if (!beat || !beat.running) return { bpm, phase: 0, beatIndex: 0 };
    const spb = 60 / bpm;
    const elapsed = this.ctx.currentTime - beat.startTime;
    if (elapsed <= 0) return { bpm, phase: 0, beatIndex: 0 };
    const beats = elapsed / spb;
    const beatIndex = Math.floor(beats);
    return { bpm, phase: beats - beatIndex, beatIndex };
  }

  // Reverb wet-send amount (0..1). Smoothed to stay zipper-free.
  set reverbMix(v) {
    const t = this.ctx.currentTime;
    this._wet.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), t, 0.03);
  }
  get reverbMix() {
    return this._wet.gain.value;
  }

  // Task 5 recorder tap — expose the post-FX node.
  connectRecorderTap(node) {
    this.output.connect(node);
    return node;
  }

  // Smoothed RMS level 0..1 from the analyser time-domain data.
  getLevel() {
    const buf = this._timeBuf;
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    // One-pole smoothing; scale so typical output lands in a useful 0..1 range.
    const target = Math.min(1, rms * 2.5);
    this._level += 0.3 * (target - this._level);
    return this._level;
  }

  // Normalized spectral centroid 0..1 from analyser byte frequency data.
  getCentroid() {
    const buf = this._freqBuf;
    this.analyser.getByteFrequencyData(buf);
    let num = 0;
    let den = 0;
    for (let i = 0; i < buf.length; i++) {
      const m = buf[i];
      num += i * m;
      den += m;
    }
    if (den === 0) return 0;
    return (num / den) / buf.length; // 0..1
  }
}

// Convenience re-exports already declared above (loadUserFile, captureMic, generateLibrary).
