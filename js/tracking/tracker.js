// AETHER CURRENTS — hand tracking main-thread facade
// Owns the frame pump (mailbox discipline: never queue more than one
// in-flight frame), the latest-snapshot store, one-euro smoothing, feature
// extraction and the gesture state machine. The vision worker only ever
// returns plain landmark data — all interpretation happens here.

const LANDMARK_COUNT = 21;

const MODE_CONFIG = {
  full: { sendHz: 40, resizeWidth: 720 },
  light: { sendHz: 20, resizeWidth: 480 },
};

// Handedness note (see report): the <video id="cam"> element carries no
// CSS mirror transform, so the raw ImageBitmap handed to the worker is the
// camera's natural (unmirrored, "looking at the user") frame. MediaPipe's
// HandLandmarker handedness classifier is documented to assume a mirrored
// / selfie-style input image. Feeding it an unmirrored frame therefore
// flips the label relative to the physical hand: MediaPipe's "Left"
// corresponds to the user's physical RIGHT hand, and "Right" to physical
// LEFT. This mapping is applied below. It is based on documented MediaPipe
// behavior, not a live empirical check (no webcam in this environment) —
// flagged for human verification via dev-test/tracking-test.html.
const SWAP_HANDEDNESS = true;

function mapLabelToSide(label) {
  if (label === 'Left') return SWAP_HANDEDNESS ? 'right' : 'left';
  if (label === 'Right') return SWAP_HANDEDNESS ? 'left' : 'right';
  return null;
}

// ---- one-euro filter ----------------------------------------------------

class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x, tMs) {
    if (this.tPrev === null) {
      this.tPrev = tMs;
      this.xPrev = x;
      this.dxPrev = 0;
      return x;
    }
    const dt = Math.max((tMs - this.tPrev) / 1000, 1e-3);
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuro.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = OneEuro.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = tMs;
    return xHat;
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
}

// ---- per-hand filter/feature bank ---------------------------------------

class HandFilterBank {
  constructor() {
    this.coord = new Array(LANDMARK_COUNT * 3);
    for (let i = 0; i < this.coord.length; i++) this.coord[i] = new OneEuro();
    this.vx = new OneEuro();
    this.vy = new OneEuro();
    this.fist = new OneEuro();
    this.palmOpen = new OneEuro();
    this.pinch = new OneEuro();

    this.lastRawX = null;
    this.lastRawY = null;
    this.lastT = null;

    // gesture-edge bookkeeping
    this.fistAbove = false; // freeze hysteresis state (4-frame persisted)
    this.aboveStreak = 0;
    this.belowStreak = 0;

    this.wasFist = false; // raw (unpersisted) fist edge, used for burst timing
    this.fistHighAt = -Infinity;
    this.releasedAt = -Infinity;
    this.armedForBurst = false;
    this.lastPalmOpen = 0;
    this.lastPalmOpenT = null;

    this.lastSeenT = -Infinity;
  }
}

// ---- landmark math --------------------------------------------------

