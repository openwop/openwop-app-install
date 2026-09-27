/**
 * Retention (ADR 0077 P3) — the commerce/billing `internal`-classification purgers.
 *
 * Two append-only, no-PII stores accrued forever with no age-out:
 *   - `commerce:order-idem`  — opaque checkout dedup claims (ages on `at`, key tenant-prefixed)
 *   - `billing:checkout`     — short-lived Stripe redirect handles (ages on `createdAt`)
 * Both are `internal` (no PII) and purge ONLY under the operator's opt-in
 * `retention.internalDays` window (driven by the sweep daemon). Verifies per store: an aged
 * row purges, a fresh row is kept, cross-tenant is untouched, and a `confidential-pii` sweep
 * touches NEITHER (they aren't PII). Also pins the deliberate exclusion: `billing:webhook-event`
 * (the money-critical Stripe dedup ledger) registers NO purger — pruning it would let a
 * re-delivered event re-process.
 *
 * Importing the services triggers their module-load purger registration; the test seeds
 * backdated rows over the SAME collection names, then drives the host seam via `purgeRetained`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { purgeRetained } from '../src/host/retentionPurger.js';
import type { Storage } from '../src/storage/storage.js';

// Importing the services registers their purgers (module-load side-effect).
import '../src/features/commerce/commerceService.js';
import '../src/features/billing/billingService.js';

const DAY = 86_400_000;
const now = 1_900_000_000_000;
const cutoffIso = new Date(now - 90 * DAY).toISOString();
const OLD = new Date(now - 120 * DAY).toISOString();
const FRESH = new Date(now - 10 * DAY).toISOString();

// Partial row shapes over the REAL collection names — the purgers read only the tenant key +
// the age field + the id, so a minimal row exercises the real delete path (no `as` cast).
// order-idem ages on `at`; its key is `${tenant}:${org}:${idkey}` (tenant-prefixed for the
// bounded scan). checkout ages on `createdAt`, keyed by an arbitrary sessionId.
const orderIdemCol = () => new DurableCollection<{ key: string; tenantId: string; orgId: string; at: string }>('commerce:order-idem', (r) => r.key);
const checkoutCol = () => new DurableCollection<{ sessionId: string; tenantId: string; createdAt: string }>('billing:checkout', (s) => s.sessionId);

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  // Fresh memory storage ⇒ empty collections; do NOT reset the purger registry (the purgers
  // register once at module load and must stay registered for purgeRetained to reach them).
});

describe('commerce/billing internal-retention purgers', () => {
  it('commerce:order-idem — purges an aged claim, keeps a fresh one', async () => {
    const col = orderIdemCol();
    await col.put({ key: 'tA:orgA:old', tenantId: 'tA', orgId: 'orgA', at: OLD });
    await col.put({ key: 'tA:orgA:fresh', tenantId: 'tA', orgId: 'orgA', at: FRESH });
    const results = await purgeRetained('tA', 'internal', cutoffIso);
    expect(results.find((r) => r.feature === 'commerce:order-idem')).toMatchObject({ deleted: 1, ok: true });
    expect(await col.get('tA:orgA:old')).toBeNull();
    expect(await col.get('tA:orgA:fresh')).not.toBeNull();
  });

  it('billing:checkout — purges an aged session, keeps a fresh one', async () => {
    const col = checkoutCol();
    await col.put({ sessionId: 'ck-old', tenantId: 'tA', createdAt: OLD });
    await col.put({ sessionId: 'ck-fresh', tenantId: 'tA', createdAt: FRESH });
    const results = await purgeRetained('tA', 'internal', cutoffIso);
    expect(results.find((r) => r.feature === 'billing:checkout')).toMatchObject({ deleted: 1, ok: true });
    expect(await col.get('ck-old')).toBeNull();
    expect(await col.get('ck-fresh')).not.toBeNull();
  });

  it('opt-in only for `internal` — a `confidential-pii` sweep purges NEITHER store', async () => {
    await orderIdemCol().put({ key: 'tA:orgA:old', tenantId: 'tA', orgId: 'orgA', at: OLD });
    await checkoutCol().put({ sessionId: 'ck-old', tenantId: 'tA', createdAt: OLD });
    const results = await purgeRetained('tA', 'confidential-pii', cutoffIso);
    expect(results.find((r) => r.feature === 'commerce:order-idem')?.deleted).toBe(0);
    expect(results.find((r) => r.feature === 'billing:checkout')?.deleted).toBe(0);
    expect(await orderIdemCol().get('tA:orgA:old')).not.toBeNull();
    expect(await checkoutCol().get('ck-old')).not.toBeNull();
  });

  it('never crosses tenants — another tenant\'s aged rows are untouched', async () => {
    await orderIdemCol().put({ key: 'tB:orgA:old', tenantId: 'tB', orgId: 'orgA', at: OLD });
    await checkoutCol().put({ sessionId: 'ck-other', tenantId: 'tB', createdAt: OLD });
    await purgeRetained('tA', 'internal', cutoffIso);
    expect(await orderIdemCol().get('tB:orgA:old')).not.toBeNull();
    expect(await checkoutCol().get('ck-other')).not.toBeNull();
  });

  it('billing:webhook-event is DELIBERATELY excluded — no purger registered for the dedup ledger', async () => {
    // Sweep BOTH classifications; the money-critical Stripe dedup ledger must never appear.
    const internalResults = await purgeRetained('tA', 'internal', cutoffIso);
    const piiResults = await purgeRetained('tA', 'confidential-pii', cutoffIso);
    expect(internalResults.find((r) => r.feature === 'billing:webhook-event')).toBeUndefined();
    expect(piiResults.find((r) => r.feature === 'billing:webhook-event')).toBeUndefined();
  });
});
