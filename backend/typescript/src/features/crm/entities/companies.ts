/**
 * CRM Companies (ADR 0008 Phase 1) — org-scoped and RBAC-gated. Every record
 * carries tenantId + orgId and every accessor verifies BOTH (CTI-1 IDOR
 * guard). Split out of the former `crmEntitiesService.ts` god-file
 * (CRMGAP-10) — re-exported unchanged via that file's barrel.
 *
 * @see docs/adr/0008-crm-full-port.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { filterVisibleCrmRecords } from '../../../host/crmRecordVisibility.js';
import { fireCrmRecordDeleted } from '../../../host/crmRecordLifecycle.js';
import { OpenwopError } from '../../../types.js';
import { MAX, MAX_PER_ORG_ENTITIES, assertUnderCap, cleanStr, cleanTags, nowIso, optStr } from './shared.js';
// ADR 0409 Phase 2 — companies live in the CONTENT KERNEL. This module is the
// CRM domain FAÇADE: it keeps every exported signature + org-scoped RBAC +
// merge/CAS + firmographics, and stores rows as `crm.company` system-type kernel
// records (id-preserving: companyId=entityId). A DECLARED one-directional
// dependency (crm → entities); the kernel never imports crm.
import {
  mintSystemType, listAllSystemRows, type EntityRecord,
} from '../../entities/entitiesService.js';
import { makeKernelAdapter } from '../../entities/kernelAdapter.js';
import { changedFields, crmMutated, emitOptsOf, type CrmEmitOptions } from '../emit.js';

// ── crm.company kernel adapter (ADR 0409 Phase 2) ───────────────────────────
const CRM_COMPANY_TYPE = 'crm.company';
/** Queryable scalar projection (values). The FULL Company rides `ext.company`
 *  (the SoT); values is what generic RBAC-gated query/entityList reads. */
const COMPANY_SCALARS = [
  { key: 'org_id', label: 'Org', type: 'string', required: true },
  { key: 'name', label: 'Name', type: 'string', required: true },
  { key: 'domain', label: 'Domain', type: 'string', required: false },
  { key: 'industry', label: 'Industry', type: 'string', required: false },
  { key: 'size', label: 'Company size', type: 'number', required: false },
  { key: 'revenue', label: 'Revenue', type: 'number', required: false },
  { key: 'merged_into', label: 'Merged into', type: 'string', required: false },
];
/** No process memo (storage can reset under a live process — the cms.page
 *  ensurePageType lesson): mint is idempotent (one point-read when present). */
async function ensureCompanyType(tenantId: string): Promise<void> {
  await mintSystemType({ tenantId, name: CRM_COMPANY_TYPE, displayName: 'Company', fields: COMPANY_SCALARS, neverPublic: true, actor: 'system:crm' });
}
function companyToKernel(c: Company): { values: Record<string, unknown>; ext: Record<string, unknown> } {
  return {
    values: {
      org_id: c.orgId, name: c.name,
      ...(c.domain !== undefined ? { domain: c.domain } : {}),
      ...(c.industry !== undefined ? { industry: c.industry } : {}),
      ...(c.size !== undefined ? { size: c.size } : {}),
      ...(c.revenue !== undefined ? { revenue: c.revenue } : {}),
      ...(c.mergedInto !== undefined ? { merged_into: c.mergedInto } : {}),
    },
    ext: { company: c },
  };
}
const kernelToCompany = (rec: EntityRecord): Company => (rec.ext?.company as Company);

/** LEGACY store — retained READ-DARK for the migration + the historical
 *  APP_MIGRATION 4 backfill (which operates on legacy rows before the kernel
 *  move). The service functions no longer read it. */
const legacyCompanies = new DurableCollection<Company>('crm:company', (c) => c.companyId, undefined, (c) => c.tenantId);

/** The kernel-backed store adapter the service functions use. Every method is
 *  tenant-aware (the kernel is tenant-namespaced; the tenant-less
 *  `companies.get(id)` shape is gone — every caller has the tenant). */
/** The kernel-backed store adapter the service functions use (KERNEL-5 shared
 *  factory). Every method is tenant-aware; `cas` is byte-identical over
 *  ext.company (merge safety). */
const companies = makeKernelAdapter<Company>({
  typeName: CRM_COMPANY_TYPE,
  ensureType: ensureCompanyType,
  toKernel: companyToKernel,
  fromKernel: kernelToCompany,
  idOf: (c) => c.companyId,
  tenantOf: (c) => c.tenantId,
  orgOf: (c) => c.orgId,
  actorOf: (c) => c.createdBy,
  updatedAtOf: (c) => c.updatedAt,
  legacy: legacyCompanies,
});

