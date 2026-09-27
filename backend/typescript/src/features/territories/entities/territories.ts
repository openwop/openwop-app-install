/**
 * Sales Territory Management — the model layer (ADR 0272 Phase 1).
 *
 * A LAYERED territory model over the existing CRM (ADR 0008 / 0208–0213):
 *   TerritoryType   — classification ("Geographic", "Named-Account")
 *   TerritoryModel  — an org arrangement / scenario with a lifecycle
 *   Territory       — a node in a parent-child hierarchy within a model
 *
 * Model lifecycle: `planning` (freely editable; previewable — P2) → `active`
 * (exactly ONE per (tenant,org); drives record access + forecast) → `archived`
 * (read-only history). The single-active invariant is enforced by a
 * `DurableCollection.compareAndSwap` on a per-(tenant,org) active pointer
 * (the approvalService A7 / accessControl ≥1-owner precedent) — two concurrent
 * activations cannot both win. `getActiveModelId` is the O(1) authority read
 * the P4 visibility resolver and P3 reports consume.
 *
 * Every accessor verifies `tenantId` + `orgId` (the CRM "CTI-1" IDOR guard).
 * Territories reference accessControl org members by opaque subject id
 * (RFC 0048) — NO net-new people store. The hierarchy is validated acyclic with
 * the Kahn pattern borrowed from `orgChartService.hasReportsToCycle` (the agent
 * org-chart is the wrong owner — agents-only, authority-forbidden, RFC 0087 §B).
 *
 * @see docs/adr/0272-sales-territory-management.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { cleanString, cleanOpaqueToken } from '../../../host/boundedStrings.js';
import { validateTerritoryType, validateTerritoryModel, validateTerritory, isObj, isStr, isNeStr } from './rowGuards.js';

export type ModelState = 'planning' | 'active' | 'archived';
export const MODEL_STATES: readonly ModelState[] = ['planning', 'active', 'archived'];

export interface TerritoryType {
  territoryTypeId: string;
  tenantId: string;
  orgId: string;
  name: string;
  /** Higher wins when a record could match rules of two types (P2). */
  priority: number;
  createdAt: string;
}

export interface TerritoryModel {
  modelId: string;
  tenantId: string;
  orgId: string;
  name: string;
  state: ModelState;
  createdBy: string;
  createdAt: string;
  activatedAt?: string;
  archivedAt?: string;
}

export interface Territory {
  territoryId: string;
  tenantId: string;
  orgId: string;
  modelId: string;
  territoryTypeId?: string;
  name: string;
  /** Parent-child hierarchy edge; `null` at a root. */
  parentTerritoryId: string | null;
  /** An accessControl org member (RFC 0048 subject); manages this subtree. */
  managerSubjectId?: string;
  /** Reps = accessControl org members (opaque subject ids). */
  memberSubjectIds: string[];
  /** Explicit sales-map region (ADR 0282 §8 mapping field): a Natural Earth
   *  ADM0_A3 lowercase country id (e.g. `usa`). When set, the map colours that
   *  country from this territory regardless of the territory's name; absent ⇒
   *  the map falls back to name/alias matching. Opaque to the backend (the
   *  region catalog is frontend-vendored data). */
  regionId?: string;
  createdAt: string;
  updatedAt: string;
}

/** One row per (tenant,org): the pointer to the single active model. A CAS
 *  target — `modelId === ''` means "no active model". */
interface ActivePointer {
  pointerId: string; // `${tenantId}::${orgId}`
  tenantId: string;
  orgId: string;
  modelId: string;
  at: string;
  /** Bumped on every (re)materialize of assignments — lets a cross-instance
   *  visibility index detect a same-model re-sync without a wall-clock TTL. */
  assignVersion?: number;
}

const MAX = { name: 160, perOrgTypes: 50, perOrgModels: 100, perModelTerritories: 2000, members: 500 } as const;

