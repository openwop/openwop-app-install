/**
 * TOCU-1 (ADR 0604) — a shortened array must not read as a complete one.
 *
 * `_elided` had SIX hits in the repo, ALL backend / tests / docs — zero under
 * `frontend/react/src`, zero i18n keys. The lossy compaction kernel persists
 * `{"_elided": N}` into the run event log (the `compact` node is
 * `role:"action"`), and both `RunStepInspector` and `RunTimeline` rendered
 * `ev.payload` through a bare `JSON.stringify`. So an operator scrubbing a run
 * saw a truncated list presented as the whole answer, with the honesty marker
 * sitting inside it as ordinary-looking JSON.
 *
 * The assertions below are polarised on purpose: the notice must appear when
 * markers are present AND must be absent when they are not. A disclosure that
 * always renders is noise, and a test that only checks the positive case cannot
 * tell the two apart.
 *
 * Sabotages that turn it red (w22 probes): `+=` → `=` in the elided sum; `> 0` →
 * `>= 0` in hasCompactionMarkers; descend into `_emptied`; drop the cycle `seen`
 * set; accept a negative `_elided`; drop the row-count / field-name text; drop
 * the `return null`; `variant="error"`; default `announce` to true or ignore it;
 * drop `<CompactionNotice` from RunTimeline or `announce` from RunStepInspector.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { RunEventDoc } from '@openwop/openwop';
import { CompactionNotice, findCompactionMarkers, hasCompactionMarkers } from '../CompactionNotice.js';
import { RunStepInspector } from '../RunStepInspector.js';
import { RunTimeline } from '../RunTimeline.js';
import { announce, currentAnnouncements } from '../../ui/announce.js';

afterEach(cleanup);

describe('findCompactionMarkers', () => {
  it('sums elided rows across nested arrays and collects emptied field names', () => {
    const payload = {
      items: [{ id: 1 }, { _elided: 137 }, { id: 200 }],
      nested: { rows: [{ a: 1 }, { _elided: 4 }], _emptied: ['tags', 'note'] },
      more: { _emptied: ['tags', 'extra'] }, // a repeat is listed once, first-seen order kept
    };
    expect(findCompactionMarkers(payload)).toEqual({ elidedRows: 141, emptiedFields: ['tags', 'note', 'extra'] });
  });

  it('reports NOTHING for an ordinary payload (the negative polarity)', () => {
    const markers = findCompactionMarkers({ items: [{ id: 1, tags: [] }], ok: true });
    expect(hasCompactionMarkers(markers)).toBe(false);
  });

  it('does not count the disclosure list itself as payload', () => {
    // `_emptied` holds KEY NAMES. Walking into it would be counting the notice's
    // own words, inflating the very number the notice exists to state honestly.
    // A hostile shape (run payloads are untrusted): an object INSIDE the disclosure
    // list must not be walked. With real kernel output (`_emptied` is all strings)
    // the skip is unobservable — w22 fe-skip-emptied was vacuous on ['a','b'].
    expect(findCompactionMarkers({ _emptied: ['a', { _elided: 9 }], keep: 1 })).toEqual({ elidedRows: 0, emptiedFields: ['a'] });
  });

  it('is total — a cycle, a primitive or a hostile shape never throws', () => {
    // The cycle carries a marker, so a missing `seen` set is observable: the
    // depth bound alone stops the walk, but only after counting it 65 times.
    const cyclic: Record<string, unknown> = { _elided: 5 };
    cyclic.self = cyclic;
    expect(findCompactionMarkers(cyclic).elidedRows).toBe(5);
    expect(() => findCompactionMarkers(null)).not.toThrow();
    expect(() => findCompactionMarkers('a string')).not.toThrow();
    // A non-numeric / negative `_elided` is not a real marker and must not
    // manufacture a disclosure out of ordinary data.
    expect(hasCompactionMarkers(findCompactionMarkers({ _elided: 'not a number' }))).toBe(false);
    expect(hasCompactionMarkers(findCompactionMarkers({ _elided: 0 }))).toBe(false);
    // A negative count must not SUBTRACT from real markers.
    expect(findCompactionMarkers({ items: [{ _elided: 5 }, { _elided: -3 }, { _elided: 'x' }] }).elidedRows).toBe(5);
  });
});

describe('CompactionNotice', () => {
  it('states the row count when rows were elided', () => {
    render(<CompactionNotice markers={{ elidedRows: 137, emptiedFields: [] }} />);
    // The COUNT is the load-bearing part — "this was shortened" without a number
    // leaves the operator unable to judge how wrong the list is.
    expect(screen.getByText(/137/)).toBeTruthy();
  });

  it('names the dropped fields when fields were emptied', () => {
    render(<CompactionNotice markers={{ elidedRows: 0, emptiedFields: ['tags', 'note'] }} />);
    expect(screen.getByText(/tags, note/)).toBeTruthy();
  });

  it('renders NOTHING when there is nothing to disclose', () => {
    const { container } = render(<CompactionNotice markers={{ elidedRows: 0, emptiedFields: [] }} />);
    expect(container.innerHTML).toBe('');
  });

  it('does NOT use role="alert" — a shortened list is a fact, not an interruption', () => {
    for (const props of [{}, { announce: true }] as const) {
      cleanup();
      const { container } = render(<CompactionNotice markers={{ elidedRows: 5, emptiedFields: [] }} {...props} />);
      expect(container.querySelector('[role="alert"]')).toBeNull();
    }
  });

  it('the ANNOUNCING variant carries no inline region — it delegates', () => {
    // This component is conditionally mounted, so a region arriving WITH its
    // text announces nothing. It delegates to the always-mounted
    // GlobalLiveRegion via `announce`, and `Notice` drops its own role/aria-live
    // when that is set. Asserting the ABSENCE is what makes the delegation
    // load-bearing — with an inline region present, the disclosure would be
    // sighted-only.
    const { container } = render(<CompactionNotice markers={{ elidedRows: 5, emptiedFields: [] }} announce />);
    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it('the SILENT variant keeps the design-system default, and that region is inert', () => {
    // Review M10 — recorded rather than "fixed", because the honest reading is
    // that it needs no fix. Without `announce`, `Notice` renders its standard
    // `role="status" aria-live="polite"`, exactly as every other Notice in the
    // app does. Mounted WITH its content, such a region announces nothing (the
    // PR #2615/#2616 finding) — which is the point: the collapsed timeline
    // disclosure is silent, and the inertness is why the OPENED surface must
    // delegate instead of relying on this.
    announce('', { assertive: false }); // the channel is module-global
    const { container } = render(<CompactionNotice markers={{ elidedRows: 5, emptiedFields: [] }} />);
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(currentAnnouncements().polite).not.toContain('5');
  });
});

/**
 * ADR 0604 review M10 — WHAT THE ISOLATED UNIT TEST ABOVE COULD NOT SEE.
 *
 * `RunTimeline` renders this notice inside a COLLAPSED `<details>`. Its
 * children mount while collapsed, so an unconditional `announce` spoke about
 * content the operator had not opened. And `ui/announce.tsx` holds ONE
 * `politeMsg`, so N marker-carrying events in a segment collapse to a single
 * orphaned count — from whichever event rendered last. Rendering one component
 * on its own can observe neither: it is one notice, and it is not inside a
 * disclosure. Both are asserted below: the default is silent (so N notices in a
 * segment leave the single polite channel untouched — a separate N-notice case
 * was cut in w22 as the same break), and the real RunTimeline collapsed
 * disclosure is rendered in the last block.
 */
