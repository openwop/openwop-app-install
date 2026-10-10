/**
 * ADR 0848 — the email feature's store integrity and egress exits (feature loop
 * 2026-10 row 30). Every `describe` names the decision it witnesses; each was RED on
 * `e5088d4ae` (origin/main before this change) — see the ADR's implementation record.
 *
 * D1 (#4485) — `email:template` / `email:campaign` are keyed by id ALONE, and the
 *   create paths looked for a "prior" row through the tenant+org-FILTERED getter, so a
 *   row another tenant (or org) held read as absent and the blind put took it.
 * D2 — the run surface's `createDraftCampaign` writes, but the ADR 0832 floor asked
 *   only read tier of it.
 * D3 — a bounce-webhook config could be re-keyed / deleted from another org.
 * D4 — sender identity was an editor setting.
 * D5 — test-send was an unmetered relay.
 * D6 — contact data was promoted to a link (and could carry CR/LF into the subject).
 * D7 / D7a — no RFC 8058 header; and a campaign with no link base shipped with no
 *   unsubscribe link at all.
 * D8 — the public consent pages could be framed.
 * D9 — engagement erasure left events behind, and an unread store read as green.
 *
 * Re-witnessed (grade-tests w9): 29 single-site sabotages, one or more per decision, each
 * red the case that names it (see the w9 tracker row). H2 is asserted on the PROJECTED
 * tenant read: `listForTenantIndexed` re-checks each row's tenant (ADR 0848 M2), so it
 * self-heals a foreign marker and could never see the H2 defect — the projected read
 * trusts the marker, which is exactly the reader the leftover marker would lie to.
 * HONEST CEILING: D5's budget is keyed on the wall-clock HOUR inside the route (no
 * injectable `now`), so a run straddling `:00` resets the budget mid-case.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createOrg } from '../src/host/accessControlService.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import {
  createTemplate, createCampaign, getTemplate, getCampaign, listTemplates, listCampaigns,
  sendCampaign, setSenderAddress, deleteCampaign, type EmailMessage, type EmailProvider,
} from '../src/features/email/emailService.js';
import { buildEmailSurface } from '../src/features/email/surface.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { mintToken, recordClick, deleteSubjectEngagement, listEngagement } from '../src/features/email/engagementService.js';
import { setWebhookConfig, listWebhookConfigs } from '../src/features/email/bounceWebhooks.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'email', 'crm']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => {
  delete process.env.OPENWOP_EMAIL_LINK_BASE_URL;
  delete process.env.OPENWOP_EMAIL_TEST_SEND_PER_HOUR;
  vi.restoreAllMocks();
});

/** The error envelope every failing route answers with (plus whatever a success body carries). */
type ApiBody = { error?: string; message?: string; details?: Record<string, unknown> } & Record<string, unknown>;
interface Res<T> { status: number; body: T; headers: Headers }
function client() {
  let cookie = '';
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    // The JSON decode boundary: each call site names the body shape it expects, and the
    // assertion that reads a field is what fails on a mismatch (no `any` past this line).
    const parsed: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: parsed as T, headers: res.headers };
  };
  return {
    get: <T = ApiBody,>(p: string) => call<T>('GET', p),
    post: <T = ApiBody,>(p: string, b?: unknown) => call<T>('POST', p, b),
    put: <T = ApiBody,>(p: string, b?: unknown) => call<T>('PUT', p, b),
  };
}
const uniq = (who: string) => `${who}-${Date.now()}-${n++}@acme.test`;
const EM = (orgId: string) => `/host/openwop-app/email/orgs/${encodeURIComponent(orgId)}`;

