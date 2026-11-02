/**
 * ADR 0333 — the closed-world drawing validator `validateDrawingDoc` (the SSoT
 * mirror of the `canvas.drawing` artifact schema) and its two untrusted-content
 * hardening rules (grade pass CODE-D4). TST-CWC-4.
 *
 * This gate is what makes the AI drawing agent's output honest (invalid = a typed
 * error, never success-with-a-fabricated-shape) and an UNTRUSTED (model- or
 * user-authored) drawing safe to render. Each rejection is asserted as the WHOLE
 * `errors` array, so a different (or an extra) error cannot stand in for it.
 *
 * Renamed from `dr-grade-probe.test.ts` (a grading-pass probe, wave 69); the
 * cases are the same four. DRP-3 is also exercised end-to-end through the agent
 * tool in drawings-agent-tools.test.ts; DRP-1 and DRP-2 are covered only here.
 *
 * Red when (sabotage-witnessed, wave 69):
 *  - DRP-1: the shape-kind enum check, the unknown-shape-field error, or the
 *    unknown-top-level-field error is removed;
 *  - DRP-2: `image.src` stops requiring a host media-asset serve path (an
 *    external URL is a per-viewer read-receipt beacon / SSRF-exfil vector);
 *  - DRP-3: a paint field stops being checked against the safe-color grammar
 *    (`url(...)` in an SVG paint triggers a cross-origin fetch on render).
 */
import { describe, it, expect } from 'vitest';
import { validateDrawingDoc } from '../src/features/drawings/validateDrawingDoc.js';

const draw = (shapes: unknown[], extra: Record<string, unknown> = {}) =>
  ({ title: 'probe', width: 100, height: 100, shapes, ...extra });

describe('ADR 0333 drawing validator — closed-world + untrusted-content hardening (by execution)', () => {
  it('DRP-1: closed-world rejects unknown shape kind / unknown shape field / unknown top-level field', () => {
    expect(validateDrawingDoc(draw([{ kind: 'hyperbolic-manifold' }])).errors).toEqual([
      { path: 'shapes[0].kind', message: 'kind must be one of: rect, circle, ellipse, line, polyline, polygon, text, stroke, arrow, image' },
    ]);
    expect(validateDrawingDoc(draw([{ kind: 'rect', bogusField: 1 }])).errors).toEqual([
      { path: 'shapes[0].bogusField', message: "unknown shape field 'bogusField'" },
    ]);
    expect(validateDrawingDoc(draw([{ kind: 'rect' }], { rogueTopLevel: true })).errors).toEqual([
      { path: 'rogueTopLevel', message: "unknown drawing field 'rogueTopLevel'" },
    ]);
  });

  it('DRP-2 (security): image.src must be a host asset path — an external URL is rejected', () => {
    expect(validateDrawingDoc(draw([{ kind: 'image', src: 'https://evil.example/beacon.png' }])).errors).toEqual([
      { path: 'shapes[0].src', message: 'src must be a host media-asset serve path (/host/openwop-app/assets/<token>) — external URLs are not allowed' },
    ]);
    // A real host media-asset serve path is accepted.
    expect(validateDrawingDoc(draw([{ kind: 'image', src: '/host/openwop-app/assets/abc123XYZ_-' }])).errors)
      .toEqual([]);
  });

  it('DRP-3 (security): a paint field with a CSS-injection value is rejected; a safe color is accepted', () => {
    expect(validateDrawingDoc(draw([{ kind: 'rect', fill: 'url(https://evil.example/x)' }])).errors).toEqual([
      { path: 'shapes[0].fill', message: 'fill must be a safe color (hex, rgb/hsl/oklch, keyword, currentColor, none)' },
    ]);
    expect(validateDrawingDoc(draw([{ kind: 'rect', fill: '#ff0000', stroke: 'rgb(0,0,0)' }])).errors).toEqual([]);
  });

  it('DRP-4 (control): a well-formed drawing validates clean', () => {
    expect(validateDrawingDoc(draw([{ kind: 'rect', x: 0, y: 0, width: 10, height: 10, fill: '#00ff00' }])).errors)
      .toEqual([]);
  });
});
