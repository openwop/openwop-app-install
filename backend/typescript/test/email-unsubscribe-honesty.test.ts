/**
 * EM-2 / EM-UX-1 — the public unsubscribe must not report success over a failed
 * durable write.
 *
 * `recordUnsubscribe` used to catch BOTH send-stopping writes (the marketing
 * consent revocation and the `crm:suppression` upsert) into `log.warn` and
 * `return true` unconditionally, so the route rendered *"You are unsubscribed.
 * No further marketing email will be sent to this address."* over a person who
 * was still on the list — and the operator's Engagement panel showed a clean
 * `Unsubscribes: 1`, corroborating the false claim on every surface.
 *
 * This suite is the missing injection the grade-code pass named: nothing in the
 * repo ever made `recordConsent`/`addSuppression` fail inside `recordUnsubscribe`,
 * which is why the defect shipped. Every case below is RED on `origin/main`:
 * the outcome was a bare `true`, the route always answered 200 with the done
 * page, and `EngagementStats` had no `unsubscribesUnenforced` field at all.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Flipped per-test to fail exactly one leg at a time. */
let consentFails = false;
let suppressionFails = false;

// Review F4 — this intercepted `recordConsent`, which is what `recordUnsubscribe`
// USED to call. Moving that lane onto `mergeConsentCategories` (so the write
// stops destroying the subject's `legalBasis`/`purposes`/`region`) made the
// injection INERT: the mock still applied, the consent write still succeeded,
// and the two "consent gate throws" cases below went red because nothing threw.
// That is the failure mode this file exists to prevent, one level up — a
// failure-injection harness that no longer injects reads exactly like a passing
// system. It is retargeted at the writer the code actually calls, and it caught
// itself only because the assertions are about the OUTCOME rather than the mock.
vi.mock('../src/features/consent/consentService.js', async (orig) => {
  const actual = await orig<typeof import('../src/features/consent/consentService.js')>();
  return {
    ...actual,
    mergeConsentCategories: async (...args: Parameters<typeof actual.mergeConsentCategories>) => {
      if (consentFails) throw new Error('consent store unavailable');
      return actual.mergeConsentCategories(...args);
    },
  };
});

vi.mock('../src/features/crm/suppressionService.js', async (orig) => {
  const actual = await orig<typeof import('../src/features/crm/suppressionService.js')>();
  return {
    ...actual,
    addSuppression: async (...args: Parameters<typeof actual.addSuppression>) => {
      if (suppressionFails) throw new Error('suppression store unavailable');
      return actual.addSuppression(...args);
    },
  };
});

import { createApp } from '../src/index.js';
import { mintToken, recordUnsubscribe, engagementStats, __clearEngagement } from '../src/features/email/engagementService.js';
import { isSuppressed } from '../src/features/crm/suppressionService.js';
import { getConsent, recordConsent, isAllowed, MARKETING_CHANNELS } from '../src/features/consent/consentService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

beforeEach(async () => {
  consentFails = false;
  suppressionFails = false;
  await __clearEngagement();
});

const T = 'user:unsub-honesty';
/** The English done-page claim the recipient must never see over a failed write. */
const DONE_CLAIM = 'No further marketing email will be sent to this address.';
const FAILED_CLAIM = 'You have NOT been removed from this list yet';

async function mintUnsub(campaignId: string, contactId: string, email: string): Promise<string> {
  return mintToken({ tenantId: T, campaignId, contactId, kind: 'unsubscribe', email });
}
const unsubUrl = (token: string): string =>
  `${BASE}/v1/host/openwop-app/public-email/u/${encodeURIComponent(token)}`;

