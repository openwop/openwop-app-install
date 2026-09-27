/**
 * Solstice Roasters brand imagery — declarative draw-specs rendered to PNG bytes
 * by {@link renderMediaPng} at seed time (not at import, so there is no
 * process-start cost). Every asset the demo-media seeder stores is produced here
 * from the shared palette, so the whole library reads as one brand.
 */
import { Canvas } from './pngCanvas.js';
import { SOLSTICE_PALETTE as P } from '../solsticeDemo.js';

export type Silhouette = 'bag' | 'mug' | 'box' | 'bottle' | 'grid' | 'beans' | 'grinder' | 'cup';

export type MediaSpec =
  | { kind: 'product'; silhouette: Silhouette; hue: string; accent: string }
  | { kind: 'brand'; variant: 'mark' | 'wordmark' | 'pattern' }
  | { kind: 'blog'; hue: string };

const CREAM = P.cream;

function drawSilhouette(c: Canvas, s: Silhouette, accent: string): void {
  const cx = c.width / 2;
  switch (s) {
    case 'bag':
      c.roundRect(cx - 52, 52, 104, 156, 16, CREAM);
      c.rect(cx - 52, 52, 104, 20, accent);
      c.disc(cx, 132, 30, accent, 90);
      c.ring(cx, 132, 30, 4, accent);
      break;
    case 'mug':
      c.roundRect(cx - 46, 92, 84, 96, 12, CREAM);
      c.ring(cx + 52, 138, 26, 9, CREAM);
      c.rect(cx - 46, 92, 84, 16, accent);
      break;
    case 'box':
      c.roundRect(cx - 58, 96, 116, 96, 8, CREAM);
      c.rect(cx - 58, 96, 116, 22, accent);
      c.rect(cx - 6, 96, 12, 96, accent, 60);
      break;
    case 'bottle':
      c.rect(cx - 12, 56, 24, 22, accent);
      c.roundRect(cx - 30, 78, 60, 132, 16, CREAM);
      c.disc(cx, 140, 20, accent, 80);
      break;
    case 'grid':
      for (let i = 0; i < 4; i += 1) {
        const gx = cx - 54 + (i % 2) * 60, gy = 78 + Math.floor(i / 2) * 60;
        c.roundRect(gx, gy, 48, 48, 8, CREAM);
        c.rect(gx, gy, 48, 10, accent);
      }
      break;
    case 'beans':
      for (const [dx, dy] of [[-30, -18], [24, -22], [-10, 20], [34, 24], [4, -4]] as const) {
        c.disc(cx + dx, 132 + dy, 22, CREAM);
        c.rect(cx + dx - 2, 132 + dy - 20, 4, 40, accent, 70);
      }
      break;
    case 'grinder':
      c.roundRect(cx - 40, 96, 80, 96, 10, CREAM);
      c.disc(cx, 84, 16, CREAM);
      c.rect(cx - 4, 60, 8, 30, accent);
      c.rect(cx - 40, 150, 80, 8, accent);
      break;
    case 'cup':
      c.roundRect(cx - 40, 84, 80, 116, 10, CREAM);
      c.rect(cx - 40, 84, 80, 18, accent);
      c.disc(cx, 150, 22, accent, 55);
      break;
  }
}

function drawSun(c: Canvas, hex: string): void {
  const cx = c.width / 2, cy = c.height * 0.44;
  c.ring(cx, cy, 46, 6, hex);
  for (let i = 0; i < 12; i += 1) {
    const a = (i * Math.PI) / 6;
    const x = Math.round(cx + Math.cos(a) * 66), y = Math.round(cy + Math.sin(a) * 66);
    c.disc(x, y, 4, hex);
  }
}

/** Render a spec to base64 PNG bytes + its content type. */
export function renderMediaPng(spec: MediaSpec): { contentBase64: string; contentType: 'image/png' } {
  let c: Canvas;
  if (spec.kind === 'product') {
    c = new Canvas(256, 256);
    c.fill(spec.hue);
    drawSilhouette(c, spec.silhouette, spec.accent);
  } else if (spec.kind === 'brand') {
    c = new Canvas(256, 256);
    if (spec.variant === 'pattern') {
      c.fill(P.espresso);
      for (let i = 0; i < 25; i += 1) {
        const x = 26 + (i % 5) * 51, y = 26 + Math.floor(i / 5) * 51;
        c.disc(x, y, 8, P.caramel, 130);
        c.rect(x - 1, y - 12, 2, 24, P.clay, 110);
      }
    } else {
      c.fill(P.espresso);
      drawSun(c, P.caramel);
      if (spec.variant === 'wordmark') c.rect(48, 196, 160, 6, P.caramel);
    }
  } else {
    c = new Canvas(512, 288);
    c.gradientV(spec.hue, P.ink);
    c.rect(40, 210, 180, 8, P.caramel);
    c.rect(40, 232, 120, 6, CREAM);
  }
  const { contentBase64, contentType } = { contentBase64: c.toBase64Png(), contentType: 'image/png' as const };
  return { contentBase64, contentType };
}