/** ADR 0409 Phase 2 — the id-preserving legacy→kernel migration (idempotent,
 *  concurrency-safe; legacy rows read-dark one release). */
export async function migrateCompaniesToKernel(): Promise<{ migrated: number; skipped: number }> {
  return companies.migrate();
}

export interface Company {
  companyId: string;
  tenantId: string;
  orgId: string;
  name: string;
  domain?: string;
  industry?: string;
  /** CRM-2 (ADR 0383) — first-class firmographics (optional; `size` = employee count,
   *  `revenue` = annual revenue in MAJOR units, matching the commerce `price:number`
   *  convention). Promoted from `customFields.employees`; pre-promotion rows are backfilled
   *  by APP_MIGRATION 4. */
  size?: number;
  revenue?: number;
  tags: string[];
  customFields: Record<string, string | number | boolean>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Set by a merge (ADR 0209 §2): this company is a TOMBSTONE — see Contact.mergedInto. */
  mergedInto?: string;
  mergedAt?: string;
}

/** Excludes tombstoned (merged-away) companies — see `listContacts`. */
export async function listCompanies(tenantId: string, orgId: string, q?: string, viewerSubject?: string): Promise<Company[]> {
  const needle = q?.trim().toLowerCase();
  const rows = (await companies.listForTenant(tenantId)).filter(
    (c) => c.orgId === orgId && !c.mergedInto && (!needle || c.name.toLowerCase().includes(needle)),
  );
  // Row-level territory visibility (ADR 0272 P4) — no-op unless a viewer subject
  // is supplied AND the territories resolver is registered.
  return filterVisibleCrmRecords({ tenantId, orgId, target: 'company', callerSubject: viewerSubject, rows, idOf: (c) => c.companyId });
}

