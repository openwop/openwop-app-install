/**
 * CRM record-lifecycle seam (ADR 0283) — the dependency-safe hook by which OTHER
 * features clean up their SOFT references to a CRM record when it is deleted,
 * WITHOUT crm importing them (and without them importing each other). The
 * in-process sibling of `crmRecordVisibility.ts` (the read-side CRM seam) and the
 * cross-feature generalization of `commerce/productLifecycleSeam.ts` (#1337):
 * `crmMutated` host events are webhook/host-event egress only — nothing in-process
 * can subscribe to them, which is exactly how territory assignments orphaned on
 * deal/company deletion (TERR-DATA-1, docs/steward/DATA-ASSESSMENT.md RI-2 / DG-INT-2).
 *
 * Contract (same as the product seam): registrations are KEYED so a repeated boot
 * (feature `registerRoutes` runs per test `createApp`) overwrites the same slot
 * instead of stacking duplicates — idempotent by construction. Handlers MUST be
 * idempotent, MUST bound their work (indexed/point reads — never a cross-tenant
 * scan), and run best-effort: `fireCrmRecordDeleted` swallows a handler's error so
 * one registrant's cleanup can neither block the delete nor another registrant's
 * cleanup. Fired AFTER the owning row is deleted, so a mid-way handler failure
 * fails CLOSED (the parent is already unreachable; leftover soft refs remain
 * re-prunable orphans, never resurrected records). Deletes happen on REST paths
 * outside runs — nothing here touches `run.metadata` or replay. Default = no
 * handlers ⇒ the CRM delete paths are byte-identical when nothing is wired.
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.crmRecordLifecycle');

export type CrmRecordEntity = 'contact' | 'company' | 'deal';

export interface CrmRecordDeletedEvent {
  tenantId: string;
  /** Present for org-scoped entities (company/deal); absent for tenant-scoped contacts. */
  orgId?: string;
  entity: CrmRecordEntity;
  recordId: string;
}

type CrmRecordDeletedHandler = (e: CrmRecordDeletedEvent) => Promise<void>;

const handlers = new Map<string, CrmRecordDeletedHandler>();

/** A consumer feature registers (idempotently, keyed) its per-record cleanup at boot. */
export function onCrmRecordDeleted(key: string, fn: CrmRecordDeletedHandler): void {
  handlers.set(key, fn);
}

/** Called by the CRM delete paths AFTER the row is gone; runs every registrant
 *  best-effort. Never throws. Returns how many handlers ran (observability). */
