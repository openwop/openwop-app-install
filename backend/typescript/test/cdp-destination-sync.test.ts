/**
 * CDP-D Phase 1 — destination-sync core (ADR 0266). The genuinely-missing CDC
 * watermark + field mapping (pure, unit-tested) + the config catalog + dry-run
 * preview (route, toggle-gated).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { applyFieldMap, selectChangedRecords } from '../src/features/destination-sync/destinationSyncService.js';

describe('CDP-D pure primitives', () => {
  it('applyFieldMap renames present fields, skips absent ones', () => {
    const mapped = applyFieldMap({ email: 'a@x.test', stage: 'lead', extra: 1 }, [
      { from: 'email', to: 'EMAIL' },
      { from: 'stage', to: 'lifecycle_stage' },
      { from: 'missing', to: 'nope' },
    ]);
    expect(mapped).toEqual({ EMAIL: 'a@x.test', lifecycle_stage: 'lead' });
  });

  it('selectChangedRecords: first sync returns all + seeds the watermark to the max', () => {
    const recs = [{ id: '1', updatedAt: '2026-01-01' }, { id: '2', updatedAt: '2026-03-01' }, { id: '3', updatedAt: '2026-02-01' }];
    const r = selectChangedRecords(recs, undefined, 'updatedAt');
    expect(r.changed.length).toBe(3);
    expect(r.nextCursor).toBe('2026-03-01');
  });

  it('selectChangedRecords: subsequent sync returns only records past the watermark', () => {
    const recs = [{ id: '1', updatedAt: '2026-01-01' }, { id: '2', updatedAt: '2026-03-01' }, { id: '4', updatedAt: '2026-04-01' }];
    const r = selectChangedRecords(recs, '2026-03-01', 'updatedAt');
    expect(r.changed.map((c) => c.id)).toEqual(['4']);
    expect(r.nextCursor).toBe('2026-04-01');
  });

  it('selectChangedRecords: skips records missing the cursor field', () => {
    const recs = [{ id: '1' }, { id: '2', updatedAt: '2026-05-01' }];
    const r = selectChangedRecords(recs as any, undefined, 'updatedAt');
    expect(r.changed.map((c: any) => c.id)).toEqual(['2']);
  });
});

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users'); if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
let n = 0;
async function owner() { const c = client(); const r = await c.post('/v1/host/openwop-app/test/login', { email: `d-${Date.now()}-${n++}@a.test`, tenantId: `org:d-${Date.now()}-${n++}` }); expect(r.status).toBe(201); return c; }
const setToggle = async (id: string, s: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: s }, 'test'); };

describe('CDP-D destination-sync routes', () => {
  it('creates a sync and dry-runs the field mapping without sending', async () => {
    await setToggle('destination-sync', 'on');
    const c = await owner();
    const created = await c.post('/v1/host/openwop-app/destination-sync/syncs', {
      name: 'to-esp', destinationKind: 'esp', sourceObject: 'contact', syncMode: 'cdc',
      fieldMap: [{ from: 'email', to: 'EMAIL' }, { from: 'stage', to: 'status' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.syncMode).toBe('cdc');

    const dry = await c.post(`/v1/host/openwop-app/destination-sync/syncs/${created.body.syncId}/dry-run`, { sample: { email: 'a@x.test', stage: 'customer', ignored: true } });
    expect(dry.status).toBe(200);
    expect(dry.body.mapped).toEqual({ EMAIL: 'a@x.test', status: 'customer' });
  });

  it('rejects a duplicate destination field in the map', async () => {
    await setToggle('destination-sync', 'on');
    const c = await owner();
    const bad = await c.post('/v1/host/openwop-app/destination-sync/syncs', { name: 'dup', fieldMap: [{ from: 'a', to: 'X' }, { from: 'b', to: 'X' }] });
    expect(bad.status).toBe(400);
  });

  it('prepare does NOT advance; an explicit advance (post-egress) commits the watermark', async () => {
    await setToggle('destination-sync', 'on');
    const c = await owner();
    const sync = (await c.post('/v1/host/openwop-app/destination-sync/syncs', {
      name: 'cdc', syncMode: 'cdc', cursorField: 'updatedAt', fieldMap: [{ from: 'email', to: 'EMAIL' }],
    })).body;
    const recs = [{ email: 'a@x', updatedAt: '2026-01-01' }, { email: 'b@x', updatedAt: '2026-02-01' }];
    const P = `/v1/host/openwop-app/destination-sync/syncs/${sync.syncId}`;

    const first = await c.post(`${P}/prepare`, { records: recs });
    expect(first.body.count).toBe(2);
    expect(first.body.nextCursor).toBe('2026-02-01');

    // prepare did NOT advance — re-preparing the SAME records (e.g. after an egress
    // failure) still returns them, so nothing is dropped.
    const retry = await c.post(`${P}/prepare`, { records: recs });
    expect(retry.body.count).toBe(2);

    // commit the watermark AFTER a successful egress
    const adv = await c.post(`${P}/advance`, { cursor: first.body.nextCursor });
    expect(adv.status).toBe(200);
    expect(adv.body.cursor).toBe('2026-02-01');

    // NOW a re-prepare of the same records sends nothing; a newer record is picked up
    expect((await c.post(`${P}/prepare`, { records: recs })).body.count).toBe(0);
    const third = await c.post(`${P}/prepare`, { records: [...recs, { email: 'c@x', updatedAt: '2026-03-01' }] });
    expect(third.body.count).toBe(1);
    expect(third.body.payloads[0]).toEqual({ EMAIL: 'c@x' });
  });

  it('is toggle-gated (OFF ⇒ 404)', async () => {
    await setToggle('destination-sync', 'off');
    const c = await owner();
    expect((await c.get('/v1/host/openwop-app/destination-sync/syncs')).status).toBe(404);
  });
});
