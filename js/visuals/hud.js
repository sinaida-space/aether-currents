// AETHER CURRENTS — DOS-style HUD on the 2D overlay canvas.
// Pure text, white/red/cyan monospace, palette-matched glow. Redraws at <=10Hz.
// Everything the recording needs is painted here (no HTML overlays).

import { VERSION } from '../version.js';

const WHITE = '#f2f2f2';
const RED = '#ff2a2a';
const CYAN = '#00e5ff';
const DIM = 'rgba(242,242,242,0.35)';
const GESTURE_NORMAL = 'rgba(242,242,242,0.55)';
const GESTURE_DIMMED = 'rgba(242,242,242,0.22)';
const GESTURE_DIM_AFTER_MS = 60000;
const GESTURE_LINE_WIDE =
  'R-HAND XY:POS/PITCH · PINCH:GRAIN · L-HAND Y:DENSITY · HANDS APART:FILTER+SPACE · FIST:FREEZE · FLICK OPEN:BURST · R-3FING:CHORD · L-3FING HOLD:CHORD/ARP';
const GESTURE_LINES_NARROW = [
  'R-HAND XY:POS/PITCH · PINCH:GRAIN · L-HAND Y:DENSITY',
  'HANDS APART:FILTER+SPACE · FIST:FREEZE · FLICK OPEN:BURST',
  'R-3FING:CHORD · L-3FING HOLD:CHORD/ARP',
];

// Fallback note names (A minor pentatonic) — used only until the first
// mapper frame supplies live noteNames for the active scale+key.
const DEFAULT_NOTE_NAMES = ['A', 'C', 'D', 'E', 'G', 'A'];
const BAND_COUNT = 6;

function fmt2(x) {
  // 0.42 -> ".42", -0.4 -> "-.40"
  if (x == null || Number.isNaN(x)) return '.00';
  const s = Math.abs(x).toFixed(2).replace(/^0/, '');
  return (x < 0 ? '-' : '') + s;
}
function fmt1(x) {
  if (x == null || Number.isNaN(x)) return '0.0';
  return x.toFixed(1);
}

