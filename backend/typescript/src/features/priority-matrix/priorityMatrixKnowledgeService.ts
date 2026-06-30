/**
 * Priority Matrix → KB auto-indexer (ADR 0100 Phase 2). The Priority-Matrix
 * counterpart of `strategyKnowledgeService` (Phase 1): mirrors an org's lists +
 * ideas into a managed 'Priority Matrix KB' collection so agents + Boards of
 * Advisors can retrieve prioritized planning content. Composes `kbService`.
 *
 * Invariants (same discipline as Phase 1):
 *  - VISIBILITY = COLLECTION SCOPE: a `projectId`-scoped list inherits its
 *    project's (potentially narrower) visibility, so it + its ideas are NEVER
 *    indexed into the org-shared collection. Only workspace/org-level lists
 *    (no `projectId`) are indexed. `projectId` is immutable after creation
 *    (`updateList` cannot change it), so there is no scope-change reconcile.
 *  - One collection, two doc namespaces: a LIST → `pm-list:<listId>`, an IDEA →
 *    `pm-idea:<cardId>` (no collision).
 *  - BEST-EFFORT / FAIL-OPEN: every entry point swallows + logs; a KB failure
 *    never breaks the Priority-Matrix CRUD.
 *  - GATED on BOTH the `kb` and `priority-matrix` toggles.
 *
 * Note the runtime-only import cycle with `priorityMatrixService` (it imports the
 * index hooks; we import `listRankedIdeas`/`listCards`). ESM resolves it because
 * neither side calls the other at module-eval time — only inside functions.
 *
 * @see docs/adr/0100-planning-knowledge-base.md
 */

import { createLogger } from '../../observability/logger.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { createCollection, deleteDocument, getCollection, getDocument, upsertDocument } from '../kb/kbService.js';
import { type ShareableKbProvider } from '../../host/shareableKb.js';
import { listCards } from '../../host/kanbanService.js';
import { listLists, listRankedIdeas, type RankedIdea } from './priorityMatrixService.js';
import type { PriorityList } from './types.js';

const log = createLogger('priority-matrix-kb');

const MANAGED = 'priority-matrix' as const;
const COLLECTION_NAME = 'Priority Matrix KB';
const collectionIdFor = (orgId: string): string => `mgd-priority-matrix-${orgId}`;
const listDocId = (listId: string): string => `pm-list:${listId}`;
const ideaDocId = (cardId: string): string => `pm-idea:${cardId}`;

/** A list (and its ideas) is shared-scope only when it is NOT project-scoped. */
function isShared(list: PriorityList): boolean {
  return !list.projectId;
}

async function gatesOpen(tenantId: string, userId?: string): Promise<boolean> {
  const subject = { tenantId, ...(userId ? { userId } : {}) };
  // KB is always-on (toggle removed) — only the priority-matrix toggle gates indexing now.
  const pm = await resolveOne('priority-matrix', subject);
  return Boolean(pm?.enabled);
}

async function getOrCreateCollection(tenantId: string, orgId: string, actor: string) {
  const id = collectionIdFor(orgId);
  const existing = await getCollection(tenantId, orgId, id);
  if (existing) return existing;
  const col = await createCollection(tenantId, orgId, actor, { name: COLLECTION_NAME, collectionId: id, managed: MANAGED });
  // First creation ⇒ backfill the org's PRE-EXISTING lists + ideas (see the strategy
  // counterpart). Re-entrant-safe (collection now exists) + idempotent + hash-guarded.
  // BEST-EFFORT so a backfill hiccup never breaks the caller (indexer or board-share ensure).
  try { await backfillPriorityMatrixKb(tenantId, orgId); } catch (err) { log.warn('pm_kb_backfill_on_create_failed', { orgId, err: String(err) }); }
  return col;
}

/**
 * Shareable-KB provider (ADR 0100 D2) — lets a board share the org's Priority
 * Matrix KB with its advisors without importing this feature. `ensure` pre-creates
 * + backfills.
 */
export const priorityMatrixShareableKbProvider: ShareableKbProvider = {
  kind: 'priority-matrix',
  resolveCollectionIds: async (tenantId, orgId) => ((await getCollection(tenantId, orgId, collectionIdFor(orgId))) ? [collectionIdFor(orgId)] : []),
  ensureCollectionIds: async (tenantId, orgId, actor) => [(await getOrCreateCollection(tenantId, orgId, actor)).collectionId],
};

