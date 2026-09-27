/**
 * A failed WRITE must reach the user — and must not take their unsaved work
 * off screen doing it.
 *
 * The mirror of the failed-READ family. A whole programme of work went into
 * reads that lie; these three writes swallowed their rejection through all of
 * it, because the ratchet counts reads and nobody was counting writes. The
 * symptom: the UI shows the edit as applied, the server never took it, and the
 * user finds out on the next load, if ever.
 *
 * W-1  DashboardPage — the debounced layout save swallowed its failure. One
 *      notice per failure EPISODE (a drag re-fires the debounce), cleared by
 *      the next success.
 * W-2  PersonalNoteTile — the SHARPER half. The save failure was routed into
 *      the same `error` flag the READ uses, and that flag swaps the whole tile
 *      for a one-line message — so a failed save REPLACED the textarea and took
 *      the user's unsaved text off screen with no way back. Losing sight of
 *      unsaved work is worse than the silence this set out to fix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { putNote, getNote } = vi.hoisted(() => ({ putNote: vi.fn(), getNote: vi.fn() }));
vi.mock('../dashboardClient.js', async (orig) => ({
  ...(await orig<typeof import('../dashboardClient.js')>()),
  putNote, getNote,
}));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('../../../ui/toast.js', async (orig) => ({
  ...(await orig<typeof import('../../../ui/toast.js')>()),
  toast: { success: vi.fn(), error: toastError, info: vi.fn() },
}));

// NO react-i18next mock. vitest.config.ts bootstraps real i18n via
// `setupFiles` precisely so component tests assert the copy a user sees, and
// replacing the module wholesale ALSO broke five unrelated peer specs in the
// full-suite run (they pass in isolation) — a mock that returns only
// `useTranslation` starves every other consumer in the same worker.
import PersonalNoteTile from '../tiles/PersonalNoteTile.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
beforeEach(() => { getNote.mockResolvedValue({ text: 'my work' }); });

describe('W-2 · a failed note save keeps the text on screen', () => {
  it('does NOT replace the textarea when a save fails', async () => {
    vi.useFakeTimers();
    putNote.mockRejectedValue(new Error('offline'));
    await act(async () => { render(<PersonalNoteTile compact={false} />); });
    await act(async () => { await Promise.resolve(); });

    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'my work plus more' } });
    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });

    // THE POINT: the editing surface survives, with the text still in it.
    const still = screen.queryByRole('textbox') as HTMLTextAreaElement | null;
    expect(still, 'the textarea must survive a failed save').toBeTruthy();
    expect(still!.value).toBe('my work plus more');
  });

  it('tells the user, inline and via a toast', async () => {
    vi.useFakeTimers();
    putNote.mockRejectedValue(new Error('offline'));
    await act(async () => { render(<PersonalNoteTile compact={false} />); });
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });

    // ONE channel for a LIVE failure: the persistent inline status line. No
    // toast on this path — the span is long-mounted, so its text change already
    // announces politely, and adding an assertive toast made one failure speak
    // twice (DASHW-14). The earlier `queryByRole('alert')).toBeNull()` proved
    // nothing here anyway: the toast module is mocked, so no alert node could
    // exist by construction. Assert the real contract instead.
    expect(screen.getByRole('status').textContent).toContain('Not saved');
    expect(toastError, 'a live failure uses the inline surface, not a toast').not.toHaveBeenCalled();
  });

  it('the inline surface is idempotent under StrictMode, which is how the app runs', async () => {
    // main.tsx wraps the app in <StrictMode>, which DOUBLE-INVOKES state
    // updaters. The first cut put toast.error inside a setSaveFailed updater and
    // this test passed only because it did not render under StrictMode — it
    // asserted a guarantee the code did not hold. The guard now lives in a ref.
    vi.useFakeTimers();
    putNote.mockRejectedValue(new Error('offline'));
    await act(async () => { render(<StrictMode><PersonalNoteTile compact={false} /></StrictMode>); });
    await act(async () => { await Promise.resolve(); });
    const box = screen.getByRole('textbox');
    for (const v of ['a', 'ab', 'abc']) {
      fireEvent.change(box, { target: { value: v } });
      await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });
    }
    expect(screen.getByRole('status').textContent).toContain('Not saved');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('SABOTAGE — a SUCCESSFUL save still reports saved, and says nothing alarming', async () => {
    vi.useFakeTimers();
    putNote.mockResolvedValue(undefined);
    await act(async () => { render(<PersonalNoteTile compact={false} />); });
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ok' } });
    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });

    expect(toastError).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('Saved');
  });

  it('SABOTAGE — a failed READ still replaces the tile (that IS the right behaviour)', async () => {
    getNote.mockRejectedValue(new Error('offline'));
    await act(async () => { render(<PersonalNoteTile compact={false} />); });
    await act(async () => { await Promise.resolve(); });
    // Nothing was ever loaded, so there is no unsaved work to protect.
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

// ── W-1 ───────────────────────────────────────────────────────────────────
/**
 * The layout lane, which the first cut described but never tested — and it is
 * the one with the riskier logic (a ref-based dedup that only clears on
 * success, so a session-long failure could otherwise go silent after one toast).
 */
