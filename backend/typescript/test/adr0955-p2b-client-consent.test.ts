/**
 * ADR 0955 P2b — per-client SMS consent (Q7, team-lead decision), SMS templates in the ADR 0905
 * store, the broadcast on the one eligibility check, and the shipped chains' gates.
 *
 * Exit criteria (ADR 0955 phase table, P2b): a START or an opt-in to client A does not permit
 * client B; an SMS template edit makes a new version and a pinned send keeps the old body; the
 * broadcast and the journey refuse the same recipient for the same reason.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - `isAllowedForClient` falling back to the workspace-level `true`          → "names no brand"
 *  - `isAllowedForClient` ignoring a workspace-level `false` (STOPALL)         → "STOPALL beats a grant"
 *  - START recording a grant while a STOPALL stands                           → "START after STOPALL"
 *  - the merge handler letting a `true` overwrite the survivor's `false`      → "merge: false wins"
 *  - `createCampaign` accepting an SMS template                              → "never an email"
 *  - the broadcast keeping its own consent check (topic not narrowed)          → "same reason"
 */
import type { AddressInfo } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createSecretConnection } from '../src/features/connections/connectionsService.js';
import { setInboundConfig } from '../src/features/connections/inboundWebhooks.js';
import { setSmsSender } from '../src/features/crm/smsSenders.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { addSuppression } from '../src/features/crm/suppressionService.js';
import { checkChannelEligibility } from '../src/features/crm/channelEligibility.js';
import { isAllowed, recordConsent, recordClientChannelConsent } from '../src/features/consent/consentService.js';
import { getClientChannelGrant } from '../src/features/consent/clientChannelConsent.js';
import { setTopicOptOut } from '../src/features/consent/topicOptOuts.js';
import { fireCrmRecordMerged } from '../src/host/crmRecordLifecycle.js';
import { createCampaign, createTemplate, createTopic, getTemplateVersion, sendCampaign, listSends, setSenderAddress, updateTemplate, type EmailProvider } from '../src/features/email/emailService.js';
import { smsTemplateBody } from '../src/features/campaign-journeys/smsSend.js';

const AUTH_TOKEN = 'twilio-auth-token-secret-p2b';
let BASE = '';
const PUBLIC = 'https://app.example.test';
const T = `org:p2b-${randomBytes(3).toString('hex')}`;
let orgA = '';
let orgB = '';
let connectionId = '';
const NUM_A = '+15550500001';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_PUBLIC_BASE_URL = PUBLIC;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const id of ['consent', 'email', 'crm']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  orgA = (await createOrg({ tenantId: T, createdBy: 'seed', name: 'Client A (synthetic)' })).orgId;
  orgB = (await createOrg({ tenantId: T, createdBy: 'seed', name: 'Client B (synthetic)' })).orgId;
  connectionId = (await createSecretConnection({ tenantId: T, provider: 'twilio', kind: 'basic', secret: 'ACp2b:token', scope: 'user', userId: 'u1' })).connectionId;
  await setInboundConfig({ tenantId: T, connectionId, provider: 'twilio', signingSecret: AUTH_TOKEN });
  await setSmsSender({ tenantId: T, number: NUM_A, orgId: orgA, connectionId, boundBy: 'admin' });
});
afterAll(() => { delete process.env.OPENWOP_PUBLIC_BASE_URL; });

const fresh = () => `+1555060${String(Math.floor(Math.random() * 9000) + 1000)}`;
async function inbound(from: string, to: string, body: string): Promise<number> {
  const path = `/host/openwop-app/connections-inbound/${encodeURIComponent(connectionId)}`;
  const params = { MessageSid: `SM${randomBytes(8).toString('hex')}`, From: from, To: to, Body: body };
  const data = `${PUBLIC}${path}` + Object.keys(params).sort().map((k) => `${k}${params[k as keyof typeof params]}`).join('');
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': createHmac('sha1', AUTH_TOKEN).update(data, 'utf8').digest('base64') }, body: new URLSearchParams(params).toString() });
  return r.status;
}
const sms = (subjectKey: string, orgId: string) => isAllowed(T, subjectKey, 'marketing.sms', { client: { orgId } });

