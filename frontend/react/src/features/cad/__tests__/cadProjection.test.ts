/**
 * ADR 0317 — the CAD projection extracted from the renderer (shared by the
 * read-only view and the direct-manipulation overlay). Pins the footprint per
 * kind and the auto-fit transform's invariants so the two layers can never drift.
 */
import { describe, it, expect } from 'vitest';
import { cadFootprint, cadProjection, CAD_W, CAD_H, CAD_PAD } from '../../../chat/artifacts/CadPreview.js';
import { rotatePoint, cadRotatePatch, solidCenter, cadResizeHandles, cadResizePatch } from '../cadGeometry.js';

describe('cadFootprint', () => {
  it('is the box footprint', () => {
    expect(cadFootprint({ kind: 'box', x: 5, y: 6, width: 40, height: 30 })).toEqual({ x: 5, y: 6, w: 40, h: 30 });
  });
  it('wraps a sphere in its diameter', () => {
    expect(cadFootprint({ kind: 'sphere', x: 0, y: 0, radius: 10 })).toEqual({ x: 0, y: 0, w: 20, h: 20 });
  });
  it('uses radius×2 by length for a cylinder/cone', () => {
    expect(cadFootprint({ kind: 'cylinder', x: 1, y: 2, radius: 5, length: 40 })).toEqual({ x: 1, y: 2, w: 10, h: 40 });
  });
});

describe('cadProjection', () => {
  it('fits the content within the padded frame and flips model-y to screen-y', () => {
    const solids = [{ kind: 'box', x: 0, y: 0, width: 100, height: 100 }];
    const { sx, sy, scale } = cadProjection(solids);
    // A 100-unit span fits the smaller padded axis (H is the tighter one).
    expect(scale).toBeCloseTo((CAD_H - 2 * CAD_PAD) / 100, 5);
    // min corner maps to the left pad / bottom (y is up in model, down on screen).
    expect(sx(0)).toBeCloseTo(CAD_PAD, 5);
    expect(sy(0)).toBeCloseTo(CAD_H - CAD_PAD, 5);
    // a higher model-y projects HIGHER on screen (smaller screen y).
    expect(sy(100)).toBeLessThan(sy(0));
  });

  it('exposes the fixed viewBox dimensions', () => {
    expect(CAD_W).toBe(360);
    expect(CAD_H).toBe(240);
  });

  it('returns a finite identity projection for empty input (no NaN from Math.min([]))', () => {
    const { sx, sy, scale } = cadProjection([]);
    expect(Number.isFinite(scale)).toBe(true);
    expect(Number.isFinite(sx(0))).toBe(true);
    expect(Number.isFinite(sy(0))).toBe(true);
  });
});

describe('cadGeometry — the gizmo math (ADR 0317)', () => {
  it('rotatePoint rotates about a centre (90° clockwise on screen)', () => {
    const p = rotatePoint(10, 0, 0, 0, 90); // (10,0) → (0,10) clockwise on screen
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(10, 6);
  });

  it('cadRotatePatch: knob straight up = 0°, to the right = 90°', () => {
    expect(cadRotatePatch(100, 100, 100, 40).rotation).toBe(0); // pointer above centre
    expect(cadRotatePatch(100, 100, 160, 100).rotation).toBe(90); // pointer right of centre
    expect(cadRotatePatch(100, 100, 100, 160).rotation).toBe(180); // below
  });

  it('solidCenter matches the footprint centre per kind', () => {
    expect(solidCenter({ kind: 'box', x: 0, y: 0, width: 40, height: 30 })).toEqual({ x: 20, y: 15 });
    expect(solidCenter({ kind: 'sphere', x: 0, y: 0, radius: 10 })).toEqual({ x: 10, y: 10 });
    expect(solidCenter({ kind: 'cylinder', x: 0, y: 0, radius: 5, length: 40 })).toEqual({ x: 5, y: 20 });
  });

  it('cadResizeHandles exposes the right handles per kind', () => {
    expect(cadResizeHandles('box').map((h) => h.id)).toEqual(['w', 'h']);
    expect(cadResizeHandles('sphere').map((h) => h.id)).toEqual(['r']);
    expect(cadResizeHandles('cone').map((h) => h.id)).toEqual(['r', 'len']);
  });

  it('cadResizePatch is centre-preserving (dimension + anchor), clamped ≥ 1', () => {
    // box width 40 centred at x=20 → new width 60 keeps centre → x = 20-30 = -10.
    expect(cadResizePatch({ kind: 'box', x: 0, y: 0, width: 40, height: 30 }, 'w', 60)).toEqual({ width: 60, x: -10 });
    expect(cadResizePatch({ kind: 'box', x: 0, y: 0, width: 40, height: 30 }, 'h', 50)).toEqual({ height: 50, y: -10 });
    // sphere radius keeps the square footprint centred (x AND y re-anchored).
    expect(cadResizePatch({ kind: 'sphere', x: 0, y: 0, radius: 10 }, 'r', 20)).toEqual({ radius: 20, x: -10, y: -10 });
    // cylinder radius re-anchors x only; length re-anchors y.
    expect(cadResizePatch({ kind: 'cylinder', x: 0, y: 0, radius: 5, length: 40 }, 'r', 8)).toEqual({ radius: 8, x: -3 });
    expect(cadResizePatch({ kind: 'cylinder', x: 0, y: 0, radius: 5, length: 40 }, 'len', 60)).toEqual({ length: 60, y: -10 });
    // never collapses below 1.
    expect(cadResizePatch({ kind: 'box', x: 0, y: 0, width: 40, height: 30 }, 'w', 0)).toMatchObject({ width: 1 });
  });
});
