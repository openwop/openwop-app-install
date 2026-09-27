/**
 * Strategy version snapshots (ADR 0230 §B4) — append-only revision rows, the
 * CMS PageVersion pattern. A revision snapshots the strategy AS PERSISTED
 * (appended after the successful `strategies.put`, never before) with
 * distinct-content dedupe: the hash EXCLUDES `updatedAt`, so a no-op PATCH
 * appends nothing. Best-effort: a revision failure must never fail the
 * mutation (callers `void`+catch).
 *
 * Storage (architect Q3): its own DurableCollection keyed
 * `${tenantId}::${strategyId}::${n}` with a tenant secondary index — reads are
 * per-tenant slices, never cross-tenant scans (the CRMGAP-3 rule). Cap: the
 * newest {@link STRATEGY_REVISION_CAP} revisions per strategy are kept (an
 * implementation guard against unbounded growth, not policy).
 *
 * Concurrency note: two racing mutations can compute the same `n`; the loser's
 * snapshot is overwritten (one history row lost, the entity itself is fine).
 * Revisions are a best-effort trail, not a ledger — acceptable by design.
 */
import { createHash } from 'node:crypto';
import { ERASED_USER_REF } from '../../host/subjectErasureRedaction.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import type { Strategy } from './types.js';

export interface StrategyRevision {
  /** `${tenantId}::${strategyId}::${n}` — deterministic, per-strategy ordered. */
  revisionId: string;
  tenantId: string;
  strategyId: string;
  n: number;
  /** The full strategy as persisted (content restore reads from this). */
  snapshot: Strategy;
  /** sha256 over the snapshot EXCLUDING `updatedAt` (dedupe key). */
  contentHash: string;
  /** Opaque actor id — principal for HTTP callers, `run:<runId>` for verbs. */
  actor: string;
  createdAt: string;
}

const revisions = new DurableCollection<StrategyRevision>(
  'strategy:revision',
  (r) => r.revisionId,
  undefined,
  (r) => r.tenantId,
);

export const STRATEGY_REVISION_CAP = 50;

function contentHash(s: Strategy): string {
  const { updatedAt: _updatedAt, ...rest } = s;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

/** All revisions for one strategy, oldest→newest. Per-tenant indexed read. */
export async function listStrategyRevisions(tenantId: string, strategyId: string): Promise<StrategyRevision[]> {
  return (await revisions.listForTenantIndexed(tenantId))
    .filter((r) => r.strategyId === strategyId)
    .sort((a, b) => a.n - b.n);
}

export async function getStrategyRevision(tenantId: string, strategyId: string, n: number): Promise<StrategyRevision | null> {
  const r = await revisions.get(`${tenantId}::${strategyId}::${n}`);
  return r && r.tenantId === tenantId && r.strategyId === strategyId ? r : null;
}

/**
 * Append a revision of the just-persisted strategy unless its content matches
 * the newest existing revision (dedupe). Prunes beyond the cap (oldest first).
 */
export async function appendStrategyRevision(strategy: Strategy, actor: string): Promise<StrategyRevision | null> {
  const existing = await listStrategyRevisions(strategy.tenantId, strategy.id);
  const hash = contentHash(strategy);
  const last = existing[existing.length - 1];
  if (last && last.contentHash === hash) return null;
  const n = (last?.n ?? 0) + 1;
  const rev: StrategyRevision = {
    revisionId: `${strategy.tenantId}::${strategy.id}::${n}`,
    tenantId: strategy.tenantId,
    strategyId: strategy.id,
    n,
    snapshot: structuredClone(strategy),
    contentHash: hash,
    actor,
    createdAt: new Date().toISOString(),
  };
  await revisions.put(rev);
  const over = existing.length + 1 - STRATEGY_REVISION_CAP;
  for (let i = 0; i < over; i++) await revisions.delete(existing[i]!.revisionId);
  return rev;
}

/** Hard-delete cascade (called from `hardDeleteStrategy`). */
export async function deleteStrategyRevisions(tenantId: string, strategyId: string): Promise<void> {
  for (const r of await listStrategyRevisions(tenantId, strategyId)) await revisions.delete(r.revisionId);
}

/**
 * R2 STR2-M7 — the revision trail keeps its shape; the person-links are severed.
 *
 * CORRECTION (review): the first version anonymised `actor` ONLY, and `snapshot` is a full
 * clone of the strategy — `createdBy`, `ownerUserId` and every `initiative.ownerUserId`
 * live inside it, up to 50 snapshots per strategy. So a DSAR reported success while the id
 * survived in the history, and a version RESTORE wrote it straight back onto the live row.
 * `contentHash` is deliberately left alone: it is a dedupe key, not a ledger.
 */
export async function eraseRevisionSubject(tenantId: string, forms: ReadonlySet<string>): Promise<void> {
  for (const r of await revisions.list()) {
    if (r.tenantId !== tenantId) continue;
    const next = { ...r };
    let touched = false;
    if (forms.has(r.actor)) { next.actor = ERASED_USER_REF; touched = true; }
    const snap = r.snapshot;
    if (snap) {
      const nextSnap = { ...snap };
      if (forms.has(nextSnap.createdBy)) { nextSnap.createdBy = ERASED_USER_REF; touched = true; }
      if (nextSnap.ownerUserId !== undefined && forms.has(nextSnap.ownerUserId)) { nextSnap.ownerUserId = ERASED_USER_REF; touched = true; }
      nextSnap.initiatives = nextSnap.initiatives.map((i) => {
        if (i.ownerUserId === undefined || !forms.has(i.ownerUserId)) return i;
        touched = true;
        return { ...i, ownerUserId: ERASED_USER_REF };
      });
      if (touched) next.snapshot = nextSnap;
    }
    if (touched) await revisions.put(next);
  }
}
