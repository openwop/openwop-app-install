/**
 * KickTodo wave 4C — the hash-keyed token stores (KTX-D1) and their lifecycle.
 *
 *  - KTC-8 / KTI-5 / KTINT-5 / KTX-D1: `kicktodo-invites` and `kicktodo-feed-tokens`
 *    are keyed by token hash (the public lanes have no tenant), so every per-tenant
 *    read — DSAR erasure, consent revoke — scanned EVERY tenant's tokens. They now
 *    carry a tenant secondary index. Production already holds rows without markers,
 *    so nothing is re-keyed: the ADR 0866 hourly reconcile is the idempotent
 *    backfill, and reads stay on the old scan until it has VERIFIED the index.
 *  - KTCORE-4 / KTINT-4: revoked invites, feed tokens and webhook tokens are aged
 *    out after KICKTODO_REVOKED_ROW_RETENTION_DAYS; live ones never are.
 *  - KTINT-4: webhook rotation is atomic — concurrent registrations leave exactly
 *    ONE live token for the (tenant, provider) pair.
 *
 * What breaks these (sabotage-witnessed, each reverted and restored):
 *  - drop `tenantOf` from either collection → `listForTenantIndexed` throws and
 *    the verified-index tests red;
 *  - make the erasers call `list()` unconditionally again → the "no full scan
 *    once verified" spies red;
 *  - drop the `revokedAt` kvAgeOut registrations → the age-out tests red;
 *  - restore revoke-then-put rotation → the concurrent-rotation test leaves two
 *    live tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __runKvAgeOutOnce } from '../src/host/kvAgeOut.js';
import { KICKTODO_REVOKED_ROW_RETENTION_DAYS } from '../src/features/kicktodo-core/types.js';
import { eraseSubjectInvites, __test as inviteStore } from '../src/features/kicktodo-core/inviteService.js';
import {
  eraseIntegrationsSubject,
  grantConsent,
  revokeConsent,
  __test as integrationStore,
} from '../src/features/kicktodo-integrations/integrationService.js';
import {
  registerWearableWebhook,
  __resetWearableWebhooks,
  __test as webhookStore,
} from '../src/features/kicktodo-integrations/wearableWebhookService.js';
import { registerWearableAdapter, __resetWearableAdapters } from '../src/features/kicktodo-integrations/wearableProviderAdapter.js';

const T = 'tenant-kt-tok';
const T2 = 'tenant-kt-tok-other';
const A = 'user:tok-alice';
const B = 'user:tok-bob';
const NOW = new Date('2026-10-01T00:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const invite = (tokenHash: string, tenantId: string, inviterSubject: string, revokedAt?: string) => ({
  tokenHash, tenantId, challengeId: 'ch1', inviterSubject, createdAt: daysAgo(200), ...(revokedAt ? { revokedAt } : {}),
});
const feed = (tokenHash: string, tenantId: string, ownerSubject: string, revokedAt?: string) => ({
  tokenHash, tenantId, ownerSubject, createdAt: daysAgo(200), ...(revokedAt ? { revokedAt } : {}),
});

describe('KTC-8 / KTX-D1 — invites: tenant index with an idempotent backfill', () => {
  it('erases from the scan while unverified (legacy rows have no marker), then the reconcile backfills once and is a no-op after', async () => {
    // A LEGACY row: written raw, exactly as pre-index code left it (no marker).
    await storage.kvSet('hostext:kicktodo-invites:h-legacy', JSON.stringify(invite('h-legacy', T, A)));
    await inviteStore.invites.put(invite('h-new', T, A));
    await inviteStore.invites.put(invite('h-other-tenant', T2, A));

    expect(await inviteStore.invites.tenantIndexVerified()).toBe(false);
    const first = await inviteStore.invites.reconcileTenantIndex({ windowMs: 0, now: NOW.getTime() });
    expect(first).toMatchObject({ repaired: 1, verified: true }); // only the legacy row lacked a marker
    const second = await inviteStore.invites.reconcileTenantIndex({ windowMs: 0, now: NOW.getTime() });
    expect(second).toMatchObject({ repaired: 0, reset: false, verified: true }); // idempotent

    // Warm the one-time `ensureTenantIndex` sentinel, then prove the erase is bounded.
    await eraseSubjectInvites(T, 'user:nobody');
    const scan = vi.spyOn(inviteStore.invites, 'list');
    expect(await eraseSubjectInvites(T, A)).toBe(2); // legacy row found through the backfilled index
    expect(scan).not.toHaveBeenCalled();
    expect(await inviteStore.invites.get('h-legacy')).toBeNull();
    expect(await inviteStore.invites.get('h-other-tenant')).not.toBeNull();
  });

  it('falls back to the full scan while the index is unverified, so a legacy row is never missed', async () => {
    await storage.kvSet('hostext:kicktodo-invites:h-legacy', JSON.stringify(invite('h-legacy', T, A)));
    expect(await eraseSubjectInvites(T, A)).toBe(1);
    expect(await inviteStore.invites.get('h-legacy')).toBeNull();
  });
});

describe('KTI-5 / KTINT-5 — feed tokens: revoke + erase read one tenant', () => {
  it('consent revoke and DSAR erase stop scanning every tenant once the index is verified', async () => {
    await grantConsent(T, A, 'calendar-project');
    await integrationStore.feeds.put(feed('f-a', T, A));
    await integrationStore.feeds.put(feed('f-b', T, B));
    await integrationStore.feeds.put(feed('f-t2', T2, A));
    await integrationStore.feeds.reconcileTenantIndex({ windowMs: 0, now: NOW.getTime() });
    await eraseIntegrationsSubject(T, 'user:nobody'); // warm the backfill sentinel

    const scan = vi.spyOn(integrationStore.feeds, 'list');
    await revokeConsent(T, A, 'calendar-project');
    expect((await integrationStore.feeds.get('f-a'))?.revokedAt).toBeTruthy();
    expect((await integrationStore.feeds.get('f-b'))?.revokedAt).toBeUndefined();
    expect((await integrationStore.feeds.get('f-t2'))?.revokedAt).toBeUndefined();

    await eraseIntegrationsSubject(T, A);
    expect(await integrationStore.feeds.get('f-a')).toBeNull();
    expect(await integrationStore.feeds.get('f-b')).not.toBeNull();
    expect(await integrationStore.feeds.get('f-t2')).not.toBeNull();
    expect(scan).not.toHaveBeenCalled();
  });
});

describe('KTCORE-4 / KTINT-4 — revoked tokens age out; live ones never do', () => {
  it('deletes invites, feed tokens and webhook tokens revoked longer ago than the window', async () => {
    const W = KICKTODO_REVOKED_ROW_RETENTION_DAYS;
    await inviteStore.invites.put(invite('i-old', T, A, daysAgo(W + 1)));
    await inviteStore.invites.put(invite('i-recent', T, A, daysAgo(W - 1)));
    await inviteStore.invites.put(invite('i-live', T, B));
    await integrationStore.feeds.put(feed('f-old', T, A, daysAgo(W + 1)));
    await integrationStore.feeds.put(feed('f-live', T, B));
    await webhookStore.registrations.put({ tokenHash: 'w-old', tenantId: T, provider: 'google', createdAt: daysAgo(400), revokedAt: daysAgo(W + 1) });
    await webhookStore.registrations.put({ tokenHash: 'w-live', tenantId: T, provider: 'google', createdAt: daysAgo(400) });

    const res = await __runKvAgeOutOnce(storage, NOW);
    for (const id of ['kicktodo-invites:revoked', 'kicktodo-feed-tokens:revoked', 'kicktodo-wearable-webhook:revoked']) {
      expect(res.find((r) => r.id === id), id).toMatchObject({ deleted: 1 });
    }
    expect(await inviteStore.invites.get('i-old')).toBeNull();
    expect(await inviteStore.invites.get('i-recent')).not.toBeNull();
    expect(await inviteStore.invites.get('i-live')).not.toBeNull();
    expect(await integrationStore.feeds.get('f-old')).toBeNull();
    expect(await integrationStore.feeds.get('f-live')).not.toBeNull();
    expect(await webhookStore.registrations.get('w-old')).toBeNull();
    expect(await webhookStore.registrations.get('w-live')).not.toBeNull();
    // The swept rows' tenant-index markers went with them (deleted via the collection).
    expect((await storage.kvList('hostextidx:kicktodo-invites:')).map((r) => r.key)).not.toContain(`hostextidx:kicktodo-invites:${T}:i-old`);
  });
});

describe('KTINT-4 — webhook rotation is atomic', () => {
  beforeEach(async () => {
    process.env.OPENWOP_WEARABLE_PROVIDER_ENABLED = 'true';
    registerWearableAdapter('google', { verify: () => true, extractProviderUserId: () => null, normalize: () => [] });
    await __resetWearableWebhooks();
  });
  afterEach(() => {
    delete process.env.OPENWOP_WEARABLE_PROVIDER_ENABLED;
    __resetWearableAdapters();
  });

  const live = async () => (await webhookStore.registrations.list()).filter((r) => r.tenantId === T && r.provider === 'google' && !r.revokedAt);

  it('concurrent registrations leave exactly ONE live token, and it is the pointer\'s', async () => {
    await Promise.all([registerWearableWebhook(T, 'google'), registerWearableWebhook(T, 'google'), registerWearableWebhook(T, 'google')]);
    const rows = await live();
    expect(rows).toHaveLength(1);
    expect((await webhookStore.currentToken.get(`${T}::google`))?.tokenHash).toBe(rows[0].tokenHash);
  });

  it('a token minted before the pointer existed is revoked by the next rotation', async () => {
    await webhookStore.registrations.put({ tokenHash: 'legacy', tenantId: T, provider: 'google', createdAt: daysAgo(10) });
    await registerWearableWebhook(T, 'google');
    const rows = await live();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe('legacy');
    expect((await webhookStore.registrations.get('legacy'))?.revokedAt).toBeTruthy();
  });
});
