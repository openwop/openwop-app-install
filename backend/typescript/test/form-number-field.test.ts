/**
 * ADR 0516 — `number` is a real field type, not a workaround.
 *
 * The shipped RSVP starter declared `type:"number"`, which did not exist in the
 * closed catalog, and the loader silently coerced it to `text`; the fix at the
 * time was to force a guest COUNT into a bounded select. Adopting the wire's
 * portable field kinds (`chat-card-packs.md:81`, RFC 0071 Phase 2) makes the
 * type real, so a count is stored as a NUMBER a consumer can sum without
 * re-parsing.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createForm, validateValues, FIELD_TYPES } from '../src/features/forms/formsService.js';

const TENANT = 'user:number-test';
const ORG = 'org-number';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  initHostExtPersistence(await openStorage('memory://'));
});

const mk = (fields: unknown) =>
  createForm({ tenantId: TENANT, orgId: ORG, title: 'T', fields, createdBy: 'user:x' });

describe('ADR 0516 — the `number` field type', () => {
  it('is in the closed catalog', () => {
    expect(FIELD_TYPES).toContain('number');
  });

  it('SURVIVES sanitizeFields instead of coercing to text', async () => {
    // The exact regression: before `number` existed, this came back as 'text'.
    const form = await mk([{ key: 'guests', label: 'Guests', type: 'number' }]);
    expect(form.fields[0]!.type).toBe('number');
  });

  it('stores a submitted count as a NUMBER, not the raw string', async () => {
    const form = await mk([{ key: 'guests', label: 'Guests', type: 'number' }]);
    const out = validateValues(form, { guests: '3' });
    expect(out.guests).toBe(3);
    expect(typeof out.guests).toBe('number');
  });

  it('REJECTS a non-numeric value rather than coercing it', async () => {
    const form = await mk([{ key: 'guests', label: 'Guests', type: 'number' }]);
    // `Number('') === 0` and `Number('abc') === NaN` — coercing either would
    // silently invent a count. A public form must not fabricate data.
    expect(() => validateValues(form, { guests: 'abc' })).toThrow();
  });

  it('does not disturb the other types', async () => {
    const form = await mk([
      { key: 'a', label: 'A', type: 'text' },
      { key: 'b', label: 'B', type: 'email' },
      { key: 'c', label: 'C', type: 'checkbox' },
    ]);
    expect(form.fields.map((f) => f.type)).toEqual(['text', 'email', 'checkbox']);
  });
});
