/**
 * Forms feature (ADR 0017) — ROUTE-level harness. Boots the real app and drives:
 * the authed org-scoped builder (RBAC write/read), the PUBLIC unauthed render +
 * submit, honeypot drop, required-field validation, submission → CRM contact
 * (contactId set via crmService), toggle-off 404, and cross-tenant IDOR.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { addSuppression } from '../src/features/crm/suppressionService.js';
import { deleteSubject } from '../src/features/consent/consentService.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'forms']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client(initialCookie = '') {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    const sc = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
    for (const c of sc) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
// public (unauthenticated) calls — no cookie
const pub = client();

let n = 0;
async function ownerWithOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  // ADR 0026: mint an authenticated user via the env-gated auth test seam.
  const owner = client();
  const su = await owner.post('/v1/host/openwop-app/test/login', { email: `forms-${Date.now()}-${n++}@acme.test` });
  expect(su.status, JSON.stringify(su.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const enableForms = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('forms'); if (d) await saveConfig({ ...d, status }, 'test');
};
const CONTACT_FORM = {
  title: 'Contact us',
  createToContact: true,
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true },
  ],
};

describe('Forms: authed org-scoped builder (RBAC)', () => {
  it('is registered as a backend feature', async () => {
    const { BACKEND_FEATURES } = await import('../src/features/index.js');
    expect(BACKEND_FEATURES.some((f) => f.id === 'forms')).toBe(true);
  });

  it('advertises the ctx.features.forms surface at /.well-known/openwop (ADR 0014)', async () => {
    const disco = await pub.get('/.well-known/openwop');
    expect(disco.status).toBe(200);
    expect(disco.body.hostExtensions?.featureSurfaces).toContain('host.sample.forms');
  });

  it('owner creates a draft, lists, reads, and publishes', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, CONTACT_FORM);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.status).toBe('draft');
    const formId = created.body.formId;

    const list = await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`);
    expect(list.body.forms.some((f: any) => f.formId === formId)).toBe(true);

    const pubd = await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${formId}/status`, { status: 'published' });
    expect(pubd.status).toBe(200);
    expect(pubd.body.status).toBe('published');
  });
});

describe('Forms: public render + submit', () => {
  it('renders a published form publicly (no auth) but not a draft', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const draft = (await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, CONTACT_FORM)).body;
    // draft → public 404
    expect((await pub.get(`/v1/host/openwop-app/public-forms/${draft.formId}`)).status).toBe(404);
    await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${draft.formId}/status`, { status: 'published' });
    const render = await pub.get(`/v1/host/openwop-app/public-forms/${draft.formId}`);
    expect(render.status).toBe(200);
    expect(render.body.fields).toHaveLength(2);
    expect(render.body.honeypotField).toBe('_hp_ref');
  });

  it('submit creates a CRM contact (contactId set via crmService)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const form = (await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, CONTACT_FORM)).body;
    await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/status`, { status: 'published' });

    const sub = await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { name: 'Lead', email: 'lead@x.com' } });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body.ok).toBe(true);

    const subs = await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/submissions`);
    expect(subs.body.submissions).toHaveLength(1);
    expect(subs.body.submissions[0].contactId).toMatch(/^crm:/); // routed through createContact
    expect(subs.body.submissions[0].values.email).toBe('lead@x.com');
  });

  // FRMWF-2 / ADR 0648 D2 — an anonymous public submit must NOT resurrect a
  // suppressed or DSAR-erased subject as a CRM contact. `createContact` consulted
  // neither store; a comment 300 lines below it says `crm:suppression` is retained
  // "ON PURPOSE (the address is the key)" so that exactly this check can be made —
  // and nothing on the create path called it. The eraser anonymizes the SUBMISSION;
  // the sink then re-created the CONTACT. This is the one place in the lane where an
  // unauthenticated actor could undo erasure. The check lives in the SINK, not in
  // `createContact`: an operator re-adding a contact by hand through the authenticated
  // route is allowed to; an anonymous form is not.
  it('FRMWF-2: a public submit from a SUPPRESSED address creates no contact, and says so as a marker', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const form = (await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, CONTACT_FORM)).body;
    await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/status`, { status: 'published' });
    const tenantId: string = form.tenantId ?? (await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}`)).body.tenantId;
    expect(tenantId, 'the fixture must expose the tenant — otherwise the suppression is seeded nowhere').toBeTruthy();

    const email = 'erased-subject@x.com';
    await addSuppression(tenantId, email, 'manual', 'dsar:test', 'erased subject — must never be re-created by a public form');

    const sub = await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { name: 'Ghost', email } });
    // Capture-before-effect (ADR 0017): the SUBMISSION still lands with the same
    // shape as a clean one — refusing it would turn suppression into an oracle.
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    // …but the CONTACT must not exist, and the sink must say WHY as a marker, not a
    // throw (sink throws are swallowed by design, so a throw would be invisible).
    const rows = (await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/submissions`)).body.submissions;
    const mine = rows.find((r: { values: { email?: string } }) => r.values.email === email);
    expect(mine, 'the submission row must exist').toBeTruthy();
    expect(mine.contactId, 'a suppressed subject must NOT get a contact').toBeUndefined();
    expect(mine.error).toBe('suppressed');
  });

  // FRMWF-6 / ADR 0648 D5 — the two refusals on the app's highest-volume
  // unauthenticated write path that had ZERO backend witnesses. The GET refusal
  // for a draft was tested; the POST's was INFERRED from it. And the 20 000-char
  // values cap + 5 000-char field cap were referenced by nothing in `test/` — the
  // frontend test literally calls its client mirror "the 5k SERVER mirror".
  it('FRMWF-6a: POST /submit to a DRAFT form is refused with the uniform 404', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const form = (await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, CONTACT_FORM)).body;
    // NOT published. The read refusal is already witnessed; this is the WRITE.
    const sub = await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { name: 'Early', email: 'early@x.com' } });
    expect(sub.status).toBe(404);
    // Non-vacuity: publish it and the same submit lands.
    await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/status`, { status: 'published' });
    expect((await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { name: 'Early', email: 'early@x.com' } })).status).toBe(201);
  });

  it('FRMWF-6b: an over-long values body is refused (413), an over-long single field too (400)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const form = (await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, CONTACT_FORM)).body;
    await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/status`, { status: 'published' });
    // 20 001 chars across the bag → MAX_VALUES_CHARS (20 000) → 413.
    const big = await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { name: 'x'.repeat(10_001), email: 'y'.repeat(10_000) } });
    expect(big.status, JSON.stringify(big.body).slice(0, 200)).toBe(413);
    // 5 001 chars in ONE field, bag under the total cap → MAX_FIELD_LEN (5 000) → 400.
    const longField = await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { name: 'z'.repeat(5_001), email: 'ok@x.com' } });
    expect(longField.status, JSON.stringify(longField.body).slice(0, 200)).toBe(400);
    // Non-vacuity: a bag just under both caps lands.
    const fine = await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { name: 'n'.repeat(4_999), email: 'fine@x.com' } });
    expect(fine.status).toBe(201);
  });

  // FRMCD-1 / ADR 0648 D2 (corrected) — the ERASURE arm, witnessed through the
  // REAL eraser. The first D2 witness seeded `addSuppression` by hand and claimed
  // "suppressed or DSAR-erased"; it could only see the suppression half, and that
  // half was all D2 closed. No erasure path writes a suppression row — the DSAR
  // fan-out only REDACTS an existing one — so a respondent who became a contact
  // and then filed a DSAR without ever unsubscribing was still re-created from an
  // anonymous submit. The predicate that exists for exactly this is
  // `isErasureTombstoned`, written BEFORE the fan-out. This drives `deleteSubject`,
  // the real entry, so the witness sees whatever the eraser actually leaves behind.
  it('FRMCD-1: a public submit from a DSAR-ERASED address creates no contact', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const form = (await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, CONTACT_FORM)).body;
    await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/status`, { status: 'published' });
    const tenantId: string = form.tenantId ?? (await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}`)).body.tenantId;
    const email = 'Dsar.Subject@X.com';   // mixed case on purpose — the tombstone hashes the RAW key

    // Non-vacuity: they become a contact the normal way first.
    const first = await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { name: 'Before', email } });
    expect(first.status).toBe(201);
    const before = (await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/submissions`)).body.submissions
      .find((r: { values: { email?: string } }) => r.values.email === email);
    expect(before?.contactId, 'the first submit must have created a contact, or the erasure below proves nothing').toBeTruthy();

    // The REAL DSAR — through the subject-erasure seam, not a hand-seeded row.
    await deleteSubject(tenantId, email);

    // Now the same address, from an anonymous write.
    const again = await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { name: 'After', email } });
    expect(again.status, 'the SUBMISSION still lands — refusing it would make erasure an oracle').toBe(201);
    const rows = (await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/submissions`)).body.submissions;
    const after = rows.find((r: { values: { name?: string } }) => r.values.name === 'After');
    expect(after, 'the second submission row must exist').toBeTruthy();
    expect(after.contactId, 'an ERASED subject must NOT be re-created as a contact').toBeUndefined();
    expect(after.error).toBe('erased');
  });

  it('crm toggled off: submission persists with no contactId and NO error — the sink skips silently (ADR 0330)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const form = (await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, CONTACT_FORM)).body;
    await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/status`, { status: 'published' });
    const crmDefault = getToggleDefault('crm');
    expect(crmDefault).toBeTruthy();
    await saveConfig({ ...crmDefault!, status: 'off' }, 'test');
    try {
      const sub = await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { name: 'Lead', email: 'lead-off@x.com' } });
      expect(sub.status, JSON.stringify(sub.body)).toBe(201);
      const subs = await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/submissions`);
      expect(subs.body.submissions).toHaveLength(1);
      expect(subs.body.submissions[0].contactId).toBeUndefined();
      expect(subs.body.submissions[0].error).toBeUndefined(); // a skip is not an error
    } finally {
      await saveConfig({ ...crmDefault!, status: 'on' }, 'test');
    }
  });

  /**
   * FORM-UX-1 (ADR 0584) — this test used to be named "drops a honeypot-filled
   * submission (silent 200, no row)" and asserted exactly that. It was the
   * tests-that-pin-defects shape: a respondent whose browser extension filled
   * the hidden decoy was told "Thanks — your submission was received", a funnel
   * step advanced, and the lead existed nowhere.
   *
   * The honest contract, pinned here in its three separable halves:
   *   1. the row IS stored, marked `flagged` — nothing is silently lost;
   *   2. the response is INDISTINGUISHABLE from a clean submit (201 + a real
   *      submissionId), which is a strictly better anti-oracle posture than the
   *      old 200-without-an-id it replaces;
   *   3. the operator can see the rate (`flaggedCount` on the inbox read).
   * A VALIDATION failure is unaffected: it is still a visible 400, because a
   * missing required field is the respondent's to fix.
   */
  it('QUARANTINES a honeypot-filled submission (stored + flagged + counted) and rejects a missing required field', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const form = (await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, CONTACT_FORM)).body;
    await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/status`, { status: 'published' });

    const honeypot = await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { name: 'Bot', email: 'b@x.com', _hp_ref: 'spam' } });
    expect(honeypot.status).toBe(201);
    expect(typeof honeypot.body.submissionId).toBe('string');
    const missing = await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { email: 'noname@x.com' } });
    expect(missing.status).toBe(400);

    const subs = await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/submissions`);
    // The quarantined lead is recoverable by a human; the 400 recorded nothing.
    expect(subs.body.submissions).toHaveLength(1);
    expect(subs.body.submissions[0].flagged).toBe('honeypot');
    expect(subs.body.submissions[0].contactId).toBeUndefined(); // sinks did NOT run
    expect(subs.body.flaggedCount).toBe(1);
  });

  // GC-FRM-7/FORMS-1 (grade pass 2026-07-10) — the abuse ceiling: at the
  // 50k/form cap a further submit refuses HONESTLY (429; a capture primitive
  // must never silently drop a lead), and the cap never affects other forms.
  it('refuses a submit at the per-form cap (429) without touching other forms', async () => {
    const { __setSubmissionCountForTests, MAX_SUBMISSIONS_PER_FORM } = await import('../src/features/forms/formsService.js');
    const { owner, orgId } = await ownerWithOrg();
    const capped = (await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, CONTACT_FORM)).body;
    await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${capped.formId}/status`, { status: 'published' });
    const healthy = (await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, { ...CONTACT_FORM, title: 'Healthy' })).body;
    await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${healthy.formId}/status`, { status: 'published' });

    const tenantId = capped.tenantId ?? (await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${capped.formId}`)).body.tenantId;
    await __setSubmissionCountForTests(capped.formId, tenantId, MAX_SUBMISSIONS_PER_FORM);
    const refused = await pub.post(`/v1/host/openwop-app/public-forms/${capped.formId}/submit`, { values: { name: 'N', email: 'n@x.com' } });
    expect(refused.status, JSON.stringify(refused.body)).toBe(429);
    const ok = await pub.post(`/v1/host/openwop-app/public-forms/${healthy.formId}/submit`, { values: { name: 'M', email: 'm@x.com' } });
    expect(ok.status).toBe(201);
  });

  // FORMS-3 — the paged inbox read: newest-first, `limit`/`before` cursor.
  it('paginates submissions with a stable before-cursor', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const form = (await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, CONTACT_FORM)).body;
    await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/status`, { status: 'published' });
    for (let i = 0; i < 5; i++) {
      expect((await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { name: `P${i}`, email: `p${i}@x.com` } })).status).toBe(201);
    }
    const page1 = await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/submissions?limit=2`);
    expect(page1.body.submissions).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/submissions?limit=2&before=${encodeURIComponent(page1.body.nextCursor)}`);
    expect(page2.body.submissions).toHaveLength(2);
    const ids1 = page1.body.submissions.map((s: { submissionId: string }) => s.submissionId);
    const ids2 = page2.body.submissions.map((s: { submissionId: string }) => s.submissionId);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false); // disjoint pages
    expect((await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/submissions?limit=999`)).status).toBe(400);
  });

  // GC-FRM-5 — the public submit path must stay under the IP budget: it is
  // NOT on the SSE exemption list (asserted at the matcher seam — exhausting
  // the shared per-process limiter in-suite would be order-dependent).
  it('the public submit path is not SSE-exempt from the IP rate limit', async () => {
    const { __isSseExemptPathForTests } = await import('../src/middleware/rateLimit.js');
    expect(__isSseExemptPathForTests('/v1/host/openwop-app/public-forms/form:abc/submit')).toBe(false);
    expect(__isSseExemptPathForTests('/v1/host/openwop-app/channels/ch1/stream')).toBe(true); // the list still works
  });
});

describe('Forms: isolation + gating', () => {
  it('cross-tenant access to another org 404s (IDOR)', async () => {
    const a = await ownerWithOrg();
    const b = await ownerWithOrg(); // different tenant
    const r = await b.owner.get(`/v1/host/openwop-app/forms/orgs/${a.orgId}/forms`);
    expect(r.status).toBe(404);
  });

  it('toggle off ⇒ authed + public both 404', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const form = (await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, CONTACT_FORM)).body;
    await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/status`, { status: 'published' });
    try {
      await enableForms('off');
      expect((await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`)).status).toBe(404);
      expect((await pub.get(`/v1/host/openwop-app/public-forms/${form.formId}`)).status).toBe(404);
    } finally {
      await enableForms('on');
    }
  });
});
