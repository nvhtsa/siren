// audio.js — turn a spectrogram bitmap into sound.
//
// The drawing is treated as a magnitude spectrogram: every frame of audio gets
// its bin magnitudes straight from the picture. Phase is a deterministic ramp
// (2π·b·hop·t/N) so each bin reconstructs as a stable oscillator — smooth
// glides stay smooth instead of turning to phase-vocoder mush.

export const SR = 44100;
export const N = 8192;
export const HOP = 1024;
const HALF = N / 2;
const TAU = Math.PI * 2;

/* ---------------------------------------------------------------- FFT ---- */

const REV = new Uint32Array(N);
{
  const levels = Math.round(Math.log2(N));
  for (let i = 0; i < N; i++) {
    let x = i, r = 0;
    for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
    REV[i] = r;
  }
}
const COS = new Float64Array(HALF);
const SIN = new Float64Array(HALF);
for (let i = 0; i < HALF; i++) { COS[i] = Math.cos(TAU * i / N); SIN[i] = Math.sin(TAU * i / N); }

// inverse transform, e^{+i}, unnormalised (caller scales by 1/N)
function ifft(re, im) {
  for (let i = 0; i < N; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const c = COS[w], s = SIN[w];
        const a = start + k, b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr;        im[a] += ti;
      }
    }
  }
}

// The hop divides N exactly, so a bin's phase advance per hop is always one of
// N/HOP fixed turns. A lookup table replaces millions of trig calls.
const STEPS = N / HOP;
const PCOS = new Float64Array(STEPS);
const PSIN = new Float64Array(STEPS);
for (let i = 0; i < STEPS; i++) {
  PCOS[i] = Math.cos((TAU * i) / STEPS);
  PSIN[i] = Math.sin((TAU * i) / STEPS);
}

const WIN = new Float64Array(N);
for (let i = 0; i < N; i++) WIN[i] = Math.sqrt(0.5 - 0.5 * Math.cos(TAU * i / N));

/* ------------------------------------------------------------- helpers ---- */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Small Freeverb-style room. Drawn sounds are dry and clicky without it.
function room(x, sr, mix) {
  const scale = sr / 44100;
  const combs = [1557, 1580, 1617, 1491].map((d) => ({
    buf: new Float32Array(Math.max(1, Math.round(d * scale))), i: 0, lp: 0,
  }));
  const aps = [556, 341].map((d) => ({
    buf: new Float32Array(Math.max(1, Math.round(d * scale))), i: 0,
  }));
  const feedback = 0.76, damp = 0.28, out = new Float32Array(x.length);

  for (let n = 0; n < x.length; n++) {
    const input = x[n] * 0.16;
    let wet = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp = y * (1 - damp) + c.lp * damp;
      c.buf[c.i] = input + c.lp * feedback;
      if (++c.i >= c.buf.length) c.i = 0;
      wet += y;
    }
    for (const a of aps) {
      const b = a.buf[a.i];
      a.buf[a.i] = wet + b * 0.5;
      if (++a.i >= a.buf.length) a.i = 0;
      wet = b - wet * 0.5;
    }
    out[n] = x[n] + wet * mix;
  }
  return out;
}

/* -------------------------------------------------------------- render ---- */

/**
 * @param {Uint8ClampedArray} pixels RGBA from the ink canvas (opaque, additive)
 * @param {number} width  ink width in px
 * @param {number} height ink height in px
 * @param {number} duration seconds represented by the full width
 * @returns {Promise<{samples: Float32Array, sampleRate: number}>}
 */
