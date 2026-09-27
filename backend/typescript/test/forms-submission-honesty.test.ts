/**
 * ADR 0584 — the four backend halves of the Forms submission-honesty batch.
 *
 *  - FORM-UX-1: an abuse-control trip QUARANTINES rather than destroys; past the
 *    quarantine budget it REFUSES (429) instead of answering with a thank-you;
 *    the operator sees both numbers.
 *  - FORM-1: the ADR 0464 subject eraser reaches a respondent who never became a
 *    CRM contact (the majority case), and leaves the row as the org's record.
 *  - FORM-2: `meta.utm` / `meta.referrer` are bounded on the public write path.
 *  - FORM-3: the at-most-once guard is atomic, so CONCURRENT same-key submits
 *    produce ONE row and ONE set of sink effects. This is the case the existing
 *    sequential FRMB-IDEM pin structurally cannot see.
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

interface Res { status: number; body: any }
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

const FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
];

async function fixture(createToContact = false): Promise<{ user: ReturnType<typeof client>; tenantId: string; orgId: string; formId: string; F: string }> {
  const user = client();
  await user.post('/v1/host/openwop-app/test/login', { email: `fsh-${Date.now()}-${n++}@acme.test` });
  const me = await user.get('/v1/host/openwop-app/users/me');
  const org = await user.post('/v1/host/openwop-app/orgs', { name: 'Honest Co' });
  const orgId: string = org.body.orgId;
  const form = await user.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, { title: 'Contact', fields: FIELDS, createToContact });
  const formId: string = form.body.formId;
  await user.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${formId}/status`, { status: 'published' });
  return { user, tenantId: me.body?.user?.tenantId ?? me.body?.tenantId, orgId, formId, F: `/v1/host/openwop-app/forms/orgs/${orgId}/forms/${formId}` };
}

const submit = (formId: string, body: Record<string, unknown>) =>
  client().post(`/v1/host/openwop-app/public-forms/${encodeURIComponent(formId)}/submit`, body);

describe('FORM-UX-1 — an abuse-control trip is quarantined, never silently destroyed', () => {
  it('a GUARD denial stores the row, skips the sinks, and is counted', async () => {
    const { registerSubmitGuard, clearSubmitGuardsForTest } = await import('../src/features/forms/submitGuards.js');
    const { user, F, formId } = await fixture(true); // CRM destination ON
    registerSubmitGuard({ id: 'test-deny-all', check: async () => 'deny' });
    try {
      const r = await submit(formId, { values: { name: 'Real Person', email: 'real@x.com' } });
      // Same shape as a clean submit: the endpoint is not a spam oracle.
      expect(r.status).toBe(201);
      expect(typeof r.body.submissionId).toBe('string');
      const page = (await user.get(`${F}/submissions?limit=50`)).body;
      expect(page.submissions).toHaveLength(1);
      expect(page.submissions[0].flagged).toBe('guard');
      // The whole point of quarantine: STORED, but nothing moved downstream.
      expect(page.submissions[0].contactId).toBeUndefined();
      expect(page.flaggedCount).toBe(1);
      expect(page.droppedCount).toBe(0);
    } finally { clearSubmitGuardsForTest(); }
  });

  it('past the QUARANTINE budget it refuses honestly (429) and counts the drop — it never says thank-you', async () => {
    const { __setSubmissionCountForTests, MAX_FLAGGED_PER_FORM } = await import('../src/features/forms/formsService.js');
    const { user, F, formId } = await fixture();
    const form = (await user.get(F)).body;
    await __setSubmissionCountForTests(formId, form.tenantId ?? (await user.get(`${F}`)).body.tenantId, 0, MAX_FLAGGED_PER_FORM);
    const r = await submit(formId, { values: { name: 'Bot', email: 'b@x.com', _hp_ref: 'x' } });
    // A refusal the respondent can SEE. The old code answered 200 {ok:true}.
    expect(r.status).toBe(429);
    const page = (await user.get(`${F}/submissions?limit=50`)).body;
    expect(page.submissions).toHaveLength(0);
    // …and the operator still learns it happened, even with no row to count.
    expect(page.droppedCount).toBe(1);
  });

  it('the quarantine budget is SEPARATE from the lead ceiling — bot volume cannot crowd out capture', async () => {
    const { __setSubmissionCountForTests, MAX_FLAGGED_PER_FORM } = await import('../src/features/forms/formsService.js');
    const { user, F, formId } = await fixture();
    const stored = (await user.get(F)).body;
    await __setSubmissionCountForTests(formId, stored.tenantId, 0, MAX_FLAGGED_PER_FORM);
    // The flagged budget is exhausted (above) yet a REAL lead still lands.
    const clean = await submit(formId, { values: { name: 'Ada', email: 'ada@x.com' } });
    expect(clean.status).toBe(201);
    expect((await user.get(`${F}/submissions?limit=50`)).body.submissions).toHaveLength(1);
  });
});

describe('FORM-2 — public `meta` is bounded like its sibling `context`', () => {
  it('drops unknown utm keys and caps the values + the referrer', async () => {
    const { user, F, formId } = await fixture();
    const long = 'x'.repeat(5_000);
    await submit(formId, {
      values: { name: 'Ada', email: 'ada@x.com' },
      referrer: `https://ref.example/${long}`,
      utm: {
        utm_source: `news${long}`,
        utm_campaign: 'aug',
        // Neither of these is on the closed allowlist.
        utm_evil: 'payload',
        arbitrary_key: 'payload',
      },
    });
    const row = (await user.get(`${F}/submissions?limit=50`)).body.submissions[0];
    expect(Object.keys(row.meta.utm).sort()).toEqual(['utm_campaign', 'utm_source']);
    expect(row.meta.utm.utm_source.length).toBe(1_024);
    expect(row.meta.referrer.length).toBe(1_024);
  });

  it('a hostile key COUNT cannot grow the row (the open Object.entries loop is gone)', async () => {
    const { user, F, formId } = await fixture();
    const utm: Record<string, string> = {};
    for (let i = 0; i < 500; i += 1) utm[`utm_${i}`] = 'v';
    await submit(formId, { values: { name: 'Ada', email: 'ada2@x.com' }, utm });
    const row = (await user.get(`${F}/submissions?limit=50`)).body.submissions[0];
    expect(row.meta.utm).toBeUndefined(); // not one of the 500 survived
  });
});

describe('FORM-3 — the at-most-once guard is ATOMIC (the case the sequential pin cannot see)', () => {
  /**
   * WHY THIS DRIVES THE SERVICE AND NOT THE ROUTE. The first cut of this test
   * fired three concurrent HTTP submits and passed — but the LOG showed
   * `submission_captured` followed by two `submission_replayed`, i.e. the first
   * request had already persisted before the others reached the read. That
   * result is produced by the OLD read-then-write just as happily, so the
   * assertion discriminated nothing. Racing the service directly puts all three
   * callers past `submissions.get()` before any of them writes, which IS the
   * window the defect lives in.
   *
   * NON-VACUITY, MEASURED: with `compareAndSwap(null, submission)` reverted to
   * `submissions.put(submission)` this test goes RED — 3 rows, 3 sink runs.
   */
  it('CONCURRENT same-key submits produce ONE row and run the sinks ONCE', async () => {
    const { getForm, recordSubmission, listSubmissions } = await import('../src/features/forms/formsService.js');
    const { user, F, orgId, formId } = await fixture(true); // CRM destination ON
    const tenantId = (await user.get(F)).body.tenantId;
    const form = await getForm(tenantId, orgId, formId);
    expect(form, 'the fixture must resolve — otherwise every assertion below is hollow').toBeTruthy();

    const clientKey = `ck-${Date.now()}`;
    const values = { name: 'Grace', email: 'grace@x.com' };
    // The real scenario: a double-click on a slow connection. Under the old
    // read-then-write all three read `null`, all three fell through the cap and
    // the counter, and ALL THREE ran the sinks — duplicate rows and duplicate
    // CRM contacts from the app's highest-volume unauthenticated write path.
    const settled = await Promise.allSettled([
      recordSubmission(form!, values, {}, clientKey),
      recordSubmission(form!, values, {}, clientKey),
      recordSubmission(form!, values, {}, clientKey),
    ]);
    const ids = new Set(settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value.submissionId] : [])));
    expect(ids.size, 'every winner and every replay must resolve to the SAME id').toBe(1);

    const rows = await listSubmissions(tenantId, orgId, formId);
    expect(rows).toHaveLength(1);
    // ONE contact, not three — the sinks ran exactly once.
    const contacts = (await user.get('/v1/host/openwop-app/crm/contacts')).body;
    const matching = (contacts.contacts ?? []).filter((c: { email?: string }) => c.email === 'grace@x.com');
    expect(matching).toHaveLength(1);
  });
});

