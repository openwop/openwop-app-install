/**
 * UX_UPGRADE-webinars ROUND 2 — sync truth + the pending-push queue.
 *
 *  - WB-SP-1: a PARTIAL attendance walk must never feed the no-show
 *    computation — the people on the unfetched pages ATTENDED, and a false
 *    `no-show` activity is durable and fires a "you missed it" notification.
 *  - WB-SP-5: an ERROR sync must roll the cooldown claim back — the old code
 *    kept it, so the retry was told "Recently synced" (a false past-success).
 *  - WB-SP-8: attendees count DISTINCT people, not per-join-session rows.
 *  - WB-SP-2: the pending registrant-push queue round-trips per (event,email).
 *  - WB-SP-4: the pack sync node maps a surface error to a node FAILURE.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const listAttendance = vi.fn();
vi.mock('../src/features/webinars/host/webinarAdapter.js', () => ({
  makeWebinarAdapter: () => ({ listAttendance: (...a: unknown[]) => listAttendance(...a) }),
}));

import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { syncEvent, computeEventCounts } from '../src/features/webinars/webinarSyncService.js';
import { ingestWebinarEvent } from '../src/features/webinars/webinarProcessor.js';
import { enqueuePendingPush, listPendingPushes, deletePendingPush, pendingPushCounts } from '../src/features/webinars/pendingPush.js';
import { __resetCrmStore } from '../src/features/crm/contactsService.js';
import { __resetCrmEntities } from '../src/features/crm/crmEntitiesService.js';
import type { MarketingEvent } from '../src/features/webinars/entities/marketingEvent.js';
import { nodes as webinarNodes } from '../../../packs/feature.webinars.nodes/index.mjs';

const T = 't-sync';
const ORG = 'o1';
const EVENT: MarketingEvent = {
  eventId: `${T}:zoom:900`, tenantId: T, orgId: ORG, provider: 'zoom', providerEventId: '900',
  title: 'Launch call', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
};
const deps = { storage: null as never, tenantId: T, runId: 'test', orgId: ORG } as never;

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetCrmStore();
  await __resetCrmEntities();
  listAttendance.mockReset();
});

describe('R2 WB-SP-1/5/8 — sync truth', () => {
  it('a partial walk ingests attendees but NEVER computes no-shows', async () => {
    // Two registrants; page 1 shows only Alice attended; page 2 (where Bob
    // would appear) FAILS mid-walk.
    await ingestWebinarEvent(T, ORG, undefined, { provider: 'zoom', providerEventId: '900', phase: 'registered', participantEmail: 'alice@x.test' });
    await ingestWebinarEvent(T, ORG, undefined, { provider: 'zoom', providerEventId: '900', phase: 'registered', participantEmail: 'bob@x.test' });
    listAttendance
      .mockResolvedValueOnce({ ok: true, value: { rows: [{ email: 'alice@x.test' }], nextCursor: 'p2' } })
      .mockResolvedValueOnce({ ok: false, error: 'zoom_500' });

    const out = await syncEvent(deps, T, ORG, EVENT);
    expect(out.outcome).toBe('synced');
    if (out.outcome !== 'synced') return;
    expect(out.attendees).toBe(1); // the partial ingest is kept
    expect(out.noShows).toBe(0); // the accusation is DEFERRED
    // Bob carries no durable false no-show.
    const counts = await computeEventCounts(T, ORG, '900');
    expect(counts.noShowCount).toBe(0);
  });

  it('an ERROR sync releases the cooldown — the immediate retry RUNS instead of reporting "recently synced"', async () => {
    listAttendance.mockResolvedValueOnce({ ok: false, error: 'no_connection' });
    const first = await syncEvent(deps, T, ORG, EVENT);
    expect(first.outcome).toBe('error');
    // The old code kept the claim: this retry returned 'cooldown'.
    listAttendance.mockResolvedValueOnce({ ok: true, value: { rows: [{ email: 'alice@x.test' }] } });
    const retry = await syncEvent(deps, T, ORG, EVENT);
    expect(retry.outcome).toBe('synced');
  });

  it('attendees count DISTINCT people — a drop-and-rejoin is one attendee, not two', async () => {
    listAttendance.mockResolvedValueOnce({ ok: true, value: { rows: [
      { email: 'alice@x.test', joinTime: '2026-08-01T10:00:00Z' },
      { email: 'ALICE@x.test', joinTime: '2026-08-01T10:20:00Z' }, // rejoin, case-shifted
    ] } });
    const out = await syncEvent(deps, T, ORG, EVENT);
    expect(out.outcome).toBe('synced');
    if (out.outcome === 'synced') expect(out.attendees).toBe(1);
  });
});

describe('R2 WB-SP-2 — the pending-push queue', () => {
  it('round-trips keyed by (event,email) — a re-submission never duplicates', async () => {
    const row = { tenantId: T, orgId: ORG, eventId: EVENT.eventId, providerEventId: '900', email: 'carol@x.test', name: 'Carol' };
    await enqueuePendingPush(row);
    await enqueuePendingPush(row); // dedup by key
    expect(await listPendingPushes(T, ORG, EVENT.eventId)).toHaveLength(1);
    expect((await pendingPushCounts(T, ORG)).get(EVENT.eventId)).toBe(1);
    await deletePendingPush(T, EVENT.eventId, 'CAROL@x.test'); // case-insensitive key
    expect(await listPendingPushes(T, ORG, EVENT.eventId)).toHaveLength(0);
  });
});

describe('R2 WB-SP-4 — the pack sync node maps errors', () => {
  it('a surface error is a node FAILURE (the fail branch finally fires)', async () => {
    const ctx = {
      features: { webinars: { registerRegistrant: async () => ({}), syncEvent: async () => ({ success: false, outcome: 'error', reason: 'no_connection' }) } },
      inputs: { orgId: ORG, eventId: EVENT.eventId },
    };
    const out = await webinarNodes['feature.webinars.nodes.sync'](ctx);
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('sync_failed');
  });

  it('polarity: a successful sync stays a node success', async () => {
    const ctx = {
      features: { webinars: { registerRegistrant: async () => ({}), syncEvent: async () => ({ success: true, outcome: 'synced', attendees: 3, noShows: 1 }) } },
      inputs: { orgId: ORG, eventId: EVENT.eventId },
    };
    const out = await webinarNodes['feature.webinars.nodes.sync'](ctx);
    expect(out.status).toBe('success');
  });
});

describe('R2 review fold-in — the pending-push lifecycle (a raw-email store must not outlive the person)', () => {
  it('the subject eraser deletes queued rows for the erased email', async () => {
    const { eraseSubjectPendingPushes } = await import('../src/features/webinars/pendingPush.js');
    await enqueuePendingPush({ tenantId: T, orgId: ORG, eventId: EVENT.eventId, providerEventId: '900', email: 'gone@x.test', name: 'Gone' });
    await enqueuePendingPush({ tenantId: T, orgId: ORG, eventId: EVENT.eventId, providerEventId: '900', email: 'stays@x.test' });
    await eraseSubjectPendingPushes(T, 'gone@x.test');
    const left = await listPendingPushes(T, ORG, EVENT.eventId);
    expect(left.map((r) => r.email)).toEqual(['stays@x.test']);
  });

  it('a partial walk reports partial:true so the operator is not told full success', async () => {
    await ingestWebinarEvent(T, ORG, undefined, { provider: 'zoom', providerEventId: '900', phase: 'registered', participantEmail: 'alice@x.test' });
    listAttendance
      .mockResolvedValueOnce({ ok: true, value: { rows: [{ email: 'alice@x.test' }], nextCursor: 'p2' } })
      .mockResolvedValueOnce({ ok: false, error: 'zoom_500' });
    const out = await syncEvent(deps, T, ORG, EVENT);
    expect(out.outcome).toBe('synced');
    if (out.outcome === 'synced') expect(out.partial).toBe(true);
  });
});