/** Deterministic text for a list's scoring model. */
function formatListForKb(list: PriorityList): string {
  const lines: string[] = [`# Priority list: ${list.name}`];
  if (list.criteriaSet.criteria.length > 0) {
    lines.push('\n## Scoring criteria');
    for (const c of list.criteriaSet.criteria) {
      lines.push(`- ${c.name} (weight ${c.weight}, ${c.direction})${c.description ? ` — ${c.description}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** Deterministic text for one idea, with its status + ranked priority + scores. */
function formatIdeaForKb(list: PriorityList, idea: RankedIdea): string {
  const lines: string[] = [`# Idea: ${idea.card.title}`];
  lines.push(`List: ${list.name} · Status: ${idea.status.columnName} · Priority: ${idea.computedPriority.toFixed(2)} (rank ${idea.rank})`);
  if (idea.card.description) lines.push(`\n${idea.card.description}`);
  const named = list.criteriaSet.criteria
    .map((c) => (idea.scores[c.id] !== undefined ? `${c.name}: ${idea.scores[c.id]}/10` : null))
    .filter((x): x is string => x !== null);
  if (named.length > 0) lines.push(`\n## Scores\n${named.join(' · ')}`);
  return lines.join('\n');
}

/** Reconcile a list's KB presence: shared ⇒ upsert its doc; project-scoped ⇒ remove. */
export async function indexList(tenantId: string, list: PriorityList, actor: string): Promise<void> {
  try {
    if (!(await gatesOpen(tenantId, actor))) return;
    if (!isShared(list)) {
      await removeDoc(tenantId, list.orgId, listDocId(list.id));
      return;
    }
    const col = await getOrCreateCollection(tenantId, list.orgId, actor);
    await upsertDocument(tenantId, list.orgId, col.collectionId, listDocId(list.id), actor, {
      title: list.name,
      text: formatListForKb(list),
      contentTrust: 'trusted',
    });
  } catch (err) {
    log.warn('pm_kb_index_list_failed', { listId: list.id, err: String(err) });
  }
}

/** Upsert one idea's doc (create/score/move). Resolves the ranked idea for its
 *  status + priority; if the card is gone, removes the doc. Skipped for a
 *  project-scoped list (its ideas are not shared). */
export async function indexIdea(tenantId: string, list: PriorityList, cardId: string, actor: string): Promise<void> {
  try {
    if (!(await gatesOpen(tenantId, actor))) return;
    if (!isShared(list)) {
      await removeDoc(tenantId, list.orgId, ideaDocId(cardId));
      return;
    }
    const ranked = await listRankedIdeas(tenantId, list.id);
    const idea = ranked.find((r) => r.card.id === cardId);
    if (!idea) {
      await removeDoc(tenantId, list.orgId, ideaDocId(cardId));
      return;
    }
    const col = await getOrCreateCollection(tenantId, list.orgId, actor);
    await upsertDocument(tenantId, list.orgId, col.collectionId, ideaDocId(cardId), actor, {
      title: idea.card.title,
      text: formatIdeaForKb(list, idea),
      contentTrust: 'trusted',
    });
  } catch (err) {
    log.warn('pm_kb_index_idea_failed', { listId: list.id, cardId, err: String(err) });
  }
}

/**
 * Re-index ALL of a list's idea docs from a single ranking pass. Called when a
 * criteria/weight change re-ranks every idea (so the priority numbers in the KB
 * don't go stale) — O(ideas), one `listRankedIdeas` call, not O(ideas²).
 * Best-effort; skipped for a project-scoped list.
 */
export async function reindexListIdeas(tenantId: string, list: PriorityList, actor: string): Promise<void> {
  try {
    if (!isShared(list) || !(await gatesOpen(tenantId, actor))) return;
    const ranked = await listRankedIdeas(tenantId, list.id);
    if (ranked.length === 0) return;
    const col = await getOrCreateCollection(tenantId, list.orgId, actor);
    for (const idea of ranked) {
      await upsertDocument(tenantId, list.orgId, col.collectionId, ideaDocId(idea.card.id), actor, {
        title: idea.card.title,
        text: formatIdeaForKb(list, idea),
        contentTrust: 'trusted',
      });
    }
  } catch (err) {
    log.warn('pm_kb_reindex_ideas_failed', { listId: list.id, err: String(err) });
  }
}

/**
 * Remove a whole list from the KB: its list doc + every idea doc. Call from
 * `deleteList` with the cardIds captured BEFORE the board is deleted (ideas have
 * no standalone delete path — they vanish only with the list). Best-effort.
 */
export async function removeList(tenantId: string, orgId: string, listId: string, cardIds: string[]): Promise<void> {
  try {
    const collectionId = collectionIdFor(orgId);
    if (!(await getCollection(tenantId, orgId, collectionId))) return;
    await removeDoc(tenantId, orgId, listDocId(listId));
    for (const cardId of cardIds) await removeDoc(tenantId, orgId, ideaDocId(cardId));
  } catch (err) {
    log.warn('pm_kb_remove_list_failed', { listId, err: String(err) });
  }
}

/**
 * Backfill (ADR 0100 Phase 3): reconcile every list + idea in an org against the
 * KB (for entities that predate the toggles flipping on). Idempotent + cheap on
 * re-run (upsert content-hash guard). Returns the count of lists processed.
 * Triggered by the `reindex-kb` route, not the CRUD hot path.
 */
export async function backfillPriorityMatrixKb(tenantId: string, orgId: string): Promise<number> {
  const lists = (await listLists(tenantId)).filter((l) => l.orgId === orgId);
  for (const list of lists) {
    await indexList(tenantId, list, list.createdBy);
    await reindexListIdeas(tenantId, list, list.createdBy); // one ranking pass; skips project-scoped
  }
  return lists.length;
}

/** Capture a list's idea card ids (for removal) — best-effort, empty on failure. */
export async function ideaCardIds(boardId: string): Promise<string[]> {
  try {
    return (await listCards(boardId)).map((c) => c.id);
  } catch {
    return [];
  }
}

/** Idempotent single-doc remove (no-op when the collection/doc never existed). */
async function removeDoc(tenantId: string, orgId: string, documentId: string): Promise<void> {
  const collectionId = collectionIdFor(orgId);
  const col = await getCollection(tenantId, orgId, collectionId);
  if (!col) return;
  const doc = await getDocument(tenantId, orgId, collectionId, documentId);
  if (!doc) return;
  await deleteDocument(tenantId, orgId, collectionId, documentId);
}