describe('EM-2 — recordUnsubscribe reports what actually persisted', () => {
  it('returns revoked only when BOTH send-stopping writes land', async () => {
    const tok = await mintUnsub('cmp-ok', 'ct-ok', 'ok@example.com');
    expect(await recordUnsubscribe(tok)).toEqual({ status: 'revoked', unenforced: [] });
    expect(await isSuppressed(T, 'ok@example.com')).toBe(true);
    expect((await getConsent(T, 'ct-ok'))?.categories.marketing).toBe(false);
  });

  it('returns partial naming the consent gate when the consent revoke throws', async () => {
    const tok = await mintUnsub('cmp-c', 'ct-c', 'c@example.com');
    consentFails = true;
    expect(await recordUnsubscribe(tok)).toEqual({ status: 'partial', unenforced: ['consent'] });
  });

  it('returns partial naming the suppression gate when the suppression upsert throws', async () => {
    const tok = await mintUnsub('cmp-s', 'ct-s', 's@example.com');
    suppressionFails = true;
    expect(await recordUnsubscribe(tok)).toEqual({ status: 'partial', unenforced: ['suppression'] });
    // The consent half DID land — 'partial' is not 'nothing happened'.
    expect((await getConsent(T, 'ct-s'))?.categories.marketing).toBe(false);
  });

  it('names BOTH gates when both throw — the exact state that shipped a false success', async () => {
    const tok = await mintUnsub('cmp-b', 'ct-b', 'b@example.com');
    consentFails = true;
    suppressionFails = true;
    const outcome = await recordUnsubscribe(tok);
    expect(outcome.status).toBe('partial');
    expect(outcome.unenforced.sort()).toEqual(['consent', 'suppression']);
    // And the recipient really is still reachable, which is the whole point.
    expect(await isSuppressed(T, 'b@example.com')).toBe(false);
  });

  it('an unknown token is inert and distinguishable from a failure', async () => {
    expect(await recordUnsubscribe('tok:missing')).toEqual({ status: 'unknown', unenforced: [] });
  });

  it('a consent failure does not stop the suppression write from being attempted', async () => {
    // Ordering guard: the two gates are independent, so one failing leg must not
    // cost the other. (It also used to be possible for an engagement-row throw to
    // abort BOTH before either ran.)
    const tok = await mintUnsub('cmp-i', 'ct-i', 'i@example.com');
    consentFails = true;
    await recordUnsubscribe(tok);
    expect(await isSuppressed(T, 'i@example.com')).toBe(true);
  });
});

describe('EM-UX-1 — the operator surface distinguishes recorded from enforced', () => {
  it('stamps the engagement row so a partial unsubscribe is not a clean one', async () => {
    const tok = await mintUnsub('cmp-op', 'ct-op', 'op@example.com');
    suppressionFails = true;
    await recordUnsubscribe(tok);
    const stats = await engagementStats(T, 'cmp-op');
    // The engagement row still writes (the operator must see the request), but it
    // must NOT read as an honoured opt-out.
    expect(stats.unsubscribes).toBe(1);
    expect(stats.unsubscribesUnenforced).toBe(1);
  });

  it('a retry that lands the writes CLEARS the warning in place', async () => {
    const tok = await mintUnsub('cmp-rt', 'ct-rt', 'rt@example.com');
    suppressionFails = true;
    await recordUnsubscribe(tok);
    expect((await engagementStats(T, 'cmp-rt')).unsubscribesUnenforced).toBe(1);

    suppressionFails = false;
    expect((await recordUnsubscribe(tok)).status).toBe('revoked');
    const stats = await engagementStats(T, 'cmp-rt');
    expect(stats.unsubscribes).toBe(1);          // still ONE person, not two rows
    expect(stats.unsubscribesUnenforced).toBe(0); // and the panel now reads clean
  });

  it('a clean unsubscribe reports zero unenforced', async () => {
    const tok = await mintUnsub('cmp-cl', 'ct-cl', 'cl@example.com');
    await recordUnsubscribe(tok);
    const stats = await engagementStats(T, 'cmp-cl');
    expect(stats.unsubscribes).toBe(1);
    expect(stats.unsubscribesUnenforced).toBe(0);
  });
});