// Read-side validators (TERR-DATA-5) reject corrupt/drifted rows at the boundary.
// The ActivePointer guard is inline because its type is module-private AND its
// `modelId` may legitimately be '' ("no active model") — a non-empty check would
// wrongly skip the empty-pointer row.
const isActivePointer = (v: unknown): v is ActivePointer =>
  isObj(v) && isNeStr(v.pointerId) && isNeStr(v.tenantId) && isNeStr(v.orgId) && isStr(v.modelId);
const validatePointer = (v: unknown): ActivePointer | null => (isActivePointer(v) ? v : null);

const types = new DurableCollection<TerritoryType>('crm:territory-type', (t) => t.territoryTypeId, validateTerritoryType, (t) => t.tenantId);
const models = new DurableCollection<TerritoryModel>('crm:territory-model', (m) => m.modelId, validateTerritoryModel, (m) => m.tenantId);
const territories = new DurableCollection<Territory>('crm:territory', (t) => t.territoryId, validateTerritory, (t) => t.tenantId);
const activePointers = new DurableCollection<ActivePointer>('crm:territory-active', (p) => p.pointerId, validatePointer, (p) => p.tenantId);

const nowIso = (): string => new Date().toISOString();
// Length-prefixed composite key so ('a::b','c') and ('a','b::c') can't collide (L4).
const pointerId = (tenantId: string, orgId: string): string => `${tenantId.length}|${tenantId}|${orgId}`;
const scoped = <T extends { tenantId: string; orgId: string }>(rows: T[], tenantId: string, orgId: string): T[] =>
  rows.filter((r) => r.tenantId === tenantId && r.orgId === orgId);

/** Clean an opaque id/reference token (RFC 0048 subjects, entity ids) WITHOUT the
 *  secret-scrubbing `optionalCleanString` applies — an id with a 40+ char run
 *  would otherwise be silently mangled (boundedStrings.ts, ADR 0206 precedent). */
const optToken = (raw: unknown): string | undefined => cleanOpaqueToken(raw, MAX.name) || undefined;

function assertUnderCap(count: number, max: number, label: string): void {
  if (count >= max) throw new OpenwopError('validation_error', `This org has the maximum ${max} ${label}.`, 409, { max });
}

function requireName(raw: unknown): string {
  const name = cleanString(raw, MAX.name, '');
  if (!name) throw new OpenwopError('validation_error', 'Field `name` is required and MUST be a non-empty string.', 400, { field: 'name' });
  return name;
}

/** Kahn-style acyclic check over `parentTerritoryId` (mirrors
 *  `orgChartService.hasReportsToCycle`): repeatedly settle nodes whose parent is
 *  null / absent / already-settled; a remnant ⇒ cycle. */
function hasParentCycle(nodes: Array<{ territoryId: string; parentTerritoryId: string | null }>): boolean {
  const byId = new Map(nodes.map((n) => [n.territoryId, n]));
  const settled = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const n of nodes) {
      if (settled.has(n.territoryId)) continue;
      const p = n.parentTerritoryId;
      if (p === null || !byId.has(p) || settled.has(p)) {
        settled.add(n.territoryId);
        progress = true;
      }
    }
  }
  return settled.size !== nodes.length;
}

// ── Types ───────────────────────────────────────────────────────────────────

export async function createType(tenantId: string, orgId: string, input: { name?: unknown; priority?: unknown }, actor: string): Promise<TerritoryType> {
  void actor;
  assertUnderCap(scoped(await types.listForTenantIndexed(tenantId), tenantId, orgId).length, MAX.perOrgTypes, 'territory types');
  let priority = 0;
  if (input.priority !== undefined) {
    if (typeof input.priority !== 'number' || !Number.isFinite(input.priority)) throw new OpenwopError('validation_error', 'Field `priority` MUST be a finite number.', 400, { field: 'priority' });
    priority = Math.trunc(input.priority);
  }
  const type: TerritoryType = { territoryTypeId: `terrtype:${randomUUID()}`, tenantId, orgId, name: requireName(input.name), priority, createdAt: nowIso() };
  await types.put(type);
  return type;
}

