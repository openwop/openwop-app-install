/**
 * ADR 0905 P0 — a campaign send is pinned to the template content at send start (D2),
 * and a template a live campaign still needs cannot be deleted (D1 delete guard).
 *
 * Before P0, `sendCampaignSerialized` re-read the LIVE template on every batch, so an
 * edit made while a campaign was `sending` changed the rest of the send.
 *
 * Sabotage-witnessed: never reusing a pin (dropping `existingPin` and the CAS loser's
 * adopt) reds the mid-send and legacy-resume cases; dropping the guard in
 * `deleteTemplate` reds both delete cases.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  __resetEmailStore, createTemplate, createCampaign, sendCampaign, updateTemplate, deleteTemplate, getCampaign,
  setSenderAddress, templateContentHash, type EmailMessage, type Campaign,
} from '../src/features/email/emailService.js';
import { createContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { __resetConsentStore } from '../src/features/consent/consentService.js';
import { OpenwopError } from '../src/types.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

const T = 'tPin';
let delivered: EmailMessage[] = [];
const provider = { id: 'test-transport', send: async (m: EmailMessage) => { delivered.push(m); } };

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

beforeEach(async () => {
  await __resetEmailStore(); await __resetCrmStore(); await __resetConsentStore();
  delivered = [];
  await setSenderAddress(T, 'o1', 'sender@acme.test', 'u1');
});

async function threeContactCampaign(): Promise<{ campaignId: string; templateId: string }> {
  for (const n of ['a', 'b', 'c']) await createContact({ tenantId: T, name: n.toUpperCase(), email: `${n}@x.com`, stage: 'lead' });
  const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'Launch', subject: 'Original subject', body: 'Original body', createdBy: 'u1' });
  const cmp = await createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
  return { campaignId: cmp.campaignId, templateId: tpl.templateId };
}

describe('ADR 0905 D2 — the send pin', () => {
  it('an edit made while the campaign is sending does not change the rest of the send', async () => {
    const { campaignId, templateId } = await threeContactCampaign();
    const first = await sendCampaign(T, 'o1', campaignId, { provider, limit: 1 });
    expect(first?.status).toBe('sending');
    expect(first?.sendPin).toMatchObject({ generation: 0, subject: 'Original subject', contentHash: templateContentHash({ subject: 'Original subject', body: 'Original body' }) });

    await updateTemplate(T, 'o1', templateId, { subject: 'EDITED subject', body: 'EDITED body' });
    const rest = await sendCampaign(T, 'o1', campaignId, { provider, limit: 10 });
    expect(rest?.status).toBe('sent');
    expect(delivered).toHaveLength(3);
    expect(delivered.map((m) => m.subject)).toEqual(['Original subject', 'Original subject', 'Original subject']);
    expect(delivered.every((m) => m.body.startsWith('Original body'))).toBe(true);
  });

  it('a resend opens a new generation and re-pins from the live template', async () => {
    const { campaignId, templateId } = await threeContactCampaign();
    await sendCampaign(T, 'o1', campaignId, { provider });
    await updateTemplate(T, 'o1', templateId, { subject: 'Second wave' });
    delivered = [];
    const again = await sendCampaign(T, 'o1', campaignId, { provider, resend: true });
    expect(again?.sendPin).toMatchObject({ generation: 1, subject: 'Second wave' });
    expect(delivered.map((m) => m.subject)).toEqual(['Second wave', 'Second wave', 'Second wave']);
  });

  it('a legacy `sending` row with no pin is pinned on its first continuation, then frozen', async () => {
    const { campaignId, templateId } = await threeContactCampaign();
    await sendCampaign(T, 'o1', campaignId, { provider, limit: 1 });
    // Simulate a row written before P0: strip the pin, keep status `sending`.
    const row = await getCampaign(T, 'o1', campaignId);
    const { sendPin: _gone, ...legacy } = row!;
    await new DurableCollection<Campaign>('email:campaign', (c) => c.campaignId, undefined, (c) => c.tenantId).put(legacy);
    await updateTemplate(T, 'o1', templateId, { subject: 'Edited before resume' });
    await sendCampaign(T, 'o1', campaignId, { provider, limit: 1 });
    await updateTemplate(T, 'o1', templateId, { subject: 'Edited after resume' });
    await sendCampaign(T, 'o1', campaignId, { provider, limit: 10 });
    expect(delivered.map((m) => m.subject)).toEqual(['Original subject', 'Edited before resume', 'Edited before resume']);
  });

  it('a send refused before dispatch leaves the campaign a draft with no pin', async () => {
    const { campaignId } = await threeContactCampaign();
    await setSenderAddress(T, 'o1', '', 'u1');
    await expect(sendCampaign(T, 'o1', campaignId, { provider })).rejects.toMatchObject({ httpStatus: 501 });
    const after = await getCampaign(T, 'o1', campaignId);
    expect(after?.status).toBe('draft');
    expect(after?.sendPin).toBeUndefined();
  });
});

describe('ADR 0905 D1 — delete guard', () => {
  it('refuses 409 template_in_use while a draft or sending campaign references it; allows it once sent', async () => {
    const { campaignId, templateId } = await threeContactCampaign();
    const err = await deleteTemplate(T, 'o1', templateId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    expect(err).toMatchObject({ httpStatus: 409, details: { reason: 'template_in_use', campaignIds: [campaignId] } });

    await sendCampaign(T, 'o1', campaignId, { provider, limit: 1 });
    await expect(deleteTemplate(T, 'o1', templateId)).rejects.toMatchObject({ httpStatus: 409 });

    await sendCampaign(T, 'o1', campaignId, { provider, limit: 10 });
    expect(await deleteTemplate(T, 'o1', templateId)).toBe(true);
  });

  it('the HTTP route answers 409, and 204 for an unreferenced template', async () => {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const h = res.headers as { getSetCookie?: () => string[] };
      for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
      const parsed: unknown = res.status === 204 ? {} : await res.json().catch(() => ({}));
      return { status: res.status, body: parsed as Record<string, unknown> };
    };
    expect((await call('POST', '/host/openwop-app/test/login', { email: `pin-${Date.now()}@acme.test` })).status).toBe(201);
    const org = await call('POST', '/host/openwop-app/orgs', { name: 'Acme' });
    const E = `/host/openwop-app/email/orgs/${String(org.body.orgId)}`;
    const used = await call('POST', `${E}/templates`, { name: 'U', subject: 'S', body: 'B' });
    const spare = await call('POST', `${E}/templates`, { name: 'F', subject: 'S', body: 'B' });
    expect((await call('POST', `${E}/campaigns`, { templateId: used.body.templateId })).status).toBe(201);

    const refused = await call('DELETE', `${E}/templates/${String(used.body.templateId)}`);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('template_in_use');
    expect((await call('DELETE', `${E}/templates/${String(spare.body.templateId)}`)).status).toBe(204);
  });
});
