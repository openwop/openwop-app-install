/**
 * CRM Deals (ADR 0008 Phase 1) + stage history (ADR 0210 §1, moved here with
 * deals per CRMGAP-10 — history is deal-scoped and has no other consumer).
 * Org-scoped and RBAC-gated; every accessor verifies tenantId + orgId
 * (CTI-1 IDOR guard). Split out of the former `crmEntitiesService.ts`
 * god-file — re-exported unchanged via that file's barrel.
 *
 * CYCLE NOTE: this file and `./pipelines.js` import from each other
 * (`resolveStage` here needs `getPipeline`/`getOrCreateDefaultPipeline`;
 * `updatePipeline`/`deletePipeline` there need `listDeals` here for
 * referential-integrity checks). This is a REAL, deliberate bidirectional
 * domain coupling (a deal always sits on a pipeline's stage; a pipeline
 * cannot drop a stage/be deleted while deals reference it) — not an
 * accidental import tangle. It is SAFE in ESM: every cross-reference is an
 * `export async function` (hoisted) called only from inside another
 * function's BODY, never at module-top-level, so both modules fully
 * instantiate before either cross-file call ever executes.
 *
 * @see docs/adr/0008-crm-full-port.md, docs/adr/0210-crm-stage-history-snapshots-reports.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { filterVisibleCrmRecords } from '../../../host/crmRecordVisibility.js';
import { fireCrmRecordDeleted, onCrmRecordDeleted } from '../../../host/crmRecordLifecycle.js';
import { OpenwopError } from '../../../types.js';
import { MAX, MAX_PER_ORG_ENTITIES, assertUnderCap, cleanStr, isStrictDate, nowIso, optStr } from './shared.js';
import { getOrCreateDefaultPipeline, getPipeline } from './pipelines.js';
import {
  mintSystemType, type EntityRecord,
} from '../../entities/entitiesService.js';
import { makeKernelAdapter } from '../../entities/kernelAdapter.js';
import { changedFields, crmMutated, emitOptsOf, type CrmEmitOptions } from '../emit.js';

export type DealStatus = 'open' | 'won' | 'lost';
export const DEAL_STATUSES: readonly DealStatus[] = ['open', 'won', 'lost'];

export interface Deal {
  dealId: string;
  tenantId: string;
  orgId: string;
  title: string;
  pipelineId: string;
  stageId: string;
  amount?: number;
  currency?: string;
  companyId?: string;
  contactId?: string;
  /** Opaque owning-subject id (RFC 0048) — assignment reference, not PII. (ADR 0008 amendment.) */
  owner?: string;
  /** Expected close date, strict YYYY-MM-DD. (ADR 0008 amendment.) */
  closeDate?: string;
  /** Explicit outcome. Derived at WRITE time from the stage name when a stage
   *  move doesn't set it (English "won"/"lost" heuristic — an explicit value
   *  always wins); projected `?? 'open'` at read for pre-amendment rows. */
  status?: DealStatus;
  customFields: Record<string, string | number | boolean>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ── crm.deal kernel adapter (ADR 0409 Phase 3) ──────────────────────────────
// Deals live in the content kernel (the cms.page/company façade pattern).
// Simpler than company: deals have no merge/CAS. Full Deal → ext.deal (SoT);
// queryable scalars → values; org-scoped via the opaque top-level orgId.
const CRM_DEAL_TYPE = 'crm.deal';
const DEAL_SCALARS = [
  { key: 'org_id', label: 'Org', type: 'string', required: true },
  { key: 'title', label: 'Title', type: 'string', required: true },
  { key: 'pipeline_id', label: 'Pipeline', type: 'string', required: true },
  { key: 'stage_id', label: 'Stage', type: 'string', required: true },
  { key: 'amount', label: 'Amount', type: 'number', required: false },
  { key: 'currency', label: 'Currency', type: 'string', required: false },
  { key: 'company_id', label: 'Company', type: 'string', required: false },
  { key: 'contact_id', label: 'Contact', type: 'string', required: false },
  { key: 'deal_status', label: 'Status', type: 'string', required: false },
  { key: 'close_date', label: 'Close date', type: 'string', required: false },
];
async function ensureDealType(tenantId: string): Promise<void> {
  await mintSystemType({ tenantId, name: CRM_DEAL_TYPE, displayName: 'Deal', fields: DEAL_SCALARS, neverPublic: true, actor: 'system:crm' });
}
function dealToKernel(d: Deal): { values: Record<string, unknown>; ext: Record<string, unknown> } {
  return {
    values: {
      org_id: d.orgId, title: d.title, pipeline_id: d.pipelineId, stage_id: d.stageId,
      ...(d.amount !== undefined ? { amount: d.amount } : {}),
      ...(d.currency !== undefined ? { currency: d.currency } : {}),
      ...(d.companyId !== undefined ? { company_id: d.companyId } : {}),
      ...(d.contactId !== undefined ? { contact_id: d.contactId } : {}),
      ...(d.status !== undefined ? { deal_status: d.status } : {}),
      ...(d.closeDate !== undefined ? { close_date: d.closeDate } : {}),
    },
    ext: { deal: d },
  };
}
const kernelToDeal = (rec: EntityRecord): Deal => (rec.ext?.deal as Deal);
const legacyDeals = new DurableCollection<Deal>('crm:deal', (d) => d.dealId, undefined, (d) => d.tenantId);

