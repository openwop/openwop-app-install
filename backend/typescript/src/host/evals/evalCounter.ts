/**
 * ADR 0977 D1 — the conformance-reserved counter tool `conformance.eval:counter`
 * (`conformance/fixtures.md` §Eval-suite fixtures, RFC 0244 G2).
 *
 * It exists so the suite can OBSERVE whether a scripted call reached a live
 * tool. A call that does reach it under `onMiss: "live"` increments or reads a
 * counter scoped to the run's owner triple and `key`. A fail-mode miss or a
 * served fixture entry never touches it, so a count that did not move proves
 * the call stayed off the live path.
 *
 * It reads no tenant data and has no external effect, which is why the contract
 * lets a production tenant serve it. The live door to it is opened ONLY for a
 * fixture-sourced suite (ADR 0977 D2, `agentEvalRun.ts`).
 *
 * State: one `DurableCollection` row per `(tenant, owner, key)`. Each one
 * survives eval runs, instance replacement and redeploys. It is kept for a day
 * (the contract's floor is one hour) and removed by tenant teardown.
 */
import { createHash } from 'node:crypto';
import { DurableCollection, keyableTenant, registerTenantPurgeHook } from '../hostExtPersistence.js';
import { registerKvAgeOut } from '../kvAgeOut.js';
import { runOwner } from '../runOwner.js';
import type { RunRecord } from '../../types.js';

export const COUNTER_TOOL = 'conformance.eval:counter';

const NAME = 'eval-counter';
const PREFIX = `hostext:${NAME}:`;
/** One day; the contract's floor is one hour (D1). */
const TTL_DAYS = 1;
/** Bounded CAS, the ADR 0973 D2 bound. */
const MAX_INC_ATTEMPTS = 8;
const KEY = /^[A-Za-z0-9._-]{1,64}$/;

interface CounterRow { k: string; tenantId: string; count: number; updatedAt: string }

const rows = new DurableCollection<CounterRow>(NAME, (r) => r.k);

registerKvAgeOut({ id: NAME, prefix: PREFIX, ttlDays: TTL_DAYS, timestampField: 'updatedAt' });

registerTenantPurgeHook(NAME, async (tenantId) => {
  if (!keyableTenant(tenantId)) return 0;
  let deleted = 0;
  for (const r of await rows.listByPrefix(`${tenantId}::`)) {
    if (r.tenantId === tenantId && await rows.delete(r.k)) deleted += 1;
  }
  return deleted;
});

/**
 * The owner part of the key: a hash of the run's STORED owner stamp. It is never
 * re-resolved from a request, because a resumed trial has none. A run with no
 * stamp shares the tenant's `anonymous` bucket.
 */
export function counterOwnerHash(run: Pick<RunRecord, 'tenantId' | 'metadata'>): string {
  const owner = runOwner(run);
  const material = owner?.principal && owner.subject
    ? [owner.principal, owner.subject.issuer, owner.subject.subjectId].join('\n')
    : 'anonymous';
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

export type CounterResult =
  | { ok: true; value: { key: string; count: number } }
  | { ok: false; code: 'invalid_counter_input' | 'counter_contention'; message: string };

/** Execute one live counter call for `run`. Never throws for bad input or contention. */
export async function runCounter(run: Pick<RunRecord, 'tenantId' | 'metadata'>, input: Record<string, unknown>): Promise<CounterResult> {
  const key = input.key;
  const op = input.op;
  if (typeof key !== 'string' || !KEY.test(key) || (op !== 'inc' && op !== 'read') || !keyableTenant(run.tenantId)) {
    return { ok: false, code: 'invalid_counter_input', message: 'counter input must be {key: [A-Za-z0-9._-]{1,64}, op: "inc" | "read"}' };
  }
  const k = `${run.tenantId}::${counterOwnerHash(run)}::${key}`;
  if (op === 'read') {
    const row = await rows.get(k);
    return { ok: true, value: { key, count: row?.count ?? 0 } };
  }
  for (let attempt = 0; attempt < MAX_INC_ATTEMPTS; attempt += 1) {
    const row = await rows.get(k);
    const next: CounterRow = { k, tenantId: run.tenantId, count: (row?.count ?? 0) + 1, updatedAt: new Date().toISOString() };
    if (await rows.compareAndSwap(row, next)) return { ok: true, value: { key, count: next.count } };
  }
  return { ok: false, code: 'counter_contention', message: 'counter increment lost every compare-and-swap attempt' };
}
