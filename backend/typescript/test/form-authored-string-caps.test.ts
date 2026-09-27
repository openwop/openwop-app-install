/**
 * ADR 0516 Phase 2a — authored strings and option lists are BOUNDED, by truncation.
 *
 * `label`, `title` and `options[]` all render on the PUBLIC, unauthenticated fill
 * page (`/public-forms/:formId`). Before this they were unbounded: `sanitizeFields`
 * type-checked them and stored them verbatim, so a 10 MB label or a 100 000-entry
 * select was a render-time denial of service. The field COUNT cap did not help —
 * one field is enough.
 *
 * The bounds live in `sanitizeFields`/`createForm`, NOT in the form-content pack
 * loader, and that placement is the point: the loader can only bound what a PACK
 * ships, while a hand-typed 10 MB label is the same attack on the same page.
 * Bounding at the shared choke point means pack input and typed input get identical
 * treatment — which is what makes "instantiate through createForm" (ADR 0516
 * §Security) worth anything.
 *
 * TRUNCATE, NOT THROW. An existing form with an over-long label must keep saving;
 * only structural problems (bad key, duplicate key) throw. A cap that threw would
 * turn a hardening change into a migration, and would make the next person's
 * "harmless" cap a production incident.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createForm, updateForm } from '../src/features/forms/formsService.js';

const TENANT = 'user:caps-test';
const ORG = 'org-caps';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  initHostExtPersistence(await openStorage('memory://'));
});

const mk = (fields: unknown, title = 'T') =>
  createForm({ tenantId: TENANT, orgId: ORG, title, fields, createdBy: 'user:x' });

describe('ADR 0516 Phase 2a — authored strings are bounded', () => {
  it('TRUNCATES an over-long label instead of throwing', async () => {
    const form = await mk([{ key: 'k', label: 'x'.repeat(10_000), type: 'text' }]);
    // 1000, not 200: a GDPR consent checkbox's label IS its legal text and routinely
    // runs past 200 chars. Truncating consent copy is worse than a long label.
    expect(form.fields[0]!.label.length).toBe(1_000);
    // The value is kept, just bounded — truncation must not blank the label, which
    // would silently unlabel a control on a public page.
    expect(form.fields[0]!.label.startsWith('x')).toBe(true);
  });

  it('TRUNCATES an over-long title on BOTH create and update', async () => {
    const form = await mk([{ key: 'k', label: 'K', type: 'text' }], 'y'.repeat(10_000));
    expect(form.title.length).toBe(200);
    // A cap enforced only at create is a cap a rename walks straight past.
    const renamed = await updateForm(TENANT, ORG, form.formId, { title: 'z'.repeat(10_000) });
    expect(renamed!.title.length).toBe(200);
  });

  it('caps the option COUNT — a 100k-entry select cannot reach the public page', async () => {
    const opts = Array.from({ length: 100_000 }, (_, i) => `opt-${i}`);
    const form = await mk([{ key: 'k', label: 'K', type: 'select', options: opts }]);
    expect(form.fields[0]!.options).toHaveLength(250);
  });

  it('caps each option LENGTH — count alone is not enough', async () => {
    // 100 options is fine; 100 options of 1 MB each is the same DoS by another route.
    const form = await mk([{ key: 'k', label: 'K', type: 'select', options: ['a'.repeat(10_000), 'b'] }]);
    expect(form.fields[0]!.options![0]!.length).toBe(200);
    expect(form.fields[0]!.options![1]).toBe('b');
  });

  it('a COUNTRY-sized option list survives — the cap must not break an ordinary form', async () => {
    // The regression this cap nearly caused. ~195 countries; the first draft capped
    // at 100 and would have silently dropped half the world.
    const countries = Array.from({ length: 195 }, (_, i) => `Country ${i}`);
    const form = await mk([{ key: 'country', label: 'Country', type: 'select', options: countries }]);
    expect(form.fields[0]!.options).toHaveLength(195);
  });

  it('bounds submitMessage on create AND update — it renders on the public page too', async () => {
    // Missed in the first pass: the post-submit confirmation is authored, public, and
    // was entirely unbounded.
    const form = await mk([{ key: 'k', label: 'K', type: 'text' }]);
    const withMsg = await updateForm(TENANT, ORG, form.formId, { submitMessage: 'm'.repeat(10_000) });
    expect(withMsg!.submitMessage!.length).toBe(2_000);
  });

  it('leaves ordinary content untouched — the cap must not be a silent editor', async () => {
    // The regression direction. Without this, truncating everything to '' would
    // satisfy every assertion above.
    const label = 'How can we help?';
    const form = await mk([{ key: 'msg', label, type: 'select', options: ['Yes', 'No'] }], 'Contact us');
    expect(form.title).toBe('Contact us');
    expect(form.fields[0]!.label).toBe(label);
    expect(form.fields[0]!.options).toEqual(['Yes', 'No']);
  });

  it('an empty/whitespace label still falls back to the key, not to a blank', async () => {
    const form = await mk([{ key: 'the_key', label: '   ', type: 'text' }]);
    expect(form.fields[0]!.label).toBe('the_key');
  });

  it('structural problems STILL throw — truncation is only for length', async () => {
    // Bounding must not have softened the checks that protect the submission
    // envelope; these are correctness, not resource, problems.
    await expect(mk([{ key: 'not a key!', label: 'X', type: 'text' }])).rejects.toThrow();
    await expect(mk([
      { key: 'dup', label: 'A', type: 'text' },
      { key: 'dup', label: 'B', type: 'text' },
    ])).rejects.toThrow();
  });
});