describe('FORM-1 — a DSAR reaches a respondent who never became a contact', () => {
  it('erases the answers and the tracking meta, KEEPS the row, and is idempotent', async () => {
    const { eraseFormsSubject, ERASED_VALUE } = await import('../src/features/forms/erasure.js');
    const { user, F, formId } = await fixture(); // createToContact OFF — the majority case
    await submit(formId, {
      values: { name: 'Rosalind', email: 'Rosalind@X.com' },
      referrer: 'https://ref.example/a',
      utm: { utm_source: 'news' },
    });
    const before = (await user.get(`${F}/submissions?limit=50`)).body.submissions[0];
    expect(before.contactId).toBeUndefined(); // nothing else could have reached it
    const tenantId = (await user.get(F)).body.tenantId;

    // Case-folded, exact-match — the address the person actually typed.
    await eraseFormsSubject(tenantId, 'rosalind@x.com');
    const after = (await user.get(`${F}/submissions?limit=50`)).body.submissions[0];
    expect(after.submissionId).toBe(before.submissionId); // the row SURVIVES
    expect(after.values.name).toBe(ERASED_VALUE);
    expect(after.values.email).toBe(ERASED_VALUE);
    expect(Object.keys(after.values).sort()).toEqual(['email', 'name']); // keys kept
    expect(after.meta.referrer).toBeUndefined();
    expect(after.meta.utm).toBeUndefined();

    // Idempotent — the seam invokes an eraser once per LINKED key.
    await eraseFormsSubject(tenantId, 'rosalind@x.com');
    const again = (await user.get(`${F}/submissions?limit=50`)).body.submissions[0];
    expect(again.values.name).toBe(ERASED_VALUE);
  });

  it('an OPAQUE subject key is never matched against free text (no over-erasure)', async () => {
    const { eraseFormsSubject, ERASED_VALUE } = await import('../src/features/forms/erasure.js');
    const { user, F, formId } = await fixture();
    await submit(formId, { values: { name: 'Alan', email: 'alan@x.com' } });
    const tenantId = (await user.get(F)).body.tenantId;
    // Not email-shaped ⇒ the values leg must not fire, even though 'Alan' is a
    // value in the row. A substring or fuzzy match here would erase strangers.
    await eraseFormsSubject(tenantId, 'Alan');
    const row = (await user.get(`${F}/submissions?limit=50`)).body.submissions[0];
    expect(row.values.name).not.toBe(ERASED_VALUE);
  });
});

