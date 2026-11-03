import { renderAudio, encodeWav } from './audio.js';

/* ------------------------------------------------------------- geometry -- */

const W = 1280;              // ink resolution (independent of display size)
const H = 640;
const FMIN = 100;            // bottom of the plot, Hz
const FMAX = 8000;           // top of the plot, Hz
const LOGSPAN = Math.log(FMAX / FMIN);
// Left ruler width, css px. Mirrors --gutter so the ink canvas, the note labels
// and the playhead all share one time axis.
const GUTTER = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gutter')) || 46;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SCALES = {
  off: null,
  pentMinor: [0, 3, 5, 7, 10],
  pentMajor: [0, 2, 4, 7, 9],
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
};
const HARMONICS = [[2, 0.42, 0.8], [3, 0.26, 0.7], [4, 0.15, 0.62]];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const yOfF = (f) => (H * Math.log(FMAX / f)) / LOGSPAN;
const fOfY = (y) => FMAX * Math.exp((-LOGSPAN * y) / H);
const freqOfMidi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const midiOfFreq = (f) => 69 + 12 * Math.log2(f / 440);
const noteLabel = (m) => NOTES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

/* --------------------------------------------------------------- elements -- */

const $ = (id) => document.getElementById(id);
const appEl = $('app');
const screenEl = $('screen');
const gridCv = $('grid');
const inkCv = $('ink');
const overCv = $('overlay');
const readout = $('readout');
const renderState = $('renderState');
const renderBar = $('renderBar');
const playBtn = $('play');
const tcurEl = $('tcur');
const tlenEl = $('tlen');
const loopBtn = $('loop');
const harmBtn = $('harm');
const sizeEl = $('size');
const snapEl = $('snap');
const durationEl = $('duration');
const chipsEl = $('chips');

const ctx = inkCv.getContext('2d', { willReadFrequently: true });
inkCv.width = W;
inkCv.height = H;

const state = { duration: 12, tool: 'pen', size: 10, snap: 'pentMinor', harm: false, loop: true };

/* ---------------------------------------------------------------- sprites -- */

const SPRITE = 160;
const spriteCache = new Map();
let eraseCache = null;

function spriteFor(t) {
  const key = Math.round(clamp(t, 0, 1) * 23);
  let s = spriteCache.get(key);
  if (s) return s;

  const u = key / 23;
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE;
  const g = c.getContext('2d');

  g.fillStyle = `hsl(${268 - 83 * u} 92% ${56 + 22 * u}%)`;
  g.fillRect(0, 0, SPRITE, SPRITE);

  const grad = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.38, 'rgba(255,255,255,0.92)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.3)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');

  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = grad;
  g.fillRect(0, 0, SPRITE, SPRITE);

  spriteCache.set(key, c);
  return c;
}

function eraseSprite() {
  if (eraseCache) return eraseCache;
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, SPRITE, SPRITE);
  const grad = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.75)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = grad;
  g.fillRect(0, 0, SPRITE, SPRITE);
  eraseCache = c;
  return c;
}

/* ------------------------------------------------------------------ painting */

function stampPen(x, y, r, a) {
  if (x < -r || x > W + r || y < -r || y > H + r) return;
  ctx.globalAlpha = a;
  ctx.drawImage(spriteFor(1 - y / H), x - r, y - r, r * 2, r * 2);

  if (state.harm) {
    const f = fOfY(y);
    for (const [mult, gain, scale] of HARMONICS) {
      const fh = f * mult;
      if (fh > FMAX) break;
      const yh = yOfF(fh);
      const rh = r * scale;
      ctx.globalAlpha = a * gain;
      ctx.drawImage(spriteFor(1 - yh / H), x - rh, yh - rh, rh * 2, rh * 2);
    }
  }
  ctx.globalAlpha = 1;
}

function stampErase(x, y, r, a) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = a;
  ctx.drawImage(eraseSprite(), x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'lighter';
}

function snappedY(y) {
  const scale = SCALES[state.snap];
  if (!scale) return y;
  const f = clamp(fOfY(y), FMIN, FMAX);
  const m = midiOfFreq(f);
  let best = Math.round(m);
  let bestD = Infinity;
  for (let k = Math.floor(m) - 4; k <= Math.ceil(m) + 4; k++) {
    if (!scale.includes(((k % 12) + 12) % 12)) continue;
    const d = Math.abs(k - m);
    if (d < bestD) { bestD = d; best = k; }
  }
  return yOfF(clamp(freqOfMidi(best), FMIN, FMAX));
}

