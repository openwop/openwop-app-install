/**
 * ADR 0404 §a — Zoom webinar connector. Covers the normalized-event mapping, the
 * Zoom (Slack-shaped) signature verification reused by the shared inbound seam,
 * the adapterOnly governed-write posture, and the idempotent CRM ingest +
 * compute-on-read counts (both ingestion lanes converge on the same
 * deterministic-id activity).
 *
 * What is and is not tested (8f W4, round-2 ruling 9):
 *  - Idempotency and the no-show suppression are asserted on the activity ROWS,
 *    not only on the derived counts (counts dedupe by contact id, so the probes
 *    wb-dedupe and wb-noshow-suppress were vacuous against counts alone). The
 *    no-show rule is a DOUBLE guard: ingest refuses a late no-show AND
 *    `countsFrom` subtracts attendees; each half now has its own witness.
 *  - The feature's REAL lifecycle consumers (the two inline lambdas in
 *    `features/webinars/feature.ts` registerRoutes) are driven in the last
 *    describe, which boots the app so `registerRoutes` runs, then fires the real
 *    seams (`fireFormDeleted`, `fireCrmRecordDeleted`). The `form-lifecycle` and
 *    `contact-delete` describes above it test the SEAM and the HELPER, and say so
 *    in their titles. The contact consumer's own effect is BLOCKED-ON-PRODUCT
 *    (WEBINAR-CONTACT-PRUNE-1, pinned as it.fails below): a sibling CRM consumer
 *    runs first and leaves it nothing to delete.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createHmac } from 'node:crypto';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { verifySlackSignature, inboundSupported, inboundObserverOnly } from '../src/features/connections/inboundWebhooks.js';
import { getProvider } from '../src/features/connections/providerRegistry.js';
import { normalizeZoomEvent, ingestWebinarEvent } from '../src/features/webinars/webinarProcessor.js';
import { computeEventCounts, computeEventCountsBatch } from '../src/features/webinars/webinarSyncService.js';
import { __clearWebinars, upsertMarketingEvent, bindFormToEvent, getFormBinding, unbindForm, getMarketingEvent } from '../src/features/webinars/entities/marketingEvent.js';
import { onFormDeleted, fireFormDeleted, __resetFormLifecycleHooks } from '../src/host/formLifecycle.js';
import { __resetCrmStore, findContactByEmail } from '../src/features/crm/contactsService.js';
import { deleteActivitiesForContactByPrefix } from '../src/features/crm/entities/activities.js';
import { __resetCrmEntities, listActivitiesByIdPrefix } from '../src/features/crm/crmEntitiesService.js';
import { fireCrmRecordDeleted } from '../src/host/crmRecordLifecycle.js';

/** The activity ROWS behind one event, by phase suffix — counts are computed from
 *  SETS of contact ids, so they cannot show a duplicated or a suppressed row. */
const phasesOf = async (providerEventId: string): Promise<string[]> =>
  (await listActivitiesByIdPrefix('t1', 'o1', `act:webinar:${providerEventId}:`)).map((a) => a.activityId.split(':').pop()!).sort();

describe('webinars — provider + inbound wiring', () => {
  it('registers zoom-webinar as an adapterOnly governed-write provider', () => {
    const m = getProvider('zoom-webinar');
    expect(m).toBeTruthy();
    expect(m!.adapterOnly).toBe(true);
    expect(m!.consumerNodes).toEqual([]); // never reachable by generic http.fetch
    expect(m!.apiHosts).toContain('zoom.us');
  });

  it('marks zoom-webinar inbound-supported + observer-only', () => {
    expect(inboundSupported('zoom-webinar')).toBe(true);
    expect(inboundObserverOnly('zoom-webinar')).toBe(true);
    expect(inboundObserverOnly('slack')).toBe(false);
  });
});

