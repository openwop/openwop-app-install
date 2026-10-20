/**
 * ADR 0905 P1 — immutable email template versions (D1).
 *
 * Sabotage-witnessed: dropping the `expectedVersion` check reds the concurrent-edit
 * cases; dropping the pre-supersede backfill (`ensureVersionRow(existing…)`) reds the
 * legacy-template case; skipping the owned-template read in `listTemplateVersions` reds
 * the IDOR case.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  __resetEmailStore, createTemplate, updateTemplate, getTemplate, listTemplateVersions, getTemplateVersion,
  restoreTemplateVersion, createCampaign, sendCampaign, setSenderAddress, deleteTemplate, type EmailTemplate,
} from '../src/features/email/emailService.js';
import { createContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { __resetConsentStore } from '../src/features/consent/consentService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

const T = 'tVer';
let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'email']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => { await __resetEmailStore(); await __resetCrmStore(); await __resetConsentStore(); });

const newTpl = () => createTemplate({ tenantId: T, orgId: 'o1', name: 'N', subject: 'S1', body: 'line one\nline two', createdBy: 'u1' });

describe('ADR 0905 D1 — service', () => {
  it('create is version 1 with its row; a content change bumps and records; a rename does not', async () => {
    const t = await newTpl();
    expect(t.version).toBe(1);
    expect((await listTemplateVersions(T, 'o1', t.templateId))?.map((v) => v.version)).toEqual([1]);
    const renamed = await updateTemplate(T, 'o1', t.templateId, { name: 'Renamed' });
    expect(renamed?.version).toBe(1);
    const edited = await updateTemplate(T, 'o1', t.templateId, { subject: 'S2' }, { actor: 'u2' });
    expect(edited?.version).toBe(2);
    const versions = await listTemplateVersions(T, 'o1', t.templateId);
    expect(versions?.map((v) => [v.version, v.subject, v.createdBy])).toEqual([[2, 'S2', 'u2'], [1, 'S1', 'u1']]);
  });

  it('two editors saving from the same version: exactly one wins, the other 409 version_conflict', async () => {
    const t = await newTpl();
    const results = await Promise.allSettled([
      updateTemplate(T, 'o1', t.templateId, { body: 'A' }, { expectedVersion: 1 }),
      updateTemplate(T, 'o1', t.templateId, { body: 'B' }, { expectedVersion: 1 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ httpStatus: 409, details: { reason: 'version_conflict', currentVersion: 2 } });
    expect((await getTemplate(T, 'o1', t.templateId))?.version).toBe(2);
  });

  it('restore writes a NEW version copying the old content; history is not rewritten', async () => {
    const t = await newTpl();
    await updateTemplate(T, 'o1', t.templateId, { subject: 'S2', body: 'changed' });
    const restored = await restoreTemplateVersion(T, 'o1', t.templateId, 1, { actor: 'u3', expectedVersion: 2 });
    expect(restored).toMatchObject({ version: 3, subject: 'S1', body: 'line one\nline two' });
    expect(await getTemplateVersion(T, 'o1', t.templateId, 3)).toMatchObject({ restoredFrom: 1, createdBy: 'u3' });
    expect(await getTemplateVersion(T, 'o1', t.templateId, 2)).toMatchObject({ subject: 'S2', body: 'changed' });
  });

  it('a template from before versioning is backfilled as version 1 when first superseded', async () => {
    const t = await newTpl();
    // Simulate a pre-P1 row: no version, no contentHash, no version rows.
    const raw = new DurableCollection<EmailTemplate>('email:template', (x) => x.templateId, undefined, (x) => x.tenantId);
    const { version: _v, contentHash: _h, ...legacy } = t;
    await raw.put(legacy);
    await new DurableCollection<{ templateId: string; version: number }>('email:template-version', (x) => `${x.templateId}@${x.version}`).delete(`${t.templateId}@1`);

    const next = await updateTemplate(T, 'o1', t.templateId, { subject: 'After' });
    expect(next?.version).toBe(2);
    const versions = await listTemplateVersions(T, 'o1', t.templateId);
    expect(versions?.map((v) => [v.version, v.subject])).toEqual([[2, 'After'], [1, 'S1']]);
  });

  it('the send pin records the template version it pinned', async () => {
    await setSenderAddress(T, 'o1', 'sender@acme.test', 'u1');
    await createContact({ tenantId: T, name: 'A', email: 'a@x.com', stage: 'lead' });
    const t = await newTpl();
    await updateTemplate(T, 'o1', t.templateId, { subject: 'S2' });
    const c = await createCampaign({ tenantId: T, orgId: 'o1', templateId: t.templateId, createdBy: 'u1' });
    const sent = await sendCampaign(T, 'o1', c.campaignId, { provider: { id: 'x', send: async () => undefined } });
    expect(sent?.sendPin).toMatchObject({ templateVersion: 2, subject: 'S2' });
  });

  it('delete keeps the versions while a sent campaign references the template, else removes them', async () => {
    const lone = await newTpl();
    await updateTemplate(T, 'o1', lone.templateId, { subject: 'x' });
    expect(await deleteTemplate(T, 'o1', lone.templateId)).toBe(true);
    const store = new DurableCollection<{ templateId: string; version: number }>('email:template-version', (x) => `${x.templateId}@${x.version}`);
    expect(await store.get(`${lone.templateId}@1`)).toBeNull();
    expect(await store.get(`${lone.templateId}@2`)).toBeNull();

    await setSenderAddress(T, 'o1', 'sender@acme.test', 'u1');
    await createContact({ tenantId: T, name: 'A', email: 'a@x.com', stage: 'lead' });
    const kept = await newTpl();
    const c = await createCampaign({ tenantId: T, orgId: 'o1', templateId: kept.templateId, createdBy: 'u1' });
    await sendCampaign(T, 'o1', c.campaignId, { provider: { id: 'x', send: async () => undefined } });
    expect(await deleteTemplate(T, 'o1', kept.templateId)).toBe(true);
    expect(await store.get(`${kept.templateId}@1`)).not.toBeNull();
  });
});

describe('ADR 0905 D1 — routes', () => {
  type Body = Record<string, unknown>;
  function client() {
    let cookie = '';
    return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Body }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...headers, ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const h = res.headers as { getSetCookie?: () => string[] };
      for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
      const parsed: unknown = res.status === 204 ? {} : await res.json().catch(() => ({}));
      return { status: res.status, body: parsed as Body };
    };
  }
  let n = 0;
  async function owner() {
    const call = client();
    expect((await call('POST', '/host/openwop-app/test/login', { email: `ver-${Date.now()}-${n++}@acme.test` })).status).toBe(201);
    const org = await call('POST', '/host/openwop-app/orgs', { name: 'Acme' });
    return { call, E: `/host/openwop-app/email/orgs/${String(org.body.orgId)}` };
  }

  it('history, one version, diff, stale save 409, If-Match, restore', async () => {
    const { call, E } = await owner();
    const tpl = await call('POST', `${E}/templates`, { name: 'N', subject: 'S1', body: 'a\nb' });
    const id = String(tpl.body.templateId);
    expect((await call('PATCH', `${E}/templates/${id}`, { body: 'a\nc', expectedVersion: 1 })).body).toMatchObject({ version: 2 });
    const stale = await call('PATCH', `${E}/templates/${id}`, { body: 'zzz' }, { 'if-match': '"1"' });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain('version_conflict');
    expect((await call('PATCH', `${E}/templates/${id}`, { body: 'x', expectedVersion: 'nope' })).status).toBe(400);

    const list = await call('GET', `${E}/templates/${id}/versions`);
    expect((list.body.versions as Body[]).map((v) => v.version)).toEqual([2, 1]);
    expect((await call('GET', `${E}/templates/${id}/versions/1`)).body).toMatchObject({ version: 1, body: 'a\nb' });
    expect((await call('GET', `${E}/templates/${id}/versions/9`)).status).toBe(404);

    const diff = await call('GET', `${E}/templates/${id}/versions/1/diff`);
    expect(diff.body).toMatchObject({ from: 1, to: 2, subject: { changed: false }, body: { format: 'text', added: 1, removed: 1 } });

    const restored = await call('POST', `${E}/templates/${id}/versions/1/restore`, { expectedVersion: 2 });
    expect(restored.body).toMatchObject({ version: 3, body: 'a\nb' });
  });

  it('another workspace cannot read or restore the versions (404)', async () => {
    const a = await owner();
    const b = await owner();
    const tpl = await a.call('POST', `${a.E}/templates`, { name: 'N', subject: 'S', body: 'B' });
    const id = String(tpl.body.templateId);
    expect((await b.call('GET', `${b.E}/templates/${id}/versions`)).status).toBe(404);
    expect((await b.call('GET', `${b.E}/templates/${id}/versions/1`)).status).toBe(404);
    expect((await b.call('POST', `${b.E}/templates/${id}/versions/1/restore`, {})).status).toBe(404);
  });
});