type Login = { user: { userId: string } };
/** An owner, an editor and a viewer in one org of one shared tenant. */
async function workspace() {
  const tenantId = `org:a0848-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post<Login>('/host/openwop-app/test/login', { email: uniq('own'), tenantId })).body.user.userId;
  const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'MailCo' })).body.orgId;
  const editor = client();
  const editorId = (await editor.post<Login>('/host/openwop-app/test/login', { email: uniq('edit'), tenantId })).body.user.userId;
  await createMember({ tenantId, orgId, subject: editorId, displayName: 'E', roles: ['editor'] });
  const viewer = client();
  const viewerId = (await viewer.post<Login>('/host/openwop-app/test/login', { email: uniq('view'), tenantId })).body.user.userId;
  await createMember({ tenantId, orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
  return { tenantId, orgId, owner, ownerId, editor, editorId, viewer, viewerId };
}

/** A capturing provider (not the console stub, so sends are attempted). */
function capture(): { provider: EmailProvider; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { sent, provider: { id: 'capture', async send(m) { sent.push(m); } } };
}

describe('ADR 0848 D1 (#4485) — a caller-chosen template/campaign id never takes another workspace\'s row', () => {
  const TA = 'org:a0848-d1-a';
  const TB = 'org:a0848-d1-b';

  it('another TENANT creating the same template id is refused and the owner keeps its row', async () => {
    const id = 'tpl:a0848-shared';
    await createTemplate({ tenantId: TA, orgId: TA, name: 'A secret', subject: 'S', body: 'B', createdBy: 'u-a', templateId: id });
    await expect(createTemplate({ tenantId: TB, orgId: TB, name: 'stolen', subject: 'x', body: 'y', createdBy: 'u-b', templateId: id }))
      .rejects.toMatchObject({ httpStatus: 409 });
    expect((await getTemplate(TA, TA, id))?.name).toBe('A secret');
    expect(await getTemplate(TB, TB, id)).toBeNull();
  });

  it('another ORG in the same tenant is refused too, for campaigns as well as templates', async () => {
    const tpl = await createTemplate({ tenantId: TA, orgId: 'orgA1', name: 'T', subject: 'S', body: 'B', createdBy: 'u' });
    const id = 'cmp:a0848-shared';
    await createCampaign({ tenantId: TA, orgId: 'orgA1', templateId: tpl.templateId, createdBy: 'u', campaignId: id });
    const tpl2 = await createTemplate({ tenantId: TA, orgId: 'orgA2', name: 'T2', subject: 'S', body: 'B', createdBy: 'u' });
    await expect(createCampaign({ tenantId: TA, orgId: 'orgA2', templateId: tpl2.templateId, createdBy: 'u', campaignId: id }))
      .rejects.toMatchObject({ httpStatus: 409 });
    expect((await getCampaign(TA, 'orgA1', id))?.templateId).toBe(tpl.templateId);
  });

  it('a campaign cannot reference a template the caller\'s (tenant, org) does not own — at the service, not only the route', async () => {
    const foreign = await createTemplate({ tenantId: TA, orgId: TA, name: 'A', subject: 'S', body: 'B', createdBy: 'u-a' });
    await expect(createCampaign({ tenantId: TB, orgId: TB, templateId: foreign.templateId, createdBy: 'u-b' }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it('a same-workspace replay converges on the prior row (idempotency kept)', async () => {
    const id = 'tpl:a0848-replay';
    const first = await createTemplate({ tenantId: TA, orgId: TA, name: 'R', subject: 'S', body: 'B', createdBy: 'u', templateId: id });
    const again = await createTemplate({ tenantId: TA, orgId: TA, name: 'R2', subject: 'S', body: 'B', createdBy: 'u', templateId: id });
    expect(again.templateId).toBe(first.templateId);
    expect(again.name).toBe('R');
  });

  it('two tenants publishing the SAME email sequence through the run surface each get their own rows (no collision, no 409)', async () => {
    const args = { orgId: '', name: 'Launch', idemBase: 'node-1:briefhash', emails: [{ position: 1, subjectLines: ['Same subject'], body: 'Same body' }] };
    const a = await buildEmailSurface({ tenantId: TA, runId: 'run-a' }).createDraftCampaign!({ ...args, orgId: TA });
    const b = await buildEmailSurface({ tenantId: TB, runId: 'run-b' }).createDraftCampaign!({ ...args, orgId: TB });
    const [tplA] = (a as { templateIds: string[] }).templateIds;
    const [tplB] = (b as { templateIds: string[] }).templateIds;
    expect(tplA).not.toBe(tplB);
    expect((await getTemplate(TA, TA, tplA!))?.subject).toBe('Same subject');
    expect((await getTemplate(TB, TB, tplB!))?.subject).toBe('Same subject');
    // A replay of tenant A's node converges on A's own rows.
    const again = await buildEmailSurface({ tenantId: TA, runId: 'run-a' }).createDraftCampaign!({ ...args, orgId: TA });
    expect((again as { templateIds: string[] }).templateIds).toEqual([tplA]);
  });

  it('lists are per workspace (the tenant index, still filtered)', async () => {
    const T = `org:a0848-list-${n++}`;
    // In-case neighbours, so the claim does not lean on rows other cases left behind:
    // another TENANT, and another ORG of the same tenant.
    await createTemplate({ tenantId: `${T}-other`, orgId: `${T}-other`, name: 'other-tenant', subject: 'S', body: 'B', createdBy: 'u' });
    await createTemplate({ tenantId: T, orgId: `${T}-org2`, name: 'other-org', subject: 'S', body: 'B', createdBy: 'u' });
    await createTemplate({ tenantId: T, orgId: T, name: 'mine', subject: 'S', body: 'B', createdBy: 'u' });
    expect((await listTemplates(T, T)).map((t) => t.name)).toEqual(['mine']);
    expect(await listCampaigns(T, T)).toEqual([]);
  });

  it('a campaign deleted while it is sending stays deleted (the final write is a CAS, not a blind put)', async () => {
    const T = `org:a0848-del-${n++}`;
    process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
    await setSenderAddress(T, T, 'news@mailco.test', 'u');
    await createContact({ tenantId: T, name: 'Ann', email: `ann-${n++}@x.test` });
    const tpl = await createTemplate({ tenantId: T, orgId: T, name: 'T', subject: 'S', body: 'B', createdBy: 'u' });
    const cmp = await createCampaign({ tenantId: T, orgId: T, templateId: tpl.templateId, createdBy: 'u' });
    const provider: EmailProvider = { id: 'deleter', async send() { await deleteCampaign(T, T, cmp.campaignId); } };
    await expect(sendCampaign(T, T, cmp.campaignId, { provider })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'deleted_during_send' } });
    expect(await getCampaign(T, T, cmp.campaignId)).toBeNull();
  });
});

describe('ADR 0848 H2 — a lost insert race never leaves the loser a tenant-index marker to the winner\'s row', () => {
  it('listForTenantIndexed(B) does not return A\'s row after B\'s failed compareAndSwap(null, …)', async () => {
    interface Row { id: string; tenantId: string; v: string }
    const coll = new DurableCollection<Row>(`a0848:cas-${n++}`, (r) => r.id, undefined, (r) => r.tenantId);
    expect(await coll.compareAndSwap(null, { id: 'x', tenantId: 'A', v: 'a' })).toBe(true);
    expect(await coll.compareAndSwap(null, { id: 'x', tenantId: 'B', v: 'b' })).toBe(false);
    expect(await coll.listForTenantIndexed('B')).toEqual([]);
    expect((await coll.listForTenantIndexed('A')).map((r) => r.v)).toEqual(['a']);
  });

  it('the loser\'s pre-written marker is REMOVED — the projected read (which trusts markers) does not list A\'s id under B', async () => {
    interface Row { id: string; tenantId: string; v: string }
    const coll = new DurableCollection<Row>(`a0848:cas-p-${n++}`, (r) => r.id, undefined, (r) => r.tenantId, (r) => ({ v: r.v }));
    expect(await coll.compareAndSwap(null, { id: 'x', tenantId: 'A', v: 'a' })).toBe(true);
    expect(await coll.compareAndSwap(null, { id: 'x', tenantId: 'B', v: 'b' })).toBe(false);
    expect(await coll.listForTenantProjected('B')).toEqual([]);
    expect(await coll.listForTenantProjected('A')).toEqual([{ v: 'a' }]);
  });
});

describe('ADR 0848 D2 — a run creates email drafts only if its starter could write them', () => {
  it('a viewer\'s run is refused at the surface floor; an editor\'s run writes', async () => {
    const w = await workspace();
    const args = { orgId: w.orgId, name: 'X', idemBase: `d2-${n++}`, emails: [{ position: 1, subjectLines: ['Hi'], body: 'Body' }] };
    const asViewer = buildFeatureSurfaces({ tenantId: w.tenantId, actingUserId: w.viewerId })['email']!;
    await expect(asViewer.createDraftCampaign!(args)).rejects.toMatchObject({ httpStatus: 403 });
    const asEditor = buildFeatureSurfaces({ tenantId: w.tenantId, actingUserId: w.editorId })['email']!;
    const ok = await asEditor.createDraftCampaign!(args) as { steps: number };
    expect(ok.steps).toBe(1);
  });
});

describe('ADR 0848 D3 — a bounce webhook belongs to one org, and only an admin (re)keys it', () => {
  it('another org in the same tenant cannot re-key or delete it', async () => {
    const tenantId = `org:a0848-wh-${n++}`;
    const orgA = (await createOrg({ tenantId, createdBy: 'u', name: 'A', ownerSubject: 'u' })).orgId;
    const orgB = (await createOrg({ tenantId, createdBy: 'u', name: 'B', ownerSubject: 'u' })).orgId;
    const cfg = await setWebhookConfig({ tenantId, orgId: orgA, provider: 'postmark', verificationSecret: 'secret-A' });
    await expect(setWebhookConfig({ tenantId, orgId: orgB, provider: 'postmark', verificationSecret: 'attacker', webhookId: cfg.webhookId }))
      .rejects.toMatchObject({ httpStatus: 404 });
    expect((await listWebhookConfigs(tenantId, orgA)).map((c) => c.webhookId)).toEqual([cfg.webhookId]);
    const { removeWebhookConfig } = await import('../src/features/email/bounceWebhooks.js');
    expect(await removeWebhookConfig(tenantId, orgB, cfg.webhookId)).toBe(false);
    expect((await listWebhookConfigs(tenantId, orgA)).length).toBe(1);
  });

  it('an editor cannot add a webhook config; the owner can', async () => {
    const w = await workspace();
    const refused = await w.editor.post(`${EM(w.orgId)}/webhook-configs`, { provider: 'postmark', verificationSecret: 's' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('forbidden_scope');
    expect(await listWebhookConfigs(w.tenantId, w.orgId), 'the refused editor wrote no config').toEqual([]);
    const ok = await w.owner.post<{ webhookId: string }>(`${EM(w.orgId)}/webhook-configs`, { provider: 'postmark', verificationSecret: 's' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await listWebhookConfigs(w.tenantId, w.orgId)).map((c) => c.webhookId)).toEqual([ok.body.webhookId]);
  });
});

describe('ADR 0848 D4 — the sender address is an admin setting, and the read says who may edit it', () => {
  it('an editor is refused; the owner saves; GET answers canEdit per caller', async () => {
    const w = await workspace();
    expect((await w.editor.put(`${EM(w.orgId)}/settings`, { senderAddress: 'ceo@other-company.test' })).status).toBe(403);
    const ok = await w.owner.put(`${EM(w.orgId)}/settings`, { senderAddress: 'news@mailco.test' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await w.owner.get(`${EM(w.orgId)}/settings`)).body).toMatchObject({ senderAddress: 'news@mailco.test', canEdit: true });
    expect((await w.editor.get(`${EM(w.orgId)}/settings`)).body).toMatchObject({ senderAddress: 'news@mailco.test', canEdit: false });
  });
});

describe('ADR 0848 D5 — test-send is metered per member', () => {
  it('the call over the hourly cap answers 429 with Retry-After, before any provider is resolved', async () => {
    process.env.OPENWOP_EMAIL_TEST_SEND_PER_HOUR = '2';
    const w = await workspace();
    const tpl = await w.editor.post<{ templateId: string }>(`${EM(w.orgId)}/templates`, { name: 'T', subject: 'S', body: 'B' });
    const cmp = await w.editor.post<{ campaignId: string }>(`${EM(w.orgId)}/campaigns`, { templateId: tpl.body.templateId });
    const send = () => w.editor.post(`${EM(w.orgId)}/campaigns/${cmp.body.campaignId}/test-send`, { to: 'someone@outside.test' });
    // Within budget the request reaches the real checks (no sender configured ⇒ 501).
    expect((await send()).status).toBe(501);
    expect((await send()).status).toBe(501);
    const third = await send();
    expect(third.status).toBe(429);
    expect(third.body?.details?.limit).toBe('email_test_send');
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    // The cap is per member: the owner still has budget.
    expect((await w.owner.post(`${EM(w.orgId)}/campaigns/${cmp.body.campaignId}/test-send`, { to: 'someone@outside.test' })).status).toBe(501);
  });
});

describe('ADR 0848 D6 / D7 / D7a — contact data stays data, campaigns carry one-click unsubscribe, and never ship without one', () => {
  async function campaignFor(name: string, email: string, body = 'Hello {{contact.name}} at {{contact.company}} — {{contact.email}}. Read https://mailco.test/news', subject = 'Hi {{contact.name}}') {
    const T = `org:a0848-eg-${n++}`;
    await setSenderAddress(T, T, 'news@mailco.test', 'u');
    await createContact({ tenantId: T, name, email, company: '[Verify your account](https://evil.example/c)' });
    const tpl = await createTemplate({ tenantId: T, orgId: T, name: 'T', subject, body, createdBy: 'u', format: 'markdown' });
    const cmp = await createCampaign({ tenantId: T, orgId: T, templateId: tpl.templateId, createdBy: 'u' });
    return { T, cmp };
  }

  it('D6: brackets in a contact field survive as typed outside a Markdown body', async () => {
    const { neutralizeContactValue } = await import('../src/features/email/emailService.js');
    expect(neutralizeContactValue('Q&A [beta]')).toBe('Q&A [beta]');
    expect(neutralizeContactValue('Q&A [beta]', { markdown: true })).toBe('Q&A \uFF3Bbeta\uFF3D');
    expect(neutralizeContactValue('HTTPS://x.test')).toBe('HTTPS:\u200B//x.test');
  });

  it('D6: a URL, a Markdown link or CR/LF in a contact field never becomes a link or a header line', async () => {
    process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
    const { T, cmp } = await campaignFor('https://evil.example/n\r\nBcc: victim@x.test', `https://evil.example/e@x${n++}.test`);
    const { provider, sent } = capture();
    await sendCampaign(T, T, cmp.campaignId, { provider });
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.body).not.toContain('https://evil.example');
    expect(m.html ?? '').not.toMatch(/href="https:\/\/evil\.example/);
    expect(m.html ?? '').not.toContain('>Verify your account</a>');
    // Exactly ONE click token was minted — for the template's own link, never for contact data.
    const tracked = m.body.match(/\/public-email\/c\//g) ?? [];
    expect(tracked).toHaveLength(1);
  });

  it('D7: every campaign message carries the RFC 8058 unsubscribe URL (this host\'s /u path, https)', async () => {
    process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
    const { T, cmp } = await campaignFor('Ann', `ann-${n++}@x.test`);
    const { provider, sent } = capture();
    await sendCampaign(T, T, cmp.campaignId, { provider });
    const lu = (sent[0] as EmailMessage & { listUnsubscribe?: { url: string } }).listUnsubscribe;
    expect(lu?.url).toMatch(/^https:\/\/app\.example\/.*\/public-email\/u\/tok%3A/);
    expect(sent[0]!.body).toContain(lu!.url); // the header and the footer link are the SAME token
  });

  it('D7: the adapter maps it onto each provider\'s header shape, and drops a foreign URL', async () => {
    const { __providerBodyForTest } = await import('../src/host/emailAdapter.js');
    const url = 'https://app.example/host/openwop-app/public-email/u/tok%3A1';
    const sg = JSON.parse(__providerBodyForTest('sendgrid', { from: 'a@b.c', to: 'x@y.z', subject: 's', text: 't', listUnsubscribe: { url } }));
    expect(sg.headers).toEqual({ 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    const pm = JSON.parse(__providerBodyForTest('postmark', { from: 'a@b.c', to: 'x@y.z', subject: 's', text: 't', listUnsubscribe: { url } }));
    expect(pm.Headers).toEqual([{ Name: 'List-Unsubscribe', Value: `<${url}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }]);
    const foreign = JSON.parse(__providerBodyForTest('sendgrid', { from: 'a@b.c', to: 'x@y.z', subject: 's', text: 't', listUnsubscribe: { url: 'https://evil.example/u/x' } }));
    expect(foreign.headers).toBeUndefined();
  });

  it('D7a: with no public link base a campaign is refused (501), never sent without an unsubscribe link', async () => {
    delete process.env.OPENWOP_EMAIL_LINK_BASE_URL;
    const saved = { cb: process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL, pub: process.env.OPENWOP_PUBLIC_BASE_URL };
    delete process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL; delete process.env.OPENWOP_PUBLIC_BASE_URL;
    try {
      const { T, cmp } = await campaignFor('Ann', `ann-${n++}@x.test`);
      const { provider, sent } = capture();
      await expect(sendCampaign(T, T, cmp.campaignId, { provider })).rejects.toMatchObject({ httpStatus: 501 });
      expect(sent).toHaveLength(0);
    } finally {
      if (saved.cb !== undefined) process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL = saved.cb;
      if (saved.pub !== undefined) process.env.OPENWOP_PUBLIC_BASE_URL = saved.pub;
    }
  });
});

describe('ADR 0848 D8 — the public consent pages refuse to be framed, on every response', () => {
  for (const path of ['u/tok%3Anope', 'p/tok%3Anope']) {
    it(`GET /public-email/${path} (an unknown-token error page) carries frame-ancestors 'none'`, async () => {
      const res = await fetch(`${BASE}/host/openwop-app/public-email/${path}`);
      expect(res.headers.get('content-security-policy') ?? '').toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });
  }
});

describe('ADR 0848 D9 — engagement erasure follows the address, and an unread store is a failure', () => {
  it('an erasure keyed by ADDRESS removes the events of the contact that address was mailed as', async () => {
    const T = `org:a0848-er-${n++}`;
    const email = `gone-${n++}@x.test`;
    const tok = await mintToken({ tenantId: T, campaignId: 'cmp:1', contactId: 'ct-gone', kind: 'click', url: 'https://mailco.test/a', email });
    expect(await recordClick(tok)).toBeTruthy();
    expect((await listEngagement(T)).length).toBe(1);
    const out = await deleteSubjectEngagement(T, email);
    expect(out.failed).toBe(0);
    expect(await listEngagement(T)).toEqual([]);
  });

  it('a SESSION-keyed erasure does not reach the contact\'s other events (no over-erasure via a forwarded link)', async () => {
    const T = `org:a0848-er-${n++}`;
    const tok = await mintToken({ tenantId: T, campaignId: 'cmp:1', contactId: 'ct-keep', kind: 'click', url: 'https://mailco.test/a', email: `keep-${n++}@x.test` });
    await recordClick(tok);
    await deleteSubjectEngagement(T, 'session:someone-else');
    expect((await listEngagement(T)).length).toBe(1);
  });

  it('an unreadable store is counted as a failure, never as removed:0/failed:0', async () => {
    vi.spyOn(DurableCollection.prototype, 'listByPrefix').mockRejectedValue(new Error('kv down'));
    vi.spyOn(DurableCollection.prototype, 'listForTenantIndexed').mockRejectedValue(new Error('kv down'));
    const out = await deleteSubjectEngagement(`org:a0848-er-${n++}`, 'ct-x');
    expect(out.failed).toBe(2); // BOTH unread stores count — the token leg and the event leg
  });
});

