/**
 * Campaign Journeys (ADR 0222 / campaign gap plan C6):
 *   - enrollment is idempotent per (journey, contact), tenant-isolated, and
 *     resettable only explicitly;
 *   - eligibility composes contact + email + consent + suppression;
 *   - the pack nodes stop honestly (already_enrolled / not_eligible) and
 *     resolve the contact from the trigger payload (ADR 0208).
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { enroll, resetEnrollment, listEnrollments, checkEligibility, checkEngagement, checkFrequency, resolveSegment, activeInGroup, __clearEnrollments } from '../src/features/campaign-journeys/journeyService.js';
import { buildCampaignJourneysSurface } from '../src/features/campaign-journeys/surface.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { addSuppression } from '../src/features/crm/suppressionService.js';
import { createSegment } from '../src/features/crm/segmentsService.js';
import { mintToken, recordOpen, recordClick } from '../src/features/email/engagementService.js';
import * as pack from '../../../packs/feature.campaign-journeys.nodes/index.mjs';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const T = 'user:journeys-test';

describe('ADR 0222 — enrollment guard', () => {
  it('enrolls once, blocks repeats, isolates tenants, resets explicitly', async () => {
    await __clearEnrollments();
    expect((await enroll(T, 'welcome', 'ct-1', 'run-1')).enrolled).toBe(true);
    const again = await enroll(T, 'welcome', 'ct-1', 'run-2');
    expect(again.enrolled).toBe(false);
    expect(again.enrolledAt).toBeTruthy();
    // A different journey or contact is independent; tenants are isolated.
    expect((await enroll(T, 'winback', 'ct-1')).enrolled).toBe(true);
    expect((await enroll('user:other', 'welcome', 'ct-1')).enrolled).toBe(true);
    expect((await listEnrollments(T, 'welcome')).map((e) => e.contactId)).toEqual(['ct-1']);
    // Reset re-opens exactly the one pair.
    expect(await resetEnrollment(T, 'welcome', 'ct-1')).toBe(true);
    expect((await enroll(T, 'welcome', 'ct-1')).enrolled).toBe(true);
  });

  it('is CONCURRENCY-safe: N simultaneous enrolls of the same pair yield exactly one winner (grade-code AUDIT-2)', async () => {
    await __clearEnrollments();
    const results = await Promise.all(Array.from({ length: 8 }, () => enroll(T, 'welcome', 'ct-race', 'run-x')));
    expect(results.filter((r) => r.enrolled)).toHaveLength(1); // the double-send guard the feature exists for
    expect((await listEnrollments(T, 'welcome'))).toHaveLength(1);
  });
});

describe('ADR 0299 — cross-journey priority arbitration (CDP-E)', () => {
  const G = 'lifecycle';

  it('higher-priority journey wins an exclusivity group; the lower is superseded', async () => {
    await __clearEnrollments();
    // Low-priority journey enrolls first and holds the group.
    const low = await enroll(T, 'nurture', 'ct-a', 'run-lo', { exclusivityGroup: G, priority: 5 });
    expect(low.enrolled).toBe(true);
    expect((await activeInGroup(T, G, 'ct-a'))?.journeyId).toBe('nurture');
    // A higher-priority journey qualifies → it wins and displaces the incumbent.
    const high = await enroll(T, 'winback-vip', 'ct-a', 'run-hi', { exclusivityGroup: G, priority: 10 });
    expect(high.enrolled).toBe(true);
    expect(high.displacedJourneyId).toBe('nurture');
    expect((await activeInGroup(T, G, 'ct-a'))?.journeyId).toBe('winback-vip');
    // A lower-priority challenger against the new holder is skipped (superseded), NOT double-enrolled.
    const loser = await enroll(T, 'nurture', 'ct-a', 'run-lo2', { exclusivityGroup: G, priority: 5 });
    expect(loser.enrolled).toBe(false);
    expect(loser.reason).toBe('superseded');
    expect((await activeInGroup(T, G, 'ct-a'))?.journeyId).toBe('winback-vip');
  });

  it('re-firing the incumbent journey is idempotent (no re-enroll)', async () => {
    await __clearEnrollments();
    expect((await enroll(T, 'nurture', 'ct-idem', undefined, { exclusivityGroup: G, priority: 5 })).enrolled).toBe(true);
    const again = await enroll(T, 'nurture', 'ct-idem', undefined, { exclusivityGroup: G, priority: 5 });
    expect(again.enrolled).toBe(false);
    expect(again.reason).toBe('already_enrolled');
  });

  it('concurrent competing enrolls in a group → exactly ONE active winner (the CAS holds, no double-enroll)', async () => {
    await __clearEnrollments();
    // Two DIFFERENT journeys, priorities 5 and 10, race for the same (group, contact).
    const results = await Promise.all([
      enroll(T, 'nurture', 'ct-race', 'r1', { exclusivityGroup: G, priority: 5 }),
      enroll(T, 'winback-vip', 'ct-race', 'r2', { exclusivityGroup: G, priority: 10 }),
    ]);
    // Whatever the interleaving, the group holds exactly one journey — and it is
    // deterministically the higher-priority one.
    const active = await activeInGroup(T, G, 'ct-race');
    expect(active?.journeyId).toBe('winback-vip');
    // The slot row is unique: only one enrollment key exists for this (group, contact).
    const rows = (await listEnrollments(T)).filter((e) => e.contactId === 'ct-race' && e.exclusivityGroup === G);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.journeyId).toBe('winback-vip');
    // At least one call reports enrolled:true for the winner; the lower one never wins concurrently.
    expect(results.some((r) => r.enrolled && r.reason === undefined)).toBe(true);
  });

  it('tie-break is deterministic (equal priority ⇒ lexicographically-smaller journeyId wins), regardless of order', async () => {
    // Order A-then-B.
    await __clearEnrollments();
    await enroll(T, 'j-alpha', 'ct-tie', undefined, { exclusivityGroup: G, priority: 7 });
    await enroll(T, 'j-beta', 'ct-tie', undefined, { exclusivityGroup: G, priority: 7 });
    expect((await activeInGroup(T, G, 'ct-tie'))?.journeyId).toBe('j-alpha');
    // Reverse order B-then-A → same winner.
    await __clearEnrollments();
    await enroll(T, 'j-beta', 'ct-tie', undefined, { exclusivityGroup: G, priority: 7 });
    await enroll(T, 'j-alpha', 'ct-tie', undefined, { exclusivityGroup: G, priority: 7 });
    expect((await activeInGroup(T, G, 'ct-tie'))?.journeyId).toBe('j-alpha');
  });

  it('journeys with NO exclusivityGroup are unchanged — arbitration never touches them (regression)', async () => {
    await __clearEnrollments();
    // Same contact, two ungrouped journeys → BOTH enroll (independent), exactly as ADR 0222.
    expect((await enroll(T, 'welcome', 'ct-plain')).enrolled).toBe(true);
    expect((await enroll(T, 'winback', 'ct-plain')).enrolled).toBe(true);
    expect((await enroll(T, 'welcome', 'ct-plain')).enrolled).toBe(false); // still one-per-(journey, contact)
    // No group slot was created for an ungrouped enroll.
    expect(await activeInGroup(T, G, 'ct-plain')).toBeNull();
    expect((await listEnrollments(T)).filter((e) => e.contactId === 'ct-plain')).toHaveLength(2);
  });

  it('exclusivity is per-tenant and per-contact scoped (arbitration never crosses either)', async () => {
    await __clearEnrollments();
    await enroll(T, 'nurture', 'ct-scope', undefined, { exclusivityGroup: G, priority: 5 });
    // A different contact in the same tenant+group is independent.
    expect((await enroll(T, 'nurture', 'ct-scope-2', undefined, { exclusivityGroup: G, priority: 5 })).enrolled).toBe(true);
    // A different tenant, same group+contact, is independent.
    expect((await enroll('user:other', 'winback-vip', 'ct-scope', undefined, { exclusivityGroup: G, priority: 1 })).enrolled).toBe(true);
    expect((await activeInGroup(T, G, 'ct-scope'))?.journeyId).toBe('nurture');
    expect((await activeInGroup('user:other', G, 'ct-scope'))?.journeyId).toBe('winback-vip');
  });
});

describe('ADR 0222 — eligibility composite', () => {
  it('walks every gate: missing → no email → suppressed → eligible', async () => {
    expect(await checkEligibility(T, 'ct-missing')).toEqual({ eligible: false, reason: 'contact_not_found' });
    const noMail = await createContact({ tenantId: T, name: 'NoMail' });
    expect(await checkEligibility(T, noMail.contactId)).toEqual({ eligible: false, reason: 'no_email' });
    const ada = await createContact({ tenantId: T, name: 'Ada', email: 'ada-j@example.com' });
    const ok = await checkEligibility(T, ada.contactId);
    expect(ok).toMatchObject({ eligible: true, email: 'ada-j@example.com', name: 'Ada' });
    await addSuppression(T, 'ada-j@example.com', 'unsubscribed', 'test');
    expect(await checkEligibility(T, ada.contactId)).toEqual({ eligible: false, reason: 'suppressed' });
  });
});

describe('ADR 0222 — pack nodes over the surface', () => {
  const surface = buildCampaignJourneysSurface({ tenantId: T } as never);
  const ctx = (inputs: Record<string, unknown>, triggerData?: unknown) => ({
    features: { 'campaign-journeys': surface },
    inputs,
    runId: 'run-x',
    ...(triggerData !== undefined ? { triggerData } : {}),
  });

  it('enroll node: guards + resolves the contact from the trigger payload', async () => {
    await __clearEnrollments();
    // JRNY-1: enroll now runs an eligibility pre-check, so it needs a real,
    // eligible contact (consent + suppression + has-email).
    const ev = await createContact({ tenantId: T, name: 'Ev', email: 'ev-j@example.com' });
    const trigger = { eventName: 'host.crm.contact.created', payload: { contactId: ev.contactId } };
    const viaTrigger = await pack.enroll(ctx({ journeyId: 'welcome' }, trigger));
    expect(viaTrigger.status).toBe('success');
    const repeat = await pack.enroll(ctx({ journeyId: 'welcome' }, trigger));
    expect(repeat.status).toBe('failed');
    expect(repeat.error?.code).toBe('already_enrolled');
  });

  it('enroll node: an ineligible contact fails the eligibility pre-check and never enrolls (JRNY-1)', async () => {
    await __clearEnrollments();
    // A fabricated / no-email contact is ineligible → enroll fails BEFORE the
    // irreversible ledger claim, so a later retry (once eligible) can still run.
    const out = await pack.enroll(ctx({ journeyId: 'welcome', contactId: 'ct-ineligible' }));
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('not_eligible');
    // Nothing was written — a subsequent enroll of the same pair is not blocked.
    const bea = await createContact({ tenantId: T, name: 'BeaRetry', email: 'bea-retry@example.com' });
    const retry = await pack.enroll(ctx({ journeyId: 'welcome', contactId: bea.contactId }));
    expect(retry.status).toBe('success');
  });

  it('eligibility node: fails with the reason, outputs to/email when eligible', async () => {
    const bea = await createContact({ tenantId: T, name: 'Bea', email: 'bea-j@example.com' });
    const ok = await pack.eligibility(ctx({ contactId: bea.contactId }));
    expect(ok.status).toBe('success');
    expect(ok.outputs).toMatchObject({ eligible: true, email: 'bea-j@example.com', to: 'bea-j@example.com' });
    const bad = await pack.eligibility(ctx({ contactId: 'ct-missing' }));
    expect(bad.status).toBe('failed');
    expect(bad.error?.code).toBe('not_eligible');
  });
});

describe('ADR 0243 — journey-depth read verbs', () => {
  it('checkEngagement reports opened/clicked from the engagement rows (LIVE read)', async () => {
    const c = await createContact({ tenantId: T, name: 'Eng', email: 'eng243@example.com' });
    // Seed an open + a click for this contact via the public token path.
    const openTok = await mintToken({ tenantId: T, campaignId: 'cmp-243', contactId: c.contactId, kind: 'open' });
    const clickTok = await mintToken({ tenantId: T, campaignId: 'cmp-243', contactId: c.contactId, kind: 'click', url: 'https://x.example/y' });
    await recordOpen(openTok);
    await recordClick(clickTok);

    const r = await checkEngagement(T, c.contactId, 'cmp-243');
    expect(r).toMatchObject({ opened: true, clicked: true, openCount: 1, clickCount: 1 });

    // A contact with no engagement → all false.
    const none = await checkEngagement(T, 'ct-none', 'cmp-243');
    expect(none).toEqual({ opened: false, clicked: false, openCount: 0, clickCount: 0 });
  });

  it('checkFrequency is within-cap when the contact has no sends in the window', async () => {
    const r = await checkFrequency(T, 'ct-quiet', 30, 3);
    expect(r).toEqual({ sentCount: 0, withinCap: true });
    // A max of 0 is coerced to 1; 0 sends < 1 → within cap.
    expect((await checkFrequency(T, 'ct-quiet', 30, 0)).withinCap).toBe(true);
  });

  it('resolveSegment returns member ids, capped with a truncated flag', async () => {
    await createContact({ tenantId: T, name: 'M1', email: 'm1-243@example.com', stage: 'customer' });
    await createContact({ tenantId: T, name: 'M2', email: 'm2-243@example.com', stage: 'customer' });
    const seg = await createSegment({ tenantId: T, name: 'Cust243', filters: [{ field: 'stage', op: 'eq', value: 'customer' }], createdBy: 'test' });

    const all = await resolveSegment(T, seg.segmentId);
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.contactIds.length).toBe(all.total);
    expect(all.truncated).toBe(false);

    // A cap below the member count truncates + flags it (no silent drop).
    const capped = await resolveSegment(T, seg.segmentId, 1);
    expect(capped.contactIds.length).toBe(1);
    expect(capped.truncated).toBe(true);
    expect(capped.total).toBeGreaterThanOrEqual(2);
  });

  it('the pack nodes dispatch the verbs over the surface (engagement / frequency-gate / segment-members)', async () => {
    const surface = buildCampaignJourneysSurface({ tenantId: T } as never);
    const ctx = (inputs: Record<string, unknown>) => ({ features: { 'campaign-journeys': surface }, inputs });

    const c = await createContact({ tenantId: T, name: 'NodeEng', email: 'nodeeng243@example.com' });
    const eng = await pack.engagement(ctx({ contactId: c.contactId }));
    expect(eng.status).toBe('success');
    expect(eng.outputs).toMatchObject({ opened: false, clicked: false, contactId: c.contactId });

    const freq = await pack.frequencyGate(ctx({ contactId: c.contactId, windowDays: 7, maxSends: 2 }));
    expect(freq.status).toBe('success');
    expect(freq.outputs?.withinCap).toBe(true);

    const seg = await createSegment({ tenantId: T, name: 'NodeSeg', filters: [{ field: 'stage', op: 'eq', value: 'lead' }], createdBy: 'test' });
    const members = await pack.segmentMembers(ctx({ segmentId: seg.segmentId }));
    expect(members.status).toBe('success');
    expect(Array.isArray(members.outputs?.contactIds)).toBe(true);

    // Missing required inputs fail closed.
    expect((await pack.segmentMembers(ctx({}))).status).toBe('failed');
    expect((await pack.engagement(ctx({}))).status).toBe('failed');
  });
});
