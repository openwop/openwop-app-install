/**
 * ADR 1013 (RFC 0255 §E) — the rules for a form on a `clarification` interrupt,
 * and the one rule for a clarification's answers.
 *
 * `spec/v2/core/interrupt.md` §Forms: a host MUST NOT raise a form that fails
 * `interrupt-form.schema.json` or has an input `id` outside `questions[].id`.
 * The schema is what refuses a form asking for a secret. §Re-entry and resume
 * values: each answered `id` is a `questions[].id`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { locateRepoSchemasDir } from './_repoPath.js';
import { OpenwopError } from '../types.js';

const V2_INPUTS = new Set(['TextField', 'CheckBox', 'ChoicePicker', 'DateTimeInput']);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

let validator: ValidateFunction | undefined;
function formValidator(): ValidateFunction {
  if (validator) return validator;
  const dir = join(locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json'), 'v2');
  const schema = JSON.parse(readFileSync(join(dir, 'interrupt-form.schema.json'), 'utf8')) as Rec;
  validator = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  return validator;
}

function questionIds(data: Rec): string[] {
  if (!Array.isArray(data.questions)) return [];
  return data.questions.flatMap((q) => (isRec(q) && typeof q.id === 'string' ? [q.id] : []));
}

/** Every input `id` in a schema-valid form. */
function formInputIds(form: Rec): string[] {
  if (isRec(form.surface) && Array.isArray(form.surface.components)) {
    return form.surface.components.flatMap((c) =>
      isRec(c) && typeof c.component === 'string' && c.component.startsWith('field.') ? [String(c.id)] : [],
    );
  }
  const v2 = Array.isArray(form.surfaces) ? form.surfaces : [form];
  return v2.flatMap((s) => (isRec(s) && Array.isArray(s.messages) ? s.messages : [])).flatMap((m) => {
    const update = isRec(m) ? m.updateComponents : undefined;
    if (!isRec(update) || !Array.isArray(update.components)) return [];
    return update.components.flatMap((c) => (isRec(c) && V2_INPUTS.has(String(c.component)) ? [String(c.id)] : []));
  });
}

/** Why this clarification may not be raised with its form, or `null`. */
export function interruptFormDefect(data: unknown): string | null {
  if (!isRec(data) || data.form === undefined) return null;
  const validate = formValidator();
  if (!validate(data.form)) {
    const first = validate.errors?.[0];
    return `data.form fails interrupt-form.schema.json: ${first?.instancePath || '(root)'} ${first?.message ?? 'is invalid'}`;
  }
  const ids = questionIds(data);
  if (ids.length === 0) return 'data.form needs questions[] beside it as the fallback';
  const unbound = formInputIds(data.form as Rec).find((id) => !ids.includes(id));
  return unbound === undefined ? null : `form input ${JSON.stringify(unbound)} is not a questions[].id`;
}

/**
 * Refuse an answer to a question this interrupt did not raise. Applies only when
 * the interrupt stored `questions` and the value has an `answers` array: every
 * other resume value stays the node's to read.
 */
export function assertAnswersNameRaisedQuestions(interrupt: { kind: string; data: unknown }, resumeValue: unknown): void {
  if (interrupt.kind !== 'clarification' || !isRec(interrupt.data) || !isRec(resumeValue)) return;
  if (!Array.isArray(interrupt.data.questions) || !Array.isArray(resumeValue.answers)) return;
  const ids = questionIds(interrupt.data);
  for (const a of resumeValue.answers) {
    const id = isRec(a) ? a.id : undefined;
    if (typeof id !== 'string' || !ids.includes(id)) {
      throw new OpenwopError('validation_error', `resumeValue.answers names ${JSON.stringify(id)}, which is not a question this interrupt raised.`, 400, { field: 'resumeValue', received: id ?? null, allowed: ids });
    }
  }
}