describe('webinars — Zoom webhook signature (Slack-shaped)', () => {
  const now = 1_800_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const secret = 'zoom-secret-token';
  const body = JSON.stringify({ event: 'webinar.participant_joined' });
  const sig = () => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;

  it('accepts a correct signature', () => {
    expect(verifySlackSignature({ signingSecret: secret, timestampHeader: ts, signatureHeader: sig(), rawBody: body, now }).ok).toBe(true);
  });
  it('rejects a tampered body', () => {
    expect(verifySlackSignature({ signingSecret: secret, timestampHeader: ts, signatureHeader: sig(), rawBody: body + 'x', now })).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('rejects a stale timestamp', () => {
    const oldTs = String(Math.floor((now - 10 * 60_000) / 1000));
    const oldSig = `v0=${createHmac('sha256', secret).update(`v0:${oldTs}:${body}`).digest('hex')}`;
    expect(verifySlackSignature({ signingSecret: secret, timestampHeader: oldTs, signatureHeader: oldSig, rawBody: body, now })).toEqual({ ok: false, reason: 'stale' });
  });
  it('rejects missing headers', () => {
    expect(verifySlackSignature({ signingSecret: secret, timestampHeader: undefined, signatureHeader: undefined, rawBody: body, now })).toEqual({ ok: false, reason: 'missing_headers' });
  });
});

describe('webinars — normalizeZoomEvent', () => {
  it('maps registration_created → registered', () => {
    const ev = normalizeZoomEvent({ event: 'webinar.registration_created', payload: { object: { id: '99', topic: 'Launch', registrant: { email: 'a@x.test', first_name: 'Ann', last_name: 'Smith' } } } });
    expect(ev).toMatchObject({ provider: 'zoom', providerEventId: '99', phase: 'registered', participantEmail: 'a@x.test', participantName: 'Ann Smith', title: 'Launch' });
  });
  it('maps participant_joined → attended', () => {
    const ev = normalizeZoomEvent({ event: 'webinar.participant_joined', payload: { object: { id: '99', participant: { email: 'a@x.test', user_name: 'Ann', join_time: '2026-07-20T10:00:00Z' } } } });
    expect(ev).toMatchObject({ phase: 'attended', participantEmail: 'a@x.test', occurredAt: '2026-07-20T10:00:00Z' });
  });
  it('returns null for an untracked event', () => {
    expect(normalizeZoomEvent({ event: 'webinar.updated', payload: { object: { id: '99' } } })).toBeNull();
    expect(normalizeZoomEvent({ event: 'x', payload: {} })).toBeNull();
  });
});

describe('webinars — idempotent CRM ingest + compute-on-read counts', () => {
  beforeEach(async () => {
    initHostExtPersistence(await openStorage('memory://'));
    await __resetCrmStore();
    await __resetCrmEntities();
    await __clearWebinars();
  });

  it('a re-ingested event is a no-op (deterministic activity id) and counts derive from the stream', async () => {
    const base = { provider: 'zoom', providerEventId: '77', participantEmail: 'a@x.test', participantName: 'Ann', title: 'Launch' } as const;
    // Two lanes converge on the same registered event → one activity. The second
    // carries a different occurredAt: a re-ingest that rewrote the row would move
    // its createdAt. The deterministic id alone makes a DUPLICATE row impossible
    // (one key), so "no-op" is witnessed by the row staying untouched.
    // DOUBLE GUARD (named): ingest point-reads the id (webinarProcessor.ts:136)
    // AND createActivity returns an existing id unchanged (activities.ts:152);
    // either alone keeps the row. Probe wb-dedupe-r3 removes both.
    await ingestWebinarEvent('t1', 'o1', 'conn:1', { ...base, phase: 'registered' });
    const firstAt = (await listActivitiesByIdPrefix('t1', 'o1', 'act:webinar:77:'))[0]!.createdAt;
    await ingestWebinarEvent('t1', 'o1', 'conn:1', { ...base, phase: 'registered', occurredAt: '2020-01-01T00:00:00.000Z' });
    expect((await listActivitiesByIdPrefix('t1', 'o1', 'act:webinar:77:')).map((a) => a.createdAt)).toEqual([firstAt]);
    // A second registrant + an attendee.
    await ingestWebinarEvent('t1', 'o1', 'conn:1', { ...base, phase: 'registered', participantEmail: 'b@x.test', participantName: 'Bob' });
    await ingestWebinarEvent('t1', 'o1', 'conn:1', { ...base, phase: 'attended' });

    const counts = await computeEventCounts('t1', 'o1', '77');
    expect(counts).toEqual({ registrantCount: 2, attendeeCount: 1, noShowCount: 0 });
    // The ROWS: a-registered, b-registered, a-attended — the re-ingest wrote none.
    expect(await phasesOf('77')).toEqual(['attended', 'registered', 'registered']);
  });

  it('attendance wins over a stale no-show (no double-count, no false no-show)', async () => {
    const base = { provider: 'zoom', providerEventId: '55', participantEmail: 'a@x.test', title: 'Launch' } as const;
    // A report-lag no-show is written first, then the real attendance arrives.
    await ingestWebinarEvent('t1', 'o1', undefined, { ...base, phase: 'registered' });
    await ingestWebinarEvent('t1', 'o1', undefined, { ...base, phase: 'no-show' });
    await ingestWebinarEvent('t1', 'o1', undefined, { ...base, phase: 'attended' });
    // A LATER no-show ingest for the same contact is suppressed (attended exists).
    await ingestWebinarEvent('t1', 'o1', undefined, { ...base, phase: 'no-show' });
    const counts = await computeEventCounts('t1', 'o1', '55');
    expect(counts.attendeeCount).toBe(1);
    expect(counts.noShowCount).toBe(0); // stale no-show subtracted; the contact attended
    // The early no-show row is kept (it shares its id with the late one, so the
    // late ingest can only collide with it — that half is countsFrom's).
    expect(await phasesOf('55')).toEqual(['attended', 'no-show', 'registered']);

    // INGEST-side half on its own: attended FIRST, then a late no-show for a
    // contact that never had one. Only the ingest guard keeps that row out
    // (8f W4 r2: wb-noshow-suppress-r2 was vacuous against the event-55 fixture,
    // where the late no-show's id equals the early one's).
    const late = { provider: 'zoom', providerEventId: '56', participantEmail: 'a@x.test', title: 'Launch' } as const;
    await ingestWebinarEvent('t1', 'o1', undefined, { ...late, phase: 'registered' });
    await ingestWebinarEvent('t1', 'o1', undefined, { ...late, phase: 'attended' });
    await ingestWebinarEvent('t1', 'o1', undefined, { ...late, phase: 'no-show' });
    expect(await phasesOf('56')).toEqual(['attended', 'registered']);
  });

  it('isolates counts by tenant', async () => {
    await ingestWebinarEvent('t1', 'o1', undefined, { provider: 'zoom', providerEventId: '88', phase: 'registered', participantEmail: 'a@x.test' });
    await ingestWebinarEvent('t2', 'o1', undefined, { provider: 'zoom', providerEventId: '88', phase: 'registered', participantEmail: 'c@x.test' });
    expect((await computeEventCounts('t1', 'o1', '88')).registrantCount).toBe(1);
    expect((await computeEventCounts('t2', 'o1', '88')).registrantCount).toBe(1);
  });

  it('computeEventCountsBatch derives every event in ONE scan, matching per-event (grade-code WEB-1)', async () => {
    await ingestWebinarEvent('t1', 'o1', undefined, { provider: 'zoom', providerEventId: '77', phase: 'registered', participantEmail: 'a@x.test' });
    await ingestWebinarEvent('t1', 'o1', undefined, { provider: 'zoom', providerEventId: '77', phase: 'attended', participantEmail: 'a@x.test' });
    await ingestWebinarEvent('t1', 'o1', undefined, { provider: 'zoom', providerEventId: '99', phase: 'registered', participantEmail: 'b@x.test' });
    const byPid = await computeEventCountsBatch('t1', 'o1');
    expect(byPid.get('77')).toEqual(await computeEventCounts('t1', 'o1', '77'));
    expect(byPid.get('99')).toEqual(await computeEventCounts('t1', 'o1', '99'));
    expect(byPid.get('77')).toEqual({ registrantCount: 1, attendeeCount: 1, noShowCount: 0 });
    expect(byPid.get('nope')).toBeUndefined(); // caller defaults to zeros
  });
});

describe('webinars — form-lifecycle unbind (grade-data WEB-2)', () => {
  beforeEach(async () => {
    initHostExtPersistence(await openStorage('memory://'));
    await __clearWebinars();
    __resetFormLifecycleHooks();
  });

  it('unbindForm removes the binding AND clears the event\'s dangling formId', async () => {
    await upsertMarketingEvent({ tenantId: 't1', orgId: 'o1', provider: 'zoom', providerEventId: '77', formId: 'form:1' });
    await bindFormToEvent('t1', 'o1', 'form:1', 't1:zoom:77');
    expect(await getFormBinding('t1', 'form:1')).toBeTruthy();

    expect(await unbindForm('t1', 'form:1')).toBe(true);
    expect(await getFormBinding('t1', 'form:1')).toBeNull(); // binding gone
    expect((await getMarketingEvent('t1', 'o1', 't1:zoom:77'))?.formId).toBeUndefined(); // no dangling pointer
  });

  it('the form-deleted SEAM calls a registered consumer with the deleted form id (the webinars consumer itself: last describe)', async () => {
    let pruned = '';
    onFormDeleted('test-unbind', async ({ formId }) => { pruned = formId; });
    const ran = await fireFormDeleted({ tenantId: 't1', orgId: 'o1', formId: 'form:9' });
    expect(ran).toBe(1);
    expect(pruned).toBe('form:9');
  });

  it('R2 WB-SP-3: a rebind SUPERSEDES — the old form stops registering and the old event loses its chip', async () => {
    // Event bound to form A; rebinding the EVENT to form B must kill A's row —
    // the old code left it live, so the "unlinked" form kept registering people
    // into the webinar forever.
    await upsertMarketingEvent({ tenantId: 't1', orgId: 'o1', provider: 'zoom', providerEventId: '88' });
    await bindFormToEvent('t1', 'o1', 'form:A', 't1:zoom:88');
    await bindFormToEvent('t1', 'o1', 'form:B', 't1:zoom:88');
    expect(await getFormBinding('t1', 'form:A')).toBeNull(); // superseded
    expect((await getFormBinding('t1', 'form:B'))?.eventId).toBe('t1:zoom:88');

    // Form C bound to event X, then re-bound to event Y: X's formId pointer
    // must not dangle (the chip rendered a dead link).
    await upsertMarketingEvent({ tenantId: 't1', orgId: 'o1', provider: 'zoom', providerEventId: 'X', formId: 'form:C' });
    await upsertMarketingEvent({ tenantId: 't1', orgId: 'o1', provider: 'zoom', providerEventId: 'Y' });
    await bindFormToEvent('t1', 'o1', 'form:C', 't1:zoom:X');
    await bindFormToEvent('t1', 'o1', 'form:C', 't1:zoom:Y');
    expect((await getMarketingEvent('t1', 'o1', 't1:zoom:X'))?.formId).toBeUndefined();
    expect((await getFormBinding('t1', 'form:C'))?.eventId).toBe('t1:zoom:Y');
  });
});

describe('webinars — contact-delete activity unlink (grade-data WEB-1)', () => {
  beforeEach(async () => {
    initHostExtPersistence(await openStorage('memory://'));
    await __resetCrmStore();
    await __resetCrmEntities();
    await __clearWebinars();
  });

  it('the prune HELPER removes a deleted contact\'s webinar activities, so counts stop inflating (the real consumer: last describe)', async () => {
    const base = { provider: 'zoom', providerEventId: '77', title: 'Launch' } as const;
    await ingestWebinarEvent('t1', 'o1', undefined, { ...base, phase: 'registered', participantEmail: 'a@x.test' });
    await ingestWebinarEvent('t1', 'o1', undefined, { ...base, phase: 'registered', participantEmail: 'b@x.test' });
    expect((await computeEventCounts('t1', 'o1', '77')).registrantCount).toBe(2);

    // Contact A is deleted → its webinar activities are pruned (the seam handler).
    const a = await findContactByEmail('t1', 'a@x.test');
    const removed = await deleteActivitiesForContactByPrefix('t1', a!.contactId, 'act:webinar:');
    expect(removed).toBe(1);
    expect((await computeEventCounts('t1', 'o1', '77')).registrantCount).toBe(1); // no dead-contact inflation
  });
});

describe('webinars — the feature\'s REAL lifecycle consumers (booted app: registerRoutes runs)', () => {
  let server: http.Server;
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
  beforeEach(async () => {
    initHostExtPersistence(await openStorage('memory://'));
    await __resetCrmStore();
    await __resetCrmEntities();
    await __clearWebinars();
  });

  it('a deleted bound form is unbound by the webinars consumer (binding gone, no dangling formId)', async () => {
    await upsertMarketingEvent({ tenantId: 't1', orgId: 'o1', provider: 'zoom', providerEventId: 'R1', formId: 'form:R' });
    await bindFormToEvent('t1', 'o1', 'form:R', 't1:zoom:R1');
    expect(await getFormBinding('t1', 'form:R')).toBeTruthy(); // non-vacuous

    // The consumer was registered by this describe's createApp (beforeAll runs at
    // the describe's start, after any earlier describe's hook reset).
    const ran = await fireFormDeleted({ tenantId: 't1', orgId: 'o1', formId: 'form:R' });
    expect(ran, 'the webinars-form-unbind consumer must be registered').toBeGreaterThanOrEqual(1);
    expect(await getFormBinding('t1', 'form:R')).toBeNull();
    expect((await getMarketingEvent('t1', 'o1', 't1:zoom:R1'))?.formId).toBeUndefined();
  });

  it('a deleted contact stops counting through the real fan-out, and no webinar row still names it', async () => {
    const base = { provider: 'zoom', providerEventId: 'C1', title: 'Launch' } as const;
    await ingestWebinarEvent('t1', 'o1', undefined, { ...base, phase: 'registered', participantEmail: 'a@x.test' });
    await ingestWebinarEvent('t1', 'o1', undefined, { ...base, phase: 'registered', participantEmail: 'b@x.test' });
    expect((await computeEventCounts('t1', 'o1', 'C1')).registrantCount).toBe(2);

    const a = await findContactByEmail('t1', 'a@x.test');
    await fireCrmRecordDeleted({ tenantId: 't1', entity: 'contact', recordId: a!.contactId });
    expect((await computeEventCounts('t1', 'o1', 'C1')).registrantCount).toBe(1);
    const rows = await listActivitiesByIdPrefix('t1', 'o1', 'act:webinar:C1:');
    expect(rows.filter((r) => r.contactId === a!.contactId)).toEqual([]);
  });

  /**
   * WEBINAR-CONTACT-PRUNE-1 (BLOCKED-ON-PRODUCT). `features/webinars/feature.ts:44`
   * registers `webinars-activity-unlink` to DELETE a deleted contact's webinar
   * activities, but `features/crm/entities/activities.ts:63`
   * (`activities-crm-unlink`, registered first, at import) runs before it and
   * strips `contactId` from every activity, so the webinars consumer's
   * `a.contactId === contactId` filter (`activities.ts:102`) matches nothing and
   * the rows survive as contact-less husks. Counts are right (a row with no
   * contact is not counted); the prune the feature promises never happens.
   * Fix-probe: 8fw4g2-wb-contact-prune-fix-r2.
   */
  it.fails('the webinars consumer deletes the contact\'s webinar rows (WEBINAR-CONTACT-PRUNE-1)', async () => {
    const base = { provider: 'zoom', providerEventId: 'C2', title: 'Launch' } as const;
    await ingestWebinarEvent('t1', 'o1', undefined, { ...base, phase: 'registered', participantEmail: 'a@x.test' });
    await ingestWebinarEvent('t1', 'o1', undefined, { ...base, phase: 'registered', participantEmail: 'b@x.test' });
    const a = await findContactByEmail('t1', 'a@x.test');
    await fireCrmRecordDeleted({ tenantId: 't1', entity: 'contact', recordId: a!.contactId });
    expect(await phasesOf('C2')).toEqual(['registered']);
  });
});
