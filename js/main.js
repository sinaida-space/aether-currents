// AETHER CURRENTS — boot module
// Consent -> system check -> mode select -> camera -> boot hook.

import { runSystemCheck } from './syscheck.js';
import { GranularEngine, generateLibrary, captureMic } from './audio/engine.js';
import { HandTracker } from './tracking/tracker.js';
import { Renderer } from './visuals/renderer.js';
import { Mapper } from './mapping.js';
import { Recorder, downloadBlob } from './recorder.js';

const CONSENT_KEY = 'ac.consent';
const MODE_KEY = 'ac.mode';

const welcome = document.getElementById('welcome');
const modeSelect = document.getElementById('mode-select');
const boot = document.getElementById('boot');
const bootLinesEl = document.getElementById('boot-lines');
const bootGdpr = document.getElementById('boot-gdpr');
const btnBootAccept = document.getElementById('btn-boot-accept');
const asciiGlyphs = document.getElementById('ascii-glyphs');
const btnStartFull = document.getElementById('btn-start-full');
const btnStartLight = document.getElementById('btn-start-light');
const syscheckStatus = document.getElementById('syscheck-status');
const syscheckDetails = document.getElementById('syscheck-details');
const cameraError = document.getElementById('camera-error');
const cameraErrorText = document.getElementById('camera-error-text');
const btnRetryCamera = document.getElementById('btn-retry-camera');
const uiBar = document.getElementById('ui-bar');
const btnFullscreen = document.getElementById('btn-fullscreen');
const hudStatus = document.getElementById('hud-status');
const camVideo = document.getElementById('cam');

let lastProbe = null;
let pendingMode = null;

function hasConsent() {
  return localStorage.getItem(CONSENT_KEY) === '1';
}

function setConsent() {
  localStorage.setItem(CONSENT_KEY, '1');
}

function storeMode(mode) {
  localStorage.setItem(MODE_KEY, mode);
}

function formatDetails(details) {
  const mem = details.memoryGB === null ? 'unknown' : details.memoryGB + 'GB';
  return (
    `GPU: ${details.gpu}\n` +
    `CORES: ${details.cores}  MEMORY: ${mem}  CONNECTION: ${details.connection}\n` +
    `RENDER SCORE: ${details.renderScore.toFixed(2)}ms/frame`
  );
}

async function runProbeAndShowModes() {
  modeSelect.style.display = 'block';
  syscheckStatus.textContent = 'SYSTEM CHECK...';
  syscheckDetails.textContent = '';

  const probe = await runSystemCheck((text) => {
    syscheckStatus.textContent = text;
  });
  lastProbe = probe;

  syscheckDetails.textContent = formatDetails(probe.details);

  btnStartFull.classList.remove('recommended');
  btnStartLight.classList.remove('recommended');

  if (probe.recommended === 'light') {
    syscheckStatus.textContent = 'SYSTEM CHECK: LIGHT MODE recommended — you can still try it here ▸';
    btnStartLight.classList.add('recommended');
  } else {
    syscheckStatus.textContent = 'SYSTEM CHECK: FULL MODE recommended ▸';
    btnStartFull.classList.add('recommended');
  }
}

// ---------------------------------------------------------------------------
// Screen 1 — BIOS/POST boot sequence + GDPR consent.
// Returning visitors (ac.consent already set) skip straight to Screen 2.
// ---------------------------------------------------------------------------

const BOOT_LINES = [
  { text: 'AETHER BIOS v3.2.0 — (C) SINAIDA SYSTEMS' },
  { memory: true },
  { text: 'AETHER SOUND DRIVER ........ OK' },
  { text: 'HAND TRACKING MODULE ....... OK' },
  { text: 'GRANULAR ENGINE ............ OK' },
  { text: 'VIDEO: VHS COMPOSITE ....... OK' },
  { text: '' },
  { text: 'AETHER CURRENTS — conduct sound with your hands.' },
  { text: 'made by Sinaida — sinaida.eu' },
];
const MEMORY_TARGET_KB = 65536;

let typingDone = false;
let skipRequested = false;
let bootLines = [];

