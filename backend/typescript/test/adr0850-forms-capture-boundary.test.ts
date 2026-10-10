/**
 * ADR 0850 — the forms capture boundary. The legs marked RED were witnessed
 * failing on `16a9aab7a` (origin/main when row 32 opened):
 *
 *  D1  (RED) the service-desk sink filed EVERY form submission in the tenant into
 *      the intake org, so the intake org's members read org B's leads (values
 *      verbatim in the ticket body). Now (user decision): a per-form
 *      `createTicket` opt-in, default off, filing into the form's OWN org;
 *  D2  (RED) a REQUIRED checkbox could be designated the email opt-in, so the form
 *      could not be submitted without "consenting", and the sink recorded it as
 *      `legalBasis:'consent'`. Now: refused on create and on a transition; a
 *      legacy conflict saves but records nothing; consent reads the capture-time
 *      snapshot and never re-grants over a newer record;
 *  D3  a held lead can be released by a writer (never a reader), once;
 *  D4  (RED ×2) the post-sink write was a blind `put` of the in-memory row, so a
 *      DSAR erasure or an operator delete that landed while the sinks ran was
 *      undone;
 *  D5  a per-form burst past the ceiling is quarantined (`burst`), never refused,
 *      with the same response a clean submit gets;
 *  D6  the agent's submission read is a bounded page that says it is one, and
 *      excludes held rows unless asked; the persona prompt's inputs stay a true
 *      subset of the tool schema.
 *
 * Sabotage-witnessed (grade-tests w8, probes w8g1-cap-*): the `createTicket` default and
 * own-org filing, the service-desk toggle, `optInIsRequired` on create/update, the
 * consent sink's required/no-re-grant/snapshot rules, `workspace:write` on release, the
 * `!cur.flagged` early return, the post-sink `put`, the claimed-row resume,
 * `overSubmitBurst` (and counting an invalid body), the held filter and the `formId`
 * schema key each turn a case red. Double guards (no single sabotage reaches them):
 * the `erasedAt` arm of the release refusal (the eraser also tombstones every value) and
 * the PATCH `createTicket:'yes'` refusal (route `typeof` + service `=== true`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createWorkspace, createOrg, createMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import {
  createForm, updateForm, setFormStatus, recordSubmission, getSubmission, deleteSubmission, validateValues,
  submissionStatsOf, type FormDef,
} from '../src/features/forms/formsService.js';
import { registerSubmissionSink } from '../src/features/forms/submissionSinks.js';
import { eraseFormsSubject, ERASED_VALUE } from '../src/features/forms/erasure.js';
import { __resetSubmitBurstForTests } from '../src/features/forms/submitBurst.js';
import { setIntakeConfig, getIntakeConfig } from '../src/features/service-desk/intake.js';
import { listTickets } from '../src/features/service-desk/tickets.js';
import { getConsent, recordConsent } from '../src/features/consent/consentService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { FORMS_LIST_SUBMISSIONS_TOOL_ID } from '../src/features/forms/agentTools.js';
import { readFileSync } from 'node:fs';

let server: http.Server;
let BASE = '';
let ws = '';
let orgA = '';
let orgB = '';
let editorCookie = '';
let viewerCookie = '';

const FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
  { key: 'agree', label: 'I agree to the terms', type: 'checkbox', required: true },
  { key: 'news', label: 'Email me news', type: 'checkbox', required: false },
];
const CONTACT_FIELDS = FIELDS.filter((f) => f.key !== 'agree');

/** Probe sinks run LAST (registered after boot) and act on one form only. */
const probe: { formId: string; act?: (tenantId: string, orgId: string, formId: string, submissionId: string) => Promise<void> } = { formId: '' };

