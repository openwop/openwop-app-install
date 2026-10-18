/**
 * PeerSelectionOverlays (ADR 0359 residuals — the scene half of D5): a dashed
 * outline in the peer's hue + a name flag per peer, pointer-inert and hidden
 * from assistive tech. Breaks: a flag eating clicks or being announced, an
 * outline off its padded bbox, truncation keeping the full name, co-selection
 * flags occluding each other, top-edge flags clipped off-canvas, flag geometry
 * not following flagScale (or the outline wrongly scaling with it).
 *
 * Expected geometry is computed by hand from the module constants PAD=3,
 * FLAG_H=13, FLAG_GAP=2 — never by calling the renderer's math.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { PeerSelectionOverlays } from '../PeerSelectionOverlay.js';

const renderSvg = (node: JSX.Element) => render(<svg>{node}</svg>);

describe('PeerSelectionOverlays', () => {
  it('renders nothing for an empty peer set (solo path zero-delta)', () => {
    const { container } = renderSvg(<PeerSelectionOverlays outlines={[]} />);
    expect(container.querySelector('.cv-peer-outlines')).toBeNull();
  });

  it('renders a dashed hue outline + name flag per peer, pointer-inert and aria-hidden', () => {
    const { container } = renderSvg(
      <PeerSelectionOverlays outlines={[
        { x: 10, y: 20, w: 100, h: 50, name: 'Ana', color: '#3366aa' },
        { x: 200, y: 20, w: 40, h: 40, name: 'Bo', color: '#aa6633' },
      ]} />,
    );
    const g = container.querySelector('.cv-peer-outlines');
    expect(g?.getAttribute('aria-hidden')).toBe('true');
    expect(g?.getAttribute('pointer-events')).toBe('none');
    const rects = container.querySelectorAll('rect[stroke-dasharray]');
    expect(rects.length).toBe(2);
    expect(rects[0]?.getAttribute('stroke')).toBe('#3366aa');
    // bbox padded by 3 on every side: (10,20,100,50) → (7,17,106,56).
    expect(rects[0]?.getAttribute('x')).toBe('7');
    expect(rects[0]?.getAttribute('y')).toBe('17');
    expect(rects[0]?.getAttribute('width')).toBe('106');
    expect(rects[0]?.getAttribute('height')).toBe('56');
    const names = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(names).toEqual(['Ana', 'Bo']);
  });

  it('truncates long names with an ellipsis', () => {
    const { container } = renderSvg(
      <PeerSelectionOverlays outlines={[{ x: 0, y: 0, w: 10, h: 10, name: 'A very long collaborator name', color: '#123123' }]} />,
    );
    // MAX_NAME 18 → the first 17 characters plus the ellipsis.
    expect(container.querySelector('text')?.textContent).toBe('A very long colla…');
  });

  it('collision-stacks co-selection flags so BOTH names stay visible (UX finding 2)', () => {
    const { container } = renderSvg(
      <PeerSelectionOverlays outlines={[
        { x: 50, y: 60, w: 80, h: 40, name: 'Ana', color: '#333366' },
        { x: 50, y: 60, w: 80, h: 40, name: 'Bo', color: '#663333' },
      ]} />,
    );
    const flags = [...container.querySelectorAll('g[transform^="translate"]')]
      .filter((g) => g.querySelector('text'));
    expect(flags.length).toBe(2);
    const ys = flags.map((g) => Number(/translate\([^,]+,\s*([-\d.]+)\)/.exec(g.getAttribute('transform') ?? '')?.[1]));
    // First flag above the box: 60 − 3 − 13 − 2 = 42; the second shifts one
    // flag + gap down (42 + 15 = 57) — stacked, not occluding.
    expect(ys).toEqual([42, 57]);
  });

  it('flips the flag BELOW the box when the element sits at the top edge (UX finding 3)', () => {
    const { container } = renderSvg(
      <PeerSelectionOverlays outlines={[{ x: 10, y: 4, w: 30, h: 20, name: 'Ana', color: '#333366' }]} />,
    );
    const flag = [...container.querySelectorAll('g[transform^="translate"]')].find((g) => g.querySelector('text'));
    const y = Number(/translate\([^,]+,\s*([-\d.]+)\)/.exec(flag?.getAttribute('transform') ?? '')?.[1]);
    // Above would be 4 − 3 − 13 − 2 = −14 (clipped) → flipped below: 4 + 20 + 3 + 2.
    expect(y).toBe(29);
  });

  it('scales flag geometry by flagScale while the outline stays scene-space (UX finding 4)', () => {
    const { container } = renderSvg(
      <PeerSelectionOverlays flagScale={2} outlines={[{ x: 100, y: 100, w: 30, h: 20, name: 'Ana', color: '#333366' }]} />,
    );
    const flag = [...container.querySelectorAll('g[transform^="translate"]')].find((g) => g.querySelector('text'));
    // Flag geometry scales: fh = 26, gap = 4 → y = 100 − 3 − 26 − 4 = 67.
    expect(flag?.getAttribute('transform')).toBe('translate(97, 67) scale(2)');
    // The outline stays in scene units (30×20 padded by 3, NOT scaled by 2).
    const outline = container.querySelector('rect[stroke-dasharray]');
    expect(outline?.getAttribute('width')).toBe('36');
    expect(outline?.getAttribute('height')).toBe('26');
  });
});
