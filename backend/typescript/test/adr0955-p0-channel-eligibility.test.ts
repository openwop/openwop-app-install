/**
 * ADR 0955 P0 — one eligibility check per channel, channel- and sender-scoped suppression,
 * the client on every enrollment, and a per-contact engagement read.
 *
 * Exit criteria (ADR 0955 phase table): a phone-only contact passes SMS eligibility; a
 * client-B enrollment from a client-A run is refused; `checkEngagement` does no tenant scan.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - `channelEligibility.addressFor` reading `contact.email` for SMS        → "phone-only"
 *  - `bindJourneyOrg` skipping the stamp comparison                          → "client-A run"
 *  - `suppressionCheck` ignoring `senderOrgId` (only the tenant-wide read)   → "sender-scoped"
 *  - `enroll` dropping the legacy-row read on the client key                → "no double send"
 *  - `checkEngagement` back on `listEngagement`                              → "no tenant scan"
 *  - erasure leg 4 without the `#` keyspace                                  → "erasure"
 *  - the journey view dropping `topicOrgId`                                  → "client-less workspace"
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { hostExtStorage, DurableCollection } from '../src/host/hostExtPersistence.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { CAMPAIGN_OPS_RUN_STAMP } from '../src/features/campaign-ops/surface.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { addSuppression, listSuppressions, suppressionCheck, suppressionBlocksSend } from '../src/features/crm/suppressionService.js';
import { eraseCrmSubject } from '../src/features/crm/erasure.js';
import { checkChannelEligibility, CHANNEL_INELIGIBLE_REASONS } from '../src/features/crm/channelEligibility.js';
import { recordConsent, recordClientChannelConsent } from '../src/features/consent/consentService.js';
import { setTopicOptOut } from '../src/features/consent/topicOptOuts.js';
import { enroll, checkEligibility, checkEngagement, listEnrollments, __clearEnrollments } from '../src/features/campaign-journeys/journeyService.js';
import { buildCampaignJourneysSurface } from '../src/features/campaign-journeys/surface.js';
import { mintToken, recordOpen, recordClick } from '../src/features/email/engagementService.js';
import * as pack from '../../../packs/feature.campaign-journeys.nodes/index.mjs';

let server: http.Server;
let BASE = '';
let TENANT = '';
let orgA = '';
let orgB = '';
let operatorUserId = '';
let cookie = '';

const SOLO = `user:adr0955-solo-${randomBytes(3).toString('hex')}`; // a workspace with no clients

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-journeys', 'campaign-ops', 'consent', 'crm']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const ws = await createWorkspace({ name: 'Journeys Agency', ownerSubject: 'oidc:j0955-owner' });
  TENANT = ws.tenantId;
  const op = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:j0955-operator', source: 'oidc' });
  operatorUserId = op.userId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: op.userId, displayName: 'Operator', roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A (synthetic)' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B (synthetic)' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: op.userId, displayName: 'Operator', roles: ['editor'] });
  await createClient({ tenantId: TENANT, orgId: orgA, name: 'Client A (synthetic)', createdBy: 'seed' });
  await createClient({ tenantId: TENANT, orgId: orgB, name: 'Client B (synthetic)', createdBy: 'seed' });
  const now = Math.floor(Date.now() / 1000);
  cookie = `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId: op.userId, personalTenant: 'ws:home-j0955', iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const phone = () => `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`;

async function stampedRun(metadata: Record<string, unknown>): Promise<string> {
  const runId = `run-j0955-${randomBytes(4).toString('hex')}`;
  await hostExtStorage().insertRun({ runId, workflowId: 'w', tenantId: TENANT, status: 'pending', inputs: null, metadata, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  return runId;
}

describe('ADR 0955 D2 — one eligibility check per channel', () => {
  it('a phone-only contact passes SMS eligibility and has no email address', async () => {
    const number = phone();
    const c = await createContact({ tenantId: TENANT, name: 'Ana', phone: number });
    expect(await checkChannelEligibility(TENANT, orgA, c.contactId, 'email')).toEqual({ eligible: false, channel: 'email', reason: 'no_address' });
    expect(await checkChannelEligibility(TENANT, orgA, c.contactId, 'sms')).toMatchObject({ eligible: false, reason: 'consent' });
    await recordConsent({ tenantId: TENANT, subjectKey: c.contactId, categories: { 'marketing.sms': true }, source: 'test' });
    // ADR 0955 Q7 (P2b) — a workspace-level yes names no brand: client A needs its own grant.
    expect(await checkChannelEligibility(TENANT, orgA, c.contactId, 'sms')).toMatchObject({ eligible: false, reason: 'consent' });
    await recordClientChannelConsent({ tenantId: TENANT, orgId: orgA, subjectKey: c.contactId, channel: 'sms', granted: true, source: 'test' });
    expect(await checkChannelEligibility(TENANT, orgA, c.contactId, 'sms')).toEqual({ eligible: true, channel: 'sms', address: number, name: 'Ana' });
  });

  it('a number without a country code is not an SMS address', async () => {
    const c = await createContact({ tenantId: TENANT, name: 'Local', phone: '415 555 0100' });
    await recordConsent({ tenantId: TENANT, subjectKey: c.contactId, categories: { 'marketing.sms': true }, source: 'test' });
    expect(await checkChannelEligibility(TENANT, orgA, c.contactId, 'sms')).toMatchObject({ eligible: false, reason: 'no_address' });
  });

  it('names a topic opt-out as its own reason, and only for the client that owns the topic', async () => {
    const c = await createContact({ tenantId: TENANT, name: 'Topic', email: `topic-${randomBytes(3).toString('hex')}@example.test` });
    await recordConsent({ tenantId: TENANT, subjectKey: c.contactId, categories: { 'marketing.email': true }, source: 'test' });
    await setTopicOptOut(TENANT, orgA, c.contactId, 'tp-news', true, 'test');
    expect(await checkChannelEligibility(TENANT, orgA, c.contactId, 'email', { topicId: 'tp-news' })).toMatchObject({ eligible: false, reason: 'topic_opt_out' });
    expect(await checkChannelEligibility(TENANT, orgB, c.contactId, 'email', { topicId: 'tp-news' })).toMatchObject({ eligible: true });
    expect(await checkChannelEligibility(TENANT, orgA, c.contactId, 'email')).toMatchObject({ eligible: true });
  });

  it('transactional mail needs no marketing consent and ignores an unsubscribe, never a bounce', async () => {
    const email = `tx-${randomBytes(3).toString('hex')}@example.test`;
    const c = await createContact({ tenantId: TENANT, name: 'Tx', email });
    expect(await checkChannelEligibility(TENANT, orgA, c.contactId, 'email')).toMatchObject({ reason: 'consent' });
    expect(await checkChannelEligibility(TENANT, orgA, c.contactId, 'email', { purpose: 'transactional' })).toMatchObject({ eligible: true });
    await addSuppression(TENANT, email, 'unsubscribed', 'test');
    expect(await checkChannelEligibility(TENANT, orgA, c.contactId, 'email', { purpose: 'transactional' })).toMatchObject({ eligible: true });
    await addSuppression(TENANT, email, 'bounced', 'test');
    expect(await checkChannelEligibility(TENANT, orgA, c.contactId, 'email', { purpose: 'transactional' })).toMatchObject({ eligible: false, reason: 'suppressed' });
  });

  it('declares the whole closed reason set, including the ones later phases emit', () => {
    expect([...CHANNEL_INELIGIBLE_REASONS].sort()).toEqual(['consent', 'consent_unreadable', 'contact_not_found', 'deliverability_paused', 'frequency_cap', 'no_address', 'quiet_hours', 'suppressed', 'suppression_unreadable', 'topic_opt_out']);
  });

  it('the legacy email verb is a view of the same check (consent asked on the requested channel)', async () => {
    const email = `legacy-${randomBytes(3).toString('hex')}@example.test`;
    const c = await createContact({ tenantId: TENANT, name: 'Legacy', email });
    await recordConsent({ tenantId: TENANT, subjectKey: c.contactId, categories: { 'marketing.sms': true, 'marketing.email': false }, source: 'test' });
    expect(await checkEligibility(TENANT, c.contactId)).toEqual({ eligible: false, reason: 'consent' });
    expect(await checkEligibility(TENANT, c.contactId, 'sms')).toEqual({ eligible: true, email, name: 'Legacy' });
  });
});

describe('ADR 0955 D2 — the journey view keeps the topic in a workspace with no clients', () => {
  it('a chain naming its org in a client-less workspace still honours that org’s topic opt-out', async () => {
    const { checkJourneyChannelEligibility } = await import('../src/features/campaign-journeys/journeyService.js');
    const org = (await createOrg({ tenantId: SOLO, createdBy: 'seed', name: 'Solo org' })).orgId;
    const c = await createContact({ tenantId: SOLO, name: 'Solo', email: `solo-${randomBytes(3).toString('hex')}@example.test` });
    await recordConsent({ tenantId: SOLO, subjectKey: c.contactId, categories: { 'marketing.email': true }, source: 'test' });
    await setTopicOptOut(SOLO, org, c.contactId, 'tp-solo', true, 'test');
    expect(await checkJourneyChannelEligibility(SOLO, org, c.contactId, 'email', { topicId: 'tp-solo' })).toMatchObject({ eligible: false, reason: 'topic_opt_out' });
  });
});

describe('ADR 0955 D2 (J2) — suppression by channel and sender', () => {
  it('a sender-scoped SMS row stops that client only; a tenant-wide row stops every client', async () => {
    const number = phone();
    await addSuppression(TENANT, number, 'unsubscribed', 'sms:stop', undefined, { channel: 'sms', senderOrgId: orgA });
    expect(await suppressionCheck(TENANT, { channel: 'sms', address: number, senderOrgId: orgA })).toBe('suppressed');
    expect(await suppressionCheck(TENANT, { channel: 'sms', address: number, senderOrgId: orgB })).toBe('clear');
    expect(await suppressionCheck(TENANT, { channel: 'sms', address: number })).toBe('clear');
    // The same number as an email address string never collides with the SMS row.
    expect(await suppressionBlocksSend(TENANT, number)).toBe('clear');
    // A caller that cannot name the sender sees every scope of the number.
    expect(await suppressionCheck(TENANT, { channel: 'sms', address: number, anySender: true })).toBe('suppressed');
    expect(await suppressionCheck(TENANT, { channel: 'sms', address: phone(), anySender: true })).toBe('clear');
    await addSuppression(TENANT, number, 'complaint', 'sms:stopall', undefined, { channel: 'sms' });
    expect(await suppressionCheck(TENANT, { channel: 'sms', address: number, senderOrgId: orgB })).toBe('suppressed');
  });

  it('a legacy email row is tenant-wide: it stops every client sender (nothing gets less strict)', async () => {
    const email = `wide-${randomBytes(3).toString('hex')}@example.test`;
    await addSuppression(TENANT, email, 'bounced', 'webhook:test');
    expect(await suppressionCheck(TENANT, { channel: 'email', address: email, senderOrgId: orgA })).toBe('suppressed');
    expect(await suppressionCheck(TENANT, { channel: 'email', address: email.toUpperCase(), senderOrgId: orgB })).toBe('suppressed');
    const row = (await listSuppressions(TENANT)).find((r) => r.email === email)!;
    expect(row).toMatchObject({ channel: 'email', address: email });
    expect(row.senderOrgId).toBeUndefined();
  });

  it('refuses an SMS suppression that is not E.164', async () => {
    await expect(addSuppression(TENANT, '555-0100', 'manual', 'test', undefined, { channel: 'sms' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('an unreadable store is suppression_unreadable, never a claim about the person', async () => {
    const c = await createContact({ tenantId: TENANT, name: 'Unread', phone: phone() });
    await recordClientChannelConsent({ tenantId: TENANT, orgId: orgA, subjectKey: c.contactId, channel: 'sms', granted: true, source: 'test' });
    const real = DurableCollection.prototype.get;
    const failing = vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, id: string) {
      if ((this as unknown as { name: string }).name === 'crm:suppression') throw new Error('kv down');
      return real.call(this, id);
    });
    try {
      expect(await checkChannelEligibility(TENANT, orgA, c.contactId, 'sms')).toMatchObject({ eligible: false, reason: 'suppression_unreadable' });
    } finally { failing.mockRestore(); }
  });

  it('erasure redacts a scoped row but keeps the number that honours the refusal', async () => {
    const number = phone();
    const c = await createContact({ tenantId: TENANT, name: 'Erase', phone: number });
    await addSuppression(TENANT, number, 'unsubscribed', 'sms:stop', 'reply STOP from Ana', { channel: 'sms', senderOrgId: orgA });
    await eraseCrmSubject(TENANT, c.contactId);
    const row = (await listSuppressions(TENANT)).find((r) => r.address === number && r.senderOrgId === orgA)!;
    expect(row.note).toBeUndefined();
    expect(row.actor).not.toBe('sms:stop');
    expect(await suppressionCheck(TENANT, { channel: 'sms', address: number, senderOrgId: orgA })).toBe('suppressed');
  });
});

describe('ADR 0955 D1 (J9) — every enrollment names its client', () => {
  it('refuses a client-B enrollment from a client-A run, under either run stamp', async () => {
    await __clearEnrollments();
    const viaOps = await stampedRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA } });
    const viaTag = await stampedRun({ campaignOrchestration: { campaignId: 'cmp_x', orgId: orgA, goalVersion: 0 } });
    for (const runId of [viaOps, viaTag]) {
      const s = buildCampaignJourneysSurface({ tenantId: TENANT, runId });
      await expect(s.enroll!({ journeyId: 'welcome', contactId: 'ct-1', orgId: orgB })).rejects.toMatchObject({ details: { reason: 'wrong_client' } });
      await expect(s.checkChannelEligibility!({ contactId: 'ct-1', orgId: orgB, channel: 'sms' })).rejects.toMatchObject({ details: { reason: 'wrong_client' } });
      await expect(s.enroll!({ journeyId: 'welcome', contactId: 'ct-1', orgId: '' })).rejects.toMatchObject({ details: { reason: 'wrong_client' } });
    }
    expect(await buildCampaignJourneysSurface({ tenantId: TENANT, runId: viaOps }).enroll!({ journeyId: 'welcome', contactId: 'ct-1', orgId: orgA })).toMatchObject({ enrolled: true });
  });

  it('refuses a run whose two stamps name different clients', async () => {
    const runId = await stampedRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, campaignOrchestration: { campaignId: 'cmp_y', orgId: orgB, goalVersion: 0 } });
    const s = buildCampaignJourneysSurface({ tenantId: TENANT, runId });
    await expect(s.enroll!({ journeyId: 'welcome', contactId: 'ct-2', orgId: orgA })).rejects.toMatchObject({ details: { reason: 'wrong_client' } });
  });

  it('checks the person behind the run against the client', async () => {
    const s = buildCampaignJourneysSurface({ tenantId: TENANT, actingUserId: operatorUserId });
    await expect(s.enroll!({ journeyId: 'welcome', contactId: 'ct-3', orgId: orgB })).rejects.toBeTruthy(); // no row on B
    expect(await s.enroll!({ journeyId: 'welcome', contactId: 'ct-3', orgId: orgA })).toMatchObject({ enrolled: true });
  });

  it('keeps clients apart, and needs a client once the workspace has one', async () => {
    await __clearEnrollments();
    expect((await enroll(TENANT, 'welcome', 'ct-9', undefined, { orgId: orgA })).enrolled).toBe(true);
    expect((await enroll(TENANT, 'welcome', 'ct-9', undefined, { orgId: orgB })).enrolled).toBe(true);
    expect((await enroll(TENANT, 'welcome', 'ct-9', undefined, { orgId: orgA })).enrolled).toBe(false);
    expect((await listEnrollments(TENANT, 'welcome', orgA)).map((e) => e.orgId)).toEqual([orgA]);
    await expect(enroll(TENANT, 'welcome', 'ct-9')).rejects.toMatchObject({ details: { reason: 'client_required' } });
    await expect(enroll(TENANT, 'welcome', 'ct-9', undefined, { orgId: 'org-not-a-client' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await enroll(SOLO, 'welcome', 'ct-9')).enrolled).toBe(true); // no clients: unchanged ADR 0222
    // …where a chain's `orgId` says where work lands, not whose client: same legacy row.
    expect((await enroll(SOLO, 'welcome', 'ct-9', undefined, { orgId: 'org-anywhere' })).enrolled).toBe(false);
  });

  it('client-scoped enrollment remains available with the campaign-ops UI off, and an absent client is still refused', async () => {
    const toggle = getToggleDefault('campaign-ops');
    if (!toggle) throw new Error('campaign-ops toggle missing');
    await saveConfig({ ...toggle, status: 'off' }, 'test');
    try {
      expect(await enroll(TENANT, 'ops-off', 'ct-ops-off', undefined, { orgId: orgA })).toEqual({ enrolled: true });
      await expect(enroll(TENANT, 'ops-off', 'ct-no-client')).rejects.toMatchObject({ details: { reason: 'client_required' } });
    } finally {
      await saveConfig({ ...toggle, status: 'on' }, 'test');
    }
  });

  it('no double send: a contact enrolled before the workspace had clients stays enrolled', async () => {
    await __clearEnrollments();
    const ws = await createWorkspace({ name: 'Late Agency', ownerSubject: 'oidc:j0955-late' });
    expect((await enroll(ws.tenantId, 'welcome', 'ct-late')).enrolled).toBe(true);
    expect((await enroll(ws.tenantId, 'nurture', 'ct-late', undefined, { exclusivityGroup: 'g', priority: 5 })).enrolled).toBe(true);
    const org = (await createOrg({ tenantId: ws.tenantId, createdBy: 'seed', name: 'First client' })).orgId;
    await createClient({ tenantId: ws.tenantId, orgId: org, name: 'First client', createdBy: 'seed' });
    expect((await enroll(ws.tenantId, 'welcome', 'ct-late', undefined, { orgId: org })).enrolled).toBe(false);
    // The legacy group incumbent still holds the group against an equal-or-lower challenger.
    expect(await enroll(ws.tenantId, 'other', 'ct-late', undefined, { exclusivityGroup: 'g', priority: 1, orgId: org })).toMatchObject({ enrolled: false, reason: 'superseded' });
    expect(await enroll(ws.tenantId, 'nurture', 'ct-late', undefined, { exclusivityGroup: 'g', priority: 5, orgId: org })).toMatchObject({ enrolled: false, reason: 'already_enrolled' });
  });

  it('an absent org is refused by every verb once the workspace has a client (never a tenant-wide read)', async () => {
    const s = buildCampaignJourneysSurface({ tenantId: TENANT });
    for (const [verb, args] of [
      ['enroll', { journeyId: 'welcome', contactId: 'ct-abs' }],
      ['checkChannelEligibility', { contactId: 'ct-abs', channel: 'sms' }],
      ['listEnrollments', {}],
    ] as const) {
      await expect(s[verb]!({ ...args }), verb).rejects.toMatchObject({ details: { reason: 'client_required' } });
    }
  });

  it('the routes need the client, and the client scope', async () => {
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${BASE}/host/openwop-app/campaign-journeys${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null };
    };
    expect((await call('GET', '/enrollments')).status).toBe(400); // client_required
    expect((await call('GET', `/enrollments?orgId=${orgB}`)).status).toBe(403); // no row on B
    const a = await call('GET', `/enrollments?orgId=${orgA}`);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect((a.body!.enrollments as Array<{ orgId?: string }>).every((e) => e.orgId === orgA)).toBe(true);
    expect((await call('DELETE', '/enrollments', { orgId: orgB, journeyId: 'welcome', contactId: 'ct-9' })).status).toBe(403);
  });
});

describe('ADR 0955 P0 (J8) — engagement is read per contact', () => {
  it('counts the contact’s opens and clicks, legacy rows included, with no tenant scan after the backfill', async () => {
    const T = `user:adr0955-eng-${randomBytes(3).toString('hex')}`;
    const open = await mintToken({ tenantId: T, campaignId: 'cmp-1', contactId: 'ct-e', kind: 'open' });
    await recordOpen(open);
    expect(await checkEngagement(T, 'ct-e')).toMatchObject({ opened: true, openCount: 1 });
    const click = await mintToken({ tenantId: T, campaignId: 'cmp-2', contactId: 'ct-e', kind: 'click', url: 'https://example.test/x' });
    await recordClick(click);
    await recordOpen(await mintToken({ tenantId: T, campaignId: 'cmp-1', contactId: 'ct-other', kind: 'open' }));
    const scans = vi.spyOn(DurableCollection.prototype, 'listByPrefix');
    try {
      expect(await checkEngagement(T, 'ct-e')).toEqual({ opened: true, clicked: true, openCount: 1, clickCount: 1 });
      expect(await checkEngagement(T, 'ct-e', 'cmp-2')).toEqual({ opened: false, clicked: true, openCount: 0, clickCount: 1 });
      const tenantScans = scans.mock.calls.filter((call, i) => (scans.mock.contexts[i] as { name?: string }).name === 'email:engagement' && call[0] === `${T}::`);
      expect(tenantScans).toHaveLength(0);
    } finally { scans.mockRestore(); }
  });
});

describe('ADR 0955 — the channel-eligibility node', () => {
  it('outputs the SMS address for the send step, and fails with the reason otherwise', async () => {
    const number = phone();
    const c = await createContact({ tenantId: TENANT, name: 'Node', phone: number });
    await recordClientChannelConsent({ tenantId: TENANT, orgId: orgA, subjectKey: c.contactId, channel: 'sms', granted: true, source: 'test' });
    const runId = await stampedRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA } });
    const ctx = (inputs: Record<string, unknown>) => ({ nodeId: 'n', runId, inputs, features: { 'campaign-journeys': buildCampaignJourneysSurface({ tenantId: TENANT, runId }) } });
    const ok = await pack.channelEligibility(ctx({ contactId: c.contactId, orgId: orgA, channel: 'sms' }));
    expect(ok).toMatchObject({ status: 'success', outputs: { channel: 'sms', address: number, to: number } });
    const no = await pack.channelEligibility(ctx({ contactId: c.contactId, orgId: orgA, channel: 'email' }));
    expect(no.status).toBe('failed');
    expect(no.error?.message).toContain('no_address');
  });
});
