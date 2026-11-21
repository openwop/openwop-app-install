/**
 * <TableScroll> is a named, focusable region only while its table overflows
 * (axe `scrollable-region-focusable`), and adds no tab stop while it fits.
 * jsdom has neither layout nor ResizeObserver: widths are stubbed on the
 * prototype, and the observer reports each target once on observe, as browsers do.
 *
 * Train 296: the observer's callback is ASYNC in a browser, so a render that made the
 * content overflow left a window with a scrolling region and no tab stop, and axe
 * caught it intermittently on /capabilities. The 'inert observer' cases below never
 * fire the callback, so they pass only if the wrapper measures synchronously after
 * each render. Red when the measurement waits for the observer.
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

  describe('without waiting for the ResizeObserver (an inert observer)', () => {
    beforeEach(() => {
      vi.stubGlobal('ResizeObserver', class {
        observe(): void {}
        disconnect(): void {}
      });
    });

    it('is focusable and named in the same render that overflows', () => {
      widths(900, 300);
      const { container } = render(<TableScroll label="Week by week">{table}</TableScroll>);
      const el = container.firstElementChild!;
      expect(el.getAttribute('tabindex')).toBe('0');
      expect(el.getAttribute('role')).toBe('region');
      expect(el.getAttribute('aria-label')).toBe('Week by week');
    });

    it('becomes focusable when a re-render makes the content overflow (rows arrived)', () => {
      widths(300, 300);
      const { container, rerender } = render(<TableScroll label="Week by week">{table}</TableScroll>);
      const el = container.firstElementChild!;
      expect(el.hasAttribute('tabindex')).toBe(false);
      vi.restoreAllMocks();
      widths(900, 300);
      rerender(<TableScroll label="Week by week">{table}<span>more</span></TableScroll>);
      expect(el.getAttribute('tabindex')).toBe('0');
      expect(el.getAttribute('role')).toBe('region');
    });
  });
});
