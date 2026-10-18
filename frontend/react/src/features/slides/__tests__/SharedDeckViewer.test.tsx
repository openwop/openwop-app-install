/**
 * ADR 0328 Phase 7 — the public shared-deck pager: notes NEVER render (the
 * S7 audience posture), skipped slides are passed over, and each reached
 * frame reports one analytics view.
 *
 * /grade-tests w52 — PROTECTED (public share surface). Witnessed by sabotage of
 * `SharedDeckViewer.tsx`: rendering `slide.notes`, the once-per-frame guard, the
 * reported index, both key-scoping rules, the audience-empty analytics guard and
 * its raw-entries clause, the stage click, the swipe dominance rule (the
 * vertical leg now starts on frame 1 with |dx| past the 40px threshold — it used
 * to run on the LAST frame with dx=−5, so neither rule was reachable), the
 * fullscreen presence + label, the autoplay loop, manual-stop, autostart and the
 * single-slide Play. Autoplay legs advance ONE tick (7 s): four ticks on a
 * two-frame loop land back on "1 / 2", which made the no-motion and paused
 * counters unable to fail.
 *
 * DOUBLE GUARD (named, not probed per-clause): `audienceEmpty`'s
 * `visible.length === 0` clause sits behind the raw-entries clause — every raw
 * deck with no non-skipped object entry is already caught there, and coercion
 * never marks a raw non-skipped object skipped, so no fixture reaches the
 * second clause alone. The shared piece (the analytics/empty guard both feed)
 * is probed instead. Counter + real-index analytics are twinned in
 * `sharedDeckUpgrade.test.tsx` (both protected; kept).
 */
import { describe, it, expect, afterEach, vi, beforeEach, type Mock } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { config } from '../../../client/config.js';
import { SharedDeckViewer } from '../SharedDeckViewer.js';

const FRAME_VIEW_URL = `${config.baseUrl}/host/openwop-app/shared/tok/frame-view`;

/** A typed fetch stub — read back without casting `globalThis.fetch`. */
function stubFetch(): Mock<typeof fetch> {
  const spy = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', spy);
  return spy;
}
const frameViewCalls = (spy: Mock<typeof fetch>): unknown[][] =>
  spy.mock.calls.filter((c) => String(c[0]).includes('frame-view'));

afterEach(cleanup);

const deck = {
  title: 'Shared',
  theme: 'dark',
  slides: [
    { layout: 'title', title: 'Public headline', notes: 'SECRET notes' },
    { layout: 'blank', skip: true },
    { layout: 'section', title: 'Second stop', notes: 'MORE secrets' },
  ],
};

describe('SharedDeckViewer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders one frame at a time, never the speaker notes, and skips skipped slides', async () => {
    const { container, getByLabelText } = render(<SharedDeckViewer token="tok" deck={deck} />);
    expect(container.textContent).toContain('Public headline');
    expect(container.textContent).not.toContain('SECRET');
    // UX_UPGRADE-slides SL-G1/SL-G2 — the AUDIENCE projection changed
    // deliberately. This used to assert 3 dots (one dimmed for the skipped
    // slide) and a counter that jumped 1/3 → 3/3. Both told the audience about
    // material they cannot reach: the dot advertised a hidden slide, and the
    // counter promised three stops while delivering two. The viewer now counts
    // and draws ONLY the visible deck.
    expect(container.querySelectorAll('.cv-shared-deck__dot').length).toBe(2);
    expect(container.textContent).toContain('1 / 2');
    await act(async () => { fireEvent.click(getByLabelText('Next')); });
    expect(container.textContent).toContain('Second stop');
    expect(container.textContent).not.toContain('MORE secrets');
    expect(container.textContent).toContain('2 / 2');
  });

  it('reports each reached frame ONCE to the share analytics', async () => {
    const spy = stubFetch();
    const { getByLabelText } = render(<SharedDeckViewer token="tok" deck={deck} />);
    await act(async () => { fireEvent.click(getByLabelText('Next')); });
    await act(async () => { fireEvent.click(getByLabelText('Previous')); });
    // Frames 0 and 2, each once (the revisit of 0 is not re-reported), each a
    // POST to the share link's own frame-view endpoint.
    expect(spy.mock.calls.map(([url, init]) => [String(url), init?.method, init?.body])).toEqual([
      [FRAME_VIEW_URL, 'POST', '{"frame":0}'],
      [FRAME_VIEW_URL, 'POST', '{"frame":2}'],
    ]);
  });
});

