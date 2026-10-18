/**
 * ADR 0873 D12 — offline entitlement: fail closed by default, `last-known` by opt-in.
 *
 * Two halves. The store rules (keying, TTL, revocation, sign-out) are unit tests
 * of `lastKnownEntitlement.ts`. The guard behaviour runs the REAL provider and the
 * REAL guard over mocked fetchers, because the defect class this guards against
 * lives in the wiring: an HTTP error read as "offline", a fallback '*' recorded as
 * a grant, or a grant consulted online.
 *
 * Offline is neither "locked" nor "unlocked": the notice is asserted by its own
 * title, and the locked panel's title is asserted ABSENT beside it.
 *
 * "A REFRESH that loses the network keeps the mounted page" is a DOUBLE guard:
 * FeatureAccessContext's `if (settledOnce.current && !refused) return;` AND its
 * `if (!settledOnce.current) setOffline(unreachable)`. Each single-guard sabotage
 * is a no-op by design; the probe aims at the state both read (`settledOnce`).
 *
 * FAC-REFRESH-ENT5XX-1 (BLOCKED-ON-PRODUCT, ADR 0873 D12 follow-up): a 5xx on the
 * ENTITLEMENT read during a refresh degrades to '*' inside its own catch, so the
 * refresh "succeeds" and a locked feature reads unlocked — the keep-the-previous-
 * answer branch is only reached when the ASSIGNMENTS read fails. Pinned below as
 * `it.fails` with the correct expectation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BundleCommerce, FeatureBundleCatalog, PublicPlanTier } from '../../features/marketplace/marketplaceClient.js';

const { fetchAssignments, fetchEntitlements } = vi.hoisted(() => ({ fetchAssignments: vi.fn(), fetchEntitlements: vi.fn() }));
vi.mock('../../client/featureTogglesClient.js', () => ({ fetchAssignments, fetchEntitlements }));
// The REAL config module (the lazy locked panel's clients read `config` at import),
// with auth-change subscriptions stubbed.
vi.mock('../../client/config.js', async (orig) => ({ ...(await orig<typeof import('../../client/config.js')>()), onAuthChange: () => () => {} }));
// The locked panel's catalog read: `books` is in no bundle ⇒ the generic locked copy,
// reached through data rather than through a failed import.
vi.mock('../../features/marketplace/marketplaceClient.js', () => ({
  fetchFeatureBundles: async (): Promise<FeatureBundleCatalog> => ({ available: true, bundles: [], standalone: [], core: [] }),
  fetchBundleCommerce: async (): Promise<BundleCommerce[]> => [],
  fetchPublicPricing: async (): Promise<PublicPlanTier[]> => [],
}));
vi.mock('../../platform/telemetry.js', () => ({ telemetry: { reportError: vi.fn(), reportEvent: vi.fn() } }));
vi.mock('../../features/billing/dataExportClient.js', () => ({ listExportableFeatures: vi.fn(async () => []), downloadFeatureExport: vi.fn() }));

import { FeatureAccessProvider, useFeatureAccess } from '../FeatureAccessContext.js';
import { EntitlementGuard } from '../EntitlementGuard.js';
import {
  clearLastKnownEntitlements,
  hasLastKnownEntitlement,
  lastKnownTtlMs,
  recordEntitlementAnswer,
  revokeLastKnownEntitlements,
} from '../lastKnownEntitlement.js';

const A = { userId: 'u-a', tenantId: 'ws:x' };
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 12, 12);
const BOOKS = [{ id: 'books', status: 'on', enabled: true, variant: null }];
/** The assignments body as the D12 backend sends it: the subject it resolved FOR. */
const answeredFor = (tenantId: string, principalId = 'u-a') => ({ assignments: BOOKS, caller: { tenantId, principalId } });

/** An HTTP failure as the client throws it (`ToggleAdminError` carries `status`). */
const httpError = (status: number): Error => Object.assign(new Error(`returned ${status}`), { status });
const offlineError = () => new TypeError('Failed to fetch');

