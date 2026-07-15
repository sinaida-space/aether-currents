// field.js — persistent 2D fluid-field sim for MEDIUM mode (issue #44, Task A).
//
// Stable-fluids-lite: semi-Lagrangian self-advection of velocity, a Jacobi
// pressure projection (this is what makes injected vortices keep spinning
// instead of dissipating in a couple of frames — incompressibility is
// required, not decorative), then dye advected by the divergence-free
// velocity field and left to decay on its own.
//
// No deps. ZERO allocation in splat()/step() — every working buffer is a
// preallocated Float32Array; ping-pong buffers are swapped by re-assigning
// the instance properties (`this.vx = vx2; this._vx2 = vx;`), never by
// allocating a new array. `summary` is a single object mutated in place so
// callers (mapping.js) never allocate reading the per-frame result either.
//
// Grid is collocated (not staggered) at 32x24 — simple and plenty stable at
// this resolution given the damping below.

const NX = 32;
const NY = 24;
const N = NX * NY;

const JACOBI_ITERS = 12;
const VEL_DAMP = 0.995; // per-step (not per-second) global velocity damping
const DYE_DECAY = 0.99; // per-step dye decay
const ENERGY_EPS = 1e-5; // mean |v|^2 below this = "no motion left"
const DYE_EPS = 1e-3; // summed dye below this = "wake has faded"

function idx(x, y) {
  return y * NX + x;
}

