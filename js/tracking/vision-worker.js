// AETHER CURRENTS — vision worker
// Module worker: downloads MediaPipe HandLandmarker (wasm + model) with
// progress, then runs VIDEO-mode detection on bitmaps handed over by the
// main-thread frame pump. Replies with plain objects only (no MediaPipe
// class instances cross the postMessage boundary).

import {
  HandLandmarker,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';

let landmarker = null;
let ready = false;

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch failed for ${url}: ${res.status}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) {
    // No streaming or no length available — fall back to a single jump.
    const buf = await res.arrayBuffer();
    onProgress(1);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }
  const buf = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.length;
  }
  return buf.buffer;
}

async function init(mode) {
  // wasm ~0-60% of progress, model download ~60-95%, createFromOptions ~95-100%
  const report = (p) => self.postMessage({ type: 'progress', value: p });

  report(0);
  const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
  report(0.6);

  const modelAssetBuffer = await fetchWithProgress(MODEL_URL, (p) => {
    report(0.6 + p * 0.35);
  });

  const baseOptions = {
    modelAssetBuffer: new Uint8Array(modelAssetBuffer),
    delegate: 'GPU',
  };

  try {
    landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions,
      runningMode: 'VIDEO',
      numHands: 2,
    });
  } catch (err) {
    // GPU delegate unsupported/failed — fall back to CPU.
    landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { ...baseOptions, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 2,
    });
  }

  report(1);
  ready = true;
  self.postMessage({ type: 'ready' });
}

function detect(bitmap, id, sentAt) {
  if (!ready || !landmarker) {
    bitmap.close();
    return;
  }
  const ts = performance.now();
  let result;
  try {
    result = landmarker.detectForVideo(bitmap, ts);
  } catch (err) {
    bitmap.close();
    self.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
    return;
  }
  bitmap.close();

  const hands = [];
  const landmarksList = result.landmarks || [];
  const handednessList = result.handedness || [];
  for (let i = 0; i < landmarksList.length; i++) {
    const lm = landmarksList[i];
    const flat = new Float32Array(lm.length * 3);
    for (let j = 0; j < lm.length; j++) {
      flat[j * 3] = lm[j].x;
      flat[j * 3 + 1] = lm[j].y;
      flat[j * 3 + 2] = lm[j].z;
    }
    const cat = handednessList[i] && handednessList[i][0];
    hands.push({
      label: cat ? cat.categoryName : null, // raw MediaPipe label, unmirrored frame
      score: cat ? cat.score : 0,
      landmarks: flat,
    });
  }

  self.postMessage(
    {
      type: 'result',
      id,
      sentAt,
      t: ts,
      hands,
    },
    hands.map((h) => h.landmarks.buffer)
  );
}

self.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      init(msg.mode).catch((err) => {
        self.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
      });
      break;
    case 'frame':
      detect(msg.bitmap, msg.id, msg.sentAt);
      break;
    case 'stop':
      // Nothing persistent to tear down; landmarker stays warm for restart.
      break;
    default:
      break;
  }
};
