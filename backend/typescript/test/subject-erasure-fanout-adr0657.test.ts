/**
 * ADR 0657 D7 / D12 — the erasure fan-out's three seam-level guarantees:
 *
 *  - CONS-30: a per-eraser TIMEOUT (`OPENWOP_ERASER_TIMEOUT_MS`). One eraser
 *    awaiting a store that never answers used to pin the whole DSAR forever —
 *    no failure, no receipt, nothing to retry. A timeout now has the SAME shape
 *    as a throw (counted in `failed`, NAMED in `failedFeatures`) and the fan-out
 *    continues.
 *  - CONS-11: the resolver CLOSURE is two hops. `userId → email` (users) and
 *    `email → crm:contact` (CRM) are two different resolvers answering for two
 *    different key shapes; a single pass stopped at the email and the contact
 *    keyed by it was never erased.
 *  - D7: `currentErasureRequest()` — an eraser handed a RESOLVED key can learn
 *    the REQUESTED key, so the tombstones one DSAR writes carry one `dsarHash`
 *    and readmit can reverse them as a group.
 *
 * Each case is a witness for one mechanism; none reads the others' state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  eraseSubject, registerSubjectEraser, registerSubjectKeyResolver, currentErasureRequest,
  __resetSubjectErasers, __resetSubjectKeyResolvers,
} from '../src/host/subjectErasure.js';

const T = 'ws:adr0657-fanout';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  __resetSubjectErasers();
  __resetSubjectKeyResolvers();
  delete process.env.OPENWOP_ERASER_TIMEOUT_MS;
});
afterEach(() => {
  __resetSubjectErasers();
  __resetSubjectKeyResolvers();
  delete process.env.OPENWOP_ERASER_TIMEOUT_MS;
});

describe('CONS-30 — a per-eraser timeout is a NAMED failure, and the fan-out continues', () => {
  it('an eraser that never resolves counts into `failed` by name; the next eraser still ran', async () => {
    process.env.OPENWOP_ERASER_TIMEOUT_MS = '50';
    let nextRan = 0;
    registerSubjectEraser(async function hangsForever() { await new Promise<void>(() => { /* never settles */ }); });
    registerSubjectEraser(async function stillRuns() { nextRan += 1; return { rowsTouched: 1 }; });

    const out = await eraseSubject(T, 'u-timeout');

    // Same shape as a throw: counted AND named.
    expect(out.failed).toBe(1);
    expect(out.failedFeatures).toEqual(['hangsForever']);
    expect(out.total).toBe(2);
    // The fan-out CONTINUED past the hung eraser (registration order is the
    // call order, so `stillRuns` was queued BEHIND the hang).
    expect(nextRan, 'the eraser after the hung one must still run').toBe(1);
    expect(out.reportingErasers).toBe(1);
    expect(out.rowsTouched).toBe(1);
  });

  it('`0` disables the timeout; the default applies when unset; a slow-but-finite eraser is not a failure under a generous budget', async () => {
    let calls = 0;
    registerSubjectEraser(async function slowButFinite() { calls += 1; await new Promise((r) => setTimeout(r, 80)); });

    process.env.OPENWOP_ERASER_TIMEOUT_MS = '20';
    const tight = await eraseSubject(T, 'u-slow');
    expect(tight.failed, 'a 20 ms budget times an 80 ms eraser out').toBe(1);
    expect(tight.failedFeatures).toEqual(['slowButFinite']);

    process.env.OPENWOP_ERASER_TIMEOUT_MS = '0';
    const disabled = await eraseSubject(T, 'u-slow');
    expect(disabled.failed, '`0` disables the timeout').toBe(0);

    delete process.env.OPENWOP_ERASER_TIMEOUT_MS;
    const dflt = await eraseSubject(T, 'u-slow');
    expect(dflt.failed, 'the 10 s default does not time out an 80 ms eraser').toBe(0);
    // Read PER CALL: three calls, three different budgets, one registration.
    expect(calls).toBe(3);
  });
});