export async function fireCrmRecordDeleted(e: CrmRecordDeletedEvent): Promise<number> {
  let ran = 0;
  for (const [key, h] of handlers.entries()) {
    try {
      await h(e);
      ran += 1;
    } catch (err) {
      // Best-effort is defensible; INVISIBLE best-effort is not (grade-trio
      // finding 6): a swallowed cleanup failure used to leave orphaned
      // feature rows with zero trace anywhere. The delete still proceeds.
      log.error('crm_record_deleted_handler_failed', {
        handler: key, entity: e.entity, recordId: e.recordId, tenantId: e.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return ran;
}

/**
 * CRM-5 — the MERGE sibling of the delete seam.
 *
 * A merge is not a delete: the source record survives as a TOMBSTONE
 * (`mergedInto`/`mergedAt`) and every reference to it must move to the survivor
 * rather than be dropped. `crmMergeService` relinked exactly three collections it
 * owns — deals, tasks, activities — while its own file docblock claimed it
 * "RELINKS every referencing row … never a dangling reference to a tombstone".
 * ~20 cross-feature stores were left pointing at the tombstone, two of them
 * compliance-grade:
 *
 *  - `consent:record` is keyed on the contactId, so a source contact that had
 *    opted OUT of marketing lost that record on merge — while the survivor became
 *    reachable at the source's ABSORBED email identifier. An opt-out silently
 *    became a send.
 *  - `email:sendlog` keys the per-recipient dedupe on `contactId`, so the survivor
 *    could be re-sent a campaign the source had already received, and the
 *    frequency cap reset.
 *
 * Deliberately a SEPARATE event rather than a discriminator on the delete one.
 * The delete handlers' contract is "drop your soft reference"; applying that to a
 * merge would DESTROY exactly the data that has to move (a delete handler that
 * dropped the source's consent row is the defect, not the fix). A distinct type
 * means a consumer must opt in with merge-aware code, and the ones that have not
 * are honestly uncovered rather than silently mishandled.
 *
 * Same contract as the delete seam otherwise: registrations are KEYED (idempotent
 * across repeated boots), handlers MUST be idempotent and bounded (indexed/point
 * reads — never a cross-tenant scan), and the fan-out is best-effort so one
 * registrant's failure blocks neither the merge nor another registrant.
 *
 * ORDERING (and it is the opposite of the delete seam's, for a reason): fired
 * AFTER the merge has committed — the survivor is written, references are
 * relinked, the source is tombstoned. Firing before would let a handler move
 * references onto a survivor the CAS then failed to write.
 */
export interface CrmRecordMergedEvent {
  tenantId: string;
  /** Present for org-scoped entities (company/deal); absent for tenant-scoped contacts. */
  orgId?: string;
  entity: CrmRecordEntity;
  /** The now-tombstoned record whose references must move. */
  sourceId: string;
  /** The record they must move TO. */
  survivorId: string;
}

type CrmRecordMergedHandler = (e: CrmRecordMergedEvent) => Promise<void>;

const mergeHandlers = new Map<string, CrmRecordMergedHandler>();

/** A consumer feature registers (idempotently, keyed) its per-merge relink at boot. */
export function onCrmRecordMerged(key: string, fn: CrmRecordMergedHandler): void {
  mergeHandlers.set(key, fn);
}

/** Called by the CRM merge paths AFTER the merge has committed; runs every
 *  registrant best-effort. Never throws. Returns how many handlers ran. */
export async function fireCrmRecordMerged(e: CrmRecordMergedEvent): Promise<number> {
  if (e.sourceId === e.survivorId) return 0; // a self-merge is not a merge
  let ran = 0;
  for (const [key, h] of mergeHandlers.entries()) {
    try {
      await h(e);
      ran += 1;
    } catch (err) {
      // Best-effort is defensible; INVISIBLE best-effort is not. A swallowed
      // relink failure here means a consent row or a send-log ledger still
      // points at a tombstone, which is exactly the class this seam exists for.
      log.error('crm_record_merged_handler_failed', {
        handler: key, entity: e.entity, sourceId: e.sourceId, survivorId: e.survivorId, tenantId: e.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return ran;
}

/**
 * The REVERSE of the merge event, fired by `unmergeContacts`/`unmergeCompanies`.
 *
 * A contact merge is reversible, so a merge handler that MOVES rows (rather than
 * copying) would otherwise turn a reversible operation into a lossy one — fixing
 * one silent-loss defect by introducing another. A consumer that relinks on merge
 * registers here to relink back; a consumer whose merge handling is already
 * symmetric (an idempotent fold that destroys nothing) needs no registration.
 *
 * `sourceId`/`survivorId` name the SAME two records the merge event named, in the
 * same roles — so a handler reads "move what I moved to `survivorId` back to
 * `sourceId`", never a mirrored event it has to re-interpret.
 */
type CrmRecordUnmergedHandler = (e: CrmRecordMergedEvent) => Promise<void>;

const unmergeHandlers = new Map<string, CrmRecordUnmergedHandler>();

/** A consumer feature registers (idempotently, keyed) its per-unmerge relink. */
export function onCrmRecordUnmerged(key: string, fn: CrmRecordUnmergedHandler): void {
  unmergeHandlers.set(key, fn);
}

/** Called by the CRM unmerge paths AFTER the source is live again. Best-effort. */
export async function fireCrmRecordUnmerged(e: CrmRecordMergedEvent): Promise<number> {
  if (e.sourceId === e.survivorId) return 0;
  let ran = 0;
  for (const [key, h] of unmergeHandlers.entries()) {
    try {
      await h(e);
      ran += 1;
    } catch (err) {
      log.error('crm_record_unmerged_handler_failed', {
        handler: key, entity: e.entity, sourceId: e.sourceId, survivorId: e.survivorId, tenantId: e.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return ran;
}

/** Test-only: drop all registrations so suites don't leak handlers across files. */
export function __resetCrmRecordLifecycleHooks(): void {
  handlers.clear();
  mergeHandlers.clear();
  unmergeHandlers.clear();
}
