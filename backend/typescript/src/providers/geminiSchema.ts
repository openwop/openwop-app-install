/**
 * Gemini function-declaration schema projection — ONE converter for every Gemini
 * egress: generateContent tool rounds, the Gemini Live auth-token constraint, and the
 * Live client `setup` message (which the host hands the SPA pre-projected).
 *
 * Gemini's `FunctionDeclaration.parameters` is an OpenAPI-subset `Schema`, not JSON
 * Schema. Unknown KEYWORDS are rejected by name (`Unknown name "additionalProperties"`);
 * invalid VALUES are rejected too, and on the Live WebSocket those surface only as a
 * generic close `1007: Request contains an invalid argument.` (no field path). The
 * value classes this projection NORMALISES (each is unambiguous — the output is what the
 * schema meant, in Gemini's vocabulary):
 *
 *  - `type` arrays (`['string','null']`) and nullable `anyOf`/`oneOf` pairs → type + nullable;
 *  - `format` values Gemini does not support for the type → stripped;
 *  - `enum` with non-string members or on a non-string type → stripped;
 *  - `required` naming a property not in `properties` → filtered;
 *  - `minItems`/`maxItems` off an array → stripped.
 *
 * One class it does NOT rewrite: a FREE-FORM member — an OBJECT with no `properties`,
 * an untyped `{}`, an ARRAY with no `items`. There is no faithful Gemini spelling for
 * "any object", and dropping the member would silently strip a required argument from
 * tools that depend on it (the `*.render` tools' payloads). Those pass through as before
 * and are REPORTED by `geminiFreeFormPaths`, so `test/gemini-live-setup-schema.test.ts`
 * holds them to a no-growth ratchet and keeps the default-on baseline free of them —
 * Gemini has historically rejected an OBJECT without properties
 * (`properties: should be non-empty for OBJECT type`). Pure.
 */

/** Keywords Gemini's FunctionDeclaration parameter schema accepts (an OpenAPI
 *  subset). Everything else (`additionalProperties`, `minLength`, `minimum`,
 *  `$schema`, `anyOf`, …) is dropped — Gemini rejects the whole request otherwise. */
