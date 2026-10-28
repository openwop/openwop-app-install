/** ADR 0954 P0 recovery — physical CAS barriers and reopened SQLite storage,
 * rather than index-shape assertions, witness admission/deletion ownership. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';
import { DurableCollection, initHostExtPersistence, __resetHostExtPersistence, purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { collectEvent, listCollectedEvents, type CollectedEvent } from '../src/features/cdp/collectService.js';
import { registerEventSchema } from '../src/features/cdp/eventSchemaService.js';
import { eraseCdpCollectedEvents, registerCdpErasure } from '../src/features/cdp/erasure.js';
import { collectedEvents, deleteCollectedEvent, eventsForVisitors, indexCollectedEvent, persistCollectedEvent, reconcileCollectedEventReceipts, VISITOR_EVENT_CAP } from '../src/features/cdp/visitorEventIndex.js';

interface Forward { key: string; tenantId: string; eventId: string; visitor?: string; visitorHash?: string; eventType?: string; at?: string; deleted?: true }
interface Receipt { reservationId?: string; eventId: string; tenantId: string; key?: string; forwardKey?: string; state?: string; subjectHashes?: string[]; at?: string; schemaVersion?: number; piiFields?: string[] }
const forwards = new DurableCollection<Forward>('cdp:visitor-event', (r) => r.key, undefined, (r) => r.tenantId);
const receipts = new DurableCollection<Receipt>('cdp:visitor-event-of', (r) => r.reservationId ?? r.eventId, undefined, (r) => r.tenantId);
const markers = new DurableCollection<{ tenantId: string; at: string; format?: string }>('cdp:visitor-index-built', (r) => r.tenantId);
const tenantId = 'cdp-owned-events';
const row = (eventId: string, visitor: string, tenant = tenantId): CollectedEvent => ({ eventId, tenantId: tenant, eventType: 'funnel.step_viewed', payload: { visitor }, piiFields: [], at: '2026-10-20T12:00:00Z' });
const primaryKey = (id: string): string => `hostext:cdp:collected-event:${id}`;
const receiptKey = (id: string): string => `hostext:cdp:visitor-event-of:${tenantId}::${id}`;

describe('CDP canonical event ownership', () => {
  let storage: Storage; let directory: string; let database: string;
  beforeAll(registerCdpErasure);
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'owp-cdp-owner-'));
    database = join(directory, 'store.sqlite');
    storage = openSqliteStorage(database); initHostExtPersistence(storage);
  });
  afterEach(async () => { vi.restoreAllMocks(); await storage.close(); __resetHostExtPersistence(); rmSync(directory, { recursive: true }); });
  async function reopen(): Promise<void> {
    vi.restoreAllMocks(); await storage.close(); storage = openSqliteStorage(database); initHostExtPersistence(storage);
  }

  it.each(['primary', 'forward', 'receipt'])('erasure wins before the physical %s admission CAS', async (phase) => {
    const event = row('paused-event', 'private-visitor');
    const cas = storage.kvCompareAndSwap.bind(storage);
    let arrived!: () => void; let release!: () => void; let held = false;
    const entered = new Promise<void>((resolve) => { arrived = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const value = JSON.parse(next);
      const target = phase === 'primary' ? key === primaryKey(event.eventId) && value.payload
        : phase === 'forward' ? key.startsWith('hostext:cdp:visitor-event:') && !value.deleted
          : key === receiptKey(event.eventId) && value.state === 'live';
      if (!held && target) { held = true; arrived(); await barrier; }
      return cas(key, expected, next);
    });
    const sending = persistCollectedEvent(event).catch((error: unknown) => error);
    try {
      await entered;
      await eraseCdpCollectedEvents(tenantId, 'private-visitor');
    } finally { release(); }
    expect(await sending).toMatchObject({ httpStatus: 409 });
    expect(await collectedEvents.get(event.eventId)).toEqual({ tenantId, eventId: event.eventId, deleted: true });
    expect(await listCollectedEvents(tenantId)).toEqual([]);
    expect(await eventsForVisitors(tenantId, ['private-visitor'])).toEqual({ events: [], truncated: false });
  });

  it('a conflicting pending dedupe candidate cannot overwrite the canonical winner or index another visitor', async () => {
    const cas = storage.kvCompareAndSwap.bind(storage);
    let arrived!: () => void; let release!: () => void; let held = false;
    const entered = new Promise<void>((resolve) => { arrived = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!held && key.startsWith('hostext:cdp:collected-event:') && JSON.parse(next).payload) { held = true; arrived(); await barrier; }
      return cas(key, expected, next);
    });
    const first = collectEvent(tenantId, 'funnel.step_viewed', { visitor: 'visitor-a' }, 'same-key');
    try {
      await entered;
      await expect(collectEvent(tenantId, 'funnel.step_viewed', { visitor: 'visitor-b' }, 'same-key')).rejects.toMatchObject({ httpStatus: 409 });
    } finally { release(); }
    const accepted = await first;
    expect(await collectEvent(tenantId, 'funnel.step_viewed', { visitor: 'visitor-b' }, 'same-key')).toEqual(accepted);
    const indexed = await eventsForVisitors(tenantId, ['visitor-a', 'visitor-b']);
    expect(indexed.events.map((e) => [e.eventId, e.visitor])).toEqual([[accepted.eventId, 'visitor-a']]);
    expect(await listCollectedEvents(tenantId)).toHaveLength(1);
  });

  it('replay repairs a primary-only commit using its stored schema receipt, before newer validation', async () => {
    await registerEventSchema(tenantId, 'owned-event', { type: 'object', properties: { visitor: { type: 'string' } }, required: ['visitor'] });
    const cas = storage.kvCompareAndSwap.bind(storage); let failed = false;
    const fault = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!failed && key.startsWith('hostext:cdp:visitor-event:')) { failed = true; throw new Error('forward unavailable'); }
      return cas(key, expected, next);
    });
    await expect(collectEvent(tenantId, 'owned-event', { visitor: 'visitor-a' }, 'retry-key')).rejects.toThrow('forward unavailable');
    fault.mockRestore();
    const [stored] = await listCollectedEvents(tenantId);
    expect(stored).toMatchObject({ schemaVersion: 1, payload: { visitor: 'visitor-a' } });
    await registerEventSchema(tenantId, 'owned-event', { type: 'object', properties: { newRequired: { type: 'string' } }, required: ['newRequired'] });
    expect(await collectEvent(tenantId, 'owned-event', { visitor: 'not-the-winner' }, 'retry-key')).toMatchObject({ eventId: stored!.eventId, hasSchema: true, schemaVersion: 1 });
    expect((await eventsForVisitors(tenantId, ['visitor-a', 'not-the-winner'])).events.map((e) => e.visitor)).toEqual(['visitor-a']);
  });

  it('restart repairs a pending index even when backfill was already marked complete', async () => {
    await eventsForVisitors(tenantId, []);
    const cas = storage.kvCompareAndSwap.bind(storage);
    const fault = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key.startsWith('hostext:cdp:visitor-event:')) throw new Error('forward unavailable');
      return cas(key, expected, next);
    });
    await expect(persistCollectedEvent(row('reopened', 'visitor-a'))).rejects.toThrow('forward unavailable');
    fault.mockRestore(); await reopen();
    await reconcileCollectedEventReceipts();
    expect((await eventsForVisitors(tenantId, ['visitor-a'])).events.map((e) => e.eventId)).toEqual(['reopened']);
    expect(JSON.stringify(await receipts.listByPrefix(`${tenantId}::`))).not.toContain('visitor-a');
    expect(JSON.stringify(await forwards.listByPrefix(`${tenantId}::`))).not.toContain('visitor-a');
  });

  it('reopened pending admission keeps its validation receipt when the schema tightens', async () => {
    await registerEventSchema(tenantId, 'pending-event', { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] });
    const cas = storage.kvCompareAndSwap.bind(storage);
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key.startsWith('hostext:cdp:collected-event:') && JSON.parse(next).payload) throw new Error('primary unavailable');
      return cas(key, expected, next);
    });
    await expect(collectEvent(tenantId, 'pending-event', { email: 'person@example.test' }, 'pending-key')).rejects.toThrow('primary unavailable');
    const [pending] = await receipts.listByPrefix(`${tenantId}::`);
    expect(pending).toMatchObject({ state: 'pending', schemaVersion: 1, piiFields: ['email'] });
    expect(await listCollectedEvents(tenantId)).toEqual([]);
    await reopen(); await reconcileCollectedEventReceipts();
    await registerEventSchema(tenantId, 'pending-event', { type: 'object', properties: { newRequired: { type: 'string' } }, required: ['newRequired'] });
    await expect(collectEvent(tenantId, 'pending-event', { email: 'other@example.test' }, 'pending-key')).rejects.toMatchObject({ httpStatus: 409 });
    expect(await collectEvent(tenantId, 'pending-event', { email: 'person@example.test' }, 'pending-key')).toMatchObject({ eventId: pending!.eventId, hasSchema: true, schemaVersion: 1, piiFields: ['email'] });
    const events = await listCollectedEvents(tenantId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventId: pending!.eventId, at: pending!.at, schemaVersion: 1, piiFields: ['email'], payload: { email: 'person@example.test' } });
  });

  it.each(['primary', 'forward', 'legacy', 'close'])('restart completes deletion after a %s cleanup failure', async (phase) => {
    const event = row('cleanup-retry', 'legacy-private-visitor');
    await persistCollectedEvent(event);
    const legacyKey = `${tenantId}::legacy-private-visitor::${event.eventId}`;
    await forwards.put({ key: legacyKey, tenantId, eventId: event.eventId, visitor: 'legacy-private-visitor', eventType: event.eventType, at: event.at });
    await receipts.put({ tenantId, eventId: event.eventId, key: legacyKey });
    const cas = storage.kvCompareAndSwap.bind(storage); const remove = storage.kvDelete.bind(storage);
    let failed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const value = JSON.parse(next);
      if (!failed && (phase === 'primary' && key === primaryKey(event.eventId) && value.deleted
        || phase === 'forward' && key.startsWith('hostext:cdp:visitor-event:') && value.deleted
        || phase === 'close' && key === receiptKey(event.eventId) && value.state === 'deleted')) { failed = true; throw new Error('cleanup unavailable'); }
      return cas(key, expected, next);
    });
    vi.spyOn(storage, 'kvDelete').mockImplementation(async (key) => {
      if (!failed && phase === 'legacy' && key === `hostext:cdp:visitor-event:${legacyKey}`) { failed = true; throw new Error('cleanup unavailable'); }
      return remove(key);
    });
    await expect(eraseCdpCollectedEvents(tenantId, 'legacy-private-visitor')).rejects.toThrow('cleanup unavailable');
    expect(failed).toBe(true);
    await reopen(); await reconcileCollectedEventReceipts();
    await eraseCdpCollectedEvents(tenantId, 'legacy-private-visitor');
    expect(await collectedEvents.get(event.eventId)).toEqual({ tenantId, eventId: event.eventId, deleted: true });
    expect(await forwards.get(legacyKey)).toBeNull();
    expect(await receipts.get(`${tenantId}::${event.eventId}`)).toEqual({ reservationId: `${tenantId}::${event.eventId}`, tenantId, eventId: event.eventId, state: 'deleted' });
    expect(JSON.stringify(await receipts.list())).not.toContain('legacy-private-visitor');
    expect(await eventsForVisitors(tenantId, ['legacy-private-visitor'])).toEqual({ events: [], truncated: false });
  });

  it('an old backfill marker rebuilds canonical primaries into the hashed format', async () => {
    const event = row('legacy-upgrade', 'visitor-a');
    await collectedEvents.put(event);
    const legacyKey = `${tenantId}::visitor-a::${event.eventId}`;
    await forwards.put({ key: legacyKey, tenantId, eventId: event.eventId, visitor: 'visitor-a', eventType: event.eventType, at: event.at });
    await receipts.put({ tenantId, eventId: event.eventId, key: legacyKey });
    await markers.put({ tenantId, at: event.at });
    expect((await eventsForVisitors(tenantId, ['visitor-a'])).events.map((e) => e.eventId)).toEqual([event.eventId]);
    expect(await markers.get(tenantId)).toMatchObject({ format: 'receipt-hash-v1' });
  });

  it('legacy orphan cleanup preserves another canonical visitor, with or without a reverse pointer', async () => {
    const event = row('old-dedupe-race', 'visitor-b');
    await collectedEvents.put(event);
    const a = `${tenantId}::visitor-a::${event.eventId}`;
    const b = `${tenantId}::visitor-b::${event.eventId}`;
    await forwards.put({ key: a, tenantId, eventId: event.eventId, visitor: 'visitor-a', eventType: event.eventType, at: event.at });
    await forwards.put({ key: b, tenantId, eventId: event.eventId, visitor: 'visitor-b', eventType: event.eventType, at: event.at });
    await receipts.put({ tenantId, eventId: event.eventId, key: b });
    const orphanKey = `${tenantId}::visitor-a::forward-only`;
    await forwards.put({ key: orphanKey, tenantId, eventId: 'forward-only', visitor: 'visitor-a', eventType: event.eventType, at: event.at });
    await eraseCdpCollectedEvents(tenantId, 'visitor-a');
    expect(await forwards.get(a)).toBeNull(); expect(await forwards.get(orphanKey)).toBeNull();
    expect(await collectedEvents.get(event.eventId)).toEqual(event);
    expect(await forwards.get(b)).not.toBeNull();
    await eraseCdpCollectedEvents(tenantId, 'visitor-b');
    expect(await forwards.get(b)).toBeNull();
    expect(await listCollectedEvents(tenantId)).toEqual([]);
  });

  it.each([false, true])('canonical E164 erasure reaches formatted-phone identity, pending=%s, without crossing tenants', async (pending) => {
    const event = { ...row('phone-event', 'visitor-a'), payload: { phone: '+1 (555) 000-1111' }, piiFields: ['phone'] };
    await persistCollectedEvent({ ...event, tenantId: 'foreign', eventId: 'foreign-phone' });
    const cas = storage.kvCompareAndSwap.bind(storage); let failed = false;
    const fault = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (pending && !failed && key === primaryKey(event.eventId) && JSON.parse(next).payload) { failed = true; throw new Error('primary unavailable'); }
      return cas(key, expected, next);
    });
    if (pending) await expect(persistCollectedEvent(event)).rejects.toThrow('primary unavailable');
    else await persistCollectedEvent(event);
    fault.mockRestore();
    await eraseCdpCollectedEvents(tenantId, '+15550001111');
    expect(await collectedEvents.get(event.eventId)).toEqual({ tenantId, eventId: event.eventId, deleted: true });
    expect(await listCollectedEvents(tenantId)).toEqual([]);
    expect((await listCollectedEvents('foreign'))[0]?.payload).toEqual(event.payload);
  });

  it('orphan-only cleanup resumes after failure without fencing another visitor primary', async () => {
    const event = row('orphan-cleanup', 'visitor-b');
    await collectedEvents.put(event);
    const oldKey = `${tenantId}::visitor-a::${event.eventId}`;
    await forwards.put({ key: oldKey, tenantId, eventId: event.eventId, visitor: 'visitor-a', eventType: event.eventType, at: event.at });
    await receipts.put({ tenantId, eventId: event.eventId, key: oldKey }); // stale old reverse
    const remove = storage.kvDelete.bind(storage);
    vi.spyOn(storage, 'kvDelete').mockImplementation(async (key) => {
      if (key === `hostext:cdp:visitor-event:${oldKey}`) throw new Error('orphan cleanup unavailable');
      return remove(key);
    });
    await expect(eraseCdpCollectedEvents(tenantId, 'visitor-a')).rejects.toThrow('orphan cleanup unavailable');
    expect((await receipts.listByPrefix(`${tenantId}::projection::`))[0]).toMatchObject({ state: 'deleting' });
    await reopen(); await reconcileCollectedEventReceipts();
    expect(await forwards.get(oldKey)).toBeNull();
    expect(JSON.stringify(await receipts.list())).not.toContain('visitor-a');
    expect(await collectedEvents.get(event.eventId)).toEqual(event);
    expect((await eventsForVisitors(tenantId, ['visitor-b'])).events.map((e) => e.eventId)).toEqual([event.eventId]);
  });

  it('the registered fan-out reaches payload.visitor', async () => {
    await persistCollectedEvent(row('fanout-visitor', 'visitor-a'));
    const report = await eraseSubject(tenantId, 'visitor-a');
    expect(report.missing).not.toContain('eraseCdpCollectedEvents');
    expect(report.failedFeatures.filter((name) => !name.endsWith(' (never registered)'))).toEqual([]);
    expect(report.failed).toBe(report.missing.length); // this focused registry is not a full boot
    expect(await listCollectedEvents(tenantId)).toEqual([]);
  });

  it('forward tombstones never consume the visitor cap', async () => {
    const event = row('still-live', 'visitor-a');
    await persistCollectedEvent(event);
    const receipt = await receipts.get(`${tenantId}::${event.eventId}`);
    const prefix = receipt!.forwardKey!.slice(0, -event.eventId.length);
    for (let i = 0; i <= VISITOR_EVENT_CAP; i++) await forwards.put({ key: `${prefix}deleted-${i}`, tenantId, eventId: `deleted-${i}`, deleted: true });
    expect((await eventsForVisitors(tenantId, ['visitor-a']))).toMatchObject({ events: [expect.objectContaining({ eventId: event.eventId })], truncated: false });
  }, 120_000);

  it('a stale backfill snapshot cannot recreate an erased primary', async () => {
    const event = row('stale-backfill', 'visitor-a');
    await persistCollectedEvent(event); await deleteCollectedEvent(tenantId, event.eventId);
    await indexCollectedEvent(event);
    expect(await collectedEvents.get(event.eventId)).toEqual({ tenantId, eventId: event.eventId, deleted: true });
    expect(await eventsForVisitors(tenantId, ['visitor-a'])).toEqual({ events: [], truncated: false });
  });

  it('tenant teardown removes receipts and opaque fences without recreating primary rows', async () => {
    await persistCollectedEvent(row('tenant-live', 'visitor-a'));
    await persistCollectedEvent(row('tenant-closed', 'visitor-b'));
    await deleteCollectedEvent(tenantId, 'tenant-closed');
    await persistCollectedEvent(row('foreign-kept', 'visitor-a', 'foreign'));
    await purgeTenantHostExt(tenantId);
    expect(await collectedEvents.get('tenant-live')).toBeNull();
    expect(await collectedEvents.get('tenant-closed')).toBeNull();
    expect(await receipts.listByPrefix(`${tenantId}::`)).toEqual([]);
    expect(await forwards.listByPrefix(`${tenantId}::`)).toEqual([]);
    expect(await collectedEvents.get('foreign-kept')).toMatchObject({ tenantId: 'foreign', payload: { visitor: 'visitor-a' } });
  });
});
