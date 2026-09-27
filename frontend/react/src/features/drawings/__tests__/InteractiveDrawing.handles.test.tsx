/**
 * ADR 0333 grade pass — screen-constant selection handles, verified through a
 * REAL render (not just the pure `screenConstant` math). Mounts InteractiveDrawing
 * with one shape selected, drives the actual ViewportSurface zoom chrome, and
 * asserts the handle geometry + the `--hz` stroke-width var scale INVERSELY with
 * zoom (a handle that stays a constant on-screen size). This is the automated
 * stand-in for the runtime light+dark click-through (jsdom lacks getScreenCTM, so
 * the selectionBounds/CTM path is inert — but the handle overlay sizes off pure
 * doc-space bbox geometry, which renders fine).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { InteractiveDrawing } from '../InteractiveDrawing.js';
import type { DrawingDoc } from '../definition.js';

afterEach(cleanup);

const DOC = { shapes: [{ kind: 'rect', x: 40, y: 40, width: 120, height: 80 }], width: 360, height: 360 } as unknown as DrawingDoc;

function mountWithSelection(): void {
  render(
    <InteractiveDrawing
      doc={DOC}
      selection={{ col: 'shapes', idx: 0 }}
      selectedIndices={() => [0]}
      onSelect={() => {}}
      onClearSelection={() => {}}
      onSetSelection={() => {}}
      patchElement={() => {}}
      patchElements={() => {}}
      deleteElements={() => 0}
    />,
  );
}

const handleWidth = (): number => Number(document.querySelector('.cv-draw-interactive__handle')?.getAttribute('width') ?? '0');
const hzVar = (): string => (document.querySelector('.cv-draw-interactive__svg') as HTMLElement | null)?.style.getPropertyValue('--hz').trim() ?? '';
// Chrome order (ViewportSurface): [zoomOut, reset%, zoomIn, zoomToSelection].
const zoomButtons = (): HTMLButtonElement[] => Array.from(document.querySelectorAll('.cv-viewport__chrome button')) as HTMLButtonElement[];

describe('screen-constant selection handles (real render)', () => {
  it('the handle overlay renders for a single selection at zoom 1 (baseline == unit)', () => {
    mountWithSelection();
    // unit = max(360,360)/90 = 4; handle width = hz*2 = (unit/1)*2 = 8 at zoom 1.
    expect(handleWidth()).toBeCloseTo(8, 5);
    expect(hzVar()).toBe('1'); // no scaling until zoomed
  });

  it('zooming IN shrinks the handle geometry + --hz (so it stays screen-constant)', () => {
    mountWithSelection();
    const w0 = handleWidth();
    fireEvent.click(zoomButtons()[2]!); // zoom in
    const w1 = handleWidth();
    expect(w1).toBeLessThan(w0);            // doc-space handle shrinks as zoom rises
    expect(Number(hzVar())).toBeLessThan(1); // stroke-width multiplier shrinks in lockstep
    fireEvent.click(zoomButtons()[2]!); // zoom in again
    expect(handleWidth()).toBeLessThan(w1); // monotonic
  });

  it('zooming OUT grows the handle geometry above the baseline', () => {
    mountWithSelection();
    const w0 = handleWidth();
    fireEvent.click(zoomButtons()[0]!); // zoom out
    expect(handleWidth()).toBeGreaterThan(w0);
    expect(Number(hzVar())).toBeGreaterThan(1);
  });

  it('the on-screen size is invariant: handle geometry × zoom stays ≈ the baseline', () => {
    mountWithSelection();
    const base = handleWidth(); // at zoom 1
    // Read the percent chrome to recover the zoom factor, then check hz·zoom == unit·2.
    fireEvent.click(zoomButtons()[2]!);
    const pct = Number((zoomButtons()[1]!.textContent ?? '').replace('%', ''));
    const zoom = pct / 100;
    expect(handleWidth() * zoom).toBeCloseTo(base, 2); // constant screen size
  });
});
