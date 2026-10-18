/**
 * The failed-read class where the swallowed value drives a DECISION, not copy.
 *
 * `check-failed-read-sentinels.mjs` bounds the shape; this file pins the five
 * cases where `.catch(() => …)` did something worse than mislabel a list:
 *
 *  D-1  DashboardPage — a failed layout read set `saved = null`, which is also
 *       "the server says you have none". `mergeForPersist` preserves rows only
 *       from that argument, so the FIRST customize action wrote the DEFAULTS
 *       OVER the user's real stored layout. Data loss, server-side, silent.
 *  D-2  finalizeSession — a failed `/me` was published into the canonical
 *       signed-in store as `{ user: null, resolved: true }`: "this account has
 *       no durable user, settled".
 *  D-3  RealtimeVoiceSettings — an unreadable key list made the ADR 0499
 *       missing-binding alarm fire on a HEALTHY binding, telling the operator
 *       their key was deleted and voice would fail.
 *  D-4  EvalsDrawer — an unreadable revision head skipped the staleness check
 *       and chose the OPTIMISTIC branch, so the chip promised "all green" on a
 *       result the publish gate would refuse as stale.
 *  D-5  useVoiceTranscriptStream — a failed capability probe read as "not
 *       openai-realtime" and silently disabled the only transcript path.
 *
 * Each case fails against the pre-fix code, with ONE recorded exception:
 * D-1's write refusal is a DOUBLE GUARD — the Customize button is
 * `disabled={layoutFailed}` AND `persist()` returns early on `layoutFailed`.
 * No UI route reaches `persist` while the button is disabled, so removing the
 * persist guard alone stays green here by design (/grade-tests w50 probe
 * `frd-persist-guard`). What both guards read — `layoutFailed`, set by the
 * read's catch — is probed instead (`frd-catch`, `frd-disabled`).
 *
 * Tile bodies are not mounted (`LazyMount` is stubbed): D-1 is about the layout
 * read, and the tile bodies' own reads (chat sessions, notifications) were live
 * fetches racing the end of the test (ADR 0661 allowlist, w50).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '../features/users/usersClient.js';
import type { WorkflowEvalResultDTO, WorkflowEvalSetDTO } from '../workflows/workflowEvalsClient.js';
import type { WorkflowRevisionRow } from '../workflows/workflowsClient.js';

afterEach(() => { cleanup(); vi.resetAllMocks(); });

// ── D-1 ───────────────────────────────────────────────────────────────────
const { getLayout, putLayout } = vi.hoisted(() => ({ getLayout: vi.fn(), putLayout: vi.fn() }));
vi.mock('../features/dashboard/dashboardClient.js', async (orig) => ({
  ...(await orig<typeof import('../features/dashboard/dashboardClient.js')>()),
  getLayout, putLayout,
}));
vi.mock('../features/dashboard/LazyMount.js', () => ({ LazyMount: () => null }));
vi.mock('../auth/useAuth.js', () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock('../auth/backendSession.js', async (orig) => ({
  ...(await orig<typeof import('../auth/backendSession.js')>()),
  useBackendSession: () => ({ user: null, resolved: true }),
}));
vi.mock('../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  useFeatureLocked: () => () => false,
  useAllFeatureAccess: () => ({ loading: false, resolved: true }),
}));
vi.mock('../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: () => ({ access: null, resolved: true }),
  isAdminCaller: () => false,
}));

import { DashboardPage } from '../features/dashboard/DashboardPage.js';

const DEFAULT_TILES = /default tiles/i;

describe('D-1 · dashboard layout — a failed read must never be persisted over', () => {
  beforeEach(() => { vi.useFakeTimers(); putLayout.mockResolvedValue(undefined); });
  afterEach(() => { vi.useRealTimers(); });

  it('never writes at all while the layout is unreadable', async () => {
    getLayout.mockRejectedValue(new Error('offline'));
    await act(async () => { render(<DashboardPage />); });
    expect(screen.getByText(DEFAULT_TILES)).toBeTruthy(); // settled into the failed state
    // Try the user's route to a write: Customize, then a tile control.
    fireEvent.click(screen.getByRole('button', { name: /customize/i }));
    expect(screen.queryAllByRole('button', { name: 'Move down' }), 'a customize control is reachable on an unread layout').toEqual([]);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(putLayout).not.toHaveBeenCalled();
  });

  it('says the tiles are defaults, not the user’s arrangement', async () => {
    getLayout.mockRejectedValue(new Error('offline'));
    await act(async () => { render(<DashboardPage />); });
    expect(screen.getByText(DEFAULT_TILES)).toBeTruthy();
  });

  it('disables Customize while the layout is unreadable (no edit can reach persist)', async () => {
    getLayout.mockRejectedValue(new Error('offline'));
    await act(async () => { render(<DashboardPage />); });
    const btn = screen.getByRole('button', { name: /customize/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // WHY THE GUARD IS THE FIX AND NOT BETTER COPY. This pins the destructive
  // mechanism itself: `mergeForPersist` can only preserve rows it is GIVEN, so
  // persisting against a baseline we never read discards every saved tile that
  // isn't in the current working set. The page guard exists because this
  // function cannot tell "no layout" from "unread layout" — and must not try.
  it('MECHANISM — merging against a null baseline drops the user’s saved rows', async () => {
    const { mergeForPersist } = await import('../features/dashboard/resolveTiles.js');
    const ids = new Set(['a', 'b', 'kept']);
    const realSaved = [{ id: 'kept', order: 9, size: 'full' as const, enabled: true }];
    const working = [{ id: 'a', order: 0, size: 'half' as const, enabled: true }];
    expect(mergeForPersist(realSaved, working, ids).map((r) => r.id)).toContain('kept');
    // The same write with the baseline a failed read would have supplied:
    expect(mergeForPersist(null, working, ids).map((r) => r.id)).not.toContain('kept');
  });

  it('SABOTAGE — a genuine "no saved layout" answer still customizes and persists', async () => {
    getLayout.mockResolvedValue(null); // the server said: nothing saved
    await act(async () => { render(<DashboardPage />); });
    const btn = screen.getByRole('button', { name: /customize/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.queryByText(DEFAULT_TILES)).toBeNull();
    // The write path the failed case is refused from really writes here.
    fireEvent.click(btn);
    const move = screen.getAllByRole('button', { name: 'Move down' }).find((b) => !(b as HTMLButtonElement).disabled);
    expect(move, 'no enabled Move down control in customize mode').toBeDefined();
    fireEvent.click(move!);
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(putLayout).toHaveBeenCalledTimes(1);
  });
});

// ── D-2 ───────────────────────────────────────────────────────────────────
const { getMe, bindOidc, migrateAnonToUser, getCurrentIdToken } = vi.hoisted(() => ({
  getMe: vi.fn(), bindOidc: vi.fn(), migrateAnonToUser: vi.fn(), getCurrentIdToken: vi.fn(),
}));
vi.mock('../features/users/usersClient.js', async (orig) => ({
  ...(await orig<typeof import('../features/users/usersClient.js')>()),
  getMe, bindOidc,
}));
vi.mock('../auth/migrateTenant.js', () => ({ migrateAnonToUser }));
vi.mock('../auth/firebase.js', () => ({ getCurrentIdToken }));

import { finalizeFirebaseSession } from '../auth/finalizeSession.js';

describe('D-2 · finalizeSession — unreadable /me is not "no durable user"', () => {
  beforeEach(() => {
    getCurrentIdToken.mockResolvedValue('tok');
    migrateAnonToUser.mockResolvedValue({ migrated: false });
    bindOidc.mockResolvedValue(null);
  });

  it('reports ok:false when /me cannot be read', async () => {
    getMe.mockRejectedValue(new Error('network'));
    await expect(finalizeFirebaseSession()).resolves.toEqual({ ok: false });
  });

  it('SABOTAGE — a real "no user" answer is still reported as a READ answer', async () => {
    getMe.mockResolvedValue(null);
    await expect(finalizeFirebaseSession()).resolves.toEqual({ ok: true, user: null });
  });

  it('distinguishes the two — the old shape collapsed both to null', async () => {
    getMe.mockRejectedValue(new Error('network'));
    const failed = await finalizeFirebaseSession();
    getMe.mockResolvedValue(null);
    const answered = await finalizeFirebaseSession();
    expect(failed).not.toEqual(answered);
  });
});

// ── D-3 / D-5 voice client (one mock: a module may be mocked once) ─────────
const { getRealtimeConfig, getRealtimeCapability, subscribeVoiceTranscripts } = vi.hoisted(() => ({
  getRealtimeConfig: vi.fn(), getRealtimeCapability: vi.fn(), subscribeVoiceTranscripts: vi.fn(),
}));
vi.mock('../chat/voice/voiceClient.js', async (orig) => ({
  ...(await orig<typeof import('../chat/voice/voiceClient.js')>()),
  getRealtimeCapability, subscribeVoiceTranscripts, getRealtimeConfig,
}));

import { RealtimeVoiceSettings } from '../byok/RealtimeVoiceSettings.js';

describe('D-3 · realtime voice keys — unreadable list must not condemn the binding', () => {
  beforeEach(() => {
    getRealtimeConfig.mockResolvedValue({ provider: 'openai-realtime', credentialRef: 'openai:prod' });
  });

  it('does NOT claim the configured key is gone when the list was unreadable', async () => {
    await act(async () => { render(<RealtimeVoiceSettings storedRefs={[]} refsUnreadable />); });
    // The ADR 0499 alarm text keys on the ref; it must not appear.
    expect(screen.queryByText(/openai:prod/)).toBeNull();
    expect(screen.getByText(/can’t tell whether the configured key still exists/i)).toBeTruthy();
  });

  it('SABOTAGE — a genuinely absent key still raises the ADR 0499 alarm', async () => {
    await act(async () => { render(<RealtimeVoiceSettings storedRefs={['other:key']} />); });
    // The alarm itself (literal en copy), not just the ref in the <select>.
    expect(screen.getByText(/but that key no longer exists/)).toBeTruthy();
  });
});

// ── D-4 ───────────────────────────────────────────────────────────────────
const { listEvalSets, listEvalResults, listOnlineBuckets, listWorkflowRevisions } = vi.hoisted(() => ({
  listEvalSets: vi.fn(), listEvalResults: vi.fn(), listOnlineBuckets: vi.fn(), listWorkflowRevisions: vi.fn(),
}));
vi.mock('../workflows/workflowEvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../workflows/workflowEvalsClient.js')>()),
  listEvalSets, listEvalResults, listOnlineBuckets,
}));
vi.mock('../workflows/workflowsClient.js', async (orig) => ({
  ...(await orig<typeof import('../workflows/workflowsClient.js')>()),
  listWorkflowRevisions,
}));

import { EvalsDrawer } from '../builder/EvalsDrawer.js';

const EVAL_SET: WorkflowEvalSetDTO = {
  workflowId: 'wf1', evalSetId: 'set1', name: 'Smoke', requiredForPromote: true,
  cases: [
    { caseId: 'c1', assertions: [] },
    { caseId: 'c2', assertions: [] },
  ],
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
};
const GREEN_RESULT: WorkflowEvalResultDTO = {
  workflowId: 'wf1', evalSetId: 'set1', resultId: 'r1', revisionHash: 'h1', status: 'complete',
  cases: [
    { caseId: 'c1', runId: 'run1', status: 'passed', assertions: [] },
    { caseId: 'c2', runId: 'run2', status: 'passed', assertions: [] },
  ],
  startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:01:00.000Z',
};
const HEAD_H1: WorkflowRevisionRow = { revisionHash: 'h1', createdAt: '2026-10-01T00:00:00.000Z', nodeCount: 3, published: false, isHead: true };

describe('D-4 · eval chip — unverifiable freshness must not read as plain green', () => {
  it('the unverified chip and the green chip are different claims', async () => {
    listEvalSets.mockResolvedValue([EVAL_SET]);
    listEvalResults.mockResolvedValue([GREEN_RESULT]);
    listOnlineBuckets.mockResolvedValue([]);

    // Unreadable head → the honest chip, never plain green.
    listWorkflowRevisions.mockRejectedValue(new Error('revisions_503'));
    const first = render(<MemoryRouter><EvalsDrawer workflowId="wf1" open onClose={() => undefined} /></MemoryRouter>);
    expect(await screen.findByText('Green — freshness unverified')).toBeTruthy();
    expect(screen.queryByText('All 2 cases green')).toBeNull();
    first.unmount();

    // Positive control: a readable head that matches → plain green.
    listWorkflowRevisions.mockResolvedValue([HEAD_H1]);
    render(<MemoryRouter><EvalsDrawer workflowId="wf1" open onClose={() => undefined} /></MemoryRouter>);
    expect(await screen.findByText('All 2 cases green')).toBeTruthy();
    expect(screen.queryByText('Green — freshness unverified')).toBeNull();
  });
});

// ── D-5 ───────────────────────────────────────────────────────────────────
import { useVoiceTranscriptStream } from '../chat/voice/useVoiceTranscriptStream.js';

/** Advance the hook's retry backoff (400 ms, then 800 ms) on the fake clock. */
const advance = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('D-5 · voice transcripts — a failed probe is retried, not read as "not openai"', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); subscribeVoiceTranscripts.mockReturnValue(() => undefined); });
  afterEach(() => { vi.useRealTimers(); });

  it('retries the capability probe before giving up', async () => {
    getRealtimeCapability.mockRejectedValue(new Error('offline'));
    const reload = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useVoiceTranscriptStream('c1', true, reload));
    await vi.waitFor(() => { expect(getRealtimeCapability).toHaveBeenCalledTimes(1); });
    await advance(400);
    await advance(800);
    await advance(2000); // well past the last backoff: no fourth attempt
    expect(getRealtimeCapability).toHaveBeenCalledTimes(3);
    expect(subscribeVoiceTranscripts).not.toHaveBeenCalled();
  });

  it('subscribes once the probe succeeds on a retry', async () => {
    getRealtimeCapability
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ provider: 'openai-realtime' });
    const reload = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useVoiceTranscriptStream('c1', true, reload));
    await vi.waitFor(() => { expect(getRealtimeCapability).toHaveBeenCalledTimes(1); });
    await advance(400);
    await vi.waitFor(() => { expect(subscribeVoiceTranscripts).toHaveBeenCalledWith('c1', expect.any(Function)); });
    expect(getRealtimeCapability).toHaveBeenCalledTimes(2);
  });

  it('SABOTAGE — a definite non-openai answer still no-ops after ONE probe', async () => {
    getRealtimeCapability.mockResolvedValue({ provider: 'gemini-live' });
    const reload = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useVoiceTranscriptStream('c1', true, reload));
    await vi.waitFor(() => { expect(getRealtimeCapability).toHaveBeenCalledTimes(1); });
    // Past every retry slot: a definite answer is never re-asked.
    await advance(2000);
    expect(getRealtimeCapability).toHaveBeenCalledTimes(1);
    expect(subscribeVoiceTranscripts).not.toHaveBeenCalled();
  });
});

