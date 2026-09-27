/**
 * Chart primitives (ADR 0377 Wave 2) — TileBars scaling/a11y + Sparkline
 * normalization + the TileStats delta variant's glyph pairing.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TileBars } from '../TileBars.js';
import { Sparkline } from '../Sparkline.js';
import { TileStats } from '../TileStats.js';

describe('TileBars', () => {
  it('renders the value as TEXT beside a decorative (aria-hidden) bar', () => {
    const { container, getByText } = render(
      <TileBars bars={[{ key: 'a', label: 'Draft', value: 7 }, { key: 'b', label: 'Published', value: 21, display: '21 pages' }]} />,
    );
    expect(getByText('7')).toBeTruthy();
    expect(getByText('21 pages')).toBeTruthy(); // display overrides raw value
    const tracks = container.querySelectorAll('.dash-tile__bar-track');
    expect(tracks).toHaveLength(2);
    for (const t of tracks) expect(t.getAttribute('aria-hidden')).toBe('true');
  });

  it('scales fills to the max (100% for the largest, proportional otherwise)', () => {
    const { container } = render(
      <TileBars bars={[{ key: 'a', label: 'A', value: 50 }, { key: 'b', label: 'B', value: 100 }]} />,
    );
    const fills = [...container.querySelectorAll<HTMLElement>('.dash-tile__bar-fill')];
    expect(fills[0]!.style.width).toBe('50%');
    expect(fills[1]!.style.width).toBe('100%');
  });

  it('caps overflow at 100% when an explicit max is exceeded (pacing "over")', () => {
    const { container } = render(<TileBars bars={[{ key: 'a', label: 'A', value: 130 }]} max={100} />);
    const fill = container.querySelector<HTMLElement>('.dash-tile__bar-fill');
    expect(fill!.style.width).toBe('100%');
  });
});

describe('Sparkline', () => {
  it('renders role="img" with the tile-supplied label', () => {
    const { container } = render(<Sparkline points={[1, 5, 3]} label="3-week trend, latest 3" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('3-week trend, latest 3');
    expect(container.querySelector('polyline')?.getAttribute('points')).toBeTruthy();
  });

  it('is aria-hidden decoration without a label, and null for <2 points', () => {
    const { container } = render(<Sparkline points={[1, 2]} />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const { container: c2 } = render(<Sparkline points={[1]} />);
    expect(c2.querySelector('svg')).toBeNull();
  });

  it('a flat series (zero span) still renders without NaN coordinates', () => {
    const { container } = render(<Sparkline points={[5, 5, 5]} />);
    expect(container.querySelector('polyline')?.getAttribute('points')).not.toContain('NaN');
  });
});

describe('TileStats delta variant', () => {
  it('pairs direction glyph + number (never color alone); zero delta renders nothing', () => {
    const { getByText, queryByText, rerender } = render(
      <TileStats stats={[{ label: 'Pipeline', value: '340', delta: { value: 12, display: '12' } }]} />,
    );
    expect(getByText(/▲/).textContent).toContain('12');
    rerender(<TileStats stats={[{ label: 'Pipeline', value: '340', delta: { value: -3, display: '3' } }]} />);
    expect(getByText(/▼/).textContent).toContain('3');
    rerender(<TileStats stats={[{ label: 'Pipeline', value: '340', delta: { value: 0, display: '0' } }]} />);
    expect(queryByText(/[▲▼]/)).toBeNull();
  });
});
