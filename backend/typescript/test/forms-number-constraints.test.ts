/**
 * UX_UPGRADE-forms ROUND 3 — F9 (deferred from R2 as "a model change"), on the
 * ADR 0516 `number` field type.
 *
 * Optional authored `min`/`max`/`step` on number fields, enforced at BOTH
 * levels the enumerate-the-class lesson demands: the AUTHORING sanitizer (a
 * constraint persists only on a number field; a nonsense constraint is a typed
 * 400, never silently stored) and the SUBMIT validator (out-of-bound values are
 * typed 400s naming the bound). The step check is epsilon-tolerant on both
 * sides: 0.3/0.1 is 2.9999999999999996 in floats, and rejecting an
 * exact-looking value over binary representation is the engine lying.
 *
 * Sabotage-witnessed (grade-tests w8, probes w8g1-nc-*): not persisting `min`, dropping
 * the `type === 'number'` gate, accepting `step: 0` or `min > max`, skipping the
 * min/max submit checks, a naive `ratio % 1` step check, or counting steps from 0
 * instead of `min` each turn a case red. Unit-level: only host-ext persistence is
 * needed (it used to boot `createApp` + listen for this).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createForm, validateValues, type FormDef } from '../src/features/forms/formsService.js';

const TENANT = 'org:forms-r3';
beforeAll(() => { initHostExtPersistence(openSqliteStorage(':memory:')); });

const mk = (fields: unknown): Promise<FormDef> =>
  createForm({ tenantId: TENANT, orgId: 'o1', title: 'T', fields, createdBy: 'u1' });

describe('F9 authoring — constraints persist only where they mean something', () => {
  it('persists min/max/step on a number field', async () => {
    const form = await mk([{ key: 'guests', label: 'Guests', type: 'number', required: true, min: 1, max: 20, step: 1 }]);
    expect(form.fields[0]).toMatchObject({ min: 1, max: 20, step: 1 });
  });

  it('DROPS constraints on non-number fields (the options-is-select-only posture)', async () => {
    const form = await mk([{ key: 'name', label: 'Name', type: 'text', required: false, min: 1, max: 5 }]);
    expect(form.fields[0]).not.toHaveProperty('min');
    expect(form.fields[0]).not.toHaveProperty('max');
  });

  it('rejects a non-positive step and an inverted range as typed 400s', async () => {
    await expect(mk([{ key: 'n', label: 'N', type: 'number', required: false, step: 0 }]))
      .rejects.toMatchObject({ code: 'validation_error' });
    await expect(mk([{ key: 'n', label: 'N', type: 'number', required: false, min: 10, max: 1 }]))
      .rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('F9 submit — bounds enforced, floats not lied about', () => {
  it('rejects below-min, above-max, and off-step with typed errors naming the field', async () => {
    const form = await mk([{ key: 'guests', label: 'Guests', type: 'number', required: true, min: 2, max: 10, step: 2 }]);
    expect(() => validateValues(form, { guests: '1' })).toThrowError(/at least 2/);
    expect(() => validateValues(form, { guests: '12' })).toThrowError(/at most 10/);
    expect(() => validateValues(form, { guests: '5' })).toThrowError(/steps of 2/);
    expect(validateValues(form, { guests: '6' })).toEqual({ guests: 6 });
  });

  it('accepts 0.3 with step 0.1 — the float-representation case (epsilon)', async () => {
    // (0.3 - 0) / 0.1 === 2.9999999999999996; a naive modulo/integer check
    // rejects a value the author plainly intended to allow.
    const form = await mk([{ key: 'kg', label: 'Kg', type: 'number', required: true, min: 0, step: 0.1 }]);
    expect(validateValues(form, { kg: '0.3' })).toEqual({ kg: 0.3 });
    expect(() => validateValues(form, { kg: '0.35' })).toThrowError(/steps of 0.1/);
  });

  it('a number field WITHOUT constraints behaves exactly as before (the negative control)', async () => {
    const form = await mk([{ key: 'n', label: 'N', type: 'number', required: true }]);
    expect(validateValues(form, { n: '-999999' })).toEqual({ n: -999999 });
  });

  it('step counts from min when authored', async () => {
    const form = await mk([{ key: 'n', label: 'N', type: 'number', required: true, min: 1, step: 2 }]);
    expect(validateValues(form, { n: '5' })).toEqual({ n: 5 }); // 1,3,5…
    expect(() => validateValues(form, { n: '4' })).toThrowError(/steps of 2 from 1/);
  });
});