// ── D-6 (grade-data FRD-1) ─────────────────────────────────────────────────
/**
 * The WIDER half of D-2. `finalizeSession` was fixed in #2910, but
 * `refreshBackendSession` ran the same `.catch(() => publish({user:null,
 * resolved:true}))` into the SAME store — and it runs on every SignInButton
 * mount, not just the OAuth redirect, so it was the bigger hole. Its doc
 * claimed "a 401/404 settles to null", which `getMe` could not support while
 * it threw an untyped Error: 404 and 503 arrived identically.
 */
const ADA: User = {
  userId: 'u1', tenantId: 't1', principalId: 'p1', displayName: 'Ada', groups: [],
  source: 'oidc', status: 'active', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('D-6 · refreshBackendSession — unreadable is not "no user"', () => {
  it('a TRANSPORT failure leaves the prior snapshot alone', async () => {
    // D-1 above mocks `useBackendSession` to a constant, so the REAL module is
    // what this must assert against — reading the mock would pass or fail for
    // reasons that have nothing to do with the store.
    const real = await vi.importActual<typeof import('../auth/backendSession.js')>('../auth/backendSession.js');
    real.setBackendSessionUser(ADA);
    getMe.mockRejectedValue(new Error('network down'));
    await real.refreshBackendSession();
    const { result } = renderHook(() => real.useBackendSession());
    expect(result.current).toEqual({ user: ADA, resolved: true });
  });

  it('SABOTAGE — a definitive 404 still settles to null', async () => {
    const { UsersApiError } = await import('../features/users/usersClient.js');
    const real = await vi.importActual<typeof import('../auth/backendSession.js')>('../auth/backendSession.js');
    real.setBackendSessionUser(ADA);
    getMe.mockRejectedValue(new UsersApiError('users off', 404));
    await real.refreshBackendSession();
    const { result } = renderHook(() => real.useBackendSession());
    expect(result.current.user).toBeNull();
  });
});
