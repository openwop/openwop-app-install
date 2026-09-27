/**
 * GRADING PROBE — "Drawings" (FEATURES.md ordinal 227, ADR 0333). Evidence only.
 * GREEN + CI-safe. Exercises the closed-world drawing validator `validateDrawingDoc`
 * (the SSoT mirror of the `canvas.drawing` artifact schema) directly — the gate that
 * makes the AI drawing agent's output honest (invalid = typed error, never
 * success-with-a-fabricated-shape), PLUS the two security-hardening checks that make
 * an UNTRUSTED (model- or user-authored) drawing safe to render.
 *
 * DRP-1 (closed-world reject): an unknown shape kind, an unknown shape field, and an
 *     unknown top-level field are all rejected (closed enum + additionalProperties:false
 *     mirror) — a catalog-violating write cannot reach durable state.
 * DRP-2 (SECURITY — no external image URL): `image.src` must be a HOST media-asset
 *     serve path; an external URL is rejected (the CODE-D4 read-receipt-beacon /
 *     SSRF-exfil class), a host asset path is accepted.
 * DRP-3 (SECURITY — safe-color paint grammar): a paint field (`fill`/`stroke`/`color`)
 *     carrying a CSS-injection value (`url(...)`) is rejected; a safe color is accepted.
 * DRP-4 (positive control): a well-formed drawing validates clean.
 */
import { describe, it, expect } from 'vitest';
import { validateDrawingDoc } from '../src/features/drawings/validateDrawingDoc.js';

const draw = (shapes: unknown[], extra: Record<string, unknown> = {}) =>
  ({ title: 'probe', width: 100, height: 100, shapes, ...extra });

describe('ADR 0333 drawing validator — closed-world + untrusted-content hardening (by execution)', () => {
  it('DRP-1: closed-world rejects unknown shape kind / unknown shape field / unknown top-level field', () => {
    expect(validateDrawingDoc(draw([{ kind: 'hyperbolic-manifold' }])).errors.length).toBeGreaterThan(0);
    expect(validateDrawingDoc(draw([{ kind: 'rect', bogusField: 1 }])).errors.length).toBeGreaterThan(0);
    expect(validateDrawingDoc(draw([{ kind: 'rect' }], { rogueTopLevel: true })).errors.length).toBeGreaterThan(0);
  });

  it('DRP-2 (security): image.src must be a host asset path — an external URL is rejected', () => {
    expect(validateDrawingDoc(draw([{ kind: 'image', src: 'https://evil.example/beacon.png' }])).errors.length)
      .toBeGreaterThan(0);
    // A real host media-asset serve path is accepted.
    expect(validateDrawingDoc(draw([{ kind: 'image', src: '/v1/host/openwop-app/assets/abc123XYZ_-' }])).errors)
      .toEqual([]);
  });

  it('DRP-3 (security): a paint field with a CSS-injection value is rejected; a safe color is accepted', () => {
    expect(validateDrawingDoc(draw([{ kind: 'rect', fill: 'url(https://evil.example/x)' }])).errors.length)
      .toBeGreaterThan(0);
    expect(validateDrawingDoc(draw([{ kind: 'rect', fill: '#ff0000', stroke: 'rgb(0,0,0)' }])).errors).toEqual([]);
  });

  it('DRP-4 (control): a well-formed drawing validates clean', () => {
    expect(validateDrawingDoc(draw([{ kind: 'rect', x: 0, y: 0, width: 10, height: 10, fill: '#00ff00' }])).errors)
      .toEqual([]);
  });
});
