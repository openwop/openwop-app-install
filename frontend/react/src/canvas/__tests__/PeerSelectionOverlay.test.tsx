/** PeerSelectionOverlays (ADR 0359 residuals — the scene half of D5). */
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
    const rects = container.querySelectorAll('rect[stroke-dasharray]');
    expect(rects.length).toBe(2);
    expect(rects[0]?.getAttribute('stroke')).toBe('#3366aa');
    expect(rects[0]?.getAttribute('x')).toBe('7'); // bbox padded by 3
    const names = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(names).toEqual(['Ana', 'Bo']);
  });

  it('truncates long names with an ellipsis', () => {
    const { container } = renderSvg(
      <PeerSelectionOverlays outlines={[{ x: 0, y: 0, w: 10, h: 10, name: 'A very long collaborator name', color: '#123123' }]} />,
    );
    expect(container.querySelector('text')?.textContent?.endsWith('…')).toBe(true);
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
    expect(ys[0]).not.toBe(ys[1]); // stacked, not occluding
  });

  it('flips the flag BELOW the box when the element sits at the top edge (UX finding 3)', () => {
    const { container } = renderSvg(
      <PeerSelectionOverlays outlines={[{ x: 10, y: 4, w: 30, h: 20, name: 'Ana', color: '#333366' }]} />,
    );
    const flag = [...container.querySelectorAll('g[transform^="translate"]')].find((g) => g.querySelector('text'));
    const y = Number(/translate\([^,]+,\s*([-\d.]+)\)/.exec(flag?.getAttribute('transform') ?? '')?.[1]);
    expect(y).toBeGreaterThan(4 + 20); // below the box, never negative/clipped
  });

  it('scales flag geometry by flagScale while the outline stays scene-space (UX finding 4)', () => {
    const { container } = renderSvg(
      <PeerSelectionOverlays flagScale={2} outlines={[{ x: 100, y: 100, w: 30, h: 20, name: 'Ana', color: '#333366' }]} />,
    );
    const flag = [...container.querySelectorAll('g[transform^="translate"]')].find((g) => g.querySelector('text'));
    expect(flag?.getAttribute('transform')).toContain('scale(2)');
  });
});
