/**
 * ADR 0331 §D4-A — the renderer-convergence bridge: maps the public form
 * render schema (`FormField`, the forms feature's five-type authoring union)
 * onto the ADR 0197 `DerivedField` shape so client validation reuses the ONE
 * `validateInputs` engine (`runs/inputSchemaForm.ts`) instead of growing a
 * third. Adaptation (recorded in the ADR): `textarea` has no `FieldKind`, so
 * it validates as `text` and only the RENDERER distinguishes the control;
 * `select` maps to `enum`, `checkbox` to `boolean`. Error keys returned by
 * the engine live in the `runs` i18n namespace (`errRequired`, `errEmail`,
 * `errEnum`) — the public renderer translates them from there.
 */

import { validateInputs, type DerivedField, type FieldError } from '../../../lib/formEngine.js';

/** The public render schema's field shape (`GET /public-forms/:formId`). */
export interface PublicFormField {
  key: string;
  label: string;
  type: 'text' | 'email' | 'number' | 'textarea' | 'select' | 'checkbox';
  required: boolean;
  options?: string[];
  /** UX_UPGRADE-forms F-G1 — optional per-field help text (authored in the
   *  builder, rendered under the control via `ui/Field`'s `help`). */
  description?: string;
  /** F9 — number-only authored constraints (mirrors `formsService.FormField`). */
  min?: number;
  max?: number;
  step?: number;
}

// `number` maps to the engine's EXISTING `number` FieldKind (`formEngine.ts:25`)
// — no new validation machinery, the same reuse this bridge exists for.
const KIND_BY_TYPE = { text: 'text', email: 'email', number: 'number', textarea: 'text', select: 'enum', checkbox: 'boolean' } as const;

export function toDerivedFields(fields: PublicFormField[]): DerivedField[] {
  return fields.map((f) => ({
    name: f.key,
    kind: KIND_BY_TYPE[f.type],
    label: f.label,
    required: f.required,
    ...(f.type === 'select' ? { options: f.options ?? [] } : {}),
  }));
}

/** Client-side validation mirroring the server's `validateValues` semantics,
 *  through the shared ADR 0197 engine. */
/**
 * F1 (round 2 BLOCKER) — the renderer stores every text-shaped input as a
 * STRING (the server wire demands strings and coerces server-side,
 * `formsService.validateValues`), but the engine's `number` kind judges
 * `typeof v === 'number'`. Without this bridge a filled number field ALWAYS
 * failed "Enter a number" and the form could never be submitted. Coerce a
 * numeric string to its number FOR JUDGEMENT ONLY — the submitted wire value
 * stays the string the server demands; a non-numeric string passes through
 * and fails honestly.
 */
function engineValues(fields: PublicFormField[], values: Record<string, unknown>): Record<string, unknown> {
  let out = values;
  for (const f of fields) {
    if (f.type !== 'number') continue;
    const v = values[f.key];
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) {
        if (out === values) out = { ...values };
        out[f.key] = n;
      }
    }
  }
  return out;
}

/** R2 F3 — mirror the server's per-field length cap (formsService MAX_FIELD_LEN
 *  5000) so an over-long answer is named AT THE FIELD instead of surfacing as a
 *  generic 400 after submit that retrying can never fix. */
const MAX_FIELD_LEN = 5000;

function lengthErrors(fields: PublicFormField[], values: Record<string, unknown>): FieldError[] {
  const out: FieldError[] = [];
  for (const f of fields) {
    const v = values[f.key];
    if (typeof v === 'string' && v.length > MAX_FIELD_LEN) out.push({ name: f.key, key: 'errTooLong' });
  }
  return out;
}

/** F9 — the client mirror of the server's number constraints, in the same
 *  local layer as `lengthErrors` (the engine has no range kinds, and its other
 *  consumers don't want them — extending it here keeps the seam forms-local).
 *  Same epsilon-tolerant step check as the server: floats make 0.3/0.1 into
 *  2.9999…96, and rejecting an exact-looking value over binary representation
 *  would be the client lying about what the server will accept. */
function constraintErrors(fields: PublicFormField[], values: Record<string, unknown>): FieldError[] {
  const out: FieldError[] = [];
  for (const f of fields) {
    if (f.type !== 'number') continue;
    const v = values[f.key];
    if (typeof v !== 'string' || v.trim() === '') continue;
    const num = Number(v);
    if (!Number.isFinite(num)) continue; // the engine's errNumber already owns this
    if (f.min !== undefined && num < f.min) { out.push({ name: f.key, key: 'errMin', values: { min: f.min } }); continue; }
    if (f.max !== undefined && num > f.max) { out.push({ name: f.key, key: 'errMax', values: { max: f.max } }); continue; }
    if (f.step !== undefined) {
      const base = f.min ?? 0;
      const ratio = (num - base) / f.step;
      if (Math.abs(Math.round(ratio) - ratio) > 1e-9) out.push({ name: f.key, key: 'errStep', values: { step: f.step } });
    }
  }
  return out;
}

/** R2 F4 — a required checkbox must be TRUE (consent semantics): the engine
 *  treats `false` as a present value, so check-then-uncheck satisfied
 *  "required". Mirrors the server rule exactly. */
function consentErrors(fields: PublicFormField[], values: Record<string, unknown>): FieldError[] {
  return fields
    .filter((f) => f.type === 'checkbox' && f.required && values[f.key] === false)
    .map((f) => ({ name: f.key, key: 'errRequired' as const }));
}

export function validatePublicValues(fields: PublicFormField[], values: Record<string, unknown>): FieldError[] {
  const engine = validateInputs(toDerivedFields(fields), engineValues(fields, values));
  const extras = [...lengthErrors(fields, values), ...consentErrors(fields, values), ...constraintErrors(fields, values)];
  const flagged = new Set(engine.map((e) => e.name));
  return [...engine, ...extras.filter((e) => !flagged.has(e.name))];
}

/**
 * UX_UPGRADE-forms F-G2 — validate ONE field, for the on-blur pass. Runs the
 * same engine over a single-field slice, so inline feedback can never disagree
 * with what submit will say (a second, looser client rule is how "it looked
 * fine until I pressed submit" happens).
 */
export function validatePublicField(
  fields: PublicFormField[],
  key: string,
  values: Record<string, unknown>,
): FieldError | undefined {
  const field = fields.find((f) => f.key === key);
  if (!field) return undefined;
  const one = { [key]: values[key] };
  return validateInputs(toDerivedFields([field]), engineValues([field], one))[0]
    ?? lengthErrors([field], one)[0]
    ?? consentErrors([field], one)[0]
    ?? constraintErrors([field], one)[0];
}