const { getLayout, putLayout } = vi.hoisted(() => ({ getLayout: vi.fn(), putLayout: vi.fn() }));
vi.mock('../dashboardClient.js', async (orig) => ({
  ...(await orig<typeof import('../dashboardClient.js')>()),
  putNote, getNote, getLayout, putLayout,
}));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock('../../../auth/backendSession.js', async (orig) => ({
  ...(await orig<typeof import('../../../auth/backendSession.js')>()),
  useBackendSession: () => ({ user: null, resolved: true }),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  useFeatureLocked: () => () => false,
  useAllFeatureAccess: () => ({ loading: false, resolved: true }),
}));
vi.mock('../../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: () => ({ access: null, resolved: true }),
  isAdminCaller: () => false,
}));

// ADR 0661 — `DashboardPage` renders `RecentConversationsTile`, which calls
// `listChatSessions()` in an effect (`tiles/RecentConversationsTile.tsx:20`). This file
// never named that module, so the REAL client ran and hit `/chat/sessions` for real.
// That is cause (2) in the live-fetch guard's own message: "a SHARED cross-feature module
// the test never mentions". It is a RACE — whether the unmocked fetch lands before the
// test finishes depends on machine load, which is why this leg passed in isolation every
// time and failed inside three separate full CI runs (loop iterations 36, 41 and 44).
//
// Mocking it ISOLATES THE SUBJECT rather than hiding a failure: this file is about a
// failed LAYOUT SAVE keeping a standing surface, and the conversations tile's data is
// incidental to that. The sibling `aiBriefingTile.test.tsx:26` already mocks this exact
// module the same way.
vi.mock('../../../client/chatSessionsClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listChatSessions: () => Promise.resolve([]),
}));

// ── ADR 0661, the CLASS this time, not the instance ─────────────────────────────
//
// #3919 mocked `chatSessionsClient` after this suite tripped the live-fetch guard on
// `/chat/sessions`. The very next full run tripped it on `/approvals?status=pending`
// (`ApprovalsInboxTile`). That is the tell: `DashboardPage` renders ~52 tiles, and the
// guard surfaces whichever unmocked fetch happens to land before the test finishes —
// ONE per run, load-dependent, and it passes in isolation every time. Mocking clients
// one URL at a time is whack-a-mole with a ~50-tile board.
//
// MEASURED population: 44 of 52 tiles fetch through TWO shared hooks
// (`useTileData` / `useOrgResource`); 8 fetch directly. Of those 8, one has no client
// calls, one (`PersonalNoteTile`) is already covered by the `dashboardClient` mock
// above, one (`RecentConversationsTile`) by #3919, and the remaining FIVE name four
// client modules. Everything below covers that whole population at once.
//
// WHY THIS ISOLATES THE SUBJECT RATHER THAN HIDING A FAILURE: this suite is W-1 — a
// failed LAYOUT SAVE must keep a standing surface. That branch is `putLayout`
// (mocked at the top of this describe) and is untouched here. Tile DATA is incidental;
// a tile stuck in its honest `loading` state is exactly what a page shows before any
// read resolves. The hooks' fetcher is never invoked, so no network call can exist.
vi.mock('../useTileData.js', () => ({
  useTileData: () => ({ status: 'loading', data: null }),
}));
vi.mock('../useOrgResource.js', () => ({
  useOrgResource: () => ({ status: 'loading', data: null }),
}));
vi.mock('../../../client/runsClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listMyRuns: () => Promise.resolve([]),
}));
vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listEnrollments: () => Promise.resolve([]),
  getProgress: () => Promise.resolve(null),
  getToday: () => Promise.resolve(null),
}));
vi.mock('../../../kanban/kanbanClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAssignedToMe: () => Promise.resolve([]),
}));
vi.mock('../../priority-matrix/priorityMatrixClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPortfolio: () => Promise.resolve([]),
}));

import { DashboardPage } from '../DashboardPage.js';

describe('W-1 · a failed layout save does not go quiet after one toast', () => {
  beforeEach(() => { getLayout.mockResolvedValue(null); });

  it('keeps a STANDING surface, not just a ~5s toast', async () => {
    // The first cut clicked "Customize" and guarded on `putLayout` having been
    // called — but entering customize mode never calls persist(), and the guard
    // let it pass anyway. /grade-code sabotage-proved it: deleting the standing
    // Notice left this green. Drive a REAL edit, and assert unconditionally.
    vi.useFakeTimers();
    putLayout.mockRejectedValue(new Error('offline'));
    await act(async () => { render(<DashboardPage />); });
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole('button', { name: /customize/i }));
    // A tile control inside customize mode is what actually mutates the layout.
    // "Make wide"/"Make compact" is the per-tile control that calls mutate() →
    // persist(); the move buttons are disabled on a single-tile edge.
    const mutators = screen.getAllByRole('button').filter((b) => /make wide|make compact|remove/i.test(b.getAttribute('aria-label') ?? ''));
    expect(mutators.length, 'no layout-mutating control was reachable — the test would prove nothing').toBeGreaterThan(0);
    fireEvent.click(mutators[0]!);
    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });

    expect(putLayout, 'the edit must actually reach a save for this to test anything').toHaveBeenCalled();
    expect(screen.getByText(/isn’t saving/i)).toBeTruthy();
  });
});