describe('announcement is scoped to the surface the operator opened (M10)', () => {
  const markers = { elidedRows: 137, emptiedFields: ['tags'] };

  it('silent by default — a notice inside a collapsed disclosure says nothing', () => {
    announce('', { assertive: false }); // reset the module-global channel
    render(<details><summary>payload</summary><CompactionNotice markers={markers} /></details>);
    expect(currentAnnouncements().polite).toBe('');
    // …and it is still VISIBLE the moment the disclosure opens.
    expect(screen.getByText(/137/)).toBeTruthy();
  });

  it('announces only when the caller opts in', () => {
    announce('', { assertive: false });
    render(<CompactionNotice markers={markers} announce />);
    expect(currentAnnouncements().polite).toContain('137');
  });
});

/**
 * The two render paths, RENDERED — these replace a source grep that could not
 * see whether the opened surface announces (w22 fe-inspector-announce, vacuous).
 */
describe('the render paths actually call the disclosure', () => {
  const elided: RunEventDoc = {
    eventId: 'e3', runId: 'r1', schemaVersion: 1, sequence: 3, type: 'node.completed', nodeId: 'lister',
    timestamp: '2026-09-01T00:00:03.000Z',
    payload: { items: [{ id: 1 }, { _elided: 137 }, { id: 200 }] },
  };

  it('RunStepInspector (the expanded surface) discloses AND announces', () => {
    announce('', { assertive: false });
    render(<RunStepInspector events={[elided]} seq={3} />);
    expect(screen.getByText(/137 rows were removed/)).toBeTruthy();
    expect(currentAnnouncements().polite).toContain('137');
  });

  it('RunTimeline (the collapsed payload) discloses SILENTLY', () => {
    announce('', { assertive: false });
    const events: RunEventDoc[] = [
      { eventId: 'e1', runId: 'r1', schemaVersion: 1, sequence: 1, type: 'run.started', timestamp: '2026-09-01T00:00:01.000Z', payload: {} },
      { eventId: 'e2', runId: 'r1', schemaVersion: 1, sequence: 2, type: 'node.started', nodeId: 'lister', timestamp: '2026-09-01T00:00:02.000Z', payload: {} },
      elided,
    ];
    const { container } = render(<RunTimeline events={events} readState="ready" />);
    fireEvent.click(screen.getByRole('button', { name: /lister/ }));
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(within(details as HTMLElement).getByText(/137 rows were removed/)).toBeTruthy();
    expect(currentAnnouncements().polite).toBe('');
  });
});
