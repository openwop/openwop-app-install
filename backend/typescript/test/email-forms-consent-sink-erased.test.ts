/**
 * ADR 0655 D7 (EMWF-11 / review S4) — the email forms-consent sink checks the erasure
 * tombstone FIRST and skips the write for an erased subject: a checkbox on a public
 * form is not fresh consent, and `clearTombstone:false` alone is inert once a record
 * exists. Asserted through `isAllowed`, not through the flag. Born red: the sink
 * wrote `marketing:true` for the erased contact and `isAllowed` answered true.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { runSubmissionSinks } from '../src/features/forms/submissionSinks.js';
import { isAllowed, deleteSubject, isErasureTombstoned, __resetConsentStore } from '../src/features/consent/consentService.js';

const T = 'tSinkErased';
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  for (const id of ['email', 'consent']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  await __resetConsentStore();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const form = { formId: 'f-optin', tenantId: T, orgId: 'o1', emailOptInField: 'optin' } as never;
const submission = (contactId: string) => ({ submissionId: `s-${contactId}`, tenantId: T, orgId: 'o1', formId: 'f-optin', contactId, values: { optin: true }, createdAt: new Date().toISOString() } as never);

describe('EMWF-11 — the forms opt-in sink never re-consents an erased subject', () => {
  it('positive control: a live contact ticking the box IS consented', async () => {
    await runSubmissionSinks(form, submission('ct-live'));
    expect(await isAllowed(T, 'ct-live', 'marketing.email')).toBe(true);
  });
  it('an ERASED contact ticking the box stays refused, and the tombstone survives', async () => {
    await deleteSubject(T, 'ct-erased');
    expect(await isErasureTombstoned(T, 'ct-erased')).toBe(true);
    await runSubmissionSinks(form, submission('ct-erased'));
    expect(await isAllowed(T, 'ct-erased', 'marketing.email'), 'no fresh consent from a public form for an erased subject').toBe(false);
    expect(await isErasureTombstoned(T, 'ct-erased')).toBe(true);
  });
});