describe('CONS-11 — the resolver closure is two hops, deduped, and bounded', () => {
  /** A: userId → email (the users resolver's shape). */
  const resolverA = async (_t: string, key: string): Promise<readonly string[]> => (key === 'u1' ? ['a@x.test'] : []);
  /** B: email → crm contact (the CRM resolver's shape). */
  const resolverB = async (_t: string, key: string): Promise<readonly string[]> => (key === 'a@x.test' ? ['crm:c1'] : []);

  it('erase(u1) reaches u1, a@x.test AND crm:c1 — every eraser is called for all three', async () => {
    registerSubjectKeyResolver(resolverA);
    registerSubjectKeyResolver(resolverB);
    const seen1: string[] = [];
    const seen2: string[] = [];
    registerSubjectEraser(async function first(_t, key) { seen1.push(key); });
    registerSubjectEraser(async function second(_t, key) { seen2.push(key); });

    const out = await eraseSubject(T, 'u1');

    expect(out.keysResolved).toBe(3);
    expect(out.resolverFailures).toBe(0);
    expect(out.failed).toBe(0);
    expect(seen1.sort()).toEqual(['a@x.test', 'crm:c1', 'u1']);
    expect(seen2.sort()).toEqual(['a@x.test', 'crm:c1', 'u1']);
  });

  it('a resolver that maps a derived key BACK to the original does not loop, and each key is erased exactly once', async () => {
    registerSubjectKeyResolver(resolverA);
    registerSubjectKeyResolver(resolverB);
    // C: email → userId (the reverse edge — a real users-by-email lookup would do this).
    let cCalls = 0;
    registerSubjectKeyResolver(async (_t, key) => { cCalls += 1; return key === 'a@x.test' ? ['u1'] : []; });
    const perKey = new Map<string, number>();
    registerSubjectEraser(async function countPerKey(_t, key) { perKey.set(key, (perKey.get(key) ?? 0) + 1); });

    const out = await eraseSubject(T, 'u1');

    expect(out.keysResolved).toBe(3);
    expect([...perKey.entries()].sort()).toEqual([['a@x.test', 1], ['crm:c1', 1], ['u1', 1]]);
    // Bounded: hop 1 (u1) + hop 2 (a@x.test) = two hops for resolver C, and
    // crm:c1 (derived in hop 2) is NOT re-fed — no third hop.
    expect(cCalls).toBe(2);
  });

  it('the bound is two hops: a key derived in hop 2 is not fed back through the resolvers', async () => {
    registerSubjectKeyResolver(resolverA);
    registerSubjectKeyResolver(resolverB);
    // D: crm contact → a further "session" key, reachable only from a THIRD hop.
    registerSubjectKeyResolver(async (_t, key) => (key === 'crm:c1' ? ['sess:never'] : []));
    const seen: string[] = [];
    registerSubjectEraser(async function seenEraser(_t, key) { seen.push(key); });

    const out = await eraseSubject(T, 'u1');

    expect(out.keysResolved).toBe(3);
    expect(seen).not.toContain('sess:never');
  });

  it('a resolver that throws in hop 2 counts ONCE per resolver, never once per key', async () => {
    registerSubjectKeyResolver(resolverA);
    registerSubjectKeyResolver(resolverB);
    registerSubjectKeyResolver(async (_t, key) => { if (key !== 'u1') throw new Error('store down'); return []; });
    registerSubjectEraser(async function ok() {});

    const out = await eraseSubject(T, 'u1');

    // It threw for a@x.test (hop 2) — one broken resolver is ONE failure.
    expect(out.resolverFailures).toBe(1);
    expect(out.failedFeatures).toEqual(['identity-link-resolution']);
    expect(out.failed).toBe(1);
    // …and the keys the OTHER resolvers found were still erased.
    expect(out.keysResolved).toBe(3);
  });

  it('a falsy derived key is dropped (the existing non-subject guard is unchanged)', async () => {
    registerSubjectKeyResolver(async () => ['', 'k2']);
    const seen: string[] = [];
    registerSubjectEraser(async function seenEraser(_t, key) { seen.push(key); });
    const out = await eraseSubject(T, 'k1');
    expect(out.keysResolved).toBe(2);
    expect(seen.sort()).toEqual(['k1', 'k2']);
  });
});

describe('ADR 0657 D7 — currentErasureRequest() names the DSAR from inside any eraser', () => {
  it('an eraser called for the DERIVED key crm:c1 sees requestedKey === u1; outside a fan-out it is undefined', async () => {
    registerSubjectKeyResolver(async (_t, key) => (key === 'u1' ? ['a@x.test'] : []));
    registerSubjectKeyResolver(async (_t, key) => (key === 'a@x.test' ? ['crm:c1'] : []));
    const observed = new Map<string, { tenantId: string; requestedKey: string } | undefined>();
    registerSubjectEraser(async function observing(_t, key) { observed.set(key, currentErasureRequest()); });

    expect(currentErasureRequest(), 'outside a fan-out there is no DSAR').toBeUndefined();
    await eraseSubject(T, 'u1');
    expect(currentErasureRequest(), 'the context does not leak past the fan-out').toBeUndefined();

    expect(observed.get('crm:c1')).toEqual({ tenantId: T, requestedKey: 'u1' });
    expect(observed.get('a@x.test')).toEqual({ tenantId: T, requestedKey: 'u1' });
    expect(observed.get('u1')).toEqual({ tenantId: T, requestedKey: 'u1' });
  });

  it('a resolver also runs under the context (resolution is inside the fan-out)', async () => {
    let inResolver: string | undefined;
    registerSubjectKeyResolver(async () => { inResolver = currentErasureRequest()?.requestedKey; return []; });
    registerSubjectEraser(async function noop() {});
    await eraseSubject(T, 'u9');
    expect(inResolver).toBe('u9');
  });
});
