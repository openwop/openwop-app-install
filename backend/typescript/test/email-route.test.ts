/**
 * Email Marketing (ADR 0019) — ROUTE + service harness. Boots the real app and
 * drives: templates + campaigns CRUD (RBAC), the send route, the send LOGIC
 * (audience resolved live from contacts, {{contact.*}} render, marketing consent
 * gate, partial-failure stats), the well-known advertisement, and a surface/node
 * smoke. Proves the Email↔CRM↔Consent composition.
 *
 * Sabotage-witnessed (grade-tests w9): a secret-ish key on the provider-status row,
 * an unregistered surface id, a dropped LEAK-1 console check (the 501 MESSAGE, not just
 * its code — the sender check also 501s `capability_not_provided`), a dropped `no_email`
 * ledger row, a no-op `{{contact.*}}` interpolation, an eraser that skips send-logs, and a
 * surface that stops projecting `tenantId` each red their case.
 * HONEST CEILINGS (double guards): the route's unknown-templateId 400 is backed by the
 * ADR 0848 D1 service check; the single-template IDOR leg is refused by `authz` before the
 * service's tenant filter is reached.
 * Cut here as redundant (w9, both covers witnessed red under the same sabotage): the
 * re-send guard → `email-campaign-send.test.ts` "re-invoking a fully sent campaign 409s…";
 * the consent gate → `consent-channels.test.ts` "specific-off skips even with the umbrella on".
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __resetEmailStore, createTemplate, createCampaign, sendCampaign, listSends, setSenderAddress, type EmailMessage, type EmailProvider } from '../src/features/email/emailService.js';
import { buildEmailSurface } from '../src/features/email/surface.js';
import { createContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { __resetConsentStore } from '../src/features/consent/consentService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  // ADR 0848 D7a — a campaign send now REFUSES without a public link base (no unsubscribe link ⇒ no send).
  process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'email']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The error envelope every failing route answers with (plus whatever a success body carries). */
type ApiBody = { error?: string; message?: string } & Record<string, unknown>;
interface Res<T> { status: number; body: T }
function client(initialCookie = '') {
  let cookie = initialCookie;
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    // The JSON decode boundary: each call site names the body shape it expects, and the
    // assertion that reads a field is what fails on a mismatch (no `any` past this line).
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return {
    get: <T = ApiBody,>(p: string) => call<T>('GET', p),
    post: <T = ApiBody,>(p: string, b?: unknown) => call<T>('POST', p, b),
  };
}
const pub = client();
let n = 0;
async function ownerWithOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const owner = client();
  expect((await owner.post('/host/openwop-app/test/login', { email: `em-${Date.now()}-${n++}@acme.test` })).status).toBe(201);
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}

describe('Email: provider-status (DEF-4 / Deferred Phase B.1)', () => {
  it('an org member reads providers (all disconnected here), host default, sender identity', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const r = await owner.get<{ providers: Record<string, unknown>[]; defaultProvider?: string | null }>(`/host/openwop-app/email/orgs/${orgId}/provider-status`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Array.isArray(r.body.providers)).toBe(true);
    expect(r.body.providers.length).toBeGreaterThan(0);
    for (const p of r.body.providers) {
      expect(typeof p.provider).toBe('string');
      expect(p.connected).toBe(false); // no brokered connections in this harness
      // Booleans + identifiers only — the status read must never echo a secret.
      expect(Object.keys(p).sort()).toEqual(['connected', 'provider']);
    }
    expect(r.body.defaultProvider ?? null).toBeNull(); // env unset in tests
  });

  it('an unauthenticated caller cannot read provider status', async () => {
    const { orgId } = await ownerWithOrg();
    const r = await pub.get(`/host/openwop-app/email/orgs/${orgId}/provider-status`);
    expect([401, 403]).toContain(r.status);
  });
});