describe('ADR 0955 Q7 — SMS consent belongs to the client that collected it', () => {
  it('a workspace-level yes names no brand; a client grant permits that client only', async () => {
    const k = `subj-${randomBytes(3).toString('hex')}`;
    await recordConsent({ tenantId: T, subjectKey: k, categories: { 'marketing.sms': true }, source: 'test' });
    expect(await sms(k, orgA)).toBe(false);
    await recordClientChannelConsent({ tenantId: T, orgId: orgA, subjectKey: k, channel: 'sms', granted: true, source: 'test' });
    expect(await sms(k, orgA)).toBe(true);
    expect(await sms(k, orgB)).toBe(false);
  });

  it('STOPALL beats a grant, and a topic still narrows', async () => {
    const k = `subj-${randomBytes(3).toString('hex')}`;
    await recordClientChannelConsent({ tenantId: T, orgId: orgA, subjectKey: k, channel: 'sms', granted: true, source: 'test' });
    await setTopicOptOut(T, orgA, k, 'tp-promo', true, 'test');
    expect(await isAllowed(T, k, 'marketing.sms', { client: { orgId: orgA }, topic: { orgId: orgA, topicId: 'tp-promo' } })).toBe(false);
    await recordConsent({ tenantId: T, subjectKey: k, categories: { 'marketing.sms': false }, source: 'stopall' });
    expect(await sms(k, orgA)).toBe(false);
  });

  it('START to client A’s number grants A (not B); STOP withdraws it; START after STOPALL grants nothing', async () => {
    const person = fresh();
    const contact = await createContact({ tenantId: T, name: 'Kim', phone: person });
    expect(await inbound(person, NUM_A, 'START')).toBe(202);
    expect((await getClientChannelGrant(T, orgA, contact.contactId, 'sms'))?.granted).toBe(true);
    expect(await checkChannelEligibility(T, orgA, contact.contactId, 'sms')).toMatchObject({ eligible: true });
    expect(await checkChannelEligibility(T, orgB, contact.contactId, 'sms')).toMatchObject({ eligible: false, reason: 'consent' });
    expect(await inbound(person, NUM_A, 'STOP')).toBe(202);
    expect((await getClientChannelGrant(T, orgA, person, 'sms'))?.granted).toBe(false);
    const other = fresh();
    const c2 = await createContact({ tenantId: T, name: 'Lee', phone: other });
    await inbound(other, NUM_A, 'STOPALL');
    await inbound(other, NUM_A, 'START');
    expect(await getClientChannelGrant(T, orgA, c2.contactId, 'sms')).toBeNull();
    expect(await checkChannelEligibility(T, orgA, c2.contactId, 'sms')).toMatchObject({ eligible: false });
  });

  it('a CRM merge carries grants to the survivor, and a false wins', async () => {
    const src = `src-${randomBytes(3).toString('hex')}`;
    const surv = `surv-${randomBytes(3).toString('hex')}`;
    await recordClientChannelConsent({ tenantId: T, orgId: orgA, subjectKey: src, channel: 'sms', granted: true, source: 'test' });
    await recordClientChannelConsent({ tenantId: T, orgId: orgB, subjectKey: src, channel: 'sms', granted: false, source: 'test' });
    await recordClientChannelConsent({ tenantId: T, orgId: orgB, subjectKey: surv, channel: 'sms', granted: true, source: 'test' });
    // …and the survivor's own `false` for a third client must survive the source's `true`.
    const orgC = (await createOrg({ tenantId: T, createdBy: 'seed', name: 'Client C (synthetic)' })).orgId;
    await recordClientChannelConsent({ tenantId: T, orgId: orgC, subjectKey: src, channel: 'sms', granted: true, source: 'test' });
    await recordClientChannelConsent({ tenantId: T, orgId: orgC, subjectKey: surv, channel: 'sms', granted: false, source: 'test' });
    await fireCrmRecordMerged({ tenantId: T, entity: 'contact', sourceId: src, survivorId: surv });
    expect((await getClientChannelGrant(T, orgA, surv, 'sms'))?.granted).toBe(true); // no row on the survivor ⇒ carried
    expect((await getClientChannelGrant(T, orgB, surv, 'sms'))?.granted).toBe(false); // false wins
    expect((await getClientChannelGrant(T, orgC, surv, 'sms'))?.granted).toBe(false); // a true never overwrites a false
  });
});