function dist3(ax, ay, az, bx, by, bz) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function computeRawFeatures(lm) {
  // lm: Float32Array(63), already mirrored, NOT yet smoothed (smoothing
  // happens on the coords separately; features are recomputed from the
  // smoothed coords by the caller).
  const wx = lm[0], wy = lm[1], wz = lm[2];
  const mx = lm[9 * 3], my = lm[9 * 3 + 1], mz = lm[9 * 3 + 2];
  const scale = Math.max(dist3(wx, wy, wz, mx, my, mz), 1e-4);

  const tipIdx = [8, 12, 16, 20];
  let fingerDistSum = 0;
  const cx = (lm[0] + lm[5 * 3] + lm[17 * 3]) / 3;
  const cy = (lm[1] + lm[5 * 3 + 1] + lm[17 * 3 + 1]) / 3;
  const cz = (lm[2] + lm[5 * 3 + 2] + lm[17 * 3 + 2]) / 3;
  for (const t of tipIdx) {
    fingerDistSum += dist3(lm[t * 3], lm[t * 3 + 1], lm[t * 3 + 2], cx, cy, cz);
  }
  const meanTipDist = fingerDistSum / tipIdx.length / scale;
  // open hand: meanTipDist roughly ~1.2-1.6x scale; closed fist: ~0.3-0.5x
  const fist = clamp01(1 - (meanTipDist - 0.3) / (1.4 - 0.3));

  // palmOpen: mean pairwise spread of all 5 fingertips (incl thumb) +
  // extension from palm center — distinct from `fist` because it also
  // reacts to lateral finger spread, not just curl.
  const allTips = [4, 8, 12, 16, 20];
  let spreadSum = 0;
  let pairs = 0;
  for (let i = 0; i < allTips.length; i++) {
    for (let j = i + 1; j < allTips.length; j++) {
      const ti = allTips[i] * 3, tj = allTips[j] * 3;
      spreadSum += dist3(lm[ti], lm[ti + 1], lm[ti + 2], lm[tj], lm[tj + 1], lm[tj + 2]);
      pairs++;
    }
  }
  const meanSpread = spreadSum / pairs / scale;
  let extSum = 0;
  for (const t of allTips) {
    extSum += dist3(lm[t * 3], lm[t * 3 + 1], lm[t * 3 + 2], cx, cy, cz);
  }
  const meanExt = extSum / allTips.length / scale;
  const palmOpen = clamp01(((meanSpread / 1.6) + (meanExt / 1.5)) / 2);

  // pinch: thumb-tip <-> index-tip, normalized, inverted so closed=1
  const pinchDist =
    dist3(lm[4 * 3], lm[4 * 3 + 1], lm[4 * 3 + 2], lm[8 * 3], lm[8 * 3 + 1], lm[8 * 3 + 2]) /
    scale;
  const pinch = clamp01(1 - (pinchDist - 0.15) / (1.1 - 0.15));

  return { fist, palmOpen, pinch, scale };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---- HandTracker ----------------------------------------------------

export class HandTracker {
  static async create({ video, mode = 'full', onProgress = null }) {
    const tracker = new HandTracker(video, mode);
    await tracker._init(onProgress);
    return tracker;
  }

  constructor(video, mode) {
    this.video = video;
    this.mode = mode === 'light' ? 'light' : 'full';
    this.worker = null;
    this._running = false;
    this._busy = false;
    this._frameId = 0;
    this._lastSendT = 0;
    this._useRvfc = typeof video.requestVideoFrameCallback === 'function';
    this._pumpHandle = null;

    this._banks = { left: new HandFilterBank(), right: new HandFilterBank() };
    this._latest = { t: -Infinity, hands: { left: null, right: null } };
    this._freeze = false;

    this._burstCount = 0;

    this._resultTimes = []; // rolling window for trackingFps
  }

  async _init(onProgress) {
    this.worker = new Worker(new URL('./vision-worker.js', import.meta.url), { type: 'module' });

    await new Promise((resolve, reject) => {
      const onMessage = (ev) => {
        const msg = ev.data;
        if (msg.type === 'progress') {
          if (onProgress) onProgress(msg.value);
        } else if (msg.type === 'ready') {
          this.worker.removeEventListener('message', onMessage);
          resolve();
        } else if (msg.type === 'error') {
          this.worker.removeEventListener('message', onMessage);
          reject(new Error(msg.message));
        }
      };
      this.worker.addEventListener('message', onMessage);
      this.worker.postMessage({ type: 'init', mode: this.mode });
    });

    // Steady-state listener (after init handshake resolved).
    this.worker.addEventListener('message', (ev) => this._onWorkerMessage(ev.data));
  }

  _onWorkerMessage(msg) {
    if (msg.type === 'result') {
      this._busy = false;
      this._ingestResult(msg);
    } else if (msg.type === 'error') {
      this._busy = false;
      // Non-fatal per-frame error — drop this frame, keep pumping.
      // eslint-disable-next-line no-console
      console.error('[HandTracker] worker error:', msg.message);
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._scheduleNext();
  }

  stop() {
    this._running = false;
    if (this._pumpHandle != null) {
      if (this._useRvfc && this.video.cancelVideoFrameCallback) {
        this.video.cancelVideoFrameCallback(this._pumpHandle);
      } else {
        cancelAnimationFrame(this._pumpHandle);
      }
      this._pumpHandle = null;
    }
    if (this.worker) this.worker.postMessage({ type: 'stop' });
  }

  get trackingFps() {
    const times = this._resultTimes;
    if (times.length < 2) return 0;
    const span = (times[times.length - 1] - times[0]) / 1000;
    if (span <= 0) return 0;
    return (times.length - 1) / span;
  }

  _scheduleNext() {
    if (!this._running) return;
    if (this._useRvfc) {
      this._pumpHandle = this.video.requestVideoFrameCallback(() => this._tick());
    } else {
      this._pumpHandle = requestAnimationFrame(() => this._tick());
    }
  }

  async _tick() {
    if (!this._running) return;
    const cfg = MODE_CONFIG[this.mode];
    const minInterval = 1000 / cfg.sendHz;
    const now = performance.now();

    if (this._busy || now - this._lastSendT < minInterval) {
      this._scheduleNext();
      return;
    }

    const video = this.video;
    if (!video.videoWidth || !video.videoHeight) {
      this._scheduleNext();
      return;
    }

    const aspect = video.videoHeight / video.videoWidth;
    const resizeWidth = cfg.resizeWidth;
    const resizeHeight = Math.round(resizeWidth * aspect);

    this._lastSendT = now;
    this._busy = true;
    try {
      const bitmap = await createImageBitmap(video, {
        resizeWidth,
        resizeHeight,
        resizeQuality: 'low',
      });
      const id = ++this._frameId;
      this.worker.postMessage({ type: 'frame', bitmap, id, sentAt: now }, [bitmap]);
    } catch (err) {
      this._busy = false;
      // eslint-disable-next-line no-console
      console.error('[HandTracker] createImageBitmap failed:', err);
    }

    this._scheduleNext();
  }

  _ingestResult(msg) {
    const t = msg.t;
    this._resultTimes.push(t);
    if (this._resultTimes.length > 30) this._resultTimes.shift();

    for (const hand of msg.hands) {
      const side = mapLabelToSide(hand.label);
      if (!side) continue;
      const bank = this._banks[side];
      bank.lastSeenT = t;

      // mirror x (raw frame unmirrored -> selfie-view mirrored for output)
      const raw = hand.landmarks;
      const mirrored = new Float32Array(raw.length);
      for (let i = 0; i < LANDMARK_COUNT; i++) {
        mirrored[i * 3] = 1 - raw[i * 3];
        mirrored[i * 3 + 1] = raw[i * 3 + 1];
        mirrored[i * 3 + 2] = raw[i * 3 + 2];
      }

      // smooth each coordinate
      const smoothed = new Float32Array(mirrored.length);
      for (let i = 0; i < mirrored.length; i++) {
        smoothed[i] = bank.coord[i].filter(mirrored[i], t);
      }

      // palm center (mean of landmarks 0, 5, 17) from smoothed coords
      const px =
        (smoothed[0 * 3] + smoothed[5 * 3] + smoothed[17 * 3]) / 3;
      const py =
        (smoothed[0 * 3 + 1] + smoothed[5 * 3 + 1] + smoothed[17 * 3 + 1]) / 3;

      let vx = 0, vy = 0;
      if (bank.lastRawX !== null && bank.lastT !== null) {
        const dt = Math.max((t - bank.lastT) / 1000, 1e-3);
        vx = (px - bank.lastRawX) / dt;
        vy = (py - bank.lastRawY) / dt;
      }
      bank.lastRawX = px;
      bank.lastRawY = py;
      bank.lastT = t;
      const svx = bank.vx.filter(vx, t);
      const svy = bank.vy.filter(vy, t);

      const feats = computeRawFeatures(smoothed);
      const fist = bank.fist.filter(feats.fist, t);
      const palmOpen = bank.palmOpen.filter(feats.palmOpen, t);
      const pinch = bank.pinch.filter(feats.pinch, t);

      // burst edge detection (new-snapshot events only)
      this._updateBurstState(bank, fist, palmOpen, t);

      this._latest.hands[side] = {
        x: px,
        y: py,
        pinch,
        fist,
        palmOpen,
        velocity: { x: svx, y: svy },
        landmarks: smoothed,
      };
    }

    this._latest.t = t;
    this._updateFreeze();
  }

  _updateBurstState(bank, fist, palmOpen, t) {
    const ON_T = 0.75;
    const OFF_T = 0.55;

    if (fist > ON_T) {
      bank.aboveStreak++;
      bank.belowStreak = 0;
    } else if (fist < OFF_T) {
      bank.belowStreak++;
      bank.aboveStreak = 0;
    } else {
      bank.aboveStreak = 0;
      bank.belowStreak = 0;
    }

    if (!bank.fistAbove && bank.aboveStreak >= 4) {
      bank.fistAbove = true;
    } else if (bank.fistAbove && bank.belowStreak >= 4) {
      bank.fistAbove = false;
    }

    // Raw (unpersisted) fist edge — burst timing needs the release moment
    // itself, not the debounced freeze state, so <180ms windows are usable.
    const isFistRaw = fist > ON_T;
    if (isFistRaw && !bank.wasFist) {
      bank.fistHighAt = t;
      bank.armedForBurst = true; // a fresh fist engagement arms the next release for burst detection
    } else if (!isFistRaw && bank.wasFist) {
      bank.releasedAt = t;
    }
    bank.wasFist = isFistRaw;

    // palm-open velocity (rate of change of the low-passed palmOpen scalar)
    let openVel = 0;
    if (bank.lastPalmOpenT !== null) {
      const dt = Math.max((t - bank.lastPalmOpenT) / 1000, 1e-3);
      openVel = (palmOpen - bank.lastPalmOpen) / dt;
    }
    bank.lastPalmOpen = palmOpen;
    bank.lastPalmOpenT = t;

    const OPEN_T = 0.6;
    const OPEN_VEL_T = 2.5; // palmOpen units/sec

    if (
      bank.armedForBurst &&
      palmOpen > OPEN_T &&
      openVel > OPEN_VEL_T &&
      t - bank.releasedAt < 180 &&
      bank.releasedAt > bank.fistHighAt
    ) {
      this._burstCount++;
      bank.armedForBurst = false;
    }
  }

  _updateFreeze() {
    const leftOn = this._banks.left.fistAbove;
    const rightOn = this._banks.right.fistAbove;
    this._freeze = leftOn || rightOn;
  }

  getState() {
    const now = performance.now();
    const t = this._latest.t;
    const stale = !isFinite(t) || now - t > 250;

    const hands = { left: null, right: null };
    for (const side of ['left', 'right']) {
      const bank = this._banks[side];
      const sinceSeen = now - bank.lastSeenT;
      if (this._latest.hands[side] && sinceSeen <= 150) {
        hands[side] = this._latest.hands[side];
      } else if (sinceSeen > 150) {
        this._latest.hands[side] = null;
      }
      // freeze auto-release when its hand has been lost >300ms
      if (bank.fistAbove && sinceSeen > 300) {
        bank.fistAbove = false;
        bank.aboveStreak = 0;
        bank.belowStreak = 0;
      }
    }
    this._updateFreeze();

    let twoHandDistance = null;
    if (hands.left && hands.right) {
      const dx = hands.left.x - hands.right.x;
      const dy = hands.left.y - hands.right.y;
      twoHandDistance = clamp01(Math.sqrt(dx * dx + dy * dy) / Math.SQRT2);
    }

    const rightPinch = hands.right ? hands.right.pinch : 0;

    return {
      t,
      stale,
      hands,
      gestures: {
        freeze: this._freeze,
        burstCount: this._burstCount,
        pinch: rightPinch,
        twoHandDistance,
      },
    };
  }
}
