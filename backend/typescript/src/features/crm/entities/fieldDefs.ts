/**
 * CRM custom field definitions (ADR 0008 Phase 3; ADR 0213 §1/§2 —
 * date/enum/reference + tenant-scoped contact defs). `company`/`deal` defs
 * are org-scoped; `contact` defs are TENANT-scoped (the `CONTACT_FIELD_DEF_ORG`
 * sentinel orgId). Split out of the former `crmEntitiesService.ts` god-file
 * (CRMGAP-10) — re-exported unchanged via that file's barrel.
 *
 * @see docs/adr/0008-crm-full-port.md, docs/adr/0213-crm-field-types-contact-org-migration.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
// ADR 0257 — CRM adopts the shared, entity-agnostic custom-field seam (the seam was originally
// lifted FROM this file). CRM keeps its storage/scoping/caps/dup-check/resolvers; the field-def
// SHAPE validation and the per-value loop now delegate to the seam, so the two can't drift.
import { buildFieldSpec, validateFieldValues } from '../../../host/customFields/index.js';
import { MAX, nowIso } from './shared.js';
import { companyExistsInTenant } from './companies.js';
import { dealExistsInTenant } from './deals.js';
// fieldDefs.ts never imported back from contactsService.ts, so this one-way
// edge is cycle-free — needed for `resolveContactCustomFields`'s `contact`
// reference resolver (ADR 0213 §2).
import { getContact as ctGetContact } from '../contactsService.js';
import { crmMutated, emitOptsOf, type CrmEmitOptions } from '../emit.js';

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'reference';
export const FIELD_TYPES: FieldType[] = ['string', 'number', 'boolean', 'date', 'enum', 'reference'];
export type CustomEntity = 'company' | 'deal' | 'contact';
/** Every entity a custom field can target — used by `validateCustomFields`. */
export const CUSTOM_ENTITIES: CustomEntity[] = ['company', 'deal', 'contact'];
/** The subset the ORG-scoped `/fields` route accepts — `contact` defs are
 *  tenant-scoped (ADR 0213 §2) and only reachable through the tenant `/crm/fields`
 *  routes, never through an org path (that would smuggle a real orgId onto a def
 *  that must stay org-independent). */
export const ORG_CUSTOM_ENTITIES: CustomEntity[] = ['company', 'deal'];

export type RefEntityType = 'company' | 'deal' | 'contact';
const REF_ENTITY_TYPES: RefEntityType[] = ['company', 'deal', 'contact'];

export interface FieldDef {
  defId: string;
  tenantId: string;
  /** Org-scoped for `company`/`deal` defs. `contact` defs are TENANT-scoped
   *  (ADR 0213 §2) — they carry the `CONTACT_FIELD_DEF_ORG` sentinel (`''`),
   *  never a real org id, so a contact def can never be mistaken for (or
   *  smuggled through) an org's field list. */
  orgId: string;
  entityType: CustomEntity;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** `enum` only — 1..24 bounded option strings; the value MUST be one of them. */
  options?: string[];
  /** `reference` only — the id MUST exist as this entity type, in scope
   *  (org for company/deal, tenant for contact); tombstoned refs rejected at
   *  write, dangling refs tolerated at read (deletes don't cascade). */
  refEntityType?: RefEntityType;
  createdAt: string;
}

/** Sentinel `orgId` for tenant-scoped `contact` field defs — see the `FieldDef.orgId` doc. */
export const CONTACT_FIELD_DEF_ORG = '';

const fieldDefs = new DurableCollection<FieldDef>('crm:fielddef', (f) => f.defId, undefined, (f) => f.tenantId);

export async function listFieldDefs(tenantId: string, orgId: string, entityType?: CustomEntity): Promise<FieldDef[]> {
  return (await fieldDefs.listForTenantIndexed(tenantId)).filter((f) => f.orgId === orgId && (entityType === undefined || f.entityType === entityType));
}

/** The tenant's `contact` field defs (ADR 0213 §2 — org-independent). */
export async function listContactFieldDefs(tenantId: string): Promise<FieldDef[]> {
  return (await fieldDefs.listForTenantIndexed(tenantId)).filter((f) => f.entityType === 'contact');
}

