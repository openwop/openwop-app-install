/**
 * Grade-pass fixes (2026-07-10, forms-capture program) — route-level pins:
 *  - FRMD-2: deleteForm cascades its submissions (no orphaned PII);
 *  - FRMB-IDEM: a clientKey replays the SAME submission (no duplicate row, no
 *    duplicate CRM contact — sinks don't re-run);
 *  - FRMB-PAGE: `?limit&before` pages newest-first with an opaque cursor;
 *    no-limit keeps the legacy full shape; bad cursor 400s;
 *  - FRMB-HP: a non-string honeypot value still trips the trap;
 *  - FRMD-4: deleting the linked CRM contact strips submission.contactId.
 *
 * FORM-UX-1 CORRECTION (ADR 0584). The FRMB-HP case below used to assert
 * `200` + no `submissionId` + ZERO rows, under the name "the silent bot
 * posture". That test ENCODED THE DEFECT: it pinned as desired behaviour the
 * fact that a tripped submission is destroyed while the respondent is shown a
 * thank-you. It now pins the honest contract — the row is QUARANTINED
 * (`flagged`), the response is indistinguishable from a clean submit, and the
 * operator gets a count.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'forms']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
const anon = client;

const FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
];

async function fixture(createToContact = false): Promise<{ user: ReturnType<typeof client>; orgId: string; formId: string; F: string }> {
  const user = client();
  await user.post('/v1/host/openwop-app/test/login', { email: `fgf-${Date.now()}-${n++}@acme.test` });
  const org = await user.post('/v1/host/openwop-app/orgs', { name: 'Grade Co' });
  const orgId: string = org.body.orgId;
  const form = await user.post(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms`, { title: 'F', fields: FIELDS, createToContact });
  await user.patch(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${form.body.formId}/status`, { status: 'published' });
  return { user, orgId, formId: form.body.formId, F: `/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${form.body.formId}` };
}
const submit = (formId: string, body: Record<string, unknown>) =>
  anon().post(`/v1/host/openwop-app/public-forms/${encodeURIComponent(formId)}/submit`, body);

describe('grade fixes — forms capture', () => {
  it('FRMD-2: deleteForm cascades its submissions', async () => {
    const { user, orgId, formId, F } = await fixture();
    await submit(formId, { values: { name: 'A', email: 'a@x.com' } });
    await submit(formId, { values: { name: 'B', email: 'b@x.com' } });
    expect((await user.get(`${F}/submissions`)).body.submissions).toHaveLength(2);
    expect((await user.del(F)).status).toBe(204);
    // Rows are gone from the tenant slice: recreate a form and confirm empty inbox
    const again = await user.post(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms`, { title: 'F2', fields: FIELDS });
    expect((await user.get(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${again.body.formId}/submissions`)).body.submissions).toHaveLength(0);
  });

  it('FRMB-IDEM: clientKey replays the SAME submission and does not duplicate the CRM contact', async () => {
    const { user, F, formId } = await fixture(true);
    const key = 'ck-retry-1';
    const first = await submit(formId, { values: { name: 'Ada', email: 'ada@x.com' }, clientKey: key });
    const retry = await submit(formId, { values: { name: 'Ada', email: 'ada@x.com' }, clientKey: key });
    expect(first.body.submissionId).toBe(retry.body.submissionId);
    const rows = (await user.get(`${F}/submissions`)).body.submissions;
    expect(rows).toHaveLength(1);
    const contacts = await user.get('/v1/host/openwop-app/crm/contacts');
    expect((contacts.body.contacts as { email?: string }[]).filter((c) => c.email === 'ada@x.com')).toHaveLength(1);
  });

  it('FRMB-PAGE: limit/before pages newest-first; legacy no-limit unchanged; an unknown cursor restarts at page one (the T4 contract)', async () => {
    const { user, F, formId } = await fixture();
    for (let i = 0; i < 5; i += 1) await submit(formId, { values: { name: `N${i}`, email: `n${i}@x.com` } });
    const p1 = (await user.get(`${F}/submissions?limit=2`)).body;
    expect(p1.submissions).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await user.get(`${F}/submissions?limit=2&before=${encodeURIComponent(p1.nextCursor)}`)).body;
    expect(p2.submissions).toHaveLength(2);
    expect(p2.submissions[0].submissionId).not.toBe(p1.submissions[0].submissionId);
    const legacy = (await user.get(`${F}/submissions`)).body;
    expect(legacy.submissions).toHaveLength(5);
    expect(legacy.nextCursor).toBeUndefined();
    const unknown = (await user.get(`${F}/submissions?limit=2&before=garbage`)).body;
    expect(unknown.submissions).toHaveLength(2); // no-~ cursor ⇒ first page, not an error
  });

  it('FRMB-HP + FORM-UX-1: a non-string honeypot value trips the trap and QUARANTINES the row', async () => {
    // The trip condition is unchanged (FRMB-HP: any non-empty value, not just a
    // string). What changed is the consequence — see the FORM-UX-1 block below.
    const { user, F, formId } = await fixture();
    const r = await submit(formId, { values: { name: 'Bot', email: 'bot@x.com', _hp_ref: 1 } });
    expect(r.status).toBe(201);
    expect(typeof r.body.submissionId).toBe('string');
    const page = (await user.get(`${F}/submissions`)).body;
    expect(page.submissions).toHaveLength(1);
    expect(page.submissions[0].flagged).toBe('honeypot');
    expect(page.flaggedCount).toBe(1);
  });

  it('FRMD-4: deleting the linked CRM contact strips submission.contactId', async () => {
    const { user, F, formId } = await fixture(true);
    await submit(formId, { values: { name: 'Link', email: 'link@x.com' } });
    const rows = (await user.get(`${F}/submissions`)).body.submissions;
    const contactId: string = rows[0].contactId;
    expect(contactId).toMatch(/^crm:/);
    const del = await user.del(`/v1/host/openwop-app/crm/contacts/${encodeURIComponent(contactId)}`);
    expect([200, 204]).toContain(del.status);
    const after = (await user.get(`${F}/submissions`)).body.submissions;
    expect(after[0].contactId).toBeUndefined();
  });
});
