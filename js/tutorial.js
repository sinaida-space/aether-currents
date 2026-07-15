// tutorial.js — guided gesture onboarding overlay (v3.5).
// Six-step live tutorial: reads tracker.getState() on its own rAF loop,
// listens to perfBus 'cc' for meter values, auto-advances on lenient
// gesture detection, and drops back into free play on finish/exit.
// Deliberately its own DOM layer (not the HUD canvas) since it needs
// clickable controls (SKIP / EXIT) alongside a live camera feed — see
// scout report TRAP 3. Zero per-frame cost unless requestTutorial() was
// called before boot: startTutorial() is the only entry point that spends
// any work, and it is only invoked by main.js when isTutorialRequested().

let tutorialRequested = false;

export function requestTutorial() {
  tutorialRequested = true;
}

export function isTutorialRequested() {
  return tutorialRequested;
}

// cc param -> [min, max] used only to normalize the meter bar fill (0..1);
// ranges lifted from js/mapping.js's Mapper._setParam call sites (scout
// report section 2a).
const CC_RANGES = {
  pitch: [0.25, 4],
  grainSize: [0.03, 0.25],
  density: [4, 60],
  filterCutoff: [800, 16000],
};

function normCc(param, value) {
  const range = CC_RANGES[param];
  if (!range || value == null) return null;
  const [lo, hi] = range;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}

