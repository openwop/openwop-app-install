/**
 * Per-channel consent + preference center (ADR 0227 / D2):
 *   - `marketing.<channel>` resolution matrix: no record → policy default;
 *     umbrella-only record → the umbrella governs every channel; a recorded
 *     specific governs its channel (both directions), others fall back;
 *   - `sendCampaign` gates on `marketing.email` (specific-off skips even with
 *     the umbrella on);
 *   - journeys `checkEligibility` takes an optional channel (default email);
 *   - the public preference center: GET renders prefilled checkboxes, POST
 *     writes specifics + the derived umbrella through consentService, all-off
 *     adds the `crm:suppression` overlay, unknown tokens 404, idempotent.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { isAllowed, recordConsent, getConsent, setPolicy, __resetConsentStore } from '../src/features/consent/consentService.js';
import { createTemplate, createCampaign, sendCampaign, listSends, setSenderAddress } from '../src/features/email/emailService.js';
import { mintToken, instrumentBody } from '../src/features/email/engagementService.js';
import { checkEligibility } from '../src/features/campaign-journeys/journeyService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { isSuppressed } from '../src/features/crm/suppressionService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const enableConsent = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('consent'); if (d) await saveConfig({ ...d, status }, 'test'); };

describe('ADR 0227 — marketing.<channel> resolution matrix', () => {
  it('specific governs; else umbrella; else policy default (fail-closed opt-in)', async () => {
    await __resetConsentStore();
    try {
      await enableConsent('on');
      const T = 'tChMatrix';
      // 1. No record + opt-in default ⇒ deny (channel and umbrella alike).
      expect(await isAllowed(T, 's-none', 'marketing.email')).toBe(false);
      expect(await isAllowed(T, 's-none', 'marketing')).toBe(false);
      // 2. Umbrella-only record (a pre-ADR-0227 record shape) ⇒ governs every channel.
      await recordConsent({ tenantId: T, subjectKey: 's-umbrella', categories: { marketing: true }, source: 'test' });
      expect(await isAllowed(T, 's-umbrella', 'marketing.email')).toBe(true);
      expect(await isAllowed(T, 's-umbrella', 'marketing.sms')).toBe(true);
      expect(await isAllowed(T, 's-umbrella', 'marketing.push')).toBe(true);
      // 3. Specific OFF + umbrella ON ⇒ the specific governs its channel; the
      //    others fall back to the umbrella; the umbrella ask itself is untouched.
      await recordConsent({ tenantId: T, subjectKey: 's-specific-off', categories: { marketing: true, 'marketing.email': false }, source: 'test' });
      expect(await isAllowed(T, 's-specific-off', 'marketing.email')).toBe(false);
      expect(await isAllowed(T, 's-specific-off', 'marketing.sms')).toBe(true);
      expect(await isAllowed(T, 's-specific-off', 'marketing')).toBe(true);
      // 4. Specific ON + umbrella OFF ⇒ the specific still governs its channel.
      await recordConsent({ tenantId: T, subjectKey: 's-specific-on', categories: { marketing: false, 'marketing.email': true }, source: 'test' });
      expect(await isAllowed(T, 's-specific-on', 'marketing.email')).toBe(true);
      expect(await isAllowed(T, 's-specific-on', 'marketing.sms')).toBe(false);
      expect(await isAllowed(T, 's-specific-on', 'marketing')).toBe(false);
      // 5. Opt-out policy + no record ⇒ allow (the existing default path).
      const T2 = 'tChOptOut';
      await setPolicy(T2, { defaultMode: 'opt-out' });
      expect(await isAllowed(T2, 's-none', 'marketing.email')).toBe(true);
    } finally { await enableConsent('off'); }
  });

  it('recordConsent stores specifics only when sent as booleans (absence means "umbrella governs")', async () => {
    const rec = await recordConsent({
      tenantId: 'tChSan', subjectKey: 's1',
      categories: { marketing: true, 'marketing.email': false, 'marketing.sms': 'yes', junk: true },
      source: 'test',
    });
    expect(rec.categories.marketing).toBe(true);
    expect(rec.categories['marketing.email']).toBe(false);
    expect(rec.categories['marketing.sms']).toBeUndefined(); // non-boolean dropped
    expect(rec.categories['marketing.push']).toBeUndefined(); // absent stays absent
    expect(Object.keys(rec.categories)).not.toContain('junk');
  });
});

describe('ADR 0227 — sendCampaign gates on marketing.email', () => {
  const okProvider = { id: 'test-transport', send: async (): Promise<void> => {} };
  it('specific-off skips even with the umbrella on; umbrella-only still sends', async () => {
    const T = 'tChSend';
    await setSenderAddress(T, 'o1', 'sender@acme.test', 'u1');
    const umbrellaOnly = await createContact({ tenantId: T, name: 'Umbrella', email: 'umbrella@x.com', stage: 'lead' });
    const specificOff = await createContact({ tenantId: T, name: 'NoEmailCh', email: 'noemailch@x.com', stage: 'lead' });
    await recordConsent({ tenantId: T, subjectKey: umbrellaOnly.contactId, categories: { marketing: true }, source: 'test' });
    await recordConsent({ tenantId: T, subjectKey: specificOff.contactId, categories: { marketing: true, 'marketing.email': false }, source: 'test' });
    const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'T', subject: 'S', body: 'B', createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    try {
      await enableConsent('on');
      const sent = await sendCampaign(T, 'o1', cmp.campaignId, { provider: okProvider });
      expect(sent?.stats).toMatchObject({ sent: 1, skipped: 1, failed: 0 });
      const sends = await listSends(T, cmp.campaignId);
      expect(sends.find((s) => s.contactId === specificOff.contactId)).toMatchObject({ status: 'skipped', error: 'consent' });
      expect(sends.find((s) => s.contactId === umbrellaOnly.contactId)).toMatchObject({ status: 'sent' });
    } finally { await enableConsent('off'); }
  });
});

describe('ADR 0227 — journeys eligibility takes a channel', () => {
  it('email-off contact is ineligible for email (default) but eligible for sms (umbrella fallback)', async () => {
    const T = 'tChJourney';
    const c = await createContact({ tenantId: T, name: 'Jo', email: 'jo-ch@example.com' });
    await recordConsent({ tenantId: T, subjectKey: c.contactId, categories: { marketing: true, 'marketing.email': false }, source: 'test' });
    try {
      await enableConsent('on');
      expect(await checkEligibility(T, c.contactId)).toEqual({ eligible: false, reason: 'consent' }); // default 'email'
      expect(await checkEligibility(T, c.contactId, 'sms')).toMatchObject({ eligible: true, email: 'jo-ch@example.com' });
    } finally { await enableConsent('off'); }
  });
});

describe('ADR 0227 — public preference center', () => {
  const T = 'tChPrefs';
  const MINT = { tenantId: T, campaignId: 'cmp-prefs', contactId: 'ct-prefs', email: 'prefs@example.com' } as const;
  const postForm = async (token: string, body: string): Promise<{ status: number; text: string }> => {
    const res = await fetch(`${BASE}/host/openwop-app/public-email/p/${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    });
    return { status: res.status, text: await res.text() };
  };

  it('GET renders prefilled from specifics ?? umbrella; POST writes through consentService', async () => {
    await recordConsent({ tenantId: T, subjectKey: MINT.contactId, categories: { marketing: true }, source: 'test' });
    const token = await mintToken({ ...MINT, kind: 'preferences' });

    // Umbrella-only ⇒ every channel prefills checked (the fallback).
    const page1 = await fetch(`${BASE}/host/openwop-app/public-email/p/${encodeURIComponent(token)}`);
    expect(page1.status).toBe(200);
    expect(page1.headers.get('content-type')).toContain('text/html');
    const html1 = await page1.text();
    expect(html1).toContain('name="email" checked');
    expect(html1).toContain('name="sms" checked');
    expect(html1).toContain('name="push" checked');
    expect(html1).not.toContain('prefs@example.com'); // no PII on the page
    expect(html1).not.toContain('ct-prefs');

    // POST email only ⇒ specifics recorded, umbrella true (a channel is on).
    const saved = await postForm(token, 'email=on');
    expect(saved.status).toBe(200);
    expect(saved.text).toContain('saved');
    const rec = await getConsent(T, MINT.contactId);
    expect(rec?.categories).toMatchObject({ marketing: true, 'marketing.email': true, 'marketing.sms': false, 'marketing.push': false });
    expect(await isSuppressed(T, MINT.email)).toBe(false);

    // GET again ⇒ prefills from the specifics now.
    const html2 = await (await fetch(`${BASE}/host/openwop-app/public-email/p/${encodeURIComponent(token)}`)).text();
    expect(html2).toContain('name="email" checked');
    expect(html2).not.toContain('name="sms" checked');
    expect(html2).not.toContain('name="push" checked');
  });

  it('all-off revokes the umbrella AND adds the suppression overlay; idempotent; unknown token 404s', async () => {
    const token = await mintToken({ ...MINT, kind: 'preferences' });
    const off = await postForm(token, '');
    expect(off.status).toBe(200);
    const rec = await getConsent(T, MINT.contactId);
    expect(rec?.categories).toMatchObject({ marketing: false, 'marketing.email': false, 'marketing.sms': false, 'marketing.push': false });
    expect(await isSuppressed(T, MINT.email)).toBe(true);
    // Idempotent: a repeat POST is the same outcome, no error.
    expect((await postForm(token, '')).status).toBe(200);
    // Unknown token: 404 on both verbs.
    //
    // EM-UX-2 — this assertion used to pin `content-type: text/plain` and, below
    // it, that an UNSUBSCRIBE token "does not open the page" as INTENDED
    // behaviour. The kind check is genuinely intended and stays. What was not
    // intended is what the product did with it: the unsubscribe page built its
    // "Manage preferences" / "choose which messages instead" links from the
    // unsubscribe token itself, so BOTH links 404'd for every recipient, always
    // — and this test protected that. The page now links the SIBLING preferences
    // token (or omits the link), and the refusal is a localized styled page
    // rather than a bare sentence with no heading and no way forward.
    const badGet = await fetch(`${BASE}/host/openwop-app/public-email/p/tok%3Anope`);
    expect(badGet.status).toBe(404);
    expect(badGet.headers.get('content-type')).toContain('text/html');
    const badHtml = await badGet.text();
    expect(badHtml).toContain('This link did not work');
    expect(badHtml).toContain('role="alert"');
    expect((await postForm('tok:nope', 'email=on')).status).toBe(404);
    // The kind check itself: a non-preferences token still does not open the
    // page — a preferences token is the capability, and an unsubscribe token is
    // not it.
    const unsub = await mintToken({ ...MINT, kind: 'unsubscribe' });
    expect((await fetch(`${BASE}/host/openwop-app/public-email/p/${encodeURIComponent(unsub)}`)).status).toBe(404);
  });

  it('EM-UX-2 — the unsubscribe page links a preferences URL that actually resolves', async () => {
    // The real send path: `instrumentBody` mints the pair, so the unsubscribe
    // row carries its sibling.
    const body = await instrumentBody('Read more: https://example.test/x', BASE, MINT);
    const unsubUrl = /\/host\/openwop-app\/public-email\/u\/\S+/.exec(body)?.[0];
    expect(unsubUrl, 'the body must carry an unsubscribe line').toBeTruthy();

    const page = await fetch(`${BASE}${unsubUrl!}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const prefsHref = /\/host\/openwop-app\/public-email\/p\/[^"]+/.exec(html)?.[0];
    expect(prefsHref, 'the page must offer a preferences link').toBeTruthy();
    // The whole defect: this used to be the UNSUBSCRIBE token, which /p rejects.
    expect(prefsHref).not.toContain(unsubUrl!.split('/u/')[1]!);
    // Follow it — it must open the preference center, not the 404.
    const followed = await fetch(`${BASE}${prefsHref!}`);
    expect(followed.status, 'the linked preferences URL must resolve').toBe(200);
    expect(await followed.text()).toContain('name="email"');
  });

  it('EM-UX-2 — a token with no sibling OMITS the link rather than emitting a dead one', async () => {
    // Rows minted before the pair was stored (and any run whose preferences mint
    // failed) carry no sibling. An absent escape hatch is honest; a dead one is
    // the defect.
    const lone = await mintToken({ ...MINT, kind: 'unsubscribe' });
    const page = await fetch(`${BASE}/host/openwop-app/public-email/u/${encodeURIComponent(lone)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain('/public-email/p/');
    expect(html).toContain('<form method="post"'); // the opt-out itself still works
  });
});