function renderBootLines() {
  bootLinesEl.textContent = bootLines.join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function typeLine(text, msPerChar) {
  bootLines.push('');
  const idx = bootLines.length - 1;
  for (let i = 0; i < text.length; i++) {
    if (skipRequested) {
      bootLines[idx] = text;
      renderBootLines();
      return;
    }
    bootLines[idx] += text[i];
    renderBootLines();
    await sleep(msPerChar);
  }
}

async function typeMemoryLine() {
  bootLines.push('');
  const idx = bootLines.length - 1;
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    if (skipRequested) break;
    const kb = Math.round((MEMORY_TARGET_KB / steps) * i);
    bootLines[idx] = `MEMORY TEST : ${kb} KB`;
    renderBootLines();
    await sleep(18);
  }
  bootLines[idx] = `MEMORY TEST : ${MEMORY_TARGET_KB} KB OK`;
  renderBootLines();
}

async function runBootSequence() {
  for (const l of BOOT_LINES) {
    if (skipRequested) {
      bootLines.push(l.memory ? `MEMORY TEST : ${MEMORY_TARGET_KB} KB OK` : l.text);
      renderBootLines();
      continue;
    }
    if (l.memory) await typeMemoryLine();
    else await typeLine(l.text, 11);
  }
  finishTyping();
}

function finishTyping() {
  typingDone = true;
  bootGdpr.hidden = false;
}

function skipTyping() {
  if (typingDone) return;
  skipRequested = true;
}

boot.addEventListener('click', () => skipTyping());
document.addEventListener('keydown', () => {
  if (boot.hidden || boot.classList.contains('dissolve')) return;
  skipTyping();
});

function dissolveBoot() {
  boot.classList.add('dissolve');
  setTimeout(() => {
    boot.hidden = true;
  }, 400);
  runProbeAndShowModes();
}

btnBootAccept.addEventListener('click', (e) => {
  e.stopPropagation();
  setConsent();
  dissolveBoot();
});

if (hasConsent()) {
  boot.hidden = true;
  runProbeAndShowModes();
} else {
  runBootSequence();
}

// ---------------------------------------------------------------------------
// Screen 2 — sparse ASCII bloom glyphs, spawned outside the welcome panel.
// ---------------------------------------------------------------------------

const GLYPH_CHARS = ['✶', '·', '✦', '+', '·', '✧'];
const GLYPH_COLORS = ['var(--red)', 'var(--cyan)', 'var(--white)'];
const MAX_GLYPHS = 14;
let activeGlyphs = 0;

function spawnGlyph() {
  if (activeGlyphs >= MAX_GLYPHS || !asciiGlyphs) return;
  activeGlyphs++;

  const el = document.createElement('span');
  el.className = 'ascii-glyph';
  el.textContent = GLYPH_CHARS[Math.floor(Math.random() * GLYPH_CHARS.length)];
  el.style.color = GLYPH_COLORS[Math.floor(Math.random() * GLYPH_COLORS.length)];

  // Keep glyphs out of the centered panel: bias toward the side margins.
  const xSide = Math.random() < 0.5 ? Math.random() * 18 : 82 + Math.random() * 18;
  const y = Math.random() * 100;
  el.style.left = xSide + '%';
  el.style.top = y + '%';

  asciiGlyphs.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => {
      el.remove();
      activeGlyphs--;
    }, 1500);
  }, 1500 + 3000);
}

function glyphLoop() {
  spawnGlyph();
  setTimeout(glyphLoop, 450 + Math.random() * 700);
}
glyphLoop();

// Respawn-safe glyphs on rotate/resize: the side-band % geometry is meaningless
// once the aspect ratio flips, so clear stale glyphs and let the loop respawn.
window.addEventListener('resize', () => {
  if (!asciiGlyphs || (welcome && welcome.style.display === 'none')) return;
  asciiGlyphs.innerHTML = '';
  activeGlyphs = 0;
});

async function startWithMode(mode, audioContext) {
  pendingMode = mode;
  storeMode(mode);
  window.AC_MODE = mode;

  cameraError.style.display = 'none';

  const constraints =
    mode === 'light'
      ? { video: { width: 640, height: 480 } }
      : { video: { width: 1280, height: 720 } };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    camVideo.srcObject = stream;
    await camVideo.play().catch(() => {});

    welcome.style.display = 'none';
    uiBar.classList.add('visible');

    if (typeof window.__AC_BOOT === 'function') {
      window.__AC_BOOT(mode, audioContext);
    } else {
      hudStatus.textContent = 'modules loading — pipeline in progress';
    }
  } catch (err) {
    cameraErrorText.textContent =
      'CAMERA ACCESS DENIED. AETHER CURRENTS needs your camera to track hand gestures.';
    cameraError.style.display = 'block';
  }
}

