/**
 * <TableScroll> is a named, focusable region only while its table overflows
 * (axe `scrollable-region-focusable`), and adds no tab stop while it fits.
 * jsdom has neither layout nor ResizeObserver: widths are stubbed on the
 * prototype, and the observer reports each target once on observe, as browsers do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TableScroll } from '../DataTable.js';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly cb: () => void) {}
    observe(): void { this.cb(); }
    disconnect(): void {}
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function widths(scroll: number, client: number): void {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scroll);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(client);
}
const table = <table><caption>Week by week</caption><tbody><tr><td>1</td></tr></tbody></table>;

describe('<TableScroll>', () => {
  it('is a focusable region named by its label while it overflows', () => {
    widths(900, 300);
    const { container } = render(<TableScroll className="table--stack" label="Week by week">{table}</TableScroll>);
    const el = container.firstElementChild!;
    expect(el.className).toBe('table-scroll table--stack');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.getAttribute('role')).toBe('region');
    expect(el.getAttribute('aria-label')).toBe('Week by week');
  });
  it('adds no tab stop while the table fits', () => {
    widths(300, 300);
    const { container } = render(<TableScroll label="Week by week">{table}</TableScroll>);
    const el = container.firstElementChild!;
    expect(el.hasAttribute('tabindex')).toBe(false);
    expect(el.hasAttribute('role')).toBe(false);
  });
});
