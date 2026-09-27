/**
 * ADR 0331 §D4-A — the renderer-convergence bridge: FormField → DerivedField
 * mapping feeds the ONE ADR 0197 validation engine. Pins the kind mapping
 * (textarea validates as text — the recorded adaptation), required/email/enum
 * semantics matching the server's `validateValues`, and checkbox tolerance.
 */
import { describe, it, expect } from 'vitest';
import { toDerivedFields, validatePublicValues, validatePublicField, type PublicFormField } from '../render/deriveFields.js';

const FIELDS: PublicFormField[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
  { key: 'bio', label: 'Bio', type: 'textarea', required: false },
  { key: 'topic', label: 'Topic', type: 'select', required: true, options: ['A', 'B'] },
  { key: 'agree', label: 'Agree', type: 'checkbox', required: false },
];

describe('toDerivedFields', () => {
  it('maps the five authoring types onto the ADR 0197 kinds (textarea → text)', () => {
    const kinds = Object.fromEntries(toDerivedFields(FIELDS).map((f) => [f.name, f.kind]));
    expect(kinds).toEqual({ name: 'text', email: 'email', bio: 'text', topic: 'enum', agree: 'boolean' });
  });
});

describe('validatePublicValues', () => {
  it('passes a valid submission', () => {
    expect(validatePublicValues(FIELDS, { name: 'A', email: 'a@x.com', topic: 'A', agree: true })).toEqual([]);
  });

  it('flags missing required, bad email, and off-options enum', () => {
    const errs = validatePublicValues(FIELDS, { email: 'nope', topic: 'C' });
    const byName = Object.fromEntries(errs.map((e) => [e.name, e.key]));
    expect(byName.name).toBe('errRequired');
    expect(byName.email).toBe('errEmail');
    expect(byName.topic).toBe('errEnum');
  });
});

describe('F9 (round 3) — the client constraint mirror', () => {
  const numField = (extra: Record<string, unknown> = {}) =>
    [{ key: 'n', label: 'N', type: 'number' as const, required: true, ...extra }];

  it('mirrors min/max/step with the bound in the message values', () => {
    expect(validatePublicValues(numField({ min: 2 }), { n: '1' })).toEqual([{ name: 'n', key: 'errMin', values: { min: 2 } }]);
    expect(validatePublicValues(numField({ max: 10 }), { n: '11' })).toEqual([{ name: 'n', key: 'errMax', values: { max: 10 } }]);
    expect(validatePublicValues(numField({ step: 2, min: 0 }), { n: '3' })).toEqual([{ name: 'n', key: 'errStep', values: { step: 2 } }]);
  });

  it('accepts the float-representation case the server accepts (0.3 @ step 0.1)', () => {
    // Client and server MUST agree here, or the client blocks a submit the
    // server would take — the retry-futility honesty rule in reverse.
    expect(validatePublicValues(numField({ min: 0, step: 0.1 }), { n: '0.3' })).toEqual([]);
  });

  it('an unconstrained number field never gains a constraint error (negative control)', () => {
    expect(validatePublicValues(numField(), { n: '-999999' })).toEqual([]);
  });

  it('per-field revalidation carries the same mirror (the touched-field path)', () => {
    expect(validatePublicField(numField({ min: 5 }), 'n', { n: '2' })).toMatchObject({ key: 'errMin' });
  });
});
