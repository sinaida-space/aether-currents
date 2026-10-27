// tutorial.js — guided gesture onboarding overlay (v3.5).
// Live tutorial (six FLOW steps, or five GRID steps when GRID is selected):
// reads tracker.getState() on its own rAF loop,
// listens to perfBus 'cc' for meter values, auto-advances on lenient
// gesture detection, and drops back into free play on finish/exit.
// Deliberately its own DOM layer (not the HUD canvas) since it needs
// clickable controls (SKIP / EXIT) alongside a live camera feed — see
// scout report TRAP 3. Zero per-frame cost unless requestTutorial() was
// called before boot: startTutorial() is the only entry point that spends
// any work, and it is only invoked by main.js when isTutorialRequested().

import { writeGate } from './grid/sequencer.js';
import { makeStep } from './grid/tape.js';

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

// Hold a continuous gesture value above `on` for `ms`; it only counts as
// released once it falls below `off`.
function holdWithHysteresis(ctx, value, on, off, ms) {
  const v = value || 0;
  if (ctx.holding ? v >= off : v >= on) {
    ctx.holding = true;
    if (!ctx.holdStart) ctx.holdStart = ctx.now;
    // progress: the first half is "you're there", the rest is the hold
    ctx.progress = 0.5 + 0.5 * Math.min(1, (ctx.now - ctx.holdStart) / ms);
    return ctx.now - ctx.holdStart >= ms;
  }
  ctx.holding = false;
  ctx.holdStart = null;
  ctx.progress = 0.5 * Math.min(1, v / on);
  return false;
}

