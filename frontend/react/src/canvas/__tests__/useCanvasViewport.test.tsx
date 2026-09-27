/**
 * useCanvasViewport — the ADR 0337 Phase 2c additions the GraphSurface adoption
 * relies on: `fitBounds` (canvas-space fit with a per-fit clamp) and the
 * `armsBackgroundPan` gate (plain-left-drag pans for no-marquee consumers). The
 * pointer/zoom GEOMETRY is proven in the pure `viewport.ts` suite (jsdom drops
 * pointer `button`/`pointerType`), so the pan gate is tested as a pure predicate.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCanvasViewport, armsBackgroundPan, isInteractiveTarget } from '../useCanvasViewport.js';

/** A detached div with a real measured geometry (jsdom returns 0 otherwise). */
function measuredDiv(w: number, h: number): HTMLDivElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  if (!el.setPointerCapture) el.setPointerCapture = () => undefined;
  return el;
}

describe('useCanvasViewport — fitBounds (ADR 0337 Phase 2c)', () => {
  it('frames canvas-space bounds and honors a per-fit clamp (the graph ≤1:1 pin)', () => {
    const { result } = renderHook(() => useCanvasViewport({ limits: { min: 0.25, max: 2.5 } }));
    const el = measuredDiv(1000, 800);
    act(() => { result.current.wrapperProps.ref(el); });
    // A tiny box would magnify to fill the surface, but the ≤1 fit clamp caps it
    // at 1:1 — exactly the graph's fit-all-nodes-never-past-100% behavior.
    act(() => { result.current.fitBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, { min: 0.25, max: 1 }); });
    expect(result.current.zoom).toBe(1);
    // Without the per-fit override, the interaction clamp lets it magnify past 1.
    act(() => { result.current.fitBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 }); });
    expect(result.current.zoom).toBeGreaterThan(1);
  });

  it('no-ops on an unmeasured surface and on zero-area bounds', () => {
    const { result } = renderHook(() => useCanvasViewport());
    // Never bound a ref → unmeasured → no change.
    act(() => { result.current.fitBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 }); });
    expect(result.current.zoom).toBe(1);
    const el = measuredDiv(1000, 800);
    act(() => { result.current.wrapperProps.ref(el); });
    act(() => { result.current.fitBounds({ minX: 50, minY: 50, maxX: 50, maxY: 50 }); }); // degenerate
    expect(result.current.zoom).toBe(1);
  });
});

describe('armsBackgroundPan gate (ADR 0337 Phase 2c)', () => {
  const base = { backgroundPan: true, button: 0, pointerType: 'mouse', spaceDown: false, panActive: false, target: null };

  it('arms on a plain primary-button non-touch down over empty canvas when opted in', () => {
    expect(armsBackgroundPan(base)).toBe(true);
    expect(armsBackgroundPan({ ...base, target: document.createElement('div') })).toBe(true);
  });

  it('never arms when the opt-in is off (marquee consumers keep plain left-drag)', () => {
    expect(armsBackgroundPan({ ...base, backgroundPan: false })).toBe(false);
  });

  it('ignores non-primary buttons, touch, Space-held, an in-flight pan, and interactive targets', () => {
    expect(armsBackgroundPan({ ...base, button: 1 })).toBe(false);        // middle → capture path owns it
    expect(armsBackgroundPan({ ...base, button: 2 })).toBe(false);        // right
    expect(armsBackgroundPan({ ...base, pointerType: 'touch' })).toBe(false); // pinch path owns touch
    expect(armsBackgroundPan({ ...base, spaceDown: true })).toBe(false);  // Space-pan owns it
    expect(armsBackgroundPan({ ...base, panActive: true })).toBe(false);  // already panning
    expect(armsBackgroundPan({ ...base, target: document.createElement('button') })).toBe(false); // chrome
    expect(armsBackgroundPan({ ...base, target: document.createElement('select') })).toBe(false); // device select
  });
});

describe('isInteractiveTarget — the chrome gate shared by pan-arm + graph deselect', () => {
  it('classifies form controls / buttons / links as interactive', () => {
    for (const tag of ['button', 'select', 'input', 'textarea', 'a']) {
      expect(isInteractiveTarget(document.createElement(tag))).toBe(true);
    }
  });

  it('treats the plain canvas background (div, role=group/region) as non-interactive', () => {
    expect(isInteractiveTarget(document.createElement('div'))).toBe(false);
    const group = document.createElement('div');
    group.setAttribute('role', 'group'); // the .cv-graph wrapper itself → deselect must still fire
    expect(isInteractiveTarget(group)).toBe(false);
    expect(isInteractiveTarget(null)).toBe(false);
  });

  it('honors Space-activated ARIA roles (a role=button div is interactive)', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'button');
    expect(isInteractiveTarget(el)).toBe(true);
  });
});
