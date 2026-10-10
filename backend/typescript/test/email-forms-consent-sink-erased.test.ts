/**
 * ADR 0655 D7 (EMWF-11 / review S4) — the email forms-consent sink checks the erasure
 * tombstone FIRST and skips the write for an erased subject: a checkbox on a public
 * form is not fresh consent, and `clearTombstone:false` alone is inert once a record
 * exists. Asserted through `isAllowed` and the absent record. Born red: the sink
 * wrote `marketing:true` for the erased contact and `isAllowed` answered true.
 *
 * The outcome is guarded three times on this path: the sink's own tombstone check,
 * the ADR 0657 D10 write barrier inside `mergeConsentCategories` (whose throw the
 * sink's fail-soft catch swallows), and `isAllowed` reading the tombstone first.
 * Breaking any one of them alone changes no outcome (grade-tests w9, probes
 * fs-tombstone-check / fs-barrier-both). So the "skips the write" claim is also
 * asserted directly: the merge writer is wrapped to record the subjects it was asked to write,
 * and the erased subject must never reach it. Sabotage: `if (await isErasureTombstoned(…))`
 * → `if (false)` in `formsConsentSink.ts` reds the erased case; flipping the granted
 * category to `false` reds the positive control.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { runSubmissionSinks } from '../src/features/forms/submissionSinks.js';
import type { FormDef, Submission } from '../src/features/forms/formsService.js';
import { getConsent, isAllowed, deleteSubject, isErasureTombstoned, __resetConsentStore } from '../src/features/consent/consentService.js';

/** Every subject `mergeConsentCategories` was ASKED to write (attempted, landed or refused). */
const mergeAttempts = vi.hoisted((): string[] => []);
vi.mock('../src/features/consent/consentService.js', async (orig) => {
  const actual = await orig<typeof import('../src/features/consent/consentService.js')>();
  return {
    ...actual,
    mergeConsentCategories: async (...args: Parameters<typeof actual.mergeConsentCategories>) => {
      mergeAttempts.push(args[0].subjectKey);
      return actual.mergeConsentCategories(...args);
    },
  };
});

const T = 'tSinkErased';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['email', 'consent']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  await __resetConsentStore();
});

const NOW = new Date().toISOString();
const form: FormDef = {
  formId: 'f-optin', tenantId: T, orgId: 'o1', title: 'Newsletter', status: 'published', createToContact: false,
  emailOptInField: 'optin', fields: [{ key: 'optin', label: 'News', type: 'checkbox', required: false }],
  createdBy: 'u1', createdAt: NOW, updatedAt: NOW,
};
const submission = (contactId: string): Submission => ({
  submissionId: `s-${contactId}`, tenantId: T, orgId: 'o1', formId: 'f-optin', contactId,
  values: { optin: true }, meta: {}, createdAt: new Date().toISOString(),
});

describe('EMWF-11 — the forms opt-in sink never re-consents an erased subject', () => {
  it('positive control: a live contact ticking the box IS consented', async () => {
    await runSubmissionSinks(form, submission('ct-live'));
    expect(mergeAttempts).toContain('ct-live');
    expect(await isAllowed(T, 'ct-live', 'marketing.email')).toBe(true);
  });
  it('an ERASED contact ticking the box stays refused, and the tombstone survives', async () => {
    await deleteSubject(T, 'ct-erased');
    expect(await isErasureTombstoned(T, 'ct-erased')).toBe(true);
    await runSubmissionSinks(form, submission('ct-erased'));
    expect(mergeAttempts, 'the sink checks the tombstone FIRST and never attempts the write').not.toContain('ct-erased');
    expect(await getConsent(T, 'ct-erased'), 'no record was re-inserted').toBeNull();
    expect(await isAllowed(T, 'ct-erased', 'marketing.email'), 'no fresh consent from a public form for an erased subject').toBe(false);
    expect(await isErasureTombstoned(T, 'ct-erased')).toBe(true);
  });
});
