/**
 * ADR 0615 — the partial-refund CRASH WINDOW.
 *
 * `partialRefundOrder` claims a ledger row, calls Stripe, then folds the amount
 * into the order. The `catch` releases the claim so a THROWN failure re-drives.
 * A process that dies between the provider call and the fold runs no catch:
 *
 *   - the ledger row survives, still `provider:'none'` with no `refundId`;
 *   - `order.refundedAmount` was never updated;
 *   - the same-key retry hit `if (existing) return getOrder(...)` and was
 *     swallowed as "idempotent — already applied".
 *
 * Money left, the order said it did not, and the retry that should have repaired
 * it was the very thing that hid it. These tests pin that window shut, and pin
 * the two ways it must NOT be closed: no silent re-drive while an owner may still
 * be alive, and no silent re-drive of money a human has not reconciled.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createProduct, createOrder, markAsPaid, partialRefundOrder, getOrder,
  listOrderRefunds, __resetCommerce,
} from '../src/features/commerce/commerceService.js';
import * as stripeApi from '../src/features/billing/stripeApi.js';

const T = 'tenant-crw';
const ORG = 'org-crw';
const BY = 'user-crw';
const LEASE_MS = 120_000; // must match REFUND_CLAIM_LEASE_MS


/** ADR 0875 D3 — the refund exit re-reads the intent and requires it to be bound to
 *  its order (metadata), so the intents these orders were paid with must answer as
 *  Stripe would: succeeded, carrying their own order's metadata. */
const boundIntents = new Map<string, string>();
function bindIntents(): void {
  vi.spyOn(stripeApi, 'getStripePaymentIntent').mockImplementation(async (_key: string, id: string) => {
    const orderId = boundIntents.get(id) ?? '';
    return { status: 'succeeded', amount: 0, currency: 'usd', metadata: { orderId, tenantId: T, orgId: ORG } };
  });
}

let storage: Awaited<ReturnType<typeof openStorage>>;
beforeAll(async () => { storage = await openStorage('memory://'); initHostExtPersistence(storage); });
beforeEach(async () => { await __resetCommerce(); vi.restoreAllMocks(); bindIntents(); });

async function paidOrder(price = 100): Promise<string> {
  const p = await createProduct({
    tenantId: T, orgId: ORG, createdBy: BY, type: 'physical', name: 'Widget',
    price, currency: 'USD', inventory: 10,
  });
  const o = await createOrder({ tenantId: T, orgId: ORG, createdBy: BY, lines: [{ productId: p.productId, quantity: 1 }] });
  await markAsPaid(T, ORG, o.orderId, `pi_live_crw_${o.orderId}`, {});
  boundIntents.set(`pi_live_crw_${o.orderId}`, o.orderId);
  return o.orderId;
}

/**
 * Model a process that DIES after the provider call returns. Getting this faithful is
 * the whole test:
 *
 *   - the order fold must not land, AND
 *   - no further write to the claim may land either — not the release, and not the
 *     `manual_intervention_required` marker. A dead process writes NOTHING. Blocking
 *     only the delete would simulate a *handled* failure and would exercise the wrong
 *     branch entirely.
 *
 * The order CAS and the ledger-claim CAS both carry the orderId (the ledger id is
 * `commerce:refund:<tenant>:<org>:<order>:<key>`), so the fold-blocker must exclude the
 * refund keyspace. Without that exclusion the CLAIM fails instead, the call returns
 * idempotently, Stripe is never called, and the test goes green having proved nothing.
 */
function crashAfterProviderCall(orderId: string): { die: () => void; reboot: () => void } {
  const realCas = storage.kvCompareAndSwap.bind(storage);
  const realDelete = storage.kvDelete.bind(storage);
  const realSet = storage.kvSet.bind(storage);
  // Starts ALIVE. The claim — its row *and* its tenant-index entry — completes before
  // the provider call, so it must be allowed to land; killing writes from the start
  // would also erase the index and fake a claim that never existed.
  let dead = false;
  const isRefundKey = (k: string): boolean => k.includes('commerce:refund');
  vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) =>
    (dead && key.includes(orderId) && !isRefundKey(key)) ? { swapped: false, actual: null } : realCas(key, expected, next));
  vi.spyOn(storage, 'kvDelete').mockImplementation(async (key) =>
    (dead && isRefundKey(key)) ? true : realDelete(key));
  vi.spyOn(storage, 'kvSet').mockImplementation(async (key, val) =>
    (dead && isRefundKey(key)) ? undefined : realSet(key, val));
  return { die: () => { dead = true; }, reboot: () => { dead = false; } };
}

