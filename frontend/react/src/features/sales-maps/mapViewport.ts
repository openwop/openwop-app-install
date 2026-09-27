/**
 * Sales Maps — pure viewport (zoom/pan) math for the SVG map (ADR 0282 P5).
 *
 * The map zooms by narrowing the SVG viewBox: a viewport is a scale (1 = whole
 * world) + a centre in world units (the MAP_W×MAP_H space every geometry projects
 * into). Pure functions so the wheel/drag/button handlers in MapView stay thin
 * and the clamping/anchor math is unit-tested.
 */
import { MAP_W, MAP_H } from './projection.js';

export interface MapViewport { scale: number; cx: number; cy: number }

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;

export const HOME_VIEWPORT: MapViewport = { scale: 1, cx: MAP_W / 2, cy: MAP_H / 2 };

/** Clamp scale to [MIN,MAX] and the centre so the viewBox never leaves the world. */
export function clampViewport(v: MapViewport): MapViewport {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale));
  const halfW = MAP_W / scale / 2;
  const halfH = MAP_H / scale / 2;
  return {
    scale,
    cx: Math.min(MAP_W - halfW, Math.max(halfW, v.cx)),
    cy: Math.min(MAP_H - halfH, Math.max(halfH, v.cy)),
  };
}

/** The `viewBox` attribute string for a viewport. */
export function viewBoxOf(v: MapViewport): string {
  const w = MAP_W / v.scale;
  const h = MAP_H / v.scale;
  return `${v.cx - w / 2} ${v.cy - h / 2} ${w} ${h}`;
}

/**
 * Zoom to `newScale` keeping the world point under the screen fraction (fx, fy)
 * fixed — fx/fy ∈ [0,1] across the rendered map (0,0 = top-left). This is what
 * makes wheel/double-click zoom feel anchored to the cursor.
 */
export function zoomAtPoint(v: MapViewport, fx: number, fy: number, newScale: number): MapViewport {
  const w = MAP_W / v.scale;
  const h = MAP_H / v.scale;
  const px = v.cx - w / 2 + fx * w;
  const py = v.cy - h / 2 + fy * h;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
  const w2 = MAP_W / scale;
  const h2 = MAP_H / scale;
  return clampViewport({ scale, cx: px + w2 * (0.5 - fx), cy: py + h2 * (0.5 - fy) });
}

/** Pan by a screen-pixel delta, given the rendered map width in pixels. */
export function panByPixels(v: MapViewport, dxPx: number, dyPx: number, renderedWidthPx: number): MapViewport {
  const unitsPerPx = MAP_W / v.scale / renderedWidthPx;
  return clampViewport({ scale: v.scale, cx: v.cx - dxPx * unitsPerPx, cy: v.cy - dyPx * unitsPerPx });
}