export const GEMINI_SCHEMA_KEYS: ReadonlySet<string> = new Set(['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'minItems', 'maxItems']);

const GEMINI_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

/** `format` values Gemini accepts, per (lower-cased) type. Anything else is stripped. */
const GEMINI_FORMATS: Readonly<Record<string, readonly string[]>> = {
  string: ['enum', 'date-time'],
  number: ['float', 'double'],
  integer: ['int32', 'int64'],
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** Collapse `type: ['x','null']` and `anyOf|oneOf: [X, {type:'null'}]` to X + nullable. */
function collapseNullable(schema: Json): Json {
  let s = schema;
  if (Array.isArray(s.type)) {
    const types = (s.type as unknown[]).filter((t): t is string => typeof t === 'string');
    const nonNull = types.filter((t) => t !== 'null');
    const { type: _t, ...rest } = s;
    void _t;
    s = { ...rest, ...(nonNull.length === 1 ? { type: nonNull[0] } : {}), ...(types.includes('null') ? { nullable: true } : {}) };
  }
  if (s.type === undefined) {
    for (const k of ['anyOf', 'oneOf'] as const) {
      const alts = s[k];
      if (!Array.isArray(alts)) continue;
      const nonNull = alts.filter((a) => !(isObj(a) && a.type === 'null'));
      if (nonNull.length === 1 && isObj(nonNull[0]) && nonNull.length < alts.length) {
        const { [k]: _drop, ...rest } = s;
        void _drop;
        return collapseNullable({ ...nonNull[0], ...rest, nullable: true });
      }
    }
  }
  return s;
}

/** Recursively project a JSON Schema onto Gemini's accepted subset. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!isObj(schema)) return schema;
  const s = collapseNullable(schema);
  const t = typeof s.type === 'string' ? s.type.toLowerCase() : undefined;
  const out: Json = {};
  for (const [k, v] of Object.entries(s)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue; // drop additionalProperties / minLength / $schema / …
    if (k === 'properties') {
      if (isObj(v)) out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === 'items') {
      out.items = toGeminiSchema(v);
    } else if (k === 'format') {
      if (typeof v === 'string' && t && (GEMINI_FORMATS[t] ?? []).includes(v)) out.format = v;
    } else if (k === 'enum') {
      if (t === 'string' && Array.isArray(v) && v.length > 0 && v.every((e) => typeof e === 'string')) out.enum = v;
    } else if (k === 'minItems' || k === 'maxItems') {
      if (t === 'array') out[k] = v;
    } else if (k === 'nullable') {
      if (typeof v === 'boolean') out.nullable = v;
    } else {
      out[k] = v;
    }
  }
  if (Array.isArray(out.required)) {
    const props = isObj(out.properties) ? out.properties : {};
    const required = [...new Set((out.required as unknown[]).filter((r): r is string => typeof r === 'string' && r in props))];
    if (required.length > 0) out.required = required; else delete out.required;
  }
  return out;
}

/** One Gemini `FunctionDeclaration` (the shape every Gemini egress sends). */
export function toGeminiFunctionDeclaration(tool: { name: string; description?: string; parameters: unknown }): { name: string; description: string; parameters: Record<string, unknown> } {
  return { name: tool.name, description: tool.description ?? '', parameters: toGeminiSchema(tool.parameters ?? { type: 'object' }) as Record<string, unknown> };
}

const FREE_FORM = 'free-form';

/**
 * Validate a (projected) Gemini `Schema` against the documented constraints. Returns
 * violations (empty ⇔ valid). Conservative on purpose: it encodes what this host may
 * SEND, which is narrower than everything Gemini might accept. A FREE-FORM member
 * (OBJECT without properties below the root, untyped, ARRAY without items) is a
 * violation tagged `free-form`; `allowFreeForm` skips those (the ratchet reads them
 * separately via `geminiFreeFormPaths`).
 */
export function geminiSchemaViolations(schema: unknown, opts: { allowFreeForm?: boolean; path?: string } = {}): string[] {
  const out: string[] = [];
  const root = opts.path ?? 'parameters';
  const freeForm = (p: string, why: string): void => { if (!opts.allowFreeForm) out.push(`${p}: ${FREE_FORM} — ${why}`); };
  const walk = (s: unknown, p: string): void => {
    if (!isObj(s)) { out.push(`${p}: not a schema object`); return; }
    for (const k of Object.keys(s)) if (!GEMINI_SCHEMA_KEYS.has(k)) out.push(`${p}.${k}: keyword not in the Gemini Schema subset`);
    if (s.type === undefined) { freeForm(p, 'type must be specified'); return; }
    if (typeof s.type !== 'string' || !GEMINI_TYPES.has(s.type.toLowerCase())) { out.push(`${p}.type: must be one of ${[...GEMINI_TYPES].join('|')} (got ${JSON.stringify(s.type)})`); return; }
    const t = s.type.toLowerCase();
    if (s.format !== undefined && !(GEMINI_FORMATS[t] ?? []).includes(s.format as string)) out.push(`${p}.format: ${JSON.stringify(s.format)} unsupported for ${t}`);
    if (s.enum !== undefined && (t !== 'string' || !Array.isArray(s.enum) || s.enum.length === 0 || s.enum.some((e) => typeof e !== 'string'))) out.push(`${p}.enum: must be a non-empty string array on a string`);
    if (s.nullable !== undefined && typeof s.nullable !== 'boolean') out.push(`${p}.nullable: must be boolean`);
    if ((s.minItems !== undefined || s.maxItems !== undefined) && t !== 'array') out.push(`${p}: minItems/maxItems only on array`);
    if (t === 'array') { if (s.items === undefined) freeForm(p, 'array needs items'); else walk(s.items, `${p}.items`); }
    else if (s.items !== undefined) out.push(`${p}.items: only on array`);
    if (t === 'object') {
      const props = isObj(s.properties) ? s.properties : undefined;
      if (!props || Object.keys(props).length === 0) { if (p !== root) freeForm(p, 'properties should be non-empty for OBJECT type'); }
      else for (const [k, c] of Object.entries(props)) walk(c, `${p}.properties.${k}`);
    } else if (s.properties !== undefined) out.push(`${p}.properties: only on object`);
    if (s.required !== undefined) {
      if (!Array.isArray(s.required)) out.push(`${p}.required: must be an array`);
      else for (const r of s.required) if (!isObj(s.properties) || typeof r !== 'string' || !(r in s.properties)) out.push(`${p}.required: ${JSON.stringify(r)} is not a declared property`);
    }
  };
  walk(schema, root);
  return out;
}

/** The free-form member paths of a (projected) schema — the ratchet's input. */
export function geminiFreeFormPaths(schema: unknown): string[] {
  return geminiSchemaViolations(schema, { path: '' })
    .filter((v) => v.includes(`: ${FREE_FORM} — `))
    .map((v) => v.slice(0, v.indexOf(':')));
}

/** Validate a whole function declaration (name rule + parameters). */
export function geminiFunctionDeclarationViolations(decl: { name?: unknown; description?: unknown; parameters?: unknown }, opts: { allowFreeForm?: boolean } = {}): string[] {
  const out: string[] = [];
  const name = decl.name;
  if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$/.test(name)) out.push(`name: ${JSON.stringify(name)} must start with a letter/underscore, use [a-zA-Z0-9_.:-], ≤ 64 chars`);
  if (decl.description !== undefined && typeof decl.description !== 'string') out.push('description: must be a string');
  if (decl.parameters !== undefined) out.push(...geminiSchemaViolations(decl.parameters, opts));
  return out;
}
