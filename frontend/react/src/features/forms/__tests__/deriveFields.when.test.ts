/**
 * ADR 0808 — the public renderer's `when` evaluator agrees with the server's,
 * case for case. The table is shared with the backend's
 * `adr0808-form-conditional-visibility.test.ts`; see `whenCases.json`.
 * (`c.when as FieldWhen` narrows the JSON import's widened type — the shared
 * JSON table is the point, so that one cast is the honest ceiling.)
 * Sabotages that redden it (grade-tests wave 8): `==` for `equals`, not
 * stripping `fields.`, judging on raw values instead of VISIBLE ones, a
 * permissive `contains`, a presence-only `truthy`.
 */
import { describe, expect, it } from 'vitest';
import { visibleFields, type FieldWhen } from '../render/deriveFields.js';
import table from '../render/whenCases.json';

describe('ADR 0808 — visibleFields', () => {
  it.each(table.cases)('$when.type on $a → shown=$shown', (c) => {
    const fields = [{ key: 'a' }, { key: 'b', when: c.when as FieldWhen }];
    const values = c.a === null ? {} : { a: c.a };
    expect(visibleFields(fields, values).some((f) => f.key === 'b')).toBe(c.shown);
  });

  it('a hidden controller hides its dependents', () => {
    const fields: Array<{ key: string; when?: FieldWhen }> = [
      { key: 'shipping' },
      { key: 'region', when: { type: 'equals', left: 'fields.shipping', right: 'international' } },
      { key: 'postcode', when: { type: 'truthy', left: 'fields.region' } },
    ];
    expect(visibleFields(fields, { shipping: 'domestic', region: 'EU' }).map((f) => f.key)).toEqual(['shipping']);
    expect(visibleFields(fields, { shipping: 'international', region: 'EU' }).map((f) => f.key)).toEqual(['shipping', 'region', 'postcode']);
  });
});
