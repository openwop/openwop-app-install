/**
 * ADR 0729 D2 — a declared `format` is enforced at the run-input gate.
 *
 * Before this, the client rendered a localized "not a valid email" beside the field and
 * the gate accepted the value anyway (`validateFormats: false`), so the product told the
 * user a value was wrong and then ran with it.
 *
 * The third leg is the one that made D2 safe to ship: an UNKNOWN format must be IGNORED,
 * not thrown. A throw would hit `validateRunInputs`' fail-open catch and drop validation
 * ENTIRELY for that schema — D2 weakening the guard instead of tightening it.
 */
import { describe, expect, it } from 'vitest';
import { validateRunInputs } from '../src/host/runInputValidation.js';

const emailSchema = { type: 'object', properties: { to: { type: 'string', format: 'email' } }, required: ['to'] };

describe('ADR 0729 D2 — declared formats are enforced', () => {
  it('BORN RED: a bad email against `format: email` is now an error (it validated before)', () => {
    const errs = validateRunInputs(emailSchema, { to: 'not-an-email' });
    expect(errs, 'a declared format is a contract the author asked for').not.toBeNull();
    expect(errs!.length).toBeGreaterThan(0);
    expect(errs![0]!.path).toBe('/to');
  });

  it('a well-formed value still passes', () => {
    expect(validateRunInputs(emailSchema, { to: 'ops@example.com' })).toBeNull();
  });

  it('an UNKNOWN format is IGNORED, never thrown — a throw would fail-open and drop the WHOLE guard', () => {
    const schema = {
      type: 'object',
      properties: { sku: { type: 'string', format: 'sku-v2' }, n: { type: 'number' } },
      required: ['n'],
    };
    // The unknown format does not disqualify the schema…
    expect(validateRunInputs(schema, { sku: 'anything', n: 1 })).toBeNull();
    // …and the REST of the schema is still enforced, which is what proves the guard
    // survived rather than being silently dropped.
    const errs = validateRunInputs(schema, { sku: 'anything', n: 'not-a-number' });
    expect(errs, 'the rest of the schema must still bite').not.toBeNull();
    expect(errs!.some((e) => e.path === '/n')).toBe(true);
  });

  it('a schema declaring NO format behaves exactly as before (the shipped population)', () => {
    const plain = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    expect(validateRunInputs(plain, { name: 'ok' })).toBeNull();
    expect(validateRunInputs(plain, {})).not.toBeNull();
  });

  it('still fails OPEN on an uncompilable schema (ADR 0197 courtesy preserved)', () => {
    expect(validateRunInputs({ type: 'object', properties: { x: { type: 'not-a-type' } } }, { x: 1 })).toBeNull();
  });
});