function chordDegrees(f) {
  const scale = SCALES[state.snap];
  if (!scale) return [freqOfMidi(midiOfFreq(f)), freqOfMidi(Math.round(midiOfFreq(f)) + 7), freqOfMidi(Math.round(midiOfFreq(f)) + 12)];
  const m = midiOfFreq(f);
  let root = Math.round(m);
  let bestD = Infinity;
  for (let k = Math.floor(m) - 4; k <= Math.ceil(m) + 4; k++) {
    if (!scale.includes(((k % 12) + 12) % 12)) continue;
    const d = Math.abs(k - m);
    if (d < bestD) { bestD = d; root = k; }
  }
  const out = [freqOfMidi(root)];
  let cur = root;
  for (let step = 0; step < 6 && out.length < 3; step++) {
    cur++;
    const pc = ((cur % 12) + 12) % 12;
    if (scale.includes(pc)) out.push(freqOfMidi(cur));
  }
  return out;
}

function stampChord(pt) {
  const halfW = Math.round(16 + state.size * 1.4);
  const r = state.size * 0.78;
  for (const f of chordDegrees(fOfY(pt.y))) {
    const y = yOfF(clamp(f, FMIN, FMAX));
    for (let x = pt.x - halfW; x <= pt.x + halfW; x += 2) {
      const k = 1 - Math.abs((x - pt.x) / halfW);
      stampPen(x, y, r, 0.16 + 0.4 * k);
    }
  }
}

/* --------------------------------------------------------------- strokes -- */

let drawing = false;
let lastPt = null;
let hoverPt = null;
let activeId = null;

function ptFromEvent(e) {
  const r = inkCv.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
}

function beginStroke(pt) {
  pushUndo();
  drawing = true;
  activeId = null;
  lastPt = pt;

  if (state.tool === 'chord') {
    stampChord(pt);
  } else if (state.tool === 'eraser') {
    stampErase(pt.x, pt.y, state.size, 0.85);
  } else {
    stampPen(pt.x, pt.y, state.size, 0.62);
  }
  markDirty();
}

function moveStroke(pt) {
  if (!drawing || state.tool === 'chord') return;
  const prev = lastPt;
  if (!prev) { lastPt = pt; return; }

  const r = state.size;
  const dist = Math.hypot(pt.x - prev.x, pt.y - prev.y);
  const steps = Math.max(1, Math.min(400, Math.ceil(dist / Math.max(1.2, r * 0.26))));

  if (state.tool === 'eraser') {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      stampErase(prev.x + (pt.x - prev.x) * t, prev.y + (pt.y - prev.y) * t, r, 0.45);
    }
    lastPt = pt;
    markDirty();
    return;
  }

  let py = snappedY(prev.y);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = prev.x + (pt.x - prev.x) * t;
    const y = snappedY(prev.y + (pt.y - prev.y) * t);
    stampPen(x, y, r, 0.5);

    // close vertical gaps when the pitch steps (snap grid, or a fast drag)
    if (Math.abs(y - py) > r * 0.85) {
      const dir = y > py ? 1 : -1;
      const stepY = Math.max(2, r * 0.42);
      for (let yy = py + dir * stepY; dir > 0 ? yy < y : yy > y; yy += dir * stepY) {
        stampPen(x, yy, r * 0.62, 0.3);
      }
    }
    py = y;
  }
  lastPt = pt;
  markDirty();
}

function endStroke() {
  drawing = false;
  lastPt = null;
}

/* ------------------------------------------------------------------- undo -- */

const undoStack = [];
const UNDO_LIMIT = 14;

function pushUndo() {
  try {
    undoStack.push(inkCv.toDataURL('image/png'));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  } catch (err) { /* tainted canvas can't happen here, but never break drawing */ }
}

function undo() {
  const url = undoStack.pop();
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    markDirty();
  };
  img.src = url;
}

/* ------------------------------------------------------------------ presets */

const rampWarm = (y) => `hsl(${268 - 83 * (1 - y / H)} 92% ${56 + 22 * (1 - y / H)}%)`;

