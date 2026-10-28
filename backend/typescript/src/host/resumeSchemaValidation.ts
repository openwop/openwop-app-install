/**
 * ADR 0932 (Book AI P6) — a declared `resumeSchema` is enforced on every
 * externally-supplied resume, whatever the interrupt kind.
 *
 * `spec/v2/core/interrupt.md`: "A host MUST validate the resume value against
 * `resumeSchema` when one is declared." `validateResumeValue` checked only the
 * approval `actions` list and the credential shape, so a `clarification` (or
 * `custom`, `low-confidence`, …) interrupt that declared a schema resumed with
 * any value at all, and the node had to defend itself.
 *
 * One validator for ONE schema class (the ADR 0547 D2 rule): resume schemas.
 * A schema that cannot COMPILE is refused as a validation error naming the
 * defect, never treated as "anything goes" — a permissive fallback is how a
 * broken declaration silently turns validation off for the life of the run.
 */
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { OpenwopError } from '../types.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
const cache = new Map<string, ValidateFunction | Error>();

function compiledResumeSchema(resumeSchema: unknown): ValidateFunction | undefined {
  if (resumeSchema === undefined) return undefined;
  if (resumeSchema === null || typeof resumeSchema !== 'object' || Array.isArray(resumeSchema)) {
    throw new OpenwopError('validation_error', 'A declared resumeSchema must be a schema object.', 400, { field: 'resumeSchema' });
  }
  const { $id: _dropId, ...body } = resumeSchema as Record<string, unknown>;
  const key = JSON.stringify(body);
  let v = cache.get(key);
  if (!v) {
    try { v = ajv.compile(body); } catch (err) { v = err instanceof Error ? err : new Error(String(err)); }
    if (cache.size > 500) cache.clear();
    cache.set(key, v);
  }
  if (v instanceof Error) {
    throw new OpenwopError('validation_error', `The interrupt's resumeSchema does not compile, so no resume value can be accepted: ${v.message.slice(0, 200)}`, 400, { field: 'resumeSchema' });
  }
  return v;
}

/** Runtime pack code is JavaScript: validate the declaration before storage can
 * coerce malformed scalars into an absent schema. The wire admits objects only. */
export function assertResumeSchemaDeclaration(resumeSchema: unknown): void {
  compiledResumeSchema(resumeSchema);
}

export function assertResumeMatchesSchema(resumeSchema: unknown, resumeValue: unknown): void {
  const v = compiledResumeSchema(resumeSchema);
  if (!v) return;
  if (!v(resumeValue)) {
    const errors = (v.errors ?? []).slice(0, 10).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`);
    throw new OpenwopError('validation_error', `resumeValue does not match the interrupt's resumeSchema: ${errors.join('; ')}`, 400, { field: 'resumeValue', errors });
  }
}
