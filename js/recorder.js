// recorder.js — video+audio capture, branded compositing, WAV export.
// Owns two parallel recordings that both start/stop together:
//   1. a MediaRecorder on an offscreen branded-compositing canvas + audio
//      (produces the downloadable .webm)
//   2. a raw PCM tap via an inline AudioWorklet feeding a WAV encoder with
//      RIFF LIST-INFO tags (produces the downloadable .wav)
//
// Boundary: does not touch js/audio, js/tracking, js/visuals internals —
// only reads glCanvas/hudCanvas via drawImage and taps engine.output via
// the public connectRecorderTap()/output surface.

const MAX_DURATION_MS = 5 * 60 * 1000; // hard 5min cap
const PCM_CHUNK = 8192;

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

function drawBrandFrame(ctx, w, h, modeLabel, dateStr) {
  const red = '#ff2a2a';
  ctx.save();
  ctx.font = `${Math.round(h * 0.024)}px "VT323", monospace`;
  ctx.textBaseline = 'top';
  ctx.shadowColor = red;
  ctx.shadowBlur = h * 0.006;
  ctx.strokeStyle = red;
  ctx.lineWidth = Math.max(1, Math.round(h * 0.0022));
  const margin = 12;
  ctx.strokeRect(margin, margin, w - margin * 2, h - margin * 2);

  const pad = margin + 14;
  ctx.fillStyle = red;
  ctx.textAlign = 'left';
  ctx.fillText('AETHER CURRENTS', pad, pad);

  ctx.font = `${Math.round(h * 0.018)}px "VT323", monospace`;
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${modeLabel} — ${dateStr}`, pad, h - pad);

  ctx.textAlign = 'right';
  ctx.fillText('sinaida.eu', w - pad, h - pad);
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

export class Recorder {
  constructor({ glCanvas, hudCanvas, audioNode, audioContext, modeLabel }) {
    this.glCanvas = glCanvas;
    this.hudCanvas = hudCanvas;
    this.audioNode = audioNode; // engine.output
    this.ctx = audioContext;
    this.modeLabel = modeLabel;

    this.recording = false;

    // Optional hook, settable by the caller: fires with { webmBlob, wavBlob,
    // filename } whenever a recording finishes, whether via manual stop() or
    // the internal 5-minute hard-stop timer (which calls stop() on its own).
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

    await document.fonts.load('16px VT323');

    const light = this.modeLabel === 'LIGHT MODE';
    const cw = light ? 1280 : 1920;
    const ch = light ? 720 : 1080;

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    this._compositeCanvas = canvas;
    this._compositeCtx = canvas.getContext('2d');

    // --- video stream: composite canvas + branded overlay, own rAF loop ---
    const videoStream = canvas.captureStream(60);

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
    this._mediaRecorder = mr;
    mr.start(250);

    // --- parallel PCM tap for WAV ---
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
    pcmNode.port.onmessage = (e) => {
      this._pcmL.push(e.data.l);
      this._pcmR.push(e.data.r);
      this._pcmFrameCount += e.data.l.length;
    };
    this.audioNode.connect(pcmNode);
    this._pcmNode = pcmNode;

    this.recording = true;
    this._startedAt = performance.now();
    this._runCompositeLoop();

    this._stopTimer = setTimeout(() => { this.stop(); }, MAX_DURATION_MS);
  }

  _runCompositeLoop() {
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

      drawBrandFrame(ctx, cw, ch, this.modeLabel, isoDate(new Date()));

      this._compositeRaf = requestAnimationFrame(draw);
    };
    this._compositeRaf = requestAnimationFrame(draw);
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

  async stop() {
    if (!this.recording) return null;
    this.recording = false;

    if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }
    if (this._compositeRaf) { cancelAnimationFrame(this._compositeRaf); this._compositeRaf = null; }

    // --- finalize video ---
    const mr = this._mediaRecorder;
    const webmDone = new Promise((resolve) => {
      mr.onstop = resolve;
    });
    mr.stop();
    await webmDone;

    const webmBlob = new Blob(this._videoChunks, { type: this._mimeType || 'video/webm' });

    // --- finalize audio tap ---
    this.audioNode.disconnect(this._pcmNode);
    this.audioNode.disconnect(this._destNode);
    this._pcmNode.port.onmessage = null;
    this._pcmNode.disconnect();
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
    const filename = {
      webm: `aether-currents_${slug}.webm`,
      wav: `aether-currents_${slug}.wav`,
    };

    const result = { webmBlob, wavBlob, filename };
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