describe('Email: templates + campaigns CRUD (RBAC) + send route', () => {
  it('is registered + composes the ctx.features.email surface', async () => {
    const { BACKEND_FEATURES } = await import('../src/features/index.js');
    expect(BACKEND_FEATURES.some((f) => f.id === 'email')).toBe(true);
    // ADR 0812 P4: the `hostExtensions.featureSurfaces` advert went with the v1
    // builder (the v2 root has no record for it, ADR 0858 ledger); the surface
    // registry it was printed from is what is asserted now.
    const { registeredFeatureSurfaceIds } = await import('../src/host/featureSurfaces.js');
    expect(registeredFeatureSurfaceIds()).toContain('email');
  });

  it('owner CRUDs a template + campaign and sends (empty audience ⇒ 0 stats)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const tpl = await owner.post<{ templateId: string }>(`/host/openwop-app/email/orgs/${orgId}/templates`, { name: 'Welcome', subject: 'Hi {{contact.name}}', body: 'Hello!' });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(201);
    const cmp = await owner.post<{ campaignId: string; status: string }>(`/host/openwop-app/email/orgs/${orgId}/campaigns`, { templateId: tpl.body.templateId });
    expect(cmp.status, JSON.stringify(cmp.body)).toBe(201);
    expect(cmp.body.status).toBe('draft');
    // unknown templateId rejected
    expect((await owner.post(`/host/openwop-app/email/orgs/${orgId}/campaigns`, { templateId: 'tpl:nope' })).status).toBe(400);
    // LEAK-1: with no real email transport wired (v1 console stub), the /send
    // route honestly refuses (capability_not_provided) rather than reporting a
    // no-op delivery as 'sent'. The send LOGIC is exercised below via an injected
    // provider. The campaign stays a draft — nothing was falsely marked sent.
    const sent = await owner.post(`/host/openwop-app/email/orgs/${orgId}/campaigns/${cmp.body.campaignId}/send`);
    expect(sent.status).toBe(501);
    expect(sent.body.error).toBe('capability_not_provided');
    // The LEAK-1 refusal specifically — the missing-sender refusal shares the status AND code.
    expect(sent.body.message).toMatch(/not configured on this deployment/);
    const list = await owner.get<{ campaigns: { campaignId: string; status: string }[] }>(`/host/openwop-app/email/orgs/${orgId}/campaigns`);
    expect(list.body.campaigns.find((c) => c.campaignId === cmp.body.campaignId)?.status).toBe('draft');
  });

  it('cross-tenant access 404s (IDOR)', async () => {
    const a = await ownerWithOrg();
    const b = await ownerWithOrg();
    expect((await b.owner.get(`/host/openwop-app/email/orgs/${a.orgId}/templates`)).status).toBe(404);
  });

  // ADR 0519 — the single-template read backing `/email/templates/:templateId`.
  // That page must load standalone (bookmark / shared link / reload), so this
  // route is what makes the editor's URL real rather than decorative.
  it('reads ONE template by id, 404s an unknown id, and is tenant-isolated', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const tpl = await owner.post<{ templateId: string }>(`/host/openwop-app/email/orgs/${orgId}/templates`, { name: 'Welcome', subject: 'Hi', body: 'Hello!' });
    const got = await owner.get<{ name: string; templateId: string }>(`/host/openwop-app/email/orgs/${orgId}/templates/${tpl.body.templateId}`);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.name).toBe('Welcome');
    // Shape matches its siblings: the list + PATCH routes return the stored row,
    // so this one does too. (The AGENT-facing surface projects `tenantId` out —
    // that is a different consumer, and this route is not it.)
    expect(got.body.templateId).toBe(tpl.body.templateId);

    // A stale link / deleted template is a 404 the UI renders as "not found" —
    // never an empty editor bound to an id that does not exist.
    expect((await owner.get(`/host/openwop-app/email/orgs/${orgId}/templates/tpl:nope`)).status).toBe(404);

    // A new read route is a new IDOR surface: another tenant must not read it.
    const other = await ownerWithOrg();
    expect((await other.owner.get(`/host/openwop-app/email/orgs/${orgId}/templates/${tpl.body.templateId}`)).status).toBe(404);
  });
});

