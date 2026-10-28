/** ADR 0949 E-2: physical SQLite writes witness the retention coverage barrier
 * before deletion, lost acknowledgements, competing cutoffs and count-only runs.
 * Moving the watermark after deletion loses coverage after the injected crash;
 * replacing its CAS with put lets a delayed older purge regress the cutoff. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Storage } from '../src/storage/storage.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { collectEvent, collectedEventsRetainedSince, listCollectedEvents } from '../src/features/cdp/collectService.js';
import { countRetained, purgeRetained } from '../src/host/retentionPurger.js';

let storage: Storage;
let directory: string;
let database: string;
const tenantId = 'retention-coverage-fence';
const watermarkKey = `hostext:cdp:retention-watermark:${tenantId}`;
const cutoff = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'owp-retention-coverage-'));
  database = join(directory, 'store.sqlite');
  storage = openSqliteStorage(database);
  initHostExtPersistence(storage);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await storage.close();
  __resetHostExtPersistence();
  rmSync(directory, { recursive: true });
});

describe('retention coverage admission', () => {
  it('a delete committed before a lost acknowledgement retains its coverage barrier after restart', async () => {
    const event = await collectEvent(tenantId, 'page.viewed', { path: '/' });
    const until = cutoff(1);
    const cas = storage.kvCompareAndSwap.bind(storage);
    let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, prior, next) => {
      const result = await cas(key, prior, next);
      if (!crossed && key === `hostext:cdp:collected-event:${event.eventId}` && JSON.parse(next).deleted === true && result.swapped) {
        crossed = true;
        throw new Error('delete committed; acknowledgement lost');
      }
      return result;
    });
    const result = (await purgeRetained(tenantId, 'confidential-pii', until)).find((row) => row.feature === 'cdp');
    expect(crossed).toBe(true);
    expect(result).toMatchObject({ deleted: 0, failed: 1 });
    vi.restoreAllMocks();
    await storage.close();
    storage = openSqliteStorage(database);
    initHostExtPersistence(storage);
    expect(await listCollectedEvents(tenantId)).toEqual([]);
    expect(await collectedEventsRetainedSince(tenantId)).toBe(until);
  });

  it('a failed coverage write retains the event rather than deleting under a false complete claim', async () => {
    const event = await collectEvent(tenantId, 'page.viewed', { path: '/' });
    const cas = storage.kvCompareAndSwap.bind(storage);
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, prior, next) => {
      if (key === watermarkKey) throw new Error('coverage store unavailable');
      return cas(key, prior, next);
    });
    const result = (await purgeRetained(tenantId, 'confidential-pii', cutoff(1))).find((row) => row.feature === 'cdp');
    expect(result).toMatchObject({ deleted: 0, failed: 1 });
    expect((await listCollectedEvents(tenantId)).map((row) => row.eventId)).toEqual([event.eventId]);
    expect(await collectedEventsRetainedSince(tenantId)).toBeNull();
  });

  it('a delayed older purge cannot overwrite a newer cutoff or another tenant', async () => {
    await collectEvent(tenantId, 'page.viewed', { path: '/' });
    const foreign = await collectEvent('foreign-coverage', 'page.viewed', { path: '/other' });
    const older = cutoff(1);
    const newer = cutoff(2);
    const cas = storage.kvCompareAndSwap.bind(storage);
    let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, prior, next) => {
      if (!crossed && key === watermarkKey && JSON.parse(next).purgedBefore === older) {
        crossed = true;
        await purgeRetained(tenantId, 'confidential-pii', newer);
      }
      return cas(key, prior, next);
    });
    await purgeRetained(tenantId, 'confidential-pii', older);
    expect(crossed).toBe(true);
    expect(await collectedEventsRetainedSince(tenantId)).toBe(newer);
    expect(await collectedEventsRetainedSince('foreign-coverage')).toBeNull();
    expect((await listCollectedEvents('foreign-coverage')).map((row) => row.eventId)).toEqual([foreign.eventId]);
  });

  it('a count-only sweep changes neither coverage nor the event', async () => {
    const event = await collectEvent(tenantId, 'page.viewed', { path: '/' });
    const counted = (await countRetained(tenantId, 'confidential-pii', cutoff(1))).find((row) => row.feature === 'cdp');
    expect(counted).toMatchObject({ counted: true, wouldDelete: 1 });
    expect(await collectedEventsRetainedSince(tenantId)).toBeNull();
    expect((await listCollectedEvents(tenantId)).map((row) => row.eventId)).toEqual([event.eventId]);
  });
});
