// ADR 0257 — the shared custom-field seam (host layer, so multiple features can consume it
// without importing each other, ADR 0001). It owns the reusable, ENTITY-AGNOSTIC parts of a
// typed custom-field system: the field types, enum-option cleaning, field-def SHAPE
// validation, and the per-value validation loop. It owns NO storage and NO scoping — each
// consuming feature keeps its own DurableCollection + scope rules + reference resolvers
// (injected here, never imported — a host module must not depend up into a feature).
//
// Semantics are lifted from the CRM field-def logic (features/crm/entities/fieldDefs.ts,
// ADR 0213), with two deliberate hardenings: the date check is strict (rejects rollover dates
// like 2023-02-30), and string values go through host `cleanString` (secret-shape scrub) since
// they're publicly served. CRM adopting this seam in place of its inline copy is a
// (near-)behavior-preserving follow-on (kept off this PR to protect core CRM).

import { OpenwopError } from '../../types.js';
import { cleanString } from '../boundedStrings.js';

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'reference' | 'media';
export const FIELD_TYPES: FieldType[] = ['string', 'number', 'boolean', 'date', 'enum', 'reference', 'media'];

/** Narrowing guard for consumers that pin the BUILT-IN vocabulary (CRM /
 *  commerce — extension kinds never reach them; ADR 0408 D2). */
export function isBuiltinFieldType(t: string): t is FieldType {
  return (FIELD_TYPES as string[]).includes(t);
}

const MAX_ENUM_OPTIONS = 24;
const MAX_ENUM_OPTION_LEN = 80;
const MAX_LABEL = 120;
const MAX_STRING_VALUE = 120;
// ADR 0386 Phase 2 — a `media` field stores a Media TOKEN (ADR 0007; a ref,
// never bytes). Tokens are opaque ids, longer than display strings.
const MAX_MEDIA_TOKEN = 300;

/** A field definition as far as VALIDATION is concerned — storage/scoping ids are the
 *  consuming feature's concern and aren't needed here. */
export interface FieldSpec {
  key: string;
  label: string;
  /** A built-in kind, or (ADR 0408 D2) a REGISTERED extension kind — only
   *  representable when the consumer opted in via `allowExtensionKinds`. */
  type: FieldType | (string & Record<never, never>);
  required: boolean;
  options?: string[];        // enum only
  refEntityType?: string;    // reference only — the target entity, resolved by the injected resolver
  /** ADR 0406 — the field's value may carry per-locale overlays. `string`
   *  fields only (text is what translates); other kinds reject the flag.
   *  Consumers that don't localize simply never read it (CRM/commerce). */
  localizable?: boolean;
}

// ── Field-kind validator registry (ADR 0408 D2) ─────────────────────────────
//
// The seam's pluggable-kind inversion: a FEATURE registers a validator for an
// extension kind (features import core, never the reverse — the
// submission-sink/configDomain pattern). Registered kinds are NOT
// automatically authoring-visible: `FieldType`/`FIELD_TYPES` stay the closed
// built-in vocabulary, and each consumer decides (closed-world) which
// extension kinds it accepts — the cms `blocks` kind arrives with the
// ADR 0408 Phase C storage wiring. Built-in kinds cannot be overridden.

export interface FieldKindValidator {
  /** Validate + normalize one value of this kind. Throw OpenwopError on bad input. */
  validate: (value: unknown, spec: FieldSpec) => unknown | Promise<unknown>;
  /** Optional kind-internal locale resolution (ADR 0406 "one localization
   *  model, kind-scoped depth") — e.g. blocks resolve their own per-section
   *  overlays. Pure; never throws. */
  resolveLocale?: (value: unknown, locale: string, baseLocale: string) => unknown;
}

const fieldKindRegistry = new Map<string, FieldKindValidator>();

export function registerFieldKindValidator(kind: string, validator: FieldKindValidator): void {
  if ((FIELD_TYPES as string[]).includes(kind)) {
    throw new Error(`field kind '${kind}' is built-in and cannot be overridden`);
  }
  if (fieldKindRegistry.has(kind)) {
    throw new Error(`field kind '${kind}' is already registered`);
  }
  fieldKindRegistry.set(kind, validator);
}

export function getFieldKindValidator(kind: string): FieldKindValidator | undefined {
  return fieldKindRegistry.get(kind);
}

/** Test-only: unregister an extension kind (mirrors the registry inversions'
 *  test seams; production code never calls this). */
export function __unregisterFieldKindValidator(kind: string): void {
  fieldKindRegistry.delete(kind);
}

// `cleanString` (host/boundedStrings) trims, caps, AND scrubs secret-shaped blobs — the last
// matters because product string values are served on the PUBLIC storefront (parity with the
// CRM field-def validator; the seam must not weaken that scrub).
const cleanStr = cleanString;
/** Strict YYYY-MM-DD (a real calendar date). */
function isStrictDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** A bounded, deduped `enum` option list (1..24 non-empty strings). */
export function cleanEnumOptions(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ENUM_OPTIONS) {
    throw new OpenwopError('validation_error', `\`options\` must be an array of 1..${MAX_ENUM_OPTIONS} strings for an enum field.`, 400, { field: 'options' });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of raw) {
    const v = cleanStr(o, MAX_ENUM_OPTION_LEN);
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  if (out.length < 1) throw new OpenwopError('validation_error', '`options` must contain at least 1 non-empty string.', 400, { field: 'options' });
  return out;
}

/** Validate + normalize a field-def SHAPE (key/label/type/required/options/refEntityType).
 *  `allowedRefEntities` names the entity types a `reference` field may target (empty ⇒ the
 *  feature has no references, and `reference` is rejected). Returns the clean spec; the
 *  caller adds ids/scoping and persists. */