beforeEach(() => {
  localStorage.clear();
  fetchAssignments.mockReset();
  fetchEntitlements.mockReset();
  fetchAssignments.mockResolvedValue(answeredFor('ws:x'));
  fetchEntitlements.mockResolvedValue('*');
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('last-known store (D12 rules)', () => {
  it('a grant is valid inside the TTL and not after it', () => {
    recordEntitlementAnswer(A, ['books'], [], T0);
    expect(hasLastKnownEntitlement('books', T0 + 23 * HOUR, 24 * HOUR)).toBe(true);
    expect(hasLastKnownEntitlement('books', T0 + 25 * HOUR, 24 * HOUR)).toBe(false);
  });

  it('a grant dated in the future (the clock moved back) does not count', () => {
    recordEntitlementAnswer(A, ['books'], [], T0);
    expect(hasLastKnownEntitlement('books', T0 - HOUR, 24 * HOUR)).toBe(false);
  });

  it('is keyed by principal AND tenant: an answer for another identity drops the grants', () => {
    recordEntitlementAnswer(A, ['books'], [], T0);
    recordEntitlementAnswer({ userId: 'u-a', tenantId: 'ws:y' }, [], [], T0);
    expect(hasLastKnownEntitlement('books', T0, 24 * HOUR)).toBe(false);
    recordEntitlementAnswer(A, [], [], T0); // back again: the old grant was dropped, not hidden
    expect(hasLastKnownEntitlement('books', T0, 24 * HOUR)).toBe(false);
  });

  it('a not-entitled answer deletes the grant', () => {
    recordEntitlementAnswer(A, ['books'], [], T0);
    recordEntitlementAnswer(A, [], ['books'], T0 + 1);
    expect(hasLastKnownEntitlement('books', T0 + 2, 24 * HOUR)).toBe(false);
  });

  it('a 401/403 revocation deletes every grant; sign-out deletes the identity too', () => {
    recordEntitlementAnswer(A, ['books', 'docs'], [], T0);
    revokeLastKnownEntitlements();
    expect(hasLastKnownEntitlement('books', T0, 24 * HOUR)).toBe(false);
    clearLastKnownEntitlements();
    expect(localStorage.length).toBe(0);
  });

  it('a corrupt stored value fails closed', () => {
    localStorage.setItem('openwop:offline-entitlement', '{not json');
    expect(hasLastKnownEntitlement('books')).toBe(false);
  });

  it('TTL: hours from the env, default 24, never disabled by a bad value', () => {
    expect(lastKnownTtlMs('6')).toBe(6 * HOUR);
    expect(lastKnownTtlMs(undefined)).toBe(24 * HOUR);
    for (const bad of ['', 'abc', '0', '-3']) expect(lastKnownTtlMs(bad)).toBe(24 * HOUR);
  });
});

const view = (offlineEntitlement?: 'last-known', lastKnown: string[] = ['books']) => render(
  <MemoryRouter>
    <FeatureAccessProvider lastKnownFeatureIds={lastKnown}>
      <EntitlementGuard featureId="books" offlineEntitlement={offlineEntitlement}><div>FEATURE CONTENT</div></EntitlementGuard>
    </FeatureAccessProvider>
  </MemoryRouter>,
);
/** Every busy card gone (the guard's, and a lazy panel's own loading state). */
const settled = () => waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 10_000 });
const LOCKED_TITLE = 'This feature needs an upgrade';
/** The offline notice — by its own title and retry button, and NOT the locked panel. */
const notice = async (): Promise<void> => {
  await screen.findByText('You are offline', {}, { timeout: 10_000 });
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  expect(screen.queryByText(LOCKED_TITLE)).toBeNull();
};

