/**
 * ADR 0775 P4 follow-up (`ARWF-11`, workforce PATCH) — the two workforce edit
 * routes no longer overwrite a concurrent edit.
 *
 * The race tests inject the concurrent write INSIDE the victim's read→write
 * window (just before its first compare-and-swap), the same harness as
 * `adr0775-p4-stale-write-guards.test.ts`. Before this, `patchMigrationJourney`
 * merged into a read copy and `put` it, so a stage saved concurrently on another
 * key was silently dropped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  __clearMigrationJourneys,
  getMigrationJourney,
  migrationEtag,
  patchMigrationJourney,
} from '../src/host/migrationService.js';
import {
  getWorkforce,
  seedWorkforceEntities,
  setWorkforceStatus,
  workforceEtag,
} from '../src/host/workforceService.js';
import { createApp } from '../src/index.js';

const T = 'tenant-p4-wf';
const WF = 'workforce.finance.invoice-exception';

describe('service: compare-and-swap + If-Match', () => {
  const storage = openSqliteStorage(':memory:');

  /** Run `concurrent` once, just before the first swap on a key containing `marker`. */
  function injectBeforeFirstSwap(marker: string, concurrent: () => Promise<void>): void {
    const realCas = storage.kvCompareAndSwap.bind(storage);
    let fired = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!fired && key.includes(marker)) {
        fired = true;
        await concurrent();
      }
      return realCas(key, expected, next);
    });
  }

  beforeAll(() => initHostExtPersistence(storage));
  afterAll(async () => {
    __resetHostExtPersistence();
    await storage.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    initHostExtPersistence(storage);
    await __clearMigrationJourneys();
    await seedWorkforceEntities();
  });

  it('keeps a stage saved concurrently with the first-ever journey write', async () => {
    injectBeforeFirstSwap(`hostext:migration:${T}:${WF}`, async () => {
      await patchMigrationJourney(T, WF, { stageStatus: { assess: 'done' } });
    });
    await patchMigrationJourney(T, WF, { stageStatus: { target: 'done' } });
    const j = await getMigrationJourney(T, WF);
    expect(j.stageStatus).toMatchObject({ target: 'done', assess: 'done' });
  });

  it('keeps a field saved concurrently with a later stage save', async () => {
    await patchMigrationJourney(T, WF, { stageStatus: { target: 'done' } });
    injectBeforeFirstSwap(`hostext:migration:${T}:${WF}`, async () => {
      await patchMigrationJourney(T, WF, { boundaries: { auto: ['a'], review: ['r'] } });
    });
    await patchMigrationJourney(T, WF, { stageStatus: { 'map-data': 'done' } });
    const j = await getMigrationJourney(T, WF);
    expect(j.boundaries).toEqual({ auto: ['a'], review: ['r'] });
    expect(j.stageStatus).toMatchObject({ target: 'done', 'map-data': 'done' });
  });

  it('refuses a journey write whose If-Match predates a concurrent edit, and leaves the row alone', async () => {
    const seen = migrationEtag(await getMigrationJourney(T, WF));
    // An unsaved journey is minted per read; its version must still be stable.
    expect(migrationEtag(await getMigrationJourney(T, WF))).toBe(seen);
    const other = await patchMigrationJourney(T, WF, { stageStatus: { assess: 'done' } }, { ifMatch: seen });
    await expect(patchMigrationJourney(T, WF, { stageStatus: { target: 'done' } }, { ifMatch: seen })).rejects.toMatchObject({
      httpStatus: 409,
      details: { reason: 'stale_write', currentEtag: migrationEtag(other) },
    });
    expect((await getMigrationJourney(T, WF)).stageStatus.target).toBe('pending');
  });

  it('refuses a cut-over decided against a status another editor has since changed', async () => {
    const seen = workforceEtag((await getWorkforce(T, WF))!);
    injectBeforeFirstSwap(`hostext:workforce-status:${T}:${WF}`, async () => {
      await setWorkforceStatus(T, WF, 'shadow');
    });
    await expect(setWorkforceStatus(T, WF, 'piloting', { ifMatch: seen })).rejects.toMatchObject({
      httpStatus: 409,
      details: { reason: 'stale_write' },
    });
    expect((await getWorkforce(T, WF))!.status).toBe('shadow');
  });

  it('without If-Match, a lost status swap re-reads and lands instead of failing', async () => {
    injectBeforeFirstSwap(`hostext:workforce-status:${T}:${WF}`, async () => {
      await setWorkforceStatus(T, WF, 'shadow');
    });
    expect((await setWorkforceStatus(T, WF, 'piloting'))!.status).toBe('piloting');
    expect((await getWorkforce(T, WF))!.status).toBe('piloting');
  });

  it("another tenant's cut-over does not stale this tenant's version", async () => {
    const seen = workforceEtag((await getWorkforce(T, WF))!);
    await setWorkforceStatus('tenant-other', WF, 'piloting');
    expect(workforceEtag((await getWorkforce(T, WF))!)).toBe(seen);
    expect((await setWorkforceStatus(T, WF, 'shadow', { ifMatch: seen }))!.status).toBe('shadow');
  });
});