export async function listTypes(tenantId: string, orgId: string): Promise<TerritoryType[]> {
  return scoped(await types.listForTenantIndexed(tenantId), tenantId, orgId).sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
}

// ── Models ──────────────────────────────────────────────────────────────────

export async function createModel(tenantId: string, orgId: string, input: { name?: unknown }, actor: string): Promise<TerritoryModel> {
  assertUnderCap(scoped(await models.listForTenantIndexed(tenantId), tenantId, orgId).length, MAX.perOrgModels, 'territory models');
  const model: TerritoryModel = { modelId: `terrmodel:${randomUUID()}`, tenantId, orgId, name: requireName(input.name), state: 'planning', createdBy: actor, createdAt: nowIso() };
  await models.put(model);
  return model;
}

export async function listModels(tenantId: string, orgId: string): Promise<TerritoryModel[]> {
  const activeId = await getActiveModelId(tenantId, orgId);
  const activePtr = await activePointers.get(pointerId(tenantId, orgId));
  return scoped(await models.listForTenantIndexed(tenantId), tenantId, orgId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((m) => projectModel(m, activeId, activePtr?.at));
}

/** The RAW stored row — `state` is only ever `planning` or `archived`; `active`
 *  is NEVER stored (it is derived from the active pointer — H1 fix), so the
 *  row can't drift out of sync with the single-active invariant. */
async function getModelRaw(tenantId: string, orgId: string, modelId: string): Promise<TerritoryModel> {
  const m = await models.get(modelId);
  if (!m || m.tenantId !== tenantId || m.orgId !== orgId) throw new OpenwopError('not_found', 'Territory model not found.', 404, { modelId });
  return m;
}

/** Project the effective `state`: a model is `active` IFF the pointer names it. */
function projectModel(m: TerritoryModel, activeId: string | null, activatedAt?: string): TerritoryModel {
  if (m.state === 'archived') return m;
  return m.modelId === activeId ? { ...m, state: 'active', ...(activatedAt ? { activatedAt } : {}) } : { ...m, state: 'planning' };
}

export async function getModel(tenantId: string, orgId: string, modelId: string): Promise<TerritoryModel> {
  const raw = await getModelRaw(tenantId, orgId, modelId);
  const ptr = await activePointers.get(pointerId(tenantId, orgId));
  return projectModel(raw, ptr && ptr.modelId ? ptr.modelId : null, ptr?.at);
}

/** A model must be editable — stored `planning` AND not the active model — for
 *  its territories/rules to be mutated; editing the active model would silently
 *  change live access (P4). */
async function requirePlanningModel(tenantId: string, orgId: string, modelId: string): Promise<TerritoryModel> {
  const raw = await getModelRaw(tenantId, orgId, modelId);
  const activeId = await getActiveModelId(tenantId, orgId);
  if (raw.state === 'archived' || raw.modelId === activeId) {
    const effective = raw.modelId === activeId ? 'active' : raw.state;
    throw new OpenwopError('validation_error', `Model is ${effective}; only a planning model can be edited.`, 409, { modelId, state: effective });
  }
  return raw;
}

// ── Territories (hierarchy) ──────────────────────────────────────────────────

export async function listTerritories(tenantId: string, orgId: string, modelId: string): Promise<Territory[]> {
  await getModel(tenantId, orgId, modelId); // IDOR + existence
  return scoped(await territories.listForTenantIndexed(tenantId), tenantId, orgId).filter((t) => t.modelId === modelId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getTerritory(tenantId: string, orgId: string, modelId: string, territoryId: string): Promise<Territory> {
  const t = await territories.get(territoryId);
  if (!t || t.tenantId !== tenantId || t.orgId !== orgId || t.modelId !== modelId) throw new OpenwopError('not_found', 'Territory not found.', 404, { territoryId });
  return t;
}

function cleanMembers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    // NOTE (L5): P1 does not verify a subject is an accessControl org member —
    // deferred to P2/P4 where membership drives assignment + visibility.
    const s = optToken(v);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX.members) break;
  }
  return out;
}