export class Hud {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.lastDraw = -1e9;
    this._trackedSince = null;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.lastDraw = -1e9; // force redraw after a resize
  }

  // now = ms timestamp; fps = renderer.fps; osd = {osdOn, camOn, camMs} from renderer
  draw(state, fps, now, osd) {
    if (now - this.lastDraw < 100) return; // throttle to 10Hz
    this.lastDraw = now;

    const ctx = this.ctx;
    const dpr = this.dpr;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    const s = state || {};
    const blinkOn = Math.floor(now / 500) % 2 === 0;
    const fontPx = Math.max(16, Math.round(18 * dpr));
    const lh = Math.round(fontPx * 1.5);
    const pad = Math.round(18 * dpr);

    ctx.textBaseline = 'top';
    ctx.font = `${fontPx}px "VT323", "Courier New", monospace`;
    ctx.shadowBlur = 8 * dpr;

    let y = pad;
    const line = (text, color) => {
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.fillText(text, pad, y);
      y += lh;
    };

    // top-left system block
    line(`AETHER CURRENTS v${VERSION}`, WHITE);

    const modeShort = (s.modeLabel || 'FULL MODE').replace(' MODE', '');
    const trk = Math.round(s.trackingFps || 0);
    line(`MODE: ${modeShort} ▪ ${Math.round(fps || 0)}FPS ▪ TRK ${trk}FPS`, CYAN);

    line(`SMP: ${(s.sampleName || '—').toUpperCase()}`, WHITE);
    line(`3-FINGER MODE: ${s.chordArp ? 'ARP' : 'CHORD'}`, CYAN);

    const p = s.params || {};
    line(
      `POS ${fmt2(p.position)}  PIT ${fmt1(p.pitch)}  SIZ ${fmt2(p.grainSize)}  DEN ${Math.round(p.density || 0)}`,
      WHITE
    );

    if (s.frozen && blinkOn) line('[FROZEN]', RED);
    else if (s.frozen) y += lh; // keep layout stable while blinking

    // Suppress this fallback REC when the camcorder OSD is already showing
    // its own top-right ● REC — avoids a doubled REC indicator on screen.
    const osdRecActive = !!(osd && osd.osdOn && osd.camOn);
    if (s.recording && !osdRecActive) line('● REC', RED);

    // Persistent recorder error line — shown regardless of ?debug, errors
    // are never silent. Sticks for the caller-defined window (recordErrorUntil).
    if (s.recordError && now < (s.recordErrorUntil || 0)) {
      line('⚠ ' + s.recordError, RED);
    }

    // WebGL context-loss notice (issue #21) — visuals only, audio keeps
    // running underneath. Blinks while actively lost; once recovery has
    // repeated more than once in this session, offers a LIGHT-mode escape
    // hatch via keyboard (main.js binds 'L').
    if (osd && osd.glLost) {
      if (blinkOn) line('⚠ GPU CONTEXT LOST — RECOVERING…', RED);
      else y += lh;
    }
    if (osd && osd.glLossRepeated) {
      line(`⚠ GPU UNSTABLE (${osd.glLossCount}×) — PRESS L FOR LIGHT MODE`, RED);
    }

    // debug panel (?debug URL flag) — FPS/latency/encoder-queue instrumentation.
    if (s.debug) {
      line(`RENDER ${Math.round(fps || 0)}FPS  TRK ${Math.round(s.trackingFps || 0)}FPS`, CYAN);
      line(`LATENCY ${Math.round(s.latencyMs || 0)}ms  (max ${Math.round(s.latencyMaxMs || 0)}ms)`, CYAN);
      line(`ENC QUEUE ${s.encodeQueueSize ?? 0}`, CYAN);
    }

    // centered SIGNAL LOST banner
    if (s.stale && blinkOn) {
      const banner = 'SIGNAL LOST — SHOW YOUR HANDS';
      const bf = Math.max(16, Math.round(20 * dpr));
      ctx.font = `${bf}px "VT323", "Courier New", monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = CYAN;
      ctx.shadowColor = CYAN;
      ctx.fillText(banner, W / 2, H / 2 - bf);
      ctx.textAlign = 'left';
      ctx.font = `${fontPx}px "VT323", "Courier New", monospace`;
    }

    // reserve clearance so the fixed bottom ui-bar never overlaps our text
    const uiClearance = Math.round(58 * dpr);
    const bottomLine = H - uiClearance;

    // pitch bands + octave + beat pulse — only while a hand is tracked.
    const hands = s.hands || {};
    if (hands.left || hands.right) {
      this._drawBands(ctx, s, dpr, W, bottomLine, now, blinkOn);
    }

    // camcorder OSD — only while the cam background is on and the toggle is set.
    // Composited into the hud canvas, so it lands in recordings automatically.
    if (osd && osd.osdOn && osd.camOn) {
      ctx.font = `${fontPx}px "VT323", "Courier New", monospace`;
      ctx.shadowBlur = 8 * dpr;

      // top-right: blinking REC + tape counter
      ctx.textAlign = 'right';
      const rx = W - pad;
      if (blinkOn) {
        ctx.fillStyle = RED; ctx.shadowColor = RED;
        ctx.fillText('● REC', rx, pad);
      }
      const sec = Math.floor((osd.camMs || 0) / 1000);
      const mm = String(Math.floor(sec / 60) % 60).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      ctx.fillStyle = WHITE; ctx.shadowColor = WHITE;
      ctx.fillText(`SP 0:${mm}:${ss}`, rx, pad + lh);

      // bottom-left: date stamp + battery glyph
      const d = new Date();
      const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
        'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const stamp = `${MON[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')} ${d.getFullYear()}`;
      ctx.textAlign = 'left';
      ctx.shadowColor = WHITE; ctx.shadowBlur = 6 * dpr;
      ctx.fillStyle = DIM;
      ctx.fillText(stamp, pad, bottomLine - fontPx - lh);
      ctx.fillStyle = WHITE;
      ctx.fillText('▐███▌', pad, bottomLine - fontPx);

      ctx.textAlign = 'left';
      ctx.shadowBlur = 0;
    }

    // bottom-right watermark
    ctx.textAlign = 'right';
    ctx.fillStyle = DIM;
    ctx.shadowColor = WHITE;
    ctx.shadowBlur = 4 * dpr;
    ctx.fillText('sinaida.eu', W - pad, bottomLine - fontPx);
    ctx.textAlign = 'left';

    // bottom-center MS-DOS style gesture instruction line(s), above the watermark
    if (!s.stale) {
      if (this._trackedSince == null) this._trackedSince = now;
    } else {
      this._trackedSince = null;
    }
    const trackedMs = this._trackedSince != null ? now - this._trackedSince : 0;
    const dimGesture = trackedMs > GESTURE_DIM_AFTER_MS;

    const cssW = this.canvas.clientWidth || (W / dpr);
    const narrow = cssW < 900;
    const gLines = narrow ? GESTURE_LINES_NARROW.slice() : [GESTURE_LINE_WIDE];
    gLines[gLines.length - 1] += blinkOn ? ' ▮' : ' ';

    const gFontPx = Math.max(14, Math.round(16 * dpr));
    const gLh = Math.round(gFontPx * 1.35);
    ctx.font = `${gFontPx}px "VT323", "Courier New", monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = dimGesture ? GESTURE_DIMMED : GESTURE_NORMAL;
    ctx.shadowColor = WHITE;
    ctx.shadowBlur = 4 * dpr;
    let gy = bottomLine - fontPx - Math.round(6 * dpr) - gLh * gLines.length;
    for (const text of gLines) {
      ctx.fillText(text, W / 2, gy);
      gy += gLh;
    }
    ctx.textAlign = 'left';
    ctx.shadowBlur = 0;
  }

  // 6 thin band-separator lines (pitch quantization), note names, octave
  // indicator, and a beat pulse dot. Right-side column, sparse by design.
  _drawBands(ctx, s, dpr, W, bottomLine, now, blinkOn) {
    const pad = Math.round(18 * dpr);
    const colW = Math.round(72 * dpr);
    const lineX0 = W - pad - colW;
    const lineX1 = W - pad - Math.round(28 * dpr);
    const top = Math.round(90 * dpr);
    const bottom = bottomLine - Math.round(90 * dpr);
    const span = Math.max(1, bottom - top);
    const band = s.pitchBand;
    const noteNames = (s.noteNames && s.noteNames.length === BAND_COUNT) ? s.noteNames : DEFAULT_NOTE_NAMES;

    ctx.save();
    ctx.shadowBlur = 0;

    for (let b = 0; b < BAND_COUNT; b++) {
      const centerFrac = 1 - (b + 0.5) / BAND_COUNT; // b=5 (top note) near y=0
      const y = top + centerFrac * span;
      const active = b === band;
      ctx.strokeStyle = active ? RED : GESTURE_NORMAL;
      ctx.lineWidth = active ? 2 * dpr : 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(lineX0, y);
      ctx.lineTo(lineX1, y);
      ctx.stroke();

      const noteFontPx = Math.max(11, Math.round(13 * dpr));
      ctx.font = `${noteFontPx}px "VT323", "Courier New", monospace`;
      ctx.textAlign = 'right';
      ctx.fillStyle = active ? RED : DIM;
      ctx.fillText(noteNames[b], lineX1 + Math.round(20 * dpr), y - noteFontPx / 2);
    }

    // scale + key label, above the band column (cycled via S / K keys, or the
    // SCALE ui-bar button — see main.js).
    const scaleFontPx = Math.max(11, Math.round(13 * dpr));
    ctx.font = `${scaleFontPx}px "VT323", "Courier New", monospace`;
    ctx.textAlign = 'right';
    ctx.fillStyle = CYAN;
    const scaleLabel = `${s.rootKeyName || 'A'} ${s.scaleLabel || 'MIN PENT'}`;
    ctx.fillText(scaleLabel, lineX1 + Math.round(20 * dpr), top - scaleFontPx * 2 - Math.round(10 * dpr));

    // octave indicator, above the band column
    const oct = s.octaveShift || 0;
    const octLabel = oct > 0 ? '+1' : oct < 0 ? '-1' : '0';
    const octFontPx = Math.max(12, Math.round(14 * dpr));
    ctx.font = `${octFontPx}px "VT323", "Courier New", monospace`;
    ctx.textAlign = 'right';
    ctx.fillStyle = CYAN;
    ctx.fillText(`OCT ${octLabel}`, lineX1 + Math.round(20 * dpr), top - octFontPx - Math.round(6 * dpr));

    // beat pulse dot — brightest on the downbeat, fading across the phase.
    if (s.beatOn && s.beatPhase) {
      const phase = s.beatPhase.phase || 0;
      const alpha = Math.max(0, 1 - phase);
      const r = Math.round(5 * dpr);
      const cx = lineX1 + Math.round(20 * dpr) - r;
      const cy = top - octFontPx - Math.round(6 * dpr) - octFontPx - r * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,229,255,${(0.25 + 0.75 * alpha).toFixed(2)})`;
      ctx.fill();
    }

    ctx.textAlign = 'left';
    ctx.restore();
  }
}