// ---- the 6 steps ----------------------------------------------------------
// detect(state, ctx) -> bool. `ctx` is a fresh object per step (reset on
// entry) that the runner also stamps with `ctx.now` (performance.now()) each
// frame before calling detect — steps use it for their own hold timers.
const STEPS = [
  {
    id: 'move',
    title: 'RIGHT HAND X/Y',
    praise: "THAT'S IT. YOU'RE STEERING THE SOUND.",
    caption: 'move your right hand around the frame',
    listen: 'your right hand is the playhead: left to right moves through the sound, up and down picks the notes of the scale',
    glyph: GLYPHS.move,
    holdMs: 0,
    need: 'right',
    how: 'SWEEP YOUR RIGHT HAND ACROSS THE FRAME, LEFT TO RIGHT',
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
      ctx.progress = ctx.pathLen / 0.45;
      return ctx.pathLen > 0.45;
    },
  },
  {
    id: 'pinch',
    title: 'RIGHT PINCH',
    praise: "NICE PINCH. THE GRAINS ARE YOURS.",
    caption: 'pinch thumb + index on your right hand',
    listen: 'sets the grain size: a tight pinch makes tiny grains like a whisper, an open hand makes long smooth grains',
    glyph: GLYPHS.pinch,
    holdMs: 500,
    need: 'right',
    how: 'TOUCH THUMB TIP TO INDEX TIP, PALM TO THE CAMERA, AND HOLD',
    meter: {
      label: 'PINCH',
      read: (state) => state.gestures.pinch,
    },
    // Hysteresis (in at 0.5, out below 0.35) so tracking jitter on a held
    // pinch does not reset the hold.
    detect(state, ctx) {
      return holdWithHysteresis(ctx, state.gestures.pinch, 0.5, 0.35, 400);
    },
  },
  {
    id: 'leftHeight',
    title: 'LEFT HAND HEIGHT',
    praise: "GOOD. YOU JUST SHAPED THE CLOUD.",
    caption: 'raise and lower your left hand',
    listen: 'sets the density: a high hand plays many grains at once for a thick cloud, a low hand leaves sparse droplets',
    glyph: GLYPHS.raiseLower,
    holdMs: 0,
    need: 'left',
    how: 'MOVE YOUR LEFT HAND SLOWLY FROM WAIST HEIGHT UP TO YOUR FACE',
    meter: {
      label: 'DENSITY',
      read: (state, ccCache) => normCc('density', ccCache.density),
    },
    detect(state, ctx) {
      const lh = state.hands.left;
      if (!lh) return false;
      ctx.yMin = ctx.yMin == null ? lh.y : Math.min(ctx.yMin, lh.y);
      ctx.yMax = ctx.yMax == null ? lh.y : Math.max(ctx.yMax, lh.y);
      ctx.progress = (ctx.yMax - ctx.yMin) / 0.35;
      return ctx.yMax - ctx.yMin >= 0.35;
    },
  },
  {
    id: 'twoHand',
    title: 'TWO-HAND DISTANCE',
    praise: "YES. THE SPACE OPENS WITH YOUR HANDS.",
    caption: 'pull your hands apart, bring them together',
    listen: 'opens the filter and the room: hands apart sound bright and wide, hands close sound dark and near',
    glyph: GLYPHS.distance,
    holdMs: 0,
    need: 'both',
    how: 'SPREAD YOUR HANDS WIDE, THEN BRING THEM CLOSE TOGETHER',
    meter: {
      label: 'FILTER',
      read: (state, ccCache) => normCc('filterCutoff', ccCache.filterCutoff),
    },
    detect(state, ctx) {
      const d = state.gestures.twoHandDistance;
      if (d == null) return false;
      ctx.dMin = ctx.dMin == null ? d : Math.min(ctx.dMin, d);
      ctx.dMax = ctx.dMax == null ? d : Math.max(ctx.dMax, d);
      ctx.progress = (ctx.dMax - ctx.dMin) / 0.25;
      return ctx.dMax - ctx.dMin >= 0.25;
    },
  },
  {
    id: 'fist',
    title: 'FIST',
    praise: "FROZEN. A MOMENT HELD IN THE AIR.",
    caption: 'make a fist',
    listen: 'freezes the sound where it is so you can hold a moment; open the hand to let it move again',
    glyph: GLYPHS.fist,
    holdMs: 700,
    need: 'any',
    how: 'CLOSE YOUR HAND INTO A TIGHT FIST AND HOLD IT',
    meter: {
      label: 'FREEZE',
      read: (state) => (state.gestures.freeze ? 1 : 0),
    },
    detect(state, ctx) {
      return holdWithHysteresis(ctx, state.gestures.freeze ? 1 : 0, 0.5, 0.5, 700);
    },
  },
  {
    id: 'burst',
    title: 'FAST OPEN PALM',
    praise: "BURST. THAT'S THE ONE.",
    caption: 'snap your hand open, fast',
    listen: 'fires a burst of grains, an accent you can throw onto the beat',
    glyph: GLYPHS.burst,
    holdMs: 0,
    need: 'any',
    how: 'MAKE A FIST FIRST, THEN SNAP ALL FINGERS OPEN, FAST',
    meter: {
      label: 'BURST',
      read: (state) => state.gestures.burstCount,
      isCount: true,
    },
    detect(state, ctx) {
      if (ctx.startCount == null) ctx.startCount = state.gestures.burstCount;
      // Mirror the tracker's stages (fist, release, open in time) so the
      // coach can say which one is missing, with live readings.
      const hand = state.hands.right || state.hands.left;
      const now = performance.now();
      if (hand) {
        const { fist, palmOpen } = hand;
        if (fist > 0.6) { ctx.fistAt = now; ctx.releasedAt = null; ctx.openMs = null; }
        else if (ctx.fistAt && !ctx.releasedAt && fist < 0.6) ctx.releasedAt = now;
        if (ctx.releasedAt && ctx.openMs == null && (palmOpen > 0.55 || fist < 0.3)) {
          ctx.openMs = Math.round(now - ctx.releasedAt);
        }
        ctx.readout = `FIST ${Math.round(fist * 100)} · OPEN ${Math.round(palmOpen * 100)}`;
        if (!ctx.fistAt) ctx.hint = 'CLOSE YOUR HAND INTO A FIST FIRST';
        else if (!ctx.releasedAt) ctx.hint = 'GOOD FIST · NOW SNAP ALL FINGERS OPEN';
        else if (ctx.openMs != null && ctx.openMs > 300) ctx.hint = `TOO SLOW (${ctx.openMs} MS) · FIST AGAIN, SNAP FASTER`;
        else if (ctx.openMs == null && now - ctx.releasedAt > 1000) ctx.hint = 'SPREAD ALL FIVE FINGERS WIDE';
      }
      return state.gestures.burstCount > ctx.startCount;
    },
  },
];