function clampf(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Bilinear sample of a scalar grid at continuous (x, y), clamped to bounds
// (Neumann-ish: sampling past the edge just holds the edge value).
function sampleBilinear(src, x, y) {
  x = clampf(x, 0, NX - 1.001);
  y = clampf(y, 0, NY - 1.001);
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = x - x0;
  const fy = y - y0;
  const i00 = src[idx(x0, y0)];
  const i10 = src[idx(x1, y0)];
  const i01 = src[idx(x0, y1)];
  const i11 = src[idx(x1, y1)];
  const a = i00 + (i10 - i00) * fx;
  const b = i01 + (i11 - i01) * fx;
  return a + (b - a) * fy;
}

export class Field {
  constructor() {
    this.nx = NX;
    this.ny = NY;

    // Velocity, ping-ponged.
    this.vx = new Float32Array(N);
    this.vy = new Float32Array(N);
    this._vx2 = new Float32Array(N);
    this._vy2 = new Float32Array(N);

    // Dye (the visible/audible "wake"), ping-ponged.
    this.dye = new Float32Array(N);
    this._dye2 = new Float32Array(N);

    // Pressure-solve scratch.
    this._div = new Float32Array(N);
    this._p = new Float32Array(N);
    this._p2 = new Float32Array(N);

    // Vorticity scratch, recomputed every step for the mapping summary.
    this._vort = new Float32Array(N);

    // Single mutable summary object — same reference every frame.
    this.summary = {
      centroidX: 0.5,
      centroidY: 0.5,
      meanSpeed: 0,
      vorticity: 0,
      energy: 0,
      dyeSum: 0,
      asleep: true,
    };
  }

  // True once velocity + dye have both decayed below their sleep epsilons.
  // Callers (mapping.js) use this to decide whether step() is worth calling
  // at all — the field genuinely stops costing anything once asleep.
  hasEnergy() {
    return !this.summary.asleep;
  }

  // Inject a force + dye splat at normalized (xNorm, yNorm) in [0,1].
  // fx/fy are grid-unit force (caller scales from landmark velocity);
  // radius is in grid cells, gaussian falloff.
  splat(xNorm, yNorm, fx, fy, dyeAmt, radius) {
    const cx = xNorm * (NX - 1);
    const cy = yNorm * (NY - 1);
    const r = radius || 2.5;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r * 2));
    const x1 = Math.min(NX - 1, Math.ceil(cx + r * 2));
    const y0 = Math.max(0, Math.floor(cy - r * 2));
    const y1 = Math.min(NY - 1, Math.ceil(cy + r * 2));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2 * 4) continue;
        const w = Math.exp(-d2 / (2 * r2));
        const i = idx(x, y);
        this.vx[i] += fx * w;
        this.vy[i] += fy * w;
        const d = this.dye[i] + dyeAmt * w;
        this.dye[i] = d > 1.5 ? 1.5 : d;
      }
    }
  }

  // Advance the sim by dt seconds. Caller is responsible for clamping dt to
  // [1/120, 1/30] and for only calling step() while hasEnergy() || actively
  // injecting (see mapping.js Mapper._tick) — that's the "sleep" contract.
  step(dt) {
    // --- advect velocity (semi-Lagrangian self-advection) ---
    const vx = this.vx, vy = this.vy;
    const vx2 = this._vx2, vy2 = this._vy2;
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const i = idx(x, y);
        const bx = x - vx[i] * dt;
        const by = y - vy[i] * dt;
        vx2[i] = sampleBilinear(vx, bx, by);
        vy2[i] = sampleBilinear(vy, bx, by);
      }
    }
    this.vx = vx2; this._vx2 = vx;
    this.vy = vy2; this._vy2 = vy;

    // --- global damping ---
    const dvx = this.vx, dvy = this.vy;
    for (let i = 0; i < N; i++) {
      dvx[i] *= VEL_DAMP;
      dvy[i] *= VEL_DAMP;
    }

    // --- pressure projection (Jacobi) — required for vortices to persist ---
    const div = this._div;
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const xl = x > 0 ? x - 1 : x;
        const xr = x < NX - 1 ? x + 1 : x;
        const yb = y > 0 ? y - 1 : y;
        const yt = y < NY - 1 ? y + 1 : y;
        div[idx(x, y)] =
          -0.5 * ((dvx[idx(xr, y)] - dvx[idx(xl, y)]) + (dvy[idx(x, yt)] - dvy[idx(x, yb)]));
      }
    }
    let p = this._p, p2 = this._p2;
    p.fill(0);
    for (let iter = 0; iter < JACOBI_ITERS; iter++) {
      for (let y = 0; y < NY; y++) {
        for (let x = 0; x < NX; x++) {
          const xl = x > 0 ? x - 1 : x;
          const xr = x < NX - 1 ? x + 1 : x;
          const yb = y > 0 ? y - 1 : y;
          const yt = y < NY - 1 ? y + 1 : y;
          const i = idx(x, y);
          p2[i] = (div[i] + p[idx(xl, y)] + p[idx(xr, y)] + p[idx(x, yb)] + p[idx(x, yt)]) * 0.25;
        }
      }
      const tmp = p; p = p2; p2 = tmp;
    }
    this._p = p; this._p2 = p2;

    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const xl = x > 0 ? x - 1 : x;
        const xr = x < NX - 1 ? x + 1 : x;
        const yb = y > 0 ? y - 1 : y;
        const yt = y < NY - 1 ? y + 1 : y;
        const i = idx(x, y);
        dvx[i] -= 0.5 * (p[idx(xr, y)] - p[idx(xl, y)]);
        dvy[i] -= 0.5 * (p[idx(x, yt)] - p[idx(x, yb)]);
      }
    }

    // --- advect dye by the (now divergence-free) velocity, then decay ---
    const dye = this.dye, dye2 = this._dye2;
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const i = idx(x, y);
        const bx = x - dvx[i] * dt;
        const by = y - dvy[i] * dt;
        dye2[i] = sampleBilinear(dye, bx, by) * DYE_DECAY;
      }
    }
    this.dye = dye2; this._dye2 = dye;

    // --- vorticity + summary (dye-weighted centroid, mean speed, energy) ---
    const vort = this._vort;
    const dyeOut = this.dye;
    let vortSum = 0;
    let speedSum = 0;
    let energy = 0;
    let cx = 0, cy = 0, dyeSum = 0;
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const xl = x > 0 ? x - 1 : x;
        const xr = x < NX - 1 ? x + 1 : x;
        const yb = y > 0 ? y - 1 : y;
        const yt = y < NY - 1 ? y + 1 : y;
        const i = idx(x, y);
        const w = 0.5 * (dvy[idx(xr, y)] - dvy[idx(xl, y)]) - 0.5 * (dvx[idx(x, yt)] - dvx[idx(x, yb)]);
        vort[i] = w;
        vortSum += w < 0 ? -w : w;
        const svx = dvx[i], svy = dvy[i];
        speedSum += Math.sqrt(svx * svx + svy * svy);
        energy += svx * svx + svy * svy;
        const d = dyeOut[i];
        cx += x * d;
        cy += y * d;
        dyeSum += d;
      }
    }
    energy /= N;

    const s = this.summary;
    s.meanSpeed = speedSum / N;
    s.vorticity = vortSum;
    s.energy = energy;
    s.dyeSum = dyeSum;
    if (dyeSum > 1e-4) {
      s.centroidX = (cx / dyeSum) / (NX - 1);
      s.centroidY = (cy / dyeSum) / (NY - 1);
    }
    s.asleep = energy < ENERGY_EPS && dyeSum < DYE_EPS;
  }

  // Hard reset — not required by v3.6 UI but useful for a debug/dev hook.
  reset() {
    this.vx.fill(0); this.vy.fill(0);
    this._vx2.fill(0); this._vy2.fill(0);
    this.dye.fill(0); this._dye2.fill(0);
    const s = this.summary;
    s.centroidX = 0.5;
    s.centroidY = 0.5;
    s.meanSpeed = 0;
    s.vorticity = 0;
    s.energy = 0;
    s.dyeSum = 0;
    s.asleep = true;
  }
}