describe('EntitlementGuard offline (D12)', () => {
  it('fails closed by default when the resolution cannot reach the server', async () => {
    // A valid grant IS held — without the opt-in it must still not be consulted.
    recordEntitlementAnswer(A, ['books'], []);
    fetchAssignments.mockRejectedValue(offlineError());
    view();
    await notice();
    expect(screen.queryByText('FEATURE CONTENT')).toBeNull();
  });

  it('a network failure of the ENTITLEMENT read alone also fails closed', async () => {
    fetchEntitlements.mockRejectedValue(offlineError());
    view();
    await notice();
    expect(screen.queryByText('FEATURE CONTENT')).toBeNull();
  });

  it('an HTTP failure is not "offline": today\'s degrade-to-render is unchanged', async () => {
    fetchAssignments.mockRejectedValue(httpError(503));
    view();
    await waitFor(() => expect(screen.getByText('FEATURE CONTENT')).toBeTruthy());
  });

  it('last-known renders offline on an unexpired grant for the last answered identity', async () => {
    recordEntitlementAnswer(A, ['books'], []);
    fetchAssignments.mockRejectedValue(offlineError());
    view('last-known');
    await waitFor(() => expect(screen.getByText('FEATURE CONTENT')).toBeTruthy());
  });

  it('last-known still fails closed with an expired grant', async () => {
    recordEntitlementAnswer(A, ['books'], [], Date.now() - 25 * HOUR);
    fetchAssignments.mockRejectedValue(offlineError());
    view('last-known');
    await notice();
    expect(screen.queryByText('FEATURE CONTENT')).toBeNull();
  });

  it('online, a grant never unlocks a LOCKED feature', async () => {
    recordEntitlementAnswer(A, ['books'], []);
    fetchEntitlements.mockResolvedValue(['crm']); // books is not entitled
    // No provider opt-in list: the online answer must not DELETE the grant, or the
    // guard never meets one and this case cannot tell (wave 50 found exactly that).
    view('last-known', []);
    expect(await screen.findByText(LOCKED_TITLE, {}, { timeout: 10_000 })).toBeTruthy();
    await settled();
    expect(screen.queryByText('FEATURE CONTENT')).toBeNull();
    expect(hasLastKnownEntitlement('books')).toBe(true); // the grant was there to misuse
  });

  it('the browser coming back online re-resolves and clears the notice', async () => {
    fetchAssignments.mockRejectedValueOnce(offlineError());
    view();
    await notice();
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(screen.getByText('FEATURE CONTENT')).toBeTruthy());
  });

  it('a blip with navigator.onLine still true re-resolves on its own, a bounded number of times', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const advance = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    // Leg 1 — it recovers on its own: the 2 s retry still fails, the 5 s one lands.
    fetchAssignments.mockRejectedValue(offlineError());
    view();
    await notice();
    expect(fetchAssignments).toHaveBeenCalledTimes(1);
    await advance(2_000);
    await waitFor(() => expect(fetchAssignments).toHaveBeenCalledTimes(2));
    fetchAssignments.mockResolvedValue(answeredFor('ws:x'));
    await advance(5_000);
    await waitFor(() => expect(screen.getByText('FEATURE CONTENT')).toBeTruthy());
    // Leg 2 — the bound: three automatic retries (2 s, 5 s, 15 s), then none.
    cleanup();
    fetchAssignments.mockReset();
    fetchAssignments.mockRejectedValue(offlineError());
    view();
    await notice();
    for (const [ms, calls] of [[2_000, 2], [5_000, 3], [15_000, 4]] as const) {
      await advance(ms);
      await waitFor(() => expect(fetchAssignments).toHaveBeenCalledTimes(calls));
    }
    await advance(120_000);
    expect(fetchAssignments).toHaveBeenCalledTimes(4);
  });

  it('a REFRESH that loses the network keeps the mounted page (no swap to the notice)', async () => {
    view();
    await waitFor(() => expect(screen.getByText('FEATURE CONTENT')).toBeTruthy());
    fetchAssignments.mockRejectedValue(offlineError());
    // Drive a refresh the way the app does: the 403 hook's reloader.
    const { noteRequestStatus, __resetEntitlementRefreshForTest } = await import('../../client/entitlementRefresh.js');
    __resetEntitlementRefreshForTest();
    await act(async () => { noteRequestStatus(403); });
    await waitFor(() => expect(fetchAssignments).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('FEATURE CONTENT')).toBeTruthy();
  });
});