describe('ADR 0955 D8 — SMS templates in the ADR 0905 store', () => {
  it('validates at write, is never an email, never switches kind, and a pinned send keeps its version', async () => {
    const base = { tenantId: T, orgId: orgA, name: 'Promo', subject: '', createdBy: 'u1' };
    await expect(createTemplate({ ...base, body: '20% off today.', format: 'sms' })).rejects.toMatchObject({ details: { reason: 'sms_body_invalid' } });
    await expect(createTemplate({ ...base, body: `${'x'.repeat(1600)} Reply STOP`, format: 'sms' })).rejects.toMatchObject({ details: { reason: 'sms_body_invalid' } });
    const tpl = await createTemplate({ ...base, body: '20% off today. Reply STOP to opt out.', format: 'sms' });
    await expect(createCampaign({ tenantId: T, orgId: orgA, templateId: tpl.templateId, stage: 'lead', createdBy: 'u1' })).rejects.toMatchObject({ details: { reason: 'template_format' } });
    await expect(updateTemplate(T, orgA, tpl.templateId, { format: 'text' })).rejects.toMatchObject({ details: { reason: 'format_locked' } });
    await updateTemplate(T, orgA, tpl.templateId, { body: '30% off today. Reply STOP to opt out.' });
    expect((await getTemplateVersion(T, orgA, tpl.templateId, 2))?.body).toContain('30%');
    expect(await smsTemplateBody(T, orgA, tpl.templateId, 1)).toMatchObject({ ok: true, text: '20% off today. Reply STOP to opt out.', templateVersion: 1 });
    const email = await createTemplate({ ...base, subject: 'Hi', body: 'Hello' });
    expect(await smsTemplateBody(T, orgA, email.templateId, 1)).toMatchObject({ ok: false, code: 'template_format' });
    expect(await smsTemplateBody(T, orgB, tpl.templateId, 1)).toMatchObject({ ok: false, code: 'template_not_found' });
  });
});

describe('ADR 0955 D2 — the broadcast and the journey refuse for the same reason', () => {
  it('a topic opt-out and a suppression skip the broadcast exactly as the journey check refuses', async () => {
    const tpl = await createTemplate({ tenantId: T, orgId: orgA, name: 'News', subject: 'News', body: 'Hello {{name}}', createdBy: 'u1' });
    const topic = await createTopic({ tenantId: T, orgId: orgA, name: `Promos ${randomBytes(2).toString('hex')}`, createdBy: 'u1' });
    const optedOut = await createContact({ tenantId: T, name: 'Topic', email: `topic-${randomBytes(3).toString('hex')}@example.test`, stage: 'customer' });
    const suppressed = await createContact({ tenantId: T, name: 'Supp', email: `supp-${randomBytes(3).toString('hex')}@example.test`, stage: 'customer' });
    for (const c of [optedOut, suppressed]) await recordConsent({ tenantId: T, subjectKey: c.contactId, categories: { 'marketing.email': true }, source: 'test' });
    await setTopicOptOut(T, orgA, optedOut.contactId, topic.topicId, true, 'test');
    await addSuppression(T, suppressed.email!, 'bounced', 'test');
    expect(await checkChannelEligibility(T, orgA, optedOut.contactId, 'email', { topicId: topic.topicId })).toMatchObject({ reason: 'topic_opt_out' });
    expect(await checkChannelEligibility(T, orgA, suppressed.contactId, 'email', { topicId: topic.topicId })).toMatchObject({ reason: 'suppressed' });
    const camp = await createCampaign({ tenantId: T, orgId: orgA, templateId: tpl.templateId, stage: 'customer', topicId: topic.topicId, createdBy: 'u1' });
    process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
    await setSenderAddress(T, orgA, 'news@mailco.test', 'u1');
    const provider: EmailProvider = { id: 'capture', async send() { /* captured; nothing to assert */ } };
    await sendCampaign(T, orgA, camp.campaignId, { provider });
    const sends = await listSends(T, camp.campaignId);
    expect(sends.find((r) => r.contactId === optedOut.contactId)).toMatchObject({ status: 'skipped', error: 'consent' });
    expect(sends.find((r) => r.contactId === suppressed.contactId)).toMatchObject({ status: 'skipped', error: 'suppressed' });
  });
});