function path(points, width, alpha, blur = 0) {
  if (points.length < 2) return;
  const midY = points.reduce((a, p) => a + p[1], 0) / points.length;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = rampWarm(midY);
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (blur) { ctx.shadowColor = rampWarm(midY); ctx.shadowBlur = blur; }
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.restore();
}

function sweep(points, width, peak) {
  for (let i = 0; i < points.length - 1; i++) {
    const t = i / (points.length - 1);
    const e = Math.pow(Math.sin(Math.PI * t), 1.15);
    path([points[i], points[i + 1]], width, peak * e);
  }
}

function clearInk() {
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
}

function presetArp() {
  const notes = [57, 60, 62, 64, 67, 69, 72, 76];
  notes.forEach((m, i) => {
    const x = ((i + 0.5) / notes.length) * (W * 0.9) + W * 0.05;
    const y = yOfF(freqOfMidi(m));
    const tail = [];
    for (let k = 0; k <= 30; k++) tail.push([x + k * 5.5, y + Math.sin(k * 0.6) * 0.4]);
    path(tail, 13, 0.5, 10);
    for (let k = 0; k < 18; k++) path([[x + k * 5.5, y]], 12, Math.exp(-k / 5) * 0.22, 6);
  });
  const pad = [];
  for (let x = W * 0.04; x <= W * 0.96; x += 16) pad.push([x, yOfF(110)]);
  path(pad, 26, 0.1, 22);
}

function presetPad() {
  const chord = [110, 164.81, 220, 261.63, 329.63];
  chord.forEach((f, i) => {
    const pts = [];
    const n = 70;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      pts.push([W * (0.05 + t * 0.9), yOfF(f) + Math.sin(t * 6 + i) * 1.2]);
    }
    sweep(pts, 7 + i, 0.3 + 0.12 * (1 - i / chord.length));
  });
  for (let k = 0; k < 5; k++) {
    const x = W * (0.15 + k * 0.17);
    path([[x, yOfF(660)], [x + 24, yOfF(990)]], 3, 0.12, 6);
  }
}

function presetChirp() {
  const arms = [[220, 2600, 0.02], [330, 3900, 0.36], [170, 1750, 0.68]];
  arms.forEach(([a, b, off], idx) => {
    const pts = [];
    for (let i = 0; i <= 160; i++) {
      const t = i / 160;
      const f = a * Math.pow(b / a, t) * (1 + 0.025 * Math.sin(t * 42 + idx));
      pts.push([W * (off + t * 0.3), yOfF(f)]);
    }
    path(pts, 8, 0.55, 8);
    path(pts.map(([x, y]) => [x, yOfF(fOfY(y) * 2)]), 4, 0.16);
  });
}

const rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function presetBirds() {
  const r = rng(7);
  for (let b = 0; b < 7; b++) {
    const x0 = W * (0.06 + r() * 0.82);
    const f0 = 700 + r() * 2400;
    const n = 34 + Math.floor(r() * 30);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const f = f0 * (1 + 0.85 * Math.sin(Math.PI * t)) * (1 + 0.05 * Math.sin(t * 18));
      pts.push([x0 + t * (70 + r() * 40), yOfF(clamp(f, FMIN, FMAX))]);
    }
    path(pts, 5, 0.55, 6);
  }
  for (let b = 0; b < 5; b++) {
    const x0 = W * (0.1 + r() * 0.8);
    path([[x0, yOfF(180)], [x0 + 30, yOfF(150)]], 20, 0.12, 14);
  }
}

function presetRain() {
  const r = rng(31);
  for (let i = 0; i < 46; i++) {
    const x = W * (0.03 + r() * 0.94);
    const f = 400 * Math.pow(16, r());
    const y = yOfF(f);
    const radius = 6 + r() * 9;
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius * 2.2);
    g.addColorStop(0, rampWarm(y));
    g.addColorStop(0.45, rampWarm(y));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55 + r() * 0.4;
    ctx.beginPath();
    ctx.arc(x, y, radius * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    const tail = [];
    for (let k = 0; k < 8; k++) tail.push([x + k * 2.5, yOfF(f * Math.pow(0.985, k))]);
    path(tail, 3, 0.3, 4);
  }
}

function presetDrums() {
  for (let i = 0; i < 8; i++) {
    const x = W * (0.07 + i * 0.115);
    path([[x, yOfF(70)], [x, yOfF(4200)]], 7, 0.34, 10);
    path([[x, yOfF(420)], [x + 26, yOfF(90)]], 9, 0.5, 8);
  }
}