export async function createTerritory(
  tenantId: string,
  orgId: string,
  modelId: string,
  input: { name?: unknown; territoryTypeId?: unknown; parentTerritoryId?: unknown; managerSubjectId?: unknown; memberSubjectIds?: unknown; regionId?: unknown },
  actor: string,
): Promise<Territory> {
  void actor;
  await requirePlanningModel(tenantId, orgId, modelId);
  const siblings = await listTerritories(tenantId, orgId, modelId);
  assertUnderCap(siblings.length, MAX.perModelTerritories, 'territories');

  const territoryTypeId = optToken(input.territoryTypeId);
  if (territoryTypeId) {
    const t = await types.get(territoryTypeId);
    if (!t || t.tenantId !== tenantId || t.orgId !== orgId) throw new OpenwopError('validation_error', 'Unknown territoryTypeId.', 400, { territoryTypeId });
  }
  const parentTerritoryId = optToken(input.parentTerritoryId) ?? null;
  if (parentTerritoryId) await getTerritory(tenantId, orgId, modelId, parentTerritoryId); // parent must be in this model

  const managerSubjectId = optToken(input.managerSubjectId);
  const regionId = optToken(input.regionId)?.toLowerCase();
  const now = nowIso();
  const territory: Territory = {
    territoryId: `terr:${randomUUID()}`,
    tenantId,
    orgId,
    modelId,
    name: requireName(input.name),
    parentTerritoryId,
    memberSubjectIds: cleanMembers(input.memberSubjectIds),
    createdAt: now,
    updatedAt: now,
    ...(territoryTypeId ? { territoryTypeId } : {}),
    ...(managerSubjectId ? { managerSubjectId } : {}),
    ...(regionId ? { regionId } : {}),
  };

  // Acyclic check against the would-be set (a fresh node with a real parent can
  // never introduce a cycle, but validate uniformly to guard future edits).
  if (hasParentCycle([...siblings.map((s) => ({ territoryId: s.territoryId, parentTerritoryId: s.parentTerritoryId })), { territoryId: territory.territoryId, parentTerritoryId }])) {
    throw new OpenwopError('validation_error', 'The territory hierarchy MUST be acyclic.', 400, {});
  }
  await territories.put(territory);
  return territory;
}

export async function updateTerritory(
  tenantId: string,
  orgId: string,
  modelId: string,
  territoryId: string,
  patch: { name?: unknown; parentTerritoryId?: unknown; managerSubjectId?: unknown; memberSubjectIds?: unknown; regionId?: unknown },
  actor: string,
): Promise<Territory> {
  void actor;
  await requirePlanningModel(tenantId, orgId, modelId);
  const current = await getTerritory(tenantId, orgId, modelId, territoryId);

  let parentTerritoryId = current.parentTerritoryId;
  if (patch.parentTerritoryId !== undefined) {
    const p = optToken(patch.parentTerritoryId) ?? null;
    if (p === territoryId) throw new OpenwopError('validation_error', 'A territory cannot be its own parent.', 400, { territoryId });
    if (p) await getTerritory(tenantId, orgId, modelId, p);
    parentTerritoryId = p;
  }

  const next: Territory = {
    ...current,
    parentTerritoryId,
    updatedAt: nowIso(),
    ...(patch.name !== undefined ? { name: requireName(patch.name) } : {}),
    ...(patch.memberSubjectIds !== undefined ? { memberSubjectIds: cleanMembers(patch.memberSubjectIds) } : {}),
  };
  if (patch.managerSubjectId !== undefined) {
    const mgr = optToken(patch.managerSubjectId);
    if (mgr) next.managerSubjectId = mgr;
    else delete next.managerSubjectId;
  }
  if (patch.regionId !== undefined) {
    const region = optToken(patch.regionId)?.toLowerCase();
    if (region) next.regionId = region;
    else delete next.regionId; // '' / null clears the mapping
  }

  const others = (await listTerritories(tenantId, orgId, modelId)).filter((t) => t.territoryId !== territoryId);
  if (hasParentCycle([...others.map((s) => ({ territoryId: s.territoryId, parentTerritoryId: s.parentTerritoryId })), { territoryId, parentTerritoryId }])) {
    throw new OpenwopError('validation_error', 'The territory hierarchy MUST be acyclic.', 400, {});
  }
  await territories.put(next);
  return next;
}

