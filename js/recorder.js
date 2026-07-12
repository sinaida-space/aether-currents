// recorder.js — video+audio capture, branded compositing, MP4/WAV export.
// Owns two parallel recordings that both start/stop together:
//   1. video — WebCodecs path (VideoEncoder + AudioEncoder muxed to MP4 via
//      vendored mp4-muxer) when supported, else a MediaRecorder fallback on
//      an offscreen branded-compositing canvas + audio (produces .webm)
//   2. a raw PCM tap via an inline AudioWorklet feeding a WAV encoder with
//      RIFF LIST-INFO tags (produces the downloadable .wav) — also reused
//      as the AAC source for the MP4 path.
//
// Boundary: does not touch js/audio, js/tracking, js/visuals internals —
// only reads glCanvas/hudCanvas via drawImage and taps engine.output via
// the public connectRecorderTap()/output surface.

import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.min.mjs';

const MAX_DURATION_MS = 5 * 60 * 1000; // hard 5min cap
const PCM_CHUNK = 8192;
const MP4_KEYFRAME_INTERVAL_US = 2_000_000; // 2s
const MP4_BACKPRESSURE_QUEUE_SIZE = 4;

// FULL mode records 1080p60 by default, but that's real main-thread encode
// load stacked on top of rendering. If the renderer's live FPS EMA (already
// running for a few seconds before the user hits record) shows the machine
// isn't comfortably holding 60fps *before* we add encode work, drop the
// recording target to 1080p30 instead — same resolution, half the per-second
// encode+draw cost. Threshold sits a bit under 60 to allow for normal jitter.
const FULL_FPS_DOWNGRADE_THRESHOLD = 50;
// If stop()'s own cleanup work throws or hangs, this hard cap on waiting for
// a graceful stop keeps the button state machine (js/main.js) from ever
// needing to wait indefinitely — see _handleEncoderFailure().
const GRACEFUL_STOP_TIMEOUT_MS = 4000;

// ---- inline PCM-tap worklet (Blob URL module) ----------------------------
const PCM_WORKLET_SRC = `
class PCMTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this._l = new Float32Array(${PCM_CHUNK});
    this._r = new Float32Array(${PCM_CHUNK});
    this._n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const inL = input[0];
    const inR = input.length > 1 ? input[1] : input[0];
    const n = inL.length;
    for (let i = 0; i < n; i++) {
      this._l[this._n] = inL[i];
      this._r[this._n] = inR ? inR[i] : inL[i];
      this._n++;
      if (this._n >= ${PCM_CHUNK}) {
        this.port.postMessage({ l: this._l.slice(0, this._n), r: this._r.slice(0, this._n) });
        this._n = 0;
      }
    }
    return true;
  }
}
registerProcessor('aether-pcm-tap', PCMTap);
`;

function pad2(n) { return String(n).padStart(2, '0'); }

function timestampSlug(d) {
  return (
    d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
  );
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// ---- WAV encoding with RIFF LIST-INFO chunk -------------------------------

function textChunk(id, text) {
  // 4-byte id, 4-byte size (data length incl. null terminator), text + \0, word-padded.
  const bytes = new TextEncoder().encode(text + '\0');
  const size = bytes.length;
  const padded = size % 2 === 1 ? size + 1 : size;
  const buf = new ArrayBuffer(8 + padded);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < 4; i++) view.setUint8(i, id.charCodeAt(i));
  view.setUint32(4, size, true);
  u8.set(bytes, 8);
  return u8;
}

