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

    // Graph: node -> dry -> output ; node -> convolver -> wet -> output
    node.connect(dry).connect(output);
    node.connect(convolver).connect(wet).connect(output);

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

    return eng;
  }

  // --- Sample loading: downmix to mono Float32Array and transfer to the worklet ---
  setSample(audioBuffer) {
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
    this.node.port.postMessage({ type: 'setSample', buffer: mono }, [mono.buffer]);
  }

  freeze(on) {
    this.node.port.postMessage({ type: 'freeze', value: !!on });
  }

  burst() {
    this.node.port.postMessage({ type: 'burst' });
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