const PRESETS = [
  { id: 'arp', label: 'arpeggio', draw: presetArp },
  { id: 'pad', label: 'chord pad', draw: presetPad },
  { id: 'chirp', label: 'chirp', draw: presetChirp },
  { id: 'birds', label: 'birds', draw: presetBirds },
  { id: 'rain', label: 'rain', draw: presetRain },
  { id: 'drums', label: 'drums', draw: presetDrums },
];

function loadPreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  stop();
  pushUndo();
  clearInk();
  ctx.save();
  p.draw();
  ctx.restore();
  markDirty();
  setPlayhead(0);
}

/* ------------------------------------------------------------------- grid -- */

function drawGrid() {
  const rect = screenEl.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  for (const c of [gridCv, overCv]) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }

  const g = gridCv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0a0d15');
  bg.addColorStop(0.55, '#060810');
  bg.addColorStop(1, '#04060b');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);

  const yPx = (f) => (h * Math.log(FMAX / f)) / LOGSPAN;

  // scale rows glow faintly when snapping is on
  if (SCALES[state.snap]) {
    const scale = SCALES[state.snap];
    g.fillStyle = 'rgba(76,240,216,0.035)';
    for (let m = 24; m <= 122; m++) {
      if (!scale.includes(((m % 12) + 12) % 12)) continue;
      const y1 = yPx(freqOfMidi(m + 1));
      const y2 = yPx(freqOfMidi(m));
      if (y2 < 0 || y1 > h) continue;
      g.fillRect(GUTTER, y1, w - GUTTER, Math.max(1, y2 - y1));
    }
  }

  // semitone grid
  g.lineWidth = 1;
  for (let m = 24; m <= 124; m++) {
    const f = freqOfMidi(m);
    if (f < FMIN * 0.999 || f > FMAX * 1.001) continue;
    const y = Math.round(yPx(f)) + 0.5;
    const isC = m % 12 === 0;
    g.strokeStyle = isC ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.032)';
    g.beginPath();
    g.moveTo(GUTTER, y);
    g.lineTo(w, y);
    g.stroke();
  }

  // time grid
  const step = state.duration <= 8 ? 1 : state.duration <= 14 ? 2 : 4;
  g.strokeStyle = 'rgba(255,255,255,0.045)';
  for (let t = 0; t <= state.duration + 0.001; t += step) {
    const x = Math.round((t / state.duration) * (w - GUTTER)) + GUTTER + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }

  // ruler gutter
  g.fillStyle = 'rgba(0,0,0,0.4)';
  g.fillRect(0, 0, GUTTER, h);
  g.strokeStyle = 'rgba(255,255,255,0.09)';
  g.beginPath();
  g.moveTo(GUTTER + 0.5, 0);
  g.lineTo(GUTTER + 0.5, h);
  g.stroke();

  // note labels
  g.font = `9px ${MONO}`;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (let m = 24; m <= 124; m += 12) {
    const f = freqOfMidi(m);
    if (f < FMIN || f > FMAX) continue;
    const y = yPx(f);
    g.fillStyle = 'rgba(233,237,246,0.34)';
    g.fillText(noteLabel(m), GUTTER - 8, y);
    g.fillStyle = 'rgba(233,237,246,0.14)';
    g.fillText('—', GUTTER - 4, y);
  }

  // top hairline
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.beginPath();
  g.moveTo(GUTTER, 0.5);
  g.lineTo(w, 0.5);
  g.stroke();
}

/* --------------------------------------------------------------- playhead -- */

let playFraction = null;
let overlayDirty = true;

function setPlayhead(f) {
  playFraction = f;
  overlayDirty = true;
}

