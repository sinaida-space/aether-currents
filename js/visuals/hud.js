// AETHER CURRENTS — DOS-style HUD on the 2D overlay canvas.
// Pure text, amber monospace, palette-matched glow. Redraws at <=10Hz.
// Everything the recording needs is painted here (no HTML overlays).

const AMBER = '#ffb000';
const RED = '#ff2a2a';
const CYAN = '#00e5ff';
const DIM = 'rgba(255,176,0,0.35)';
const GESTURE_NORMAL = 'rgba(255,176,0,0.55)';
const GESTURE_DIMMED = 'rgba(255,176,0,0.22)';
const GESTURE_DIM_AFTER_MS = 60000;
const GESTURE_LINE_WIDE =
  'R-HAND XY:POS/PITCH · PINCH:GRAIN · L-HAND Y:DENSITY · HANDS APART:FILTER+SPACE · FIST:FREEZE · FLICK OPEN:BURST';
const GESTURE_LINES_NARROW = [
  'R-HAND XY:POS/PITCH · PINCH:GRAIN · L-HAND Y:DENSITY',
  'HANDS APART:FILTER+SPACE · FIST:FREEZE · FLICK OPEN:BURST',
];

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

  // now = ms timestamp; fps = renderer.fps
  draw(state, fps, now) {
    if (now - this.lastDraw < 100) return; // throttle to 10Hz
    this.lastDraw = now;

    const ctx = this.ctx;
    const dpr = this.dpr;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    const s = state || {};
    const blinkOn = Math.floor(now / 500) % 2 === 0;
    const fontPx = Math.max(12, Math.round(14 * dpr));
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
    line('AETHER CURRENTS v1.0', AMBER);

    const modeShort = (s.modeLabel || 'FULL MODE').replace(' MODE', '');
    const trk = Math.round(s.trackingFps || 0);
    line(`MODE: ${modeShort} ▪ ${Math.round(fps || 0)}FPS ▪ TRK ${trk}FPS`, AMBER);

    line(`SMP: ${(s.sampleName || '—').toUpperCase()}`, AMBER);

    const p = s.params || {};
    line(
      `POS ${fmt2(p.position)}  PIT ${fmt1(p.pitch)}  SIZ ${fmt2(p.grainSize)}  DEN ${Math.round(p.density || 0)}`,
      AMBER
    );

    if (s.frozen && blinkOn) line('[FROZEN]', RED);
    else if (s.frozen) y += lh; // keep layout stable while blinking

    if (s.recording) line('● REC', RED);

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

    // bottom-right watermark
    ctx.textAlign = 'right';
    ctx.fillStyle = DIM;
    ctx.shadowColor = AMBER;
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

    const gFontPx = Math.max(11, Math.round(13 * dpr));
    const gLh = Math.round(gFontPx * 1.35);
    ctx.font = `${gFontPx}px "VT323", "Courier New", monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = dimGesture ? GESTURE_DIMMED : GESTURE_NORMAL;
    ctx.shadowColor = AMBER;
    ctx.shadowBlur = 4 * dpr;
    let gy = bottomLine - fontPx - Math.round(6 * dpr) - gLh * gLines.length;
    for (const text of gLines) {
      ctx.fillText(text, W / 2, gy);
      gy += gLh;
    }
    ctx.textAlign = 'left';
    ctx.shadowBlur = 0;
  }
}