/** The provider call is the crash point: it returns, the money is gone, and the process
 *  never runs another line. Wiring `die()` into the mock is what makes that exact.
 *  Only the FIRST call crashes — a later retry is the rebooted process, which must be
 *  allowed to finish (and whose second call Stripe dedupes on the idempotency key). */
function stripeRefundThenCrash(crash: { die: () => void }, id = 're_crw'): ReturnType<typeof vi.spyOn> {
  let first = true;
  return vi.spyOn(stripeApi, 'createStripeRefund').mockImplementation(async () => {
    if (first) { first = false; crash.die(); }
    return { id, status: 'succeeded' };
  });
}

/** Move the wall clock the lease is measured against. Both the lease write and the
 *  expiry check read `Date.now()`, so this is the whole of the time dependency. */
function advanceClock(ms: number): void {
  const at = Date.now() + ms;
  vi.spyOn(Date, 'now').mockReturnValue(at);
}

describe('ADR 0615 CRW-1 — the residue a crash leaves', () => {
  it('money is gone, the order does not know, and the claim is still sitting there', async () => {
    const orderId = await paidOrder(100);
    const crash = crashAfterProviderCall(orderId);
    const refund = stripeRefundThenCrash(crash);

    await expect(partialRefundOrder(T, ORG, orderId, 100, { refundKey: 'rk-crash', stripeKey: 'sk_x', actor: BY }))
      .rejects.toThrow(/could not be updated after retries/);

    expect(refund).toHaveBeenCalledTimes(1);                                  // real money left
    expect((await getOrder(T, ORG, orderId))?.refundedAmount ?? 0).toBe(0);   // the order does not know
    const rows = await listOrderRefunds(T, ORG, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('pending');                                   // claimed, never finished
  });
});

describe('ADR 0615 CRW-2 — a live lease is a concurrent caller, not a corpse', () => {
  it('a same-key retry while the lease still runs is answered idempotently, NOT re-driven', async () => {
    const orderId = await paidOrder(100);
    const crash = crashAfterProviderCall(orderId);
    const refund = stripeRefundThenCrash(crash);
    const { reboot } = crash;
    await expect(partialRefundOrder(T, ORG, orderId, 100, { refundKey: 'rk-crash', stripeKey: 'sk_x', actor: BY }))
      .rejects.toThrow(/could not be updated after retries/);
    reboot();

    // No clock movement: the lease is still live. Reclaiming here would be racing a
    // caller that may still be running — two folds of the same refund.
    const after = await partialRefundOrder(T, ORG, orderId, 100, { refundKey: 'rk-crash', stripeKey: 'sk_x', actor: BY });
    expect(after?.refundedAmount ?? 0).toBe(0);   // deliberately NOT repaired yet
    expect(refund).toHaveBeenCalledTimes(1);      // and the provider was not called again
  });
});

describe('ADR 0615 CRW-3 — an expired lease makes the claim reclaimable', () => {
  it('the same-key retry finishes the fold instead of reporting "already applied"', async () => {
    const orderId = await paidOrder(100);
    const crash = crashAfterProviderCall(orderId);
    const refund = stripeRefundThenCrash(crash);
    const { reboot } = crash;
    await expect(partialRefundOrder(T, ORG, orderId, 100, { refundKey: 'rk-crash', stripeKey: 'sk_x', actor: BY }))
      .rejects.toThrow(/could not be updated after retries/);

    reboot();
    advanceClock(LEASE_MS + 1_000); // the owner is provably gone

    const after = await partialRefundOrder(T, ORG, orderId, 100, { refundKey: 'rk-crash', stripeKey: 'sk_x', actor: BY });

    // Re-driving is safe: the provider call carries a deterministic idempotency key, so
    // Stripe returns the SAME refund rather than issuing a second one.
    expect(after?.refundedAmount).toBe(100);
    expect(after?.status).toBe('refunded');
    expect(refund).toHaveBeenCalledTimes(2);                          // called again...
    const rows = await listOrderRefunds(T, ORG, orderId);
    expect(rows).toHaveLength(1);                                     // ...but still ONE refund
    expect(rows[0]?.state).toBe('applied');
  });
});

describe('ADR 0615 CRW-4 — a fold failure the process SURVIVES', () => {
  it('parks the row for a human and refuses to re-drive the money silently', async () => {
    const orderId = await paidOrder(100);
    const refund = vi.spyOn(stripeApi, 'createStripeRefund').mockResolvedValue({ id: 're_survive', status: 'succeeded' });

    // Only the fold is blocked; the process lives, so the catch runs.
    const realCas = storage.kvCompareAndSwap.bind(storage);
    let blocking = true;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) =>
      (blocking && key.includes(orderId) && !key.includes('commerce:refund')) ? { swapped: false, actual: null } : realCas(key, expected, next));

    await expect(partialRefundOrder(T, ORG, orderId, 100, { refundKey: 'rk-survive', stripeKey: 'sk_x', actor: BY }))
      .rejects.toThrow();

    // The claim is NOT deleted — that would erase the only durable trace that money left.
    const rows = await listOrderRefunds(T, ORG, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('manual_intervention_required');
    expect(rows[0]?.refundId).toBe('re_survive');   // reconcilable by a human

    // Even with storage healthy and the lease long gone, the retry must NOT quietly
    // move money again. It fails loudly and names the reason.
    blocking = false;
    advanceClock(LEASE_MS + 1_000);
    await expect(partialRefundOrder(T, ORG, orderId, 100, { refundKey: 'rk-survive', stripeKey: 'sk_x', actor: BY }))
      .rejects.toThrow(/manual intervention/i);
    expect(refund).toHaveBeenCalledTimes(1);
  });
});