describe('R2 SR-9 / review F2 — window key capture scoping', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('ArrowRight pages even when focus rests on a deck nav BUTTON (the blanket exclusion killed this)', async () => {
    const { container, getByLabelText } = render(<SharedDeckViewer token="tok" deck={deck} />);
    const next = getByLabelText('Next');
    next.focus();
    await act(async () => { fireEvent.keyDown(next, { key: 'ArrowRight' }); });
    expect(container.textContent).toContain('Second stop');
  });

  it('Space on a focused button does NOT page (it must activate the control)', async () => {
    const { container, getByLabelText } = render(<SharedDeckViewer token="tok" deck={deck} />);
    const next = getByLabelText('Next');
    next.focus();
    await act(async () => { fireEvent.keyDown(next, { key: ' ' }); });
    expect(container.textContent).toContain('1 / 2');
    expect(container.textContent).not.toContain('Second stop');
  });
});

describe('R2 SL-SP-2/SL-SP-5 — audience-empty honesty (no fabrication, no hidden slides, no analytics)', () => {
  let spy: Mock<typeof fetch>;
  beforeEach(() => { spy = stubFetch(); });
  afterEach(() => vi.unstubAllGlobals());

  it('an ALL-SKIPPED deck renders the designed empty state — never the retracted slide or "1 / 0"', async () => {
    const { container } = render(<SharedDeckViewer token="tok" deck={{
      title: 'All hidden', slides: [{ layout: 'title', title: 'RETRACTED', skip: true }],
    }} />);
    expect(container.textContent).toContain('Nothing to show yet');
    expect(container.textContent).not.toContain('RETRACTED');
    expect(container.textContent).not.toContain('1 / 0');
    // No analytics for a frame no audience was meant to see.
    expect(frameViewCalls(spy)).toHaveLength(0);
  });

  it('a missing/corrupt deck payload renders the empty state — never a fabricated "Slide 1"', async () => {
    const { container } = render(<SharedDeckViewer token="tok" deck={{}} />);
    expect(container.textContent).toContain('Nothing to show yet');
    expect(container.textContent).not.toContain('Slide 1');
    expect(frameViewCalls(spy)).toHaveLength(0);
  });

  it('a deck of all-INVALID entries (nulls) also hits the empty state — coerceSlide never drops entries (review F3)', async () => {
    const { container } = render(<SharedDeckViewer token="tok" deck={{ slides: [null, null] }} />);
    expect(container.textContent).toContain('Nothing to show yet');
    expect(frameViewCalls(spy)).toHaveLength(0);
  });
});

describe('R2 SL-SP-3/SL-SP-4 — pointer + touch paging', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('clicking the stage advances (the universal presentation convention)', async () => {
    const { container } = render(<SharedDeckViewer token="tok" deck={deck} />);
    expect(container.textContent).toContain('Public headline');
    await act(async () => { fireEvent.click(container.querySelector('.cv-shared-deck__stage')!); });
    expect(container.textContent).toContain('Second stop');
  });

  it('a horizontal swipe pages; a vertical drag does not (scrolling stays untouched)', async () => {
    const { container } = render(<SharedDeckViewer token="tok" deck={deck} />);
    const root = container.querySelector('.cv-shared-deck')!;
    // Vertical-dominant drag FIRST, on frame 1 (so a wrongful page has somewhere
    // to go), with |dx| = 60 — past the 40px threshold, so only the dominance
    // rule can refuse it.
    await act(async () => {
      fireEvent.touchStart(root, { touches: [{ clientX: 300, clientY: 100 }] });
      fireEvent.touchEnd(root, { changedTouches: [{ clientX: 240, clientY: 400 }] });
    });
    expect(container.textContent).toContain('1 / 2');
    expect(container.textContent).toContain('Public headline');
    await act(async () => {
      fireEvent.touchStart(root, { touches: [{ clientX: 300, clientY: 100 }] });
      fireEvent.touchEnd(root, { changedTouches: [{ clientX: 100, clientY: 110 }] });
    });
    expect(container.textContent).toContain('Second stop');
  });
});

