// AETHER CURRENTS — capability probe
// Decides FULL vs BALANCED vs LIGHT mode based on GPU renderer string, CPU
// cores, device memory, connection quality, and a measured WebGL2 render
// score.

const PROBE_QUADS = 200;
const PROBE_FRAMES = 60;
const PROBE_SIZE = 512;
// Two cutoffs on the same render-score probe (avg ms/frame drawing 200
// overlapping-blur quads at 512px): unchanged 12ms boundary still separates
// "can't hold FULL" from everything else; a new 6ms boundary — half of that,
// i.e. double the headroom — separates genuinely strong GPUs (FULL) from
// mid-tier ones (BALANCED). Machines between the two cutoffs get BALANCED
// regardless of core/memory checks, since those checks below are really
// proxies for "will this choke," not "is this exceptional."
const FAST_FRAME_MS = 6;
const SLOW_FRAME_MS = 12;

const VERT_SRC = `#version 300 es
layout(location = 0) in vec2 a_pos;
uniform float u_time;
uniform float u_index;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  float angle = u_index * 2.399963 + u_time;
  float radius = 0.05 + mod(u_index * 0.017, 0.4);
  vec2 offset = vec2(cos(angle), sin(angle)) * radius;
  vec2 p = a_pos * 0.05 + offset;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec3 accum = vec3(0.0);
  float total = 0.0;
  for (int x = -2; x <= 2; x++) {
    for (int y = -2; y <= 2; y++) {
      vec2 offset = vec2(float(x), float(y)) * 0.02;
      vec2 uv = v_uv + offset;
      float d = length(uv - 0.5);
      float w = 1.0 - smoothstep(0.0, 0.7, d);
      accum += vec3(uv.x, uv.y, 1.0 - d) * w;
      total += w;
    }
  }
  outColor = vec4(accum / max(total, 0.0001), 1.0);
}`;

function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('Shader compile error: ' + info);
  }
  return shader;
}

function buildProgram(gl) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    throw new Error('Program link error: ' + info);
  }
  return program;
}

function getGpuString(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) {
      return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || 'unknown';
    }
    return gl.getParameter(gl.RENDERER) || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

async function measureRenderScore(gl) {
  let program;
  try {
    program = buildProgram(gl);
  } catch (e) {
    return { renderScore: 999, error: String(e) };
  }

  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.useProgram(program);
  const uTime = gl.getUniformLocation(program, 'u_time');
  const uIndex = gl.getUniformLocation(program, 'u_index');

  gl.viewport(0, 0, PROBE_SIZE, PROBE_SIZE);

  const frameTimes = [];
  for (let f = 0; f < PROBE_FRAMES; f++) {
    const t0 = performance.now();
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (let i = 0; i < PROBE_QUADS; i++) {
      gl.uniform1f(uTime, f * 0.05);
      gl.uniform1f(uIndex, i);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.finish();
    const t1 = performance.now();
    frameTimes.push(t1 - t0);
  }

  frameTimes.sort((a, b) => a - b);
  const mid = Math.floor(frameTimes.length / 2);
  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  return { renderScore: avg, median: frameTimes[mid] };
}

function updateStatus(onStatus, text) {
  if (typeof onStatus === 'function') {
    onStatus(text);
  }
}

/**
 * Run the system capability probe.
 * @param {(text: string) => void} [onStatus] optional callback for animated status text
 * @returns {Promise<{recommended: 'full'|'balanced'|'light', details: {gpu: string, cores: number, memoryGB: number|null, connection: string, renderScore: number}}>}
 */
export async function runSystemCheck(onStatus) {
  const startTime = performance.now();
  updateStatus(onStatus, 'SYSTEM CHECK...');

  const cores = navigator.hardwareConcurrency || 4;
  const memoryGB = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null;
  const connection = (navigator.connection && navigator.connection.effectiveType) || 'unknown';

  updateStatus(onStatus, 'SYSTEM CHECK... probing GPU');

  const canvas = document.createElement('canvas');
  canvas.width = PROBE_SIZE;
  canvas.height = PROBE_SIZE;

  const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });

  let gpu = 'unavailable';
  let renderScore = 999;

  if (gl) {
    gpu = getGpuString(gl);
    updateStatus(onStatus, 'SYSTEM CHECK... measuring render score');
    const result = await measureRenderScore(gl);
    renderScore = result.renderScore;
    const loseCtx = gl.getExtension('WEBGL_lose_context');
    if (loseCtx) loseCtx.loseContext();
  } else {
    updateStatus(onStatus, 'SYSTEM CHECK... WebGL2 unavailable');
  }

  const elapsed = performance.now() - startTime;
  if (elapsed > 2500) {
    // still return, just note it ran long; caller only cares about result
  }

  const intelWeak = /intel(?!.*(iris xe|arc))/i.test(gpu);
  const slowScore = renderScore > SLOW_FRAME_MS;
  const fastScore = renderScore <= FAST_FRAME_MS;
  const weakCores = cores < 4;
  const weakMemory = memoryGB !== null && memoryGB < 4;

  // Three-way decision (issue #48): the original LIGHT-vs-FULL gate is
  // unchanged (same conditions, same cutoff) — it now just means "LIGHT vs.
  // anything better." BALANCED is the new middle ground: neither weak enough
  // to fail that gate, nor fast/plentiful enough to clear the stricter FULL
  // bar (fast render score, 8+ cores, no weak-Intel flag). Everything that
  // doesn't clear FULL but also doesn't trip the LIGHT gate lands on
  // BALANCED by default.
  let recommended = 'balanced';
  if (slowScore || weakCores || weakMemory || (intelWeak && slowScore)) {
    recommended = 'light';
  } else if (fastScore && cores >= 8 && !intelWeak) {
    recommended = 'full';
  }

  updateStatus(onStatus, `SYSTEM CHECK... done (${elapsed.toFixed(0)}ms)`);

  return {
    recommended,
    details: {
      gpu,
      cores,
      memoryGB,
      connection,
      renderScore,
    },
  };
}