// iOS/Safari drop "user activation" across an awaited getUserMedia prompt, so
// creating/resuming the AudioContext later inside __AC_BOOT silently fails to
// unlock audio on mobile. Create + resume it synchronously in the click
// handler itself, then hand it down through startWithMode → __AC_BOOT.
function startWithModeFromGesture(mode) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AC();
  audioContext.resume().catch(() => {});
  startWithMode(mode, audioContext);
}

btnStartFull.addEventListener('click', () => startWithModeFromGesture('full'));
btnStartLight.addEventListener('click', () => startWithModeFromGesture('light'));

btnRetryCamera.addEventListener('click', () => {
  if (pendingMode) {
    startWithModeFromGesture(pendingMode);
  }
});

function currentFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function updateFullscreenLabel() {
  btnFullscreen.textContent = currentFullscreenElement() ? '⛶ EXIT' : '⛶ FULLSCREEN';
}

function requestFullscreenOn(el) {
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  return Promise.reject(new Error('Fullscreen API unsupported'));
}

function exitFullscreenCompat() {
  if (document.exitFullscreen) return document.exitFullscreen();
  if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
  return Promise.resolve();
}

// iOS Safari has no Fullscreen API for arbitrary elements (only <video>).
// Detect that up front and hide the button rather than offer a dead control;
// the mobile CSS already maximizes the layout as a fallback.
const supportsFullscreen = !!(
  document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen
);
if (!supportsFullscreen) {
  btnFullscreen.style.display = 'none';
}

btnFullscreen.addEventListener('click', () => {
  if (currentFullscreenElement()) {
    exitFullscreenCompat().catch(() => {});
  } else {
    Promise.resolve(requestFullscreenOn(document.documentElement))
      .then(() => {
        // Best-effort landscape lock — unsupported on many browsers/orientations.
        if (screen.orientation && screen.orientation.lock) {
          screen.orientation.lock('landscape').catch(() => {});
        }
      })
      .catch((err) => {
        hudStatus.textContent = `fullscreen unavailable — ${err.message || err}`;
      });
  }
});

document.addEventListener('fullscreenchange', updateFullscreenLabel);
document.addEventListener('webkitfullscreenchange', updateFullscreenLabel);
updateFullscreenLabel();

const btnHome = document.getElementById('btn-home');
btnHome.addEventListener('click', () => {
  // Full reload cleanly tears down camera/audio/tracker state; consent is
  // already persisted, so this lands straight back on the mode-select screen.
  if (currentFullscreenElement()) exitFullscreenCompat().catch(() => {});
  location.reload();
});

// ---------------------------------------------------------------------------
// Task 8 — UI declutter panel: per-button show/hide + MINIMAL preset.
// Pure visibility toggle (display:none via a class) — buttons stay in the
// DOM, their click handlers and keyboard shortcuts keep working when hidden.
// ---------------------------------------------------------------------------

const DECLUTTER_KEY = 'ac.declutter';

// id -> { label, essential }. essential = kept visible by the MINIMAL preset.
const DECLUTTER_ITEMS = [
  { id: 'btn-home', label: 'MAIN SCREEN', essential: true },
  { id: 'btn-fullscreen', label: 'FULLSCREEN', essential: true },
  { id: 'btn-record', label: 'RECORD', essential: true },
  { id: 'btn-samples', label: 'SAMPLES', essential: false },
  { id: 'btn-bg', label: 'BACKGROUND', essential: false },
  { id: 'btn-beat', label: 'BEAT', essential: false },
];

function loadDeclutterState() {
  try {
    const raw = JSON.parse(localStorage.getItem(DECLUTTER_KEY) || '{}');
    const state = {};
    for (const item of DECLUTTER_ITEMS) {
      state[item.id] = raw[item.id] !== false; // default visible
    }
    return state;
  } catch {
    const state = {};
    for (const item of DECLUTTER_ITEMS) state[item.id] = true;
    return state;
  }
}

let declutterState = loadDeclutterState();

function saveDeclutterState() {
  localStorage.setItem(DECLUTTER_KEY, JSON.stringify(declutterState));
}

