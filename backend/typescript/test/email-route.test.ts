/**
 * Email Marketing (ADR 0019) — ROUTE + service harness. Boots the real app and
 * drives: templates + campaigns CRUD (RBAC), the send route, the send LOGIC
 * (audience resolved live from contacts, {{contact.*}} render, marketing consent
 * gate, partial-failure stats), the well-known advertisement, and a surface/node
 * smoke. Proves the Email↔CRM↔Consent composition.
 */

import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __resetEmailStore, createTemplate, createCampaign, sendCampaign, listSends } from '../src/features/email/emailService.js';
import { buildEmailSurface } from '../src/features/email/surface.js';
import { createContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { __resetConsentStore } from '../src/features/consent/consentService.js';

const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
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
  expect((await owner.post('/v1/host/sample/test/login', { email: `em-${Date.now()}-${n++}@acme.test` })).status).toBe(201);
  const org = await owner.post('/v1/host/sample/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const enableConsent = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('consent'); if (d) await saveConfig({ ...d, status }, 'test'); };

describe('Email: templates + campaigns CRUD (RBAC) + send route', () => {
  it('is registered + advertises ctx.features.email', async () => {
    const { BACKEND_FEATURES } = await import('../src/features/index.js');
    expect(BACKEND_FEATURES.some((f) => f.id === 'email')).toBe(true);
    expect((await pub.get('/.well-known/openwop')).body.hostExtensions?.featureSurfaces).toContain('host.sample.email');
  });

  it('owner CRUDs a template + campaign and sends (empty audience ⇒ 0 stats)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const tpl = await owner.post(`/v1/host/sample/email/orgs/${orgId}/templates`, { name: 'Welcome', subject: 'Hi {{contact.name}}', body: 'Hello!' });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(201);
    const cmp = await owner.post(`/v1/host/sample/email/orgs/${orgId}/campaigns`, { templateId: tpl.body.templateId });
    expect(cmp.status, JSON.stringify(cmp.body)).toBe(201);
    expect(cmp.body.status).toBe('draft');
    // unknown templateId rejected
    expect((await owner.post(`/v1/host/sample/email/orgs/${orgId}/campaigns`, { templateId: 'tpl:nope' })).status).toBe(400);
    const sent = await owner.post(`/v1/host/sample/email/orgs/${orgId}/campaigns/${cmp.body.campaignId}/send`);
    expect(sent.body.status).toBe('sent');
    expect(sent.body.stats).toMatchObject({ sent: 0, failed: 0, skipped: 0 });
  });

  it('cross-tenant access 404s (IDOR)', async () => {
    const a = await ownerWithOrg();
    const b = await ownerWithOrg();
    expect((await b.owner.get(`/v1/host/sample/email/orgs/${a.orgId}/templates`)).status).toBe(404);
  });
});

describe('Email: send logic (audience + render + consent gate)', () => {
  beforeEach(async () => { await __resetEmailStore(); await __resetCrmStore(); await __resetConsentStore(); });

  it('resolves audience live, renders {{contact.*}}, skips no-email, rolls up stats', async () => {
    await createContact({ tenantId: 'tEmail', name: 'Alice', email: 'alice@x.com', company: 'Acme', stage: 'lead' });
    await createContact({ tenantId: 'tEmail', name: 'Bob', stage: 'lead' }); // no email → skipped
    const tpl = await createTemplate({ tenantId: 'tEmail', orgId: 'o1', name: 'Hi', subject: 'Hi {{contact.name}}', body: '{{contact.name}} @ {{contact.company}}', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: 'tEmail', orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    const sent = await sendCampaign('tEmail', 'o1', cmp.campaignId); // consent OFF (default) ⇒ permissive
    expect(sent?.stats).toMatchObject({ sent: 1, failed: 0, skipped: 1 });
    const sends = await listSends('tEmail', cmp.campaignId);
    expect(sends.find((s) => s.status === 'skipped')?.error).toBe('no_email');
    expect(sends.find((s) => s.status === 'sent')).toBeTruthy();
  });

  it('consent ON + no record ⇒ marketing skipped (the gate)', async () => {
    await createContact({ tenantId: 'tC2', name: 'Carol', email: 'carol@x.com', stage: 'lead' });
    const tpl = await createTemplate({ tenantId: 'tC2', orgId: 'o1', name: 'X', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: 'tC2', orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    try {
      await enableConsent('on');
      const sent = await sendCampaign('tC2', 'o1', cmp.campaignId);
      expect(sent?.stats).toMatchObject({ sent: 0, skipped: 1 });
      expect((await listSends('tC2', cmp.campaignId))[0].error).toBe('consent');
    } finally { await enableConsent('off'); }
  });

  it('blocks re-send of a sent campaign unless resend:true (each send is a real dispatch)', async () => {
    await createContact({ tenantId: 'tR', name: 'A', email: 'a@x.com', stage: 'lead' });
    const tpl = await createTemplate({ tenantId: 'tR', orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: 'tR', orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    await sendCampaign('tR', 'o1', cmp.campaignId);
    await expect(sendCampaign('tR', 'o1', cmp.campaignId)).rejects.toThrow(/already sent/);
    expect((await sendCampaign('tR', 'o1', cmp.campaignId, { resend: true }))?.status).toBe('sent');
  });

  it('consent data-subject delete purges email send-logs (GDPR cascade via subject-erasure seam)', async () => {
    const c = await createContact({ tenantId: 'tG', name: 'Z', email: 'z@x.com', stage: 'lead' });
    const tpl = await createTemplate({ tenantId: 'tG', orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: 'tG', orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    await sendCampaign('tG', 'o1', cmp.campaignId);
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
