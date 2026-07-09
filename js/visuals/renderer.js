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
  FEEDBACK_FS, THRESHOLD_FS, BLUR_FS, GRADE_FS,
} from './shaders.js';
import { Hud } from './hud.js';

const MODES = {
  full:  { simSize: 256, dprCap: 2, renderScale: 1.0, bloomIter: 2 },
  light: { simSize: 128, dprCap: 1, renderScale: 0.5, bloomIter: 1 },
};

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

    const gl = glCanvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;

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

    // uniform locations
    this.u = {
      sim: this._locs(this.pSim, ['uState', 'uTexSize', 'uTime', 'uDt', 'uHandPresent',
        'uAttract', 'uRadius', 'uDamping', 'uDrift', 'uLandmarks', 'uHandVelL', 'uHandVelR',
        'uMomentum', 'uBurst']),
      particle: this._locs(this.pParticle, ['uState', 'uTexSize', 'uAspect', 'uPointScale', 'uHandPresent']),
      feedback: this._locs(this.pFeedback, ['uScene', 'uPrev', 'uDecay', 'uRot', 'uZoom', 'uInput']),
      threshold: this._locs(this.pThreshold, ['uTex', 'uThresh']),
      blur: this._locs(this.pBlur, ['uTex', 'uDir']),
      grade: this._locs(this.pGrade, ['uFeedback', 'uBloom', 'uTime', 'uCentroid', 'uLevel',
        'uFrozen', 'uAberr', 'uVignette', 'uRes']),
    };

    // empty VAO — WebGL2 needs one bound even for attribute-less draws
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    // simulation state (fixed size, never reallocated on resize)
    this.simSize = this.cfg.simSize;
    this.particleCount = this.simSize * this.simSize;
    this._initSim();

    // screen-space render targets (created in resize)
    this.sceneTex = null; this.sceneFBO = null;
    this.fbTex = [null, null]; this.fbFBO = [null, null]; this.fbIndex = 0;
    this.bloomTex = [null, null]; this.bloomFBO = [null, null];
    this.rw = 0; this.rh = 0; this.bw = 0; this.bh = 0;

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

    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);

    this.resize();
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
    const gl = this.gl;
    dt = Math.min(dt || 0.016, 0.033);
    this.time += dt;

    // fps EMA on true interval
    const inst = 1 / dt;
    this._fpsEMA = this._fpsEMA ? this._fpsEMA * 0.9 + inst * 0.1 : inst;
    this.fps = this._fpsEMA;

    this._readState(state);

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
    const up = this.u.particle;
    gl.uniform1i(up.uState, 0);
    gl.uniform1i(up.uTexSize, this.simSize);
    gl.uniform1f(up.uAspect, this.aspect);
    const pscale = (2.0 + this._grainSize * 7.0) * (this.rh / 900);
    gl.uniform1f(up.uPointScale, pscale);
    gl.uniform2fv(up.uHandPresent, this._handPresent);
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
    const ug = this.u.grade;
    gl.uniform1i(ug.uFeedback, 0);
    gl.uniform1i(ug.uBloom, 1);
    gl.uniform1f(ug.uTime, this.time);
    gl.uniform1f(ug.uCentroid, this._centroid);
    gl.uniform1f(ug.uLevel, this._level);
    gl.uniform1f(ug.uFrozen, this._frozen ? 1 : 0);
    gl.uniform1f(ug.uAberr, this._level * 0.5 + this._burstFlash * 1.5);
    gl.uniform1f(ug.uVignette, 0.85);
    gl.uniform2f(ug.uRes, this.glCanvas.width, this.glCanvas.height);
    this._fullscreenDraw();

    // ---- HUD ----------------------------------------------------------------
    this.hud.draw(state, this.fps, performance.now());
  }
}
