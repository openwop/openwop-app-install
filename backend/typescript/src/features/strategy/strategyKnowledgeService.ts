/**
 * Strategy → KB auto-indexer (ADR 0100 Phase 1).
 *
 * Mirrors the org's SHARED strategies into a managed 'Strategy KB' collection so
 * agents and Boards of Advisors can RETRIEVE planning content (via the existing
 * per-agent knowledge binding, ADR 0038). A thin composition over `kbService`
 * (the `projectKnowledgeService`/`profileKnowledgeService` precedent) — no new
 * store, no new vector surface.
 *
 * Invariants:
 *  - VISIBILITY = COLLECTION SCOPE (the ADR's CRITICAL RBAC carve-out): only an
 *    `org`/`workspace`-scoped strategy is indexed into the org-shared collection;
 *    a `user`-private strategy is NEVER placed there (and a scope change
 *    org→user, or an archive, REMOVES the doc). `indexStrategy` RECONCILES
 *    presence with the current scope+status — it is not append-only.
 *  - KB presence ≡ SHARED ∧ not-archived. A `draft`/`active`/`paused`/`completed`
 *    shared strategy is retrievable; `archived` is removed.
 *  - BEST-EFFORT / FAIL-OPEN: every entry point swallows its own errors + logs;
 *    a KB failure MUST NOT break the Strategy CRUD. A partial failure self-heals
 *    on the next mutation (upsert is keyed by the strategy's stable id).
 *  - GATED: runs only when BOTH the `kb` and `strategy` toggles are enabled
 *    (ADR 0100 — always-on, no dedicated toggle).
 *
 * @see docs/adr/0100-planning-knowledge-base.md
 */

import { createLogger } from '../../observability/logger.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { createCollection, deleteDocument, getCollection, getDocument, upsertDocument } from '../kb/kbService.js';
import { kbMutated, type KbEmitOptions } from '../kb/emit.js'; // ADR 0643 D3 — silent per-row sweeps + ONE batch event
import { type ShareableKbProvider } from '../../host/shareableKb.js';
import { listStrategies } from './strategyService.js';
import type { Strategy } from './types.js';

const log = createLogger('strategy-kb');

const MANAGED = 'strategy' as const;
const COLLECTION_NAME = 'Strategy KB';
/** Deterministic per-org id ⇒ the managed collection resolves by point lookup,
 *  no scan. Org-qualified so it is unique across the tenant's orgs. */
const collectionIdFor = (orgId: string): string => `mgd-strategy-${orgId}`;

/** A strategy belongs in the org-shared KB only when it is shared-scope AND live
 *  (not archived). User-private and archived strategies are removed. */
function shouldIndex(s: Strategy): boolean {
  return (s.scope === 'org' || s.scope === 'workspace') && s.status !== 'archived';
}

async function gatesOpen(tenantId: string, userId?: string): Promise<boolean> {
  const subject = { tenantId, ...(userId ? { userId } : {}) };
  // KB is always-on (toggle removed) — only the strategy toggle gates indexing now.
  const strategy = await resolveOne('strategy', subject);
  return Boolean(strategy?.enabled);
}

async function getOrCreateCollection(tenantId: string, orgId: string, actor: string) {
  const id = collectionIdFor(orgId);
  const existing = await getCollection(tenantId, orgId, id);
  if (existing) return existing;
  const col = await createCollection(tenantId, orgId, actor, { name: COLLECTION_NAME }, { collectionId: id, managed: MANAGED });
  // First creation ⇒ backfill the org's PRE-EXISTING shared strategies. Always-on
  // gating only catches future CRUD, so without this a strategy that predates the
  // toggle flip stays invisible (the user wants existing items guaranteed in).
  // Re-entrant-safe: the collection now exists, so the backfill's own indexStrategy
  // calls resolve it without re-creating. Idempotent + hash-guarded. BEST-EFFORT:
  // a backfill failure must not break the caller (the indexer is best-effort, and
  // the board-share `ensure` path must still bind even if backfill hiccups).
  try { await backfillStrategyKb(tenantId, orgId); } catch (err) { log.warn('strategy_kb_backfill_on_create_failed', { orgId, err: String(err) }); }
  return col;
}

/**
 * Shareable-KB provider (ADR 0100 D2) — lets a Board of Advisors share the org's
 * Strategy KB with its advisors WITHOUT the board importing this feature. Managed
 * collection: `ensure` pre-creates + backfills so a board can pre-share an empty KB.
 */
export const strategyShareableKbProvider: ShareableKbProvider = {
  kind: 'strategy',
  // ADR 0667 D6 (PMXWF-13 / the GEN-RCL-1 arity class) — takes the 3-ary contract's
  // `opts` even though it does not branch on it. This kind's shareable set is a
  // SINGLETON whose only predicate is existence, and its visibility carve-out is
  // applied at the DOC layer during indexing, which cannot change WHICH collection id
  // resolves — so the `forUnshare` superset is provably identical to the normal set
  // for every input, today. The parameter is accepted anyway because a provider that
  // does not ACCEPT it cannot be proved inert BY ITS SIGNATURE: the next carve-out
  // added here would silently skip unshare, with nothing in the type to catch it.
  resolveCollectionIds: async (tenantId, orgId, _opts) => ((await getCollection(tenantId, orgId, collectionIdFor(orgId))) ? [collectionIdFor(orgId)] : []),
  ensureCollectionIds: async (tenantId, orgId, actor) => [(await getOrCreateCollection(tenantId, orgId, actor)).collectionId],
};

