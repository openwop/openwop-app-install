// ADR 0257 — typed product custom fields, built on the shared host/customFields seam. This
// is the TYPED layer above the DEF-4 `Product.attributes` bag (untyped {label,value} pairs
// stay for freeform use); `customFields` are validated against org-scoped `ProductFieldDef`s
// (string/number/boolean/date/enum). `reference` fields are out of v1 (no cross-entity refs
// for products) — the seam rejects them at define time (empty allowed-ref list).

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { buildFieldSpec, isBuiltinFieldType, validateFieldValues, type FieldType, type FieldSpec } from '../../host/customFields/index.js';

const MAX_FIELDS_PER_ORG = 40;

export interface ProductFieldDef {
  defId: string;
  tenantId: string;
  orgId: string;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  createdAt: string;
}

const productFieldDefs = new DurableCollection<ProductFieldDef>('commerce:product-fielddef', (f) => f.defId, undefined, (f) => f.tenantId);

export async function listProductFieldDefs(tenantId: string, orgId: string): Promise<ProductFieldDef[]> {
  return (await productFieldDefs.listForTenantIndexed(tenantId)).filter((f) => f.orgId === orgId).sort((a, b) => a.key.localeCompare(b.key));
}

export async function createProductFieldDef(input: { tenantId: string; orgId: string; key: unknown; label: unknown; type: unknown; required?: unknown; options?: unknown }): Promise<ProductFieldDef> {
  const spec = buildFieldSpec(input, []); // no reference fields for products (v1)
  // Pin the product-field vocabulary to BUILT-IN kinds (ADR 0408 D2 —
  // extension kinds never reach commerce; this narrows the seam's widened
  // FieldSpec.type honestly) and reject `media` (no storefront surface, v1).
  if (!isBuiltinFieldType(spec.type) || spec.type === 'media') {
    throw new OpenwopError('validation_error', `type \`${spec.type}\` is not supported for product fields.`, 400, { field: 'type' });
  }
  const existing = await listProductFieldDefs(input.tenantId, input.orgId);
  if (existing.some((f) => f.key === spec.key)) throw new OpenwopError('validation_error', `A product field \`${spec.key}\` already exists.`, 409, { key: spec.key });
  if (existing.length >= MAX_FIELDS_PER_ORG) throw new OpenwopError('validation_error', `This store has the maximum ${MAX_FIELDS_PER_ORG} product fields.`, 409, { max: MAX_FIELDS_PER_ORG });
  const def: ProductFieldDef = {
    defId: `pfdef:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId,
    key: spec.key, label: spec.label, type: spec.type, required: spec.required,
    ...(spec.options ? { options: spec.options } : {}),
    createdAt: new Date().toISOString(),
  };
  await productFieldDefs.put(def);
  return def;
}

export async function deleteProductFieldDef(tenantId: string, orgId: string, defId: string): Promise<boolean> {
  const f = await productFieldDefs.get(defId);
  if (!f || f.tenantId !== tenantId || f.orgId !== orgId) return false;
  await productFieldDefs.delete(defId);
  return true;
}

/** Validate a product's typed `customFields` against the org's defs. `requireAll` (create)
 *  enforces required fields. Returns the validated map, or undefined when there are no defs
 *  and nothing was provided (byte-identical to a product without typed fields). */
export async function validateProductCustomFields(
  tenantId: string, orgId: string, raw: unknown, requireAll: boolean,
): Promise<Record<string, string | number | boolean> | undefined> {
  const defs = await listProductFieldDefs(tenantId, orgId);
  const provided = isFieldMap(raw) ? raw : {};
  if (defs.length === 0 && Object.keys(provided).length === 0) return undefined;
  const specs: FieldSpec[] = defs.map((d) => ({ key: d.key, label: d.label, type: d.type, required: d.required, ...(d.options ? { options: d.options } : {}) }));
  const validated = await validateFieldValues(specs, provided, { requireAll, entityLabel: 'product' });
  return Object.keys(validated).length ? validated : undefined;
}

function isFieldMap(v: unknown): v is Record<string, string | number | boolean> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => ['string', 'number', 'boolean'].includes(typeof x));
}

export async function __clearProductFieldDefs(): Promise<void> { await productFieldDefs.__clear(); }
