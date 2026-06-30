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
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
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

  it('drops a honeypot-filled submission (silent 200, no row) and rejects a missing required field', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const form = (await owner.post(`/v1/host/openwop-app/forms/orgs/${orgId}/forms`, CONTACT_FORM)).body;
    await owner.patch(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/status`, { status: 'published' });

    const honeypot = await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { name: 'Bot', email: 'b@x.com', _hp_ref: 'spam' } });
    expect(honeypot.status).toBe(200);
    const missing = await pub.post(`/v1/host/openwop-app/public-forms/${form.formId}/submit`, { values: { email: 'noname@x.com' } });
    expect(missing.status).toBe(400);

    const subs = await owner.get(`/v1/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/submissions`);
    expect(subs.body.submissions).toHaveLength(0); // neither was recorded
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
