// AETHER CURRENTS — GLSL sources (WebGL2, #version 300 es)
// All passes share a full-screen-triangle vertex shader (QUAD_VS).
// Coordinate model: particle simulation lives in a square [0,1]^2 "sim space"
// (origin bottom-left, y already un-mirrored). Aspect correction happens only
// at particle-render time so the constellation reads round on any viewport.

export const QUAD_VS = `#version 300 es
precision highp float;
out vec2 vUV;
void main(){
  // 0,0 / 2,0 / 0,2  -> covers the screen with one triangle
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;                       // 0..1 across the visible region
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// SIM — GPU particle integration. State texture packs pos.xy + (vel*0.5+0.5).zw
// so it survives an RGBA8 fallback as well as RGBA16F.
// ---------------------------------------------------------------------------
export const SIM_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int   uTexSize;
uniform float uTime;
uniform float uDt;
uniform vec2  uHandPresent;   // left, right (0/1)
uniform vec2  uAttract;       // per hand spring strength
uniform vec2  uRadius;        // per hand cluster radius
uniform float uDamping;
uniform float uDrift;         // curl-noise fog amount
uniform vec2  uLandmarks[42]; // 21 left + 21 right, sim space
uniform vec2  uHandVelL;
uniform vec2  uHandVelR;
uniform float uMomentum;
uniform vec3  uBurst;         // xy origin, z strength
out vec4 outColor;

float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
vec2  hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash22(i).x;
  float b = hash22(i + vec2(1.0, 0.0)).x;
  float c = hash22(i + vec2(0.0, 1.0)).x;
  float d = hash22(i + vec2(1.0, 1.0)).x;
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
vec2 curl(vec2 p){
  float e = 0.15;
  float n1 = vnoise(p + vec2(0.0, e)), n2 = vnoise(p - vec2(0.0, e));
  float n3 = vnoise(p + vec2(e, 0.0)), n4 = vnoise(p - vec2(e, 0.0));
  return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
}

void main(){
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int idx = fc.y * uTexSize + fc.x;
  vec4 s = texelFetch(uState, fc, 0);
  vec2 pos = s.xy;
  vec2 vel = (s.zw - 0.5) * 2.0;

  float fh = float(idx);
  int lm = int(hash11(fh + 0.5) * 42.0);
  lm = clamp(lm, 0, 41);
  int hand = lm < 21 ? 0 : 1;
  float present = hand == 0 ? uHandPresent.x : uHandPresent.y;

  // per-particle jitter so a landmark reads as a fuzzy star, not a single dot
  vec2 off = hash22(vec2(fh, fh * 1.7)) * 2.0 - 1.0;

  // dreamcore fog body
  vec2 force = curl(pos * 4.0 + uTime * 0.03) * uDrift;

  if(present > 0.5){
    float attract = hand == 0 ? uAttract.x : uAttract.y;
    float radius  = hand == 0 ? uRadius.x  : uRadius.y;
    vec2 target = uLandmarks[lm] + off * radius;
    force += (target - pos) * attract;          // spring toward star point
    vec2 hv = hand == 0 ? uHandVelL : uHandVelR;
    force += hv * uMomentum;                     // trail behind fast moves
  } else {
    // no hand -> slow ambient nebula, gentle pull keeps it on-screen
    force += (vec2(0.5) - pos) * 0.22;
  }

  // radial shockwave
  if(uBurst.z > 0.0){
    vec2 bd = pos - uBurst.xy;
    float dl = length(bd) + 1e-3;
    force += (bd / dl) * uBurst.z * exp(-dl * 3.5);
  }

  vel += force * uDt;
  vel *= uDamping;
  float sp = length(vel);
  if(sp > 2.5) vel *= 2.5 / sp;
  pos += vel * uDt;
  pos = clamp(pos, -0.15, 1.15);

  outColor = vec4(pos, vel * 0.5 + 0.5);
}`;