describe('R2 zero-test fill — the SL-G3 fullscreen control (shipped round 1, never pinned)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is ABSENT (not disabled) when the browser has no Fullscreen API', () => {
    const { queryByLabelText } = render(<SharedDeckViewer token="tok" deck={deck} />);
    // jsdom has no fullscreenEnabled by default — the control must not render.
    expect(queryByLabelText(/fullscreen/i)).toBeNull();
  });

  it('renders when the API exists, and the label follows fullscreenchange (Esc honesty)', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    try {
      const { getByLabelText, queryByLabelText } = render(<SharedDeckViewer token="tok" deck={deck} />);
      expect(getByLabelText(/^fullscreen|enter/i)).toBeTruthy();
      // Simulate entering fullscreen via the browser (Esc-path honesty).
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.body });
      await act(async () => { fireEvent(document, new Event('fullscreenchange')); });
      expect(queryByLabelText(/exit/i)).toBeTruthy();
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      await act(async () => { fireEvent(document, new Event('fullscreenchange')); });
      expect(queryByLabelText(/exit/i)).toBeNull();
    } finally {
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: undefined });
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    }
  });
});

describe('SL-R2-5 (round 3) — audience-initiated autoplay', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('never plays on its own; Play advances on the cadence and LOOPS past the end, skipping hidden slides', async () => {
    const { container, getByLabelText } = render(<SharedDeckViewer token="tok" deck={deck} />);
    // No spontaneous motion: time alone moves nothing. ONE cadence tick — four
    // ticks on this two-frame loop would land back on "1 / 2" and hide motion.
    await act(async () => { vi.advanceTimersByTime(7000); });
    expect(container.textContent).toContain('1 / 2');

    fireEvent.click(getByLabelText('Play the deck (advances every few seconds)'));
    await act(async () => { vi.advanceTimersByTime(7000); });
    expect(container.textContent).toContain('Second stop'); // slide 2 (the skip was passed over)
    expect(container.textContent).toContain('2 / 2');
    await act(async () => { vi.advanceTimersByTime(7000); });
    // Last frame → loop to the FIRST visible frame, not the raw index 0-of-3.
    expect(container.textContent).toContain('Public headline');
    expect(container.textContent).toContain('1 / 2');
  });

  it('manual paging takes control back — the timer stops advancing', async () => {
    const { container, getByLabelText } = render(<SharedDeckViewer token="tok" deck={deck} />);
    fireEvent.click(getByLabelText('Play the deck (advances every few seconds)'));
    await act(async () => { vi.advanceTimersByTime(7000); }); // → 2 / 2, so Previous is enabled
    await act(async () => { fireEvent.click(getByLabelText('Previous')); });
    await act(async () => { vi.advanceTimersByTime(7000); }); // one tick: a live timer would show 2 / 2
    expect(container.textContent).toContain('1 / 2'); // paused: no advance since
    // The control reads Play again (paired polarity of the pressed state).
    expect(getByLabelText('Play the deck (advances every few seconds)')).toBeTruthy();
  });

  it('a single-visible-slide deck offers no Play control at all (absent, not disabled)', () => {
    const one = { title: 'One', slides: [{ layout: 'title', title: 'Only' }, { layout: 'blank', skip: true }] };
    const { queryByLabelText } = render(<SharedDeckViewer token="tok" deck={one} />);
    expect(queryByLabelText('Play the deck (advances every few seconds)')).toBeNull();
  });
});
