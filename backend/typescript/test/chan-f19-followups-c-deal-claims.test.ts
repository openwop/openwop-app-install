/**
 * CHAN-F19 follow-up C (ADR 0464 §9) — `commissions:deal-claim` erasure of an ORPHAN claim
 * (its statement is gone, so `repointClaims` never sees it). The claim id embeds the rep
 * (`planId:subjectId:period`), and `eraseClaimSubjects` rewrites that segment.
 *
 * The bug this pins: the rewrite's compare-and-swap result was ignored, so a write that
 * landed between the list and the swap left the rep's id in the claim, and the erasure
 * reported success. It now retries on a fresh read, as `repointClaims` does.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - the retry loop reduced to one ignored CAS (the old code)  → "a concurrent write"
 *  - `forms.has` on the subject segment inverted              → "rewrites the rep"
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { claimDeals, eraseClaimSubjects, listPlanClaims } from '../src/features/sales-commissions/entities/dealClaims.js';

const T = 'org:f19c';
const O = 'org:f19c';
const PLAN = 'plan-1';
const REP = 'rep-erased';
const ERASED = 'user:[erased]';

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('eraseClaimSubjects: an orphan claim no longer names the rep', () => {
  it('rewrites the rep segment and leaves another rep’s claim alone', async () => {
    await claimDeals(T, O, PLAN, `${PLAN}:${REP}:2026-10`, ['deal-a'], '2026-10-31T00:00:00Z');
    await claimDeals(T, O, PLAN, `${PLAN}:rep-kept:2026-10`, ['deal-b'], '2026-10-31T00:00:00Z');
    await eraseClaimSubjects(T, new Set([REP]), ERASED);
    const byDeal = new Map((await listPlanClaims(T, O, PLAN)).map((c) => [c.dealId, c.statementId]));
    expect(byDeal.get('deal-a')).toBe(`${PLAN}:${ERASED}:2026-10`);
    expect(byDeal.get('deal-b')).toBe(`${PLAN}:rep-kept:2026-10`);
  });

  it('a concurrent write that beats the first swap is retried, not ignored', async () => {
    await claimDeals(T, O, PLAN, `${PLAN}:${REP}:2026-10`, ['deal-a'], '2026-10-31T00:00:00Z');
    let raced = false;
    const racing = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'kvCompareAndSwap') {
          return async (key: string, expected: string | null, next: string) => {
            if (!raced && key.startsWith('hostext:commissions:deal-claim:')) {
              raced = true; // another writer touches the claim between the read and the swap
              const cur = JSON.parse((await target.kvGet(key))!) as Record<string, unknown>;
              await target.kvSet(key, JSON.stringify({ ...cur, at: '2026-11-01T00:00:00Z' }));
            }
            return target.kvCompareAndSwap(key, expected, next);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    initHostExtPersistence(racing);
    await eraseClaimSubjects(T, new Set([REP]), ERASED);
    expect(raced).toBe(true);
    const [c] = await listPlanClaims(T, O, PLAN);
    expect(c!.statementId).toBe(`${PLAN}:${ERASED}:2026-10`);
    expect(c!.statementId).not.toContain(REP);
  });
});