/**
 * Deterministic indexable text from the strategy's OWN stored fields only.
 * Linked projects/priorities are deliberately EXCLUDED — they are resolved live
 * elsewhere and are a cross-org readability concern (ADR 0100 open Q); copying
 * them into the doc could leak a non-readable target's data.
 */
export function formatStrategyForKb(s: Strategy): string {
  const lines: string[] = [];
  lines.push(`# ${s.title}`);
  lines.push(`Status: ${s.status} · Horizon: ${s.planningHorizon} · Period: ${s.period.label}`);
  if (s.confidence) lines.push(`Confidence: ${s.confidence}`);
  if (s.risk) lines.push(`Risk: ${s.risk}`);
  if (s.summary) lines.push(`\n## Summary\n${s.summary}`);
  if (s.rationale) lines.push(`\n## Rationale\n${s.rationale}`);
  if (s.objectives.length > 0) {
    lines.push('\n## Objectives');
    for (const o of s.objectives) {
      lines.push(`- ${o.title}`);
      for (const kr of o.keyResults) {
        const progress = [kr.current, kr.target].filter(Boolean).join(' → ');
        const detail = progress ? ` (${progress}${kr.unit ? ` ${kr.unit}` : ''})` : '';
        lines.push(`  - KR: ${kr.title}${detail}${kr.status ? ` [${kr.status}]` : ''}`);
      }
    }
  }
  if (s.initiatives.length > 0) {
    lines.push('\n## Initiatives');
    for (const i of s.initiatives) lines.push(`- ${i.title}${i.status ? ` [${i.status}]` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Reconcile a strategy's KB presence with its current scope+status. Shared+live
 * ⇒ upsert (stable id = strategy.id); private or archived ⇒ remove. Best-effort.
 */
export async function indexStrategy(tenantId: string, strategy: Strategy, actor: string, emit: KbEmitOptions = {}): Promise<void> {
  try {
    if (!(await gatesOpen(tenantId, actor))) return;
    if (!shouldIndex(strategy)) {
      await removeStrategy(tenantId, strategy.orgId, strategy.id, emit);
      return;
    }
    const col = await getOrCreateCollection(tenantId, strategy.orgId, actor);
    await upsertDocument(tenantId, strategy.orgId, col.collectionId, strategy.id, actor, {
      title: strategy.title,
      text: formatStrategyForKb(strategy),
      contentTrust: 'trusted',
      ...emit, // ADR 0643 D3 — the backfill sweep passes `{ silent: true }`
    });
  } catch (err) {
    log.warn('strategy_kb_index_failed', { strategyId: strategy.id, err: String(err) });
  }
}

/**
 * Backfill (ADR 0100 Phase 3): reconcile EVERY strategy in an org against the KB
 * — needed because always-on gating only catches future CRUD, so entities that
 * existed before the toggles flipped on are otherwise invisible. Idempotent and
 * cheap on re-run (the upsert content-hash guard skips unchanged docs). Returns
 * the count processed. Best-effort per strategy (indexStrategy swallows its own
 * errors). Triggered by the `reindex-kb` route, not on the CRUD hot path.
 */
export async function backfillStrategyKb(tenantId: string, orgId: string): Promise<number> {
  const all = await listStrategies(tenantId, { orgId, includeArchived: true });
  // ADR 0643 D3 — a BULK lane: silent per row, ONE `document.ingested { count }`.
  for (const s of all) await indexStrategy(tenantId, s, s.createdBy, { silent: true });
  const count = all.filter(shouldIndex).length;
  if (count > 0) await kbMutated({ entity: 'document', verb: 'ingested', tenantId, orgId, collectionId: collectionIdFor(orgId), count });
  return all.length;
}

/**
 * Remove a strategy's KB doc (hard-delete, archive, or scope→private). Idempotent
 * — a no-op when the collection or doc never existed (so it tolerates a
 * first-index remove). Best-effort; never gated (removal must succeed even if a
 * toggle flips off between index and delete).
 *
 * ADR 0597 §Correction 6 — RETURNS the outcome instead of only swallowing it.
 * `true` means the doc is provably absent (deleted, or was never there);
 * `false` means the attempt FAILED and a doc may still be sitting in that org's
 * shared, `contentTrust:'trusted'` collection. The caller that evicts on an ORG
 * MOVE needs that distinction because, unlike an archive, a failed eviction
 * there is a cross-org exposure with NO self-heal: `backfillStrategyKb` is
 * driven by `listStrategies(tenantId, {orgId})`, and a relocated strategy now
 * carries the NEW orgId, so re-indexing the OLD org never visits it and nothing
 * anywhere enumerates KB docs looking for one with no backing strategy.
 */
export async function removeStrategy(tenantId: string, orgId: string, strategyId: string, emit: KbEmitOptions = {}): Promise<boolean> {
  try {
    const collectionId = collectionIdFor(orgId);
    const col = await getCollection(tenantId, orgId, collectionId);
    if (!col) return true;
    const doc = await getDocument(tenantId, orgId, collectionId, strategyId);
    if (!doc) return true; // never indexed / already removed — idempotent
    await deleteDocument(tenantId, orgId, collectionId, strategyId, undefined, emit);
    return true;
  } catch (err) {
    log.warn('strategy_kb_remove_failed', { strategyId, err: String(err) });
    return false;
  }
}
