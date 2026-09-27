/**
 * CRM Pipelines (ADR 0008 Phase 1) — org-scoped and RBAC-gated. Split out of
 * the former `crmEntitiesService.ts` god-file (CRMGAP-10) — re-exported
 * unchanged via that file's barrel.
 *
 * CYCLE NOTE: see `./deals.js`'s file-header doc — `updatePipeline`/
 * `deletePipeline` here import `listDealsOnStages`/`anyDealsOnPipeline` from
 * `deals.ts` for referential-integrity checks, while `deals.ts`'s
 * `resolveStage` imports `getPipeline`/`getOrCreateDefaultPipeline` from
 * here. Deliberate, safe (function declarations, called only inside other
 * functions' bodies — never at module-top-level).
 *
 * @see docs/adr/0008-crm-full-port.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { MAX, cleanStr, nowIso } from './shared.js';
import { anyDealsOnPipeline, listDealsOnStages } from './deals.js';
import { changedFields, crmMutated, type CrmEmitOptions } from '../emit.js';

export interface PipelineStage {
  stageId: string;
  name: string;
  probability: number; // 0..100
}
/** ADR 0540 D3 — what the money on this pipeline MEANS.
 *
 *  `revenue` (the default, and every pipeline that existed before this field)
 *  keeps today's behaviour: currency rollups and `Σ(amount × probability)`.
 *
 *  `non-revenue` pipelines track things whose amounts must not be summed. For a
 *  job search, "expected revenue" is the sum of every salary you applied for —
 *  a number that is not merely useless but actively misleading. Reports render
 *  count-based (conversion, aging, time-to-stage) and suppress currency rollups.
 *  Generalises to any non-revenue pipeline: hiring, grants, applications. */
export type PipelineKind = 'revenue' | 'non-revenue';

export interface Pipeline {
  pipelineId: string;
  tenantId: string;
  orgId: string;
  name: string;
  stages: PipelineStage[];
  /** Absent ⇒ `revenue`. Optional so every existing row keeps its meaning with
   *  no migration — the discriminator is additive by construction. */
  kind?: PipelineKind;
  createdAt: string;
  updatedAt: string;
}

// CRMGAP-5/14: tenantOf arms the tenant secondary index so every list below is a
// bounded per-tenant scan (`listForTenantIndexed`) instead of `list()`'s full-
// collection scan + in-memory tenant filter (mirrors `contactsService`'s GOV-1 note).
const pipelines = new DurableCollection<Pipeline>('crm:pipeline', (p) => p.pipelineId, undefined, (p) => p.tenantId);

const DEFAULT_STAGES: Array<{ name: string; probability: number }> = [
  { name: 'New', probability: 10 },
  { name: 'Qualified', probability: 30 },
  { name: 'Proposal', probability: 60 },
  { name: 'Won', probability: 100 },
  { name: 'Lost', probability: 0 },
];

function stage(name: string, probability: number): PipelineStage {
  return { stageId: `stg:${randomUUID()}`, name: cleanStr(name, MAX.short, 'Stage'), probability: Math.max(0, Math.min(100, Math.round(probability))) };
}

export async function listPipelines(tenantId: string, orgId: string): Promise<Pipeline[]> {
  return (await pipelines.listForTenantIndexed(tenantId)).filter((p) => p.orgId === orgId);
}

export async function getPipeline(tenantId: string, orgId: string, pipelineId: string): Promise<Pipeline | null> {
  const p = await pipelines.get(pipelineId);
  return p && p.tenantId === tenantId && p.orgId === orgId ? p : null;
}

/** The org's pipeline, lazily seeding a default the first time (so a deal always
 *  has a pipeline to sit on). */
export async function getOrCreateDefaultPipeline(tenantId: string, orgId: string): Promise<Pipeline> {
  const existing = await listPipelines(tenantId, orgId);
  if (existing.length > 0) return existing[0]!;
  const ts = nowIso();
  const p: Pipeline = {
    pipelineId: `pipe:${randomUUID()}`,
    tenantId,
    orgId,
    name: 'Default pipeline',
    stages: DEFAULT_STAGES.map((s) => stage(s.name, s.probability)),
    createdAt: ts,
    updatedAt: ts,
  };
  await pipelines.put(p);
  return p;
}

