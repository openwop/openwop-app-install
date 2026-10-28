/**
 * ADR 0955 P4(a) — the per-sender deliverability breaker and the sender-domain precondition.
 *
 * Exit criteria (ADR 0955 phase table, P4): a synthetic complaint spike pauses only that sender;
 * resume needs a person. Warm-up caps and the resume approval kind are P4b.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - the minimum-volume floor removed (one complaint on a tiny list pauses)   → "below the floor"
 *  - the bounce dedup removed (a redelivered batch counts twice)             → "redelivery"
 *  - the pause scoped tenant-wide (no orgId in the state key)                → "only that sender"
 *  - `checkChannelEligibility` ignoring the pause                            → "the journey refuses"
 *  - the sender-auth check ignoring DMARC                                     → "SPF and DMARC"
 *
 * NOT witnessed by sabotage: the route's `req.cookieSession` check. The only callers without a
 * browser session this harness can produce are unauthenticated, and the auth layer refuses those
 * first (the 401 below), so removing the check reds nothing here. It is defence in depth for an
 * authenticated non-browser caller (an OIDC bearer); recorded, not claimed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { recordBounceSignal, recordSends, senderPaused, getSenderHealth } from '../src/features/crm/senderHealth.js';
import { checkChannelEligibility } from '../src/features/crm/channelEligibility.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { recordConsent } from '../src/features/consent/consentService.js';
import { createCampaign, createTemplate, sendCampaign, setSenderAddress, type EmailProvider } from '../src/features/email/emailService.js';
import { __setSenderAuthResolverForTests, checkSenderDomain } from '../src/features/email/senderAuth.js';

let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  for (const id of ['email', 'crm', 'consent', 'users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { __setSenderAuthResolverForTests(null); await new Promise<void>((r) => server.close(() => r())); });

const T = () => `org:p4-${randomBytes(3).toString('hex')}`;
const NOW = new Date('2026-10-20T12:00:00Z');

describe('ADR 0955 D7 — the breaker', () => {
  it('below the floor nothing pauses; a complaint spike over the floor pauses only that sender', async () => {
    const t = T();
    await recordSends(t, 'org-a', 100, NOW);
    expect(await recordBounceSignal(t, 'org-a', 'complaint', 'x1@example.test', NOW)).toBe(false); // 100 < 500
    await recordSends(t, 'org-a', 900, NOW);
    await recordSends(t, 'org-b', 1000, NOW);
    // 1000 sent, 2 complaints = 0.2 % > 0.1 %
    expect(await recordBounceSignal(t, 'org-a', 'complaint', 'x2@example.test', NOW)).toBe(true);
    expect(await senderPaused(t, 'org-a')).toBe(true);
    expect(await senderPaused(t, 'org-b')).toBe(false);
    expect((await getSenderHealth(t, 'org-a', NOW)).state).toMatchObject({ paused: true, reason: 'complaints' });
  });

  it('a redelivered bounce counts once', async () => {
    const t = T();
    await recordSends(t, 'org-a', 1000, NOW);
    for (let i = 0; i < 25; i++) await recordBounceSignal(t, 'org-a', 'bounced', 'same@example.test', NOW);
    expect((await getSenderHealth(t, 'org-a', NOW)).window.hardBounces).toBe(1);
    expect(await senderPaused(t, 'org-a')).toBe(false);
  });

  it('the journey refuses a paused sender’s marketing email, never its receipts', async () => {
    const t = T();
    const c = await createContact({ tenantId: t, name: 'Rae', email: `rae-${randomBytes(3).toString('hex')}@example.test` });
    await recordConsent({ tenantId: t, subjectKey: c.contactId, categories: { 'marketing.email': true }, source: 'test' });
    await recordSends(t, 'org-p', 1000, new Date());
    await recordBounceSignal(t, 'org-p', 'complaint', 'a@example.test', new Date());
    await recordBounceSignal(t, 'org-p', 'complaint', 'b@example.test', new Date());
    expect(await checkChannelEligibility(t, 'org-p', c.contactId, 'email')).toMatchObject({ eligible: false, reason: 'deliverability_paused' });
    expect(await checkChannelEligibility(t, 'org-p', c.contactId, 'email', { purpose: 'transactional' })).toMatchObject({ eligible: true });
    expect(await checkChannelEligibility(t, 'org-other', c.contactId, 'email')).toMatchObject({ eligible: true });
  });

  it('the broadcast refuses up front with 409 sending_paused', async () => {
    const t = T();
    await setSenderAddress(t, t, 'news@mailco.test', 'u');
    await createContact({ tenantId: t, name: 'Ann', email: `ann-${randomBytes(3).toString('hex')}@x.test` });
    const tpl = await createTemplate({ tenantId: t, orgId: t, name: 'T', subject: 'S', body: 'B', createdBy: 'u' });
    const cmp = await createCampaign({ tenantId: t, orgId: t, templateId: tpl.templateId, createdBy: 'u' });
    await recordSends(t, t, 1000, new Date());
    await recordBounceSignal(t, t, 'complaint', 'a@example.test', new Date());
    await recordBounceSignal(t, t, 'complaint', 'b@example.test', new Date());
    const provider: EmailProvider = { id: 'capture', async send() { throw new Error('must not send'); } };
    await expect(sendCampaign(t, t, cmp.campaignId, { provider })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'sending_paused' } });
  });
});

// ── Resume through the HTTP boundary ──
interface Res { status: number; body: Record<string, unknown> }
function client(): { call: (m: string, p: string, b?: unknown, h?: Record<string, string>) => Promise<Res> } {
  let cookie = '';
  return {
    call: async (method, path, body, headers = {}) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    },
  };
}

describe('ADR 0955 D7 — resume needs a person', () => {
  it('a signed-in admin resumes through the page; a call without a browser session is refused', async () => {
    const tenantId = T();
    const owner = client();
    expect((await owner.call('POST', '/host/openwop-app/test/login', { email: `p4-${randomBytes(3).toString('hex')}@acme.test`, tenantId })).status).toBe(201);
    const org = await owner.call('POST', '/host/openwop-app/orgs', { name: 'Client (synthetic)' });
    const orgId = String(org.body.orgId);
    await recordSends(tenantId, orgId, 1000, new Date());
    await recordBounceSignal(tenantId, orgId, 'complaint', 'a@example.test', new Date());
    await recordBounceSignal(tenantId, orgId, 'complaint', 'b@example.test', new Date());
    const health = await owner.call('GET', `/host/openwop-app/email/orgs/${orgId}/deliverability`);
    expect(health.status, JSON.stringify(health.body)).toBe(200);
    expect(health.body).toMatchObject({ state: { paused: true }, canResume: true });
    // No browser session and no credentials: the auth layer refuses (see the header note).
    const bare = await fetch(`${BASE}/host/openwop-app/email/orgs/${orgId}/deliverability/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect([401, 403]).toContain(bare.status);
    expect(await senderPaused(tenantId, orgId)).toBe(true);
    const ok = await owner.call('POST', `/host/openwop-app/email/orgs/${orgId}/deliverability/resume`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await senderPaused(tenantId, orgId)).toBe(false);
    expect((await getSenderHealth(tenantId, orgId)).state).toMatchObject({ paused: false, resumedBy: expect.any(String) });
  });
});

describe('ADR 0955 D7 — the sender-domain precondition', () => {
  it('SPF and DMARC must both be published; an outage is its own refusal; DKIM is not claimed', async () => {
    const zone: Record<string, string[][] | Error> = {
      'good.test': [['v=spf1 include:_spf.example ~all']],
      '_dmarc.good.test': [['v=DMARC1; p=none']],
      'nodmarc.test': [['v=spf1 -all']],
      '_dmarc.nodmarc.test': Object.assign(new Error('nx'), { code: 'ENOTFOUND' }),
      'down.test': Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }),
    };
    __setSenderAuthResolverForTests(async (name) => {
      const v = zone[name];
      if (!v) throw Object.assign(new Error('nx'), { code: 'ENODATA' });
      if (v instanceof Error) throw v;
      return v;
    });
    expect(await checkSenderDomain('good.test')).toMatchObject({ ok: true, missing: [] });
    expect(await checkSenderDomain('nodmarc.test')).toMatchObject({ ok: false, missing: ['dmarc'] });
    expect(await checkSenderDomain('down.test')).toMatchObject({ ok: false, unverifiable: true });

    const t = T();
    await setSenderAddress(t, t, 'news@nodmarc.test', 'u');
    await createContact({ tenantId: t, name: 'Bo', email: `bo-${randomBytes(3).toString('hex')}@x.test` });
    const tpl = await createTemplate({ tenantId: t, orgId: t, name: 'T', subject: 'S', body: 'B', createdBy: 'u' });
    const cmp = await createCampaign({ tenantId: t, orgId: t, templateId: tpl.templateId, createdBy: 'u' });
    const provider: EmailProvider = { id: 'capture', async send() { /* ok */ } };
    // Toggle OFF: no precondition.
    await expect(sendCampaign(t, t, cmp.campaignId, { provider })).resolves.toBeTruthy();
    const d = getToggleDefault('email.sender-auth');
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    try {
      const cmp2 = await createCampaign({ tenantId: t, orgId: t, templateId: tpl.templateId, createdBy: 'u' });
      await expect(sendCampaign(t, t, cmp2.campaignId, { provider })).rejects.toMatchObject({ details: { reason: 'sender_unauthenticated', missing: ['dmarc'] } });
    } finally { if (d) await saveConfig({ ...d, status: 'off' }, 'test'); }
  });
});
