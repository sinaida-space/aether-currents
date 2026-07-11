// AETHER CURRENTS — boot module
// Consent -> system check -> mode select -> camera -> boot hook.

import { runSystemCheck } from './syscheck.js';
import { GranularEngine, generateLibrary, loadUserFile, captureMic } from './audio/engine.js';
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
  { text: 'AETHER BIOS v3.1 — (C) SINAIDA SYSTEMS' },
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

async function startWithMode(mode) {
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
      window.__AC_BOOT(mode);
    } else {
      hudStatus.textContent = 'modules loading — pipeline in progress';
    }
  } catch (err) {
    cameraErrorText.textContent =
      'CAMERA ACCESS DENIED. AETHER CURRENTS needs your camera to track hand gestures.';
    cameraError.style.display = 'block';
  }
}

btnStartFull.addEventListener('click', () => startWithMode('full'));
btnStartLight.addEventListener('click', () => startWithMode('light'));

btnRetryCamera.addEventListener('click', () => {
  if (pendingMode) {
    startWithMode(pendingMode);
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
const sampleUploadInput = document.getElementById('sample-upload-input');
const btnCloseSamples = document.getElementById('btn-close-samples');

const micCountdown = document.getElementById('mic-countdown');
const micCountdownNum = document.getElementById('mic-countdown-num');

const recordExport = document.getElementById('record-export');
const btnSaveVideo = document.getElementById('btn-save-video');
const btnSaveAudio = document.getElementById('btn-save-audio');
const btnCopyCredit = document.getElementById('btn-copy-credit');
const btnCloseExport = document.getElementById('btn-close-export');

const CREDIT_LINE = 'Made with AETHER CURRENTS by Sinaida — sinaida.eu';
const UPLOAD_LABEL = '▸ UPLOAD FILE...';
const MIC_LABEL = '▸ RECORD MIC (4S)';

function progressBar(frac) {
  const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
  const filled = Math.round(pct / 10);
  const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
  return `LOADING VISION MODEL ${bar} ${pct}%`;
}

window.__AC_BOOT = async function __AC_BOOT(mode) {
  hudStatus.textContent = 'BOOTING AUDIO ENGINE...';

  const AC = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AC();
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

    const uploadLi = document.createElement('li');
    uploadLi.textContent = UPLOAD_LABEL;
    uploadLi.addEventListener('click', () => sampleUploadInput.click());
    sampleList.appendChild(uploadLi);

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

  sampleUploadInput.addEventListener('change', async () => {
    const file = sampleUploadInput.files && sampleUploadInput.files[0];
    sampleUploadInput.value = '';
    if (!file) return;
    try {
      const buffer = await loadUserFile(audioContext, file);
      const name = file.name.replace(/\.[^.]+$/, '').toUpperCase().slice(0, 24);
      addCustomEntry({ id: `custom-${Date.now()}`, name: name || 'UPLOADED', buffer });
      closeSampleMenu();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[AETHER CURRENTS] upload decode failed:', err);
    }
  });

  async function recordMicSample() {
    closeSampleMenu();
    micCountdown.style.display = 'flex';
    for (const n of [3, 2, 1]) {
      micCountdownNum.textContent = String(n);
      await new Promise((res) => setTimeout(res, 1000));
    }
    micCountdownNum.textContent = '●REC';
    try {
      const buffer = await captureMic(audioContext, 4);
      addCustomEntry({ id: `custom-${Date.now()}`, name: 'MIC CAPTURE', buffer });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[AETHER CURRENTS] mic capture failed:', err);
    } finally {
      micCountdown.style.display = 'none';
    }
  }

  // ---- keyboard shortcuts -------------------------------------------------

  document.addEventListener('keydown', (e) => {
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
  });

  // ---- BEAT toggle ----------------------------------------------------------

  function updateBeatButton() {
    const bpm = Math.round(engine.getBeatPhase().bpm);
    btnBeat.textContent = engine.beatOn ? `▪ BEAT ${bpm}` : '▸ BEAT';
  }

  function toggleBeat() {
    engine.setBeat(!engine.beatOn);
    updateBeatButton();
  }

  btnBeat.addEventListener('click', toggleBeat);
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
