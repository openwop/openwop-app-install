/**
 * MapView interactivity (ADR 0282 P5) — component smoke tests: pin click selects
 * its locations-table row (the P3 click→table tie extended to points), the
 * designed tooltip appears on hover, and the zoom buttons drive the viewBox.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MapView, type MapRegion, type MapPoint } from '../MapView.js';
import { MAP_W, MAP_H } from '../projection.js';

afterEach(cleanup);

const opacityOfIn = (container: HTMLElement, i: number): number =>
  Number(container.querySelectorAll('svg[role="img"] path')[i]!.getAttribute('fill-opacity'));

const regions: MapRegion[] = [
  { id: 'usa', name: 'United States of America', value: 1200, geometry: { type: 'Polygon', coordinates: [[[-124, 48], [-124, 33], [-70, 33], [-70, 48]]] } },
  { id: 'bra', name: 'Brazil', geometry: { type: 'Polygon', coordinates: [[[-70, 0], [-70, -30], [-40, -30], [-40, 0]]] } },
];
const points: MapPoint[] = [
  { id: 'o1', lat: 34, lng: -118, label: 'LA Outlet', kind: 'outlet', sublabel: '1 Main St' },
  { id: 'o2', lat: 40, lng: -74, label: 'NYC Outlet', kind: 'outlet' },
];

const renderMap = () => render(
  <MapView regions={regions} points={points} valueLabel="Won revenue" formatValue={(n) => `$${n}`} caption="caption" />,
);

describe('R2 SM2-F9/F3 — the choropleth tells the truth about what it can compare', () => {
  const opacityOf = (container: HTMLElement, i: number): number =>
    Number(container.querySelectorAll('svg[role="img"] path')[i]!.getAttribute('fill-opacity'));

  it('a matched region with a ZERO value is still visible', () => {
    // `maxValue <= 0` sent every matched region to opacity 0 while UNMATCHED regions
    // kept 0.6 — so on a brand-new territory model (before the first closed-won deal)
    // the countries WITH data vanished and the rest of the world looked like the data.
    // The 0.12 floor exists exactly so a coloured region is always faintly visible.
    const zeroed: MapRegion[] = [{ ...regions[0]!, value: 0 }, regions[1]!];
    const { container } = render(<MapView regions={zeroed} valueLabel="Won" caption="c" />);
    expect(opacityOf(container, 0)).toBeGreaterThan(0);
  });

  it('unlike units are rendered as PRESENCE, not ranked by shading', () => {
    // Suppressing the currency symbol while keeping the magnitude ramp is the worse of
    // the two states: a JPY total is ~150× a USD one for the same business, so the
    // reader sees a confident ranking with the one cue that would make them doubt it
    // removed.
    const mixed: MapRegion[] = [{ ...regions[0]!, value: 1200 }, { ...regions[1]!, value: 150000 }];
    const { container } = render(<MapView regions={mixed} valueLabel="Won" caption="c" comparable={false} />);
    expect(opacityOf(container, 0)).toBe(opacityOf(container, 1));
  });

  it('…and comparable values still get the ramp (the negative control)', () => {
    const comparable: MapRegion[] = [{ ...regions[0]!, value: 100 }, { ...regions[1]!, value: 1000 }];
    const { container } = render(<MapView regions={comparable} valueLabel="Won" caption="c" />);
    expect(opacityOf(container, 0)).toBeLessThan(opacityOf(container, 1));
  });
});

describe('MapView interactivity (P5)', () => {
  it('clicking a pin opens the table and marks its row current', () => {
    const { container } = renderMap();
    const pins = container.querySelectorAll('svg[role="img"] circle');
    expect(pins.length).toBe(2);
    fireEvent.click(pins[0]!);
    const row = screen.getByText('LA Outlet').closest('tr');
    expect(row?.getAttribute('aria-current')).toBe('true');
    const otherRow = screen.getByText('NYC Outlet').closest('tr');
    expect(otherRow?.getAttribute('aria-current')).toBeNull();
  });

  it('onPointClick overrides the default pin-click (the deep-link seam)', () => {
    const onPointClick = vi.fn();
    const { container } = render(
      <MapView regions={regions} points={points} valueLabel="Won revenue" caption="caption" onPointClick={onPointClick} />,
    );
    fireEvent.click(container.querySelectorAll('svg[role="img"] circle')[1]!);
    expect(onPointClick).toHaveBeenCalledWith('o2');
    // The default select-table behavior is replaced — no table opened.
    expect(screen.queryByText('NYC Outlet')).toBeNull();
  });

  it('R2 review M5 — an all-zero RANKING and an unrankable map are different states', () => {
    // The docblock cited the 0.12 floor while the code returned 0.45 for BOTH. They are
    // not the same claim: all-zero is a ranking whose values are all zero (floor, so the
    // region stays visible), unrankable is not a ranking at all (a mid weight that reads
    // as "present"). Collapsing them made a brand-new model look like a mixed-currency
    // one and vice versa.
    const zeroed: MapRegion[] = [{ ...regions[0]!, value: 0 }, regions[1]!];
    const ranked = render(<MapView regions={zeroed} valueLabel="Won" caption="c" />);
    expect(opacityOfIn(ranked.container, 0)).toBeCloseTo(0.12, 5);
    cleanup();
    const unrankable = render(<MapView regions={zeroed} valueLabel="Won" caption="c" comparable={false} />);
    expect(opacityOfIn(unrankable.container, 0)).toBeCloseTo(0.45, 5);
  });

  it('R2 review M2 — the legend never advertises a ramp the map is not drawing', () => {
    // A "Lower → Higher" gradient beside a presence map is the strongest false cue on
    // the screen: it tells the reader darker means more, where every shaded region is
    // identical. The suppressed currency symbol is a much quieter signal than this one.
    const mixed: MapRegion[] = [{ ...regions[0]!, value: 1200 }, { ...regions[1]!, value: 150000 }];
    render(<MapView regions={mixed} valueLabel="Won" caption="c" comparable={false} />);
    // The gradient's two labels share one element with the swatch between them, so the
    // legend is read as a whole rather than by exact text.
    const legendText = (): string => screen.getByRole('group', { name: 'Legend' }).textContent ?? '';
    expect(legendText()).not.toMatch(/Lower/);
    expect(legendText()).toMatch(/has a territory/i);
    cleanup();
    render(<MapView regions={mixed} valueLabel="Won" caption="c" comparable />);
    expect(legendText()).toMatch(/Lower/);
    expect(legendText()).not.toMatch(/has a territory/i);
  });

  it('R2 review I1 — the spoken summary carries BOTH numbers the sighted line does', () => {
    const { container } = renderMap();
    const label = container.querySelector('svg[role="img"]')!.getAttribute('aria-label') ?? '';
    // One of two regions carries a value; a screen-reader user was told "2 regions",
    // which is the count of SHAPES drawn, not of regions with data.
    expect(label).toMatch(/1 of 2 regions shaded/i);
  });

  it('R2 review M3 — region names in the table are not 176 tab stops', () => {
    // An earlier fold-in made every name a link-button to select its region. On a full
    // world map that is 176 focusable elements with no payload a keyboard user wants,
    // ahead of the controls that matter. Selection stays on the map shape and the row.
    renderMap();
    // The table is collapsed by default — open it, or the assertion passes against a
    // DOM that contains no names at all.
    fireEvent.click(screen.getByRole('button', { name: /data table/i }));
    expect(screen.getByText('United States of America')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'United States of America' })).toBeNull();
  });

  it('hovering a region shows the designed tooltip with name + value', () => {
    const { container } = renderMap();
    const path = container.querySelector('svg[role="img"] path');
    fireEvent.mouseMove(path!, { clientX: 10, clientY: 10 });
    expect(screen.getByText('United States of America')).toBeTruthy();
    expect(screen.getByText('Won revenue: $1200')).toBeTruthy();
    fireEvent.mouseLeave(path!);
    expect(screen.queryByText('Won revenue: $1200')).toBeNull();
  });

  it('hovering a pin shows its label, kind and address', () => {
    const { container } = renderMap();
    const pin = container.querySelectorAll('svg[role="img"] circle')[0]!;
    fireEvent.mouseMove(pin, { clientX: 10, clientY: 10 });
    expect(screen.getByText('LA Outlet')).toBeTruthy();
    expect(screen.getByText('1 Main St')).toBeTruthy();
  });

  it('zoom buttons narrow the viewBox and reset restores the world', () => {
    const { container } = renderMap();
    const svg = container.querySelector('svg[role="img"]')!;
    const home = `0 0 ${MAP_W} ${MAP_H}`;
    expect(svg.getAttribute('viewBox')).toBe(home);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(svg.getAttribute('viewBox')).toBe(`${MAP_W / 4} ${MAP_H / 4} ${MAP_W / 2} ${MAP_H / 2}`);
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement;
    expect(zoomOut.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(svg.getAttribute('viewBox')).toBe(home);
  });
});