export async function renderAudio(pixels, width, height, duration, options = {}) {
  const fmin = options.fmin ?? 100;
  const fmax = options.fmax ?? 8000;
  const onProgress = options.onProgress ?? (() => {});
  const wet = options.wet ?? 0.14;

  const frames = Math.max(16, Math.round((duration * SR) / HOP));
  const bins = HALF + 1;
  const pxPerFrame = width / frames;
  const logSpan = Math.log(fmax / fmin);

  // Each bitmap row covers a slice of the log-frequency axis. Rows land on
  // fractional bin positions and split linearly across the two neighbours, so
  // a drawn line keeps its true centre frequency instead of snapping to
  // whichever bin happens to sit below it.
  const binPos = new Float32Array(height);
  const tilt = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    const fTop = fmax * Math.exp(-logSpan * (y / height));
    const fBot = fmax * Math.exp(-logSpan * ((y + 1) / height));
    const fMid = (fTop + fBot) * 0.5;
    binPos[y] = clamp((fMid * N) / SR, 1, HALF - 1);
    tilt[y] = Math.pow(fMid / 620, 0.16);
  }

  const mags = new Float32Array(frames * bins);

  for (let t = 0; t < frames; t++) {
    const c0 = Math.max(0, Math.floor(t * pxPerFrame));
    const c1 = Math.min(width - 1, Math.max(c0, Math.ceil((t + 1) * pxPerFrame) - 1));
    const cols = c1 - c0 + 1;
    const base = t * bins;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      for (let x = c0; x <= c1; x++) {
        const i = (row + x) << 2;
        sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
      }
      const v = (sum / (cols * 765)) * tilt[y];
      if (v > 0.0018) {
        const p = binPos[y];
        const k0 = p | 0;
        const frac = p - k0;
        const a0 = v * (1 - frac);
        const a1 = v * frac;
        if (a0 > mags[base + k0]) mags[base + k0] = a0;
        if (a1 > mags[base + k0 + 1]) mags[base + k0 + 1] = a1;
      }
    }
    if ((t & 127) === 0) await onProgress((t / frames) * 0.45);
  }

  // ---- overlap-add resynthesis -------------------------------------------------
  const pad = Math.ceil(N / HOP) + 1;
  const total = frames + pad * 2;
  const span = total * HOP;
  const acc = new Float32Array(span);
  const wsum = new Float32Array(span);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  for (let p = 0; p < total; p++) {
    // Edge frames repeat the first/last column so the crop is already at full
    // level, then a short fade hides the seam.
    const t = clamp(p - pad, 0, frames - 1);
    const base = t * bins;
    re.fill(0); im.fill(0);
    for (let b = 1; b < HALF; b++) {
      const a = mags[base + b];
      if (a === 0) continue;
      const q = (b * p) % STEPS;
      const cr = a * PCOS[q], ci = a * PSIN[q];
      re[b] = cr; im[b] = ci;
      re[N - b] = cr; im[N - b] = -ci;
    }
    ifft(re, im);
    const off = p * HOP;
    const inv = 1 / N;
    for (let i = 0; i < N; i++) {
      const w = WIN[i];
      acc[off + i] += re[i] * inv * w;
      wsum[off + i] += w;
    }
    if ((p & 127) === 0) await onProgress(0.45 + (p / total) * 0.45);
  }

  const start = pad * HOP;
  const len = frames * HOP;
  let sig = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const w = wsum[start + i];
    sig[i] = w > 1e-4 ? acc[start + i] / w : 0;
  }

  // DC blocker (one pole) so the bass doesn't wander.
  let px = 0, py = 0;
  const r = 0.9995;
  for (let i = 0; i < len; i++) {
    const x = sig[i];
    const y = x - px + r * py;
    sig[i] = y; px = x; py = y;
  }

  if (wet > 0) sig = room(sig, SR, wet);

  const fade = Math.min(len >> 1, Math.round(SR * 0.012));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    sig[i] *= g;
    sig[len - 1 - i] *= g;
  }

  let peak = 0;
  for (let i = 0; i < len; i++) { const a = Math.abs(sig[i]); if (a > peak) peak = a; }
  if (peak > 1e-7) {
    const g = 0.92 / peak;
    for (let i = 0; i < len; i++) sig[i] *= g;
  }

  await onProgress(1);
  return { samples: sig, sampleRate: SR };
}

/* ----------------------------------------------------------------- wav ---- */

export function encodeWav(samples, sampleRate = SR) {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, n * 2, true);

  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return buffer;
}
