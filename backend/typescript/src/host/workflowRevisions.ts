/**
 * ADR 0474 — the workflow revision store: append-only, content-hash-keyed
 * history for TENANT-OWNED workflow definitions.
 *
 * One row per distinct definition CONTENT (`${workflowId}:${revisionHash}`,
 * hash = `revisionHashOf` — lifecycle-stripped, so archive/promote re-registers
 * upsert the same row and never mint noise). `recordRevision` is called beside
 * `recordOwnership` at every tenant-content write site — and ONLY there: boot/
 * seed registrations and the chain-backed registry (already pack-versioned)
 * are excluded by design. The pairing is enforced by a source-scan test
 * (`workflow-revision-pairing.test.ts`), not by convention.
 *
 * Growth: capped per workflow (`OPENWOP_WORKFLOW_REVISIONS_KEEP`, default 50),
 * pruned opportunistically on write (the `pruneResolved` pattern). The
 * PUBLISHED revision and the current head are never pruned. A pruned revision
 * pinned by an ancient run degrades that run's re-resolve to head-by-id —
 * exactly the pre-ADR-0474 behavior, so the store is a strictly monotone
 * improvement.
 *
 * Deletion: `deleteWorkflowRevisions` is cascaded from
 * `deleteRegisteredWorkflow` (all five delete callers inherit); tenant
 * teardown additionally reaches rows via the tenant extractor.
 */

import { DurableCollection } from './hostExtPersistence.js';
import { revisionHashOf } from './definitionHash.js';
import { getOwned } from './workflowOwnership.js';
import { onWorkflowDeleted } from './workflowsRegistry.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { ERASED, subjectKeyForms } from './subjectErasureRedaction.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.workflowRevisions');

// ADR 0474 — cascade with the definition (all five delete callers inherit
// through the registry's one deletion seam).
onWorkflowDeleted((workflowId) => deleteWorkflowRevisions(workflowId));

export interface WorkflowRevisionRecord {
  /** `${workflowId}:${revisionHash}` */
  key: string;
  workflowId: string;
  tenantId: string;
  revisionHash: string;
  /** The full definition AS REGISTERED (lifecycle included — the hash strips
   *  it, the snapshot keeps it, so a restore reproduces the row verbatim). */
  definition: WorkflowDefinition;
  name?: string;
  nodeCount: number;
  createdAt: string;
  /** Per-workflow monotonic sequence — the durable ORDER (createdAt ties at
   *  millisecond resolution; a rollback re-registering old content bumps the
   *  existing row's seq, honestly re-ordering it to the front as the new head). */
  seq: number;
  /** The head's revision hash at the moment this one replaced it — provenance
   *  (absent on a workflow's first revision). NOT the sort key — `seq` is. */
  supersedes?: string;
  /** Acting user when the write path knew one (never required — ADR 0474 OQ2). */
  createdBy?: string;
  /**
   * ADR 0524 Phase E — the field contract the WRITER declared
   * (`x-openwop-field-contract`), when it declared one.
   *
   * WHY THIS IS RECORDED AND NOT INFERRED. The Phase C repair restores node
   * `inputs` to a head that carries none, sourced from an earlier revision that
   * did. That is correct while a preset input cannot be CLEARED — but the day
   * editable preset inputs ship, "no inputs" becomes an expressible authoring
   * choice, and the repair would resurrect values a user deliberately removed.
   *
   * The durable rows cannot tell those two zeroes apart on their own: a head
   * stripped by an old bundle and a head cleared on purpose look identical.
   * This stamp is the discriminator — a zero written by a client that DECLARED
   * it models `inputs` is intentional, and the repair must leave it alone.
   *
   * Not part of the content hash: `revisionHashOf` hashes the DEFINITION
   * (`definitionHash.ts:29`), so stamping this changes no key, breaks no
   * dedup, and is invisible to replay and `:fork`.
   */
  declaredFields?: string[];
}

/**
 * The host-level tenant sentinel for revisions that belong to a GLOBAL definition
 * rather than to any one tenant (the seeded `wf.seed.*` rows every tenant shares).
 * Matches the established convention — no real tenant id is `'host'`
 * (cf. `webhookSecretCodec.ts`'s `KmsAadContext`).
 *
 * Exported so the History route filters on the SAME constant the writer uses; a
 * duplicated string literal on either side is how a display filter silently stops
 * matching. Unforgeable by a tenant: every `recordRevision` caller passes a resolved
 * scope value, never request input.
 */