describe('a failed refresh keeps the previous answer (D12 follow-up)', () => {
  function Probe(): JSX.Element {
    const a = useFeatureAccess('books');
    return <div>{`enabled:${a.enabled} locked:${a.locked} failed:${a.resolutionFailed}`}</div>;
  }
  const probe = () => render(<FeatureAccessProvider><Probe /></FeatureAccessProvider>);
  async function refresh(): Promise<void> {
    const { noteRequestStatus, __resetEntitlementRefreshForTest } = await import('../../client/entitlementRefresh.js');
    __resetEntitlementRefreshForTest();
    await act(async () => { noteRequestStatus(403); });
    await waitFor(() => expect(fetchAssignments).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  for (const [name, fail] of [['a 5xx', () => httpError(503)], ['a network failure', offlineError]] as const) {
    it(`${name} on refresh leaves a locked feature locked and an enabled one enabled`, async () => {
      fetchEntitlements.mockResolvedValue(['crm']); // books is on but not entitled: locked
      probe();
      await screen.findByText('enabled:true locked:true failed:false');
      fetchAssignments.mockRejectedValue(fail());
      await refresh();
      expect(screen.getByText('enabled:true locked:true failed:false')).toBeTruthy();
    });
  }

  it('the FIRST resolution failing still reads as the fallback, flagged failed', async () => {
    fetchAssignments.mockRejectedValue(httpError(503));
    probe();
    await screen.findByText('enabled:false locked:false failed:true');
  });

  // FAC-REFRESH-ENT5XX-1 — BLOCKED-ON-PRODUCT (ADR 0873 D12 follow-up). The
  // correct outcome, asserted; it FAILS today because the entitlement read's own
  // catch turns a 5xx into '*' and the refresh "succeeds" (FeatureAccessContext
  // :118-123 never reaches :162). Fix-probe w50g3-fac-ent5xx-fix-r2 turns this red.
  it.fails('FAC-REFRESH-ENT5XX-1: a 5xx on the ENTITLEMENT read during a refresh leaves a locked feature locked', async () => {
    fetchEntitlements.mockResolvedValue(['crm']); // books is on but not entitled: locked
    probe();
    await screen.findByText('enabled:true locked:true failed:false');
    fetchEntitlements.mockRejectedValue(httpError(503));
    await refresh();
    await waitFor(() => expect(fetchEntitlements).toHaveBeenCalledTimes(2));
    // Let the refresh's whole promise chain settle before reading the answer.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByText('enabled:true locked:true failed:false')).toBeTruthy();
  });

  it('a 401 on refresh does not keep the previous answer', async () => {
    fetchEntitlements.mockResolvedValue(['crm']);
    probe();
    await screen.findByText('enabled:true locked:true failed:false');
    fetchAssignments.mockRejectedValue(httpError(401));
    await refresh();
    await screen.findByText('enabled:false locked:false failed:true');
  });
});

describe('what an online resolution records (D12)', () => {
  const storedGrants = (): Record<string, number> =>
    (JSON.parse(localStorage.getItem('openwop:offline-entitlement') ?? '{"grants":{}}') as { grants: Record<string, number> }).grants;
  it('a positive answer becomes a grant under the subject the SERVER says it answered for', async () => {
    // A tenant no other fixture uses, so a hard-coded or remembered tenant cannot pass.
    fetchAssignments.mockResolvedValue(answeredFor('ws:server'));
    view('last-known');
    await waitFor(() => expect(hasLastKnownEntitlement('books')).toBe(true));
    expect(Object.keys(storedGrants())).toEqual(['u-a\nws:server\nbooks']);
  });

  it('a grant earned in workspace X is gone once an answer arrives for workspace Y', async () => {
    recordEntitlementAnswer(A, ['books'], []); // earned in ws:x
    fetchAssignments.mockResolvedValue(answeredFor('ws:y'));
    fetchEntitlements.mockResolvedValue('*'); // ws:y entitles books too
    view('last-known');
    await waitFor(() => expect(Object.keys(storedGrants())).toEqual(['u-a\nws:y\nbooks']));
    // The ws:x grant was dropped by the identity change — not by a not-entitled delete.
  });

  it('billing off (the 404 answer, "*") is a positive answer', async () => {
    fetchEntitlements.mockResolvedValue('*');
    view('last-known');
    await waitFor(() => expect(hasLastKnownEntitlement('books')).toBe(true));
  });

  it('a 5xx on the entitlement read is NOT recorded, though it still renders', async () => {
    fetchEntitlements.mockRejectedValue(httpError(500));
    view('last-known');
    await waitFor(() => expect(screen.getByText('FEATURE CONTENT')).toBeTruthy());
    expect(hasLastKnownEntitlement('books')).toBe(false);
  });

  it('a 403 on the entitlement read deletes the grant held', async () => {
    recordEntitlementAnswer(A, ['books'], []);
    fetchEntitlements.mockRejectedValue(httpError(403));
    view('last-known');
    await settled();
    expect(hasLastKnownEntitlement('books')).toBe(false);
  });

  it('a 401 on the assignments read deletes the grant held', async () => {
    recordEntitlementAnswer(A, ['books'], []);
    fetchAssignments.mockRejectedValue(httpError(401));
    view('last-known');
    await settled();
    expect(hasLastKnownEntitlement('books')).toBe(false);
  });

  it('an older backend (no caller echo) records nothing', async () => {
    fetchAssignments.mockResolvedValue({ assignments: BOOKS });
    view('last-known');
    await settled();
    expect(localStorage.length).toBe(0);
  });

  it('no opted-in feature: nothing at all is written to storage', async () => {
    view(undefined, []);
    await settled();
    expect(localStorage.length).toBe(0);
  });
});

describe('the offline path is in the entry STATIC graph (D12 x D6)', () => {
  // The worker precaches the shell as the entry chunks' STATIC import graph
  // (`scripts/gen-service-worker.mjs` computePrecache). Anything the guard needs
  // to render offline must be in it, or it fails to load exactly when needed.
  const read = (p: string): string => readFileSync(join(process.cwd(), 'src', p), 'utf8');
  // Every static edge form, either quote style (the lockedTargetsEntrySplit scan).
  const staticImports = (src: string): string[] =>
    [...src.matchAll(/^(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]/gm)].map((m) => (m[1] ?? m[2])!);

  it('the guard and the provider import the offline modules statically, never lazily', () => {
    const guard = read('featureToggles/EntitlementGuard.tsx');
    expect(staticImports(guard)).toEqual(expect.arrayContaining(['./OfflineEntitlementState.js', './lastKnownEntitlement.js']));
    expect(guard).not.toMatch(/import\(\s*'\.\/(OfflineEntitlementState|lastKnownEntitlement)/);
    expect(staticImports(read('featureToggles/FeatureAccessContext.tsx'))).toContain('./lastKnownEntitlement.js');
  });
});
