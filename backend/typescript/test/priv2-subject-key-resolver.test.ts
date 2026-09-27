/**
 * PRIV-2 / ADR 0381 — the subject-key resolver seam in `host/subjectErasure.ts`.
 *
 * `eraseSubject` expands the subject to ALL its linked identity keys UPFRONT (via registered
 * resolvers) and invokes each eraser once per key — so a delete keyed by one identity reaches
 * data keyed by a linked identity, WITHOUT racing another eraser's deletion of the link.
 *
 * These are pure seam-unit tests with fake erasers/resolvers; `__reset*` isolates the global
 * registries (vitest runs each test file in its own module context, so the reset never leaks to
 * the integration test in priv1-order-erasure.test.ts). The end-to-end proof (a sessionKey
 * erasure anonymizing a linked contact's order) lives there.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import {
  eraseSubject,
  registerSubjectEraser,
  registerSubjectKeyResolver,
  __resetSubjectErasers,
  __resetSubjectKeyResolvers,
} from '../src/host/subjectErasure.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';

const T = 'tA';

// `eraseSubject` now calls `assertNoRetentionHold` (review F2), and the hold is a
// DurableCollection — so this ADR 0381 suite needs persistence to reach the fan-out
// it is actually about. Without it every case dies at the gate with
// "host-ext persistence not initialized", which reads as a resolver defect and is not.
// A memory:// store keeps the suite a unit test: no tenant is ever held, so the gate
// passes and the assertions below still discriminate resolver behaviour alone.
beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  __resetSubjectErasers();
  __resetSubjectKeyResolvers();
});

describe('ADR 0381 — subject-key resolver + resolve-then-fan-out', () => {
  it('invokes each eraser once per RESOLVED key (subject + its linked keys)', async () => {
    const seen: string[] = [];
    registerSubjectEraser(async function recordSeenKey(_t, key) { seen.push(key); });
    registerSubjectKeyResolver(async (_t, subject) => (subject === 'sess-1' ? ['contact-1'] : []));

    const res = await eraseSubject(T, 'sess-1');
    expect(seen.sort()).toEqual(['contact-1', 'sess-1']); // the eraser saw BOTH identities
    expect(res).toMatchObject({ total: 1, failed: 0, keysResolved: 2 });
  });

  it('resolution happens UPFRONT — an eraser that deletes the link cannot hide keys from another eraser (the ordering hazard)', async () => {
    // Simulate the real hazard: the "link" eraser registers FIRST and would destroy the mapping.
    // Because resolution runs before ANY eraser, the downstream eraser still receives every key.
    let linkDeleted = false;
    const downstreamSaw: string[] = [];
    registerSubjectEraser(async function deleteTheLink() { linkDeleted = true; });            // registered first (like analytics)
    registerSubjectEraser(async function recordDownstreamKey(_t, key) { downstreamSaw.push(key); }); // registered second (like commerce)
    registerSubjectKeyResolver(async (_t, subject) => {
      if (linkDeleted) return []; // if this ran DURING fan-out (after the link eraser) it'd miss keys
      return subject === 'sess-1' ? ['contact-1'] : [];
    });

    await eraseSubject(T, 'sess-1');
    expect(downstreamSaw.sort()).toEqual(['contact-1', 'sess-1']); // got the resolved key despite the link eraser
  });

  it('a throwing resolver never BLOCKS erasure (bare key still erased) — but it now COUNTS as a failure', async () => {
    const seen: string[] = [];
    registerSubjectEraser(async function recordSeenKey(_t, key) { seen.push(key); });
    registerSubjectKeyResolver(async () => { throw new Error('resolver down'); });

    const res = await eraseSubject(T, 'contact-1');
    expect(seen).toEqual(['contact-1']); // degraded to the bare key, erasure still ran
    // R2 CN-SP-1 — this assertion previously PINNED the defect (failed: 0):
    // unenumerated linked keys are unerased data, so a resolver failure makes
    // the erasure INCOMPLETE, never silently "ok".
    expect(res).toMatchObject({ total: 1, failed: 1, keysResolved: 1, resolverFailures: 1 });
    expect(res.failedFeatures).toContain('identity-link-resolution');
  });

  it('unions keys from multiple resolvers and dedupes (no double-erase of the same key)', async () => {
    const counts = new Map<string, number>();
    registerSubjectEraser(async function countPerKey(_t, key) { counts.set(key, (counts.get(key) ?? 0) + 1); });
    registerSubjectKeyResolver(async () => ['k2', 'k3']);
    registerSubjectKeyResolver(async () => ['k3', 'k4']); // k3 overlaps

    const res = await eraseSubject(T, 'k1');
    expect([...counts.entries()].sort()).toEqual([['k1', 1], ['k2', 1], ['k3', 1], ['k4', 1]]);
    expect(res.keysResolved).toBe(4);
  });

  it('failed counts DISTINCT erasers (not per-key calls) — the {failed>0} contract is preserved', async () => {
    let calls = 0;
    registerSubjectEraser(async function alwaysFails() { calls += 1; throw new Error('always fails'); }); // fails for every key
    registerSubjectEraser(async function alwaysSucceeds() { /* ok */ });
    registerSubjectKeyResolver(async () => ['k2', 'k3']); // 3 keys total

    const res = await eraseSubject(T, 'k1');
    expect(calls).toBe(3);                 // the failing eraser was invoked once per key
    expect(res).toMatchObject({ total: 2, failed: 1, keysResolved: 3 }); // but counted as ONE failed eraser
  });

  it('a resolver that returns the subject itself does not double-invoke the erasers', async () => {
    const seen: string[] = [];
    registerSubjectEraser(async function recordSeenKey(_t, key) { seen.push(key); });
    registerSubjectKeyResolver(async (_t, subject) => [subject, 'contact-1']); // echoes the subject

    await eraseSubject(T, 'sess-1');
    expect(seen.sort()).toEqual(['contact-1', 'sess-1']); // sess-1 erased once, not twice
  });
});
