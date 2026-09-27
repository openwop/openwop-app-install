/**
 * Idea score-change history (ADR 0230 §B4) — an append-only trail of scoring
 * events: prior/new computed priority, the submitted per-criterion scores, and
 * the actor. Written by `setIdeaScore` (the single scoring choke point — both
 * the HTTP route and the `ctx.features['priority-matrix'].score-idea` verb
 * flow through it, so one call site covers both entry paths, ADR 0208 §3).
 *
 * Best-effort: a history failure must never fail the scoring write. Read
 * surfacing (the "why did this rank change" view) is C7's scope — this module
 * only guarantees the trail exists. Capped per idea (newest kept) as an
 * unbounded-growth guard, not policy.
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';

export interface IdeaScoreChange {
  changeId: string;
  tenantId: string;
  listId: string;
  cardId: string;
  /** The voter for a multi-voter list; absent for single-scorer lists. */
  voterId?: string;
  /** Computed priority before/after this scoring event (absent when unscored). */
  priorPriority?: number;
  newPriority?: number;
  /** The per-criterion scores submitted in this event. */
  scores: Record<string, number>;
  actor: string;
  /** PMXU-1 (ADR 0590) — actor class of the writer (absent = pre-stamp row). */
  source?: 'human' | 'workflow' | 'agent';
  createdAt: string;
}

const changes = new DurableCollection<IdeaScoreChange>(
  'priority:score-change',
  (c) => c.changeId,
  undefined,
  (c) => c.tenantId,
);

const SCORE_HISTORY_CAP_PER_IDEA = 100;

/** History for one idea, oldest→newest. Per-tenant indexed read. */
export async function listIdeaScoreHistory(tenantId: string, listId: string, cardId: string): Promise<IdeaScoreChange[]> {
  return (await changes.listForTenantIndexed(tenantId))
    .filter((c) => c.listId === listId && c.cardId === cardId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export async function appendIdeaScoreChange(input: Omit<IdeaScoreChange, 'changeId' | 'createdAt'>): Promise<void> {
  const row: IdeaScoreChange = { ...input, changeId: `psc:${randomUUID()}`, createdAt: new Date().toISOString() };
  await changes.put(row);
  const existing = await listIdeaScoreHistory(input.tenantId, input.listId, input.cardId);
  const over = existing.length - SCORE_HISTORY_CAP_PER_IDEA;
  for (let i = 0; i < over; i++) await changes.delete(existing[i]!.changeId);
}

/** R2 PM2-M5 — see `erasure.ts`. */
export function __scoreChangesForErasure(): typeof changes {
  return changes;
}

/** R2 PM review — cascade the list's score-change trail; see `deleteIntakeRowsForList`.
 *  PMX-D2 / PMXWF-4 (ADR 0590): when the caller knows the tenant (it always
 *  does — `deleteList` and the teardown purge are tenant-scoped), the sweep
 *  rides the collection's OWN tenant index instead of a cross-tenant full scan. */
export async function deleteScoreChangesForList(listId: string, tenantId?: string): Promise<number> {
  let removed = 0;
  const rows = tenantId !== undefined ? await changes.listForTenantIndexed(tenantId) : await changes.list();
  for (const ch of rows.filter((c) => c.listId === listId)) {
    await changes.delete(ch.changeId);
    removed += 1;
  }
  return removed;
}
