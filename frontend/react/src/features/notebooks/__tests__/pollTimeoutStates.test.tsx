/**
 * ADR 0602 / NBU-6 — a poll that GIVES UP has to say so, and must not turn its
 * silence into a positive claim.
 *
 * All three async runs in this workspace (ingest, summarize, transform) polled for
 * a result and, at their attempt cap, executed a BARE `return`. Nothing rendered,
 * nothing was announced, no state changed that a user could read; the spinner just
 * stopped, which is byte-identical to the success path minus the result. Then the
 * panel rendered "No sources yet" / "No transformations yet" — a claim about what
 * the SERVER holds, made moments after the client stopped looking. Silent first,
 * confidently wrong second.
 *
 * What is pinned here, and why each assertion is not vacuous:
 *
 *  1. the give-up STATES itself, in the owning panel, in the "we stopped checking /
 *     it may still be working" register — asserted on the copy, because a timeout
 *     rendered as "there are no results" would satisfy any weaker assertion;
 *  2. the false empty state is SUPPRESSED while the give-up stands — with a
 *     CONTROL proving that same empty state still renders when nothing is stalled,
 *     so the absence assertion is discriminating rather than trivially true;
 *  3. the feedback channel is the RENDERED CARD, not a toast — `DS-NB-1` is open:
 *     a repeated identical error toast coalesces without inserting a DOM node, and
 *     errors are excluded from `announce()`, so a second identical failure is
 *     silent to a screen reader. The card announces politely via the app-shell
 *     `GlobalLiveRegion`, which is mounted long before any message;
 *  4. "Check again" is OBSERVABLE even when it finds nothing (NBU-19) — the
 *     screen must differ before and after, or it is a button that did nothing;
 *  5. evidence clears it: a recheck that finds the result removes the card.
 *
 * The pollers recurse through `window.setTimeout`, so these drive fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listSources = vi.fn();
const listNotes = vi.fn();
const listTransformations = vi.fn();
const addYoutubeSource = vi.fn();
const applyTransformation = vi.fn();
const summarizeSource = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('../notebooksClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listSources: (...a: unknown[]) => listSources(...a),
  listNotes: (...a: unknown[]) => listNotes(...a),
  listTransformations: (...a: unknown[]) => listTransformations(...a),
  addYoutubeSource: (...a: unknown[]) => addYoutubeSource(...a),
  applyTransformation: (...a: unknown[]) => applyTransformation(...a),
  summarizeSource: (...a: unknown[]) => summarizeSource(...a),
  searchNotebook: vi.fn(async () => ({ hits: [], citations: [] })),
  addNote: vi.fn(async () => []),
  addSource: vi.fn(async () => ({ documentId: 'd1' })),
  listTransformationTemplates: vi.fn(async () => [{ id: 'tpl-1', label: 'Key Concepts' }]),
  ensureNotebookChat: vi.fn(async () => ({ conversationId: 'c1' })),
  ensureNotebook: vi.fn(async () => NOTEBOOK_FIXTURE),
}));

const NOTEBOOK_FIXTURE = {
  id: 'nb1', tenantId: 't1', orgId: 'o1', name: 'Research', collectionId: 'col1',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
/** `M9` — the recheck OUTCOME must reach a screen reader. `StateCard`'s announce
 *  effect is keyed `[announce, title]` and a recheck changes only the BODY, so
 *  the repeat was sighted-only. Both the card's announce and the page's own
 *  route through this module, so one spy sees both. */
const announceSpy = vi.fn();
vi.mock('../../../ui/announce.js', () => ({ announce: (...a: unknown[]) => announceSpy(...a) }));

vi.mock('../../../ui/toast.js', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a), info: vi.fn() },
}));

import { ProjectSourcesPanel, __clearNotebookStalls } from '../NotebooksPage.js';

const source = (id: string, over: Record<string, unknown> = {}) => ({
  documentId: id, title: `Source ${id}`, contextLevel: 'full', chunkCount: 1,
  hasSummary: false, ...over,
});

const renderWorkspace = async () => {
  const r = render(<MemoryRouter><ProjectSourcesPanel projectId="nb1" /></MemoryRouter>);
  await screen.findByLabelText('New note');
  return r;
};

/** Run out every poll attempt. The caps are ~30s (ingest) and ~20s (the other
 *  two); 60s of virtual time clears all three with margin. */
const runOutThePoll = async () => {
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
};

