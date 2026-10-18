/**
 * ADR 0338 — the email-consent sink + submit guards, route-level:
 *  - a checked designated opt-in on a contact-linked submission records the
 *    marketing.email grant (subject = contactId, source form-optin:<formId>:<submissionId>,
 *    prior analytics preserved);
 *  - unchecked opt-in ⇒ NO consent record (a skip, never an opt-out);
 *  - `emailOptInField` sanitization: must name an existing checkbox field;
 *    a fields-only patch removing it clears the designation;
 *  - a THROWING submit guard fails open (a clean lead). The deny posture —
 *    QUARANTINED, stored + flagged + delivered nowhere (ADR 0584) — is witnessed in
 *    forms-submission-honesty.
 *
 * Sabotage-witnessed (grade-tests w8, probes w8g1-ecs-*): an umbrella `marketing` grant,
 * a wholesale `recordConsent` in place of the merge, recording an unchecked box, accepting
 * a non-checkbox opt-in, keeping a designation whose checkbox was removed, and a guard
 * throw that fails CLOSED each turn a case red.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getConsent, recordConsent, isAllowed } from '../src/features/consent/consentService.js';
import { registerSubmitGuard, clearSubmitGuardsForTest } from '../src/features/forms/submitGuards.js';
import { runSubmissionSinks } from '../src/features/forms/submissionSinks.js';
import type { FormDef, FormField, Submission } from '../src/features/forms/formsService.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'forms', 'crm' /* ADR 0892: CRM is opt-in */, 'email']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => clearSubmitGuardsForTest());

/** The response fields these cases read. */
type Body = {
  user?: { tenantId?: string }; orgId?: string; formId?: string; emailOptInField?: string; submissionId?: string;
  flaggedCount?: number; submissions?: Array<{ submissionId: string; contactId?: string; flagged?: string }>;
};
interface Res { status: number; body: Body }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Body);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
const anon = client;

const FIELDS: FormField[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
  { key: 'newsletter', label: 'Subscribe?', type: 'checkbox', required: false },
];

async function fixture(extra: Record<string, unknown> = {}): Promise<{ user: ReturnType<typeof client>; orgId: string; tenantId: string; formId: string }> {
  const user = client();
  const login = await user.post('/host/openwop-app/test/login', { email: `ecs-${Date.now()}-${n++}@acme.test` });
  const org = await user.post('/host/openwop-app/orgs', { name: 'Consent Co' });
  const orgId = org.body.orgId!;
  const form = await user.post(`/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms`, {
    title: 'Opt-in form', fields: FIELDS, createToContact: true, emailOptInField: 'newsletter', ...extra,
  });
  expect(form.status, JSON.stringify(form.body)).toBe(201);
  await user.patch(`/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${form.body.formId}/status`, { status: 'published' });
  return { user, orgId, tenantId: login.body.user?.tenantId ?? '', formId: form.body.formId! };
}

/** Switch the `consent` toggle on for `fn`, and back off after, so no case leaks it. */
async function withConsentOn(fn: () => Promise<void>): Promise<void> {
  const d = getToggleDefault('consent')!;
  await saveConfig({ ...d, status: 'on' }, 'test');
  try { await fn(); } finally { await saveConfig({ ...d, status: 'off' }, 'test'); }
}

const submit = (formId: string, values: Record<string, unknown>) =>
  anon().post(`/host/openwop-app/public-forms/${encodeURIComponent(formId)}/submit`, { values });