export function buildFieldSpec(input: {
  key: unknown; label: unknown; type: unknown; required?: unknown; options?: unknown; refEntityType?: unknown; localizable?: unknown;
}, allowedRefEntities: string[] = [], opts?: {
  /** ADR 0408 D2 — extension kinds this CALLER accepts (each must be
   *  registered). User-facing authoring paths never pass this; the system-type
   *  mint does. Absent ⇒ built-ins only (closed-world unchanged). */
  allowExtensionKinds?: string[];
}): FieldSpec {
  const key = cleanStr(input.key, 60).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!key) throw new OpenwopError('validation_error', 'Field `key` is required.', 400, { field: 'key' });
  const isExtension =
    typeof input.type === 'string'
    && (opts?.allowExtensionKinds ?? []).includes(input.type)
    && fieldKindRegistry.has(input.type);
  if (!isExtension && (typeof input.type !== 'string' || !FIELD_TYPES.includes(input.type as FieldType))) {
    throw new OpenwopError('validation_error', `type must be one of: ${FIELD_TYPES.join(', ')}`, 400, { field: 'type' });
  }
  const type = input.type as FieldType;
  const spec: FieldSpec = { key, label: cleanStr(input.label, MAX_LABEL, key), type, required: input.required === true };
  if (input.localizable !== undefined) {
    if (input.localizable !== true && input.localizable !== false) {
      throw new OpenwopError('validation_error', '`localizable` must be a boolean.', 400, { field: 'localizable' });
    }
    if (input.localizable && type !== 'string') {
      throw new OpenwopError('validation_error', '`localizable` is only valid for a `string` field (text is what translates).', 400, { field: 'localizable', type });
    }
    if (input.localizable) spec.localizable = true;
  }
  if (type === 'enum') spec.options = cleanEnumOptions(input.options);
  else if (input.options !== undefined) throw new OpenwopError('validation_error', '`options` is only valid for an `enum` field.', 400, { field: 'options' });
  if (type === 'reference') {
    if (typeof input.refEntityType !== 'string' || !allowedRefEntities.includes(input.refEntityType)) {
      throw new OpenwopError('validation_error', allowedRefEntities.length ? `refEntityType must be one of: ${allowedRefEntities.join(', ')}` : 'reference fields are not supported here.', 400, { field: 'refEntityType' });
    }
    spec.refEntityType = input.refEntityType;
  } else if (input.refEntityType !== undefined) {
    throw new OpenwopError('validation_error', '`refEntityType` is only valid for a `reference` field.', 400, { field: 'refEntityType' });
  }
  return spec;
}

/** Validate a `customFields` map against a set of field defs: every provided key MUST be
 *  defined + type-correct; on `requireAll` (create) every required def must be present.
 *  Returns the validated map (defined keys only) — unknown keys are REJECTED, not dropped.
 *  `resolveReference(refEntityType, id)` is injected for the `reference` field type. */
export async function validateFieldValues(
  defs: FieldSpec[],
  provided: Record<string, unknown>,
  opts: { requireAll: boolean; entityLabel: string; resolveReference?: (refEntityType: string, id: string) => Promise<boolean> },
): Promise<Record<string, string | number | boolean>> {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(provided)) {
    const def = byKey.get(key);
    if (!def) throw new OpenwopError('validation_error', `Unknown custom field \`${key}\` for ${opts.entityLabel}.`, 400, { key });
    if (def.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new OpenwopError('validation_error', `Custom field \`${key}\` must be a number.`, 400, { key });
      out[key] = value;
    } else if (def.type === 'boolean') {
      if (typeof value !== 'boolean') throw new OpenwopError('validation_error', `Custom field \`${key}\` must be a boolean.`, 400, { key });
      out[key] = value;
    } else if (def.type === 'date') {
      if (typeof value !== 'string' || !isStrictDate(value)) throw new OpenwopError('validation_error', `Custom field \`${key}\` must be a YYYY-MM-DD date.`, 400, { key });
      out[key] = value;
    } else if (def.type === 'enum') {
      if (typeof value !== 'string' || !(def.options ?? []).includes(value)) {
        throw new OpenwopError('validation_error', `Custom field \`${key}\` must be one of: ${(def.options ?? []).join(', ')}.`, 400, { key, options: def.options ?? [] });
      }
      out[key] = value;
    } else if (def.type === 'media') {
      // A media token: opaque bounded string (existence/ownership resolution is
      // the consuming feature's concern — same posture as `reference` without a
      // resolver: the token is validated for shape, never dereferenced here).
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_MEDIA_TOKEN) {
        throw new OpenwopError('validation_error', `Custom field \`${key}\` must be a media token.`, 400, { key });
      }
      out[key] = value.trim();
    } else if (def.type === 'reference') {
      if (typeof value !== 'string' || value.length === 0) throw new OpenwopError('validation_error', `Custom field \`${key}\` must be a reference id.`, 400, { key });
      const ok = opts.resolveReference ? await opts.resolveReference(def.refEntityType ?? '', value) : false;
      if (!ok) throw new OpenwopError('validation_error', `Custom field \`${key}\` references a ${def.refEntityType} that does not exist.`, 400, { key, refEntityType: def.refEntityType });
      out[key] = value;
    } else {
      out[key] = cleanStr(value, MAX_STRING_VALUE);
    }
  }
  if (opts.requireAll) {
    for (const def of defs) {
      if (def.required && !(def.key in out)) throw new OpenwopError('validation_error', `Custom field \`${def.key}\` is required.`, 400, { key: def.key });
    }
  }
  return out;
}
