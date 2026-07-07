// AETHER CURRENTS — boot module
// Consent -> system check -> mode select -> camera -> boot hook.

import { runSystemCheck } from './syscheck.js';

const CONSENT_KEY = 'ac.consent';
const MODE_KEY = 'ac.mode';

const welcome = document.getElementById('welcome');
const consentGate = document.getElementById('consent-gate');
const modeSelect = document.getElementById('mode-select');
const btnConsent = document.getElementById('btn-consent');
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
  consentGate.style.display = 'none';
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

btnConsent.addEventListener('click', () => {
  setConsent();
  runProbeAndShowModes();
});

if (hasConsent()) {
  runProbeAndShowModes();
}

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