async function buildFieldDef(input: {
  tenantId: string;
  orgId: string;
  entityType: CustomEntity;
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: unknown;
  refEntityType?: unknown;
} & CrmEmitOptions): Promise<FieldDef> {
  // Shared shape validation (key normalization, type, label cap 120, enum options, reference
  // target ∈ REF_ENTITY_TYPES). CRM's string cap (MAX.short) already equals the seam's, so this
  // is byte-identical to the former inline checks — only the ORDER shifts: the full shape is
  // validated before the dup-key/cap 409s below (matching the commerce productFields precedent;
  // single-fault responses are unchanged, only a simultaneously-malformed-AND-duplicate request
  // surfaces a 400 before the 409).
  const spec = buildFieldSpec(input, REF_ENTITY_TYPES);
  const scopeLabel = input.entityType === 'contact' ? 'tenant' : 'org';
  const existing = input.entityType === 'contact' ? await listContactFieldDefs(input.tenantId) : await listFieldDefs(input.tenantId, input.orgId, input.entityType);
  if (existing.some((f) => f.key === spec.key)) throw new OpenwopError('validation_error', `A field \`${spec.key}\` already exists for ${input.entityType}.`, 409, { key: spec.key });
  if (existing.length >= MAX.customKeys) throw new OpenwopError('validation_error', `This ${scopeLabel} has the maximum ${MAX.customKeys} custom fields for ${input.entityType}.`, 409, { max: MAX.customKeys });

  // The shared seam (ADR 0257) grew a `media` kind for the entities engine
  // (ADR 0386); CRM's field vocabulary deliberately stays the original six —
  // reject kinds CRM does not model rather than silently widening.
  if (!FIELD_TYPES.includes(spec.type as FieldType)) {
    throw new OpenwopError('validation_error', `type must be one of: ${FIELD_TYPES.join(', ')}`, 400, { field: 'type' });
  }
  const def: FieldDef = {
    defId: `fdef:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    entityType: input.entityType,
    key: spec.key,
    label: spec.label,
    type: spec.type as FieldType,
    required: spec.required,
    ...(spec.options ? { options: spec.options } : {}),
    ...(spec.refEntityType ? { refEntityType: spec.refEntityType as RefEntityType } : {}),
    createdAt: nowIso(),
  };
  await fieldDefs.put(def);
  // ADR 0627 D2 — the ONE `fielddef.created` site (org defs carry `orgId`;
  // tenant-scoped contact defs use the '' sentinel and carry none).
  crmMutated({ entity: 'fielddef', verb: 'created', tenantId: def.tenantId, entityId: def.defId, ...(def.entityType === 'contact' ? {} : { orgId: def.orgId }), ...emitOptsOf(input) });
  return def;
}

export async function createFieldDef(input: {
  tenantId: string;
  orgId: string;
  entityType: CustomEntity;
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: unknown;
  refEntityType?: unknown;
} & CrmEmitOptions): Promise<FieldDef> {
  return buildFieldDef(input);
}

/** Create a tenant-scoped `contact` field def (ADR 0213 §2). */
export async function createContactFieldDef(input: {
  tenantId: string;
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: unknown;
  refEntityType?: unknown;
} & CrmEmitOptions): Promise<FieldDef> {
  return buildFieldDef({ ...input, orgId: CONTACT_FIELD_DEF_ORG, entityType: 'contact' });
}

export async function deleteFieldDef(tenantId: string, orgId: string, defId: string, opts: CrmEmitOptions = {}): Promise<boolean> {
  const f = await fieldDefs.get(defId);
  if (!f || f.tenantId !== tenantId || f.orgId !== orgId) return false;
  await fieldDefs.delete(defId);
  crmMutated({ entity: 'fielddef', verb: 'deleted', tenantId, orgId, entityId: defId, ...opts });
  return true;
}

export async function deleteContactFieldDef(tenantId: string, defId: string, opts: CrmEmitOptions = {}): Promise<boolean> {
  const f = await fieldDefs.get(defId);
  if (!f || f.tenantId !== tenantId || f.entityType !== 'contact') return false;
  await fieldDefs.delete(defId);
  crmMutated({ entity: 'fielddef', verb: 'deleted', tenantId, entityId: defId, ...opts });
  return true;
}

/** Caller-supplied existence checks for the `reference` field type — kept as
 *  resolvers (rather than `validateCustomFields` reaching into other services
 *  itself) so an org-scoped caller can bind org-scoped lookups while a
 *  tenant-scoped caller (contacts) binds tenant-wide ones, with no circular
 *  import between this file and `contactsService`. */
export interface CustomFieldRefResolvers {
  company: (id: string) => Promise<boolean>;
  deal: (id: string) => Promise<boolean>;
  contact: (id: string) => Promise<boolean>;
}

/**
 * Validate a `customFields` map against the org's (or, for `contact`, the
 * tenant's) active field defs for an entity: every provided key MUST be
 * defined and type-correct; on create (`requireAll`) every required def must
 * be present. Returns the validated map (only defined keys) — unknown keys
 * are rejected, not silently dropped. The ONE path routes/import/workflow
 * verbs all funnel through (ADR 0213 §1/§2).
 */
export async function validateCustomFields(
  tenantId: string,
  orgId: string,
  entityType: CustomEntity,
  provided: Record<string, unknown>,
  opts: {
    requireAll: boolean;
    refResolvers: CustomFieldRefResolvers;
    /** CRMGAP-6: a bulk caller (the import route) that already fetched the
     *  entity's defs ONCE before its per-row loop passes them here, skipping
     *  the per-row `listFieldDefs`/`listContactFieldDefs` re-read. Single-record
     *  callers omit this — the defs are fetched fresh (correct for their scale). */
    defs?: FieldDef[];
  },
): Promise<Record<string, string | number | boolean>> {
  const defs = opts.defs ?? (entityType === 'contact' ? await listContactFieldDefs(tenantId) : await listFieldDefs(tenantId, orgId, entityType));
  // ADR 0257 — the per-value loop is the shared seam. CRM keeps the defs fetch + scoping (above)
  // and the 3-key resolver, adapted to the seam's single `resolveReference`. `FieldDef[]` is
  // structurally a `FieldSpec[]`. The one behavior delta vs the former inline loop: the seam's
  // `date` check rejects day-overflow "rollover" dates (2023-02-30) that CRM's Date.parse check
  // silently accepted — a deliberate write-time-only correctness hardening (ADR 0257).
  return validateFieldValues(defs, provided, {
    requireAll: opts.requireAll,
    entityLabel: entityType,
    // Route the seam's single (refEntityType, id) resolver to CRM's per-type resolver — a
    // non-company/deal refType uses the contact resolver, matching the former `?? 'contact'`
    // default; dangling-ref ⇒ reject is preserved inside the injected resolvers.
    resolveReference: (refType, id) => (refType === 'company' ? opts.refResolvers.company : refType === 'deal' ? opts.refResolvers.deal : opts.refResolvers.contact)(id),
  });
}

function isFieldMap(v: unknown): v is Record<string, string | number | boolean> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => ['string', 'number', 'boolean'].includes(typeof x));
}

/** Validate a contact's `customFields` against the tenant's `contact` field
 *  defs (ADR 0213 §2) — the ONE place both the tenant contacts routes and the
 *  org import route (`entityType: 'contact'`) call, so validation can't drift
 *  between entry points. Reference resolution is tenant-wide (contacts have no
 *  org). Imports `contactsService.getContact` — safe (contactsService never
 *  imports this file back). */
export async function resolveContactCustomFields(
  tenantId: string,
  raw: unknown,
  requireAll: boolean,
  /** CRMGAP-6: precomputed defs (see `validateCustomFields`'s `opts.defs` doc) —
   *  the import route's per-row contact path passes its ONE pre-loop
   *  `listContactFieldDefs` fetch here instead of paying it again per row. */
  defs?: FieldDef[],
): Promise<Record<string, string | number | boolean> | undefined> {
  if (raw === undefined && !requireAll) return undefined;
  const provided = isFieldMap(raw) ? raw : {};
  return validateCustomFields(tenantId, CONTACT_FIELD_DEF_ORG, 'contact', provided, {
    requireAll,
    ...(defs ? { defs } : {}),
    refResolvers: {
      company: (id) => companyExistsInTenant(tenantId, id),
      deal: (id) => dealExistsInTenant(tenantId, id),
      contact: async (id) => {
        const contact = await ctGetContact(id);
        return contact !== null && contact.tenantId === tenantId && !contact.mergedInto;
      },
    },
  });
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __clearFieldDefs(): Promise<void> {
  await fieldDefs.__clear();
}