beforeEach(() => {
  // `M3` — give-ups now survive the component (a tab switch unmounts this
  // panel), so they must be cleared BETWEEN TESTS or a control inherits the
  // previous test's card.
  __clearNotebookStalls();
  announceSpy.mockClear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  listSources.mockResolvedValue([]);
  listNotes.mockResolvedValue([]);
  listTransformations.mockResolvedValue([]);
  // `H4` — every one of these returns `{ runId }` in production and every call
  // site used to discard it. The fixtures carry one so the give-up card's run
  // link is exercised rather than assumed.
  addYoutubeSource.mockResolvedValue({ runId: 'run-yt-1' });
  applyTransformation.mockResolvedValue({ runId: 'run-tr-1' });
  summarizeSource.mockResolvedValue({ runId: 'run-sum-1' });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('NBU-6 — an ingest poll that gives up states itself and suppresses the false empty', () => {
  it('renders the "we stopped checking" card and NOT "No sources yet"', async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('YouTube URL'), { target: { value: 'https://youtu.be/x' } });
    fireEvent.click(screen.getByRole('button', { name: /add from youtube/i }));
    await runOutThePoll();

    // The give-up is STATED...
    expect(screen.getByText('Still waiting for that source')).toBeTruthy();
    // ...in the honest register. Asserted on the copy because "we stopped
    // checking" and "there are no results" are the two candidate meanings and
    // only one of them is true.
    expect(screen.getByText(/stopped checking/i)).toBeTruthy();
    expect(screen.getByText(/not a report that it failed/i)).toBeTruthy();
    // ...and the positive claim about the server is gone.
    expect(screen.queryByText('No sources yet')).toBeNull();
  });

  it('CONTROL: with nothing stalled, "No sources yet" still renders', async () => {
    // Without this the absence assertion above passes for the wrong reason — e.g.
    // if the empty card were deleted outright, or the copy renamed.
    await renderWorkspace();
    expect(screen.getByText('No sources yet')).toBeTruthy();
    expect(screen.queryByText('Still waiting for that source')).toBeNull();
  });

  it('CONTROL: a poll that LANDS leaves no give-up card behind', async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('YouTube URL'), { target: { value: 'https://youtu.be/x' } });
    // The source appears on the first poll.
    listSources.mockResolvedValue([source('d1')]);
    fireEvent.click(screen.getByRole('button', { name: /add from youtube/i }));
    await runOutThePoll();

    expect(screen.getByText('Source d1')).toBeTruthy();
    expect(screen.queryByText('Still waiting for that source')).toBeNull();
    expect(screen.queryByText('No sources yet')).toBeNull();
  });

  it('states the give-up in the CARD, not in a toast (DS-NB-1)', async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('YouTube URL'), { target: { value: 'https://youtu.be/x' } });
    fireEvent.click(screen.getByRole('button', { name: /add from youtube/i }));
    await runOutThePoll();

    expect(screen.getByText('Still waiting for that source')).toBeTruthy();
    // A repeated identical ERROR toast coalesces without inserting a DOM node and
    // is excluded from `announce()`, so the second identical failure would be
    // silent to a screen reader. The give-up must not ride that channel.
    const errorArgs = toastError.mock.calls.map((c) => String(c[0]));
    expect(errorArgs.filter((m) => /waiting|stopped checking/i.test(m))).toEqual([]);
  });
});

describe('NBU-6 — "Check again" is observable whether or not it finds anything (NBU-19)', () => {
  it('a recheck that still finds nothing KEEPS the card and CHANGES it', async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('YouTube URL'), { target: { value: 'https://youtu.be/x' } });
    fireEvent.click(screen.getByRole('button', { name: /add from youtube/i }));
    await runOutThePoll();
    expect(screen.getByText('Still waiting for that source')).toBeTruthy();
    // Before the click there is no recheck line — the floor that makes the
    // "appears after" assertion below mean something.
    expect(screen.queryByText(/still nothing new/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(screen.getByText('Still waiting for that source')).toBeTruthy();
    expect(screen.getByText(/Checked 1 more time — still nothing new\./)).toBeTruthy();

    // A SECOND click must differ from the first, or a repeat retry is again a
    // button whose screen is byte-identical before and after.
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByText(/Checked 2 more times — still nothing new\./)).toBeTruthy();
  });

  it('a recheck that FINDS the source clears the card — it clears on evidence only', async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('YouTube URL'), { target: { value: 'https://youtu.be/x' } });
    fireEvent.click(screen.getByRole('button', { name: /add from youtube/i }));
    await runOutThePoll();
    expect(screen.getByText('Still waiting for that source')).toBeTruthy();

    listSources.mockResolvedValue([source('d9')]);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(screen.queryByText('Still waiting for that source')).toBeNull();
    expect(screen.getByText('Source d9')).toBeTruthy();
  });
});