function applyDeclutterState() {
  for (const item of DECLUTTER_ITEMS) {
    const el = document.getElementById(item.id);
    if (!el) continue;
    el.classList.toggle('ui-declutter-hidden', declutterState[item.id] === false);
  }
}

const btnDeclutter = document.getElementById('btn-declutter');
const declutterPanel = document.getElementById('declutter-panel');
const declutterList = document.getElementById('declutter-list');
const btnMinimal = document.getElementById('btn-minimal');
const btnDeclutterReset = document.getElementById('btn-declutter-reset');
const btnCloseDeclutter = document.getElementById('btn-close-declutter');

function renderDeclutterList() {
  declutterList.innerHTML = '';
  for (const item of DECLUTTER_ITEMS) {
    const li = document.createElement('li');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = declutterState[item.id] !== false;
    checkbox.addEventListener('change', () => {
      declutterState[item.id] = checkbox.checked;
      saveDeclutterState();
      applyDeclutterState();
    });
    const labelText = document.createElement('span');
    labelText.textContent = item.label;
    li.appendChild(checkbox);
    li.appendChild(labelText);
    li.addEventListener('click', (e) => {
      if (e.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    });
    declutterList.appendChild(li);
  }
}

function openDeclutterPanel() {
  renderDeclutterList();
  declutterPanel.style.display = 'block';
}

function closeDeclutterPanel() {
  declutterPanel.style.display = 'none';
}

btnDeclutter.addEventListener('click', () => {
  if (declutterPanel.style.display === 'none') openDeclutterPanel();
  else closeDeclutterPanel();
});
btnCloseDeclutter.addEventListener('click', closeDeclutterPanel);

btnMinimal.addEventListener('click', () => {
  for (const item of DECLUTTER_ITEMS) declutterState[item.id] = item.essential;
  saveDeclutterState();
  applyDeclutterState();
  renderDeclutterList();
});

btnDeclutterReset.addEventListener('click', () => {
  for (const item of DECLUTTER_ITEMS) declutterState[item.id] = true;
  saveDeclutterState();
  applyDeclutterState();
  renderDeclutterList();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && declutterPanel.style.display !== 'none') closeDeclutterPanel();
});

applyDeclutterState();

// ---------------------------------------------------------------------------
// Task 5 — boot hook, mapping loop, sample menu, recorder.
// ---------------------------------------------------------------------------

const glCanvas = document.getElementById('gl-canvas');
const hudCanvas = document.getElementById('hud-canvas');
const btnRecord = document.getElementById('btn-record');
const btnSamples = document.getElementById('btn-samples');
const btnBg = document.getElementById('btn-bg');
const btnBeat = document.getElementById('btn-beat');

const BG_KEY = 'ac.bg';
const OSD_KEY = 'ac.osd';

const sampleMenu = document.getElementById('sample-menu');
const sampleList = document.getElementById('sample-list');
const btnCloseSamples = document.getElementById('btn-close-samples');

const micCountdown = document.getElementById('mic-countdown');
const micCountdownNum = document.getElementById('mic-countdown-num');
const micReview = document.getElementById('mic-review');
const btnMicPlay = document.getElementById('btn-mic-play');
const btnMicKeep = document.getElementById('btn-mic-keep');
const btnMicRedo = document.getElementById('btn-mic-redo');

const recordExport = document.getElementById('record-export');
const btnSaveVideo = document.getElementById('btn-save-video');
const btnSaveAudio = document.getElementById('btn-save-audio');
const btnCopyCredit = document.getElementById('btn-copy-credit');
const btnCloseExport = document.getElementById('btn-close-export');

const CREDIT_LINE = 'Made with AETHER CURRENTS by Sinaida — sinaida.eu';
const MIC_LABEL = '▸ RECORD MIC (4S)';

function progressBar(frac) {
  const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
  const filled = Math.round(pct / 10);
  const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
  return `LOADING VISION MODEL ${bar} ${pct}%`;
}