/** The kernel-backed deal store (KERNEL-5 shared factory). `cas` (byte-identical
 *  over ext.deal) is present for parity with company/product — a capability the
 *  hand-rolled adapter previously lacked; current callers still use `put`. */
const deals = makeKernelAdapter<Deal>({
  typeName: CRM_DEAL_TYPE,
  ensureType: ensureDealType,
  toKernel: dealToKernel,
  fromKernel: kernelToDeal,
  idOf: (d) => d.dealId,
  tenantOf: (d) => d.tenantId,
  orgOf: (d) => d.orgId,
  actorOf: (d) => d.createdBy,
  updatedAtOf: (d) => d.updatedAt,
  legacy: legacyDeals,
});

/** ADR 0409 Phase 3 — id-preserving legacy→kernel migration (idempotent). */
export async function migrateDealsToKernel(): Promise<{ migrated: number; skipped: number }> {
  return deals.migrate();
}

// RI-10 (CRM-5 blind spot) — a hard-deleted contact/company left deals with a dangling
// contactId/companyId (merge relinks, but hard-delete had no equivalent + deals were the
// one core CRM entity missing from the CRM-5 lifecycle sweep). UNLINK (soft) — a deal is
// revenue data that survives its contact/company deletion. Contacts are TENANT-scoped
// (unlink across every org); companies are ORG-scoped (unlink only within the event's org).
// Idempotent + best-effort (the seam swallows handler errors), mirroring the forms subscriber.
onCrmRecordDeleted('deals-crm-unlink', async ({ tenantId, orgId, entity, recordId }) => {
  if (entity === 'contact') {
    for (const d of await deals.listForTenant(tenantId)) {
      if (d.contactId === recordId) { const next = { ...d }; delete next.contactId; await deals.put({ ...next, updatedAt: nowIso() }); }
    }
  } else if (entity === 'company') {
    for (const d of await deals.listForTenant(tenantId)) {
      if (d.orgId === orgId && d.companyId === recordId) { const next = { ...d }; delete next.companyId; await deals.put({ ...next, updatedAt: nowIso() }); }
    }
  }
  // entity === 'deal' → nothing to unlink HERE: a `Deal` carries no pointer to
  // another deal (no `dealId`/`parentDealId` field — checked, ADR 0627 D7), so
  // this branch is honestly empty. The rows that DO point at a deal (tasks,
  // activities) unlink in their own consumers (`tasks-crm-unlink`,
  // `activities-crm-unlink`).
});

// ── Stage history (ADR 0210 §1) — append-only; history can't be backfilled ──

export interface StageHistoryRow {
  historyId: string;
  tenantId: string;
  orgId: string;
  dealId: string;
  pipelineId: string;
  fromStageId: string | null;
  toStageId: string;
  actor: string;
  at: string;
  amountAtMove?: number;
  /** The stage's INDEX in its pipeline's ordered `stages` at the moment of the
   *  move (grade-trio residual closure) — a write-time SNAPSHOT, so reports
   *  keyed on funnel position stay reproducible after a later stage reorder
   *  or insertion. Optional + write-forward: rows written before this field
   *  existed fall back to the CURRENT index at read time (the old behavior). */
  toStagePosition?: number;
}

const stageHistory = new DurableCollection<StageHistoryRow>('crm:stagehistory', (r) => r.historyId, undefined, (r) => r.tenantId);