/**
 * DEF-7 (ADR 0238) — the two concurrency guards, with the window FORCED. The HTTP races in
 * commerce-phase1-deferrals.test.ts are real but unforced: one caller usually finishes
 * before the other reads, so it is turned away by an EARLIER guard (the live-lease
 * idempotent return, or the up-front remaining check) and the guard under test never
 * runs. Here both callers are held at the ledger-claim CAS until BOTH have arrived —
 * i.e. both have already read the order and passed every pre-claim check — then released.
 */
function holdLedgerClaimsUntil(orderId: string, callers: number): { arrivals: () => number } {
  const realCas = storage.kvCompareAndSwap.bind(storage);
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  // A fallback so a path that never brings the second caller here fails an assertion
  // instead of hanging the case.
  const fallback = setTimeout(() => release(), 2_000);
  vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
    if (key.startsWith('hostext:commerce:refund:') && key.includes(orderId) && expected === null) {
      arrived += 1;
      if (arrived >= callers) { clearTimeout(fallback); release(); }
      await gate;
    }
    return realCas(key, expected, next);
  });
  return { arrivals: () => arrived };
}

describe('DEF-7 forced window — concurrent partial refunds on a manual order', () => {
  it('two DIFFERENT keys past the up-front check: the in-CAS clamp refuses the second (no over-refund)', async () => {
    const orderId = await paidOrder(100); // no stripeKey ⇒ no Stripe backstop
    const held = holdLedgerClaimsUntil(orderId, 2);
    const results = await Promise.allSettled([
      partialRefundOrder(T, ORG, orderId, 100, { refundKey: 'k-a', actor: BY }),
      partialRefundOrder(T, ORG, orderId, 100, { refundKey: 'k-b', actor: BY }),
    ]);
    expect(held.arrivals()).toBe(2); // both really were inside the window
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toMatch(/would exceed the order charge/);
    expect(await getOrder(T, ORG, orderId)).toMatchObject({ refundedAmount: 100, status: 'refunded' }); // never 200
    expect(await listOrderRefunds(T, ORG, orderId)).toHaveLength(1); // the loser's claim is released
  });

  it('the SAME key from two callers that both read "no claim": the claim CAS folds it exactly once', async () => {
    const orderId = await paidOrder(100);
    const held = holdLedgerClaimsUntil(orderId, 2);
    const results = await Promise.allSettled([
      partialRefundOrder(T, ORG, orderId, 50, { refundKey: 'race', actor: BY }),
      partialRefundOrder(T, ORG, orderId, 50, { refundKey: 'race', actor: BY }),
    ]);
    expect(held.arrivals()).toBe(2);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true); // the loser answers idempotently
    expect(await getOrder(T, ORG, orderId)).toMatchObject({ refundedAmount: 50, status: 'partially_refunded' }); // NOT 100
    expect(await listOrderRefunds(T, ORG, orderId)).toHaveLength(1);
  });
});
