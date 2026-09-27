/**
 * The ONE schema→form engine (ADR 0197, re-homed by ADR 0331 §D4-B) — pure,
 * React-free derivation + validation over a JSON-Schema subset. Consumers:
 * the run-launch form (`runs/SchemaInputForm`), the public form renderer's
 * bridge (`features/forms/render/deriveFields`), and the builder's node-config
 * mapper (`builder/palette/configFieldsFromSchema`, scalar kind-inference
 * only — its string-list/hint vocabulary stays builder-local by design).
 * `runs/inputSchemaForm.ts` re-exports everything for existing import sites.
 */
export interface SchemaObject {
  type?: unknown;
  properties?: Record<string, SchemaProp>;
  required?: unknown;
}

export interface SchemaProp {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  default?: unknown;
  enum?: unknown;
  format?: unknown;
}

export type FieldKind = 'text' | 'number' | 'integer' | 'boolean' | 'enum' | 'date' | 'email' | 'uri' | 'json';

export interface DerivedField {
  name: string;
  kind: FieldKind;
  label: string;
  description?: string;
  required: boolean;
  /** Enum options (kind 'enum'). */
  options?: string[];
  /** Schema default, used to seed the initial value. */
  defaultValue?: unknown;
}

export interface FieldError {
  name: string;
  /** i18n key in the `runs` namespace + interpolation values. */
  // 'errTooLong' is emitted by the public-forms length mirror (deriveFields),
  // not by validateInputs itself — same i18n home (`runs:` ns, x4 locales).
  // 'errMin'/'errMax'/'errStep' are emitted by the public-forms constraint
  // mirror (deriveFields F9), not by validateInputs itself — same i18n home.
  key: 'errRequired' | 'errNumber' | 'errInteger' | 'errEnum' | 'errEmail' | 'errUri' | 'errJson' | 'errTooLong' | 'errMin' | 'errMax' | 'errStep';
  /** Optional interpolation values for the i18n message (e.g. the bound). */
  values?: Record<string, string | number>;
}

/** A schema is renderable when it is a plain `object` schema with at least
 *  one property. Anything else → the caller falls back to the raw editor. */
export function isRenderableSchema(schema: unknown): schema is SchemaObject {
  if (typeof schema !== 'object' || schema === null) return false;
  const s = schema as SchemaObject;
  if (s.type !== undefined && s.type !== 'object') return false;
  return typeof s.properties === 'object' && s.properties !== null && Object.keys(s.properties).length > 0;
}

function kindOf(p: SchemaProp): FieldKind {
  if (Array.isArray(p.enum) && p.enum.every((v) => typeof v === 'string') && p.enum.length > 0) return 'enum';
  switch (p.type) {
    case 'string':
      if (p.format === 'date') return 'date';
      if (p.format === 'email') return 'email';
      if (p.format === 'uri') return 'uri';
      return 'text';
    case 'number': return 'number';
    case 'integer': return 'integer';
    case 'boolean': return 'boolean';
    default:
      // object / array / union / missing type — degrade to a JSON sub-editor.
      return 'json';
  }
}

export function deriveFields(schema: SchemaObject): DerivedField[] {
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);
  return Object.entries(schema.properties ?? {}).map(([name, p]) => {
    const kind = kindOf(p);
    const f: DerivedField = {
      name,
      kind,
      label: typeof p.title === 'string' && p.title.trim() ? p.title : name,
      required: required.has(name),
      ...(typeof p.description === 'string' && p.description ? { description: p.description } : {}),
      ...(p.default !== undefined ? { defaultValue: p.default } : {}),
    };
    if (kind === 'enum') f.options = p.enum as string[];
    return f;
  });
}

/** Seed an inputs object from schema defaults (absent keys only). */
export function seedDefaults(fields: DerivedField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f.defaultValue !== undefined) out[f.name] = f.defaultValue;
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate a value object against the derived fields (v1 subset). A field
 *  left empty and not required is simply omitted from the payload — no error. */
export function validateInputs(fields: DerivedField[], value: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [];
  for (const f of fields) {
    const v = value[f.name];
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (f.required) errors.push({ name: f.name, key: 'errRequired' });
      continue;
    }
    switch (f.kind) {
      case 'number':
        if (typeof v !== 'number' || Number.isNaN(v)) errors.push({ name: f.name, key: 'errNumber' });
        break;
      case 'integer':
        if (typeof v !== 'number' || !Number.isInteger(v)) errors.push({ name: f.name, key: 'errInteger' });
        break;
      case 'enum':
        if (typeof v !== 'string' || !(f.options ?? []).includes(v)) errors.push({ name: f.name, key: 'errEnum' });
        break;
      case 'email':
        if (typeof v !== 'string' || !EMAIL_RE.test(v)) errors.push({ name: f.name, key: 'errEmail' });
        break;
      case 'uri':
        if (typeof v !== 'string' || !isUri(v)) errors.push({ name: f.name, key: 'errUri' });
        break;
      // text / date / boolean / json carry no further client checks in v1
      // (dates ride the native date input; json fields are parsed at edit time).
      default:
        break;
    }
  }
  return errors;
}

function isUri(v: string): boolean {
  try { new URL(v); return true; } catch { return false; }
}

/** Strip empty optional entries so the launch payload only carries real input. */
export function compactInputs(fields: DerivedField[], value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = value[f.name];
    if (v === undefined || v === null || v === '') continue;
    out[f.name] = v;
  }
  return out;
}

/** ADR 0331 §D4-B — the scalar kind-inference both schema→form mappers share:
 *  a scalar enum beats type; boolean → checkbox-ish; number/integer numeric.
 *  Callers refine non-scalar shapes (arrays/objects) in their own vocabulary. */
export function inferScalarKind(type: string | undefined, hasEnum: boolean): 'enum' | 'boolean' | 'number' | 'integer' | 'text' {
  if (hasEnum && type !== 'object' && type !== 'array') return 'enum';
  if (type === 'boolean') return 'boolean';
  if (type === 'number') return 'number';
  if (type === 'integer') return 'integer';
  return 'text';
}
