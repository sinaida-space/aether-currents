// AETHER CURRENTS — WebGL2 render pipeline.
// Pass chain per frame:
//   1. sim        (ping-pong state texture, curl + hand-attraction integration)
//   2. particles  -> sceneFBO (additive point sprites)
//   3. feedback   (scene over decayed/zoomed/rotated prev frame)  -> ping-pong
//   4. bloom      (threshold -> separable gaussian blur)
//   5. grade      -> screen (palette, grain, vignette, scanlines, chroma)
//
// No libraries, no build step. Zero per-frame allocation in frame().

import {
  QUAD_VS, SIM_FS, PARTICLE_VS, PARTICLE_FS,
  FEEDBACK_FS, THRESHOLD_FS, BLUR_FS, GRADE_FS, COPY_FS,
} from './shaders.js';
import { Hud } from './hud.js';

const MODES = {
  full:  { simSize: 256, dprCap: 2, renderScale: 1.0, bloomIter: 2 },
  light: { simSize: 128, dprCap: 1, renderScale: 0.5, bloomIter: 1 },
};

// found-footage glitch event types
const G_DATAMOSH = 1, G_ASCII = 2, G_BLEED = 3, G_WOBBLE = 4;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader compile: ' + gl.getShaderInfoLog(sh) + '\n' + src);
  }
  return sh;
}