// ---- GRID steps: write bars with the left hand, edit with SPACE ----------
// getGrid() returns the GRID transport once main.js has booted it (or null).
// Write and erase only pass when the tape really changed, with the same
// pinch gate that play uses (writeGate from js/grid/sequencer.js).

// Counts tape writes and clears while a step runs; ctx.tapeOff() unsubscribes.
function watchTape(ctx, getGrid) {
  const tape = getGrid()?.tape;
  if (ctx.tape === tape) return tape;
  if (ctx.tapeOff) ctx.tapeOff();
  ctx.tape = tape;
  ctx.wrote = 0;
  ctx.cleared = 0;
  ctx.tapeOff = tape && tape.onChange
    ? tape.onChange(({ bar, step, reset }) => {
      if (reset) return;
      if (tape.getStep(bar, step)) ctx.wrote++;
      else ctx.cleared++;
    })
    : null;
  return tape;
}

function makeGridSteps(getGrid) {
  return [
    STEPS[0],
    {
      id: 'gridWrite',
      title: 'LEFT PINCH (HOLD)',
      praise: 'WRITTEN. THAT NOTE IS ON THE TAPE NOW.',
      caption: 'keep your right hand in view, pinch with your left and keep holding',
      listen: 'records: while you hold it, every step the playhead passes takes the note your right hand is playing',
      glyph: GLYPHS.pinch,
      holdMs: 600,
      need: 'both',
      tapeFocus: true,
      how: 'RIGHT HAND PICKS THE NOTE · PINCH THUMB AND INDEX ON YOUR LEFT HAND, HOLD UNTIL A NOTE LANDS ON THE TAPE',
      meter: { label: 'WRITE', read: (state) => state.gestures.leftPinch },
      enter(ctx) {
        watchTape(ctx, getGrid);
      },
      detect(state, ctx) {
        watchTape(ctx, getGrid);
        ctx.on = writeGate(ctx.on, state.gestures.leftPinch || 0, !state.stale && !!state.hands.left);
        const held = holdWithHysteresis(ctx, ctx.on && state.hands.right ? 1 : 0, 0.5, 0.5, 600);
        if (held && !ctx.wrote) ctx.progress = 0.9; // pinch is fine, the tape has not changed yet
        return held && ctx.wrote > 0;
      },
    },
    {
      id: 'gridErase',
      title: 'LEFT FIST (HOLD)',
      praise: 'ERASED. THAT STEP IS CLEAN AGAIN.',
      caption: 'close your left hand into a fist while a note passes the playhead',
      listen: 'erases: while you hold the fist, every step the playhead passes goes silent',
      glyph: GLYPHS.fist,
      holdMs: 600,
      need: 'left',
      tapeFocus: true,
      how: 'CLOSE YOUR LEFT HAND INTO A FIST AND HOLD IT UNTIL A NOTE DISAPPEARS',
      meter: { label: 'ERASE', read: (state) => (state.gestures.leftFist ? 1 : 0) },
      enter(ctx) {
        const grid = getGrid();
        const tape = grid?.tape;
        if (tape && !tape.hasNotes()) this.seed(grid, tape);
        watchTape(ctx, getGrid); // after seeding, so only real clears count
      },
      // Nothing to erase yet: one note on every beat of the bar under the playhead.
      seed(grid, tape) {
        const bar = Math.max(0, Math.min(tape.barCount - 1, grid.playhead?.bar || 0));
        const sc = grid.getScaleState ? grid.getScaleState() : { scaleId: 'minorPentatonic', rootIndex: 9 };
        for (let i = 0; i < 16; i += 4) {
          tape.setStep(bar, i, makeStep({ band: 2, octave: 0, grainSize: 0.09, density: 12, filterCutoff: 12000 }, sc));
        }
      },
      detect(state, ctx) {
        watchTape(ctx, getGrid);
        const held = holdWithHysteresis(ctx, state.gestures.leftFist ? 1 : 0, 0.5, 0.5, 600);
        if (held && !ctx.cleared) ctx.progress = 0.9;
        return held && ctx.cleared > 0;
      },
    },
    {
      id: 'gridFreeze',
      title: 'RIGHT FIST',
      praise: 'FROZEN. THE TAPE KEEPS ROLLING.',
      caption: 'make a fist with your right hand',
      listen: 'freezes your live sound while the recorded tape keeps playing underneath',
      glyph: GLYPHS.fist,
      holdMs: 700,
      need: 'right',
      how: 'CLOSE YOUR RIGHT HAND INTO A FIST AND HOLD IT',
      meter: { label: 'FREEZE', read: (state) => (state.gestures.freeze ? 1 : 0) },
      detect(state, ctx) {
        return holdWithHysteresis(ctx, state.gestures.freeze ? 1 : 0, 0.5, 0.5, 700);
      },
    },
    {
      id: 'gridEdit',
      title: 'SPACE · TAP THE TAPE',
      praise: "THAT'S THE ROUND TRIP: PLAY, EDIT, PLAY. THE EDITOR IS ONE SPACE AWAY.",
      caption: 'press SPACE or tap the tape, look at the editor, then press SPACE again',
      listen: 'pauses and opens the editor: scroll through the bars, fix notes with the mouse, export them for your DAW',
      glyph: GLYPHS.burst,
      holdMs: 0,
      how: 'PRESS SPACE (OR TAP THE TAPE), THEN SPACE AGAIN TO COME BACK',
      meter: { label: 'EDIT', read: (state, cc, ctx) => (ctx && ctx.sawEdit ? 1 : getGrid()?.mode === 'edit' ? 1 : 0) },
      // Passes on the way back to PLAY, so the praise is seen; an editor
      // that was already open when the step began does not count.
      detect(state, ctx) {
        const mode = getGrid()?.mode;
        if (mode === 'play') ctx.sawPlay = true;
        if (mode === 'edit' && ctx.sawPlay) ctx.sawEdit = true;
        ctx.progress = ctx.sawEdit ? 0.5 : 0;
        return !!ctx.sawEdit && mode === 'play';
      },
    },
  ];
}

