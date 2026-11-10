/**
 * ADR 0951 D2 — a form field's `sensitivity` (`payment` | `health` |
 * `credential`) is authored, closed-vocabulary and persisted, so the public
 * renderer can stamp it as `data-owx-sensitivity` and session recording refuses
 * the page (`frontend/.../site/replayCapture.ts` NEVER_RECORD_SELECTOR).
 *
 * Red when: the sanitizer drops the field, or accepts an unknown value (a typo
 * like "helth" would leave a health form recordable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createForm, FIELD_SENSITIVITIES } from '../src/features/forms/formsService.js';

const base = { tenantId: 't-0951', orgId: 'o-0951', title: 'Intake', createdBy: 'u' };

describe('ADR 0951 D2 — forms field sensitivity', () => {
  // `createForm` needs only the host-extension store, not a booted app.
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
  afterAll(() => { __resetHostExtPersistence(); });

  it('persists every value in the closed vocabulary, and leaves an ordinary field without one', async () => {
    expect(FIELD_SENSITIVITIES).toEqual(['payment', 'health', 'credential']);
    const f = await createForm({ ...base, fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'card', label: 'Card', type: 'text', sensitivity: 'payment' },
      { key: 'condition', label: 'Condition', type: 'textarea', sensitivity: 'health' },
      { key: 'code', label: 'Code', type: 'text', sensitivity: 'credential' },
      { key: 'notes', label: 'Notes', type: 'text', sensitivity: '' },
    ] });
    expect(f.fields.map((x) => x.sensitivity)).toEqual([undefined, 'payment', 'health', 'credential', undefined]);
    expect('sensitivity' in f.fields[0]!).toBe(false);
  });

  it('refuses an unknown value as an authoring error instead of dropping it', async () => {
    await expect(createForm({ ...base, fields: [{ key: 'condition', label: 'Condition', type: 'text', sensitivity: 'helth' }] }))
      .rejects.toThrow(/sensitivity MUST be one of: payment, health, credential/);
  });
});
