/**
 * `useLiveRegion` — a surface-owned polite region whose repeats stay audible.
 *
 * The defect this exists to kill (`ANN-UX-2`): ~44 hand-rolled regions in this
 * app render their message as a bare text child of a `useState` string. Setting
 * the SAME string is a no-op end to end — React bails on `Object.is`-equal
 * state, and even on a render the reconciler skips an equal text update — so
 * the DOM never mutates and a live region only speaks on mutation. The second
 * identical message says nothing, which is precisely when a user repeats an
 * action to check whether it worked.
 *
 * Asserted against a real MutationObserver rather than by inspecting the value,
 * because "the DOM changed" is the actual precondition for speech; a test that
 * only compared strings would pass on an implementation that never rendered.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useLiveRegion } from '../announce.js';

function Harness({ onReady }: { onReady: (set: (m: string, o?: { collapseRepeats?: boolean }) => void) => void }): JSX.Element {
  const [text, set] = useLiveRegion();
  onReady(set);
  return <div data-testid="region" role="status" aria-live="polite">{text}</div>;
}

/** Counts real text mutations — what assistive tech actually observes. */
function mounted(): { set: (m: string, o?: { collapseRepeats?: boolean }) => void; mutations: () => number; text: () => string } {
  let set!: (m: string, o?: { collapseRepeats?: boolean }) => void;
  const { getByTestId } = render(<Harness onReady={(s) => { set = s; }} />);
  const el = getByTestId('region');
  let count = 0;
  new MutationObserver((records) => { count += records.length; }).observe(el, {
    childList: true, characterData: true, subtree: true,
  });
  return { set, mutations: () => count, text: () => el.textContent ?? '' };
}

afterEach(cleanup);

describe('useLiveRegion', () => {
  it('re-announces a REPEATED message — the region actually mutates each time', async () => {
    const r = mounted();
    act(() => { r.set('No downstream node.'); });
    await Promise.resolve();
    act(() => { r.set('No downstream node.'); });
    await Promise.resolve();

    expect(r.mutations()).toBeGreaterThanOrEqual(2); // silent-on-repeat would be 1
    // …and the SPOKEN text is unchanged: only an invisible marker differs.
    expect(r.text().replace(/​/g, '')).toBe('No downstream node.');
  });

  it('alternates rather than growing — a third repeat returns to the first value', () => {
    const r = mounted();
    act(() => { r.set('Saved.'); });
    const first = r.text();
    act(() => { r.set('Saved.'); });
    const second = r.text();
    act(() => { r.set('Saved.'); });
    const third = r.text();

    expect(second).not.toBe(first);
    expect(third).toBe(first);      // bounded: never accumulates markers
    expect(third.length).toBeLessThanOrEqual(first.length);
  });

  it('collapseRepeats opts ambient churn out — a flapping peer must not queue up', async () => {
    const r = mounted();
    act(() => { r.set('Alice joined', { collapseRepeats: true }); });
    await Promise.resolve();
    const after = r.mutations();
    act(() => { r.set('Alice joined', { collapseRepeats: true }); });
    await Promise.resolve();

    expect(r.mutations()).toBe(after); // no second mutation ⇒ no second announcement
  });

  it('a genuinely different message always speaks, marker or not', async () => {
    const r = mounted();
    act(() => { r.set('No upstream node.'); });
    act(() => { r.set('No upstream node.'); });   // marker on
    await Promise.resolve();
    const before = r.mutations();
    act(() => { r.set('No downstream node.'); }); // different text
    await Promise.resolve();

    expect(r.mutations()).toBeGreaterThan(before);
    expect(r.text().replace(/​/g, '')).toBe('No downstream node.');
  });
});