async function appendStageHistory(input: {
  tenantId: string;
  orgId: string;
  dealId: string;
  pipelineId: string;
  fromStageId: string | null;
  toStageId: string;
  actor: string;
  amountAtMove?: number;
  toStagePosition?: number;
}): Promise<void> {
  const row: StageHistoryRow = {
    historyId: `dsh:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    dealId: input.dealId,
    pipelineId: input.pipelineId,
    fromStageId: input.fromStageId,
    toStageId: input.toStageId,
    actor: input.actor,
    at: nowIso(),
    ...(typeof input.amountAtMove === 'number' ? { amountAtMove: input.amountAtMove } : {}),
    ...(typeof input.toStagePosition === 'number' ? { toStagePosition: input.toStagePosition } : {}),
  };
  await stageHistory.put(row);
}

/** A deal's stage-move history, newest first (ADR 0210 §1). */
export async function getStageHistory(tenantId: string, orgId: string, dealId: string): Promise<StageHistoryRow[]> {
  return (await stageHistory.listForTenantIndexed(tenantId))
    .filter((r) => r.orgId === orgId && r.dealId === dealId)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** All stage-history rows for a tenant+org's pipeline — the report's raw input
 *  for both the "conversions" (from→to counts) computation and, when needed,
 *  per-deal aging joins. */
export async function listStageHistoryForPipeline(tenantId: string, orgId: string, pipelineId: string): Promise<StageHistoryRow[]> {
  return (await stageHistory.listForTenantIndexed(tenantId)).filter((r) => r.orgId === orgId && r.pipelineId === pipelineId);
}

/** Write-time status derivation from a stage's display name. User-authored
 *  stage names are free text, so this is a best-effort English heuristic; the
 *  explicit `status` field is the authoritative override. */
function deriveStatusFromStageName(stageName: string): DealStatus {
  if (/\bwon\b/i.test(stageName)) return 'won';
  if (/\blost\b/i.test(stageName)) return 'lost';
  return 'open';
}

function parseDealStatus(value: unknown): DealStatus {
  if (typeof value === 'string' && (DEAL_STATUSES as readonly string[]).includes(value)) return value as DealStatus;
  throw new OpenwopError('validation_error', `status must be one of: ${DEAL_STATUSES.join(', ')}.`, 400, { status: value });
}

function parseCloseDate(value: unknown): string {
  if (typeof value === 'string' && isStrictDate(value)) return value;
  throw new OpenwopError('validation_error', 'closeDate must be a YYYY-MM-DD date.', 400, { closeDate: value });
}

/** Read projection — pre-amendment rows have no `status`. */
const projectDeal = (d: Deal): Deal => (d.status ? d : { ...d, status: 'open' });

/** Resolve the (pipeline, stage) a deal should sit on — defaulting to the org's
 *  default pipeline's first stage, validating any explicit ids belong to the org. */
async function resolveStage(tenantId: string, orgId: string, pipelineId?: string, stageId?: string): Promise<{ pipelineId: string; stageId: string; stageName: string; stageIndex: number }> {
  const pipeline = pipelineId ? await getPipeline(tenantId, orgId, pipelineId) : await getOrCreateDefaultPipeline(tenantId, orgId);
  if (!pipeline) throw new OpenwopError('not_found', 'Pipeline not found in this org.', 404, { pipelineId });
  if (pipeline.stages.length === 0) throw new OpenwopError('validation_error', 'Pipeline has no stages.', 409, { pipelineId: pipeline.pipelineId });
  const stageIndex = stageId ? pipeline.stages.findIndex((s) => s.stageId === stageId) : 0;
  const resolvedStage = stageIndex >= 0 ? pipeline.stages[stageIndex] : undefined;
  if (!resolvedStage) throw new OpenwopError('not_found', 'Stage not found in this pipeline.', 404, { stageId });
  return { pipelineId: pipeline.pipelineId, stageId: resolvedStage.stageId, stageName: resolvedStage.name, stageIndex };
}

export async function listDeals(tenantId: string, orgId: string, filter: { pipelineId?: string; stageId?: string; companyId?: string; q?: string } = {}, viewerSubject?: string): Promise<Deal[]> {
  const needle = filter.q?.trim().toLowerCase();
  const rows = (await deals.listForTenant(tenantId))
    .filter(
      (d) =>
        d.orgId === orgId &&
        (filter.pipelineId === undefined || d.pipelineId === filter.pipelineId) &&
        (filter.stageId === undefined || d.stageId === filter.stageId) &&
        (filter.companyId === undefined || d.companyId === filter.companyId) &&
        (!needle || d.title.toLowerCase().includes(needle)),
    )
    .map(projectDeal);
  // Row-level territory visibility (ADR 0272 P4) — a no-op unless a viewer subject
  // is supplied AND a resolver is registered (the `territories` feature); a system
  // read (no viewer) or territories-off returns `rows` unchanged.
  return filterVisibleCrmRecords({ tenantId, orgId, target: 'deal', callerSubject: viewerSubject, rows, idOf: (d) => d.dealId });
}

export async function getDeal(tenantId: string, orgId: string, dealId: string): Promise<Deal | null> {
  const d = await deals.get(tenantId, dealId);
  return d && d.tenantId === tenantId && d.orgId === orgId ? projectDeal(d) : null;
}

export async function createDeal(input: {
  tenantId: string;
  orgId: string;
  title: string;
  pipelineId?: string;
  stageId?: string;
  amount?: number;
  currency?: unknown;
  companyId?: string;
  contactId?: string;
  owner?: string;
  closeDate?: unknown;
  status?: unknown;
  customFields?: Record<string, string | number | boolean>;
  createdBy: string;
  /** Best-effort actor for the initial stage-history row — falls back to
   *  `createdBy` when omitted (HTTP routes always have a principal; a governed
   *  write verb may pass `run:<runId>`). */
  actor?: string;
  validateCompany: (companyId: string) => Promise<boolean>;
  validateContact: (contactId: string) => Promise<boolean>;
  /** Caller-supplied deterministic id (ADR 0162 pattern). MUST be `deal:`-prefixed.
   *  Same same-tenant-org short-circuit / cross-tenant 404 contract as `createCompany`. */
  dealId?: string;
} & CrmEmitOptions): Promise<Deal> {
  if (input.dealId !== undefined) {
    if (!input.dealId.startsWith('deal:')) {
      throw new OpenwopError('validation_error', 'dealId must be `deal:`-prefixed.', 400, { dealId: input.dealId });
    }
    const existing = await deals.get(input.tenantId, input.dealId);
    if (existing) {
      if (existing.tenantId === input.tenantId && existing.orgId === input.orgId) return projectDeal(existing);
      throw new OpenwopError('not_found', 'Deal not found.', 404, { dealId: input.dealId });
    }
  }
  assertUnderCap((await listDeals(input.tenantId, input.orgId)).length, MAX_PER_ORG_ENTITIES, 'deals');
  const { pipelineId, stageId, stageName, stageIndex } = await resolveStage(input.tenantId, input.orgId, input.pipelineId, input.stageId);
  const status: DealStatus = input.status !== undefined ? parseDealStatus(input.status) : deriveStatusFromStageName(stageName);
  const closeDate = input.closeDate !== undefined ? parseCloseDate(input.closeDate) : undefined;
  if (input.companyId && !(await input.validateCompany(input.companyId))) {
    throw new OpenwopError('not_found', 'Linked company not found in this org.', 404, { companyId: input.companyId });
  }
  if (input.contactId && !(await input.validateContact(input.contactId))) {
    throw new OpenwopError('not_found', 'Linked contact not found in this tenant.', 404, { contactId: input.contactId });
  }
  const ts = nowIso();
  const d: Deal = {
    dealId: input.dealId ?? `deal:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    title: cleanStr(input.title, MAX.name, 'Untitled deal'),
    pipelineId,
    stageId,
    ...(typeof input.amount === 'number' && Number.isFinite(input.amount) ? { amount: input.amount } : {}),
    ...(optStr(input.currency, 8) ? { currency: optStr(input.currency, 8) } : {}),
    ...(input.companyId ? { companyId: input.companyId } : {}),
    ...(input.contactId ? { contactId: input.contactId } : {}),
    ...(optStr(input.owner, MAX.name) ? { owner: optStr(input.owner, MAX.name) } : {}),
    ...(closeDate ? { closeDate } : {}),
    status,
    customFields: input.customFields ?? {},
    createdBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await deals.put(d);
  // ADR 0210 §1 — history can't be backfilled, so ship the initial row at creation.
  await appendStageHistory({
    tenantId: d.tenantId,
    orgId: d.orgId,
    dealId: d.dealId,
    pipelineId: d.pipelineId,
    fromStageId: null,
    toStageId: d.stageId,
    actor: input.actor ?? input.createdBy,
    ...(typeof d.amount === 'number' ? { amountAtMove: d.amount } : {}),
    toStagePosition: stageIndex,
  });
  // ADR 0627 D2 — the ONE `deal.created` site, NEW row only. A deal born on a
  // won/lost stage emits `created` only: `won`/`lost` are TRANSITIONS of an
  // existing deal (`updateDeal`), never a birth state.
  crmMutated({ entity: 'deal', verb: 'created', tenantId: d.tenantId, orgId: d.orgId, entityId: d.dealId, ...emitOptsOf(input) });
  return d;
}

/** ADR 0627 D6 — attempts per `updateDeal`: the first read + retries on a lost
 *  CAS race, each against a FRESH re-read (the `mergeContacts` shape, one more
 *  retry because a stage move is the hot path two agents race on). */
const MAX_DEAL_UPDATE_ATTEMPTS = 4;

/**
 * Update a deal. ADR 0627 D6 — CAS-guarded: the row is re-read raw
 * (unprojected — the kernel CAS is a byte-identical match on the stored
 * `ext.deal`, so a `projectDeal` `status:'open'` backfill would make every legacy
 * row spuriously lose), the patch is recomputed against THAT read, and the swap
 * lands only if the stored row is still identical. Two concurrent stage moves
 * (`moveDealStage` is this function with `{ stageId }`) used to race a plain
 * get→put: the second writer's `put` clobbered the first's stage while BOTH
 * appended a stage-history row — history could claim a transition the row never
 * showed. Now the history append and the transition emits sit INSIDE the won
 * attempt only (a lost attempt writes nothing and re-reads), so every history
 * row describes a swap that actually landed, from the stage the deal was really on.
 * A loss on the final attempt surfaces as a `409 conflict`, never a silent drop.
 */
export async function updateDeal(
  tenantId: string,
  orgId: string,
  dealId: string,
  patch: { title?: string; stageId?: string; pipelineId?: string; amount?: number | null; currency?: string | null; companyId?: string | null; contactId?: string | null; owner?: string | null; closeDate?: unknown | null; status?: unknown; customFields?: Record<string, string | number | boolean> },
  validators: { validateCompany: (id: string) => Promise<boolean>; validateContact: (id: string) => Promise<boolean> },
  actor: string,
  opts: Omit<CrmEmitOptions, 'actor'> = {},
): Promise<Deal | null> {
  for (let attempt = 0; attempt < MAX_DEAL_UPDATE_ATTEMPTS; attempt++) {
    const raw = await deals.get(tenantId, dealId);
    if (!raw || raw.tenantId !== tenantId || raw.orgId !== orgId) return null;
    const d = projectDeal(raw);
    const next: Deal = { ...d, updatedAt: nowIso() };
    let stageMoved = false;
    // Hoisted so the stage-history write below (a different branch) can snapshot
    // the moved-to position; -1 = no stage patch in this update (never written —
    // history only appends when stageMoved).
    let movedToPosition = -1;
    if (patch.title !== undefined) next.title = cleanStr(patch.title, MAX.name, d.title);
    if (patch.pipelineId !== undefined || patch.stageId !== undefined) {
      const { pipelineId, stageId, stageName, stageIndex } = await resolveStage(tenantId, orgId, patch.pipelineId ?? d.pipelineId, patch.stageId);
      movedToPosition = stageIndex;
      if (stageId !== d.stageId || pipelineId !== d.pipelineId) stageMoved = true;
      next.pipelineId = pipelineId;
      next.stageId = stageId;
      // A stage move re-derives the outcome unless the same patch sets it
      // explicitly (explicit always wins — see Deal.status contract note).
      if (patch.status === undefined) next.status = deriveStatusFromStageName(stageName);
    }
    if (patch.status !== undefined) next.status = parseDealStatus(patch.status);
    if (patch.owner !== undefined) {
      if (patch.owner === null || patch.owner === '') delete next.owner;
      else next.owner = cleanStr(patch.owner, MAX.name, '');
    }
    if (patch.closeDate !== undefined) {
      if (patch.closeDate === null) delete next.closeDate;
      else next.closeDate = parseCloseDate(patch.closeDate);
    }
    if (patch.amount !== undefined) {
      if (patch.amount === null) delete next.amount;
      else if (Number.isFinite(patch.amount)) next.amount = patch.amount;
    }
    if (patch.currency !== undefined) {
      if (patch.currency === null) delete next.currency;
      else next.currency = optStr(patch.currency, 8);
    }
    if (patch.companyId !== undefined) {
      if (patch.companyId === null) delete next.companyId;
      else {
        if (!(await validators.validateCompany(patch.companyId))) throw new OpenwopError('not_found', 'Linked company not found in this org.', 404, { companyId: patch.companyId });
        next.companyId = patch.companyId;
      }
    }
    if (patch.contactId !== undefined) {
      if (patch.contactId === null) delete next.contactId;
      else {
        if (!(await validators.validateContact(patch.contactId))) throw new OpenwopError('not_found', 'Linked contact not found in this tenant.', 404, { contactId: patch.contactId });
        next.contactId = patch.contactId;
      }
    }
    if (patch.customFields !== undefined) next.customFields = patch.customFields;
    const swapped = await deals.cas(raw, next);
    if (!swapped) continue; // lost the race — re-read and recompute
    return await commitDealUpdate(d, next, { stageMoved, movedToPosition, actor, opts });
  }
  throw new OpenwopError('conflict', 'Deal was updated concurrently — retry.', 409, { dealId });
}

/** The post-swap half of `updateDeal`: the stage-history append + the
 *  transition-guarded emits, run ONLY for the attempt whose CAS landed. */
async function commitDealUpdate(
  d: Deal,
  next: Deal,
  ctx: { stageMoved: boolean; movedToPosition: number; actor: string; opts: Omit<CrmEmitOptions, 'actor'> },
): Promise<Deal> {
  const { stageMoved, movedToPosition, actor, opts } = ctx;
  const { tenantId, orgId, dealId } = next;
  if (stageMoved) {
    await appendStageHistory({
      tenantId: next.tenantId,
      orgId: next.orgId,
      dealId: next.dealId,
      pipelineId: next.pipelineId,
      fromStageId: d.stageId,
      toStageId: next.stageId,
      actor,
      ...(typeof next.amount === 'number' ? { amountAtMove: next.amount } : {}),
      ...(movedToPosition >= 0 ? { toStagePosition: movedToPosition } : {}),
    });
  }
  // ADR 0627 D2 — transition guards decided on the LANDED row: `stage-changed`
  // iff the stage actually moved (a re-PATCH to the same stage is not a move);
  // `won`/`lost` iff `status` FLIPPED (`d` is the projected pre-image, so a
  // pre-amendment row reads `open`). A re-PATCH of `status:'won'` on a won deal
  // emits `updated` only — never a second `won`.
  const emit = { tenantId, orgId, entityId: dealId, actor, ...opts } as const;
  // `changed` is the pre-image→landed DIFF (review S1), so a value-equal
  // re-PATCH emits no `updated` either — the landed row IS `next` (the CAS won).
  const changed = changedFields(d, next);
  if (changed.length > 0) crmMutated({ entity: 'deal', verb: 'updated', changed, ...emit });
  if (stageMoved) crmMutated({ entity: 'deal', verb: 'stage-changed', ...emit });
  if (next.status !== d.status && (next.status === 'won' || next.status === 'lost')) crmMutated({ entity: 'deal', verb: next.status, ...emit });
  return next;
}

export async function deleteDeal(tenantId: string, orgId: string, dealId: string, opts: CrmEmitOptions = {}): Promise<boolean> {
  const d = await getDeal(tenantId, orgId, dealId);
  if (!d) return false;
  await deals.delete(tenantId, dealId);
  // ADR 0283 — fire AFTER the row is gone (fail-closed ordering) so consumer
  // features (territory assignments, …) can drop their soft references.
  await fireCrmRecordDeleted({ tenantId, orgId, entity: 'deal', recordId: dealId });
  crmMutated({ entity: 'deal', verb: 'deleted', tenantId, orgId, entityId: dealId, ...opts });
  return true;
}

/** Existence check for a `reference` field's `deal` target when the caller
 *  has no org context (contact defs are tenant-scoped — ADR 0213 §2):
 *  tenant-wide instead of org-scoped. */
export async function dealExistsInTenant(tenantId: string, dealId: string): Promise<boolean> {
  const d = await deals.get(tenantId, dealId);
  return d !== null && d.tenantId === tenantId;
}

/** Referential-integrity check for `pipelines.ts`'s `updatePipeline` (dropped
 *  stages) — every deal in this org+pipeline sitting on one of `stageIds`. */
export async function listDealsOnStages(tenantId: string, orgId: string, pipelineId: string, stageIds: readonly string[]): Promise<Deal[]> {
  return (await listDeals(tenantId, orgId, { pipelineId })).filter((d) => stageIds.includes(d.stageId));
}

/** Referential-integrity check for `pipelines.ts`'s `deletePipeline`. */
export async function anyDealsOnPipeline(tenantId: string, orgId: string, pipelineId: string): Promise<boolean> {
  return (await listDeals(tenantId, orgId, { pipelineId })).length > 0;
}

// ── Merge relink (ADR 0209 §2) — the deals slice; composed with tasks'/
// activities' counterparts by `activities.ts`'s `relinkContactReferences`/
// `relinkCompanyReferences` (CRMGAP-10 split). ──────────────────────────────

/** Relink every tenant-scoped deal pointing at `sourceContactId` to
 *  `survivorContactId`. Contacts are tenant-wide (not org-scoped), so this
 *  scans across every org in the tenant — the same shape `listContacts` uses. */
export async function relinkDealsForContact(tenantId: string, sourceContactId: string, survivorContactId: string): Promise<void> {
  for (const d of await deals.listForTenant(tenantId)) {
    if (d.tenantId === tenantId && d.contactId === sourceContactId) {
      await deals.put({ ...d, contactId: survivorContactId, updatedAt: nowIso() });
    }
  }
}

/** ADR 0264 — deal ids currently pointing at `contactId` (captured pre-merge for a
 *  reversible unmerge). */
export async function dealIdsForContact(tenantId: string, contactId: string): Promise<string[]> {
  return (await deals.listForTenant(tenantId)).filter((d) => d.tenantId === tenantId && d.contactId === contactId).map((d) => d.dealId);
}

/** ADR 0264 — repoint EXACTLY the listed deals back to `contactId` (unmerge restore). */
export async function repointDealsToContact(tenantId: string, dealIds: readonly string[], contactId: string): Promise<void> {
  if (dealIds.length === 0) return;
  const set = new Set(dealIds);
  for (const d of await deals.listForTenant(tenantId)) {
    if (d.tenantId === tenantId && set.has(d.dealId)) await deals.put({ ...d, contactId, updatedAt: nowIso() });
  }
}

/** GEN-7 — deal ids currently pointing at `companyId` (captured PRE-merge so a company
 *  unmerge repoints EXACTLY these back; a deal created post-merge stays with the survivor). */
export async function dealIdsForCompany(tenantId: string, orgId: string, companyId: string): Promise<string[]> {
  return (await deals.listForTenant(tenantId)).filter((d) => d.tenantId === tenantId && d.orgId === orgId && d.companyId === companyId).map((d) => d.dealId);
}

/** GEN-7 — repoint EXACTLY the listed deals back to `companyId` (company unmerge restore). */
export async function repointDealsToCompany(tenantId: string, orgId: string, dealIds: readonly string[], companyId: string): Promise<void> {
  if (dealIds.length === 0) return;
  const set = new Set(dealIds);
  for (const d of await deals.listForTenant(tenantId)) {
    if (d.tenantId === tenantId && d.orgId === orgId && set.has(d.dealId)) await deals.put({ ...d, companyId, updatedAt: nowIso() });
  }
}

/** Relink every org-scoped deal pointing at `sourceCompanyId` to
 *  `survivorCompanyId` (both companies must already be validated as
 *  belonging to `orgId` by the caller). */
export async function relinkDealsForCompany(tenantId: string, orgId: string, sourceCompanyId: string, survivorCompanyId: string): Promise<void> {
  for (const d of await deals.listForTenant(tenantId)) {
    if (d.tenantId === tenantId && d.orgId === orgId && d.companyId === sourceCompanyId) {
      await deals.put({ ...d, companyId: survivorCompanyId, updatedAt: nowIso() });
    }
  }
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __clearDeals(): Promise<void> {
  await deals.__clear();
  await stageHistory.__clear();
}
