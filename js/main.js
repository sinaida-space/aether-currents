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
  { text: 'AETHER BIOS v1.2 — (C) SINAIDA SYSTEMS' },
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
const MAX_GLYPHS = 7;
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
  setTimeout(glyphLoop, 900 + Math.random() * 1400);
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

function updateFullscreenLabel() {
  btnFullscreen.textContent = document.fullscreenElement ? '⛶ EXIT' : '⛶ FULLSCREEN';
}

btnFullscreen.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
});

document.addEventListener('fullscreenchange', updateFullscreenLabel);
updateFullscreenLabel();

// ---------------------------------------------------------------------------
// Task 5 — boot hook, mapping loop, sample menu, recorder.
// ---------------------------------------------------------------------------

const glCanvas = document.getElementById('gl-canvas');
const hudCanvas = document.getElementById('hud-canvas');
const btnRecord = document.getElementById('btn-record');
const btnSamples = document.getElementById('btn-samples');
const btnBg = document.getElementById('btn-bg');

const BG_KEY = 'ac.bg';

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

  const defaultEntry = library.find((s) => s.id === 'drone') || library[0];
  engine.setSample(defaultEntry.buffer);

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

  // ---- sample menu ------------------------------------------------------

  function renderSampleList() {
    sampleList.innerHTML = '';
    library.forEach((entry, i) => {
      const li = document.createElement('li');
      li.dataset.index = String(i);
      li.innerHTML = `<span class="key-hint">[${i}]</span>${entry.name}`;
      li.addEventListener('click', () => selectSample(i));
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

  function selectSample(i) {
    const entry = library[i];
    if (!entry) return;
    engine.setSample(entry.buffer);
    mapper.setSampleName(entry.name);
    closeSampleMenu();
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
      engine.setSample(buffer);
      mapper.setSampleName(name || 'UPLOADED');
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
      engine.setSample(buffer);
      mapper.setSampleName('MIC CAPTURE');
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
      if (library[i]) selectSample(i);
      return;
    }
    if (e.key === 'v' || e.key === 'V') {
      setBgMode(bgMode === 'CAM' ? 'VOID' : 'CAM');
    }
  });

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