/**
 * ADR 0584 §Correction — the adversarial-review fold-in (PR #3368 R2).
 *
 * Each case below covers a defect the shipped batch INTRODUCED or left
 * standing, not a property of the code it replaced.
 */
describe('FORM-BUDGET-1 — the quarantine budget is OCCUPANCY, so the recovery promise does not expire', () => {
  it('a RETENTION PURGE gives flagged budget back (it shipped as a lifetime tally nothing decremented)', async () => {
    const { __setSubmissionCountForTests, submissionStatsOf, MAX_FLAGGED_PER_FORM } = await import('../src/features/forms/formsService.js');
    const { purgeRetained } = await import('../src/host/retentionPurger.js');
    const { user, F, formId } = await fixture();
    const tenantId = (await user.get(F)).body.tenantId;

    // One trip below the budget, so the NEXT one is stored…
    await __setSubmissionCountForTests(formId, tenantId, 0, MAX_FLAGGED_PER_FORM - 1);
    expect((await submit(formId, { values: { name: 'PM Filled It', email: 'pm@x.com', _hp_ref: 'x' } })).status).toBe(201);
    expect((await submissionStatsOf(formId)).flaggedCount).toBe(MAX_FLAGGED_PER_FORM);
    // …and the one after that is refused, because the budget is now full.
    expect((await submit(formId, { values: { name: 'Also Real', email: 'also@x.com', _hp_ref: 'x' } })).status).toBe(429);

    // A purge whose cutoff is in the FUTURE reclaims every row of this tenant.
    const results = await purgeRetained(tenantId, 'confidential-pii', new Date(Date.now() + 60_000).toISOString());
    const forms = results.find((r) => r.feature === 'forms');
    expect(forms?.ok).toBe(true);
    expect(forms?.deleted).toBeGreaterThanOrEqual(1);
    // THE ASSERTION: the counter FELL. Before this fix nothing in src/ ever
    // decremented it, so it stayed pinned at the budget forever and every later
    // trip — including a real person's — took the drop path.
    expect((await submissionStatsOf(formId)).flaggedCount).toBe(MAX_FLAGGED_PER_FORM - 1);
    // …and the freed budget is REAL: a trip is quarantined again, not dropped.
    expect((await submit(formId, { values: { name: 'Recovered', email: 'rec@x.com', _hp_ref: 'x' } })).status).toBe(201);
  });

  it('deleting ONE held submission frees exactly one unit of budget (the operator lever)', async () => {
    const { submissionStatsOf } = await import('../src/features/forms/formsService.js');
    const { user, F, formId } = await fixture();
    await submit(formId, { values: { name: 'Bot', email: 'bot@x.com', _hp_ref: 'x' } });
    await submit(formId, { values: { name: 'Ada', email: 'ada-clean@x.com' } });
    const held = (await user.get(`${F}/submissions?limit=50`)).body.submissions.find((s: any) => s.flagged);
    expect((await submissionStatsOf(formId)).flaggedCount).toBe(1);

    expect((await user.del(`${F}/submissions/${held.submissionId}`)).status).toBe(204);
    const stats = await submissionStatsOf(formId);
    expect(stats.flaggedCount).toBe(0);
    // The CLEAN row's own counter is untouched — the two buckets never bleed.
    expect(stats.count).toBe(1);
    const rows = (await user.get(`${F}/submissions?limit=50`)).body.submissions;
    expect(rows).toHaveLength(1);
    expect(rows[0].flagged).toBeUndefined();
  });

  it('the delete is tenant+org+form-guarded and never goes negative', async () => {
    const { submissionStatsOf } = await import('../src/features/forms/formsService.js');
    const { user, F, formId } = await fixture();
    const other = await fixture();
    await submit(formId, { values: { name: 'Bot', email: 'b2@x.com', _hp_ref: 'x' } });
    const held = (await user.get(`${F}/submissions?limit=50`)).body.submissions[0];

    // Another workspace's operator cannot reach it (uniform 404, not a probe).
    expect((await other.user.del(`${other.F}/submissions/${held.submissionId}`)).status).toBe(404);
    expect((await submissionStatsOf(formId)).flaggedCount).toBe(1);
    // The same delete twice: the second is a 404, and the counter floors at 0.
    expect((await user.del(`${F}/submissions/${held.submissionId}`)).status).toBe(204);
    expect((await user.del(`${F}/submissions/${held.submissionId}`)).status).toBe(404);
    expect((await submissionStatsOf(formId)).flaggedCount).toBe(0);
  });
});