export async function createPipeline(tenantId: string, orgId: string, name: string, stageInput: Array<{ name: string; probability?: number }>, kind?: PipelineKind, opts: CrmEmitOptions = {}): Promise<Pipeline> {
  const stages = (stageInput.length > 0 ? stageInput : DEFAULT_STAGES).slice(0, MAX.stages).map((s) => stage(s.name, typeof s.probability === 'number' ? s.probability : 0));
  const ts = nowIso();
  // ADR 0540 D3 — omit the key entirely for the default so existing rows and
  // new revenue pipelines are byte-identical; `undefined` already MEANS revenue.
  const p: Pipeline = {
    pipelineId: `pipe:${randomUUID()}`, tenantId, orgId,
    name: cleanStr(name, MAX.name, 'Pipeline'), stages,
    ...(kind && kind !== 'revenue' ? { kind } : {}),
    createdAt: ts, updatedAt: ts,
  };
  await pipelines.put(p);
  // ADR 0627 D2 — the ONE `pipeline.created` site. (`getOrCreateDefaultPipeline`
  // materializes the lazy default inside READS and stays silent — unchanged.)
  crmMutated({ entity: 'pipeline', verb: 'created', tenantId, orgId, entityId: p.pipelineId, ...opts });
  return p;
}

export async function updatePipeline(
  tenantId: string,
  orgId: string,
  pipelineId: string,
  patch: { name?: string; kind?: PipelineKind; stages?: Array<{ stageId?: string; name: string; probability?: number }> },
  opts: CrmEmitOptions = {},
): Promise<Pipeline | null> {
  const p = await getPipeline(tenantId, orgId, pipelineId);
  if (!p) return null;
  const next: Pipeline = { ...p, updatedAt: nowIso() };
  if (patch.name !== undefined) next.name = cleanStr(patch.name, MAX.name, p.name);
  // ADR 0540 D3 — switching to `revenue` DELETES the key rather than storing it,
  // so the stored shape has exactly one representation of the default.
  if (patch.kind !== undefined) {
    if (patch.kind === 'revenue') delete next.kind;
    else next.kind = patch.kind;
  }
  if (patch.stages !== undefined) {
    // Preserve a stage's id (and thus deals on it) when the caller keeps it.
    const byId = new Map(p.stages.map((s) => [s.stageId, s]));
    next.stages = patch.stages.slice(0, MAX.stages).map((s) => {
      const keep = s.stageId ? byId.get(s.stageId) : undefined;
      return {
        stageId: keep?.stageId ?? `stg:${randomUUID()}`,
        name: cleanStr(s.name, MAX.short, keep?.name ?? 'Stage'),
        probability: typeof s.probability === 'number' ? Math.max(0, Math.min(100, Math.round(s.probability))) : (keep?.probability ?? 0),
      };
    });
    // Referential integrity (code-review #1): refuse to drop a stage that deals
    // sit on — orphaning them onto a dead stageId. Same guard as deletePipeline.
    const survivingIds = new Set(next.stages.map((s) => s.stageId));
    const removedIds = p.stages.filter((s) => !survivingIds.has(s.stageId)).map((s) => s.stageId);
    if (removedIds.length > 0) {
      const orphaned = await listDealsOnStages(tenantId, orgId, pipelineId, removedIds);
      if (orphaned.length > 0) {
        throw new OpenwopError('validation_error', 'A removed stage still has deals — move them to another stage first.', 409, { dealsOnRemovedStages: orphaned.length });
      }
    }
  }
  await pipelines.put(next);
  const changed = changedFields(p, next); // ADR 0627 D2 (review S1) — pre-image vs landed (`stages[]` deep-compared)
  if (changed.length > 0) crmMutated({ entity: 'pipeline', verb: 'updated', tenantId, orgId, entityId: pipelineId, changed, ...opts });
  return next;
}

export async function deletePipeline(tenantId: string, orgId: string, pipelineId: string, opts: CrmEmitOptions = {}): Promise<boolean> {
  const p = await getPipeline(tenantId, orgId, pipelineId);
  if (!p) return false;
  const referencing = await anyDealsOnPipeline(tenantId, orgId, pipelineId);
  if (referencing) {
    throw new OpenwopError('validation_error', 'Pipeline still has deals — move or delete them first.', 409, { pipelineId });
  }
  await pipelines.delete(pipelineId);
  crmMutated({ entity: 'pipeline', verb: 'deleted', tenantId, orgId, entityId: pipelineId, ...opts });
  return true;
}

/** Every pipeline row (no tenant/org filter) — used ONLY by `snapshots.ts`'s
 *  `listCrmOrgScopes` (the snapshot daemon's tenant/org enumerator). Never
 *  call this from request-serving code: an unbounded full-collection scan by
 *  design (the snapshot daemon runs hourly, not per-request — mirrors
 *  `listSyncSourceTenants`: no global tenant-listing primitive exists, so a
 *  feature-owned daemon derives its own scan input from its own rows). */
export async function listAllPipelinesUnscoped(): Promise<Pipeline[]> {
  return pipelines.list();
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __clearPipelines(): Promise<void> {
  await pipelines.__clear();
}
