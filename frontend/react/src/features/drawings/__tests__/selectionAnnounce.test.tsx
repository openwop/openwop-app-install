/**
 * DRU-2 — canvas SELECTION must be announced to assistive tech.
 *
 * The drawing SVG is a single `role="img"` with one static aria-label, so a
 * screen-reader user perceives nothing about WHICH shape is selected or when the
 * selection changes — the canvas is opaque beyond the side shape-list. This wires
 * the ADR 0363 imperative live region (`announce`) so a selection change speaks
 * the shape ("Rectangle selected") or the count ("2 selected"), reusing the
 * existing `kind_*` / `nSelected` labels + a new `shapeSelected` template.
 *
 * Born-red: before the wiring, `announce` is never called on selection change.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { DrawingDoc } from '../definition.js';

const announce = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/announce.js', () => ({
  announce,
  GlobalLiveRegion: () => null,
}));

const { InteractiveDrawing } = await import('../InteractiveDrawing.js');

const DOC = {
  shapes: [
    { kind: 'rect', x: 40, y: 40, width: 120, height: 80 },
    { kind: 'circle', cx: 260, cy: 120, r: 40 },
  ],
  width: 360,
  height: 360,
} as unknown as DrawingDoc;

type Props = Parameters<typeof InteractiveDrawing>[0];
const props = (idxs: number[]): Props =>
  ({
    doc: DOC,
    selection: idxs.length ? { col: 'shapes', idx: idxs[0] } : null,
    selectedIndices: () => idxs,
    onSelect: () => {},
    onClearSelection: () => {},
    onSetSelection: () => {},
    patchElement: () => {},
    patchElements: () => {},
    deleteElements: () => 0,
  }) as unknown as Props;

beforeEach(() => announce.mockClear());
afterEach(cleanup);

describe('DRU-2 — selection is announced to assistive tech', () => {
  it('says nothing while nothing is selected (no noise on an empty canvas)', () => {
    render(<InteractiveDrawing {...props([])} />);
    expect(announce).not.toHaveBeenCalled();
  });

  it('announces the shape KIND when a single shape becomes selected', () => {
    const { rerender } = render(<InteractiveDrawing {...props([])} />);
    expect(announce).not.toHaveBeenCalled();
    rerender(<InteractiveDrawing {...props([0])} />);
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('Rectangle'));
  });

  it('announces the COUNT for a multi-selection', () => {
    const { rerender } = render(<InteractiveDrawing {...props([0])} />);
    announce.mockClear();
    rerender(<InteractiveDrawing {...props([0, 1])} />);
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('2'));
  });

  it('re-announces when the selection moves to a DIFFERENT shape of the same-or-other kind', () => {
    const { rerender } = render(<InteractiveDrawing {...props([0])} />);
    announce.mockClear();
    rerender(<InteractiveDrawing {...props([1])} />);
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('Circle'));
  });
});