function buildListInfoChunk(tags) {
  const parts = [];
  for (const [id, text] of tags) parts.push(textChunk(id, text));
  const infoBody = parts.reduce((sum, p) => sum + p.length, 0) + 4; // +4 for "INFO" tag
  const listSize = infoBody;
  const total = 8 + listSize;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  writeAscii(view, 0, 'LIST');
  view.setUint32(4, listSize, true);
  writeAscii(view, 8, 'INFO');
  let off = 12;
  for (const p of parts) { u8.set(p, off); off += p.length; }
  return u8;
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function encodeWav(channelL, channelR, sampleRate, tags) {
  const numFrames = channelL.length;
  const numChannels = 2;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const listChunk = buildListInfoChunk(tags);

  const fmtSize = 16;
  const headerSize = 12 /* RIFF header */
    + 8 + fmtSize /* fmt chunk */
    + listChunk.length /* LIST chunk */
    + 8 /* data chunk header */;

  const dataPadded = dataSize % 2 === 1 ? dataSize + 1 : dataSize;
  const riffSize = headerSize - 8 + dataPadded;

  const buf = new ArrayBuffer(headerSize + dataPadded);
  const view = new DataView(buf);
  let off = 0;

  writeAscii(view, off, 'RIFF'); off += 4;
  view.setUint32(off, riffSize, true); off += 4;
  writeAscii(view, off, 'WAVE'); off += 4;

  writeAscii(view, off, 'fmt '); off += 4;
  view.setUint32(off, fmtSize, true); off += 4;
  view.setUint16(off, 1, true); off += 2; // PCM
  view.setUint16(off, numChannels, true); off += 2;
  view.setUint32(off, sampleRate, true); off += 4;
  view.setUint32(off, sampleRate * blockAlign, true); off += 4;
  view.setUint16(off, blockAlign, true); off += 2;
  view.setUint16(off, bytesPerSample * 8, true); off += 2;

  new Uint8Array(buf, off, listChunk.length).set(listChunk); off += listChunk.length;

  writeAscii(view, off, 'data'); off += 4;
  view.setUint32(off, dataSize, true); off += 4;

  let p = off;
  for (let i = 0; i < numFrames; i++) {
    let sl = Math.max(-1, Math.min(1, channelL[i]));
    let sr = Math.max(-1, Math.min(1, channelR[i]));
    view.setInt16(p, sl < 0 ? sl * 0x8000 : sl * 0x7fff, true); p += 2;
    view.setInt16(p, sr < 0 ? sr * 0x8000 : sr * 0x7fff, true); p += 2;
  }
  // pad byte (if dataSize was odd) is left zero-initialized by ArrayBuffer.

  return new Blob([buf], { type: 'audio/wav' });
}

// ---- brand frame drawing ---------------------------------------------------

function drawBrandFrame(ctx, w, h) {
  // Border only — all text overlays (title, mode/date, watermark) live on
  // the HUD canvas, which is the single source of truth composited above.
  const red = '#ff2a2a';
  ctx.save();
  ctx.shadowColor = red;
  ctx.shadowBlur = h * 0.006;
  ctx.strokeStyle = red;
  ctx.lineWidth = Math.max(1, Math.round(h * 0.0022));
  const margin = 12;
  ctx.strokeRect(margin, margin, w - margin * 2, h - margin * 2);
  ctx.restore();
}

function pickMimeType() {
  const candidates = [
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return '';
}

// ---- WebCodecs MP4 capability probe ---------------------------------------

async function probeMp4Support(width, height, sampleRate, framerate) {
  if (typeof window === 'undefined') return false;
  if (!window.VideoEncoder || !window.AudioEncoder) return false;
  try {
    const videoConfig = {
      codec: 'avc1.640028',
      width,
      height,
      bitrate: 8_000_000,
      framerate: framerate || 60,
    };
    const audioConfig = {
      codec: 'mp4a.40.2',
      sampleRate,
      numberOfChannels: 2,
      bitrate: 192_000,
    };
    const [v, a] = await Promise.all([
      VideoEncoder.isConfigSupported(videoConfig),
      AudioEncoder.isConfigSupported(audioConfig),
    ]);
    return !!(v && v.supported && a && a.supported);
  } catch (e) {
    return false;
  }
}

export class Recorder {
  constructor({ glCanvas, hudCanvas, audioNode, audioContext, modeLabel, onError, getFps }) {
    this.glCanvas = glCanvas;
    this.hudCanvas = hudCanvas;
    this.audioNode = audioNode; // engine.output
    this.ctx = audioContext;
    this.modeLabel = modeLabel;
    this._onError = typeof onError === 'function' ? onError : null;
    // Optional live-FPS sampler (e.g. () => renderer.fps), used at start()
    // to decide 1080p60 vs 1080p30 in FULL mode. Absent/zero reading = skip
    // the downgrade (fail open to the higher-quality default).
    this._getFps = typeof getFps === 'function' ? getFps : null;
    this._recordFps = 60;

    this.recording = false;
    // Set true the moment an encoder/MediaRecorder reports an error so stop()
    // knows to salvage rather than assume a clean flush is possible, and so
    // repeat error events don't each try to trigger their own stop().
    this._encoderFailed = false;

    // Optional hook, settable by the caller: fires with { videoBlob,
    // videoKind, wavBlob, filename, webmBlob } whenever a recording
    // finishes, whether via manual stop() or the internal 5-minute
    // hard-stop timer (which calls stop() on its own). webmBlob is a
    // back-compat alias of videoBlob; filename.webm is extension-correct
    // for whichever kind (mp4/webm) was actually produced.
    this.onStop = null;

    this._compositeCanvas = null;
    this._compositeCtx = null;
    this._compositeRaf = null;
    this._mediaRecorder = null;
    this._videoChunks = [];
    this._mimeType = '';

    this._pcmNode = null;
    this._pcmModuleLoaded = false;
    this._pcmL = [];
    this._pcmR = [];
    this._pcmFrameCount = 0;

    this._destNode = null; // MediaStreamAudioDestinationNode
    this._stopTimer = null;
    this._startedAt = 0;

    // WebCodecs MP4 path state (only used when probeMp4Support() passes).
    this._useMp4 = false;
    this._videoEncoder = null;
    this._audioEncoder = null;
    this._muxer = null;
    this._muxerTarget = null;
    this._lastKeyFrameUs = -Infinity;
    this._audioTimestampUs = 0;
  }

  // Live WebCodecs encode backlog, for debug instrumentation (issue #20).
  // 0 when not using the MP4/WebCodecs path (e.g. MediaRecorder fallback).
  get encodeQueueSize() {
    return this._videoEncoder ? this._videoEncoder.encodeQueueSize : 0;
  }

  async _ensurePcmModule() {
    if (this._pcmModuleLoaded) return;
    const blob = new Blob([PCM_WORKLET_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this._pcmModuleLoaded = true;
  }

  async start() {
    if (this.recording) return;
    try {
      await this._start();
    } catch (err) {
      // Roll back partial setup so a failed start never leaks connections
      // or leaves the recorder wedged in a not-quite-recording state.
      this._teardownOnError();
      throw err;
    }
  }

  _teardownOnError() {
    try { if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') this._mediaRecorder.stop(); } catch (e) { /* already dead */ }
    this._mediaRecorder = null;
    try { if (this._videoEncoder && this._videoEncoder.state !== 'closed') this._videoEncoder.close(); } catch (e) { /* already dead */ }
    this._videoEncoder = null;
    try { if (this._audioEncoder && this._audioEncoder.state !== 'closed') this._audioEncoder.close(); } catch (e) { /* already dead */ }
    this._audioEncoder = null;
    this._muxer = null;
    this._muxerTarget = null;
    try { if (this._destNode) this.audioNode.disconnect(this._destNode); } catch (e) { /* not connected */ }
    this._destNode = null;
    try { if (this._pcmNode) { this.audioNode.disconnect(this._pcmNode); this._pcmNode.port.onmessage = null; } } catch (e) { /* not connected */ }
    this._pcmNode = null;
    if (this._compositeRaf) { clearTimeout(this._compositeRaf); this._compositeRaf = null; }
    if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }
    this.recording = false;
  }

  async _start() {
    await document.fonts.load('16px VT323');

    const light = this.modeLabel === 'LIGHT MODE';
    // match the on-screen canvas's orientation: portrait devices (mobile,
    // most phones held upright) get a portrait export instead of always
    // being cropped into a fixed 16:9 landscape frame.
    const srcW = this.glCanvas.width || this.glCanvas.clientWidth || 1;
    const srcH = this.glCanvas.height || this.glCanvas.clientHeight || 1;
    const portrait = srcH > srcW;
    const cw = light ? (portrait ? 720 : 1280) : (portrait ? 1080 : 1920);
    const ch = light ? (portrait ? 1280 : 720) : (portrait ? 1920 : 1080);

    this._recordFps = 60;
    if (!light) {
      const fps = this._getFps ? this._getFps() : null;
      if (typeof fps === 'number' && fps > 0 && fps < FULL_FPS_DOWNGRADE_THRESHOLD) {
        this._recordFps = 30;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    this._compositeCanvas = canvas;
    this._compositeCtx = canvas.getContext('2d');
    // Force one real paint onto the composite canvas *before* anything probes
    // or captures it. A freshly created, never-appended, never-painted
    // offscreen canvas has a backing store but no committed frame yet — on
    // some Chrome builds calling captureStream() on that canvas in the same
    // tick intermittently yields a MediaStream with zero video tracks (the
    // capture pipeline has nothing to composite from). When that happened,
    // `combined` below silently ended up audio-only and MediaRecorder just
    // recorded sound with no complaint — the root cause of "record dialog
    // sometimes offers only audio". Painting a frame first guarantees a
    // committed frame exists at capture time.
    this._compositeCtx.fillStyle = '#000';
    this._compositeCtx.fillRect(0, 0, cw, ch);

    // Video support is intentionally re-probed here, fresh, on every
    // start() call — never cached at module scope — and only after the
    // composite canvas above is guaranteed to exist, be correctly sized for
    // *this* recording (light/portrait can change between recordings), and
    // hold a real painted frame.
    this._useMp4 = await probeMp4Support(cw, ch, this.ctx.sampleRate, this._recordFps);

    if (this._useMp4) {
      this._startMp4Encoders(cw, ch);
    } else {
      this._startWebmRecorder(canvas);
    }

    // --- parallel PCM tap for WAV (also feeds the AAC encoder on the MP4 path) ---
    await this._ensurePcmModule();
    const pcmNode = new AudioWorkletNode(this.ctx, 'aether-pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    this._pcmL = [];
    this._pcmR = [];
    this._pcmFrameCount = 0;
    this._audioTimestampUs = 0;
    pcmNode.port.onmessage = (e) => {
      this._pcmL.push(e.data.l);
      this._pcmR.push(e.data.r);
      this._pcmFrameCount += e.data.l.length;
      if (this._useMp4 && this._audioEncoder && this._audioEncoder.state === 'configured') {
        this._encodeAudioChunk(e.data.l, e.data.r);
      }
    };
    this.audioNode.connect(pcmNode);
    this._pcmNode = pcmNode;

    this.recording = true;
    this._startedAt = performance.now();
    this._runCompositeLoop();

    this._stopTimer = setTimeout(() => { this.stop(); }, MAX_DURATION_MS);
  }

  // --- MediaRecorder webm fallback path --------------------------------
  _startWebmRecorder(canvas) {
    // --- video stream: composite canvas + branded overlay, own rAF loop ---
    let videoStream = canvas.captureStream(this._recordFps);
    if (videoStream.getVideoTracks().length === 0) {
      // Intermittent Chrome quirk: captureStream() on a canvas that hasn't
      // been composited yet can come back with no video track even though
      // we just painted a frame into it (see the fillRect above _start()).
      // One retry — by now a microtask/paint boundary has passed — recovers
      // the video track in practice. Only if this also fails do we accept a
      // genuinely audio-only recording, and we surface that via onError
      // instead of silently proceeding.
      videoStream = canvas.captureStream(this._recordFps);
      if (videoStream.getVideoTracks().length === 0) {
        console.error('[recorder] captureStream() produced no video track after retry — recording audio only');
        this._onError?.('NO VIDEO TRACK — recording audio only');
      }
    }

    // --- audio: MediaStreamAudioDestinationNode fed from engine.output, no disconnect of speakers ---
    const dest = this.ctx.createMediaStreamDestination();
    this._destNode = dest;
    this.audioNode.connect(dest);

    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    this._mimeType = pickMimeType();
    const options = this._mimeType ? { mimeType: this._mimeType } : {};
    options.videoBitsPerSecond = 8_000_000;
    options.audioBitsPerSecond = 192_000;

    this._videoChunks = [];
    const mr = new MediaRecorder(combined, options);
    mr.ondataavailable = (e) => { if (e.data && e.data.size) this._videoChunks.push(e.data); };
    mr.onerror = (e) => {
      console.error('[recorder] MediaRecorder error', e);
      this._onError?.('RECORDER ERROR');
      this._handleEncoderFailure();
    };
    this._mediaRecorder = mr;
    mr.start(250);
  }

  // --- WebCodecs MP4 path ------------------------------------------------
  _startMp4Encoders(cw, ch) {
    const target = new ArrayBufferTarget();
    this._muxerTarget = target;
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width: cw, height: ch },
      audio: { codec: 'aac', numberOfChannels: 2, sampleRate: this.ctx.sampleRate },
      fastStart: 'in-memory',
      // Video's first VideoFrame timestamp and audio's first PCM-tap chunk
      // timestamp are each zeroed against their own clocks (performance.now()
      // vs. sample count) and won't land on the exact same instant — a hard
      // zero ('strict') would throw. 'cross-track-offset' shifts both tracks
      // by one shared offset, preserving true audio/video relative timing;
      // plain 'offset' zeroes each track independently and silently eats any
      // startup skew between them.
      firstTimestampBehavior: 'cross-track-offset',
    });
    this._muxer = muxer;

    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        console.error('[recorder] VideoEncoder error', e);
        this._onError?.('VIDEO ENCODER ERROR — stopping');
        this._handleEncoderFailure();
      },
    });
    videoEncoder.configure({
      codec: 'avc1.640028',
      width: cw,
      height: ch,
      bitrate: 8_000_000,
      framerate: this._recordFps,
    });
    this._videoEncoder = videoEncoder;

    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => {
        console.error('[recorder] AudioEncoder error', e);
        this._onError?.('AUDIO ENCODER ERROR — stopping');
        this._handleEncoderFailure();
      },
    });
    audioEncoder.configure({
      codec: 'mp4a.40.2',
      sampleRate: this.ctx.sampleRate,
      numberOfChannels: 2,
      bitrate: 192_000,
    });
    this._audioEncoder = audioEncoder;

    this._lastKeyFrameUs = -Infinity;
  }

  _encodeVideoFrame() {
    const encoder = this._videoEncoder;
    if (!encoder || encoder.state !== 'configured') return;
    // Backpressure: skip encoding this frame if the encoder is falling behind.
    if (encoder.encodeQueueSize > MP4_BACKPRESSURE_QUEUE_SIZE) return;

    const timestampUs = Math.round((performance.now() - this._startedAt) * 1000);
    const frame = new VideoFrame(this._compositeCanvas, { timestamp: timestampUs });
    let keyFrame = false;
    if (timestampUs - this._lastKeyFrameUs >= MP4_KEYFRAME_INTERVAL_US) {
      keyFrame = true;
      this._lastKeyFrameUs = timestampUs;
    }
    try {
      encoder.encode(frame, { keyFrame });
    } finally {
      frame.close();
    }
  }

  _encodeAudioChunk(l, r) {
    const n = l.length;
    const planar = new Float32Array(n * 2);
    planar.set(l, 0);
    planar.set(r, n);
    const timestamp = this._audioTimestampUs;
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: this.ctx.sampleRate,
      numberOfFrames: n,
      numberOfChannels: 2,
      timestamp,
      data: planar,
    });
    try {
      this._audioEncoder.encode(data);
    } finally {
      data.close();
    }
    this._audioTimestampUs += (n / this.ctx.sampleRate) * 1e6;
  }

  _runCompositeLoop() {
    // A fixed-interval timer, not requestAnimationFrame: rAF throttles to
    // near-zero in background/inactive tabs (and in headless test panes),
    // which would silently stall both the webm capture and the MP4 encode
    // queue if the user tabs away mid-recording. setTimeout keeps drawing
    // at a steady ~60fps regardless of tab visibility.
    // Drift-corrected: each tick is scheduled against an absolute timebase,
    // so draw+encode execution time doesn't additively stack onto the period
    // (tail-scheduling would sag below target fps under FULL MODE + encode
    // load). Runs at this._recordFps (60, or 30 on marginal FULL-mode
    // machines — see FULL_FPS_DOWNGRADE_THRESHOLD).
    const FRAME_INTERVAL_MS = 1000 / this._recordFps;
    let nextTick = performance.now() + FRAME_INTERVAL_MS;
    const draw = () => {
      if (!this.recording) return;
      const ctx = this._compositeCtx;
      const cw = this._compositeCanvas.width;
      const ch = this._compositeCanvas.height;

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);

      // cover-fit draw of glCanvas
      this._drawCover(ctx, this.glCanvas, cw, ch);
      // hud overlay (already alpha-transparent 2D canvas), stretched to fit
      ctx.drawImage(this.hudCanvas, 0, 0, cw, ch);

      drawBrandFrame(ctx, cw, ch);

      if (this._useMp4) this._encodeVideoFrame();

      nextTick += FRAME_INTERVAL_MS;
      const now = performance.now();
      if (nextTick < now) nextTick = now; // fell behind — skip, don't spiral
      this._compositeRaf = setTimeout(draw, nextTick - now);
    };
    this._compositeRaf = setTimeout(draw, FRAME_INTERVAL_MS);
  }

  _drawCover(ctx, srcCanvas, dw, dh) {
    const sw = srcCanvas.width || dw;
    const sh = srcCanvas.height || dh;
    if (!sw || !sh) return;
    const srcAspect = sw / sh;
    const dstAspect = dw / dh;
    let drawW, drawH, dx, dy;
    if (srcAspect > dstAspect) {
      drawH = dh;
      drawW = dh * srcAspect;
      dx = (dw - drawW) / 2;
      dy = 0;
    } else {
      drawW = dw;
      drawH = dw / srcAspect;
      dx = 0;
      dy = (dh - drawH) / 2;
    }
    ctx.drawImage(srcCanvas, dx, dy, drawW, drawH);
  }

  // Fired from an encoder/MediaRecorder error callback mid-recording. The
  // encoder is already dead (WebCodecs auto-closes on error; MediaRecorder
  // goes 'inactive'), so waiting for the user to hit the button would just
  // wedge on "● STOP" when flush() throws. Instead, stop proactively and
  // salvage whatever was captured — stop() itself is written to tolerate an
  // already-errored encoder, so this is the same code path as a manual stop.
  _handleEncoderFailure() {
    if (this._encoderFailed || !this.recording) return;
    this._encoderFailed = true;
    const stopPromise = this.stop();
    const timeout = new Promise((resolve) => setTimeout(resolve, GRACEFUL_STOP_TIMEOUT_MS, 'timeout'));
    Promise.race([stopPromise, timeout]).then((v) => {
      if (v === 'timeout') {
        console.error('[recorder] graceful stop after encoder failure did not settle — forcing teardown');
      }
    });
    stopPromise.catch((err) => {
      // stop() is defensive (see below) and should not normally reject, but
      // guarantee there is never an unhandled rejection or a wedged state
      // even if something unexpected throws.
      console.error('[recorder] stop() after encoder failure threw — forcing teardown', err);
      this._onError?.('RECORDING FAILED — no file');
      this._teardownOnError();
      if (typeof this.onStop === 'function') this.onStop(null);
    });
  }

  async stop() {
    if (!this.recording) return null;
    this.recording = false;
    this._encoderFailed = false; // consumed for this stop cycle

    if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }
    if (this._compositeRaf) { clearTimeout(this._compositeRaf); this._compositeRaf = null; }

    // --- finalize video — never let a dead/errored encoder throw here.
    // Each step is independently guarded so a failure in one (e.g. video
    // flush after a VideoEncoder error) still lets the rest of stop() run
    // and salvage the audio (WAV always available — the PCM tap is
    // independent of the encoders) and, where possible, a partial video.
    let videoBlob = null, videoKind = null, ext = null;
    if (this._useMp4) {
      const v = this._videoEncoder;
      const a = this._audioEncoder;
      try { if (v && v.state === 'configured') await v.flush(); } catch (e) { console.error('[recorder] video flush failed', e); }
      try { if (a && a.state === 'configured') await a.flush(); } catch (e) { console.error('[recorder] audio flush failed', e); }
      try { if (v && v.state !== 'closed') v.close(); } catch (e) { /* already closed */ }
      try { if (a && a.state !== 'closed') a.close(); } catch (e) { /* already closed */ }
      this._videoEncoder = null;
      this._audioEncoder = null;
      try {
        this._muxer.finalize();
        const buf = this._muxerTarget.buffer;
        if (buf && buf.byteLength > 0) {
          videoBlob = new Blob([buf], { type: 'video/mp4' });
          videoKind = 'mp4';
          ext = 'mp4';
        }
      } catch (e) {
        console.error('[recorder] mp4 finalize failed — no video salvageable, WAV export still available', e);
        this._onError?.('VIDEO LOST — audio saved');
      }
      this._muxer = null;
      this._muxerTarget = null;
    } else {
      const mr = this._mediaRecorder;
      try {
        if (mr && mr.state !== 'inactive') {
          const webmDone = new Promise((resolve) => { mr.onstop = resolve; });
          mr.stop();
          await webmDone;
        }
        if (this._videoChunks.length) {
          videoBlob = new Blob(this._videoChunks, { type: this._mimeType || 'video/webm' });
          videoKind = 'webm';
          ext = 'webm';
        }
      } catch (e) {
        console.error('[recorder] webm finalize failed — no video salvageable, WAV export still available', e);
        this._onError?.('VIDEO LOST — audio saved');
      }
      this._mediaRecorder = null;
      this._videoChunks = [];
    }

    // --- finalize audio tap (always attempted — independent of encoder health) ---
    try { if (this._pcmNode) this.audioNode.disconnect(this._pcmNode); } catch (e) { /* not connected */ }
    try { if (this._destNode) this.audioNode.disconnect(this._destNode); } catch (e) { /* not connected */ }
    if (this._pcmNode) this._pcmNode.port.onmessage = null;
    try { if (this._pcmNode) this._pcmNode.disconnect(); } catch (e) { /* already disconnected */ }
    this._pcmNode = null;
    this._destNode = null;

    const total = this._pcmFrameCount;
    const chL = new Float32Array(total);
    const chR = new Float32Array(total);
    let off = 0;
    for (let i = 0; i < this._pcmL.length; i++) {
      chL.set(this._pcmL[i], off);
      chR.set(this._pcmR[i], off);
      off += this._pcmL[i].length;
    }
    this._pcmL = [];
    this._pcmR = [];

    const now = new Date();
    const tags = [
      ['IART', 'Sinaida — sinaida.eu'],
      ['IPRD', 'AETHER CURRENTS'],
      ['ICOP', 'Built-in sounds © Sinaida, CC BY 4.0. ATTRIBUTION REQUIRED wherever this audio appears: Made with AETHER CURRENTS by Sinaida — sinaida.eu'],
      ['ICMT', 'https://sinaida.eu'],
      ['ICRD', isoDate(now)],
    ];
    const wavBlob = encodeWav(chL, chR, this.ctx.sampleRate, tags);

    const slug = timestampSlug(now);
    // ext is null when video capture failed entirely (nothing salvageable) —
    // filename.video/webm are then omitted rather than naming a file that
    // doesn't exist; wav is always present since the PCM tap never depends
    // on encoder health.
    const filename = {
      wav: `aether-currents_${slug}.wav`,
    };
    if (ext) {
      filename.video = `aether-currents_${slug}.${ext}`;
      // Legacy key, kept for js/main.js back-compat — extension-correct for
      // whichever kind was actually produced (mp4 on WebCodecs, webm on the
      // MediaRecorder fallback).
      filename.webm = `aether-currents_${slug}.${ext}`;
    }

    const result = {
      videoBlob,
      videoKind,
      wavBlob,
      filename,
      // Legacy alias, kept for js/main.js back-compat.
      webmBlob: videoBlob,
    };
    if (typeof this.onStop === 'function') this.onStop(result);
    return result;
  }
}

// Exported for dev-test verification (dev-test/check_wav.py drives the
// whole pipeline via the browser; this export lets a Node smoke-test the
// pure-function encoder in isolation).
export { encodeWav };

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
