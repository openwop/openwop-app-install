/**
 * DRU-3 — the resize/rotate/vertex handles are pointer-only (`onPointerDown`,
 * no keyboard). The numeric properties panel IS the keyboard-equivalent for those
 * operations, but nothing told an assistive-tech user that — the substitute was
 * not discoverable AS the equivalent.
 *
 * Mirror the Cad3dView precedent (`aria-describedby` → an `sr-only` hint via
 * `useId`): when a single shape is selected (i.e. when the pointer-only handles
 * render), the canvas `role="img"` gains a description pointing to the panel path.
 * This closes the discoverability gap for browse-mode SR users; the live
 * end-to-end SR pass stays CT-DRU-3 (no headless SR here).
 *
 * Born-red: before the wiring, the SVG has no `aria-describedby`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { InteractiveDrawing } from '../InteractiveDrawing.js';
import type { DrawingDoc } from '../definition.js';
import { messages as en } from '../i18n/en.js';

afterEach(cleanup);

const DOC: DrawingDoc = {
  title: 'Scene',
  shapes: [{ kind: 'rect', x: 40, y: 40, width: 120, height: 80 }, { kind: 'circle', cx: 260, cy: 120, r: 40 }],
  width: 360,
  height: 360,
};

type Props = Parameters<typeof InteractiveDrawing>[0];
const props = (idxs: number[]): Props => ({
  doc: DOC,
  selection: idxs[0] !== undefined ? { col: 'shapes', idx: idxs[0] } : null,
  selectedIndices: () => idxs,
  onSelect: () => {},
  onClearSelection: () => {},
  onSetSelection: () => {},
  patchElement: () => {},
  patchElements: () => {},
  deleteElements: () => 0,
});

const svg = (): SVGSVGElement | null => document.querySelector('.cv-draw-interactive__svg');

describe('DRU-3 — the canvas points AT users to the keyboard resize/rotate path', () => {
  it('when a shape is selected, the canvas is described by a hint naming the properties panel', () => {
    render(<InteractiveDrawing {...props([0])} />);
    const describedBy = svg()?.getAttribute('aria-describedby');
    expect(describedBy, 'the SVG has no aria-describedby while a shape is selected').toBeTruthy();
    const hint = document.getElementById(describedBy!);
    expect(hint?.textContent).toBe(en.resizeHint);
    expect(en.resizeHint).toMatch(/properties panel/i);
    // The hint is SR-only (not visual clutter for sighted users).
    expect(hint?.className).toContain('sr-only');
  });

  it('says nothing extra when nothing is selected (no handles → no resize hint)', () => {
    render(<InteractiveDrawing {...props([])} />);
    expect(svg()).not.toBeNull();
    expect(svg()?.getAttribute('aria-describedby')).toBeNull();
  });

  it('says nothing extra for a MULTI-selection (the single-shape handles are not shown)', () => {
    render(<InteractiveDrawing {...props([0, 1])} />);
    expect(svg()).not.toBeNull();
    expect(svg()?.getAttribute('aria-describedby')).toBeNull();
  });
});