describe('Email: send logic (audience + render + consent gate)', () => {
  // A real, delivering provider injected via the LEAK-1 seam so these tests can
  // exercise the send fan-out (audience/render/consent/stats) without a live
  // SendGrid connection. The console-stub default 501s (tested via the route above).
  const okProvider = { id: 'test-transport', send: async () => {} };
  // Sender identity is required before any campaign dispatch (Phase 2) — each
  // logic test configures it for its tenant.
  const withSender = (tenantId: string) => setSenderAddress(tenantId, 'o1', 'sender@acme.test', 'u1');
  beforeEach(async () => { await __resetEmailStore(); await __resetCrmStore(); await __resetConsentStore(); });

  it('resolves audience live, renders {{contact.*}}, skips no-email, rolls up stats', async () => {
    const delivered: EmailMessage[] = [];
    const capturing: EmailProvider = { id: 'test-capture', async send(m) { delivered.push(m); } };
    await withSender('tEmail');
    await createContact({ tenantId: 'tEmail', name: 'Alice', email: 'alice@x.com', company: 'Acme', stage: 'lead' });
    await createContact({ tenantId: 'tEmail', name: 'Bob', stage: 'lead' }); // no email → skipped
    const tpl = await createTemplate({ tenantId: 'tEmail', orgId: 'o1', name: 'Hi', subject: 'Hi {{contact.name}}', body: '{{contact.name}} @ {{contact.company}}', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: 'tEmail', orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    const sent = await sendCampaign('tEmail', 'o1', cmp.campaignId, { provider: capturing }); // consent OFF (default) ⇒ permissive
    expect(sent?.stats).toMatchObject({ sent: 1, failed: 0, skipped: 1 });
    // {{contact.*}} rendered from the live contact row, in subject AND body.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.to).toBe('alice@x.com');
    expect(delivered[0]!.subject).toBe('Hi Alice');
    expect(delivered[0]!.body).toContain('Alice @ Acme');
    const sends = await listSends('tEmail', cmp.campaignId);
    expect(sends.find((s) => s.status === 'skipped')?.error).toBe('no_email');
    expect(sends.find((s) => s.status === 'sent')).toBeTruthy();
  });

  it('consent data-subject delete purges email send-logs (GDPR cascade via subject-erasure seam)', async () => {
    await withSender('tG');
    const c = await createContact({ tenantId: 'tG', name: 'Z', email: 'z@x.com', stage: 'lead' });
    const tpl = await createTemplate({ tenantId: 'tG', orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: 'tG', orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    await sendCampaign('tG', 'o1', cmp.campaignId, { provider: okProvider });
    expect((await listSends('tG', cmp.campaignId)).length).toBeGreaterThan(0);
    const { deleteSubject } = await import('../src/features/consent/consentService.js');
    await deleteSubject('tG', c.contactId);
    expect((await listSends('tG', cmp.campaignId)).length).toBe(0);
  });
});

describe('Email: ctx.features.email + nodes', () => {
  it('surface listTemplates/render + node render run', async () => {
    await __resetEmailStore();
    const tpl = await createTemplate({ tenantId: 'tN', orgId: 'o1', name: 'T', subject: 'Hi {{contact.name}}', body: 'x', createdBy: 'u1' });
    const surf = buildEmailSurface({ tenantId: 'tN' });
    const { templates } = (await surf.listTemplates({ orgId: 'o1' })) as { templates: Record<string, unknown>[] };
    expect(templates).toHaveLength(1);
    expect(templates[0].tenantId).toBeUndefined(); // projected out

    const mod = await import('../../../packs/feature.email.nodes/index.mjs');
    const ctx = (i: Record<string, unknown>) => ({ features: { email: surf }, inputs: i });
    const r = await mod.nodes['feature.email.nodes.render'](ctx({ orgId: 'o1', templateId: tpl.templateId, contact: { name: 'Dana' } }));
    expect(r.status).toBe('success');
    expect((r.outputs as { rendered: { subject: string } }).rendered.subject).toBe('Hi Dana');
  });
});

afterAll(() => { delete process.env.OPENWOP_EMAIL_LINK_BASE_URL; });