// ── Lifecycle: activate / archive (single-active invariant via CAS) ──────────

/** The active model id + its assignment version (the cross-instance cache key
 *  for the visibility index). One pointer read — reused instead of a bare
 *  getActiveModelId so the resolver doesn't add a second read. */
export async function getActiveModelRef(tenantId: string, orgId: string): Promise<{ modelId: string; assignVersion: number } | null> {
  const p = await activePointers.get(pointerId(tenantId, orgId));
  return p && p.modelId ? { modelId: p.modelId, assignVersion: p.assignVersion ?? 0 } : null;
}

/** Bump the active model's assignment version (called after a (re)materialize)
 *  so every instance's cached index detects the change on its next read.
 *  CAS-guarded (TERR-DATA-3): a blind read-then-`put` would blind-overwrite a
 *  concurrent activation's pointer (lost update on the authority row), reverting
 *  `modelId` and losing that activation. We compare-and-swap and retry, only ever
 *  touching `assignVersion` on whatever pointer is current. */
export async function bumpAssignVersion(tenantId: string, orgId: string): Promise<void> {
  const pid = pointerId(tenantId, orgId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const p = await activePointers.get(pid);
    if (!p || !p.modelId) return; // no active model → nothing to version
    if (await activePointers.compareAndSwap(p, { ...p, assignVersion: (p.assignVersion ?? 0) + 1 })) return;
  }
  // 5 concurrent writers all lost the race — leave the version as-is rather than
  // blind-overwrite the pointer; the index's TTL still refreshes it eventually.
}

export async function getActiveModelId(tenantId: string, orgId: string): Promise<string | null> {
  const p = await activePointers.get(pointerId(tenantId, orgId));
  return p && p.modelId ? p.modelId : null;
}

/** Promote a `planning` model to `active`. The ONLY authority is the pointer
 *  CAS — we NEVER write `state:'active'` onto the row (H1 fix), so two models
 *  can't drift into both being active. The previously-active model is archived
 *  via a guarded model-row CAS (a lost CAS just means someone else already moved
 *  it — the pointer has already left it, so it is no longer active regardless).
 *  A losing pointer-CAS racer gets a 409. */
export async function activateModel(tenantId: string, orgId: string, modelId: string, actor: string): Promise<TerritoryModel> {
  void actor;
  const raw = await getModelRaw(tenantId, orgId, modelId);
  const pid = pointerId(tenantId, orgId);
  const current = await activePointers.get(pid);
  if (current && current.modelId === modelId) return projectModel(raw, modelId, current.at); // already active — idempotent
  if (raw.state === 'archived') throw new OpenwopError('validation_error', 'An archived model cannot be re-activated; clone it into a new planning model.', 409, { modelId });

  const next: ActivePointer = { pointerId: pid, tenantId, orgId, modelId, at: nowIso() };
  const swapped = await activePointers.compareAndSwap(current, next);
  if (!swapped) throw new OpenwopError('conflict', 'A concurrent activation changed the active model; retry.', 409, { orgId });

  if (current && current.modelId && current.modelId !== modelId) {
    const prev = await models.get(current.modelId);
    if (prev && prev.tenantId === tenantId && prev.orgId === orgId && prev.state === 'planning') {
      await models.compareAndSwap(prev, { ...prev, state: 'archived', archivedAt: next.at }); // best-effort; safe if it loses
    }
  }
  return projectModel(raw, modelId, next.at);
}