function bar(frac, width = 10) {
  if (frac == null) return '-'.repeat(width);
  const filled = Math.round(Math.max(0, Math.min(1, frac)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ---- inline SVG hand glyphs — monochrome line icons, currentColor stroke,
// no emoji, matching the HUD's white/red/cyan monospace palette. ----------
const GLYPHS = {
  move:
    '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 30 V12a3 3 0 0 1 6 0v10 M24 22v-8a3 3 0 0 1 6 0v10 M30 24v-4a3 3 0 0 1 6 0v10c0 6-4 12-10 12h-4c-5 0-8-3-11-8l-4-7c-1-2 1-4 3-3l6 4V16a3 3 0 0 1 6 0v10"/><path d="M6 24l-4-2m4 2l-4 2m38-2l4-2m-4 2l4 2" stroke-opacity="0.6"/></svg>',
  pinch:
    '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 30V14a3 3 0 0 1 6 0v8 M26 22v-4a3 3 0 0 1 6 0v10c0 6-4 12-10 12h-3c-5 0-8-3-10-7l-3-6c-1-2 1-4 3-3l4 3"/><path d="M14 12l4 4m-4-4l-4 4" stroke="var(--red,#ff2a2a)"/></svg>',
  raiseLower:
    '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 34V16a3 3 0 0 1 6 0v8 M22 24v-4a3 3 0 0 1 6 0v9c0 6-3 11-9 11h-2c-4 0-7-2-9-6l-2-4c-1-2 1-4 3-3l3 2"/><path d="M36 10v10m0-10l-3 3m3-3l3 3M36 36V26m0 10l-3-3m3 3l3-3" stroke-opacity="0.7"/></svg>',
  distance:
    '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="24" r="5"/><circle cx="38" cy="24" r="5"/><path d="M17 24h4m6 0h4m6 0h4" stroke-dasharray="2 3"/><path d="M4 24l3-3m-3 3l3 3M44 24l-3-3m3 3l-3 3" stroke-opacity="0.7"/></svg>',
  fist:
    '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><rect x="14" y="16" width="20" height="18" rx="6"/><path d="M18 16v-3m5 3v-3m5 3v-3m5 3v-3"/></svg>',
  burst:
    '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><path d="M24 24 V8 M24 24 L34 12 M24 24 L38 22 M24 24 L34 36 M24 24 L24 40 M24 24 L14 36 M24 24 L10 22 M24 24 L14 12" stroke-opacity="0.85"/><circle cx="24" cy="24" r="3" fill="currentColor" stroke="none"/></svg>',
};

// ---- the 6 steps ----------------------------------------------------------
// detect(state, ctx) -> bool. `ctx` is a fresh object per step (reset on
// entry) that the runner also stamps with `ctx.now` (performance.now()) each
// frame before calling detect — steps use it for their own hold timers.
const STEPS = [
  {
    id: 'move',
    title: 'RIGHT HAND X/Y',
    caption: 'move your right hand around the frame',
    listen: 'hear the playhead sweep and pitch bend',
    glyph: GLYPHS.move,
    holdMs: 0,
    meter: {
      label: 'PITCH',
      read: (state, ccCache) => normCc('pitch', ccCache.pitch),
    },
    detect(state, ctx) {
      const rh = state.hands.right;
      if (!rh) {
        // hand dropped out — clear lastPos so a re-entry teleport isn't
        // counted as continuous movement and doesn't inflate pathLen.
        ctx.lastPos = null;
        return false;
      }
      if (ctx.lastPos) {
        ctx.pathLen += Math.hypot(rh.x - ctx.lastPos.x, rh.y - ctx.lastPos.y);
      }
      ctx.lastPos = { x: rh.x, y: rh.y };
      ctx.pathLen = ctx.pathLen || 0;
      return ctx.pathLen > 0.6;
    },
  },
  {
    id: 'pinch',
    title: 'RIGHT PINCH',
    caption: 'pinch thumb + index on your right hand',
    listen: 'grains shrink to a whisper',
    glyph: GLYPHS.pinch,
    holdMs: 500,
    meter: {
      label: 'GRAIN SIZE',
      read: (state, ccCache) => normCc('grainSize', ccCache.grainSize),
    },
    detect(state, ctx) {
      if (state.gestures.pinch > 0.65) {
        if (!ctx.holdStart) ctx.holdStart = ctx.now;
        return ctx.now - ctx.holdStart >= 500;
      }
      ctx.holdStart = null;
      return false;
    },
  },
  {
    id: 'leftHeight',
    title: 'LEFT HAND HEIGHT',
    caption: 'raise and lower your left hand',
    listen: 'the cloud thickens and thins',
    glyph: GLYPHS.raiseLower,
    holdMs: 0,
    meter: {
      label: 'DENSITY',
      read: (state, ccCache) => normCc('density', ccCache.density),
    },
    detect(state, ctx) {
      const lh = state.hands.left;
      if (!lh) return false;
      ctx.yMin = ctx.yMin == null ? lh.y : Math.min(ctx.yMin, lh.y);
      ctx.yMax = ctx.yMax == null ? lh.y : Math.max(ctx.yMax, lh.y);
      return ctx.yMax - ctx.yMin >= 0.35;
    },
  },
  {
    id: 'twoHand',
    title: 'TWO-HAND DISTANCE',
    caption: 'pull your hands apart, bring them together',
    listen: 'filter opens, space grows',
    glyph: GLYPHS.distance,
    holdMs: 0,
    meter: {
      label: 'FILTER',
      read: (state, ccCache) => normCc('filterCutoff', ccCache.filterCutoff),
    },
    detect(state, ctx) {
      const d = state.gestures.twoHandDistance;
      if (d == null) return false;
      ctx.dMin = ctx.dMin == null ? d : Math.min(ctx.dMin, d);
      ctx.dMax = ctx.dMax == null ? d : Math.max(ctx.dMax, d);
      return ctx.dMax - ctx.dMin >= 0.25;
    },
  },
  {
    id: 'fist',
    title: 'FIST',
    caption: 'make a fist',
    listen: 'freeze the cloud mid-air',
    glyph: GLYPHS.fist,
    holdMs: 700,
    meter: {
      label: 'FREEZE',
      read: (state) => (state.gestures.freeze ? 1 : 0),
    },
    detect(state, ctx) {
      if (state.gestures.freeze) {
        if (!ctx.holdStart) ctx.holdStart = ctx.now;
        return ctx.now - ctx.holdStart >= 700;
      }
      ctx.holdStart = null;
      return false;
    },
  },
  {
    id: 'burst',
    title: 'FAST OPEN PALM',
    caption: 'snap your hand open, fast',
    listen: 'trigger a burst',
    glyph: GLYPHS.burst,
    holdMs: 0,
    meter: {
      label: 'BURST',
      read: (state) => state.gestures.burstCount,
      isCount: true,
    },
    detect(state, ctx) {
      if (ctx.startCount == null) ctx.startCount = state.gestures.burstCount;
      return state.gestures.burstCount > ctx.startCount;
    },
  },
];

const SUCCESS_HOLD_MS = 800;

export function startTutorial({ tracker, perfBus }) {
  if (!isTutorialRequested()) return;

  // ---- state ---------------------------------------------------------
  let stepIndex = 0;
  let stepCtx = {};
  let successAt = null; // performance.now() timestamp when current step detected, or null
  let rafId = null;
  let active = true;
  let completed = false; // true once the completion card is up — gates per-frame tracker work
  const ccCache = {}; // param -> last value seen via perfBus 'cc'

  const offCc = perfBus.on('cc', ({ param, value }) => {
    ccCache[param] = value;
  });

  // ---- DOM -------------------------------------------------------------
  const overlay = document.createElement('div');
  overlay.id = 'tutorial-overlay';
  overlay.className = 'tutorial-overlay';
  overlay.innerHTML = `
    <div class="tutorial-panel" id="tutorial-panel">
      <div class="tutorial-step-row">
        <span id="tutorial-step-counter">STEP 1/${STEPS.length}</span>
        <span class="tutorial-controls">
          <a href="#" id="tutorial-skip">SKIP &rsaquo;</a>
          <a href="#" id="tutorial-exit">EXIT TUTORIAL</a>
        </span>
      </div>
      <div class="tutorial-body">
        <div class="tutorial-glyph" id="tutorial-glyph"></div>
        <div class="tutorial-text">
          <div class="tutorial-title" id="tutorial-title"></div>
          <div class="tutorial-caption" id="tutorial-caption"></div>
          <div class="tutorial-listen" id="tutorial-listen"></div>
          <div class="tutorial-meter" id="tutorial-meter"></div>
          <div class="tutorial-detected" id="tutorial-detected">&#10003; DETECTED</div>
        </div>
      </div>
    </div>
    <div class="tutorial-panel tutorial-complete" id="tutorial-complete" style="display:none">
      <div class="tutorial-complete-title">YOU'RE CONDUCTING. THE INSTRUMENT IS YOURS.</div>
      <div class="tutorial-complete-hint">full gesture list is on the MAIN SCREEN.</div>
      <button class="btn" id="tutorial-finish">[ ENTER FREE PLAY ]</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const panelEl = overlay.querySelector('#tutorial-panel');
  const completeEl = overlay.querySelector('#tutorial-complete');
  const counterEl = overlay.querySelector('#tutorial-step-counter');
  const glyphEl = overlay.querySelector('#tutorial-glyph');
  const titleEl = overlay.querySelector('#tutorial-title');
  const captionEl = overlay.querySelector('#tutorial-caption');
  const listenEl = overlay.querySelector('#tutorial-listen');
  const meterEl = overlay.querySelector('#tutorial-meter');
  const detectedEl = overlay.querySelector('#tutorial-detected');
  const skipEl = overlay.querySelector('#tutorial-skip');
  const exitEl = overlay.querySelector('#tutorial-exit');
  const finishEl = overlay.querySelector('#tutorial-finish');

  // Keep the panel clear of the (dynamically-sized) bottom ui-bar / beat
  // timeline, same live-measurement approach as hud.js's _measureUiBarHeight.
  function measureBottomClearance() {
    const uiBar = document.getElementById('ui-bar');
    const timeline = document.getElementById('beat-timeline');
    let h = 0;
    if (uiBar && uiBar.classList.contains('visible')) {
      h += uiBar.getBoundingClientRect().height;
    }
    if (timeline && timeline.style.display !== 'none') {
      h += timeline.getBoundingClientRect().height;
    }
    return Math.round(h + 24);
  }

  function updateLayout() {
    // ui-bar height can change (declutter toggle, mobile wrap) without a
    // window resize event firing — re-synced every tick() frame below, same
    // approach as beat-timeline.js's draw(). Only touch style when it
    // actually changed to avoid needless layout thrash.
    const wantBottom = measureBottomClearance() + 'px';
    if (panelEl.style.bottom !== wantBottom) panelEl.style.bottom = wantBottom;
    if (completeEl.style.bottom !== wantBottom) completeEl.style.bottom = wantBottom;
  }
  updateLayout();
  window.addEventListener('resize', updateLayout);

  function renderStep() {
    const step = STEPS[stepIndex];
    counterEl.textContent = `STEP ${stepIndex + 1}/${STEPS.length}`;
    glyphEl.innerHTML = step.glyph;
    titleEl.textContent = step.title;
    captionEl.textContent = step.caption;
    listenEl.textContent = step.listen;
    detectedEl.classList.remove('show');
  }

  function renderMeter() {
    const step = STEPS[stepIndex];
    if (!step) return;
    const value = step.meter.read(tutorialState, ccCache);
    if (step.meter.isCount) {
      meterEl.textContent = `${step.meter.label} [ ${value || 0} ]`;
    } else {
      meterEl.textContent = `${step.meter.label} [${bar(value)}]`;
    }
  }

  let tutorialState = { hands: { left: null, right: null }, gestures: {}, stale: true };

  function enterStep(index) {
    stepIndex = index;
    stepCtx = {};
    successAt = null;
    renderStep();
  }

  function showComplete() {
    panelEl.style.display = 'none';
    completeEl.style.display = 'block';
    completed = true;
  }

  function advance() {
    if (stepIndex + 1 >= STEPS.length) {
      showComplete();
    } else {
      enterStep(stepIndex + 1);
    }
  }

  function tick() {
    if (!active) return;

    updateLayout();

    if (!completed) {
      tutorialState = tracker.getState();

      if (panelEl.style.display !== 'none' && stepIndex < STEPS.length) {
        renderMeter();

        if (successAt == null) {
          const step = STEPS[stepIndex];
          stepCtx.now = performance.now();
          if (step.detect(tutorialState, stepCtx)) {
            successAt = performance.now();
            detectedEl.classList.add('show');
          }
        } else if (performance.now() - successAt >= SUCCESS_HOLD_MS) {
          advance();
        }
      }
    }

    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  function exit() {
    if (!active) return;
    active = false;
    if (rafId != null) cancelAnimationFrame(rafId);
    offCc();
    window.removeEventListener('resize', updateLayout);
    overlay.remove();
    window.__AC_TUTORIAL = { next: () => {}, exit: () => {}, active: false };
  }

  skipEl.addEventListener('click', (e) => {
    e.preventDefault();
    advance();
  });
  exitEl.addEventListener('click', (e) => {
    e.preventDefault();
    exit();
  });
  finishEl.addEventListener('click', exit);

  enterStep(0);

  // Debug/test hook — the verifier can't perform camera gestures, so it
  // drives the step machine directly. Exposed as soon as the overlay mounts.
  window.__AC_TUTORIAL = {
    next: () => (completeEl.style.display === 'none' ? advance() : null),
    exit,
    get active() {
      return active;
    },
  };
}