describe('NBU-6 — the transform poll gives up the same way', () => {
  it('suppresses "No transformations yet" and states the give-up instead', async () => {
    listSources.mockResolvedValue([source('d1')]);
    await renderWorkspace();
    // The per-source Transform menu appears once the template catalog resolves.
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: 'tpl-1' } });
    await runOutThePoll();

    expect(screen.getByText('Still waiting for that transformation')).toBeTruthy();
    expect(screen.queryByText('No transformations yet')).toBeNull();
    expect(applyTransformation).toHaveBeenCalledWith('nb1', 'd1', 'tpl-1');
  });

  it('CONTROL: with nothing stalled, "No transformations yet" still renders', async () => {
    listSources.mockResolvedValue([source('d1')]);
    await renderWorkspace();
    expect(screen.getByText('No transformations yet')).toBeTruthy();
    expect(screen.queryByText('Still waiting for that transformation')).toBeNull();
  });
});

describe('NBU-6 — the summarize poll gives up the same way', () => {
  it('states the give-up rather than silently dropping the pending spinner', async () => {
    listSources.mockResolvedValue([source('d1')]);
    await renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize' }));
    await runOutThePoll();

    expect(screen.getByText('Still waiting for that summary')).toBeTruthy();
    expect(screen.getByText(/may still be generating/i)).toBeTruthy();
    // The row's pending flag still clears — the give-up states itself INSTEAD of
    // leaving a spinner that never resolves, not in addition to one.
    expect(screen.queryByRole('button', { name: 'Summarizing…' })).toBeNull();
  });
});

/**
 * ── The adversarial-review round: the give-up card re-committed the very
 *    inversion it exists to remove. Each test below reddens without its fix. ──
 */
describe('ADR 0602 correction round — the give-up card', () => {
  it('M1: a recheck that ERRORS says so and does NOT advance the count', async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('YouTube URL'), { target: { value: 'https://youtu.be/x' } });
    fireEvent.click(screen.getByRole('button', { name: /add from youtube/i }));
    await runOutThePoll();

    listSources.mockRejectedValue(new Error('network down'));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    // A failure to OBSERVE is not an observation of absence. The old code ran the
    // catch into the same branch as "found nothing" and rendered "Checked 1 more
    // time — still nothing new": a claim about the server, from a request that
    // never reached it, on the one card whose purpose is not to make that claim.
    expect(screen.queryByText(/still nothing new/i)).toBeNull();
    expect(screen.getByText(/couldn't check just now/i)).toBeTruthy();
    expect(screen.getByText('Still waiting for that source')).toBeTruthy();

    // CONTROL: a recheck that genuinely observes nothing DOES advance the count,
    // so the assertion above is about the ERROR branch and not about the counter
    // having been removed.
    listSources.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByText(/Checked 1 more time — still nothing new\./)).toBeTruthy();
  });

  it('M3a: the card clears the moment its source ARRIVES, without a click', async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('YouTube URL'), { target: { value: 'https://youtu.be/x' } });
    fireEvent.click(screen.getByRole('button', { name: /add from youtube/i }));
    await runOutThePoll();
    expect(screen.getByText('Still waiting for that source')).toBeTruthy();

    // An ORDINARY list refresh — here the "add text source" form's `loadSources()`,
    // which never touches the poller — brings a source in. The card used to
    // survive this: the source rendered in the list directly BELOW a card still
    // saying "Still waiting for that source", because the give-up cleared only
    // inside the poller and inside "Check again".
    listSources.mockResolvedValue([source('d1')]);
    fireEvent.change(screen.getByLabelText('Source text'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(screen.getByText('Source d1')).toBeTruthy();
    expect(screen.queryByText('Still waiting for that source')).toBeNull();
  });

  it('M3b: a give-up SURVIVES the unmount a tab switch causes', async () => {
    const first = await renderWorkspace();
    fireEvent.change(screen.getByLabelText('YouTube URL'), { target: { value: 'https://youtu.be/x' } });
    fireEvent.click(screen.getByRole('button', { name: /add from youtube/i }));
    await runOutThePoll();
    expect(screen.getByText('Still waiting for that source')).toBeTruthy();

    // `ProjectDetailPage` renders this panel as `tab === 'sources' ? <Panel/> : …`,
    // so switching tabs UNMOUNTS it. With the give-up in `useState`, one tab
    // switch restored "No sources yet" — the exact positive claim the card
    // exists to suppress, via the navigation a waiting user is most likely to
    // make. Unmount + remount is that switch.
    first.unmount();
    await renderWorkspace();

    expect(screen.getByText('Still waiting for that source')).toBeTruthy();
    expect(screen.queryByText('No sources yet')).toBeNull();
  });

  it('M4: a SUMMARIZE give-up also suppresses "No sources yet"', async () => {
    // The suppression was gated on `!stalled.has('ingest')` only, so a summarize
    // stall rendered BESIDE the empty claim. ADR 0602 §3 states the rule
    // unconditionally; `panelStalled()` is what makes it true per panel.
    listSources.mockResolvedValue([source('d1')]);
    const r = await renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize' }));
    // The source list goes empty underneath (the server lost it / a peer removed
    // it) while the summarize give-up stands.
    listSources.mockResolvedValue([]);
    await runOutThePoll();

    expect(screen.getByText('Still waiting for that summary')).toBeTruthy();
    expect(screen.queryByText('No sources yet')).toBeNull();
    r.unmount();
  });

  it('H4: the give-up links the RUN the user is waiting on', async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('YouTube URL'), { target: { value: 'https://youtu.be/x' } });
    fireEvent.click(screen.getByRole('button', { name: /add from youtube/i }));
    await runOutThePoll();

    const link = screen.getByRole('link', { name: 'View the run' });
    expect(link.getAttribute('href')).toBe('/runs/run-yt-1');
  });
});