function program(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('program link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export class Renderer {
  constructor(glCanvas, hudCanvas, opts = {}) {
    this.glCanvas = glCanvas;
    this.mode = opts.mode === 'light' ? 'light' : 'full';
    this.cfg = MODES[this.mode];
    this.video = opts.video || null;
    this.debug = !!opts.debug;

    const gl = glCanvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;

    // context-loss / recovery (issue #21). A GPU reset (device loss, tab
    // backgrounding, OOM) fires 'webglcontextlost'; preventDefault() tells the
    // browser we intend to recover, otherwise the context is gone for good.
    // frame() no-ops all GL work while lost so a reset never throws into the
    // rAF loop — the mapper keeps ticking so audio is never interrupted.
    // 'webglcontextrestored' rebuilds every GPU resource and resumes.
    this.contextLost = false;
    this.lossCount = 0;
    this._lossTimestamps = []; // ms timestamps, for the "repeated loss" HUD offer
    this._onContextLost = (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.lossCount++;
      this._lossTimestamps.push(performance.now());
      // eslint-disable-next-line no-console
      console.error('[AETHER CURRENTS] WebGL context lost (#' + this.lossCount + ')');
    };
    this._onContextRestored = () => {
      // eslint-disable-next-line no-console
      console.info('[AETHER CURRENTS] WebGL context restored — rebuilding pipeline');
      try {
        this._buildGPUResources();
        this.resize();
      } finally {
        this.contextLost = false;
      }
    };
    glCanvas.addEventListener('webglcontextlost', this._onContextLost, false);
    glCanvas.addEventListener('webglcontextrestored', this._onContextRestored, false);

    // glitch scheduler state (zero per-frame allocation)
    this._glitchActive = false;
    this._glitchType = 0;
    this._glitchT0 = 0;
    this._glitchDur = 0;
    this._glitchSeed = 0;
    this._glitchProg = 0;
    this._nextGlitchAt = 0;
    this._audioPrevLevel = 0;
    this._audioCooldown = 0;
    this._motionEMA = new Float32Array(2);

    // camcorder OSD state (hud reads these via the object passed to draw)
    this._camEnabledAt = 0;
    this._osdOn = true;

    // preallocated uniform scratch (no per-frame allocation)
    this._landmarks = new Float32Array(84); // 42 * vec2
    this._handPresent = new Float32Array(2);
    this._attract = new Float32Array(2);
    this._radius = new Float32Array(2);
    this._handVelL = new Float32Array(2);
    this._handVelR = new Float32Array(2);
    this._burst = new Float32Array(3);

    // dynamic sim / burst state
    this.time = 0;
    this._prevBurst = 0;
    this._burstTimer = 0;
    this._burstFlash = 0;

    // fps (EMA of true frame interval)
    this.fps = 0;
    this._fpsEMA = 0;

    this.hud = new Hud(hudCanvas);

    // screen-space render targets (created in resize)
    this.sceneTex = null; this.sceneFBO = null;
    this.fbTex = [null, null]; this.fbFBO = [null, null]; this.fbIndex = 0;
    this.bloomTex = [null, null]; this.bloomFBO = [null, null];
    this.rw = 0; this.rh = 0; this.bw = 0; this.bh = 0;

    // everything below creates GL objects (programs, textures, FBOs, sim
    // buffers) — pulled into a method so contextrestored can redo it verbatim.
    this._buildGPUResources();

    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);

    this.resize();
  }

  // (Re)creates every GPU-side resource: programs/uniform locs, the shared
  // VAO, the cam/prev-cam textures, the glyph atlas, and the sim ping-pong.
  // Called once from the constructor and again on 'webglcontextrestored' —
  // after a context loss all previous handles are invalid, so this must not
  // assume anything from a prior run still exists.
  _buildGPUResources() {
    const gl = this.gl;

    // float render targets where possible, RGBA8 fallback otherwise
    const floatExt = gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');       // best-effort linear filtering
    if (floatExt) {
      this.colIFmt = gl.RGBA16F; this.colType = gl.HALF_FLOAT;
    } else {
      this.colIFmt = gl.RGBA8; this.colType = gl.UNSIGNED_BYTE;
    }
    this.floatTargets = !!floatExt;

    // programs
    this.pSim = program(gl, QUAD_VS, SIM_FS);
    this.pParticle = program(gl, PARTICLE_VS, PARTICLE_FS);
    this.pFeedback = program(gl, QUAD_VS, FEEDBACK_FS);
    this.pThreshold = program(gl, QUAD_VS, THRESHOLD_FS);
    this.pBlur = program(gl, QUAD_VS, BLUR_FS);
    this.pGrade = program(gl, QUAD_VS, GRADE_FS);
    this.pCopy = program(gl, QUAD_VS, COPY_FS);

    // uniform locations
    this.u = {
      sim: this._locs(this.pSim, ['uState', 'uTexSize', 'uTime', 'uDt', 'uHandPresent',
        'uAttract', 'uRadius', 'uDamping', 'uDrift', 'uLandmarks', 'uHandVelL', 'uHandVelR',
        'uMomentum', 'uBurst']),
      particle: this._locs(this.pParticle, ['uState', 'uTexSize', 'uAspect', 'uPointScale', 'uHandPresent',
        'uField', 'uFieldOn']),
      feedback: this._locs(this.pFeedback, ['uScene', 'uPrev', 'uDecay', 'uRot', 'uZoom', 'uInput']),
      threshold: this._locs(this.pThreshold, ['uTex', 'uThresh']),
      blur: this._locs(this.pBlur, ['uTex', 'uDir']),
      grade: this._locs(this.pGrade, ['uFeedback', 'uBloom', 'uCam', 'uPrevCam', 'uGlyphAtlas',
        'uCamOn', 'uCamRes', 'uTime', 'uCentroid', 'uLevel', 'uFrozen', 'uAberr', 'uVignette',
        'uRes', 'uGlyphCount', 'uGlitchType', 'uGlitchProg', 'uGlitchSeed', 'uMotion']),
      copy: this._locs(this.pCopy, ['uTex']),
    };

    // empty VAO — WebGL2 needs one bound even for attribute-less draws
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    // VHS webcam background: single reused texture, uploaded from the video
    // element only while the toggle is on/easing (frame()). Seeded with a
    // 1x1 black pixel so it's defined before the first real upload.
    this.camTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.camTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._camOnTarget = 0;
    this._camOn = 0;
    this._camResX = 1;
    this._camResY = 1;

    // Previous-cam ping-pong (fixed 480x270 RGBA8, never reallocated): datamosh
    // samples last frame's cam. Two small textures we blit between each frame.
    this._prevCamW = 480; this._prevCamH = 270;
    this._prevCamTex = [null, null];
    this._prevCamFBO = [null, null];
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this._prevCamW, this._prevCamH, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._prevCamTex[i] = t;
      this._prevCamFBO[i] = this._makeFBO(t);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._prevCamIndex = 0;

    // glyph atlas for asciiDisplace (built once from an offscreen 2D canvas)
    this._buildGlyphAtlas();

    // MEDIUM field texture (v3.6, #44): 32x24 single-channel dye wake, sampled
    // by the particle pass. R8 is core WebGL2, no extension needed. Reseeded
    // to zero here (and again on context restore) so it never shows garbage
    // before the first upload.
    this.fieldW = 32; this.fieldH = 24;
    this._fieldUploadBuf = new Uint8Array(this.fieldW * this.fieldH); // preallocated, zero per-frame alloc
    this.fieldTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.fieldW, this.fieldH, 0,
      gl.RED, gl.UNSIGNED_BYTE, this._fieldUploadBuf);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._fieldOn = 0;
    this._fieldUploadCounter = 0;

    // simulation state (fixed size, never reallocated on resize)
    this.simSize = this.cfg.simSize;
    this.particleCount = this.simSize * this.simSize;
    this._initSim();
  }

  _locs(prog, names) {
    const gl = this.gl;
    const out = {};
    for (const n of names) out[n] = gl.getUniformLocation(prog, n);
    return out;
  }

  _makeTex(w, h, filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.colIFmt, w, h, 0, gl.RGBA, this.colType, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _makeFBO(tex) {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return fbo;
  }

  // One-time glyph ramp atlas (white-on-black VT323 chars in a single row).
  _buildGlyphAtlas() {
    const gl = this.gl;
    const glyphs = ' .:-+*#%@▒▓'; // space .:-+*#%@ ▒ ▓
    this._glyphCount = glyphs.length;
    const cell = 32;
    const w = cell * glyphs.length, h = cell;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#fff';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `${cell - 6}px "VT323", monospace`;
    for (let i = 0; i < glyphs.length; i++) {
      c.fillText(glyphs[i], i * cell + cell / 2, h / 2 + 1);
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.glyphTex = tex;
  }

  _startGlitch(type) {
    this._glitchActive = true;
    this._glitchType = type;
    this._glitchT0 = this.time;
    this._glitchSeed = Math.random() * 997.0;
    let d;
    if (type === G_DATAMOSH) d = 0.3 + Math.random() * 0.4;
    else if (type === G_ASCII) d = 1.0 + Math.random() * 1.0;
    else if (type === G_BLEED) d = 2.0 + Math.random() * 2.0;
    else d = 0.4; // microWobble
    this._glitchDur = d;
    this._glitchProg = 0;
  }

  _pickGlitch() {
    const r = Math.random();
    if (r < 0.35) return G_DATAMOSH;
    if (r < 0.60) return G_ASCII;
    if (r < 0.85) return G_BLEED;
    return G_WOBBLE;
  }

  // Curated scheduler: one tasteful event every 4-9s, plus an audio-spike
  // datamosh. Only runs while the cam background is on.
  _updateGlitch(dt, camActive) {
    if (!camActive) {
      this._glitchActive = false; this._glitchType = 0;
      this._nextGlitchAt = 0; this._audioPrevLevel = 0; this._audioCooldown = 0;
      return;
    }
    if (this._nextGlitchAt === 0) this._nextGlitchAt = this.time + 4 + Math.random() * 5;

    // audio rising-edge over ~0.55 -> datamosh (min 2.5s cooldown)
    this._audioCooldown = Math.max(0, this._audioCooldown - dt);
    const lvl = this._level;
    if (lvl > 0.55 && this._audioPrevLevel <= 0.55 && this._audioCooldown === 0 && !this._glitchActive) {
      this._startGlitch(G_DATAMOSH);
      this._audioCooldown = 2.5;
    }
    this._audioPrevLevel = lvl;

    // scheduled event
    if (!this._glitchActive && this.time >= this._nextGlitchAt) {
      this._startGlitch(this._pickGlitch());
      this._nextGlitchAt = this.time + 4 + Math.random() * 5;
    }

    // advance the active event envelope
    if (this._glitchActive) {
      const p = (this.time - this._glitchT0) / this._glitchDur;
      this._glitchProg = p < 0 ? 0 : (p > 1 ? 1 : p);
      if (p >= 1) { this._glitchActive = false; this._glitchType = 0; }
    }

    // recent global motion (EMA of hand velocities) biases the datamosh drift
    const mx = (this._handVelL[0] + this._handVelR[0]) * 0.5;
    const my = (this._handVelL[1] + this._handVelR[1]) * 0.5;
    this._motionEMA[0] += (mx - this._motionEMA[0]) * 0.08;
    this._motionEMA[1] += (my - this._motionEMA[1]) * 0.08;
  }

  _initSim() {
    const gl = this.gl;
    const n = this.simSize;
    const count = n * n * 4;

    // state textures: pos in [0,1] scattered, velocity encoded at 0.5 (=zero)
    this.stateTex = [null, null];
    this.stateFBO = [null, null];
    this.stateIndex = 0;

    let data;
    if (this.floatTargets) {
      data = new Float32Array(count);
      for (let i = 0; i < n * n; i++) {
        data[i * 4 + 0] = Math.random();
        data[i * 4 + 1] = Math.random();
        data[i * 4 + 2] = 0.5;
        data[i * 4 + 3] = 0.5;
      }
    } else {
      data = new Uint8Array(count);
      for (let i = 0; i < n * n; i++) {
        data[i * 4 + 0] = (Math.random() * 255) | 0;
        data[i * 4 + 1] = (Math.random() * 255) | 0;
        data[i * 4 + 2] = 128;
        data[i * 4 + 3] = 128;
      }
    }
    const srcType = this.floatTargets ? gl.FLOAT : gl.UNSIGNED_BYTE;

    for (let s = 0; s < 2; s++) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, this.colIFmt, n, n, 0, gl.RGBA,
        s === 0 ? srcType : this.colType, s === 0 ? data : null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.stateTex[s] = t;
      this.stateFBO[s] = this._makeFBO(t);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, this.cfg.dprCap);
    const cw = this.glCanvas.clientWidth || window.innerWidth;
    const ch = this.glCanvas.clientHeight || window.innerHeight;
    const pxW = Math.max(2, Math.round(cw * dpr));
    const pxH = Math.max(2, Math.round(ch * dpr));
    this.glCanvas.width = pxW;
    this.glCanvas.height = pxH;
    this.aspect = pxW / pxH;

    // internal render res (half in light mode)
    const rs = this.cfg.renderScale;
    this.rw = Math.max(2, Math.round(pxW * rs));
    this.rh = Math.max(2, Math.round(pxH * rs));
    this.bw = Math.max(1, this.rw >> 1);
    this.bh = Math.max(1, this.rh >> 1);

    // dispose old targets
    const del = (t, f) => { if (t) gl.deleteTexture(t); if (f) gl.deleteFramebuffer(f); };
    del(this.sceneTex, this.sceneFBO);
    del(this.fbTex[0], this.fbFBO[0]); del(this.fbTex[1], this.fbFBO[1]);
    del(this.bloomTex[0], this.bloomFBO[0]); del(this.bloomTex[1], this.bloomFBO[1]);

    this.sceneTex = this._makeTex(this.rw, this.rh, gl.LINEAR);
    this.sceneFBO = this._makeFBO(this.sceneTex);
    for (let i = 0; i < 2; i++) {
      this.fbTex[i] = this._makeTex(this.rw, this.rh, gl.LINEAR);
      this.fbFBO[i] = this._makeFBO(this.fbTex[i]);
      this.bloomTex[i] = this._makeTex(this.bw, this.bh, gl.LINEAR);
      this.bloomFBO[i] = this._makeFBO(this.bloomTex[i]);
    }
    // clear feedback history so trails don't inherit garbage
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbFBO[i]);
      gl.viewport(0, 0, this.rw, this.rh);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.hud.resize();
  }

  _fullscreenDraw() {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  // VHS background toggle — eased 0..1 over ~0.5s (time-constant ~0.15s).
  setCamOn(on) {
    const t = on ? 1 : 0;
    if (t && this._camOnTarget < 0.5) this._camEnabledAt = performance.now();
    this._camOnTarget = t;
  }

  // Camcorder OSD toggle (REC dot, tape counter, date, battery). Hud reads this.
  setOsdOn(on) {
    this._osdOn = !!on;
  }

  // Pull hand fields into preallocated uniform scratch. Defensive against nulls.
  _readState(state) {
    const L = this._landmarks;
    const hands = state && state.hands ? state.hands : null;
    const fill = (hand, base, velTarget) => {
      if (!hand) { velTarget[0] = 0; velTarget[1] = 0; return 0; }
      const lm = hand.landmarks;
      if (lm && lm.length >= 63) {
        for (let i = 0; i < 21; i++) {
          L[(base + i) * 2 + 0] = lm[i * 3 + 0];
          L[(base + i) * 2 + 1] = 1.0 - lm[i * 3 + 1]; // flip y into sim space
        }
      } else {
        const x = hand.x != null ? hand.x : 0.5;
        const y = hand.y != null ? hand.y : 0.5;
        for (let i = 0; i < 21; i++) {
          L[(base + i) * 2 + 0] = x;
          L[(base + i) * 2 + 1] = 1.0 - y;
        }
      }
      const v = hand.velocity || { x: 0, y: 0 };
      velTarget[0] = v.x || 0;
      velTarget[1] = -(v.y || 0); // sim space y is flipped
      return 1;
    };

    const frozen = !!(state && state.frozen);
    const left = hands ? hands.left : null;
    const right = hands ? hands.right : null;
    this._handPresent[0] = fill(left, 0, this._handVelL);
    this._handPresent[1] = fill(right, 21, this._handVelR);

    const gest = (hand) => ({
      fist: hand && hand.fist != null ? hand.fist : 0,
      palm: hand && hand.palmOpen != null ? hand.palmOpen : 0,
    });
    const gl_ = gest(left), gr_ = gest(right);

    // spring / radius / damping shaped by fist (tighten) and palmOpen (relax)
    const attractOf = (g) => 6.0 * (1.0 + g.fist * 1.6) * (1.0 - g.palm * 0.4);
    const radiusOf = (g) => 0.022 * (1.0 - g.fist * 0.6) * (1.0 + g.palm * 1.8);
    this._attract[0] = attractOf(gl_); this._attract[1] = attractOf(gr_);
    this._radius[0] = radiusOf(gl_); this._radius[1] = radiusOf(gr_);

    // damping: frozen holds the cloud still; fist slightly steadier
    const maxFist = Math.max(gl_.fist, gr_.fist);
    this._damping = frozen ? 0.60 : (0.92 - maxFist * 0.03);
    this._frozen = frozen;

    // feedback decay grows with space + audio.level; frozen = long trails
    const audio = (state && state.audio) || { level: 0, centroid: 0 };
    const space = (state && state.params && state.params.space != null) ? state.params.space : 0;
    this._decay = frozen ? 0.965
      : Math.min(0.955, 0.86 + space * 0.08 + (audio.level || 0) * 0.02);
    this._rot = frozen ? 0.0002 : 0.002;
    this._zoom = frozen ? 1.0 : 1.003;

    this._level = Math.max(0, Math.min(1, audio.level || 0));
    this._centroid = Math.max(0, Math.min(1, audio.centroid || 0));
    this._grainSize = (state && state.params && state.params.grainSize != null)
      ? state.params.grainSize : 0.05;

    // burst: rising burstCount triggers a shockwave for ~400ms from the fastest hand
    const bc = state && state.burstCount != null ? state.burstCount : this._prevBurst;
    if (bc > this._prevBurst) {
      this._burstTimer = 0.4;
      const speed = (h) => h && h.velocity ? Math.hypot(h.velocity.x || 0, h.velocity.y || 0) : -1;
      let ox = 0.5, oy = 0.5;
      const sl = speed(left), sr = speed(right);
      const pick = sr > sl ? right : left;
      if (pick) { ox = pick.x != null ? pick.x : 0.5; oy = 1.0 - (pick.y != null ? pick.y : 0.5); }
      this._burstOX = ox; this._burstOY = oy;
    }
    this._prevBurst = bc;
  }

  frame(dt, state) {
    dt = Math.min(dt || 0.016, 0.033);
    this.time += dt;

    // Context lost: skip every GL call (they'd be no-ops at best, and some
    // getters return stale/garbage state that trips our own assertions) but
    // keep painting the 2D HUD so the "recovering" notice stays visible and
    // the rAF loop (which also drives audio mapping) never stalls.
    if (this.contextLost) {
      this.fps = 0;
      const nowMs = performance.now();
      this.hud.draw(state, 0, nowMs, {
        osdOn: this._osdOn,
        camOn: false,
        camMs: 0,
        glLost: true,
        glLossCount: this.lossCount,
        glLossRepeated: this.lossCount > 1,
      });
      return;
    }

    const gl = this.gl;

    // fps EMA on true interval
    const inst = 1 / dt;
    this._fpsEMA = this._fpsEMA ? this._fpsEMA * 0.9 + inst * 0.1 : inst;
    this.fps = this._fpsEMA;

    this._readState(state);

    // VHS background: ease toggle, upload the current video frame only while on
    const easeRate = 1 - Math.exp(-dt / 0.15);
    this._camOn += (this._camOnTarget - this._camOn) * easeRate;
    if (this._camOn < 0.001) this._camOn = 0;
    if (this.video && this._camOnTarget > 0.5 && this.video.readyState >= 2) {
      gl.bindTexture(gl.TEXTURE_2D, this.camTex);
      // Flip Y on upload so the webcam is upright (default puts the video's top
      // row at t=0 = screen bottom). camUV already mirrors X for the selfie view.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // other uploads rely on default
      this._camResX = this.video.videoWidth || 1;
      this._camResY = this.video.videoHeight || 1;
    }

    // MEDIUM field texture upload (v3.6, #44): hard-gated on field.on so
    // particle contribution is exactly zero whenever MEDIUM is off, even
    // during the field's own post-off decay tail (Task A's field keeps
    // stepping briefly after mediumOn flips false).
    const field = state && state.field;
    this._fieldOn = field && field.on ? 1 : 0;
    if (field && field.on && field.energy > 1e-7) {
      this._fieldUploadCounter = (this._fieldUploadCounter + 1) | 0;
      const uploadNow = this.mode === 'light' ? (this._fieldUploadCounter % 2 === 0) : true;
      if (uploadNow) {
        const dye = field.dye;
        const buf = this._fieldUploadBuf;
        for (let i = 0; i < buf.length; i++) {
          const v = dye[i] * 170; // dye range ~0..1.5 -> 0..255
          buf[i] = v < 0 ? 0 : (v > 255 ? 255 : v) | 0;
        }
        gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.fieldW, this.fieldH,
          gl.RED, gl.UNSIGNED_BYTE, buf);
      }
    }

    // glitch scheduler (only while the cam background is on)
    const camActive = this._camOnTarget > 0.5;
    this._updateGlitch(dt, camActive);

    // burst decay
    if (this._burstTimer > 0) {
      this._burstTimer = Math.max(0, this._burstTimer - dt);
      const k = this._burstTimer / 0.4;
      this._burst[0] = this._burstOX; this._burst[1] = this._burstOY;
      this._burst[2] = 4.5 * k;
      this._burstFlash = k;
    } else {
      this._burst[0] = this._burst[1] = this._burst[2] = 0;
      this._burstFlash = 0;
    }

    gl.bindVertexArray(this.vao);

    // ---- 1. simulation step -------------------------------------------------
    const src = this.stateIndex, dst = src ^ 1;
    gl.disable(gl.BLEND);
    gl.useProgram(this.pSim);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stateFBO[dst]);
    gl.viewport(0, 0, this.simSize, this.simSize);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex[src]);
    const us = this.u.sim;
    gl.uniform1i(us.uState, 0);
    gl.uniform1i(us.uTexSize, this.simSize);
    gl.uniform1f(us.uTime, this.time);
    gl.uniform1f(us.uDt, dt);
    gl.uniform2fv(us.uHandPresent, this._handPresent);
    gl.uniform2fv(us.uAttract, this._attract);
    gl.uniform2fv(us.uRadius, this._radius);
    gl.uniform1f(us.uDamping, this._damping);
    gl.uniform1f(us.uDrift, 0.35);
    gl.uniform2fv(us.uLandmarks, this._landmarks);
    gl.uniform2fv(us.uHandVelL, this._handVelL);
    gl.uniform2fv(us.uHandVelR, this._handVelR);
    gl.uniform1f(us.uMomentum, 0.6);
    gl.uniform3fv(us.uBurst, this._burst);
    this._fullscreenDraw();
    this.stateIndex = dst;

    // ---- 2. particles -> sceneFBO ------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFBO);
    gl.viewport(0, 0, this.rw, this.rh);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive
    gl.useProgram(this.pParticle);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex[this.stateIndex]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    const up = this.u.particle;
    gl.uniform1i(up.uState, 0);
    gl.uniform1i(up.uTexSize, this.simSize);
    gl.uniform1f(up.uAspect, this.aspect);
    const pscale = (2.0 + this._grainSize * 7.0) * (this.rh / 900);
    gl.uniform1f(up.uPointScale, pscale);
    gl.uniform2fv(up.uHandPresent, this._handPresent);
    gl.uniform1i(up.uField, 1);
    gl.uniform1f(up.uFieldOn, this._fieldOn);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);
    gl.disable(gl.BLEND);

    // ---- 3. feedback --------------------------------------------------------
    const fbSrc = this.fbIndex, fbDst = fbSrc ^ 1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbFBO[fbDst]);
    gl.viewport(0, 0, this.rw, this.rh);
    gl.useProgram(this.pFeedback);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fbTex[fbSrc]);
    const uf = this.u.feedback;
    gl.uniform1i(uf.uScene, 0);
    gl.uniform1i(uf.uPrev, 1);
    gl.uniform1f(uf.uDecay, this._decay);
    gl.uniform1f(uf.uRot, this._rot);
    gl.uniform1f(uf.uZoom, this._zoom);
    // Bound the feedback steady state: at max decay 0.965 the closed-loop
    // gain is uInput/(1-decay) ~= 0.14/0.035 ~= 4x, tamed by the grade tonemap.
    gl.uniform1f(uf.uInput, 0.14);
    this._fullscreenDraw();
    this.fbIndex = fbDst;
    const feedbackCur = this.fbTex[this.fbIndex];

    // ---- 4. bloom -----------------------------------------------------------
    // threshold: feedback (full res) -> bloomTex[0] (half res)
    gl.viewport(0, 0, this.bw, this.bh);
    gl.useProgram(this.pThreshold);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFBO[0]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, feedbackCur);
    gl.uniform1i(this.u.threshold.uTex, 0);
    gl.uniform1f(this.u.threshold.uThresh, 0.4);
    this._fullscreenDraw();

    // separable blur iterations, ping-ponging bloomTex[0] <-> bloomTex[1]
    gl.useProgram(this.pBlur);
    const ub = this.u.blur;
    const tx = 1 / this.bw, ty = 1 / this.bh;
    let bi = 0;
    for (let it = 0; it < this.cfg.bloomIter; it++) {
      // horizontal: [0] -> [1]
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFBO[bi ^ 1]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTex[bi]);
      gl.uniform1i(ub.uTex, 0);
      gl.uniform2f(ub.uDir, tx, 0);
      this._fullscreenDraw();
      bi ^= 1;
      // vertical: [1] -> [0]
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFBO[bi ^ 1]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTex[bi]);
      gl.uniform1i(ub.uTex, 0);
      gl.uniform2f(ub.uDir, 0, ty);
      this._fullscreenDraw();
      bi ^= 1;
    }
    const bloomCur = this.bloomTex[bi];

    // ---- 5. grade -> screen -------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
    gl.useProgram(this.pGrade);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, feedbackCur);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomCur);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.camTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this._prevCamTex[this._prevCamIndex]);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.glyphTex);
    const ug = this.u.grade;
    gl.uniform1i(ug.uFeedback, 0);
    gl.uniform1i(ug.uBloom, 1);
    gl.uniform1i(ug.uCam, 2);
    gl.uniform1i(ug.uPrevCam, 3);
    gl.uniform1i(ug.uGlyphAtlas, 4);
    gl.uniform1f(ug.uCamOn, this._camOn);
    gl.uniform2f(ug.uCamRes, this._camResX, this._camResY);
    gl.uniform1f(ug.uTime, this.time);
    gl.uniform1f(ug.uCentroid, this._centroid);
    gl.uniform1f(ug.uLevel, this._level);
    gl.uniform1f(ug.uFrozen, this._frozen ? 1 : 0);
    gl.uniform1f(ug.uAberr, this._level * 0.5 + this._burstFlash * 1.5);
    gl.uniform1f(ug.uVignette, 0.85);
    gl.uniform2f(ug.uRes, this.glCanvas.width, this.glCanvas.height);
    gl.uniform1f(ug.uGlyphCount, this._glyphCount);
    gl.uniform1f(ug.uGlitchType, this._glitchActive ? this._glitchType : 0);
    gl.uniform1f(ug.uGlitchProg, this._glitchActive ? this._glitchProg : 0);
    gl.uniform1f(ug.uGlitchSeed, this._glitchSeed);
    gl.uniform2fv(ug.uMotion, this._motionEMA);
    this._fullscreenDraw();

    // ---- 6. stash cam frame into the prev-cam ping-pong (datamosh source) ----
    // Runs only while the cam is on; VOID mode never touches these buffers.
    if (camActive) {
      const dstP = this._prevCamIndex ^ 1;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._prevCamFBO[dstP]);
      gl.viewport(0, 0, this._prevCamW, this._prevCamH);
      gl.useProgram(this.pCopy);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.camTex);
      gl.uniform1i(this.u.copy.uTex, 0);
      this._fullscreenDraw();
      this._prevCamIndex = dstP;
    }

    // ---- HUD ----------------------------------------------------------------
    const nowMs = performance.now();
    if (state) state.debug = this.debug;
    this.hud.draw(state, this.fps, nowMs, {
      osdOn: this._osdOn,
      camOn: camActive,
      camMs: this._camEnabledAt ? nowMs - this._camEnabledAt : 0,
      glLost: false,
      glLossCount: this.lossCount,
      // keep offering the LIGHT-mode switch for a while after recovery too,
      // not just during the outage — repeated loss is a standing problem.
      glLossRepeated: this.lossCount > 1 && (nowMs - (this._lossTimestamps[this._lossTimestamps.length - 1] || 0)) < 30000,
    });
  }

  // Runtime switch to LIGHT rendering (offered from the HUD after repeated
  // context loss — see issue #21). Rebuilds the sim at the new resolution and
  // re-derives screen-space targets; safe to call only while the context is
  // alive (contextLost guards the caller in main.js).
  setMode(mode) {
    const next = mode === 'light' ? 'light' : 'full';
    if (next === this.mode || this.contextLost) return;
    this.mode = next;
    this.cfg = MODES[next];
    this.simSize = this.cfg.simSize;
    this.particleCount = this.simSize * this.simSize;
    this._initSim();
    this.resize();
  }
}
