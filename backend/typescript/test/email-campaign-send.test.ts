/**
 * Phase 2 — REAL campaign email delivery (LEAK-1 completion; ADR 0019
 * correction note, composing the ADR 0024 brokered SendGrid spine).
 *
 *  - settings route: sender identity is explicit per-org config (GET/PUT,
 *    validation, RBAC-scoped like its siblings)
 *  - honest-failure ordering: 501 capability_not_provided (no sender) →
 *    409 credential_required (no SendGrid connection) → real dispatch
 *  - the sendLogs LEDGER: a re-invoke never re-delivers (idempotent + resumable);
 *    `resend: true` explicitly bypasses
 *  - BATCHING: at most `limit` dispatches per call; remaining audience ⇒
 *    status 'sending' + accumulated stats; exhausted ⇒ 'sent'
 *  - end-to-end through the route against a mock SendGrid: per-recipient
 *    rendering, from-address, Bearer key from the brokered Connection
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  __resetEmailStore, createTemplate, createCampaign, sendCampaign, sendTestEmail, listSends, setSenderAddress,
} from '../src/features/email/emailService.js';
import { createContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { __resetConsentStore } from '../src/features/consent/consentService.js';
import { createSecretConnection } from '../src/features/connections/connectionsService.js';
import { configureKmsClient, createLocalAesKmsClient } from '../src/byok/kmsEncryption.js';
import { randomBytes } from 'node:crypto';
import { createSegment, deleteSegment, __resetCrmSegments } from '../src/features/crm/segmentsService.js';
import { listActivities, __resetCrmEntities } from '../src/features/crm/crmEntitiesService.js';
import { __hostExtStorage, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';
import { addSuppression, __clearSuppressions } from '../src/features/crm/suppressionService.js';
import { makeBrokeredCampaignProvider } from '../src/features/email/brokeredProvider.js';

let BASE: string;
let server: http.Server;
let sg: http.Server;
let sgRequests: Array<{ auth?: string; body: Record<string, unknown> }> = [];
let sgStatus = 202;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // the mock SendGrid is on 127.0.0.1
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'email']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  // Signed-in (`user:*`) tenants persist connection secrets KMS-enveloped —
  // wire the local AES test backend (the byok-kms test precedent).
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));

  sg = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      sgRequests.push({ auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
      if (sgStatus === 202) { res.writeHead(202, { 'x-message-id': `sg-${sgRequests.length}` }); res.end(); }
      else { res.writeHead(sgStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify({ errors: [{ message: 'sender not verified' }] })); }
    });
  });
  await new Promise<void>((r) => sg.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_SENDGRID_API_BASE = `http://127.0.0.1:${(sg.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.OPENWOP_SENDGRID_API_BASE;
  await new Promise<void>((r) => sg.close(() => r()));
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
function client(initialCookie = '') {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b),
    put: (p: string, b?: unknown) => call('PUT', p, b),
  };
}

let n = 0;
async function ownerWithOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string; userId: string }> {
  const owner = client();
  const login = await owner.post('/v1/host/openwop-app/test/login', { email: `cs-${Date.now()}-${n++}@acme.test` });
  expect(login.status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const u = login.body.user as { tenantId: string; userId: string };
  return { owner, orgId: org.body.orgId, tenantId: u.tenantId, userId: u.userId };
}

const E = (orgId: string) => `/v1/host/openwop-app/email/orgs/${orgId}`;

describe('Email settings — sender identity (per-org, explicit)', () => {
  it('GET starts unconfigured; PUT validates + persists; empty unsets', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const before = await owner.get(`${E(orgId)}/settings`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ senderAddress: '', configured: false });

    expect((await owner.put(`${E(orgId)}/settings`, { senderAddress: 'not-an-email' })).status).toBe(400);

    const set = await owner.put(`${E(orgId)}/settings`, { senderAddress: 'news@acme.test' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ senderAddress: 'news@acme.test', configured: true });

    const unset = await owner.put(`${E(orgId)}/settings`, { senderAddress: '' });
    expect(unset.body).toMatchObject({ senderAddress: '', configured: false });
  });

  it('cross-tenant settings access 404s (IDOR)', async () => {
    const a = await ownerWithOrg();
    const b = await ownerWithOrg();
    expect((await b.owner.get(`${E(a.orgId)}/settings`)).status).toBe(404);
    expect((await b.owner.put(`${E(a.orgId)}/settings`, { senderAddress: 'x@y.com' })).status).toBe(404);
  });
});

describe('Honest-failure ordering on /send', () => {
  it('no sender address → 501 capability_not_provided; sender but no connection → 409 credential_required', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const tpl = await owner.post(`${E(orgId)}/templates`, { name: 'T', subject: 'S', body: 'B' });
    const cmp = await owner.post(`${E(orgId)}/campaigns`, { templateId: tpl.body.templateId });

    const noSender = await owner.post(`${E(orgId)}/campaigns/${cmp.body.campaignId}/send`);
    expect(noSender.status).toBe(501);
    expect(noSender.body.error).toBe('capability_not_provided');

    await owner.put(`${E(orgId)}/settings`, { senderAddress: 'news@acme.test' });
    const noConn = await owner.post(`${E(orgId)}/campaigns/${cmp.body.campaignId}/send`);
    expect(noConn.status).toBe(409);
    expect(noConn.body.error).toBe('credential_required');
  });
});

describe('End-to-end route send via the brokered SendGrid spine', () => {
  it('renders per contact, sends from the configured address with the connection key, rolls up stats', async () => {
    sgRequests = []; sgStatus = 202;
    const { owner, orgId, tenantId, userId } = await ownerWithOrg();
    await createSecretConnection({ tenantId, provider: 'sendgrid', kind: 'api_key', secret: 'SG.route-key', scope: 'user', userId });
    await owner.put(`${E(orgId)}/settings`, { senderAddress: 'news@acme.test' });
    await createContact({ tenantId, name: 'Alice', email: 'alice@x.com', company: 'Acme', stage: 'lead' });
    await createContact({ tenantId, name: 'NoMail', stage: 'lead' }); // skipped

    const tpl = await owner.post(`${E(orgId)}/templates`, { name: 'W', subject: 'Hi {{contact.name}}', body: 'Hello {{contact.name}}' });
    const cmp = await owner.post(`${E(orgId)}/campaigns`, { templateId: tpl.body.templateId });
    const sent = await owner.post(`${E(orgId)}/campaigns/${cmp.body.campaignId}/send`);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.status).toBe('sent');
    expect(sent.body.stats).toMatchObject({ sent: 1, failed: 0, skipped: 1 });

    expect(sgRequests).toHaveLength(1);
    expect(sgRequests[0]!.auth).toBe('Bearer SG.route-key');
    expect(sgRequests[0]!.body).toMatchObject({
      from: { email: 'news@acme.test' },
      subject: 'Hi Alice',
      personalizations: [{ to: [{ email: 'alice@x.com' }] }],
    });
  });

  /**
   * EM-1 / EM-UX-3 — a Re-send must actually re-deliver.
   *
   * This is the lane every prior resend test structurally could not see: they
   * all inject a stub `{id, send}` provider, so `makeBrokeredCampaignProvider →
   * makeEmailAdapter → emailSentLedger` — where the resend decision is actually
   * made — is never in the path. The campaign key carried no `sendGeneration`,
   * so on a resend `emailAdapter.send` found the prior ledger row, returned
   * `{sent:true}` WITHOUT calling the provider, and `sendCampaign` counted a
   * send and wrote a `'sent'` row over zero delivery — for the whole ledger TTL
   * (`OPENWOP_EMAIL_LEDGER_TTL_DAYS`, default 30 days).
   *
   * The assertion is on `sgRequests` — the count of REAL provider calls the
   * mock SendGrid received — so it fails if the provider is never called, which
   * is precisely what a green `stats.sent` could not tell you.
   */
  it('a resend actually calls the provider again — not just a green stats roll-up', async () => {
    sgRequests = []; sgStatus = 202;
    const { owner, orgId, tenantId, userId } = await ownerWithOrg();
    await createSecretConnection({ tenantId, provider: 'sendgrid', kind: 'api_key', secret: 'SG.resend-key', scope: 'user', userId });
    await owner.put(`${E(orgId)}/settings`, { senderAddress: 'news@acme.test' });
    await createContact({ tenantId, name: 'Rita', email: 'rita@x.com', stage: 'lead' });

    const tpl = await owner.post(`${E(orgId)}/templates`, { name: 'R', subject: 'S', body: 'B' });
    const cmp = await owner.post(`${E(orgId)}/campaigns`, { templateId: tpl.body.templateId });

    const first = await owner.post(`${E(orgId)}/campaigns/${cmp.body.campaignId}/send`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.stats).toMatchObject({ sent: 1 });
    expect(sgRequests, 'the first send must reach the provider').toHaveLength(1);

    // Without `resend` the ledger correctly refuses — that guard is what forces
    // the operator to ask for a re-delivery explicitly, and it must still hold.
    const noFlag = await owner.post(`${E(orgId)}/campaigns/${cmp.body.campaignId}/send`);
    expect(noFlag.status).toBe(409);
    expect(sgRequests, 'a 409 must not dispatch anything').toHaveLength(1);

    const again = await owner.post(`${E(orgId)}/campaigns/${cmp.body.campaignId}/send`, { resend: true });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.stats).toMatchObject({ sent: 1 });
    // THE assertion. Pre-fix this was still 1: the UI reported `Sent 1` and a
    // green `sent` chip while ZERO emails left the building.
    expect(sgRequests, 'the resend must reach the provider a SECOND time').toHaveLength(2);
    expect(sgRequests[1]!.body).toMatchObject({ personalizations: [{ to: [{ email: 'rita@x.com' }] }] });
  });

  /**
   * The paired negative: the generation must not turn the dedup ledger off.
   * A retry WITHIN one generation (the "Continue sending" path, and any
   * cross-instance race) must still resolve to exactly one delivery.
   */
  it('a re-invoke within the SAME generation still dedups at the adapter', async () => {
    sgRequests = []; sgStatus = 202;
    const { owner, orgId, tenantId, userId } = await ownerWithOrg();
    await createSecretConnection({ tenantId, provider: 'sendgrid', kind: 'api_key', secret: 'SG.dedup-key', scope: 'user', userId });
    await owner.put(`${E(orgId)}/settings`, { senderAddress: 'news@acme.test' });
    await createContact({ tenantId, name: 'Dee', email: 'dee@x.com', stage: 'lead' });
    await createContact({ tenantId, name: 'Eli', email: 'eli@x.com', stage: 'lead' });

    const tpl = await owner.post(`${E(orgId)}/templates`, { name: 'D', subject: 'S', body: 'B' });
    const cmp = await owner.post(`${E(orgId)}/campaigns`, { templateId: tpl.body.templateId });
    // The REAL brokered provider — the exact object the route builds — so the
    // adapter + ledger stay in the path. Called directly only because the route
    // exposes no `limit`, and a limit is the only way to reach a CONTINUATION,
    // which is where a generation-stamped key could have turned dedup off.
    const provider = await makeBrokeredCampaignProvider({
      storage: __hostExtStorage()!, tenantId, orgId, actingUserId: userId, purpose: 'marketing',
    });
    const p1 = await sendCampaign(tenantId, orgId, cmp.body.campaignId, { provider, limit: 1 });
    expect(p1!.status).toBe('sending');
    // The continuation carries NO resend flag, so it stays in generation 0
    // alongside the first pass.
    const p2 = await sendCampaign(tenantId, orgId, cmp.body.campaignId, { provider, limit: 5 });
    expect(p2!.status).toBe('sent');
    // Two contacts, one generation ⇒ exactly two provider calls, never three.
    expect(sgRequests).toHaveLength(2);
    const to = sgRequests.map((r) => JSON.stringify(r.body)).join(' ');
    expect(to).toContain('dee@x.com');
    expect(to).toContain('eli@x.com');
  });

  it('provider failure surfaces per-recipient as failed stats (partial-failure isolation)', async () => {
    sgRequests = []; sgStatus = 400;
    const { owner, orgId, tenantId, userId } = await ownerWithOrg();
    await createSecretConnection({ tenantId, provider: 'sendgrid', kind: 'api_key', secret: 'SG.k2', scope: 'user', userId });
    await owner.put(`${E(orgId)}/settings`, { senderAddress: 'news@acme.test' });
    await createContact({ tenantId, name: 'A', email: 'a@x.com', stage: 'lead' });

    const tpl = await owner.post(`${E(orgId)}/templates`, { name: 'W', subject: 'S', body: 'B' });
    const cmp = await owner.post(`${E(orgId)}/campaigns`, { templateId: tpl.body.templateId });
    const sent = await owner.post(`${E(orgId)}/campaigns/${cmp.body.campaignId}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.stats).toMatchObject({ sent: 0, failed: 1 });
    sgStatus = 202;
  });
});

describe('Ledger + batching (service level, injected provider)', () => {
  const T = 'tLedger';
  let delivered: string[] = [];
  const provider = { id: 'test-transport', send: async (m: { to: string }) => { delivered.push(m.to); } };

  beforeEach(async () => {
    await __resetEmailStore(); await __resetCrmStore(); await __resetConsentStore();
    delivered = [];
    await setSenderAddress(T, 'o1', 'sender@acme.test', 'u1');
  });

  async function threeContactCampaign(): Promise<string> {
    await createContact({ tenantId: T, name: 'A', email: 'a@x.com', stage: 'lead' });
    await createContact({ tenantId: T, name: 'B', email: 'b@x.com', stage: 'lead' });
    await createContact({ tenantId: T, name: 'C', email: 'c@x.com', stage: 'lead' });
    const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    return cmp.campaignId;
  }

  it('limit batches the fan-out; remaining ⇒ sending; continuation resumes at the ledger and accumulates stats', async () => {
    const campaignId = await threeContactCampaign();
    const first = await sendCampaign(T, 'o1', campaignId, { provider, limit: 2 });
    expect(first?.status).toBe('sending');
    expect(first?.stats).toMatchObject({ sent: 2 });
    expect(delivered).toHaveLength(2);

    const second = await sendCampaign(T, 'o1', campaignId, { provider, limit: 2 });
    expect(second?.status).toBe('sent');
    expect(second?.stats).toMatchObject({ sent: 3 }); // accumulated, not reset
    expect(delivered).toHaveLength(3);
    expect(new Set(delivered).size).toBe(3); // ledger: nobody delivered twice
  });

  it('R2 EM-SP-2 — a campaign with MORE unsendable contacts than one batch still terminates (the old ledger looped forever)', async () => {
    // 3 sendable + 4 email-less contacts, batch limit 2: the old sent-only
    // ledger re-entered every skipped contact into pending each continuation,
    // so pending never shrank below the limit and status never left 'sending'.
    for (let i = 0; i < 3; i += 1) await createContact({ tenantId: T, name: `S${i}`, email: `s${i}@x.com`, stage: 'lead' });
    for (let i = 0; i < 4; i += 1) await createContact({ tenantId: T, name: `NoMail${i}`, stage: 'lead' });
    const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    let last = await sendCampaign(T, 'o1', cmp.campaignId, { provider, limit: 2 });
    let clicks = 1;
    while (last?.status === 'sending' && clicks < 10) {
      last = await sendCampaign(T, 'o1', cmp.campaignId, { provider, limit: 2 });
      clicks += 1;
    }
    expect(last?.status, `still 'sending' after ${clicks} continuations`).toBe('sent');
    expect(clicks).toBeLessThanOrEqual(4); // ceil(7/2) — bounded, not infinite
    // EM-SP-1 — stats count each contact ONCE: never past the audience size.
    expect(last?.stats).toEqual({ sent: 3, skipped: 4, failed: 0 });
    expect(delivered).toHaveLength(3);
  });

  it('R2 EM-SP-1 — a retried failure that then sends counts as SENT once, never failed+sent', async () => {
    await createContact({ tenantId: T, name: 'Flaky', email: 'flaky@x.com', stage: 'lead' });
    const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    let failOnce = true;
    const flakyProvider = { id: 'flaky', send: async (m: { to: string }) => {
      if (failOnce) { failOnce = false; throw new Error('transient'); }
      delivered.push(m.to);
    } };
    const first = await sendCampaign(T, 'o1', cmp.campaignId, { provider: flakyProvider });
    expect(first?.status).toBe('sending');
    expect(first?.stats).toEqual({ sent: 0, skipped: 0, failed: 1 });
    const second = await sendCampaign(T, 'o1', cmp.campaignId, { provider: flakyProvider });
    expect(second?.status).toBe('sent');
    // The old accumulation reported failed:1 + sent:1 = two rows for ONE contact.
    expect(second?.stats).toEqual({ sent: 1, skipped: 0, failed: 0 });
  });

  it('R2 EM-G3 — a test send is marked, token-honest, and NEVER enters the ledger or stats', async () => {
    await createContact({ tenantId: T, name: 'Real', email: 'real@x.com', stage: 'lead' });
    // The app's REAL token syntax ({{contact.*}}) — review F6 caught the
    // first fixture using tokens interpolate() never matches, making the
    // literalness assertions vacuous (they'd pass with interpolation deleted).
    const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'T', subject: 'Hello {{contact.name}}', body: 'Hi {{contact.name}} of {{contact.company}}, mail {{contact.email}}', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    const sentMail: Array<{ to: string; subject: string; body: string }> = [];
    const p2 = { id: 'test-transport', send: async (m: { to: string; subject: string; body: string }) => { sentMail.push(m); } };
    await sendTestEmail(T, 'o1', cmp.campaignId, 'me@tester.dev', { provider: p2 });
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]!.subject).toMatch(/^\[Test\] /);                    // the explicit marker
    expect(sentMail[0]!.subject).toContain('{{contact.name}}');            // tokens stay EXACTLY as authored
    expect(sentMail[0]!.body).toContain('{{contact.company}}');
    expect(sentMail[0]!.body).toContain('{{contact.email}}');              // NOT the tester's address
    expect(sentMail[0]!.body).not.toContain('me@tester.dev');
    // The campaign is untouched: no ledger rows, status still draft.
    expect(await listSends(T, cmp.campaignId)).toHaveLength(0);
    await expect(sendTestEmail(T, 'o1', cmp.campaignId, 'not-an-email', { provider: p2 }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('re-invoking a fully sent campaign 409s; resend:true re-delivers everyone (explicit ledger bypass)', async () => {
    const campaignId = await threeContactCampaign();
    await sendCampaign(T, 'o1', campaignId, { provider });
    expect(delivered).toHaveLength(3);
    await expect(sendCampaign(T, 'o1', campaignId, { provider })).rejects.toThrow(/already sent/);
    const again = await sendCampaign(T, 'o1', campaignId, { provider, resend: true });
    expect(again?.status).toBe('sent');
    expect(delivered).toHaveLength(6);
  });

  it('R2 review F2 — a >1-batch RESEND continues past batch 1 and re-evaluates previously-skipped contacts', async () => {
    // Round 1: A+B sendable, C has no email (skipped-terminal).
    await createContact({ tenantId: T, name: 'A', email: 'a@x.com', stage: 'lead' });
    await createContact({ tenantId: T, name: 'B', email: 'b@x.com', stage: 'lead' });
    const c = await createContact({ tenantId: T, name: 'C', stage: 'lead' });
    const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    let last = await sendCampaign(T, 'o1', cmp.campaignId, { provider });
    expect(last?.status).toBe('sent');
    expect(last?.stats).toEqual({ sent: 2, skipped: 1, failed: 0 });

    // C gains an email; the operator resends with a batch limit of 2.
    const { updateContact } = await import('../src/features/crm/contactsService.js');
    await updateContact(c.contactId, { email: 'c@x.com' });
    delivered = [];
    last = await sendCampaign(T, 'o1', cmp.campaignId, { provider, resend: true, limit: 2 });
    expect(last?.status).toBe('sending'); // 3 to re-deliver, batch of 2
    // The CONTINUATION runs without the resend flag (exactly what the UI's
    // "Continue sending" does). Pre-fix, round-1 'sent'+'skipped' rows
    // truncated it: pending looked empty, the campaign flipped 'sent', and C
    // (now sendable) was never re-evaluated.
    last = await sendCampaign(T, 'o1', cmp.campaignId, { provider, limit: 2 });
    expect(last?.status).toBe('sent');
    expect(last?.stats).toEqual({ sent: 3, skipped: 0, failed: 0 });
    expect(delivered.sort()).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('CONCURRENT sends of the same campaign never double-deliver (per-campaign serialization)', async () => {
    const campaignId = await threeContactCampaign();
    // Two overlapping invocations (the double-click race): the lock serializes
    // them; the second observes the first's ledger and delivers nothing new.
    const [r1, r2] = await Promise.all([
      sendCampaign(T, 'o1', campaignId, { provider }),
      sendCampaign(T, 'o1', campaignId, { provider }).catch((e: unknown) => e),
    ]);
    expect(delivered).toHaveLength(3);
    expect(new Set(delivered).size).toBe(3);
    // First completes the campaign; the serialized second either no-ops on an
    // empty pending set or 409s on the already-sent guard — both are exact.
    const statuses = [r1, r2].map((r) => (r instanceof Error ? 'conflict' : (r as { status: string } | null)?.status));
    expect(statuses).toContain('sent');
  });

  it('a mid-run failure is retriable without double-delivery (the ledger skips prior sent)', async () => {
    const campaignId = await threeContactCampaign();
    let calls = 0;
    const flaky = { id: 'flaky', send: async (m: { to: string }) => { calls += 1; if (calls === 2) throw new Error('boom'); delivered.push(m.to); } };
    const first = await sendCampaign(T, 'o1', campaignId, { provider: flaky });
    expect(first?.stats).toMatchObject({ sent: 2, failed: 1 });
    // Retry: only the failed contact is re-attempted (sent ones are in the ledger).
    const retry = await sendCampaign(T, 'o1', campaignId, { provider });
    expect(retry?.status).toBe('sent');
    expect(delivered).toHaveLength(3);
    expect(new Set(delivered).size).toBe(3);
    expect((await listSends(T, campaignId)).filter((s) => s.status === 'sent')).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR 0193 convergence — campaigns are NOT pinned to SendGrid: the preflight
// walks the adapter's provider table (host default first) and dispatches
// through whichever transactional provider the acting user has a Connection
// for. A user with ONLY a Postmark connection sends via Postmark.
// ─────────────────────────────────────────────────────────────────────────────

describe('campaign provider fallback — postmark-only user', () => {
  let pm: http.Server;
  let pmReq: { auth?: string; token?: string; body?: string } = {};

  beforeAll(async () => {
    pm = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        pmReq = { auth: req.headers.authorization, token: req.headers['x-postmark-server-token'] as string | undefined, body: raw };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ MessageID: 'pm-msg-1', ErrorCode: 0 }));
      });
    });
    await new Promise<void>((r) => pm.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_POSTMARK_API_BASE = `http://127.0.0.1:${(pm.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    delete process.env.OPENWOP_POSTMARK_API_BASE;
    await new Promise<void>((r) => pm.close(() => r()));
  });

  it('sends via Postmark when the user has only a Postmark connection (no SendGrid)', async () => {
    const { owner, orgId, tenantId, userId } = await ownerWithOrg();
    await createSecretConnection({ tenantId, provider: 'postmark', kind: 'api_key', secret: 'pm-server-token-1', scope: 'user', userId });
    await owner.put(`${E(orgId)}/settings`, { senderAddress: 'news@acme.test' });
    await createContact({ tenantId, name: 'Pia', email: 'pia@x.com', stage: 'lead' });

    const tpl = await owner.post(`${E(orgId)}/templates`, { name: 'P', subject: 'Hi {{contact.name}}', body: 'Hello' });
    const cmp = await owner.post(`${E(orgId)}/campaigns`, { templateId: tpl.body.templateId });
    const sent = await owner.post(`${E(orgId)}/campaigns/${cmp.body.campaignId}/send`);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.status).toBe('sent');
    expect(sent.body.stats).toMatchObject({ sent: 1, failed: 0 });

    // Dispatched through Postmark's contract: token header (not Bearer), their body shape.
    expect(pmReq.token).toBe('pm-server-token-1');
    const body = JSON.parse(pmReq.body ?? '{}') as { From?: string; To?: string; Subject?: string };
    expect(body.From).toBe('news@acme.test');
    expect(body.To).toBe('pia@x.com');
    expect(body.Subject).toBe('Hi Pia');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR 0211 §1/§2 — the email→activity bridge + saved-segment audiences.
// Service-level harness with an injected test provider (mirrors "Ledger +
// batching" above) — no real SendGrid/Postmark broker needed for this surface.
// ─────────────────────────────────────────────────────────────────────────────

describe('ADR 0211 — segment audiences + email→activity bridge', () => {
  const T = 'tSegBridge';
  let delivered: string[] = [];
  const provider = { id: 'test-transport', send: async (m: { to: string }) => { delivered.push(m.to); } };

  beforeEach(async () => {
    await __resetEmailStore(); await __resetCrmStore(); await __resetConsentStore();
    await __resetCrmSegments(); await __resetCrmEntities();
    delivered = [];
    await setSenderAddress(T, 'o1', 'sender@acme.test', 'u1');
  });

  it('a campaign with segmentId sends to exactly the segment members; each sent contact gets a deterministic-id `email` activity; a resend does not duplicate activities', async () => {
    const qualified1 = await createContact({ tenantId: T, name: 'Q1', email: 'q1@x.com', stage: 'qualified' });
    const qualified2 = await createContact({ tenantId: T, name: 'Q2', email: 'q2@x.com', stage: 'qualified' });
    await createContact({ tenantId: T, name: 'Lead', email: 'lead@x.com', stage: 'lead' }); // NOT in the segment

    const segment = await createSegment({ tenantId: T, name: 'Qualified', filters: [{ field: 'stage', op: 'eq', value: 'qualified' }], createdBy: 'u1' });
    const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'Nurture', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, segmentId: segment.segmentId, createdBy: 'u1' });

    const sent = await sendCampaign(T, 'o1', cmp.campaignId, { provider });
    expect(sent?.status).toBe('sent');
    expect(sent?.stats).toMatchObject({ sent: 2, failed: 0 });
    expect(new Set(delivered)).toEqual(new Set(['q1@x.com', 'q2@x.com'])); // NOT the lead-stage contact

    const activities = await listActivities(T, 'o1', {});
    expect(activities).toHaveLength(2);
    expect(activities.every((a) => a.kind === 'email')).toBe(true);
    expect(activities.every((a) => a.body === 'Campaign email: Nurture')).toBe(true); // template name only — never rendered content
    const ids = activities.map((a) => a.activityId).sort();
    expect(ids).toEqual([
      `act:email:${cmp.campaignId}:${qualified1.contactId}`,
      `act:email:${cmp.campaignId}:${qualified2.contactId}`,
    ].sort());

    // CRMGAP-13/EM-1: the resend must not re-fire `host.crm.activity.logged`
    // for a row that's already there — the audit trail (crmMutated's
    // best-effort append) is the observable proxy for the event emit, since
    // the host-event fanout itself isn't asserted here. One audit row per
    // (campaign, contact) activity BEFORE the resend.
    const auditBefore = (await __hostExtStorage()!.listAudit({ actionPrefix: 'crm.activity.logged', limit: 200 }))
      .filter((r) => ids.includes((r.resource ?? '').replace('crm-activity:', '')));
    expect(auditBefore).toHaveLength(2);

    // Resend: bypasses the sendLogs ledger and re-dispatches to everyone, but the
    // activity bridge's deterministic id makes the SECOND append a no-op — the
    // timeline never grows past one row per (campaign, contact), AND (CRMGAP-13)
    // no duplicate `host.crm.activity.logged` audit row/event fires either.
    delivered = [];
    const resent = await sendCampaign(T, 'o1', cmp.campaignId, { provider, resend: true });
    expect(resent?.status).toBe('sent');
    expect(delivered).toHaveLength(2);
    expect(await listActivities(T, 'o1', {})).toHaveLength(2);

    const auditAfter = (await __hostExtStorage()!.listAudit({ actionPrefix: 'crm.activity.logged', limit: 200 }))
      .filter((r) => ids.includes((r.resource ?? '').replace('crm-activity:', '')));
    expect(auditAfter).toHaveLength(2); // unchanged — the resend skipped the emit, not just the append.
  });

  it('`stage` and `segmentId` together on create → 400 validation_error', async () => {
    const segment = await createSegment({ tenantId: T, name: 'Seg', filters: [], createdBy: 'u1' });
    const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    await expect(
      createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, stage: 'lead', segmentId: segment.segmentId, createdBy: 'u1' }),
    ).rejects.toMatchObject({ code: 'validation_error', httpStatus: 400 });
  });

  it('an unknown segmentId at create → 400 validation_error', async () => {
    const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    await expect(
      createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, segmentId: 'seg:does-not-exist', createdBy: 'u1' }),
    ).rejects.toMatchObject({ code: 'validation_error', httpStatus: 400 });
  });

  it('a segment deleted between campaign-create and send → 409 conflict on send (never sends to nobody silently)', async () => {
    await createContact({ tenantId: T, name: 'Q1', email: 'q1@x.com', stage: 'qualified' });
    const segment = await createSegment({ tenantId: T, name: 'Qualified', filters: [{ field: 'stage', op: 'eq', value: 'qualified' }], createdBy: 'u1' });
    const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, segmentId: segment.segmentId, createdBy: 'u1' });

    expect(await deleteSegment(T, segment.segmentId)).toBe(true);

    await expect(sendCampaign(T, 'o1', cmp.campaignId, { provider })).rejects.toMatchObject({ code: 'validation_error', httpStatus: 409 });
    expect(delivered).toHaveLength(0);
  });
});