function drawOverlay() {
  const rect = screenEl.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  const g = overCv.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  // time labels live above the ink so a loud low band can't wash them out
  const step = state.duration <= 8 ? 1 : state.duration <= 14 ? 2 : 4;
  g.font = `9px ${MONO}`;
  g.textAlign = 'center';
  g.textBaseline = 'bottom';
  g.fillStyle = 'rgba(233,237,246,0.34)';
  for (let t = 0; t <= state.duration + 0.001; t += step) {
    const x = GUTTER + (t / state.duration) * (w - GUTTER);
    if (x > w - 12) continue;
    g.fillText(`${t}s`, x, h - 6);
  }

  if (playFraction == null) return;

  const x = GUTTER + playFraction * (w - GUTTER);

  g.fillStyle = 'rgba(76,240,216,0.05)';
  g.fillRect(GUTTER, 0, x - GUTTER, h);

  g.save();
  g.strokeStyle = 'rgba(198,255,247,0.9)';
  g.lineWidth = 1.4;
  g.shadowColor = 'rgba(76,240,216,0.95)';
  g.shadowBlur = 16;
  g.beginPath();
  g.moveTo(x, 0);
  g.lineTo(x, h);
  g.stroke();
  g.restore();

  g.fillStyle = 'rgba(198,255,247,0.95)';
  g.fillRect(x - 3, 0, 6, 2);
}

/* ------------------------------------------------------------------ audio -- */

let actx = null;
let master = null;
let source = null;
let startedAt = 0;
let playing = false;
let raf = 0;
let buffer = null;
let samples = null;
let dirty = true;
let renderPromise = null;

function audioCtx() {
  if (!actx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    actx = new Ctor();
    master = actx.createGain();
    master.gain.value = 0.9;
    master.connect(actx.destination);
  }
  return actx;
}

function markDirty() {
  dirty = true;
  if (playing) stop();
}

function readInk() {
  return ctx.getImageData(0, 0, W, H).data;
}

function ensureBuffer() {
  if (!dirty && buffer) return Promise.resolve(buffer);
  if (renderPromise) return renderPromise;

  renderState.hidden = false;
  renderBar.style.width = '0%';

  const snapshot = readInk();
  const duration = state.duration;

  renderPromise = (async () => {
    const progress = async (p) => {
      renderBar.style.width = (p * 100).toFixed(1) + '%';
      await new Promise((r) => setTimeout(r, 0));
    };
    const res = await renderAudio(snapshot, W, H, duration, {
      fmin: FMIN,
      fmax: FMAX,
      onProgress: progress,
    });
    const c = audioCtx();
    const buf = c.createBuffer(1, res.samples.length, res.sampleRate);
    buf.getChannelData(0).set(res.samples);
    return { buf, res };
  })();

  return renderPromise
    .then(({ buf, res }) => {
      buffer = buf;
      samples = res.samples;
      dirty = false;
      return buf;
    })
    .finally(() => {
      renderPromise = null;
      renderState.hidden = true;
      renderBar.style.width = '0%';
    });
}

function tick() {
  if (!playing) return;
  const elapsed = actx.currentTime - startedAt;
  const dur = state.duration;
  if (!state.loop && elapsed >= dur) {
    stop();
    setPlayhead(0);
    tcurEl.textContent = '0.00';
    drawOverlay();
    return;
  }
  const pos = elapsed % dur;
  setPlayhead(pos / dur);
  if (overlayDirty) { drawOverlay(); overlayDirty = false; }
  tcurEl.textContent = pos.toFixed(2);
  raf = requestAnimationFrame(tick);
}

async function togglePlay() {
  if (playing) { stop(); return; }

  const c = audioCtx();
  if (c.state === 'suspended') await c.resume();

  let buf;
  try {
    buf = await ensureBuffer();
  } catch (err) {
    console.error('render failed', err);
    return;
  }

  source = c.createBufferSource();
  source.buffer = buf;
  source.loop = state.loop;
  source.connect(master);

  const offset = playFraction ? playFraction * state.duration : 0;
  startedAt = c.currentTime - offset;
  source.start(0, offset % buf.duration);

  playing = true;
  appEl.classList.add('is-playing');
  raf = requestAnimationFrame(tick);
}