describe('HTTP: ETag + If-Match on the workforce routes', () => {
  let server: http.Server;
  let BASE: string;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: 0,
      storageDsn: 'memory://',
      serviceName: 'test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    });
    await seedWorkforceEntities();
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  async function call<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; etag: string | null; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', ...(init.headers ?? {}) },
    });
    return { status: res.status, etag: res.headers.get('etag'), body: (await res.json()) as T };
  }

  const wfPath = `/host/openwop-app/workforces/${encodeURIComponent(WF)}`;

  it('status PATCH: returns its version, accepts a current If-Match, refuses a stale one', async () => {
    // Start from `shadow`: a move back to `production` is gated on graduation
    // (409 `cutover_not_eligible`) before the version is ever checked.
    expect((await call(wfPath, { method: 'PATCH', body: JSON.stringify({ status: 'shadow' }) })).status).toBe(200);
    const read = await call<{ etag: string; status: string }>(wfPath);
    expect(read.status).toBe(200);
    expect(read.body.status).toBe('shadow');
    expect(read.etag).toBe(`"${read.body.etag}"`);
    const next = 'piloting';

    const ok = await call<{ etag: string; status: string }>(wfPath, {
      method: 'PATCH', headers: { 'If-Match': read.etag! }, body: JSON.stringify({ status: next }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe(next);
    expect(ok.etag).toBe(`"${ok.body.etag}"`);
    expect(ok.body.etag).not.toBe(read.body.etag);

    const stale = await call<{ details?: { reason?: string; currentEtag?: string } }>(wfPath, {
      method: 'PATCH', headers: { 'If-Match': read.etag! }, body: JSON.stringify({ status: read.body.status }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details).toMatchObject({ reason: 'stale_write', currentEtag: ok.body.etag });
    expect((await call<{ status: string }>(wfPath)).body.status).toBe(next);
  });

  it('migration PATCH: returns its version, accepts a current If-Match, refuses a stale one', async () => {
    const read = await call<{ etag: string }>(`${wfPath}/migration`);
    expect(read.status).toBe(200);
    expect(read.etag).toBe(`"${read.body.etag}"`);

    const ok = await call<{ etag: string; stageStatus: Record<string, string> }>(`${wfPath}/migration`, {
      method: 'PATCH', headers: { 'If-Match': read.etag! }, body: JSON.stringify({ stageStatus: { assess: 'done' } }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.stageStatus.assess).toBe('done');

    const stale = await call<{ details?: { reason?: string; currentEtag?: string } }>(`${wfPath}/migration`, {
      method: 'PATCH', headers: { 'If-Match': read.etag! }, body: JSON.stringify({ stageStatus: { target: 'done' } }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details).toMatchObject({ reason: 'stale_write', currentEtag: ok.body.etag });

    // Omitting If-Match keeps field-level last-writer-wins.
    const free = await call<{ stageStatus: Record<string, string> }>(`${wfPath}/migration`, {
      method: 'PATCH', body: JSON.stringify({ stageStatus: { target: 'done' } }),
    });
    expect(free.status).toBe(200);
    expect(free.body.stageStatus).toMatchObject({ assess: 'done', target: 'done' });
  });
});
