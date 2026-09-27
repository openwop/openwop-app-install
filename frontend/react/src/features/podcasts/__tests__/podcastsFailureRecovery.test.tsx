/**
 * ADR 0603 §5 — `PODU-2` / `PODU-3` / `PODU-4`: the notebooks fixes that never
 * transferred to the twin feature.
 *
 * `PODU-2` is `NBU-2`'s exact shape. `ShowsManager` rendered a failure card ABOVE a
 * skeleton that spun forever (`shows` stayed `null` on the catch), `error` was never
 * cleared, and there was no retry — the only recovery was reloading the page. Note
 * the card DID pass `announce`, so `check-failure-card-announce` was satisfied by its
 * own criterion; nothing in the tree asked about RECOVERY. That gate now exists
 * (`check-failure-card-recovery.mjs`) and it CANNOT see what these tests see: it
 * checks the `action` prop is present, never that it re-runs the read.
 *
 * `PODU-3`/`-4` are `NBU-6`'s shape and worse: `.catch(() => undefined)` swallowed
 * every poll failure, there was no bound at all, `runId` was on the type and rendered
 * nowhere, and an `awaiting-approval` episode polled forever with Delete as its only
 * action. Ported from ADR 0602's poller in its CORRECTED form (its first cut
 * re-committed the inversion it existed to remove):
 *   - the give-up is not a failure claim;
 *   - it clears only on EVIDENCE, and evidence is the exact episode IDs — not a count;
 *   - an ERRORED recheck is never rendered as "still working";
 *   - the recheck outcome is ANNOUNCED (`StateCard`'s announce effect is keyed on the
 *     title, and a recheck changes only the body — so it would be sighted-only).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const {
  listShowsWithCapability, listShows, listEpisodes, listEpisodesWithCapability,
  listSpeakerProfiles, listEpisodeProfiles, listOrgs, listNotebooksForPodcasts,
} = vi.hoisted(() => ({
  listShowsWithCapability: vi.fn(), listShows: vi.fn(), listEpisodes: vi.fn(),
  listEpisodesWithCapability: vi.fn(), listSpeakerProfiles: vi.fn(),
  listEpisodeProfiles: vi.fn(), listOrgs: vi.fn(), listNotebooksForPodcasts: vi.fn(),
}));
vi.mock('../podcastsClient.js', async (orig) => ({
  ...(await orig<typeof import('../podcastsClient.js')>()),
  listShowsWithCapability, listShows, listEpisodes, listEpisodesWithCapability,
  listSpeakerProfiles, listEpisodeProfiles, listOrgs, listNotebooksForPodcasts,
}));
const { announceSpy } = vi.hoisted(() => ({ announceSpy: vi.fn() }));
vi.mock('../../../ui/announce.js', () => ({ announce: announceSpy }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { ShowsManager } from '../ShowsManager.js';
import { PodcastStudioPage, POLL_MAX_ATTEMPTS } from '../PodcastStudioPage.js';

const SHOW = {
  id: 'sh1', orgId: 'o1', slug: 'acme-hour', title: 'The Acme Hour', author: 'Acme',
  description: 'Weekly talk', languageCode: 'en', explicit: false,
  type: 'episodic' as const, published: false, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};

afterEach(() => { cleanup(); vi.useRealTimers(); });
beforeEach(() => vi.clearAllMocks());

// ───────────────────────────── PODU-2 ─────────────────────────────

describe('PODU-2 — a failed show read is recoverable, and never claims the list is empty', () => {
  const mount = async (): Promise<void> => {
    render(<MemoryRouter><ShowsManager orgId="o1" /></MemoryRouter>);
    await act(async () => {});
  };

  it('SUPPRESSES the empty state while the failure card stands', async () => {
    listShowsWithCapability.mockRejectedValue(new Error('network down'));
    await mount();
    expect(screen.getByText('network down')).toBeTruthy();
    // The regression: stopping the forever-skeleton by setting `shows = []` would
    // otherwise render "No shows yet" — a claim about the server from a read that
    // never landed. A hang traded for a lie is not a fix.
    expect(screen.queryByText(/no shows yet/i)).toBeNull();
  });

  it('CONTROL: that same empty state DOES render when the read succeeds with none', async () => {
    // Without this, the assertion above would be satisfied by copy that never
    // renders at all — the discriminating half of the pair.
    listShowsWithCapability.mockResolvedValue({ shows: [], canWrite: true });
    await mount();
    expect(screen.getByText(/no shows yet/i)).toBeTruthy();
  });

  it('the retry RE-RUNS the read and clears the error on success', async () => {
    listShowsWithCapability.mockRejectedValueOnce(new Error('network down'));
    await mount();
    expect(listShowsWithCapability).toHaveBeenCalledTimes(1); // floor: it really did read
    listShowsWithCapability.mockResolvedValue({ shows: [SHOW], canWrite: true });

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await act(async () => {});
    expect(listShowsWithCapability).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('network down')).toBeNull(); // the card cannot outlive the failure
    expect(screen.getByText('The Acme Hour')).toBeTruthy();
  });

  it('a retry that fails AGAIN keeps a card that names the new failure', async () => {
    listShowsWithCapability.mockRejectedValueOnce(new Error('first failure'));
    await mount();
    listShowsWithCapability.mockRejectedValueOnce(new Error('second failure'));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await act(async () => {});
    expect(screen.getByText('second failure')).toBeTruthy();
    expect(screen.queryByText('first failure')).toBeNull();
    expect(screen.queryByText(/no shows yet/i)).toBeNull();
  });
});

// ──────────────────────── PODU-3 / PODU-4 ─────────────────────────

const EPISODE = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ep1', tenantId: 't1', orgId: 'o1', notebookId: 'nb1', episodeProfileId: 'epp1',
  title: 'Episode One', status: 'running', runId: 'run-1', clips: [],
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', ...over,
});

/** Drive the studio to the poll's give-up: the cap is 60 × 3 s. */
async function mountStudioAndExhaustPoll(): Promise<void> {
  vi.useFakeTimers();
  render(<MemoryRouter><PodcastStudioPage /></MemoryRouter>);
  await act(async () => { await Promise.resolve(); });
  // 60 interval ticks; each schedules an async read whose promise must settle.
  for (let i = 0; i < 61; i += 1) {
    await act(async () => { vi.advanceTimersByTime(3000); await Promise.resolve(); });
  }
}