export const HOST_REVISION_TENANT = 'host';

/**
 * Is this revision row visible in `tenantId`'s History drawer?
 *
 * THE predicate — exported so the route and its test share one definition rather
 * than each carrying a copy. A test that re-implements the rule passes even when the
 * route applies no filter at all, which is precisely the failure this guards.
 *
 * Two admissible cases: the tenant's own rows, and HOST-attributed rows (a global
 * `wf.seed.*` definition's history belongs to no single tenant). Foreign TENANT rows
 * are excluded — the Review M5 property.
 */
export function revisionVisibleTo(tenantId: string, row: { tenantId: string }): boolean {
  return row.tenantId === tenantId || row.tenantId === HOST_REVISION_TENANT;
}

const store = new DurableCollection<WorkflowRevisionRecord>(
  'workflow:revision',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

// Review L2 — WORKFLOW_ID_PATTERN admits ':', so raw `${workflowId}:${hash}`
// keys are prefix-ambiguous (`a` vs `a:b`). Encode the id component (the
// policy-store precedent); the hash is hex and needs none.
const keyOf = (workflowId: string, revisionHash: string): string => `${encodeURIComponent(workflowId)}:${revisionHash}`;
const prefixOf = (workflowId: string): string => `${encodeURIComponent(workflowId)}:`;

function revisionsKeep(): number {
  const raw = Number(process.env.OPENWOP_WORKFLOW_REVISIONS_KEEP);
  return Number.isFinite(raw) && raw >= 2 ? raw : 50;
}

/** Track the current head hash per workflow so `supersedes` chains without a
 *  full list scan. Derived, best-effort; the durable rows are the truth. */
const headHash = new Map<string, string>();

/**
 * Append (idempotently) the revision for a tenant-content write. Same content
 * ⇒ same key ⇒ refresh-only upsert (no duplicate history). Never throws into
 * the write path — history must not break saves (failures are logged; the
 * pairing test + list route surface systemic breakage).
 *
 * Concurrency (review L1, accepted): read-latest-then-put means two concurrent
 * writes can mint duplicate `seq` / fork the `supersedes` chain — the
 * consequence is ordering ambiguity only (tie-broken by key; `isHead` is
 * computed from the registry, never from seq), so no CAS is warranted here.
 */
export async function recordRevision(
  tenantId: string,
  def: WorkflowDefinition,
  opts: { createdBy?: string; declaredFields?: readonly string[] } = {},
): Promise<string | null> {
  try {
    const hash = revisionHashOf(def);
    const key = keyOf(def.workflowId, hash);
    const head = await latestRevision(def.workflowId);
    const existing = await store.get(key);
    if (existing) {
      // Same content re-registered (autosave echo / lifecycle verb / ROLLBACK):
      // bump seq only when this row is not already the head — a rollback
      // honestly re-orders the restored revision to the front.
      const reorder = Boolean(head && head.key !== existing.key);
      // ADR 0524 Phase E — a DECLARATION can arrive on content that already
      // exists. §Correction: the first cut only wrote inside the reorder branch,
      // so re-saving an already-empty workflow from the builder — which is
      // exactly how a user CONFIRMS the zero is deliberate — left the row
      // unstamped and the repair free to resurrect it. Caught by its own test.
      const newlyDeclared = Boolean(
        opts.declaredFields?.length
        && opts.declaredFields.join(',') !== (existing.declaredFields ?? []).join(','),
      );
      if (reorder || newlyDeclared) {
        await store.put({
          ...existing,
          // Only a real reorder moves `seq`; a stamp-only write must not
          // re-order history, or every autosave echo would churn the ordering.
          ...(reorder && head ? { seq: head.seq + 1, supersedes: head.revisionHash } : {}),
          ...(opts.declaredFields?.length ? { declaredFields: [...opts.declaredFields] } : {}),
        });
      }
      headHash.set(def.workflowId, hash);
      return hash;
    }
    const name = typeof def.metadata?.name === 'string' ? def.metadata.name : undefined;
    await store.put({
      key,
      workflowId: def.workflowId,
      tenantId,
      revisionHash: hash,
      definition: def,
      ...(name !== undefined ? { name } : {}),
      nodeCount: def.nodes.length,
      createdAt: new Date().toISOString(),
      seq: (head?.seq ?? 0) + 1,
      ...(head && head.revisionHash !== hash ? { supersedes: head.revisionHash } : {}),
      ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
      ...(opts.declaredFields?.length ? { declaredFields: [...opts.declaredFields] } : {}),
    });
    headHash.set(def.workflowId, hash);
    await pruneRevisions(tenantId, def.workflowId);
    return hash;
  } catch (err) {
    log.warn('workflow_revision_record_failed', {
      workflowId: def.workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** All revisions for one workflow, newest first — ordered by the durable
 *  per-workflow `seq` (millisecond `createdAt` ties, and rollbacks re-heading
 *  old rows, make time an unreliable order). */
export async function listRevisions(workflowId: string): Promise<WorkflowRevisionRecord[]> {
  const rows = await store.listByPrefix(prefixOf(workflowId));
  return rows.sort((a, b) => (b.seq - a.seq) || b.key.localeCompare(a.key));
}

export async function getRevision(workflowId: string, revisionHash: string): Promise<WorkflowRevisionRecord | null> {
  return store.get(keyOf(workflowId, revisionHash));
}

/** The most recent revision row (the head's content, when history exists). */
export async function latestRevision(workflowId: string): Promise<WorkflowRevisionRecord | null> {
  return (await listRevisions(workflowId))[0] ?? null;
}

/** Cascade for `deleteRegisteredWorkflow` — the definition is gone, history
 *  goes with it (GC/teardown/DELETE all inherit through the one registrar). */
export async function deleteWorkflowRevisions(workflowId: string): Promise<number> {
  const rows = await store.listByPrefix(prefixOf(workflowId));
  for (const r of rows) await store.delete(r.key);
  headHash.delete(workflowId);
  return rows.length;
}

/** Keep-N prune (the approvalService `pruneResolved` pattern): newest first,
 *  overflow deleted — but NEVER the published revision, the current head, or
 *  (review M3) the newest revision of each calendar DAY: a 1.5s-debounced
 *  autosave session would otherwise evict the pre-session revision — the one
 *  rollback exists for — within a half hour of editing. Daily spares grow by
 *  at most one row per edited day, bounded in practice. */
async function pruneRevisions(tenantId: string, workflowId: string): Promise<void> {
  const rows = await listRevisions(workflowId);
  const keep = revisionsKeep();
  if (rows.length <= keep) return;
  const published = (await getOwned(tenantId, workflowId))?.publishedRevision;
  const head = headHash.get(workflowId);
  const dailySpares = new Set<string>();
  const seenDays = new Set<string>();
  for (const r of rows) { // newest-first ⇒ first row seen per day is that day's newest
    const day = r.createdAt.slice(0, 10);
    if (!seenDays.has(day)) { seenDays.add(day); dailySpares.add(r.revisionHash); }
  }
  for (const r of rows.slice(keep)) {
    if (r.revisionHash === published || r.revisionHash === head || dailySpares.has(r.revisionHash)) continue;
    await store.delete(r.key);
  }
}

/** ADR 0464 — DSAR subject-eraser: REDACT `createdBy` on the tenant's revision
 *  rows (the attribution is the only subject field; the definition content is
 *  tenant work-product, so deletion would destroy the tenant's history —
 *  redaction is the honest erasure here, the kanban `createdBy` pattern). */
export async function eraseSubjectWorkflowRevisions(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  // Grade-data L11 — tenant-indexed read, not a cross-tenant full scan (the
  // store registers `tenantOf`; the index backfills on first use).
  for (const r of await store.listForTenantIndexed(tenantId)) {
    if (r.createdBy && forms.has(r.createdBy)) await store.put({ ...r, createdBy: ERASED });
  }
}

/** ADR 0464 — called from `registerHostSubjectErasers()` (one explicit boot list). */
export function registerWorkflowRevisionErasure(): void {
  registerSubjectEraser(eraseSubjectWorkflowRevisions);
}