/**
 * FOLD-IN B5 — a TRANSIENT suppression-store failure must not permanently exclude a
 * recipient, and must not write a durable claim that they asked to stop.
 *
 * CRM-4 correctly made `suppressionBlocksSend` fail CLOSED — an unreadable store
 * refuses the send rather than mailing a known complainant. But the refusal then
 * wrote `log('skipped', 'suppressed')`, and in this service `skipped` is TERMINAL by
 * design: it enters `priorTerminal`, so no continuation pass ever retries the
 * recipient. One transient KV blip therefore excluded a real person from that
 * campaign generation FOREVER — and left a ledger row whose durable `reason` says
 * they unsubscribed. The distinction between "they asked us to stop" and "we could
 * not check" survived only in a server log line.
 *
 * The refusal now writes NO ledger row at all: the recipient stays out of
 * `priorTerminal`, `pending` still holds them, the pass stays non-exhaustive
 * ('sending'), and the next pass sends.
 */
describe('B5 — an unreadable suppression store refuses the send WITHOUT a terminal ledger row', () => {
  const T = 'tSuppressBlip';
  let delivered: string[] = [];
  const provider = { id: 'test-transport', send: async (m: { to: string }) => { delivered.push(m.to); } };

  beforeEach(async () => {
    await __resetEmailStore(); await __resetCrmStore(); await __resetConsentStore();
    delivered = [];
    await setSenderAddress(T, 'o1', 'sender@acme.test', 'u1');
  });

  /** Run `fn` with a storage layer whose reads of the suppression store throw. */
  async function withUnreadableSuppression<R>(fn: () => Promise<R>): Promise<R> {
    const real = __hostExtStorage()!;
    initHostExtPersistence(new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'kvGet') {
          return async (key: string) => {
            if (key.startsWith('hostext:crm:suppression:')) throw new Error('injected suppression-store read failure');
            return (target as Storage).kvGet(key);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Storage);
    try {
      return await fn();
    } finally {
      initHostExtPersistence(real);
    }
  }

  it('the recipient stays PENDING through the blip, and the NEXT pass sends', async () => {
    await createContact({ tenantId: T, name: 'A', email: 'a@x.com', stage: 'lead' });
    const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });

    const blipped = await withUnreadableSuppression(() => sendCampaign(T, 'o1', cmp.campaignId, { provider }));
    expect(delivered, 'fail-closed: nothing is mailed while the store cannot be read').toHaveLength(0);
    expect(
      await listSends(T, cmp.campaignId),
      'a refusal we could not attribute to the recipient must leave NO durable row',
    ).toEqual([]);
    expect(blipped?.status, "the pass is not exhaustive — the campaign is still 'sending'").toBe('sending');

    // The store recovers. The recipient is still pending, so the next pass sends.
    const after = await sendCampaign(T, 'o1', cmp.campaignId, { provider });
    expect(delivered, 'a transient blip must not permanently exclude a recipient').toEqual(['a@x.com']);
    expect(after?.status).toBe('sent');
    expect(after?.stats).toMatchObject({ sent: 1, skipped: 0, failed: 0 });
  });

  it('a GENUINE suppression still writes the terminal row — the fix must not weaken the real gate', async () => {
    await createContact({ tenantId: T, name: 'B', email: 'b@x.com', stage: 'lead' });
    await addSuppression(T, 'b@x.com', 'complaint', 'test');
    const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });

    const sent = await sendCampaign(T, 'o1', cmp.campaignId, { provider });
    expect(delivered).toHaveLength(0);
    const ledger = await listSends(T, cmp.campaignId);
    expect(ledger.map((s) => [s.status, s.error]), 'a real refusal IS terminal and IS recorded').toEqual([['skipped', 'suppressed']]);
    expect(sent?.status, 'skips are terminal, so the campaign completes').toBe('sent');
    await __clearSuppressions();
  });

  it('the journey gate reports a DISTINCT reason — never "suppressed" for an outage', async () => {
    // Same shape one layer over: `checkEligibility`'s reason is what a journey step
    // surfaces, and reporting an unreadable store as `suppressed` attributes an
    // outage to a human's consent choice.
    const { checkEligibility } = await import('../src/features/campaign-journeys/journeyService.js');
    const c = await createContact({ tenantId: T, name: 'C', email: 'c@x.com', stage: 'lead' });

    const ok = await checkEligibility(T, c.contactId);
    expect(ok.eligible, 'precondition: this contact is otherwise eligible').toBe(true);

    const blipped = await withUnreadableSuppression(() => checkEligibility(T, c.contactId));
    expect(blipped.eligible, 'fail-closed still holds').toBe(false);
    expect((blipped as { reason: string }).reason).toBe('suppression_unreadable');
  });
});