describe('ADR 0602 correction round — evidence and announcement', () => {
  it('M2: identity, not count — a DELETE plus an unrelated ADD does not clear the card', async () => {
    // Baseline is [d1]. The server then loses d1 and gains d2, so the COUNT is
    // unchanged at 1 while a genuinely new source IS present. The old predicate
    // (`fresh.length > baseline`) reads that as "nothing landed" and keeps the
    // card standing over a list that already contains the arrival.
    listSources.mockResolvedValue([source('d1')]);
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('YouTube URL'), { target: { value: 'https://youtu.be/x' } });
    listSources.mockResolvedValue([source('d2')]);
    fireEvent.click(screen.getByRole('button', { name: /add from youtube/i }));
    await runOutThePoll();

    expect(screen.getByText('Source d2')).toBeTruthy();
    expect(screen.queryByText('Still waiting for that source')).toBeNull();
  });

  it('M2 CONTROL: a list that is UNCHANGED still raises the give-up', async () => {
    // Without this the assertion above passes for a surface that never stalls.
    listSources.mockResolvedValue([source('d1')]);
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('YouTube URL'), { target: { value: 'https://youtu.be/x' } });
    fireEvent.click(screen.getByRole('button', { name: /add from youtube/i }));
    await runOutThePoll();
    expect(screen.getByText('Still waiting for that source')).toBeTruthy();
  });

  it('M9: the recheck RESULT is announced, and the initial give-up still is', async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('YouTube URL'), { target: { value: 'https://youtu.be/x' } });
    fireEvent.click(screen.getByRole('button', { name: /add from youtube/i }));
    await runOutThePoll();
    // The initial give-up announces its TITLE via StateCard. DO NOT BREAK THIS —
    // it was verified correct by the review and is the baseline behaviour.
    expect(announceSpy.mock.calls.map((c) => String(c[0]))).toContain('Still waiting for that source');

    announceSpy.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    // The recheck changed only the BODY, so StateCard's `[announce, title]` key
    // did not fire and a screen-reader user learned nothing from the click.
    expect(announceSpy.mock.calls.map((c) => String(c[0])).join(' | ')).toMatch(/still nothing new/i);

    announceSpy.mockClear();
    listSources.mockRejectedValue(new Error('down'));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(announceSpy.mock.calls.map((c) => String(c[0])).join(' | ')).toMatch(/couldn't check just now/i);
  });
});

describe('ADR 0602 correction round — L7, the liveRef that never reset', () => {
  it('under StrictMode the poll still runs and the pending spinner clears', async () => {
    // PRE-EXISTING. `liveRef` was set false by a cleanup-ONLY effect with a `[]`
    // dep list, so it was never set back to true. StrictMode (main.tsx:80, dev
    // only) mounts → unmounts → remounts: the first cleanup left the flag false
    // for the whole second lifetime, every poll bailed on its first tick, and
    // `summarizing`/`transforming` never cleared — a permanent spinner on every
    // dev interaction, invisible in production and therefore never chased.
    listSources.mockResolvedValue([source('d1')]);
    render(<StrictMode><MemoryRouter><ProjectSourcesPanel projectId="nb1" /></MemoryRouter></StrictMode>);
    await screen.findByLabelText('New note');
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize' }));
    await runOutThePoll();

    // The give-up is REACHED, which is only possible if the poll ran at all.
    expect(screen.getByText('Still waiting for that summary')).toBeTruthy();
    // And the row's pending flag cleared, rather than spinning forever.
    expect(screen.queryByRole('button', { name: 'Summarizing…' })).toBeNull();
  });
});