describe('ADR 0338 — email opt-in consent sink', () => {
  it('a checked opt-in records the marketing.email grant keyed by the linked contact', async () => {
    const { user, orgId, tenantId, formId } = await fixture();
    const sub = await submit(formId, { name: 'Ada', email: 'ada@x.com', newsletter: true });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    const rows = await user.get(`/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${encodeURIComponent(formId)}/submissions`);
    const contactId = rows.body.submissions![0]!.contactId!;
    expect(contactId).toMatch(/^crm:/);
    const consent = await getConsent(tenantId, contactId);
    // ADR 0849 D7 — an EMAIL checkbox grants EMAIL. It used to set the `marketing`
    // umbrella too, which `isAllowed` reads for every channel with no specific — so
    // ticking it opened SMS, push and ad audiences. RED on `b634adc76`.
    expect(consent?.categories.marketing, 'no umbrella grant from an email checkbox').toBe(false);
    expect(consent?.categories['marketing.email']).toBe(true);
    // ADR 0850 D2 — the receipt names the submission that is the proof.
    expect(consent?.source).toBe(`form-optin:${formId}:${rows.body.submissions![0]!.submissionId}`);
    await withConsentOn(async () => {
      expect(await isAllowed(tenantId, contactId, 'marketing.email')).toBe(true);
      expect(await isAllowed(tenantId, contactId, 'marketing.sms'), 'sms stays closed').toBe(false);
      expect(await isAllowed(tenantId, contactId, 'marketing.push'), 'push stays closed').toBe(false);
    });
  });

  /**
   * CONS-3 — WIDENED. This suite asserted preservation of `analytics` ONLY, and
   * that assertion shape is precisely what made the defect invisible: the sink
   * wrote a WHOLESALE record that hand-preserved `analytics` and dropped every
   * other specific, so a recorded `marketing.sms:false` vanished and
   * `isAllowed` (which falls back to the umbrella when a specific is ABSENT)
   * turned the omission into ALLOW. Ticking an EMAIL checkbox granted SMS and
   * PUSH.
   *
   * The case now asserts EVERY specific the subject set, in both directions —
   * enumerate the class, not the instance.
   */
  it('CONS-3: an email opt-in preserves every recorded specific — it never grants sms/push by omission', async () => {
    const { tenantId, orgId, formId } = await fixture();
    await withConsentOn(async () => {
      const contactId = 'crm:cons3-subject';
      // The person used a preference centre first: analytics ON, sms + push OFF.
      await recordConsent({
        tenantId, subjectKey: contactId,
        categories: { analytics: true, marketing: false, 'marketing.sms': false, 'marketing.push': false },
        source: 'preference-center',
    });

    // …then ticks the EMAIL opt-in. Driven through `runSubmissionSinks` with a
    // seeded contact id rather than HTTP submits: this exercises the SINK's own
    // merge, which is where the defect is, against a subject whose prior record the
    // test controls. (Corrected, grade-tests w8: this used to say `createToContact`
    // mints a NEW contact per submission; since ADR 0627 D6 a repeat address ATTACHES.)
    // ADR 0850 D2 — a real form carries its fields (the sink reads whether the
    // opt-in is required) and a real submission its id and capture time (AFTER the
    // preference-centre write above, or the no-re-grant rule would rightly skip).
    const now = new Date().toISOString();
    const form: FormDef = {
      formId, tenantId, orgId, title: 'Opt-in form', status: 'published', fields: FIELDS,
      createToContact: true, emailOptInField: 'newsletter', createdBy: 'test', createdAt: now, updatedAt: now,
    };
    const sub: Submission = {
      submissionId: 'sub-cons3', tenantId, orgId, formId, contactId, values: { newsletter: true }, meta: {}, createdAt: now,
    };
    await runSubmissionSinks(form, sub);

    const consent = await getConsent(tenantId, contactId);
    expect(consent?.source, 'the sink must actually have run — otherwise every assertion below is vacuous').toBe(`form-optin:${formId}:sub-cons3`);
    expect(consent?.categories['marketing.email'], 'the grant they gave').toBe(true);
    // THE finding: on `origin/main` these two keys are ABSENT from the record
    // and `isAllowed` therefore returns TRUE for both.
    expect(consent?.categories['marketing.sms'], 'the sms refusal must SURVIVE').toBe(false);
    expect(consent?.categories['marketing.push'], 'the push refusal must SURVIVE').toBe(false);
    expect(await isAllowed(tenantId, contactId, 'marketing.sms')).toBe(false);
    expect(await isAllowed(tenantId, contactId, 'marketing.push')).toBe(false);
    // …and the one this suite already checked.
    expect(consent?.categories.analytics).toBe(true);
    expect(await isAllowed(tenantId, contactId, 'marketing.email')).toBe(true);
    });
  });

  it('an unchecked opt-in records NOTHING (skip, never an opt-out)', async () => {
    const { user, orgId, tenantId, formId } = await fixture();
    await submit(formId, { name: 'Bo', email: 'bo@x.com', newsletter: false });
    const rows = await user.get(`/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${encodeURIComponent(formId)}/submissions`);
    const contactId = rows.body.submissions![0]!.contactId!;
    expect(contactId).toMatch(/^crm:/);
    expect(await getConsent(tenantId, contactId)).toBeNull();
  });

  it('rejects a non-checkbox emailOptInField and clears it when a fields patch removes the checkbox', async () => {
    const { user, orgId, formId } = await fixture();
    // An OPTIONAL text field: a REQUIRED one also trips the ADR 0850 D2 "opt-in
    // cannot be required" refusal, which masked the checkbox rule (probe
    // w8g1-ecs-checkbox-only came back vacuous against the old `email` designation).
    const bad = await user.post(`/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms`, {
      title: 'Bad', fields: [...FIELDS, { key: 'note', label: 'Note', type: 'text', required: false }], emailOptInField: 'note',
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('existing checkbox field');
    const cleared = await user.patch(`/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${formId}`, {
      fields: FIELDS.filter((f) => f.key !== 'newsletter'),
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.emailOptInField).toBeUndefined();
  });
});

describe('ADR 0338 — submit guards', () => {
  /**
   * ADR 0338 §D4 — an anti-spam outage must never drop leads, so a THROWING guard
   * fails OPEN: the lead lands CLEAN, not quarantined ("fails open" must not be a
   * quarantine in disguise). The DENY posture (quarantine, ADR 0584) is witnessed by
   * forms-submission-honesty "a GUARD denial stores the row…"; the deny half that
   * lived here was redundant with it (grade-tests w8: probes w8g1-ecs/sh-guard-deny
   * both red).
   */
  it('a throwing guard fails open — the lead is CLEAN, not quarantined', async () => {
    const { user, orgId, formId } = await fixture();
    const inbox = `/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${encodeURIComponent(formId)}/submissions`;
    registerSubmitGuard({ id: 'boom', check: async () => { throw new Error('provider down'); } });
    const allowed = await submit(formId, { name: 'Real', email: 'real@x.com' });
    expect(allowed.status).toBe(201); // fail-open — never drop leads on an outage
    const rows = await user.get(inbox);
    expect(rows.body.submissions).toHaveLength(1);
    expect(rows.body.submissions![0]!.flagged).toBeUndefined();
    expect(rows.body.flaggedCount).toBe(0);
  });
});