/** Archive a model (terminal). Archiving the ACTIVE model first clears the
 *  pointer (CAS-guarded so a concurrent activation isn't lost), then flips the
 *  row `planning → archived` via a model-row CAS (a lost CAS ⇒ 409, never a
 *  blind overwrite of a concurrently-changed row). */
export async function archiveModel(tenantId: string, orgId: string, modelId: string, actor: string): Promise<TerritoryModel> {
  void actor;
  const raw = await getModelRaw(tenantId, orgId, modelId);
  if (raw.state === 'archived') return raw;

  const pid = pointerId(tenantId, orgId);
  const current = await activePointers.get(pid);
  if (current && current.modelId === modelId) {
    const cleared = await activePointers.compareAndSwap(current, { ...current, modelId: '', at: nowIso() });
    if (!cleared) throw new OpenwopError('conflict', 'A concurrent activation changed the active model; retry.', 409, { orgId });
  }
  const archived: TerritoryModel = { ...raw, state: 'archived', archivedAt: nowIso() };
  const swapped = await models.compareAndSwap(raw, archived);
  if (!swapped) throw new OpenwopError('conflict', 'The model was modified concurrently; retry.', 409, { modelId });
  return archived;
}

/** Purge an ARCHIVED model + its territory rows (TERR-DATA-2 — the retention
 *  path ADR 0272 originally lacked, leaving archived models + descendants to
 *  accumulate forever against the `perOrgModels` cap). Fail-closed: refuses any
 *  model that is not stored `archived`, and never the pointer's model. The
 *  model-scoped rules/assignments/quotas live in sibling modules (importing them
 *  here would cycle), so the routes.ts cascade purges those FIRST, then calls
 *  this — children-first so a mid-cascade failure leaves the model retryable
 *  (archived models are inert: they drive neither access nor forecast). */
export async function assertModelPurgeable(tenantId: string, orgId: string, modelId: string): Promise<void> {
  const raw = await getModelRaw(tenantId, orgId, modelId);
  const activeId = await getActiveModelId(tenantId, orgId);
  if (raw.state !== 'archived' || raw.modelId === activeId) {
    throw new OpenwopError('validation_error', 'Only an archived model can be purged; archive it first.', 409, { modelId });
  }
}

export async function deleteArchivedModel(tenantId: string, orgId: string, modelId: string, actor: string): Promise<number> {
  void actor;
  await assertModelPurgeable(tenantId, orgId, modelId); // defense-in-depth (routes.ts also gates before the child cascade)
  let removed = 0;
  for (const t of scoped(await territories.listForTenantIndexed(tenantId), tenantId, orgId).filter((t) => t.modelId === modelId)) {
    await territories.delete(t.territoryId);
    removed += 1;
  }
  await models.delete(modelId);
  return removed + 1;
}

/** R2 TER2-B4 — the erasure seam's tenant-wide accessors. Territory rows are
 *  model-scoped everywhere else, but an erasure knows only a tenant + a subject:
 *  it must reach EVERY model, including archived ones, or the ACL edge survives
 *  in the model nobody is looking at. */
export async function __territoriesForErasure(tenantId: string): Promise<Territory[]> {
  return (await territories.listForTenantIndexed(tenantId)).filter((t) => t.tenantId === tenantId);
}
export async function __putTerritoryForErasure(t: Territory): Promise<void> {
  await territories.put(t);
}
/** REVIEW M2 — `TerritoryModel.createdBy` is a FOURTH subject-keyed field the first
 *  pass missed while its own commit message counted three. Every other store in this
 *  repo treats `createdBy` as in scope (`access-orgs`, `workflow:revision`,
 *  `kanban:card` all list it in the erasure-coverage map); neither ratchet can see
 *  this one, because the host gate scans `src/host` only and the feature gate binds
 *  on a `userId: string` field name. */
export async function __modelsForErasure(tenantId: string): Promise<TerritoryModel[]> {
  return (await models.listForTenantIndexed(tenantId)).filter((m) => m.tenantId === tenantId);
}
export async function __putModelForErasure(m: TerritoryModel): Promise<void> {
  await models.put(m);
}