// ---------------------------------------------------------------------------
// PARTICLE render — additive point sprites, position pulled from state tex.
// ---------------------------------------------------------------------------
export const PARTICLE_VS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int   uTexSize;
uniform float uAspect;      // width/height
uniform float uPointScale;
uniform vec2  uHandPresent;
out float vEnergy;
float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main(){
  int idx = gl_VertexID;
  ivec2 uv = ivec2(idx % uTexSize, idx / uTexSize);
  vec4 s = texelFetch(uState, uv, 0);
  vec2 pos = s.xy;
  vec2 vel = (s.zw - 0.5) * 2.0;
  float e = clamp(length(vel) * 3.0, 0.0, 1.0);

  // same landmark assignment as the sim: anchored particles are the stars,
  // unanchored ones are dim fog — brightness must not depend on velocity alone
  int lm = clamp(int(hash11(float(idx) + 0.5) * 42.0), 0, 41);
  float present = lm < 21 ? uHandPresent.x : uHandPresent.y;
  vEnergy = mix(0.006 + e * 0.012, 0.010 + e * 0.026, present);

  vec2 ndc = pos * 2.0 - 1.0;
  ndc.x /= uAspect;                       // keep the constellation round
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = uPointScale * (0.6 + e * 1.4 + present * 0.5);
}`;

export const PARTICLE_FS = `#version 300 es
precision highp float;
in float vEnergy;
out vec4 outColor;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;                                 // soft radial falloff
  float i = vEnergy;                      // anchored stars bright, fog dim (set in VS)
  outColor = vec4(vec3(i), a);            // colour comes later, in grade
}`;

// ---------------------------------------------------------------------------
// FEEDBACK — scene composited over the decayed, zoomed, rotated prev frame.
// ---------------------------------------------------------------------------
export const FEEDBACK_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uPrev;
uniform float uDecay;
uniform float uRot;
uniform float uZoom;
uniform float uInput;                     // scene attenuation into the loop
void main(){
  vec2 c = vUV - 0.5;
  float s = sin(uRot), co = cos(uRot);
  c = mat2(co, -s, s, co) * c;
  c *= uZoom;                             // >1 -> echoes drift outward
  vec3 prev = texture(uPrev, c + 0.5).rgb * uDecay;
  // Attenuate the scene going in so the geometric series
  // sum ~= scene*uInput/(1-uDecay) stays bounded instead of running away.
  vec3 scene = texture(uScene, vUV).rgb * uInput;
  outColor = vec4(scene + prev, 1.0);
}`;

// ---------------------------------------------------------------------------
// BLOOM — bright-pass threshold, then separable gaussian blur.
// ---------------------------------------------------------------------------
export const THRESHOLD_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uThresh;
void main(){
  vec3 c = texture(uTex, vUV).rgb;
  float b = max(c.r, max(c.g, c.b));
  float k = smoothstep(uThresh, uThresh * 2.0, b);
  outColor = vec4(c * k, 1.0);
}`;

export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uDir;                        // texel * axis
void main(){
  vec3 c = texture(uTex, vUV).rgb * 0.227;
  c += texture(uTex, vUV + uDir * 1.384).rgb * 0.316;
  c += texture(uTex, vUV - uDir * 1.384).rgb * 0.316;
  c += texture(uTex, vUV + uDir * 3.230).rgb * 0.070;
  c += texture(uTex, vUV - uDir * 3.230).rgb * 0.070;
  outColor = vec4(c, 1.0);
}`;

// ---------------------------------------------------------------------------
// GRADE — palette mapping + film grain + vignette + scanlines + chroma.
// Palette is driven by audio (centroid -> hue, level -> brightness/sat) and
// frozen (icy cyan-white). Colour is applied here, never per-particle.
// ---------------------------------------------------------------------------
export const GRADE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uFeedback;
uniform sampler2D uBloom;
uniform sampler2D uCam;
uniform float uCamOn;
uniform vec2  uCamRes;
uniform float uTime;
uniform float uCentroid;
uniform float uLevel;
uniform float uFrozen;
uniform float uAberr;
uniform float uVignette;
uniform vec2  uRes;

vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float hash1(float p){ return fract(sin(p * 127.1) * 43758.5453); }

