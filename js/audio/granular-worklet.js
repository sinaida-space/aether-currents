// granular-worklet.js
// AudioWorkletProcessor for granular synthesis. Loaded via audioWorklet.addModule.
// NOT an ES module import — runs in the AudioWorkletGlobalScope.
//
// Design constraints (see issue #2):
//  - Continuous controls are AudioParams (k-rate read here, one value per block).
//  - Discrete events arrive over the port: {type:'freeze'}, {type:'burst'}, {type:'setSample'}.
//  - ZERO allocation in process(): a fixed grain pool (256) and scratch buffers are
//    pre-allocated once; process() only reads/writes them.

const POOL = 256; // grain slots
const WIN_SIZE = 4096; // Hann window table length
const BLOCK = 128; // render quantum

// Shared Hann window table (built once for the whole global scope).
const HANN = new Float32Array(WIN_SIZE);
for (let i = 0; i < WIN_SIZE; i++) {
  HANN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN_SIZE - 1)));
}

class GranularProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'position', defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'pitch', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' },
      { name: 'grainSize', defaultValue: 0.09, minValue: 0.02, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'density', defaultValue: 12, minValue: 1, maxValue: 80, automationRate: 'k-rate' },
      { name: 'filterCutoff', defaultValue: 12000, minValue: 100, maxValue: 18000, automationRate: 'k-rate' },
      { name: 'spread', defaultValue: 0.15, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'pan', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();

    // Current source buffer (mono). null => silence.
    this._buf = null;

    // Grain pool — Structure-of-Arrays so no per-grain object is ever allocated.
    this._gActive = new Uint8Array(POOL);
    this._gBuf = new Array(POOL).fill(null); // per-grain buffer reference (survives sample swap)
    this._gPos = new Float32Array(POOL); // fractional read index into the grain's buffer
    this._gRate = new Float32Array(POOL); // playback rate (pitch)
    this._gLife = new Float32Array(POOL); // samples remaining
    this._gDur = new Float32Array(POOL); // total grain length in samples
    this._gPanL = new Float32Array(POOL);
    this._gPanR = new Float32Array(POOL);
    this._gAmp = new Float32Array(POOL);
    this._cursor = 0; // round-robin allocation cursor

    // Scratch mix buffers (pre-allocated, reused every block).
    this._sumL = new Float32Array(BLOCK);
    this._sumR = new Float32Array(BLOCK);

    // Scheduler state.
    this._nextGrain = 0; // samples until next scheduled grain

    // Burst (accent) state.
    this._burstRemaining = 0;
    this._burstNext = 0;

    // Freeze state.
    this._frozen = false;
    this._heldPos = 0.25;

    // One-pole lowpass state (per channel).
    this._lpL = 0;
    this._lpR = 0;

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    if (!msg) return;
    switch (msg.type) {
      case 'setSample':
        // msg.buffer is a transferred Float32Array (mono).
        this._buf = msg.buffer && msg.buffer.length ? msg.buffer : null;
        // Existing grains keep their own _gBuf reference and finish on the old buffer.
        break;
      case 'freeze':
        this._frozen = !!msg.value;
        break;
      case 'burst':
        // 16 extra grains spread over ~150ms with a widened position spread.
        this._burstRemaining = 16;
        this._burstNext = 0;
        break;
      default:
        break;
    }
  }

  // Allocate a grain from the pool. Returns slot index, or -1 if none free.
  _alloc() {
    for (let n = 0; n < POOL; n++) {
      const i = this._cursor;
      this._cursor = (this._cursor + 1) % POOL;
      if (!this._gActive[i]) return i;
    }
    return -1; // pool saturated — drop this grain
  }

  // Spawn one grain at the given position (0..1) with the given spread & pan width.
  _spawn(posNorm, spread, panWidth, dur, rate) {
    const buf = this._buf;
    if (!buf) return;
    const blen = buf.length;
    if (blen < 4) return;

    const i = this._alloc();
    if (i < 0) return;

    // Position with symmetric jitter scaled by spread.
    const jitter = (Math.random() * 2 - 1) * spread * 0.5 * blen;
    let start = posNorm * blen + jitter;
    if (start < 0) start = 0;
    if (start > blen - 2) start = blen - 2;

    // Equal-power random pan within the requested width.
    const panPos = 0.5 + (Math.random() - 0.5) * panWidth;
    const angle = panPos * (Math.PI * 0.5);

    this._gActive[i] = 1;
    this._gBuf[i] = buf;
    this._gPos[i] = start;
    this._gRate[i] = rate;
    this._gDur[i] = dur;
    this._gLife[i] = dur;
    this._gPanL[i] = Math.cos(angle);
    this._gPanR[i] = Math.sin(angle);
    this._gAmp[i] = 1;
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    const n = outL.length; // normally 128

    const sumL = this._sumL;
    const sumR = this._sumR;
    sumL.fill(0);
    sumR.fill(0);

    // k-rate params: read one value per block.
    const positionP = parameters.position[0];
    const pitch = parameters.pitch[0];
    const grainSize = parameters.grainSize[0];
    const density = parameters.density[0];
    const cutoff = parameters.filterCutoff[0];
    const spread = parameters.spread[0];
    const panW = parameters.pan[0];
    const gain = parameters.gain[0];

    // Freeze: hold the last un-frozen position; ignore live position while frozen.
    let posNorm;
    if (this._frozen) {
      posNorm = this._heldPos;
    } else {
      this._heldPos = positionP;
      posNorm = positionP;
    }

    const durSamples = grainSize * sampleRate;

    // --- Scheduler: spawn grains for this block ---
    if (this._buf) {
      // Normal density-driven scheduling.
      this._nextGrain -= n;
      let guard = 0;
      while (this._nextGrain <= 0 && guard < 64) {
        this._spawn(posNorm, spread, panW, durSamples, pitch);
        const io = sampleRate / density; // inter-onset in samples
        this._nextGrain += io * (0.7 + Math.random() * 0.6); // ±30% humanization
        guard++;
      }

      // Burst accent: fire the remaining burst grains, spaced ~9.4ms apart.
      if (this._burstRemaining > 0) {
        this._burstNext -= n;
        const burstSpread = Math.min(1, spread * 2 + 0.3);
        let bguard = 0;
        while (this._burstRemaining > 0 && this._burstNext <= 0 && bguard < 32) {
          this._spawn(posNorm, burstSpread, Math.min(1, panW + 0.3), durSamples, pitch);
          this._burstRemaining--;
          this._burstNext += 0.0094 * sampleRate; // ~150ms / 16
          bguard++;
        }
      }
    }

    // --- Render active grains into the scratch mix (outer grain / inner sample) ---
    for (let g = 0; g < POOL; g++) {
      if (!this._gActive[g]) continue;
      const buf = this._gBuf[g];
      const blen = buf.length;
      const dur = this._gDur[g];
      const invDur = 1 / dur;
      const rate = this._gRate[g];
      const amp = this._gAmp[g];
      const panL = this._gPanL[g];
      const panR = this._gPanR[g];
      let pos = this._gPos[g];
      let life = this._gLife[g];

      for (let i = 0; i < n; i++) {
        // Window (Hann) over grain lifetime.
        const wPhase = (dur - life) * invDur; // 0..1
        const wf = wPhase * (WIN_SIZE - 1);
        const wi = wf | 0;
        const win = HANN[wi] + (HANN[wi + 1] - HANN[wi]) * (wf - wi);

        // Linear-interpolated buffer read.
        const ip = pos | 0;
        let s;
        if (ip >= blen - 1 || ip < 0) {
          s = 0;
          life = 0; // ran off the buffer — end grain
        } else {
          const frac = pos - ip;
          s = buf[ip] + (buf[ip + 1] - buf[ip]) * frac;
        }

        const v = s * win * amp;
        sumL[i] += v * panL;
        sumR[i] += v * panR;

        pos += rate;
        life -= 1;
        if (life <= 0) {
          this._gActive[g] = 0;
          this._gBuf[g] = null;
          break;
        }
      }

      this._gPos[g] = pos;
      this._gLife[g] = life;
    }

    // --- Soft normalization from expected overlap (zipper-free, no pumping) ---
    const overlap = density * grainSize;
    const norm = 1 / Math.sqrt(overlap > 1 ? overlap : 1);

    // --- One-pole lowpass coefficient (computed once per block) ---
    let k = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
    if (k < 0) k = 0;
    else if (k > 1) k = 1;

    let lpL = this._lpL;
    let lpR = this._lpR;
    const g = gain * norm;

    for (let i = 0; i < n; i++) {
      lpL += k * (sumL[i] - lpL);
      lpR += k * (sumR[i] - lpR);
      // Master gain then tanh safety soft-clip.
      outL[i] = Math.tanh(lpL * g);
      outR[i] = Math.tanh(lpR * g);
    }

    this._lpL = lpL;
    this._lpR = lpR;

    return true; // keep the processor alive
  }
}

registerProcessor('aether-granular', GranularProcessor);