export async function getCompany(tenantId: string, orgId: string, companyId: string): Promise<Company | null> {
  const c = await companies.get(tenantId, companyId);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

/** CRM-2 firmographic validators — fail-closed (a bad value 400s). `undefined`/`null` ⇒ absent. */
function optSize(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new OpenwopError('validation_error', 'Field `size` MUST be a non-negative integer.', 400, { field: 'size' });
  return v;
}
function optRevenue(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new OpenwopError('validation_error', 'Field `revenue` MUST be a non-negative number.', 400, { field: 'revenue' });
  return v;
}

export async function createCompany(input: {
  tenantId: string;
  orgId: string;
  name: string;
  domain?: unknown;
  industry?: unknown;
  size?: unknown;
  revenue?: unknown;
  tags?: unknown;
  customFields?: Record<string, string | number | boolean>;
  createdBy: string;
  /** Caller-supplied deterministic id (ADR 0162 pattern). MUST be `cmp:`-prefixed.
   *  A row already at this id in the SAME tenant+org is returned unchanged; a
   *  row at this id in a DIFFERENT tenant/org 404s (never leak/overwrite). */
  companyId?: string;
  /** CRMGAP-6: a bulk caller (the import route) that already maintains its OWN
   *  running count across the batch (via the exported `assertUnderCap`) skips
   *  the per-call full-collection `listCompanies` re-scan — mirrors
   *  `createActivity`'s `skipCapCheck` (CRMGAP-2). Human/agent single-record
   *  paths never set this. */
  skipCapCheck?: boolean;
} & CrmEmitOptions): Promise<Company> {
  if (input.companyId !== undefined) {
    if (!input.companyId.startsWith('cmp:')) {
      throw new OpenwopError('validation_error', 'companyId must be `cmp:`-prefixed.', 400, { companyId: input.companyId });
    }
    const existing = await companies.get(input.tenantId, input.companyId);
    if (existing) {
      if (existing.tenantId === input.tenantId && existing.orgId === input.orgId) return existing;
      throw new OpenwopError('not_found', 'Company not found.', 404, { companyId: input.companyId });
    }
  }
  if (input.skipCapCheck !== true) {
    assertUnderCap((await listCompanies(input.tenantId, input.orgId)).length, MAX_PER_ORG_ENTITIES, 'companies');
  }
  const ts = nowIso();
  const c: Company = {
    companyId: input.companyId ?? `cmp:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    name: cleanStr(input.name, MAX.name, 'Untitled company'),
    ...(optStr(input.domain, MAX.short) ? { domain: optStr(input.domain, MAX.short) } : {}),
    ...(optStr(input.industry, MAX.short) ? { industry: optStr(input.industry, MAX.short) } : {}),
    ...(optSize(input.size) !== undefined ? { size: optSize(input.size) } : {}),
    ...(optRevenue(input.revenue) !== undefined ? { revenue: optRevenue(input.revenue) } : {}),
    tags: cleanTags(input.tags),
    customFields: input.customFields ?? {},
    createdBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await companies.put(c);
  // ADR 0627 D2 — the ONE `company.created` site, NEW row only (the same-id
  // return above is not a creation); the import lane passes `{ silent: true }`.
  crmMutated({ entity: 'company', verb: 'created', tenantId: c.tenantId, orgId: c.orgId, entityId: c.companyId, ...emitOptsOf(input) });
  return c;
}

/** Raw stored row (CRMGAP-8) — `getCompany` already returns the raw row (no
 *  projection step exists for `Company`), so this is API symmetry with
 *  `contactsService.getContactForCas`: it makes the "the exact value CAS
 *  compares against" contract explicit at the merge call site. */
export async function getCompanyForCas(tenantId: string, orgId: string, companyId: string): Promise<Company | null> {
  return getCompany(tenantId, orgId, companyId);
}

/**
 * CAS-guarded company field-fill (CRMGAP-8) — mirrors
 * `contactsService.casUpdateContact`: `expected` MUST be the exact value from
 * `getCompanyForCas`; the swap only lands if the stored row is still
 * byte-identical, so two concurrent merges into the SAME survivor can't lose
 * one fill to the other's last-writer-wins `put`. Returns the new row on
 * success, `null` on a lost race — NEVER throws.
 */
export async function casUpdateCompany(
  expected: Company,
  patch: { domain?: string; industry?: string; tags?: string[]; customFields?: Record<string, string | number | boolean> },
): Promise<Company | null> {
  if (Object.keys(patch).length === 0) return expected;
  const next: Company = { ...expected, ...patch, updatedAt: nowIso() };
  const swapped = await companies.cas(expected, next);
  return swapped ? next : null;
}

/** GEN-7 — clear a merge tombstone (company unmerge restore). CAS-guarded, idempotent
 *  (already-live → true). The source row's own domain/industry/tags/customFields were
 *  left intact by `tombstoneCompany`, so un-tombstoning restores the source fully. */
export async function untombstoneCompany(tenantId: string, orgId: string, companyId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const c = await getCompanyForCas(tenantId, orgId, companyId);
    if (!c || c.tenantId !== tenantId || c.orgId !== orgId) return false;
    if (!c.mergedInto) return true; // already live
    const { mergedInto: _m, mergedAt: _a, ...rest } = c;
    if (await companies.cas(c, { ...rest, updatedAt: nowIso() })) return true;
  }
  return false;
}

/** GEN-7 — revert what a merge ABSORBED onto the survivor, fail-closed PER FIELD in one
 *  CAS: clear a scalar (domain/industry) only if it still equals the recorded absorbed
 *  value; drop only tags still present; delete only customField keys whose value still
 *  equals what the merge wrote. A later user edit to any of these is respected (left
 *  intact) — safe because the un-tombstoned source already carries its own original data. */
export async function casRevertCompanyAbsorption(
  tenantId: string, orgId: string, companyId: string,
  spec: { filledFields: Record<string, string>; absorbedTags: readonly string[]; absorbedCustomFields: Record<string, string | number | boolean> },
): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const c = await getCompanyForCas(tenantId, orgId, companyId);
    // Survivor gone / foreign → nothing to revert; vacuously done (NOT a contention
    // failure — the caller must not retry a delete that already happened).
    if (!c || c.tenantId !== tenantId || c.orgId !== orgId) return true;
    const next: Company = { ...c };
    if (spec.filledFields.domain !== undefined && next.domain === spec.filledFields.domain) delete next.domain;
    if (spec.filledFields.industry !== undefined && next.industry === spec.filledFields.industry) delete next.industry;
    if (spec.absorbedTags.length) next.tags = next.tags.filter((t) => !spec.absorbedTags.includes(t));
    if (Object.keys(spec.absorbedCustomFields).length) {
      const cf = { ...next.customFields };
      for (const [k, v] of Object.entries(spec.absorbedCustomFields)) if (cf[k] === v) delete cf[k];
      next.customFields = cf;
    }
    if (await companies.cas(c, { ...next, updatedAt: nowIso() })) return true;
  }
  return false; // CAS contention exhausted — the survivor exists but a concurrent write won every attempt; the caller may retry.
}

export async function updateCompany(
  tenantId: string,
  orgId: string,
  companyId: string,
  patch: { name?: string; domain?: string | null; industry?: string | null; size?: number | null; revenue?: number | null; tags?: unknown; customFields?: Record<string, string | number | boolean> },
  opts: CrmEmitOptions = {},
): Promise<Company | null> {
  const c = await getCompany(tenantId, orgId, companyId);
  if (!c) return null;
  const next: Company = { ...c, updatedAt: nowIso() };
  if (patch.name !== undefined) next.name = cleanStr(patch.name, MAX.name, c.name);
  if (patch.domain !== undefined) {
    if (patch.domain === null) delete next.domain;
    else next.domain = optStr(patch.domain, MAX.short);
  }
  if (patch.industry !== undefined) {
    if (patch.industry === null) delete next.industry;
    else next.industry = optStr(patch.industry, MAX.short);
  }
  // CRM-2 — null clears; a value is validated fail-closed.
  if (patch.size !== undefined) {
    if (patch.size === null) delete next.size;
    else next.size = optSize(patch.size);
  }
  if (patch.revenue !== undefined) {
    if (patch.revenue === null) delete next.revenue;
    else next.revenue = optRevenue(patch.revenue);
  }
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  if (patch.customFields !== undefined) next.customFields = patch.customFields;
  await companies.put(next);
  const changed = changedFields(c, next); // ADR 0627 D2 (review S1) — pre-image vs landed, never the patch's keys
  if (changed.length > 0) crmMutated({ entity: 'company', verb: 'updated', tenantId, orgId, entityId: companyId, changed, ...opts });
  return next;
}

/** APP_MIGRATION 4 (ADR 0383) — lift the legacy `customFields.employees` onto the promoted
 *  first-class `size`, then drop the customField. Idempotent: a row already carrying `size`
 *  (or with no numeric `employees`) is skipped, so a re-run is a no-op. Forward-only. */
export async function backfillCompanySizeFromEmployees(): Promise<number> {
  let updated = 0;
  // ADR 0409 Phase 2 — operates on the KERNEL rows (where companies now live),
  // across all tenants. Idempotent (skips rows that already have `size`).
  for (const rec of await listAllSystemRows(CRM_COMPANY_TYPE)) {
    const c = kernelToCompany(rec);
    const emp = c.customFields?.employees;
    // Only lift a value that satisfies the SAME invariant the API write path enforces via
    // `optSize` (non-negative integer). A legacy `customFields.employees` that is a float /
    // negative / huge is LEFT in place (not lifted) rather than written to `size` as an
    // invalid first-class value that a later PATCH round-trip would then reject.
    if (c.size !== undefined || typeof emp !== 'number' || !Number.isInteger(emp) || emp < 0) continue;
    const cf = { ...c.customFields };
    delete cf.employees;
    await companies.put({ ...c, size: emp, customFields: cf, updatedAt: nowIso() });
    updated += 1;
  }
  return updated;
}

export async function deleteCompany(tenantId: string, orgId: string, companyId: string, opts: CrmEmitOptions = {}): Promise<boolean> {
  const c = await getCompany(tenantId, orgId, companyId);
  if (!c) return false;
  await companies.delete(tenantId, companyId);
  // ADR 0283 — fire AFTER the row is gone (fail-closed ordering) so consumer
  // features (territory assignments, …) can drop their soft references.
  await fireCrmRecordDeleted({ tenantId, orgId, entity: 'company', recordId: companyId });
  crmMutated({ entity: 'company', verb: 'deleted', tenantId, orgId, entityId: companyId, ...opts });
  return true;
}

/** Tombstone a merge SOURCE company (ADR 0209 §2) — see `contactsService.tombstoneContact`.
 *  NOTE: `getCompany` (above) does NOT filter tombstones — only `listCompanies`
 *  does — so a merge can still read a just-tombstoned source by id. */
export async function tombstoneCompany(tenantId: string, orgId: string, companyId: string, survivorId: string): Promise<void> {
  const existing = await companies.get(tenantId, companyId);
  if (!existing || existing.tenantId !== tenantId || existing.orgId !== orgId) return;
  await companies.put({ ...existing, mergedInto: survivorId, mergedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

/** Existence check for a `reference` field's `company` target when the
 *  caller has no org context (contact defs are tenant-scoped — ADR 0213 §2):
 *  tenant-wide instead of org-scoped, tombstoned companies excluded. */
export async function companyExistsInTenant(tenantId: string, companyId: string): Promise<boolean> {
  const c = await companies.get(tenantId, companyId);
  return c !== null && c.tenantId === tenantId && !c.mergedInto;
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __clearCompanies(): Promise<void> {
  await companies.__clear();
}