// cover-fit + mirror (selfie view) into the webcam texture's own aspect
vec2 camUV(vec2 uv){
  float sAsp = uRes.x / max(uRes.y, 1.0);
  float vAsp = uCamRes.x / max(uCamRes.y, 1.0);
  vec2 st = uv - 0.5;
  if (sAsp > vAsp) {
    st.y *= vAsp / sAsp;
  } else {
    st.x *= sAsp / vAsp;
  }
  st += 0.5;
  st.x = 1.0 - st.x; // mirror horizontally so it matches the particle constellation
  return st;
}

// retro VHS-styled webcam background: RGB delay, line jitter/tearing,
// coarse scanlines, tape noise + tracking-error band, desat + warm-magenta tint.
vec3 vhs(vec2 uv){
  vec2 cuv = camUV(uv);

  float row = floor(uv.y * uRes.y);
  float jitter = (hash1(row + floor(uTime * 30.0)) - 0.5) * 0.002;

  float tearCycle = mod(uTime, 3.0);
  float tearActive = step(tearCycle, 0.2);
  float tearSeed = floor(uTime / 3.0);
  float tearStart = hash1(tearSeed) * uRes.y;
  float inBand = step(tearStart, row) * step(row, tearStart + 10.0);
  jitter += tearActive * inBand * 0.01;

  cuv.x += jitter;

  float split = 0.0035 * (0.5 + uLevel);
  float r = texture(uCam, cuv - vec2(split, 0.0)).r;
  float g = texture(uCam, cuv).g;
  float b = texture(uCam, cuv + vec2(split, 0.0)).b;
  vec3 col = vec3(r, g, b);

  col *= 0.82 + 0.18 * sin(uv.y * uRes.y * 3.14159265);

  col += (hash21(uv * uRes + uTime * 7.0) - 0.5) * 0.08;
  col += 0.03 * sin(uv.y * 2.0 + uTime * 0.3);

  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(luma), 0.35);
  col *= vec3(1.0, 0.82, 0.9);

  float v = smoothstep(1.05, 0.25, length(uv - 0.5));
  col *= mix(0.4, 1.0, v);

  return max(col, 0.0);
}

void main(){
  vec2 uv = vUV;
  float ab = uAberr * 0.004;
  float r = texture(uFeedback, uv + vec2(ab, 0.0)).r;
  float g = texture(uFeedback, uv).g;
  float b = texture(uFeedback, uv - vec2(ab, 0.0)).b;
  vec3 base = vec3(r, g, b);
  vec3 bloom = texture(uBloom, uv).rgb;

  // HDR energy from the (unbounded) feedback + bloom buffers
  float raw = dot(base, vec3(0.34)) + dot(bloom, vec3(0.45));

  // Roll energy into [0,1) so bright cores read as glow, not clipped white.
  float lum = 1.0 - exp(-max(raw - 0.10, 0.0) * 1.4);

  // centroid drives hue: red (1.0) -> magenta -> cyan (0.5)
  float hue = fract(1.0 - uCentroid * 0.5);
  float val = pow(lum, 0.85) * (0.7 + 0.8 * uLevel);
  // brightest cores desaturate toward white (glow), mids keep the palette hue
  float sat = clamp(0.9 + 0.1 * uLevel - lum * 0.7, 0.0, 1.0);
  vec3 col = hsv2rgb(vec3(hue, sat, val));

  // frozen -> icy cyan-white
  vec3 ice = hsv2rgb(vec3(0.55, 0.25, val * 1.1));
  col = mix(col, ice, uFrozen);

  // subtle chromatic fringe
  col += vec3(r - b, 0.0, b - r) * 0.12 * uAberr;

  // final per-channel tonemap so peaks roll off instead of clipping
  col = vec3(1.0) - exp(-col * 1.25);

  // film grain
  col += (hash21(uv * uRes + uTime) - 0.5) * 0.03;

  // ~1px scanline modulation
  col *= 0.92 + 0.08 * sin(uv.y * uRes.y);

  // vignette
  float v = smoothstep(1.15, 0.35, length(uv - 0.5));
  col *= mix(1.0, v, uVignette);

  // VHS webcam background, composited under the graded particles/trails
  if (uCamOn > 0.001) {
    vec3 bg = vhs(uv) * uCamOn * (1.0 - lum * 0.55);
    col = bg + col;
  }

  outColor = vec4(max(col, 0.0), 1.0);
}`;