describe('EM-UX-1 — the public page never claims an unsubscribe that did not land', () => {
  it('POST answers 503 with the honest failure copy and a RETRY form', async () => {
    const tok = await mintUnsub('cmp-p1', 'ct-p1', 'p1@example.com');
    consentFails = true;
    suppressionFails = true;
    const res = await fetch(unsubUrl(tok), { method: 'POST' });
    // 503, not 200: an RFC 8058 one-click POST is a machine caller that reads the
    // status, so a 200 tells the provider it succeeded and it never retries.
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).not.toContain(DONE_CLAIM);
    expect(html).toContain(FAILED_CLAIM);
    // The done state renders no form; the failure state MUST, or the recipient
    // has no way to retry at all (the aggravator that made EM-2 a Blocker).
    expect(html).toContain('<form method="post"');
    expect(html).toContain('role="alert"');
  });

  it('POST answers 200 with the done page once the writes land', async () => {
    const tok = await mintUnsub('cmp-p2', 'ct-p2', 'p2@example.com');
    const res = await fetch(unsubUrl(tok), { method: 'POST' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(DONE_CLAIM);
    expect(html).not.toContain(FAILED_CLAIM);
  });

  it('the recipient can retry from the failure page and reach the done page', async () => {
    const tok = await mintUnsub('cmp-p3', 'ct-p3', 'p3@example.com');
    suppressionFails = true;
    const first = await fetch(unsubUrl(tok), { method: 'POST' });
    expect(first.status).toBe(503);
    suppressionFails = false;
    const second = await fetch(unsubUrl(tok), { method: 'POST' });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain(DONE_CLAIM);
    expect(await isSuppressed(T, 'p3@example.com')).toBe(true);
  });

  it('an unknown token still 404s — a failure is not a bad link', async () => {
    const res = await fetch(unsubUrl('tok:nope'), { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('GET still renders the scanner-safe confirm form and mutates nothing', async () => {
    const tok = await mintUnsub('cmp-p4', 'ct-p4', 'p4@example.com');
    const res = await fetch(unsubUrl(tok));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form method="post"');
    expect(html).not.toContain(DONE_CLAIM);
    expect(html).not.toContain(FAILED_CLAIM);
    expect(await isSuppressed(T, 'p4@example.com')).toBe(false);
  });
});

describe('EM-2 — the preference center all-off path is honest too', () => {
  it('a failed suppression overlay renders the partial state, not "saved"', async () => {
    const tok = await mintToken({ tenantId: T, campaignId: 'cmp-pc', contactId: 'ct-pc', kind: 'preferences', email: 'pc@example.com' });
    suppressionFails = true;
    const res = await fetch(`${BASE}/v1/host/openwop-app/public-email/p/${encodeURIComponent(tok)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '', // every channel off = a full opt-out
    });
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).not.toContain('Your preferences have been saved.');
    expect(html).toContain('could not complete the full opt-out');
  });

  it('a landed overlay still renders the saved state', async () => {
    const tok = await mintToken({ tenantId: T, campaignId: 'cmp-pc2', contactId: 'ct-pc2', kind: 'preferences', email: 'pc2@example.com' });
    const res = await fetch(`${BASE}/v1/host/openwop-app/public-email/p/${encodeURIComponent(tok)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Your preferences have been saved.');
  });
});

/**
 * Review F4 — CONS-3's census ("all three wholesale writers") missed TWO, and
 * both are public + unauthenticated.
 *
 * `features/email/routes.ts` (the ADR 0227 preference centre) and
 * `engagementService.recordUnsubscribe` (one-click unsubscribe) both still
 * called latest-wins `recordConsent` in the hand-preserve-`analytics` AUDIT-5
 * shape that `formsConsentSink`'s own docblock says was removed as a CLASS.
 * `recordConsent` builds the row from `input` alone, so clicking unsubscribe
 * DESTROYED the subject's stored `legalBasis`, `purposes` and `region` — the
 * Art. 6 lawful-basis evidence a controller must be able to produce, and
 * exactly the three fields `mergeConsentCategories` was extended to preserve
 * in this very PR.
 *
 * The second half of each case is the trap the fix introduces if applied
 * naively: under MERGE semantics a stored `marketing.email: true` outlives a
 * bare `{ marketing: false }`, and `isAllowed` prefers the specific over the
 * umbrella — an unsubscribe that does not unsubscribe. Replace-semantics hid
 * that by dropping every specific.
 */
describe('review F4 — the public opt-out lanes preserve lawful-basis evidence AND still opt out', () => {
  // The `consent` toggle MUST be on for the `isAllowed` assertions below to mean
  // anything: with it off, `isAllowed` short-circuits `return true` for every
  // NON-strict category (the honest-opt-in posture), so an assertion that the
  // opt-out bites would have been evaluating the toggle, not the record. Caught
  // by this suite failing on `marketing.sms` while `marketing.whatsapp` — the
  // one STRICT_EXPLICIT_OPT_IN category, which ignores the toggle — passed. A
  // green here without this line would have been a vacuous green.
  beforeAll(async () => {
    const d = getToggleDefault('consent');
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  });
  afterAll(async () => {
    const d = getToggleDefault('consent');
    if (d) await saveConfig(d, 'test');
  });

  it('one-click unsubscribe keeps legalBasis/purposes/region, and silences EVERY channel', async () => {
    // The subject as a real consent capture leaves them: an explicit lawful
    // basis, opaque purpose codes, a region, and per-channel opt-INs.
    await recordConsent({
      tenantId: T, subjectKey: 'ct-f4a',
      categories: {
        analytics: true, marketing: true,
        'marketing.email': true, 'marketing.sms': true, 'marketing.push': true, 'marketing.whatsapp': true,
      },
      source: 'preference-center', legalBasis: 'consent', region: 'EU', purposes: ['marketing_email'],
    });

    const tok = await mintToken({ tenantId: T, campaignId: 'cmp-f4a', contactId: 'ct-f4a', kind: 'unsubscribe', email: 'f4a@example.com' });
    const out = await recordUnsubscribe(tok);
    expect(out.status).toBe('revoked');
    expect(out.unenforced).toEqual([]);

    const rec = await getConsent(T, 'ct-f4a');
    // THE EVIDENCE. Before the fix all three were gone — silently, on a public
    // unauthenticated click.
    expect(rec!.legalBasis, 'Art. 6 lawful basis must survive an unsubscribe').toBe('consent');
    expect(rec!.purposes).toEqual(['marketing_email']);
    expect(rec!.region).toBe('EU');
    // …and the unrelated category the merge is supposed to leave alone.
    expect(rec!.categories.analytics).toBe(true);

    // THE OPT-OUT STILL BITES. Not just the umbrella: every specific, or the
    // surviving `true` would win over it.
    expect(rec!.categories.marketing).toBe(false);
    for (const ch of MARKETING_CHANNELS) {
      expect(rec!.categories[`marketing.${ch}`], `marketing.${ch} must be explicitly false`).toBe(false);
      expect(await isAllowed(T, 'ct-f4a', `marketing.${ch}`), `isAllowed must deny marketing.${ch}`).toBe(false);
    }
    expect(await isAllowed(T, 'ct-f4a', 'marketing')).toBe(false);
  });

  it('the preference centre keeps the evidence, and an ALL-OFF submit silences every channel', async () => {
    await recordConsent({
      tenantId: T, subjectKey: 'ct-f4b',
      categories: { analytics: true, marketing: true, 'marketing.sms': true, 'marketing.whatsapp': true },
      source: 'crm-import', legalBasis: 'legitimate-interest', region: 'BR', purposes: ['marketing_sms'],
    });

    const tok = await mintToken({ tenantId: T, campaignId: 'cmp-f4b', contactId: 'ct-f4b', kind: 'preferences', email: 'f4b@example.com' });
    const res = await fetch(`${BASE}/v1/host/openwop-app/public-email/p/${encodeURIComponent(tok)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '', // every box unticked = a full marketing opt-out
    });
    expect(res.status).toBe(200);

    const rec = await getConsent(T, 'ct-f4b');
    expect(rec!.legalBasis).toBe('legitimate-interest');
    expect(rec!.purposes).toEqual(['marketing_sms']);
    expect(rec!.region).toBe('BR');
    expect(rec!.categories.analytics).toBe(true);
    // WHATSAPP is the one this page has no control for. On an all-off submit
    // the subject IS speaking to the whole umbrella, so it must go false too —
    // a surviving `marketing.whatsapp: true` is a strict-opt-in channel that
    // would keep sending after a full opt-out.
    expect(rec!.categories['marketing.whatsapp']).toBe(false);
    expect(rec!.categories['marketing.sms']).toBe(false);
    expect(await isAllowed(T, 'ct-f4b', 'marketing.whatsapp')).toBe(false);
    expect(await isAllowed(T, 'ct-f4b', 'marketing.sms')).toBe(false);
  });

  it('a PARTIAL preference submit does not revoke the channel the page cannot show', async () => {
    // The mirror image, and the reason the all-off branch is asymmetric: this
    // page has no whatsapp control, so ticking "email" must not silently revoke
    // a whatsapp opt-in the subject never spoke to. The wholesale write DID —
    // it dropped every specific it did not name.
    await recordConsent({
      tenantId: T, subjectKey: 'ct-f4c',
      categories: { analytics: false, marketing: true, 'marketing.whatsapp': true },
      source: 'whatsapp-optin', legalBasis: 'consent',
    });

    const tok = await mintToken({ tenantId: T, campaignId: 'cmp-f4c', contactId: 'ct-f4c', kind: 'preferences', email: 'f4c@example.com' });
    const res = await fetch(`${BASE}/v1/host/openwop-app/public-email/p/${encodeURIComponent(tok)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=on',
    });
    expect(res.status).toBe(200);

    const rec = await getConsent(T, 'ct-f4c');
    expect(rec!.categories['marketing.email']).toBe(true);
    expect(rec!.categories['marketing.whatsapp'], 'a channel this page cannot show is not revoked by it').toBe(true);
    expect(await isAllowed(T, 'ct-f4c', 'marketing.whatsapp')).toBe(true);
    expect(rec!.legalBasis).toBe('consent');
  });
});