describe('FORM-QUAR-1 — a held submission is refused by the workflow surface, not merely un-announced', () => {
  it('the surface returns `flagged`, so `get-submission` can decline to file it', async () => {
    const { buildFormsSurface } = await import('../src/features/forms/surface.js');
    const { user, F, formId, orgId } = await fixture();
    await submit(formId, { values: { name: 'Bot', email: 'surf@x.com', _hp_ref: 'x' } });
    const tenantId = (await user.get(F)).body.tenantId;
    const held = (await user.get(`${F}/submissions?limit=50`)).body.submissions[0];

    const surface = buildFormsSurface({ tenantId } as never);
    const out = await surface.getSubmission!({ orgId, formId, submissionId: held.submissionId });
    expect(out.found).toBe(true);
    // The bit the node branches on. Without it the ONLY thing keeping a held
    // lead out of priority-matrix intake was that the host event never fires —
    // an absence a tenant undoes by binding the chain to another trigger.
    expect(out.flagged).toBe('honeypot');
  });

  it('a CLEAN submission still carries no `flagged` key (the marker means something)', async () => {
    const { buildFormsSurface } = await import('../src/features/forms/surface.js');
    const { user, F, formId, orgId } = await fixture();
    await submit(formId, { values: { name: 'Ada', email: 'clean-surf@x.com' } });
    const tenantId = (await user.get(F)).body.tenantId;
    const row = (await user.get(`${F}/submissions?limit=50`)).body.submissions[0];
    const out = await buildFormsSurface({ tenantId } as never).getSubmission!({ orgId, formId, submissionId: row.submissionId });
    expect(out.flagged).toBeUndefined();
  });
});

describe('FORM-FUNNEL-1 — a quarantined submission fires no funnel-completion event', () => {
  it('`isSubmissionHeld` is true only for a held row in the SAME tenant', async () => {
    const { isSubmissionHeld } = await import('../src/features/forms/formsService.js');
    const { user, F, formId } = await fixture();
    await submit(formId, { values: { name: 'Bot', email: 'fn@x.com', _hp_ref: 'x' } });
    await submit(formId, { values: { name: 'Ada', email: 'fn-clean@x.com' } });
    const tenantId = (await user.get(F)).body.tenantId;
    const rows = (await user.get(`${F}/submissions?limit=50`)).body.submissions;
    const held = rows.find((s: any) => s.flagged);
    const clean = rows.find((s: any) => !s.flagged);

    expect(await isSubmissionHeld(tenantId, held.submissionId)).toBe(true);
    // A clean row must NOT withhold its completion — that would silently zero a
    // real funnel's conversion numbers.
    expect(await isSubmissionHeld(tenantId, clean.submissionId)).toBe(false);
    // Cross-tenant and unknown ids degrade to "not held", i.e. to the behaviour
    // that shipped: an anonymous caller must not be able to provoke a refusal.
    expect(await isSubmissionHeld('tenant:someone-else', held.submissionId)).toBe(false);
    expect(await isSubmissionHeld(tenantId, 'sub:does-not-exist')).toBe(false);
    expect(await isSubmissionHeld('', held.submissionId)).toBe(false);
  });
});
