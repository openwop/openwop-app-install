/**
 * ADR 0905 P4 / D7 — subscription topics: opt-out only, narrowing only, evaluated
 * inside the one consent evaluator.
 *
 * Sabotage-witnessed: dropping the topic narrowing from `isAllowed` reds the evaluator,
 * toggle-off and send cases; dropping `topicWidening` from the preference centre reds the
 * stale re-tick case; writing rows for any posted `topic:*` field reds the closed-world case.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { mergeContacts } from '../src/features/crm/crmMergeService.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { mintToken, __setTokenCreatedAtForTests } from '../src/features/email/engagementService.js';
import { isAllowed, recordConsent, deleteSubject, __resetConsentStore } from '../src/features/consent/consentService.js';
import { isTopicOptedOut, setTopicOptOut, __resetTopicOptOuts } from '../src/features/consent/topicOptOuts.js';
import {
  __resetEmailStore, createTemplate, createCampaign, createTopic, deleteTopic, deleteCampaign, sendCampaign, setSenderAddress, listTopics, MAX_TOPICS_PER_ORG,
  type EmailMessage,
} from '../src/features/email/emailService.js';
import { createContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { addSuppression, listSuppressions, suppressionBlocksSend, __clearSuppressions } from '../src/features/crm/suppressionService.js';
import { consultRecipientEgressGuard } from '../src/host/recipientEgressGuard.js';

let BASE = '';
let server: http.Server;
const T = 'tTopics';
const ORG = 'o1';
const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => {
  await __resetEmailStore(); await __resetCrmStore(); await __resetConsentStore(); await __resetTopicOptOuts(); await __clearSuppressions();
  await setToggle('consent', 'on');
});

describe('the evaluator: narrowing only', () => {
  it('a topic opt-out denies; no opt-out leaves the decision alone; a topic never re-includes a marketing.email opt-out', async () => {
    await recordConsent({ tenantId: T, subjectKey: 'c1', categories: { marketing: true }, source: 'test' });
    const topic = { orgId: ORG, topicId: 'tp1' };
    expect(await isAllowed(T, 'c1', 'marketing.email', { topic })).toBe(true);
    await setTopicOptOut(T, ORG, 'c1', 'tp1', true, 'test');
    expect(await isAllowed(T, 'c1', 'marketing.email', { topic })).toBe(false);
    expect(await isAllowed(T, 'c1', 'marketing.email'), 'another (general) send is untouched').toBe(true);

    await recordConsent({ tenantId: T, subjectKey: 'c2', categories: { marketing: true, 'marketing.email': false }, source: 'test' });
    await setTopicOptOut(T, ORG, 'c2', 'tp1', false, 'test');
    expect(await isAllowed(T, 'c2', 'marketing.email', { topic })).toBe(false);
  });

  it('a topic opt-out holds even with the consent toggle OFF', async () => {
    await setToggle('consent', 'off');
    await setTopicOptOut(T, ORG, 'c3', 'tp1', true, 'test');
    expect(await isAllowed(T, 'c3', 'marketing.email')).toBe(true);
    expect(await isAllowed(T, 'c3', 'marketing.email', { topic: { orgId: ORG, topicId: 'tp1' } })).toBe(false);
  });

  it('erasure deletes the subject\'s topic rows', async () => {
    await setTopicOptOut(T, ORG, 'c4', 'tp1', true, 'test');
    await deleteSubject(T, 'c4');
    expect(await isTopicOptedOut(T, ORG, 'c4', 'tp1')).toBe(false);
  });
});

describe('the full opt-out never blocks transactional mail (EMWF-18)', () => {
  it('an unsubscribe suppression refuses marketing but not a receipt; a bounce still refuses both', async () => {
    await __clearSuppressions();
    await addSuppression(T, 'unsub@x.test', 'unsubscribed', 'test');
    await addSuppression(T, 'dead@x.test', 'bounced', 'test');
    const verdict = async (address: string, purpose: 'marketing' | 'transactional') =>
      (await consultRecipientEgressGuard({ channel: 'email', tenantId: T, addresses: [address], purpose })).ok;
    expect(await verdict('unsub@x.test', 'marketing')).toBe(false);
    expect(await verdict('unsub@x.test', 'transactional')).toBe(true);
    expect(await verdict('dead@x.test', 'transactional')).toBe(false);
  });
});

describe('topics + sends', () => {
  it('a topic campaign skips recipients opted out of the topic; the cap and the in-use delete guard hold', async () => {
    await setSenderAddress(T, ORG, 'news@acme.test', 'u1');
    const a = await createContact({ tenantId: T, name: 'A', email: 'a@x.com', stage: 'lead' });
    await createContact({ tenantId: T, name: 'B', email: 'b@x.com', stage: 'lead' });
    for (const c of [a.contactId]) await recordConsent({ tenantId: T, subjectKey: c, categories: { marketing: true }, source: 'test' });
    const topic = await createTopic({ tenantId: T, orgId: ORG, name: 'Product updates', createdBy: 'u1' });
    await setTopicOptOut(T, ORG, a.contactId, topic.topicId, true, 'test');
    await setToggle('consent', 'off'); // B has no record; let the base allow everyone so only the topic decides
    const tpl = await createTemplate({ tenantId: T, orgId: ORG, name: 'N', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: T, orgId: ORG, templateId: tpl.templateId, topicId: topic.topicId, createdBy: 'u1' });
    await expect(deleteTopic(T, ORG, topic.topicId)).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'topic_in_use' } });
    const delivered: EmailMessage[] = [];
    const sent = await sendCampaign(T, ORG, cmp.campaignId, { provider: { id: 'x', send: async (m: EmailMessage) => { delivered.push(m); } } });
    expect(delivered.map((m) => m.to)).toEqual(['b@x.com']);
    const preferenceUrl = delivered[0].body.match(/https:\/\/[^\s]+\/public-email\/p\/[^\s]+/)?.[0];
    expect(preferenceUrl).toBeDefined();
    const preferencePath = new URL(preferenceUrl!).pathname;
    expect(await (await fetch(`${BASE}${preferencePath}`)).text()).toContain('Product updates');
    expect(sent?.stats).toMatchObject({ sent: 1, skipped: 1 });
    await expect(createCampaign({ tenantId: T, orgId: ORG, templateId: tpl.templateId, topicId: 'etopic:nope', createdBy: 'u1' })).rejects.toMatchObject({ httpStatus: 400 });

    for (let i = (await listTopics(T, ORG)).length; i < MAX_TOPICS_PER_ORG; i++) await createTopic({ tenantId: T, orgId: ORG, name: `T${i}`, createdBy: 'u1' });
    await expect(createTopic({ tenantId: T, orgId: ORG, name: 'one too many', createdBy: 'u1' })).rejects.toMatchObject({ httpStatus: 409 });
  });
});

describe('the preference centre', () => {
  const page = async (token: string): Promise<string> => (await fetch(`${BASE}/host/openwop-app/public-email/p/${encodeURIComponent(token)}`)).text();
  const post = async (token: string, body: string): Promise<{ status: number; text: string }> => {
    const res = await fetch(`${BASE}/host/openwop-app/public-email/p/${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    return { status: res.status, text: await res.text() };
  };
  async function fixture(): Promise<{ token: string; campaignId: string; contactId: string; tp: string; other: string }> {
    const ct = await createContact({ tenantId: T, name: 'P', email: 'p@x.com', stage: 'lead' });
    await recordConsent({ tenantId: T, subjectKey: ct.contactId, categories: { marketing: true }, source: 'test' });
    const tp = await createTopic({ tenantId: T, orgId: ORG, name: 'Webinars', description: 'Upcoming sessions', createdBy: 'u1' });
    const other = await createTopic({ tenantId: T, orgId: 'other-org', name: 'Not yours', createdBy: 'u1' });
    const tpl = await createTemplate({ tenantId: T, orgId: ORG, name: 'N', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: T, orgId: ORG, templateId: tpl.templateId, createdBy: 'u1' });
    const token = await mintToken({ tenantId: T, campaignId: cmp.campaignId, orgId: ORG, contactId: ct.contactId, kind: 'preferences', email: 'p@x.com' });
    return { token, campaignId: cmp.campaignId, contactId: ct.contactId, tp: tp.topicId, other: other.topicId };
  }

  it('lists the org\'s topics; unticking opts out from any link; a foreign topic id is ignored', async () => {
    const f = await fixture();
    const html = await page(f.token);
    expect(html).toContain('Webinars');
    expect(html).not.toContain('Not yours');
    await __setTokenCreatedAtForTests(f.token, new Date(Date.now() - 90 * 86_400_000).toISOString());
    const r = await post(f.token, `email=on&topic:${encodeURIComponent(f.other)}=on`);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(await isTopicOptedOut(T, ORG, f.contactId, f.tp), 'unticked ⇒ opted out, even from a stale link').toBe(true);
    expect(await isTopicOptedOut(T, 'other-org', f.contactId, f.other)).toBe(false);
  });

  it('re-ticking an opted-out topic is WIDENING: refused from a stale link, accepted from a fresh one', async () => {
    const f = await fixture();
    await setTopicOptOut(T, ORG, f.contactId, f.tp, true, 'test');
    await __setTokenCreatedAtForTests(f.token, new Date(Date.now() - 90 * 86_400_000).toISOString());
    const stale = await post(f.token, `email=on&topic:${encodeURIComponent(f.tp)}=on`);
    expect(stale.status).toBe(409);
    expect(await isTopicOptedOut(T, ORG, f.contactId, f.tp)).toBe(true);
    await __setTokenCreatedAtForTests(f.token, new Date().toISOString());
    const freshPost = await post(f.token, `email=on&topic:${encodeURIComponent(f.tp)}=on`);
    expect(freshPost.status, freshPost.text.slice(0, 300)).toBe(200);
    expect(await isTopicOptedOut(T, ORG, f.contactId, f.tp)).toBe(false);
  });

  it.each(['bounced', 'complaint', 'manual'] as const)('public unsubscribe and preferences preserve an existing %s hold', async (reason) => {
    const f = await fixture();
    await addSuppression(T, 'p@x.com', reason, 'operator');
    // The STORED row must stay byte-identical. `listSuppressions` projects `channel` +
    // `address` onto every row on read (ADR 0955 D2), so compare the raw row, not the
    // projection: the legacy-keyed email row carries neither field on disk.
    const rowKey = `hostext:crm:suppression:${T}::p@x.com`;
    const stored = await __hostExtStorage()!.kvGet(rowKey);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toMatchObject({ reason, actor: 'operator' });
    const unsub = await mintToken({ tenantId: T, orgId: ORG, campaignId: f.campaignId, contactId: f.contactId, email: 'p@x.com', kind: 'unsubscribe' });
    const response = await fetch(`${BASE}/host/openwop-app/public-email/u/${encodeURIComponent(unsub)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    expect(response.status).toBe(200);
    expect(await __hostExtStorage()!.kvGet(rowKey)).toBe(stored);
    expect((await post(f.token, '')).status).toBe(200);
    expect(await __hostExtStorage()!.kvGet(rowKey)).toBe(stored);
    expect(await suppressionBlocksSend(T, 'p@x.com', { purpose: 'transactional' })).toBe('suppressed');
  });

  it('an unsubscribe losing its CAS to a new hard hold preserves the winning hold', async () => {
    const f = await fixture();
    const storage = __hostExtStorage()!;
    const realCas = storage.kvCompareAndSwap.bind(storage);
    let raced = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, before, after) => {
      if (!raced && key === `hostext:crm:suppression:${T}::p@x.com`) {
        raced = true;
        await addSuppression(T, 'p@x.com', 'complaint', 'provider');
      }
      return realCas(key, before, after);
    });
    try {
      expect((await post(f.token, '')).status).toBe(200);
      expect(raced).toBe(true);
      expect((await listSuppressions(T)).find((row) => row.email === 'p@x.com')).toMatchObject({ reason: 'complaint', actor: 'provider' });
      expect(await suppressionBlocksSend(T, 'p@x.com', { purpose: 'transactional' })).toBe('suppressed');
    } finally { spy.mockRestore(); }
  });

  it('an unreadable suppression cannot become an unsubscribe overwrite', async () => {
    await addSuppression(T, 'held@x.test', 'bounced', 'provider');
    const storage = __hostExtStorage()!;
    const realGet = storage.kvGet.bind(storage);
    const spy = vi.spyOn(storage, 'kvGet').mockImplementation(async (key) => {
      if (key === `hostext:crm:suppression:${T}::held@x.test`) throw new Error('injected read outage');
      return realGet(key);
    });
    try { await expect(addSuppression(T, 'held@x.test', 'unsubscribed', 'public')).rejects.toThrow('injected read outage'); }
    finally { spy.mockRestore(); }
    expect((await listSuppressions(T)).find((row) => row.email === 'held@x.test')).toMatchObject({ reason: 'bounced', actor: 'provider' });
  });

  it('DSAR completing between the topic barrier and write cannot leave a resurrected preference', async () => {
    const f = await fixture();
    const storage = __hostExtStorage()!;
    const realSet = storage.kvSet.bind(storage);
    let erased = false;
    const spy = vi.spyOn(storage, 'kvSet').mockImplementation(async (key, value) => {
      if (!erased && key.startsWith('hostext:consent:topic-optout:')) {
        erased = true;
        expect((await deleteSubject(T, f.contactId)).erasure.failed).toBe(0);
      }
      return realSet(key, value);
    });
    try {
      expect((await post(f.token, 'email=on')).status).toBe(409);
      expect(erased).toBe(true);
      expect(await isTopicOptedOut(T, ORG, f.contactId, f.tp)).toBe(false);
      expect((await storage.kvList('hostext:consent:topic-optout:')).some((row) => row.value.includes(f.contactId))).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it('merge provenance retains the survivor refusal without retaining an erased source id', async () => {
    const f = await fixture();
    const survivor = await createContact({ tenantId: T, name: 'Survivor', email: 'survivor@x.test', stage: 'lead' });
    await setTopicOptOut(T, ORG, f.contactId, f.tp, true, 'test');
    await mergeContacts(T, survivor.contactId, f.contactId, 'operator');
    expect(await isTopicOptedOut(T, ORG, survivor.contactId, f.tp)).toBe(true);
    expect((await deleteSubject(T, f.contactId)).erasure.failed).toBe(0);
    expect(await isTopicOptedOut(T, ORG, survivor.contactId, f.tp)).toBe(true);
    const rows = await __hostExtStorage()!.kvList('hostext:consent:topic-optout:');
    expect(rows.some((row) => row.value.includes(f.contactId))).toBe(false);
    expect(rows.some((row) => row.value.includes('crm-merge'))).toBe(true);
  });

  it('an old token narrows the merged recipient and its topic campaign actually skips delivery', async () => {
    const f = await fixture();
    const survivor = await createContact({ tenantId: T, name: 'Survivor', email: 'survivor@x.test', stage: 'lead' });
    await mergeContacts(T, survivor.contactId, f.contactId, 'operator');
    expect((await post(f.token, 'email=on')).status).toBe(200);
    expect(await isTopicOptedOut(T, ORG, survivor.contactId, f.tp)).toBe(true);
    await setSenderAddress(T, ORG, 'news@acme.test', 'operator');
    await setToggle('consent', 'off');
    const tpl = await createTemplate({ tenantId: T, orgId: ORG, name: 'Topic', subject: 'S', body: 'B', createdBy: 'operator' });
    const campaign = await createCampaign({ tenantId: T, orgId: ORG, templateId: tpl.templateId, topicId: f.tp, createdBy: 'operator' });
    const delivered: EmailMessage[] = [];
    const sent = await sendCampaign(T, ORG, campaign.campaignId, { provider: { id: 'test', send: async (message) => { delivered.push(message); } } });
    expect(delivered).toHaveLength(0);
    expect(sent?.stats).toMatchObject({ sent: 0, skipped: 1 });
  });

  it('campaign id reuse cannot move topic authority into another organization', async () => {
    const f = await fixture();
    expect(await deleteCampaign(T, ORG, f.campaignId)).toBe(true);
    const template = await createTemplate({ tenantId: T, orgId: 'other-org', name: 'Foreign', subject: 'S', body: 'B', createdBy: 'operator' });
    await createCampaign({ tenantId: T, orgId: 'other-org', campaignId: f.campaignId, templateId: template.templateId, createdBy: 'operator' });
    expect(await page(f.token)).toContain('Webinars');
    expect(await page(f.token)).not.toContain('Not yours');
    expect((await post(f.token, `email=on&topic:${encodeURIComponent(f.other)}=on`)).status).toBe(200);
    expect(await isTopicOptedOut(T, ORG, f.contactId, f.tp)).toBe(true);
    expect(await isTopicOptedOut(T, 'other-org', f.contactId, f.other)).toBe(false);
  });

  it('legacy unbound links retain channel controls without acquiring topic authority', async () => {
    const f = await fixture();
    const legacy = await mintToken({ tenantId: T, campaignId: f.campaignId, contactId: f.contactId, email: 'p@x.com', kind: 'preferences' });
    expect(await page(legacy)).not.toContain('Webinars');
    expect((await post(legacy, '')).status).toBe(200);
    expect(await isAllowed(T, f.contactId, 'marketing.email')).toBe(false);
    expect(await isTopicOptedOut(T, ORG, f.contactId, f.tp)).toBe(false);
  });


  it('a merge completing after preference resolution cannot strand a new refusal on the source', async () => {
    const f = await fixture();
    const survivor = await createContact({ tenantId: T, name: 'Survivor', email: 'survivor@x.test', stage: 'lead' });
    const storage = __hostExtStorage()!;
    const realSet = storage.kvSet.bind(storage);
    let merged = false;
    const spy = vi.spyOn(storage, 'kvSet').mockImplementation(async (key, value) => {
      if (!merged && key.startsWith('hostext:consent:topic-optout:')) {
        merged = true;
        await mergeContacts(T, survivor.contactId, f.contactId, 'operator');
      }
      return realSet(key, value);
    });
    try {
      expect((await post(f.token, 'email=on')).status).toBe(200);
      expect(merged).toBe(true);
      expect(await isTopicOptedOut(T, ORG, survivor.contactId, f.tp)).toBe(true);
    } finally { spy.mockRestore(); }
  });


  it.each(['unsubscribed', 'bounced'] as const)('a malformed foreign suppression cannot be returned or overwritten by %s', async (reason) => {
    const storage = __hostExtStorage()!;
    const key = `hostext:crm:suppression:${T}::malformed@x.test`;
    const raw = JSON.stringify({ key: 'foreign::malformed@x.test', tenantId: 'foreign', email: 'malformed@x.test', reason: 'manual', actor: 'foreign-operator', at: 'original' });
    await storage.kvSet(key, raw);
    await expect(addSuppression(T, 'malformed@x.test', reason, 'public')).rejects.toMatchObject({ httpStatus: 409 });
    expect(await storage.kvGet(key)).toBe(raw);
    expect(await suppressionBlocksSend(T, 'malformed@x.test', { purpose: 'transactional' })).toBe('unreadable');
    expect(await suppressionBlocksSend(T, 'malformed@x.test')).toBe('unreadable');
  });

});
