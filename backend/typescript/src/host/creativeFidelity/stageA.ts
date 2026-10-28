/**
 * ADR 0945 D3 stage A — deterministic fidelity checks over a masked region:
 * perceptual hashes (dHash, pHash; 64-bit, Hamming) on grayscale and the
 * CIEDE2000 distance between mean colours. Pure functions over RGBA grids; the
 * mask is the product's own silhouette (the cut-out's alpha), so the scene
 * around the product never counts.
 */
import { STAGE_A_RULES } from './rules.js';
import type { FidelityCheck } from './types.js';
import type { RgbaGrid } from './raster.js';

const NEUTRAL = 128;

/** Interior cells: source alpha ≥ the rule, minus the slot's rounded corners
 *  (the renderer clips them, so the composite shows scene there). */
export function productMask(source: RgbaGrid, slot: { w: number; h: number; radiusPx?: number }): boolean[] {
  const { w, h, data } = source;
  const mask: boolean[] = new Array(w * h).fill(false);
  const r = slot.radiusPx ?? 0;
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      if (data[(j * w + i) * 4 + 3] < STAGE_A_RULES.maskAlphaMin) continue;
      if (r > 0) {
        // Cell centre in slot coordinates; reject anything near a clipped corner.
        const cx = ((i + 0.5) / w) * slot.w;
        const cy = ((j + 0.5) / h) * slot.h;
        const margin = Math.max(slot.w / w, slot.h / h);
        const ox = cx < r ? r - cx : cx > slot.w - r ? cx - (slot.w - r) : 0;
        const oy = cy < r ? r - cy : cy > slot.h - r ? cy - (slot.h - r) : 0;
        if (ox > 0 && oy > 0 && Math.hypot(ox, oy) > r - margin) continue;
      }
      mask[j * w + i] = true;
    }
  }
  return mask;
}

function grayOf(g: RgbaGrid, mask: boolean[]): number[] {
  const out: number[] = new Array(g.w * g.h);
  for (let k = 0; k < g.w * g.h; k += 1) {
    out[k] = mask[k] ? 0.299 * g.data[k * 4] + 0.587 * g.data[k * 4 + 1] + 0.114 * g.data[k * 4 + 2] : NEUTRAL;
  }
  return out;
}

/** Area-average resample of a w×h scalar field to tw×th. */
function resample(v: number[], w: number, h: number, tw: number, th: number): number[] {
  const out: number[] = new Array(tw * th).fill(0);
  for (let j = 0; j < th; j += 1) {
    for (let i = 0; i < tw; i += 1) {
      const x0 = Math.floor((i * w) / tw), x1 = Math.max(x0 + 1, Math.floor(((i + 1) * w) / tw));
      const y0 = Math.floor((j * h) / th), y1 = Math.max(y0 + 1, Math.floor(((j + 1) * h) / th));
      let s = 0, n = 0;
      for (let y = y0; y < Math.min(y1, h); y += 1) for (let x = x0; x < Math.min(x1, w); x += 1) { s += v[y * w + x]; n += 1; }
      out[j * tw + i] = n > 0 ? s / n : NEUTRAL;
    }
  }
  return out;
}

/** dHash: 9×8 gradient signs → 64 bits. */
export function dHash(gray: number[], w: number, h: number): boolean[] {
  const s = resample(gray, w, h, 9, 8);
  const bits: boolean[] = [];
  for (let j = 0; j < 8; j += 1) for (let i = 0; i < 8; i += 1) bits.push(s[j * 9 + i] < s[j * 9 + i + 1]);
  return bits;
}

/** pHash: 32×32 DCT-II, the low 8×8 block against its median (DC excluded from the median). */
export function pHash(gray: number[], w: number, h: number): boolean[] {
  const N = 32;
  const s = resample(gray, w, h, N, N);
  const cos: number[][] = [];
  for (let u = 0; u < 8; u += 1) { cos.push([]); for (let x = 0; x < N; x += 1) cos[u].push(Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))); }
  const coeffs: number[] = [];
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) sum += s[y * N + x] * cos[u][x] * cos[v][y];
      coeffs.push(sum);
    }
  }
  const median = [...coeffs.slice(1)].sort((a, b) => a - b)[31];
  return coeffs.map((c) => c > median);
}

export function hamming(a: boolean[], b: boolean[]): number {
  let d = 0;
  for (let k = 0; k < a.length; k += 1) if (a[k] !== b[k]) d += 1;
  return d;
}

/** sRGB (0–255) → CIE L*a*b* (D65). */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number): number => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 (Sharma, Wu & Dalal 2005). */
export function deltaE2000(a: [number, number, number], b: [number, number, number]): number {
  const [L1, a1, b1] = a, [L2, a2, b2] = b;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (x: number, y: number): number => { if (x === 0 && y === 0) return 0; const h = Math.atan2(y, x) / rad; return h >= 0 ? h : h + 360; };
  const h1p = hp(a1p, b1), h2p = hp(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) { hbp = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2 : (h1p + h2p) / 2; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

function meanLab(g: RgbaGrid, mask: boolean[]): [number, number, number] {
  let r = 0, gg = 0, b = 0, n = 0;
  for (let k = 0; k < mask.length; k += 1) if (mask[k]) { r += g.data[k * 4]; gg += g.data[k * 4 + 1]; b += g.data[k * 4 + 2]; n += 1; }
  return rgbToLab(r / n, gg / n, b / n);
}

/** Run stage A over a masked region. Returns the checks; a too-small mask is
 *  a single `fail` (an unjudgeable region is never a pass). */
export function runStageA(source: RgbaGrid, candidate: RgbaGrid, mask: boolean[]): FidelityCheck[] {
  const cells = mask.filter(Boolean).length;
  if (cells < STAGE_A_RULES.minMaskCells) {
    return [{ id: 'dhash', status: 'fail', value: cells, threshold: STAGE_A_RULES.minMaskCells, detail: `The product region covers ${cells} sampled cells — too few to judge.` }];
  }
  const sg = grayOf(source, mask), cg = grayOf(candidate, mask);
  const dh = hamming(dHash(sg, source.w, source.h), dHash(cg, candidate.w, candidate.h));
  const ph = hamming(pHash(sg, source.w, source.h), pHash(cg, candidate.w, candidate.h));
  const de = deltaE2000(meanLab(source, mask), meanLab(candidate, mask));
  const round = (v: number): number => Math.round(v * 100) / 100;
  return [
    { id: 'dhash', status: dh <= STAGE_A_RULES.dhashMax ? 'pass' : 'fail', value: dh, threshold: STAGE_A_RULES.dhashMax, detail: 'Gradient hash distance over the product silhouette.' },
    { id: 'phash', status: ph <= STAGE_A_RULES.phashMax ? 'pass' : 'fail', value: ph, threshold: STAGE_A_RULES.phashMax, detail: 'DCT hash distance over the product silhouette.' },
    { id: 'colour_delta_e', status: de <= STAGE_A_RULES.deltaEMax ? 'pass' : 'fail', value: round(de), threshold: STAGE_A_RULES.deltaEMax, detail: 'CIEDE2000 between the mean colours of the product in the source and in the result.' },
  ];
}