window.__AC_BOOT = async function __AC_BOOT(mode, providedAudioContext) {
  hudStatus.textContent = 'BOOTING AUDIO ENGINE...';

  const AC = window.AudioContext || window.webkitAudioContext;
  const audioContext = providedAudioContext || new AC();
  if (audioContext.state === 'suspended') {
    await audioContext.resume().catch(() => {});
  }

  let library = [];
  let engine = null;
  let tracker = null;
  let renderer = null;

  const onProgress = (frac) => {
    hudStatus.textContent = progressBar(frac);
  };

  try {
    const enginePromise = GranularEngine.create(audioContext);
    const libraryPromise = generateLibrary(audioContext);
    const trackerPromise = HandTracker.create({ video: camVideo, mode, onProgress });

    // Renderer construction is synchronous WebGL setup — runs immediately,
    // alongside the async engine/library/tracker work above.
    renderer = new Renderer(glCanvas, hudCanvas, { mode, video: camVideo });

    [engine, library, tracker] = await Promise.all([enginePromise, libraryPromise, trackerPromise]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[AETHER CURRENTS] boot failed:', err);
    hudStatus.textContent = 'BOOT FAILED — SEE CONSOLE';
    return;
  }

  hudStatus.textContent = '';

  // ---- sample layering state (multi-select, 1..4 active buffers) --------
  // `library` grows in place as custom (upload/mic) entries are added, each
  // tagged with a 'custom-' id prefix so eviction can prefer them over the
  // built-in synths/voice sample.
  const activeIds = new Set();
  let activeOrder = []; // insertion order — activeOrder[0] drives the sampleName label

  function isBuiltinId(id) {
    return !id.startsWith('custom-');
  }

  const defaultEntry = library.find((s) => s.id === 'drone') || library[0];
  activeIds.add(defaultEntry.id);
  activeOrder.push(defaultEntry.id);
  engine.setActiveSamples([defaultEntry.buffer]);

  const mapper = new Mapper({
    engine,
    tracker,
    renderer,
    mode,
    sampleName: defaultEntry.name,
  });

  tracker.start();
  mapper.start();

  window.addEventListener('resize', () => renderer.resize());

  // ---- VHS webcam background toggle --------------------------------------

  const bgLabel = (m) => (m === 'CAM' ? 'BG: CAM' : 'BG: VOID');
  let bgMode = localStorage.getItem(BG_KEY) === 'CAM' ? 'CAM' : 'VOID';
  btnBg.textContent = bgLabel(bgMode);
  renderer.setCamOn(bgMode === 'CAM');

  function setBgMode(next) {
    bgMode = next;
    localStorage.setItem(BG_KEY, bgMode);
    btnBg.textContent = bgLabel(bgMode);
    renderer.setCamOn(bgMode === 'CAM');
  }

  btnBg.addEventListener('click', () => setBgMode(bgMode === 'CAM' ? 'VOID' : 'CAM'));

  // ---- camcorder OSD toggle (T key + sample-menu row) -------------------

  const osdRow = document.getElementById('osd-row');
  const osdState = document.getElementById('osd-state');
  let osdOn = localStorage.getItem(OSD_KEY) !== '0'; // default ON
  renderer.setOsdOn(osdOn);

  function updateOsdRow() {
    if (osdState) osdState.textContent = osdOn ? 'ON' : 'OFF';
  }
  function setOsd(next) {
    osdOn = next;
    localStorage.setItem(OSD_KEY, osdOn ? '1' : '0');
    renderer.setOsdOn(osdOn);
    updateOsdRow();
  }
  updateOsdRow();
  if (osdRow) osdRow.addEventListener('click', () => setOsd(!osdOn));

  // ---- sample menu ------------------------------------------------------

  function renderSampleList() {
    sampleList.innerHTML = '';
    library.forEach((entry, i) => {
      const li = document.createElement('li');
      li.dataset.index = String(i);
      const isActive = activeIds.has(entry.id);
      if (isActive) li.classList.add('active');
      if (i < 10) {
        const hint = document.createElement('span');
        hint.className = 'key-hint';
        hint.textContent = `[${i}]`;
        li.appendChild(hint);
      }
      // textContent, not innerHTML: entry.name for uploads is the raw
      // user-controlled filename.
      const marker = isActive ? '▪ ' : '  ';
      li.appendChild(document.createTextNode(marker + entry.name));
      li.addEventListener('click', () => toggleSample(entry.id));
      sampleList.appendChild(li);
    });

    const micLi = document.createElement('li');
    micLi.textContent = MIC_LABEL;
    micLi.addEventListener('click', () => recordMicSample());
    sampleList.appendChild(micLi);
  }

  function entryById(id) {
    return library.find((e) => e.id === id) || null;
  }

  function applyActiveSamples() {
    const buffers = [];
    for (const id of activeOrder) {
      const entry = entryById(id);
      if (entry) buffers.push(entry.buffer);
    }
    engine.setActiveSamples(buffers);

    const first = entryById(activeOrder[0]);
    const extra = activeOrder.length - 1;
    mapper.setSampleName(first ? (extra > 0 ? `${first.name} +${extra}` : first.name) : '—');

    renderSampleList();
  }

  // Evict the oldest custom (non-built-in) active entry to make room, or the
  // oldest entry overall if every active slot is built-in.
  function evictOldestForCap() {
    let idx = activeOrder.findIndex((id) => !isBuiltinId(id));
    if (idx === -1) idx = 0;
    const evictId = activeOrder[idx];
    activeIds.delete(evictId);
    activeOrder.splice(idx, 1);
  }

  function toggleSample(id) {
    if (activeIds.has(id)) {
      if (activeIds.size <= 1) return; // keep at least one active sample
      activeIds.delete(id);
      activeOrder = activeOrder.filter((x) => x !== id);
    } else {
      if (activeIds.size >= 4) evictOldestForCap();
      activeIds.add(id);
      activeOrder.push(id);
    }
    applyActiveSamples();
  }

  // Upload/mic ADD as a new toggled-on entry (never replace); cap 4, evict
  // oldest non-built-in if the set is already full.
  function addCustomEntry(entry) {
    library.push(entry);
    if (activeIds.size >= 4) evictOldestForCap();
    activeIds.add(entry.id);
    activeOrder.push(entry.id);
    applyActiveSamples();
  }

  function openSampleMenu() {
    renderSampleList();
    sampleMenu.style.display = 'block';
  }

  function closeSampleMenu() {
    sampleMenu.style.display = 'none';
  }

  btnSamples.addEventListener('click', () => {
    if (sampleMenu.style.display === 'none') openSampleMenu();
    else closeSampleMenu();
  });
  btnCloseSamples.addEventListener('click', closeSampleMenu);

  // Mic-only sampling (no file upload — see licensing note in the sample
  // menu): capture, then always review with playback before it's added to
  // the library, so there's no "what did I just record?" black box.
  let pendingMicBuffer = null;

  function playBuffer(buffer) {
    const src = audioContext.createBufferSource();
    src.buffer = buffer;
    src.connect(audioContext.destination);
    src.start(0);
  }

  function showMicReview() {
    micCountdownNum.style.display = 'none';
    micReview.style.display = 'block';
  }

  function hideMicReview() {
    micReview.style.display = 'none';
    micCountdownNum.style.display = 'block';
    micCountdown.style.display = 'none';
    pendingMicBuffer = null;
  }

  async function captureOnce() {
    micCountdown.style.display = 'flex';
    micCountdownNum.style.display = 'block';
    micReview.style.display = 'none';
    for (const n of [3, 2, 1]) {
      micCountdownNum.textContent = String(n);
      await new Promise((res) => setTimeout(res, 1000));
    }
    micCountdownNum.textContent = '●REC';
    try {
      pendingMicBuffer = await captureMic(audioContext, 4);
      showMicReview();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[AETHER CURRENTS] mic capture failed:', err);
      hideMicReview();
    }
  }

  function recordMicSample() {
    closeSampleMenu();
    captureOnce();
  }

  btnMicPlay.addEventListener('click', () => {
    if (pendingMicBuffer) playBuffer(pendingMicBuffer);
  });
  btnMicKeep.addEventListener('click', () => {
    if (pendingMicBuffer) {
      addCustomEntry({ id: `custom-${Date.now()}`, name: 'MIC CAPTURE', buffer: pendingMicBuffer });
    }
    hideMicReview();
  });
  btnMicRedo.addEventListener('click', () => {
    pendingMicBuffer = null;
    captureOnce();
  });

  // ---- keyboard shortcuts -------------------------------------------------

  document.addEventListener('keydown', (e) => {
    if (micReview.style.display !== 'none') {
      if (e.key === 'Enter') { btnMicKeep.click(); return; }
      if (e.key === 'r' || e.key === 'R') { btnMicRedo.click(); return; }
      if (e.key === 'Escape') { hideMicReview(); return; }
    }
    if (e.key === 'Escape') {
      if (sampleMenu.style.display !== 'none') closeSampleMenu();
      if (recordExport.style.display !== 'none') recordExport.style.display = 'none';
      return;
    }
    if (/^[0-9]$/.test(e.key)) {
      const i = Number(e.key);
      if (library[i]) toggleSample(library[i].id);
      return;
    }
    if (e.key === 'v' || e.key === 'V') {
      setBgMode(bgMode === 'CAM' ? 'VOID' : 'CAM');
    }
    if (e.key === 't' || e.key === 'T') {
      setOsd(!osdOn);
    }
    if (e.key === 'b' || e.key === 'B') {
      toggleBeat();
    }
    if (e.key === '[' || e.key === ']') {
      nudgeBpm(e.key === ']' ? 5 : -5);
    }
  });

  // ---- BEAT toggle + BPM control ---------------------------------------------
  // UI-only per product decision: no gesture, no auto-tap-tempo. Click toggles
  // beat on/off; shift-click (or long-press on touch) opens exact BPM entry;
  // [ / ] nudge by 5. BPM is always shown so it's adjustable before beat is on.

  function updateBeatButton() {
    const bpm = Math.round(engine.getBeatPhase().bpm);
    btnBeat.textContent = engine.beatOn ? `▪ BEAT ${bpm}` : `▸ BEAT ${bpm}`;
  }

  function toggleBeat() {
    engine.setBeat(!engine.beatOn);
    updateBeatButton();
  }

  function nudgeBpm(delta) {
    const current = Math.round(engine.getBeatPhase().bpm);
    engine.setBpm(current + delta);
    updateBeatButton();
  }

  function promptBpm() {
    const current = Math.round(engine.getBeatPhase().bpm);
    const input = window.prompt('BPM (60-180):', String(current));
    if (input == null) return;
    const parsed = parseInt(input, 10);
    if (!Number.isFinite(parsed)) return;
    engine.setBpm(parsed);
    updateBeatButton();
  }

  let btnBeatPressTimer = null;
  let btnBeatLongPressed = false;
  btnBeat.addEventListener('click', (e) => {
    if (btnBeatLongPressed) { btnBeatLongPressed = false; return; } // swallow synthesized click after long-press
    if (e.shiftKey) promptBpm();
    else toggleBeat();
  });
  // Long-press (touch has no shift-click) opens the same BPM prompt.
  btnBeat.addEventListener('touchstart', () => {
    btnBeatLongPressed = false;
    btnBeatPressTimer = setTimeout(() => { btnBeatLongPressed = true; promptBpm(); }, 550);
  }, { passive: true });
  btnBeat.addEventListener('touchend', () => {
    if (btnBeatPressTimer) { clearTimeout(btnBeatPressTimer); btnBeatPressTimer = null; }
  });
  updateBeatButton();

  // ---- recorder -----------------------------------------------------------

  const recorder = new Recorder({
    glCanvas,
    hudCanvas,
    audioNode: engine.output,
    audioContext,
    modeLabel: mode === 'full' ? 'FULL MODE' : 'LIGHT MODE',
  });

  let lastExport = null;

  // Centralized: fires whether stop() was triggered by the button or by the
  // recorder's own 5-minute hard-stop timer, so the UI stays in sync either way.
  recorder.onStop = (result) => {
    btnRecord.textContent = '● RECORD';
    mapper.recording = false;
    lastExport = result;
    recordExport.style.display = 'block';
  };

  btnRecord.addEventListener('click', async () => {
    if (!recorder.recording) {
      await recorder.start();
      mapper.recording = true;
      btnRecord.textContent = '● STOP';
    } else {
      await recorder.stop();
    }
  });

  btnSaveVideo.addEventListener('click', () => {
    if (!lastExport) return;
    downloadBlob(lastExport.webmBlob, lastExport.filename.webm);
  });

  btnSaveAudio.addEventListener('click', () => {
    if (!lastExport) return;
    downloadBlob(lastExport.wavBlob, lastExport.filename.wav);
  });

  btnCopyCredit.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(CREDIT_LINE);
      const original = btnCopyCredit.textContent;
      btnCopyCredit.textContent = 'COPIED ▪';
      btnCopyCredit.classList.add('copied');
      setTimeout(() => {
        btnCopyCredit.textContent = original;
        btnCopyCredit.classList.remove('copied');
      }, 1500);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[AETHER CURRENTS] clipboard write failed:', err);
    }
  });

  btnCloseExport.addEventListener('click', () => {
    recordExport.style.display = 'none';
  });
};