function stop() {
  if (source) {
    try { source.onended = null; source.stop(); } catch (err) { /* already stopped */ }
    source.disconnect();
    source = null;
  }
  playing = false;
  appEl.classList.remove('is-playing');
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

/* ------------------------------------------------------------------- test -- */

async function exportWav() {
  const buf = await ensureBuffer();
  const data = samples ?? buf.getChannelData(0);
  const blob = new Blob([encodeWav(data, buf.sampleRate)], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `siren-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.wav`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ------------------------------------------------------------------- ui ---- */

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('is-on', b.dataset.tool === tool));
  inkCv.classList.toggle('tool-eraser', tool === 'eraser');
  inkCv.classList.toggle('tool-chord', tool === 'chord');
}

function updateReadout(pt) {
  if (!pt) { readout.hidden = true; return; }
  const f = fOfY(pt.y);
  const m = Math.round(midiOfFreq(f));
  const hz = f >= 1000 ? `${(f / 1000).toFixed(2)}k` : f.toFixed(0);
  readout.textContent = `${noteLabel(m)}  ${hz} Hz`;
  readout.hidden = false;

  const rect = screenEl.getBoundingClientRect();
  const px = GUTTER + (pt.x / W) * (rect.width - GUTTER);
  const py = (pt.y / H) * rect.height;
  readout.style.left = `${clamp(px, 0, rect.width - 96)}px`;
  readout.style.top = `${clamp(py, 40, rect.height)}px`;
}

/* --------------------------------------------------------------- listeners -- */

inkCv.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  // A capture failure must never swallow the stroke itself.
  try { inkCv.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
  activeId = e.pointerId;
  const pt = ptFromEvent(e);
  hoverPt = pt;
  updateReadout(pt);

  if (state.tool === 'chord') {
    // chord stamps are one-shot; tap again to stack another
    beginStroke(pt);
    endStroke();
    return;
  }
  beginStroke(pt);
});

inkCv.addEventListener('pointermove', (e) => {
  const pt = ptFromEvent(e);
  hoverPt = pt;
  updateReadout(pt);
  if (drawing && (activeId === null || e.pointerId === activeId)) moveStroke(pt);
});

const finish = (e) => {
  if (!drawing) return;
  if (activeId !== null && e && e.pointerId !== activeId) return;
  endStroke();
  activeId = null;
};

inkCv.addEventListener('pointerup', finish);
inkCv.addEventListener('pointercancel', finish);
inkCv.addEventListener('pointerleave', () => { hoverPt = null; updateReadout(null); });
inkCv.addEventListener('contextmenu', (e) => e.preventDefault());

playBtn.addEventListener('click', togglePlay);

loopBtn.addEventListener('click', () => {
  state.loop = !state.loop;
  loopBtn.classList.toggle('is-on', state.loop);
  if (source) source.loop = state.loop;
});

harmBtn.addEventListener('click', () => {
  state.harm = !state.harm;
  harmBtn.classList.toggle('is-on', state.harm);
});

sizeEl.addEventListener('input', () => { state.size = Number(sizeEl.value); });

snapEl.addEventListener('change', () => {
  state.snap = snapEl.value;
  drawGrid();
});

durationEl.addEventListener('change', () => {
  stop();
  state.duration = Number(durationEl.value);
  tlenEl.textContent = state.duration.toFixed(2);
  tcurEl.textContent = '0.00';
  markDirty();
  setPlayhead(0);
  drawGrid();
  drawOverlay();
});

$('undo').addEventListener('click', undo);
$('clear').addEventListener('click', () => {
  stop();
  pushUndo();
  clearInk();
  markDirty();
  setPlayhead(0);
  tcurEl.textContent = '0.00';
  drawOverlay();
});
$('export').addEventListener('click', () => { exportWav().catch((e) => console.error(e)); });

document.querySelectorAll('.tool').forEach((b) => {
  b.addEventListener('click', () => setTool(b.dataset.tool));
});

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const k = e.key.toLowerCase();
  if (k === 'b') setTool('pen');
  else if (k === 'c') setTool('chord');
  else if (k === 'e') setTool('eraser');
  else if (k === 'h') harmBtn.click();
  else if (k === 'l') loopBtn.click();
});

window.addEventListener('resize', () => {
  drawGrid();
  drawOverlay();
});

/* ------------------------------------------------------------------- boot -- */

function buildChips() {
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = p.label;
    b.addEventListener('click', () => loadPreset(p.id));
    chipsEl.appendChild(b);
  }
}

function boot() {
  buildChips();
  setTool('pen');
  tlenEl.textContent = state.duration.toFixed(2);
  clearInk();
  drawGrid();
  loadPreset('arp');
  setPlayhead(0);
  drawOverlay();
  requestAnimationFrame(() => { drawGrid(); drawOverlay(); });
}

boot();

// exposed for quick console poking / automated checks
window.siren = { state, renderAudio, drawGrid, loadPreset, clearInk };
