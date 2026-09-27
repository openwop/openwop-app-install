/**
 * Email Marketing (ADR 0019) — ROUTE + service harness. Boots the real app and
 * drives: templates + campaigns CRUD (RBAC), the send route, the send LOGIC
 * (audience resolved live from contacts, {{contact.*}} render, marketing consent
 * gate, partial-failure stats), the well-known advertisement, and a surface/node
 * smoke. Proves the Email↔CRM↔Consent composition.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __resetEmailStore, createTemplate, createCampaign, sendCampaign, listSends, setSenderAddress } from '../src/features/email/emailService.js';
import { buildEmailSurface } from '../src/features/email/surface.js';
import { createContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { __resetConsentStore } from '../src/features/consent/consentService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'email']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

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
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
const pub = client();
let n = 0;
async function ownerWithOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const owner = client();
  expect((await owner.post('/v1/host/openwop-app/test/login', { email: `em-${Date.now()}-${n++}@acme.test` })).status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const enableConsent = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('consent'); if (d) await saveConfig({ ...d, status }, 'test'); };

describe('Email: provider-status (DEF-4 / Deferred Phase B.1)', () => {
  it('an org member reads providers (all disconnected here), host default, sender identity', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const r = await owner.get(`/v1/host/openwop-app/email/orgs/${orgId}/provider-status`);
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
    const r = await pub.get(`/v1/host/openwop-app/email/orgs/${orgId}/provider-status`);
    expect([401, 403]).toContain(r.status);
  });
});

describe('Email: templates + campaigns CRUD (RBAC) + send route', () => {
  it('is registered + advertises ctx.features.email', async () => {
    const { BACKEND_FEATURES } = await import('../src/features/index.js');
    expect(BACKEND_FEATURES.some((f) => f.id === 'email')).toBe(true);
    expect((await pub.get('/.well-known/openwop')).body.hostExtensions?.featureSurfaces).toContain('host.sample.email');
  });

  it('owner CRUDs a template + campaign and sends (empty audience ⇒ 0 stats)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const tpl = await owner.post(`/v1/host/openwop-app/email/orgs/${orgId}/templates`, { name: 'Welcome', subject: 'Hi {{contact.name}}', body: 'Hello!' });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(201);
    const cmp = await owner.post(`/v1/host/openwop-app/email/orgs/${orgId}/campaigns`, { templateId: tpl.body.templateId });
    expect(cmp.status, JSON.stringify(cmp.body)).toBe(201);
    expect(cmp.body.status).toBe('draft');
    // unknown templateId rejected
    expect((await owner.post(`/v1/host/openwop-app/email/orgs/${orgId}/campaigns`, { templateId: 'tpl:nope' })).status).toBe(400);
    // LEAK-1: with no real email transport wired (v1 console stub), the /send
    // route honestly refuses (capability_not_provided) rather than reporting a
    // no-op delivery as 'sent'. The send LOGIC is exercised below via an injected
    // provider. The campaign stays a draft — nothing was falsely marked sent.
    const sent = await owner.post(`/v1/host/openwop-app/email/orgs/${orgId}/campaigns/${cmp.body.campaignId}/send`);
    expect(sent.status).toBe(501);
    expect(sent.body.error).toBe('capability_not_provided');
  });

  it('cross-tenant access 404s (IDOR)', async () => {
    const a = await ownerWithOrg();
    const b = await ownerWithOrg();
    expect((await b.owner.get(`/v1/host/openwop-app/email/orgs/${a.orgId}/templates`)).status).toBe(404);
  });

  // ADR 0519 — the single-template read backing `/email/templates/:templateId`.
  // That page must load standalone (bookmark / shared link / reload), so this
  // route is what makes the editor's URL real rather than decorative.
  it('reads ONE template by id, 404s an unknown id, and is tenant-isolated', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const tpl = await owner.post(`/v1/host/openwop-app/email/orgs/${orgId}/templates`, { name: 'Welcome', subject: 'Hi', body: 'Hello!' });
    const got = await owner.get(`/v1/host/openwop-app/email/orgs/${orgId}/templates/${tpl.body.templateId}`);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.name).toBe('Welcome');
    // Shape matches its siblings: the list + PATCH routes return the stored row,
    // so this one does too. (The AGENT-facing surface projects `tenantId` out —
    // that is a different consumer, and this route is not it.)
    expect(got.body.templateId).toBe(tpl.body.templateId);

    // A stale link / deleted template is a 404 the UI renders as "not found" —
    // never an empty editor bound to an id that does not exist.
    expect((await owner.get(`/v1/host/openwop-app/email/orgs/${orgId}/templates/tpl:nope`)).status).toBe(404);

    // A new read route is a new IDOR surface: another tenant must not read it.
    const other = await ownerWithOrg();
    expect((await other.owner.get(`/v1/host/openwop-app/email/orgs/${orgId}/templates/${tpl.body.templateId}`)).status).toBe(404);
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
    await withSender('tEmail');
    await createContact({ tenantId: 'tEmail', name: 'Alice', email: 'alice@x.com', company: 'Acme', stage: 'lead' });
    await createContact({ tenantId: 'tEmail', name: 'Bob', stage: 'lead' }); // no email → skipped
    const tpl = await createTemplate({ tenantId: 'tEmail', orgId: 'o1', name: 'Hi', subject: 'Hi {{contact.name}}', body: '{{contact.name}} @ {{contact.company}}', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: 'tEmail', orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    const sent = await sendCampaign('tEmail', 'o1', cmp.campaignId, { provider: okProvider }); // consent OFF (default) ⇒ permissive
    expect(sent?.stats).toMatchObject({ sent: 1, failed: 0, skipped: 1 });
    const sends = await listSends('tEmail', cmp.campaignId);
    expect(sends.find((s) => s.status === 'skipped')?.error).toBe('no_email');
    expect(sends.find((s) => s.status === 'sent')).toBeTruthy();
  });

  it('consent ON + no record ⇒ marketing skipped (the gate)', async () => {
    await withSender('tC2');
    await createContact({ tenantId: 'tC2', name: 'Carol', email: 'carol@x.com', stage: 'lead' });
    const tpl = await createTemplate({ tenantId: 'tC2', orgId: 'o1', name: 'X', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: 'tC2', orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    try {
      await enableConsent('on');
      const sent = await sendCampaign('tC2', 'o1', cmp.campaignId, { provider: okProvider });
      expect(sent?.stats).toMatchObject({ sent: 0, skipped: 1 });
      expect((await listSends('tC2', cmp.campaignId))[0].error).toBe('consent');
    } finally { await enableConsent('off'); }
  });

  it('blocks re-send of a sent campaign unless resend:true (each send is a real dispatch)', async () => {
    await withSender('tR');
    await createContact({ tenantId: 'tR', name: 'A', email: 'a@x.com', stage: 'lead' });
    const tpl = await createTemplate({ tenantId: 'tR', orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: 'tR', orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    await sendCampaign('tR', 'o1', cmp.campaignId, { provider: okProvider });
    await expect(sendCampaign('tR', 'o1', cmp.campaignId, { provider: okProvider })).rejects.toThrow(/already sent/);
    expect((await sendCampaign('tR', 'o1', cmp.campaignId, { resend: true, provider: okProvider }))?.status).toBe('sent');
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
