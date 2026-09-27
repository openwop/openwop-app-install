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
 * Every assertion here fails against the pre-fix code; that is the point.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { renderHook } from '@testing-library/react';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// ── D-1 ───────────────────────────────────────────────────────────────────
const { getLayout, putLayout } = vi.hoisted(() => ({ getLayout: vi.fn(), putLayout: vi.fn() }));
vi.mock('../features/dashboard/dashboardClient.js', async (orig) => ({
  ...(await orig<typeof import('../features/dashboard/dashboardClient.js')>()),
  getLayout, putLayout,
}));
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

describe('D-1 · dashboard layout — a failed read must never be persisted over', () => {
  beforeEach(() => { vi.useFakeTimers(); putLayout.mockResolvedValue(undefined); });
  afterEach(() => { vi.useRealTimers(); });

  it('never writes at all while the layout is unreadable', async () => {
    getLayout.mockRejectedValue(new Error('offline'));
    await act(async () => { render(<DashboardPage />); });
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(putLayout).not.toHaveBeenCalled();
  });

  it('says the tiles are defaults, not the user’s arrangement', async () => {
    getLayout.mockRejectedValue(new Error('offline'));
    await act(async () => { render(<DashboardPage />); });
    expect(screen.getByText(/default tiles/i)).toBeTruthy();
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
    expect(screen.queryByText(/default tiles/i)).toBeNull();
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

// ── D-3 ───────────────────────────────────────────────────────────────────
const { getRealtimeConfig } = vi.hoisted(() => ({ getRealtimeConfig: vi.fn() }));
vi.mock('../chat/voice/voiceClient.js', async (orig) => ({
  ...(await orig<typeof import('../chat/voice/voiceClient.js')>()),
  getRealtimeConfig,
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
    expect(screen.getAllByText(/openai:prod/).length).toBeGreaterThan(0);
  });
});

// ── D-4 ───────────────────────────────────────────────────────────────────
describe('D-4 · eval chip — unverifiable freshness must not read as plain green', () => {
  it('the unverified chip and the green chip are different claims', async () => {
    const en = (await import('../builder/i18n/en.js')).messages as unknown as Record<string, string>;
    expect(en.evalsGreenUnverified).toBeTruthy();
    expect(en.evalsGreenUnverified).not.toEqual(en.evalsGreen);
    // The honest chip must not promise; it must warn the gate may refuse.
    expect(en.evalsGreenUnverifiedTitle).toMatch(/refuse|stale/i);
  });
});

// ── D-5 ───────────────────────────────────────────────────────────────────
const { getRealtimeCapability, subscribeVoiceTranscripts } = vi.hoisted(() => ({
  getRealtimeCapability: vi.fn(), subscribeVoiceTranscripts: vi.fn(),
}));
vi.mock('../chat/voice/voiceClient.js', async (orig) => ({
  ...(await orig<typeof import('../chat/voice/voiceClient.js')>()),
  getRealtimeCapability, subscribeVoiceTranscripts, getRealtimeConfig,
}));

import { useVoiceTranscriptStream } from '../chat/voice/useVoiceTranscriptStream.js';

describe('D-5 · voice transcripts — a failed probe is retried, not read as "not openai"', () => {
  it('retries the capability probe before giving up', async () => {
    getRealtimeCapability.mockRejectedValue(new Error('offline'));
    subscribeVoiceTranscripts.mockReturnValue(() => undefined);
    const reload = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      renderHook(() => useVoiceTranscriptStream('c1', true, reload));
    });
    await waitFor(() => { expect(getRealtimeCapability.mock.calls.length).toBeGreaterThan(1); }, { timeout: 3000 });
  });

  it('subscribes once the probe succeeds on a retry', async () => {
    getRealtimeCapability
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ provider: 'openai-realtime' });
    subscribeVoiceTranscripts.mockReturnValue(() => undefined);
    const reload = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      renderHook(() => useVoiceTranscriptStream('c1', true, reload));
    });
    await waitFor(() => { expect(subscribeVoiceTranscripts).toHaveBeenCalled(); }, { timeout: 3000 });
  });

  it('SABOTAGE — a definite non-openai answer still no-ops after ONE probe', async () => {
    getRealtimeCapability.mockResolvedValue({ provider: 'gemini-live' });
    subscribeVoiceTranscripts.mockReturnValue(() => undefined);
    const reload = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      renderHook(() => useVoiceTranscriptStream('c1', true, reload));
    });
    await waitFor(() => { expect(getRealtimeCapability).toHaveBeenCalledTimes(1); });
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
describe('D-6 · refreshBackendSession — unreadable is not "no user"', () => {
  it('a TRANSPORT failure leaves the prior snapshot alone', async () => {
    // D-1 above mocks `useBackendSession` to a constant, so the REAL module is
    // what this must assert against — reading the mock would pass or fail for
    // reasons that have nothing to do with the store.
    const real = await vi.importActual<typeof import('../auth/backendSession.js')>('../auth/backendSession.js');
    real.setBackendSessionUser({ userId: 'u1', displayName: 'Ada' } as never);
    getMe.mockRejectedValue(new Error('network down'));
    await real.refreshBackendSession();
    const { result } = renderHook(() => real.useBackendSession());
    expect(result.current.user).not.toBeNull();
  });

  it('SABOTAGE — a definitive 404 still settles to null', async () => {
    const { UsersApiError } = await import('../features/users/usersClient.js');
    const real = await vi.importActual<typeof import('../auth/backendSession.js')>('../auth/backendSession.js');
    real.setBackendSessionUser({ userId: 'u1', displayName: 'Ada' } as never);
    getMe.mockRejectedValue(new UsersApiError('users off', 404));
    await real.refreshBackendSession();
    const { result } = renderHook(() => real.useBackendSession());
    expect(result.current.user).toBeNull();
  });
});