const SUCCESS_HOLD_MS = 2600; // long enough to read the praise; a bar shows the wait

// A short glassy "ding" on success: A5 + E6 (the default A minor's root and
// fifth), straight to the speakers so the beat's sidechain never ducks it.
// The finale adds A6 a beat later.
function chime(ctx, final = false) {
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const t0 = ctx.currentTime + 0.01;
  const notes = final ? [[880, 0], [1318.5, 0], [1760, 0.12]] : [[880, 0], [1318.5, 0]];
  for (const [freq, delay] of notes) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = t0 + delay;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (final ? 1.4 : 0.9));
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + (final ? 1.5 : 1.0));
  }
}

export function startTutorial({ tracker, perfBus, play = 'flow', getGrid = () => null, audioContext = null, onComplete = null, onExit = null }) {
  if (!isTutorialRequested()) return;
  const grid = play === 'grid';
  const STEPS_RUN = grid ? makeGridSteps(getGrid) : STEPS;

  // ---- state ---------------------------------------------------------
  let stepIndex = 0;
  let stepCtx = {};
  let successAt = null; // performance.now() timestamp when current step detected, or null
  let rafId = null;
  let active = true;
  let completed = false; // true once the completion card is up — gates per-frame tracker work
  let editing = false; // GRID: the tape editor is open, the panel steps aside
  let lastTickAt = performance.now();
  const ccCache = {}; // param -> last value seen via perfBus 'cc'

  const offCc = perfBus.on('cc', ({ param, value }) => {
    ccCache[param] = value;
  });

  // ---- DOM -------------------------------------------------------------
  const overlay = document.createElement('div');
  overlay.id = 'tutorial-overlay';
  overlay.className = 'tutorial-overlay';
  overlay.innerHTML = `
    <div class="tutorial-panel" id="tutorial-panel" role="region" aria-label="TUTORIAL">
      <div class="tutorial-step-row">
        <span id="tutorial-step-counter">STEP 1/${STEPS_RUN.length}</span>
        <span class="tutorial-controls">
          <button type="button" class="tutorial-btn" id="tutorial-back">&lsaquo; BACK</button>
          <button type="button" class="tutorial-btn" id="tutorial-pause" aria-pressed="false">PAUSE</button>
          <button type="button" class="tutorial-btn" id="tutorial-skip">SKIP &rsaquo;</button>
        </span>
        <button type="button" class="tutorial-btn tutorial-btn-exit" id="tutorial-exit">EXIT TUTORIAL</button>
      </div>
      <div class="tutorial-body">
        <div class="tutorial-glyph" id="tutorial-glyph"></div>
        <div class="tutorial-text">
          <div class="tutorial-title" id="tutorial-title"></div>
          <div class="tutorial-caption" id="tutorial-caption"></div>
          <div class="tutorial-listen" id="tutorial-listen"></div>
          <div class="tutorial-meter" id="tutorial-meter"></div>
          <div class="tutorial-coach" id="tutorial-coach" aria-live="polite"></div>
          <div class="tutorial-success" id="tutorial-success" aria-live="assertive">
            <span class="tutorial-ok">&#10003; GOT IT</span>
            <span class="tutorial-praise" id="tutorial-praise"></span>
            <span class="tutorial-next" aria-hidden="true">NEXT STEP <span class="tutorial-next-track"><span class="tutorial-next-fill" id="tutorial-next-fill"></span></span> <span class="key">ENTER</span></span>
          </div>
        </div>
      </div>
    </div>
    <div class="tutorial-panel tutorial-complete" id="tutorial-complete" style="display:none" role="region" aria-label="TUTORIAL COMPLETE">
      <div class="tutorial-complete-title">${grid ? "YOU'RE WRITING BARS. THE TAPE IS YOURS." : "YOU'RE CONDUCTING. THE INSTRUMENT IS YOURS."}</div>
      <div class="tutorial-complete-hint">full gesture list is on the MAIN SCREEN.</div>
      <div class="tutorial-complete-row">
        <button type="button" class="tutorial-btn" id="tutorial-again">&lsaquo; BACK</button>
        <button class="btn" id="tutorial-finish">${grid ? '[ KEEP PLAYING ]' : '[ ENTER FREE PLAY ]'}</button>
      </div>
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
  const coachEl = overlay.querySelector('#tutorial-coach');
  const praiseEl = overlay.querySelector('#tutorial-praise');
  const nextFillEl = overlay.querySelector('#tutorial-next-fill');
  const skipEl = overlay.querySelector('#tutorial-skip');
  const backEl = overlay.querySelector('#tutorial-back');
  const againEl = overlay.querySelector('#tutorial-again');
  const pauseEl = overlay.querySelector('#tutorial-pause');
  let paused = false;
  let pausedAt = 0;
  const exitEl = overlay.querySelector('#tutorial-exit');
  const finishEl = overlay.querySelector('#tutorial-finish');
  const tapeEl = document.getElementById('tape-canvas');

  // Keep the panel clear of everything docked at the bottom: the ui-bar, the
  // beat timeline and, in GRID, the tape (its hint line and playhead too).
  // Live-measured like hud.js's _measureUiBarHeight.
  function measureBottomClearance() {
    let top = window.innerHeight;
    for (const id of ['ui-bar', 'beat-timeline', 'tape-canvas']) {
      const el = document.getElementById(id);
      if (!el || getComputedStyle(el).display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0) top = Math.min(top, r.top);
    }
    return Math.round(Math.max(0, window.innerHeight - top) + 16);
  }

  function updateLayout() {
    // ui-bar height can change (declutter toggle, mobile wrap) without a
    // window resize event firing — re-synced every tick() frame below, same
    // approach as beat-timeline.js's draw(). Only touch style when it
    // actually changed to avoid needless layout thrash.
    const clearance = measureBottomClearance();
    const wantBottom = clearance + 'px';
    // phones: what is left above the tape can be shorter than the panel
    const wantMax = Math.max(160, window.innerHeight - clearance - 8) + 'px';
    for (const el of [panelEl, completeEl]) {
      if (el.style.bottom !== wantBottom) el.style.bottom = wantBottom;
      if (el.style.maxHeight !== wantMax) el.style.maxHeight = wantMax;
    }
    // GRID: the tape editor covers the screen; the panel waits until PLAY.
    const nowEditing = grid && getGrid()?.mode === 'edit';
    if (nowEditing !== editing) {
      editing = nowEditing;
      overlay.classList.toggle('is-editing', editing);
      if (editing && overlay.contains(document.activeElement)) document.activeElement.blur();
    }
  }
  updateLayout();
  window.addEventListener('resize', updateLayout);

  function setTapeFocus(on) {
    if (tapeEl) tapeEl.classList.toggle('tutorial-focus', !!on);
  }

  function renderStep() {
    const step = STEPS_RUN[stepIndex];
    counterEl.textContent = `STEP ${stepIndex + 1}/${STEPS_RUN.length}`;
    glyphEl.innerHTML = step.glyph;
    titleEl.textContent = step.title;
    captionEl.textContent = step.caption;
    listenEl.innerHTML = '<span class="tutorial-does-label">WHAT IT DOES</span>';
    listenEl.append(step.listen);
    panelEl.classList.remove('is-success');
    skipEl.innerHTML = 'SKIP &rsaquo;';
    setTapeFocus(step.tapeFocus);
  }

  function renderMeter() {
    const step = STEPS_RUN[stepIndex];
    if (!step) return;
    const value = step.meter.read(tutorialState, ccCache, stepCtx);
    if (step.meter.isCount) {
      meterEl.textContent = `${step.meter.label} [ ${value || 0} ]`;
    } else {
      meterEl.textContent = `${step.meter.label} [${bar(value)}]`;
    }
  }

  let tutorialState = { hands: { left: null, right: null }, gestures: {}, stale: true };

  // Live coaching under the meter: what is wrong and how to fix it (red),
  // or what to do and how far along it is (cyan).
  function renderCoach() {
    const step = STEPS_RUN[stepIndex];
    if (!step) return;
    if (paused) {
      coachEl.className = 'tutorial-coach';
      coachEl.textContent = '❚❚ PAUSED · PRESS RESUME WHEN YOU ARE READY';
      return;
    }
    const h = tutorialState.hands || {};
    let bad = null;
    if (step.need) {
      if (tutorialState.stale) bad = 'CAMERA IS WARMING UP, HOLD ON';
      else if (!h.left && !h.right) bad = 'NO HANDS IN VIEW · STEP BACK UNTIL YOUR HANDS ARE IN THE FRAME';
      else if (step.need === 'right' && !h.right) bad = 'I ONLY SEE YOUR LEFT HAND · USE YOUR RIGHT HAND';
      else if (step.need === 'left' && !h.left) bad = 'I ONLY SEE YOUR RIGHT HAND · USE YOUR LEFT HAND';
      else if (step.need === 'both' && !(h.left && h.right)) bad = 'SHOW BOTH HANDS TO THE CAMERA';
    }
    if (!bad && step.id === 'gridWrite' && stepCtx.holding && !stepCtx.wrote && getGrid()?.armed !== 'write') {
      bad = 'THE TAPE IS NOT WRITING · IS THE BEAT ON?';
    }
    if (bad) {
      coachEl.className = 'tutorial-coach bad';
      coachEl.textContent = `✕ ${bad}`;
      return;
    }
    const p = Math.max(0, Math.min(1, stepCtx.progress || 0));
    coachEl.className = 'tutorial-coach go';
    coachEl.textContent = stepCtx.hint
      ? `▸ ${stepCtx.hint} · ${stepCtx.readout}`
      : `▸ ${step.how} [${bar(p)}] ${Math.round(p * 100)}%`;
  }

  function leaveStep() {
    if (stepCtx.tapeOff) stepCtx.tapeOff();
  }

  function enterStep(index) {
    leaveStep();
    stepIndex = index;
    stepCtx = {};
    successAt = null;
    renderStep();
    const step = STEPS_RUN[stepIndex];
    if (step.enter) step.enter(stepCtx);
  }

  function showComplete() {
    leaveStep();
    setTapeFocus(false);
    panelEl.style.display = 'none';
    completeEl.style.display = 'block';
    completed = true;
    chime(audioContext, true);
    if (onComplete) onComplete();
  }

  function advance() {
    if (stepIndex + 1 >= STEPS_RUN.length) {
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
      const step = STEPS_RUN[stepIndex];
      const now = performance.now();
      const dt = now - lastTickAt;
      lastTickAt = now;

      if (panelEl.style.display !== 'none' && stepIndex < STEPS_RUN.length) {
        renderMeter();

        if (paused) {
          // frozen: no detection, the success timer waits (see togglePause)
        } else if (editing && step.id !== 'gridEdit') {
          // in the editor only the EDIT step listens; the others wait for PLAY
          if (successAt != null) successAt += dt;
        } else if (successAt == null) {
          stepCtx.now = now;
          if (step.detect(tutorialState, stepCtx)) {
            successAt = performance.now();
            stepCtx.progress = 1;
            praiseEl.textContent = step.praise || '';
            panelEl.classList.add('is-success');
            skipEl.innerHTML = 'NEXT &rsaquo;';
            // restart the "next step" timer bar for this success
            nextFillEl.style.animation = 'none';
            void nextFillEl.offsetWidth;
            nextFillEl.style.animation = `tutorial-next ${SUCCESS_HOLD_MS}ms linear forwards`;
            chime(audioContext);
          }
          renderCoach();
        } else if (now - successAt >= SUCCESS_HOLD_MS) {
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
    leaveStep();
    setTapeFocus(false);
    offCc();
    window.removeEventListener('resize', updateLayout);
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    window.__AC_TUTORIAL = { next: () => {}, exit: () => {}, active: false };
    if (onExit) onExit();
  }

  // SKIP during a step, NEXT while GOT IT is showing.
  skipEl.addEventListener('click', () => advance());

  // BACK: the previous step (or, from the finale, the last step again).
  function back() {
    if (completed) {
      completed = false;
      completeEl.style.display = 'none';
      panelEl.style.display = '';
      enterStep(STEPS_RUN.length - 1);
    } else {
      enterStep(Math.max(0, stepIndex - 1));
    }
    if (paused) renderCoach();
  }
  backEl.addEventListener('click', back);
  againEl.addEventListener('click', back);

  // PAUSE: detection stops and a running "next step" timer holds its place;
  // the paused line replaces GOT IT until RESUME.
  function togglePause() {
    paused = !paused;
    pauseEl.textContent = paused ? 'RESUME' : 'PAUSE';
    pauseEl.setAttribute('aria-pressed', String(paused));
    panelEl.classList.toggle('is-paused', paused);
    if (paused) {
      pausedAt = performance.now();
    } else if (successAt != null) {
      successAt += performance.now() - pausedAt;
    }
    nextFillEl.style.animationPlayState = paused ? 'paused' : 'running';
    renderCoach();
  }
  pauseEl.addEventListener('click', togglePause);
  exitEl.addEventListener('click', exit);

  // KEEP PLAYING really plays: a GRID editor that is still open closes too.
  finishEl.addEventListener('click', () => {
    const g = grid ? getGrid() : null;
    if (g && g.mode === 'edit') g.exitEdit();
    exit();
  });

  // Enter moves on while GOT IT shows (focused buttons keep their own Enter).
  function onKey(e) {
    if (e.key !== 'Enter' || e.repeat || editing || paused || completed || successAt == null) return;
    const t = e.target;
    if (t && t.closest && t.closest('button, a, input, select, textarea, [contenteditable], [role="button"]')) return;
    e.preventDefault();
    advance();
  }
  document.addEventListener('keydown', onKey);

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
