/**
 * ADR 0338 — the email-consent sink + submit guards, route-level:
 *  - a checked designated opt-in on a contact-linked submission records the
 *    marketing.email grant (subject = contactId, source form-optin:<id>,
 *    prior analytics preserved);
 *  - unchecked opt-in ⇒ NO consent record (a skip, never an opt-out);
 *  - `emailOptInField` sanitization: must name an existing checkbox field;
 *    a fields-only patch removing it clears the designation;
 *  - a registered deny guard takes the honeypot posture (200, no row) and a
 *    throwing guard fails open.
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

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'forms', 'email']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => clearSubmitGuardsForTest());

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
const anon = client;

const FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
  { key: 'newsletter', label: 'Subscribe?', type: 'checkbox', required: false },
];

async function fixture(extra: Record<string, unknown> = {}): Promise<{ user: ReturnType<typeof client>; orgId: string; tenantId: string; formId: string }> {
  const user = client();
  const login = await user.post('/v1/host/openwop-app/test/login', { email: `ecs-${Date.now()}-${n++}@acme.test` });
  const org = await user.post('/v1/host/openwop-app/orgs', { name: 'Consent Co' });
  const form = await user.post(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(org.body.orgId)}/forms`, {
    title: 'Opt-in form', fields: FIELDS, createToContact: true, emailOptInField: 'newsletter', ...extra,
  });
  expect(form.status, JSON.stringify(form.body)).toBe(201);
  await user.patch(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(org.body.orgId)}/forms/${form.body.formId}/status`, { status: 'published' });
  return { user, orgId: org.body.orgId, tenantId: login.body.user?.tenantId ?? '', formId: form.body.formId };
}

const submit = (formId: string, values: Record<string, unknown>) =>
  anon().post(`/v1/host/openwop-app/public-forms/${encodeURIComponent(formId)}/submit`, { values });

describe('ADR 0338 — email opt-in consent sink', () => {
  it('a checked opt-in records the marketing.email grant keyed by the linked contact', async () => {
    const { user, orgId, tenantId, formId } = await fixture();
    const sub = await submit(formId, { name: 'Ada', email: 'ada@x.com', newsletter: true });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    const rows = await user.get(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${encodeURIComponent(formId)}/submissions`);
    const contactId = rows.body.submissions[0].contactId as string;
    expect(contactId).toMatch(/^crm:/);
    const consent = await getConsent(tenantId, contactId);
    expect(consent?.categories.marketing).toBe(true);
    expect(consent?.categories['marketing.email']).toBe(true);
    expect(consent?.source).toBe(`form-optin:${formId}`);
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
    const { tenantId, formId } = await fixture();
    for (const id of ['consent']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
    const contactId = 'crm:cons3-subject';
    // The person used a preference centre first: analytics ON, sms + push OFF.
    await recordConsent({
      tenantId, subjectKey: contactId,
      categories: { analytics: true, marketing: false, 'marketing.sms': false, 'marketing.push': false },
      source: 'preference-center',
    });

    // …then ticks the EMAIL opt-in. Driven through `runSubmissionSinks` with an
    // already-linked contact rather than two HTTP submits, because
    // `createToContact` mints a NEW contact per submission — measured: two
    // submits of the same address produced two distinct `crm:` ids, so a
    // route-level repeat can never revisit the same consent subject. This
    // exercises the SINK's own code, which is where the defect is.
    const { runSubmissionSinks } = await import('../src/features/forms/submissionSinks.js');
    await runSubmissionSinks(
      { formId, tenantId, emailOptInField: 'newsletter' } as never,
      { tenantId, formId, contactId, values: { newsletter: true } } as never,
    );

    const consent = await getConsent(tenantId, contactId);
    expect(consent?.source, 'the sink must actually have run — otherwise every assertion below is vacuous').toBe(`form-optin:${formId}`);
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

  it('an unchecked opt-in records NOTHING (skip, never an opt-out)', async () => {
    const { user, orgId, tenantId, formId } = await fixture();
    await submit(formId, { name: 'Bo', email: 'bo@x.com', newsletter: false });
    const rows = await user.get(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${encodeURIComponent(formId)}/submissions`);
    const contactId = rows.body.submissions[0].contactId as string;
    expect(await getConsent(tenantId, contactId)).toBeNull();
  });

  it('rejects a non-checkbox emailOptInField and clears it when a fields patch removes the checkbox', async () => {
    const { user, orgId, formId } = await fixture();
    const bad = await user.post(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms`, {
      title: 'Bad', fields: FIELDS, emailOptInField: 'email',
    });
    expect(bad.status).toBe(400);
    const cleared = await user.patch(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${formId}`, {
      fields: FIELDS.filter((f) => f.key !== 'newsletter'),
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.emailOptInField).toBeUndefined();
  });
});

describe('ADR 0338 — submit guards', () => {
  /**
   * ADR 0584 (FORM-UX-1) — this test used to assert "a deny guard takes the
   * honeypot posture (200, no row)". The `no row` half was the defect: this
   * seam exists for CAPTCHA providers, which have real false-positive rates, so
   * "deny ⇒ destroy the lead and tell the respondent thanks" was the worst
   * possible default. A deny QUARANTINES now — stored, flagged, no sinks.
   *
   * The fail-open half is unchanged and still the right call: an anti-spam
   * outage must never drop leads.
   */
  it('a deny guard QUARANTINES the submission (stored + flagged, no sinks); a throwing guard fails open', async () => {
    const { user, orgId, formId } = await fixture();
    const inbox = `/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${encodeURIComponent(formId)}/submissions`;
    registerSubmitGuard({ id: 'block-all', check: async () => 'deny' });
    const denied = await submit(formId, { name: 'Spam', email: 'spam@x.com' });
    // Indistinguishable from a clean submit on the wire — a better anti-oracle
    // posture than the 200-without-an-id it replaces, not a weaker one.
    expect(denied.status).toBe(201);
    expect(typeof denied.body.submissionId).toBe('string');
    let rows = await user.get(inbox);
    expect(rows.body.submissions).toHaveLength(1);
    expect(rows.body.submissions[0].flagged).toBe('guard');
    expect(rows.body.flaggedCount).toBe(1);

    clearSubmitGuardsForTest();
    registerSubmitGuard({ id: 'boom', check: async () => { throw new Error('provider down'); } });
    const allowed = await submit(formId, { name: 'Real', email: 'real@x.com' });
    expect(allowed.status).toBe(201); // fail-open — never drop leads on an outage
    rows = await user.get(inbox);
    expect(rows.body.submissions).toHaveLength(2);
    // The fail-open lead is a REAL one, not a quarantined one — the two paths
    // must stay distinguishable, or "fails open" would be a quarantine in
    // disguise.
    expect(rows.body.submissions.find((s: { flagged?: string }) => !s.flagged)).toBeTruthy();
    expect(rows.body.flaggedCount).toBe(1);
  });
});