describe('PODU-3/-4 — the generation poll gives up HONESTLY and offers a way on', () => {
  beforeEach(() => {
    listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    listNotebooksForPodcasts.mockResolvedValue({ notebooks: [{ id: 'nb1', name: 'Research' }], featureUnavailable: false });
    listSpeakerProfiles.mockResolvedValue([]);
    listEpisodeProfiles.mockResolvedValue([]);
    listShows.mockResolvedValue([SHOW]);
    listEpisodesWithCapability.mockImplementation(async () => ({ episodes: [EPISODE()], canWrite: true }));
    listEpisodes.mockImplementation(async () => [EPISODE()]);
  });

  it('the poll is BOUNDED and the give-up STATES itself — never "it failed"', async () => {
    await mountStudioAndExhaustPoll();
    const card = screen.getByText(/we stopped checking after about/i);
    expect(card).toBeTruthy();
    // The register is the whole point: a timeout rendered as a failure claim would
    // satisfy any weaker assertion.
    expect(card.textContent).toMatch(/not a report that it failed/i);
    // BOUNDED: the read stopped. Anything at all would satisfy `> 0`, so assert the
    // cap itself — an unbounded poll keeps climbing past it.
    const callsAtGiveUp = listEpisodes.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(30000); await Promise.resolve(); });
    expect(listEpisodes.mock.calls.length).toBe(callsAtGiveUp);
    expect(callsAtGiveUp).toBeGreaterThanOrEqual(55); // floor: it really polled
  });

  it('`C1` — the WITNESS models real response identity (a stable-reference mock hides the whole class)', async () => {
    // `mockResolvedValue([EPISODE()])` hands back the SAME array instance on every
    // call. React's `Object.is` bailout then suppresses the re-render, the polling
    // effect is never torn down, and its attempt counter accumulates — which is
    // precisely the condition production NEVER has, because `fetch(...).json()`
    // allocates a fresh object per response. Every assertion in this describe
    // block rests on that, so it is asserted rather than assumed.
    const a = await listEpisodes('o1');
    const b = await listEpisodes('o1');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('`C1` — a SUCCEEDING poll still reaches the bound: a fresh response does not reset the counter', async () => {
    vi.useFakeTimers();
    render(<MemoryRouter><PodcastStudioPage /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    // One tick short of the cap. Each of these reads SUCCEEDS, so the regression
    // (`episodes` in the effect's deps, `attempts` an effect-local) restarts the
    // effect on every one of them and the counter never passes 1.
    for (let i = 0; i < POLL_MAX_ATTEMPTS - 1; i += 1) {
      await act(async () => { vi.advanceTimersByTime(3000); await Promise.resolve(); });
    }
    expect(listEpisodes.mock.calls.length).toBe(POLL_MAX_ATTEMPTS - 1); // no tick was lost to a restart
    expect(screen.queryByText(/we stopped checking after about/i)).toBeNull();
    // ...and the very next one crosses it. Asserting the EXACT tick is what makes
    // this a bound rather than "it eventually stops".
    await act(async () => { vi.advanceTimersByTime(3000); await Promise.resolve(); });
    expect(listEpisodes.mock.calls.length).toBe(POLL_MAX_ATTEMPTS);
    expect(screen.getByText(/we stopped checking after about/i)).toBeTruthy();
  });

  it('PODU-4: a non-terminal episode links its RUN (it was on the type and rendered nowhere)', async () => {
    vi.useFakeTimers();
    render(<MemoryRouter><PodcastStudioPage /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    const link = screen.getByRole('link', { name: /view the run/i });
    expect(link.getAttribute('href')).toBe('/runs/run-1');
  });

  it('"Check again" that finds it FINISHED clears the card and announces', async () => {
    await mountStudioAndExhaustPoll();
    expect(screen.getByText(/we stopped checking after about/i)).toBeTruthy();
    listEpisodes.mockResolvedValue([EPISODE({ status: 'done' })]);
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByText(/we stopped checking after about/i)).toBeNull();
    expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/finished/i));
  });

  it('"Check again" that finds it STILL RUNNING is observable (a changing count)', async () => {
    await mountStudioAndExhaustPoll();
    expect(screen.getByText(/we stopped checking after about/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // NBU-19: a retry whose screen is byte-identical before and after is a button
    // that did nothing.
    expect(screen.getByText(/checked 1 more time/i)).toBeTruthy();
    expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/still working/i));
  });

  it('`M1` — an ERRORED recheck is NOT rendered as evidence of absence', async () => {
    await mountStudioAndExhaustPoll();
    expect(screen.getByText(/we stopped checking after about/i)).toBeTruthy();
    listEpisodes.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // "we couldn't check" — a claim about the REQUEST...
    expect(screen.getByText(/couldn't check just now/i)).toBeTruthy();
    // ...and NOT "still working", which is a claim about the SERVER made from a
    // request that never reached it. The count counts observations; this was none.
    expect(screen.queryByText(/checked 1 more time/i)).toBeNull();
  });

  it('`M2` — evidence is the EXACT episode ids, not a count', async () => {
    await mountStudioAndExhaustPoll();
    expect(screen.getByText(/we stopped checking after about/i)).toBeTruthy();
    // An UNRELATED new episode arrives while ep1 is still running. A length/count
    // predicate would clear the card and tell the user their episode had finished.
    listEpisodes.mockResolvedValue([EPISODE({ status: 'done' }), EPISODE({ id: 'ep2', status: 'running', runId: 'run-2' })]);
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // ep1 (the one we were waiting on) IS done, so the card clears — correctly, and
    // for the right reason: the id it tracked is no longer pending.
    expect(screen.queryByText(/we stopped checking after about/i)).toBeNull();
  });
});

// ───────────────────────────── PODU-8 ─────────────────────────────
//
// A DISABLED notebooks feature is not an empty one. The Studio told a user whose
// administrator had switched notebooks off to "create a research notebook first" —
// an instruction with no surface to perform it on. The client's own test had PINNED
// the conflation (`404 → []`); both are fixed.

describe('PODU-8 — "notebooks is off" and "you have no notebooks" are different cards', () => {
  const mountStudio = async (): Promise<void> => {
    render(<MemoryRouter><PodcastStudioPage /></MemoryRouter>);
    await act(async () => {});
    await act(async () => {});
  };

  beforeEach(() => {
    listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    listSpeakerProfiles.mockResolvedValue([]);
    listEpisodeProfiles.mockResolvedValue([]);
    listShows.mockResolvedValue([]);
    listShowsWithCapability.mockResolvedValue({ shows: [], canWrite: true });
    listEpisodesWithCapability.mockResolvedValue({ episodes: [], canWrite: true });
    listEpisodes.mockResolvedValue([]);
  });

  it('feature OFF: says so, and never issues the instruction the user cannot follow', async () => {
    listNotebooksForPodcasts.mockResolvedValue({ notebooks: [], featureUnavailable: true });
    await mountStudio();
    expect(screen.getByText(/research notebooks are turned off/i)).toBeTruthy();
    expect(screen.queryByText(/create a research notebook first/i)).toBeNull();
  });

  it('CONTROL — feature ON with none: the instruction IS right, and still renders', async () => {
    // The discriminating half: without it, the assertion above would be satisfied by
    // copy that was deleted rather than conditioned.
    listNotebooksForPodcasts.mockResolvedValue({ notebooks: [], featureUnavailable: false });
    await mountStudio();
    expect(screen.getByText(/create a research notebook first/i)).toBeTruthy();
    expect(screen.queryByText(/research notebooks are turned off/i)).toBeNull();
  });
});
