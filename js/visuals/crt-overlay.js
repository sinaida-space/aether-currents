// crt-overlay.js — old-TV glass over the boot and start screens only (never over the
// instrument, which already owns the GPU budget).
//
// The page itself is never warped: an SVG displacement filter only moves
// whole pixels, which chews up text at the edges and shifts buttons away
// from where they click. Instead one fullscreen WebGL quad on top
// (pointer-events off) suggests a convex tube: scanlines and grain in a
// barrel-curved space, a soft glass highlight, a vignette and a faint
// red/cyan fringe that grows towards the left/right edges.
//
// Cost: CSS-pixel resolution (never devicePixelRatio), 30 fps, paused while
// the welcome overlay is hidden, one static frame under prefers-reduced-motion.

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision mediump float;
uniform vec2 uRes;     // canvas size in pixels
uniform float uTime;   // seconds
uniform float uBulge;  // barrel strength (smaller on narrow screens)

// cheap hash noise, good enough for grain
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// barrel distortion: pushes the screen outwards from the centre,
// so straight lines drawn in this space bow like a curved tube
vec2 barrel(vec2 uv, float k) {
  vec2 c = uv * 2.0 - 1.0;
  c *= 1.0 + k * dot(c, c);
  return c * 0.5 + 0.5;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 cuv = barrel(uv, uBulge);            // curved screen space

  // scanlines every 3px, bent by the curve
  float scan = 0.5 + 0.5 * sin(cuv.y * uRes.y * 2.0944);
  float dark = (1.0 - scan) * 0.09;

  // vignette: only the rim of the tube falls off, the middle stays bright
  vec2 c = cuv * 2.0 - 1.0;
  dark += smoothstep(0.6, 1.4, length(c * vec2(0.9, 1.05))) * 0.35;

  // grain, refreshed per frame
  float n = hash(floor(gl_FragCoord.xy) + fract(uTime) * 91.7);

  // phosphor: the black of a lit tube is a faint grey; grain on top
  float light = 0.03 + n * 0.06;

  // glass highlight: a soft sheen above the centre, as on a convex screen
  vec2 h = (uv - vec2(0.5, 0.64)) * vec2(1.1, 2.2);
  float sheen = exp(-dot(h, h) * 3.0) * 0.045;

  // colour fringe growing towards the sides (the tube's guns misalign there)
  vec3 tint = vec3(1.0, 0.16, 0.16) * smoothstep(0.7, 1.0, -c.x) * 0.05
            + vec3(0.0, 0.9, 1.0) * smoothstep(0.7, 1.0, c.x) * 0.05;

  vec3 col = vec3(light + sheen) + tint;
  float a = clamp(dark + light + sheen + max(tint.r, tint.b), 0.0, 1.0);
  // premultiplied alpha: colour never exceeds alpha
  gl_FragColor = vec4(col, a);
}
`;

const FRAME_MS = 1000 / 30;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[AETHER CURRENTS] crt shader:', gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

// Barrel strength of the scanline curve (the page itself stays flat);
// phones get a gentler curve.
const bulgeFor = (w) => (w < 640 ? 0.05 : 0.08);

// Mounts the overlay over the given screens (#boot, #welcome); it shows
// while any of them is visible. Returns a stop() function, or null without
// WebGL (the CSS scanlines stay then).
export function startCrt(...screens) {
  const hosts = screens.filter(Boolean);
  if (!hosts.length) return null;
  const canvas = document.createElement('canvas');
  canvas.id = 'crt-overlay';
  canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const uRes = gl.getUniformLocation(prog, 'uRes');
  const uTime = gl.getUniformLocation(prog, 'uTime');
  const uBulge = gl.getUniformLocation(prog, 'uBulge');

  // Outside the filtered host on purpose (see the header).
  document.body.appendChild(canvas);
  hosts.forEach((h) => h.classList.add('crt-on'));

  const resize = () => {
    // CSS pixels on purpose: grain and scanlines are meant to be coarse
    const w = Math.max(1, Math.round(window.innerWidth));
    const h = Math.max(1, Math.round(window.innerHeight));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.uniform2f(uRes, w, h);
    gl.uniform1f(uBulge, bulgeFor(w));
  };

  const draw = (t) => {
    resize();
    gl.uniform1f(uTime, t / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let raf = 0;
  let last = -1e9;
  let stopped = false;

  const visible = () => hosts.some((h) => !h.hidden && h.style.display !== 'none');
  const syncCanvas = () => { canvas.style.display = visible() ? '' : 'none'; };
  syncCanvas();

  const loop = (now) => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    if (!visible() || now - last < FRAME_MS) return;
    last = now;
    draw(now);
  };

  if (still) {
    draw(4000);
    window.addEventListener('resize', () => draw(4000));
  } else {
    raf = requestAnimationFrame(loop);
  }

  // The rAF above idles cheaply while hidden; stop it entirely when the
  // instrument runs and restart when the user comes back to the main screen.
  const obs = new MutationObserver(() => {
    syncCanvas();
    if (still) return;
    if (visible() && !raf) raf = requestAnimationFrame(loop);
    if (!visible() && raf) { cancelAnimationFrame(raf); raf = 0; }
  });
  hosts.forEach((h) => obs.observe(h, { attributes: true, attributeFilter: ['style', 'hidden'] }));

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    obs.disconnect();
    canvas.remove();
    hosts.forEach((h) => h.classList.remove('crt-on'));
  };
}

// Je suis le spectre d'une rose que tu portais hier au bal. Théophile Gautier, 1837