const craftCookie = (userId: string, personalTenant: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: ws, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const seat = async (principalId: string, roles: string[]): Promise<string> => {
  const user = await upsertFromPrincipal({ tenantId: ws, principalId, source: 'oidc' });
  await createMember({ tenantId: ws, orgId: ws, subject: user.userId, displayName: principalId, roles });
  return craftCookie(user.userId, `ws:home-${principalId}`);
};
/** The fields these cases read off a response; everything else is ignored. */
type Body = { createTicket?: boolean; released?: boolean; submissionId?: string; details?: { reason?: string } };
const call = async (method: string, path: string, cookie: string | null, body?: unknown): Promise<{ status: number; body: Body | null }> => {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Body) : null };
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'forms', 'service-desk', 'crm', 'email', 'consent']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  ws = (await createWorkspace({ name: 'Forms 0850', ownerSubject: 'oidc:f50-owner' })).tenantId;
  orgA = (await createOrg({ tenantId: ws, createdBy: 'own', name: 'Support A', ownerSubject: 'own' })).orgId;
  orgB = (await createOrg({ tenantId: ws, createdBy: 'own', name: 'Private B', ownerSubject: 'own' })).orgId;
  editorCookie = await seat('oidc:f50-editor', ['editor']);
  viewerCookie = await seat('oidc:f50-viewer', ['viewer']);
  registerSubmissionSink({
    id: 'zz-adr0850-probe',
    async onSubmission(form, submission) {
      if (form.formId !== probe.formId || !probe.act) return undefined;
      await probe.act(submission.tenantId, submission.orgId, submission.formId, submission.submissionId);
      // A marker forces the post-sink write the defect lives in.
      return { error: 'probe-marker' };
    },
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => {
  probe.formId = ''; delete probe.act;
  delete process.env.OPENWOP_FORMS_SUBMIT_PER_MIN;
  __resetSubmitBurstForTests();
});

async function publishedForm(orgId: string, extra: Record<string, unknown> = {}): Promise<FormDef> {
  const form = await createForm({ tenantId: ws, orgId, title: 'Contact', fields: CONTACT_FIELDS, createdBy: 'own', ...extra });
  return (await setFormStatus(ws, orgId, form.formId, 'published'))!;
}
const raw = new DurableCollection<Record<string, unknown> & { submissionId: string }>('forms:submission', (s) => s.submissionId);
const rawForms = new DurableCollection<FormDef>('forms:def', (f) => f.formId);

describe('ADR 0850 D1 — a support ticket is a per-form opt-in, filed in the form\'s own org', () => {
  const ticketsFor = async (orgId: string, submissionId: string) => (await listTickets(ws, orgId)).filter((t) => JSON.stringify(t).includes(submissionId));

  it('a form that did not opt in files no ticket — even in the intake org (default off)', async () => {
    await setIntakeConfig(ws, orgA, 'own');
    expect((await getIntakeConfig(ws))?.defaultOrgId).toBe(orgA);
    const formA = await publishedForm(orgA);
    expect(formA.createTicket).toBeUndefined();
    const sub = await recordSubmission(formA, validateValues(formA, { name: 'Al', email: 'al@a.test' }), {});
    expect(await ticketsFor(orgA, sub.submissionId)).toHaveLength(0);
  });

  it('an opted-in form in org B files into B\'s desk — never into the intake org A', async () => {
    // The intake config names org A, so "never into A" is a live claim even when this case runs alone.
    await setIntakeConfig(ws, orgA, 'own');
    const formB = await publishedForm(orgB, { createTicket: true });
    const sub = await recordSubmission(formB, validateValues(formB, { name: 'Bea Private', email: 'bea@private.test' }), {});
    expect(JSON.stringify(await listTickets(ws, orgA))).not.toContain('bea@private.test');
    expect(await ticketsFor(orgB, sub.submissionId)).toHaveLength(1);
  });

  it('the opt-in is set and cleared over the authed PATCH, by a writer', async () => {
    const form = await publishedForm(ws);
    const path = `/host/openwop-app/forms/orgs/${ws}/forms/${encodeURIComponent(form.formId)}`;
    expect((await call('PATCH', path, viewerCookie, { createTicket: true })).status).toBe(403);
    expect((await call('PATCH', path, editorCookie, { createTicket: 'yes' })).body?.createTicket).toBeUndefined();
    expect((await call('PATCH', path, editorCookie, { createTicket: true })).body?.createTicket).toBe(true);
    expect((await call('PATCH', path, editorCookie, { createTicket: false })).body?.createTicket).toBeUndefined();
  });

  it('with the service desk switched off, an opted-in form files nothing', async () => {
    const d = getToggleDefault('service-desk')!;
    await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      const form = await publishedForm(orgA, { createTicket: true });
      const sub = await recordSubmission(form, validateValues(form, { name: 'Off', email: 'off@x.test' }), {});
      expect(await ticketsFor(orgA, sub.submissionId)).toHaveLength(0);
    } finally {
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
});

describe('ADR 0850 D2 — consent is never a condition of submitting', () => {
  it('a required checkbox cannot be designated the email opt-in on create', async () => {
    await expect(createForm({ tenantId: ws, orgId: orgA, title: 'Bundled', createdBy: 'own', fields: FIELDS, emailOptInField: 'agree' }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it('an update cannot move INTO the conflict, either way round', async () => {
    const form = await createForm({ tenantId: ws, orgId: orgA, title: 'Opt', createdBy: 'own', fields: FIELDS, emailOptInField: 'news' });
    await expect(updateForm(ws, orgA, form.formId, { emailOptInField: 'agree' })).rejects.toMatchObject({ httpStatus: 400 });
    const madeRequired = FIELDS.map((f) => (f.key === 'news' ? { ...f, required: true } : f));
    await expect(updateForm(ws, orgA, form.formId, { fields: madeRequired, emailOptInField: 'news' })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('a pre-ADR conflict still saves unrelated edits, and records no consent', async () => {
    const form = await publishedForm(orgA, { fields: FIELDS, createToContact: true, emailOptInField: 'news' });
    // Seed the legacy conflict the way it exists in stored rows: written before the rule.
    const legacy: FormDef = { ...form, fields: FIELDS.map((f) => (f.key === 'news' ? { ...f, required: true } : f)) as FormDef['fields'] };
    await rawForms.put(legacy);
    const saved = await updateForm(ws, orgA, form.formId, { title: 'Renamed', emailOptInField: 'news' });
    expect(saved?.title).toBe('Renamed');
    const sub = await recordSubmission(legacy, validateValues(legacy, { name: 'Leg', email: 'leg@x.test', agree: true, news: true }), {});
    expect(sub.optIn).toEqual({ field: 'news', label: 'Email me news', required: true });
    const row = await getSubmission(ws, orgA, form.formId, sub.submissionId);
    expect(row?.contactId).toMatch(/^crm:/);
    expect((await getConsent(ws, row!.contactId!))?.categories['marketing.email']).not.toBe(true);
  });

  it('a clean opt-in records consent whose receipt names the submission', async () => {
    const form = await publishedForm(orgA, { fields: FIELDS, createToContact: true, emailOptInField: 'news' });
    const sub = await recordSubmission(form, validateValues(form, { name: 'Ok', email: 'ok@x.test', agree: true, news: true }), {});
    const row = await getSubmission(ws, orgA, form.formId, sub.submissionId);
    const consent = await getConsent(ws, row!.contactId!);
    expect(consent?.categories['marketing.email']).toBe(true);
    expect(consent?.source).toBe(`form-optin:${form.formId}:${sub.submissionId}`);
  });
});

describe('ADR 0850 D3 — an operator releases a held submission', () => {
  const RELEASE = (formId: string, subId: string) => `/host/openwop-app/forms/orgs/${ws}/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(subId)}/release`;

  it('a viewer cannot; a writer can, exactly once, and the lead is delivered', async () => {
    const form = await publishedForm(ws, { createToContact: true });
    const held = await recordSubmission(form, validateValues(form, { name: 'Real Person', email: 'real@x.test' }), {}, undefined, 'honeypot');
    expect(held.contactId).toBeUndefined();
    expect((await submissionStatsOf(form.formId)).flaggedCount).toBe(1);

    expect((await call('POST', RELEASE(form.formId, held.submissionId), viewerCookie)).status).toBe(403);
    expect((await call('POST', RELEASE(form.formId, held.submissionId), null)).status).toBe(401);

    const first = await call('POST', RELEASE(form.formId, held.submissionId), editorCookie);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body?.released).toBe(true);
    const row = await getSubmission(ws, ws, form.formId, held.submissionId);
    expect(row?.flagged).toBeUndefined();
    expect(row?.releasedAt).toBeTruthy();
    expect(row?.contactId).toMatch(/^crm:/); // the CRM sink ran
    const stats = await submissionStatsOf(form.formId);
    expect(stats.flaggedCount).toBe(0);
    expect(stats.count).toBe(1);

    const again = await call('POST', RELEASE(form.formId, held.submissionId), editorCookie);
    expect(again.body?.released).toBe(false);
    expect((await submissionStatsOf(form.formId)).count).toBe(1);
  });

  it('an erased held row is refused, and a wrong form id is a uniform 404', async () => {
    const form = await publishedForm(ws);
    const held = await recordSubmission(form, validateValues(form, { name: 'Gone', email: 'gone@x.test' }), {}, undefined, 'guard');
    await eraseFormsSubject(ws, 'gone@x.test');
    const r = await call('POST', RELEASE(form.formId, held.submissionId), editorCookie);
    expect(r.status).toBe(409);
    expect((await call('POST', RELEASE('form:nope', held.submissionId), editorCookie)).status).toBe(404);
  });

  it('a release never re-grants consent over a newer record (an unsubscribe after the tick)', async () => {
    const form = await publishedForm(ws, { fields: FIELDS, createToContact: true, emailOptInField: 'news' });
    // A clean capture first, so the contact exists; then the held tick, then an opt-out.
    const first = await recordSubmission(form, validateValues(form, { name: 'Uns', email: 'uns@x.test', agree: true }), {});
    const contactId = (await getSubmission(ws, ws, form.formId, first.submissionId))!.contactId!;
    const held = await recordSubmission(form, validateValues(form, { name: 'Uns', email: 'uns@x.test', agree: true, news: true }), {}, undefined, 'honeypot');
    // The sink compares the consent record's `ts` to the held row's `createdAt` (ISO, ms): wait
    // for the clock to pass the capture so the unsubscribe is strictly NEWER (no fixed sleep).
    await vi.waitFor(() => expect(new Date().toISOString() > held.createdAt).toBe(true));
    await recordConsent({ tenantId: ws, subjectKey: contactId, categories: { 'marketing.email': false }, source: 'preference-centre' });
    const r = await call('POST', RELEASE(form.formId, held.submissionId), editorCookie);
    expect(r.body?.released).toBe(true);
    expect((await getConsent(ws, contactId))?.categories['marketing.email']).toBe(false);
  });

  it('a release reads the opt-in the visitor saw, not a later re-designation', async () => {
    const form = await publishedForm(ws, { fields: [...FIELDS, { key: 'other', label: 'Something else', type: 'checkbox', required: false }], createToContact: true });
    // No opt-in when captured: the tick on `other` meant nothing about email.
    const held = await recordSubmission(form, validateValues(form, { name: 'Snap', email: 'snap@x.test', agree: true, other: true }), {}, undefined, 'honeypot');
    expect(held.optIn).toBeUndefined();
    await updateForm(ws, ws, form.formId, { emailOptInField: 'other' });
    await call('POST', RELEASE(form.formId, held.submissionId), editorCookie);
    const row = await getSubmission(ws, ws, form.formId, held.submissionId);
    expect((await getConsent(ws, row!.contactId!))?.categories['marketing.email']).not.toBe(true);
  });
});

describe('ADR 0850 D4 — the post-sink write never undoes an erasure or a delete', () => {
  it('an erasure that lands while the sinks run stays erased', async () => {
    const form = await publishedForm(orgA);
    probe.formId = form.formId;
    probe.act = async (tenantId) => { await eraseFormsSubject(tenantId, 'eve@erase.test'); };
    const sub = await recordSubmission(form, validateValues(form, { name: 'Eve', email: 'eve@erase.test' }), { referrer: 'https://x.test' });
    const row = await getSubmission(ws, orgA, form.formId, sub.submissionId);
    expect(row?.values.email).toBe(ERASED_VALUE);
    expect(row?.values.name).toBe(ERASED_VALUE);
    expect(row?.meta).toEqual({});
    expect(row?.erasedAt).toBeTruthy();
  });

  it('a delete that lands while the sinks run is not re-created, and its occupancy is credited once', async () => {
    const form = await publishedForm(orgA);
    probe.formId = form.formId;
    probe.act = async (tenantId, orgId, formId, submissionId) => { await deleteSubmission(tenantId, orgId, formId, submissionId); };
    const sub = await recordSubmission(form, validateValues(form, { name: 'Del', email: 'del@x.test' }), {});
    expect(await getSubmission(ws, orgA, form.formId, sub.submissionId)).toBeNull();
    expect(await raw.get(sub.submissionId)).toBeNull();
    expect((await submissionStatsOf(form.formId)).count).toBe(0);
  });
});

describe('ADR 0850 D4 — a removal whose delete threw is finished, never stranded (grade-code FRM2CD-1)', () => {
  it('the claimed row is invisible, and the next eraser pass deletes it and credits occupancy once', async () => {
    const form = await publishedForm(orgA);
    const sub = await recordSubmission(form, validateValues(form, { name: 'Strand', email: 'strand@x.test' }), {});
    expect((await submissionStatsOf(form.formId)).count).toBe(1);
    const spy = vi.spyOn(DurableCollection.prototype, 'delete').mockRejectedValueOnce(new Error('kv blip'));
    await expect(deleteSubmission(ws, orgA, form.formId, sub.submissionId)).rejects.toThrow('kv blip');
    spy.mockRestore();
    expect((await raw.get(sub.submissionId))?.removing).toBe(true); // stranded, PII still stored
    expect(await getSubmission(ws, orgA, form.formId, sub.submissionId)).toBeNull();
    // A DSAR for the respondent must not report success over the stranded row.
    await eraseFormsSubject(ws, 'strand@x.test');
    expect(await raw.get(sub.submissionId)).toBeNull();
    expect((await submissionStatsOf(form.formId)).count).toBe(0);
  });

  it('a held row erased BEFORE `erasedAt` existed is refused release by its values (FRM2CD-2)', async () => {
    const form = await publishedForm(ws);
    const held = await recordSubmission(form, validateValues(form, { name: 'Old', email: 'old@x.test' }), {}, undefined, 'honeypot');
    const legacy = { ...(await raw.get(held.submissionId))!, values: { name: ERASED_VALUE, email: ERASED_VALUE }, meta: {} };
    await raw.put(legacy);
    const r = await call('POST', `/host/openwop-app/forms/orgs/${ws}/forms/${encodeURIComponent(form.formId)}/submissions/${encodeURIComponent(held.submissionId)}/release`, editorCookie);
    expect(r.status).toBe(409);
    expect(r.body?.details?.reason).toBe('submission_erased');
  });
});

describe('ADR 0850 D5 — a per-form burst is held, never refused', () => {
  it('past the ceiling a clean submit answers like any other and is quarantined as burst', async () => {
    process.env.OPENWOP_FORMS_SUBMIT_PER_MIN = '2';
    const form = await publishedForm(orgA);
    const url = `/host/openwop-app/public-forms/${encodeURIComponent(form.formId)}/submit`;
    // An invalid body FIRST: it is a 400 and must not count toward the window — if it did,
    // the SECOND clean submit below would already be the burst.
    expect((await call('POST', url, null, { values: { name: 'x' } })).status).toBe(400);
    const submit = (n: number) => call('POST', url, null, { values: { name: `B${n}`, email: `b${n}@x.test` } });
    const answers = [await submit(1), await submit(2), await submit(3)];
    expect(answers.map((a) => a.status)).toEqual([201, 201, 201]);
    expect(Object.keys(answers[2]!.body ?? {}).sort()).toEqual(Object.keys(answers[0]!.body ?? {}).sort());
    const rowOf = (i: number) => getSubmission(ws, orgA, form.formId, answers[i]!.body!.submissionId!);
    expect((await rowOf(2))?.flagged).toBe('burst');
    expect((await rowOf(0))?.flagged).toBeUndefined();
    expect((await rowOf(1))?.flagged, 'an invalid body never counts toward the window').toBeUndefined();
  });
});

describe('ADR 0850 D6 — the agent reads a bounded page and is told so', () => {
  it('newest first, limit honoured, held rows excluded by default, total + truncated + note', async () => {
    const form = await publishedForm(orgA);
    for (let i = 0; i < 4; i += 1) await recordSubmission(form, validateValues(form, { name: `L${i}`, email: `l${i}@x.test` }), {});
    await recordSubmission(form, validateValues(form, { name: 'Bot', email: 'bot@x.test' }), {}, undefined, 'honeypot');
    const tool = createAgentToolProvider({ tenantId: ws, actingUserId: 'own' });
    const out = await tool.executeTool({ name: FORMS_LIST_SUBMISSIONS_TOOL_ID, input: { formId: form.formId, orgId: orgA, limit: 2 } });
    const body = JSON.parse(out.content) as { total: number; heldCount: number; truncated: boolean; note?: string; submissions: Array<{ values: { name: string }; flagged?: string }> };
    expect(body.total).toBe(4);
    expect(body.heldCount).toBe(1);
    expect(body.truncated).toBe(true);
    expect(body.note).toMatch(/newest 2 of 4/);
    // Newest-first is `createdAt` order; rows recorded in one millisecond tie, so
    // assert the page, not the tie-break.
    expect(body.submissions).toHaveLength(2);
    expect(body.submissions.every((s) => s.values.name.startsWith('L') && !s.flagged)).toBe(true);
    const withHeld = JSON.parse((await tool.executeTool({ name: FORMS_LIST_SUBMISSIONS_TOOL_ID, input: { formId: form.formId, orgId: orgA, includeHeld: true } })).content) as typeof body;
    expect(withHeld.total).toBe(5);
    expect(withHeld.truncated).toBe(false);
    expect(withHeld.submissions.some((s) => s.flagged === 'honeypot')).toBe(true);
  });

  it('the persona prompt names only inputs the tool schema declares (hand-copied text, pinned)', () => {
    const prompt = readFileSync(new URL('../../../packs/vendor.openwop-app.forms.agents/prompts/forms-lead-insights.md', import.meta.url), 'utf8');
    const props = createAgentToolProvider({ tenantId: ws }).resolveTool(FORMS_LIST_SUBMISSIONS_TOOL_ID)?.inputSchema.properties;
    expect(props, 'the tool declares an input schema').toBeTypeOf('object');
    const line = /`openwop:forms\.list-submissions`[\s\S]*?Input:\s*`\{([^}]*)\}`/.exec(prompt);
    expect(line, 'the prompt documents the tool input').not.toBeNull();
    const named = line![1]!.split(',').map((k) => k.trim().replace(/\?$/, '')).filter(Boolean);
    expect(named.length).toBeGreaterThan(0);
    for (const k of named) expect(Object.keys(Object(props)), `prompt names \`${k}\``).toContain(k);
  });
});
