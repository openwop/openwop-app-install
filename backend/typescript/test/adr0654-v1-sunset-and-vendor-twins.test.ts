import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { VENDOR_ROOT, v1DeprecationHeaders, vendorTwin } from '../src/middleware/protocolVersion.js';

/**
 * ADR 0654 — v1 is DEPRECATED on this host (operator directive 2026-09-11):
 * every `/v1/…` response carries Sunset / Deprecation / Link rel="sunset";
 * unversioned major-2 responses carry none; and the three host-extension
 * operations that lived at protocol-shaped `/v1` paths (`GET /runs` list,
 * `DELETE /runs/{id}`, the events token — never v1 protocol operations,
 * steward `cc6c`) are also reachable on their RFC 0181 vendor twin.
 * Retirement stays atomic and clock-bound (`versioning.md` §5).
 */
let server: Server;
let base = '';
const AUTH = { Authorization: 'Bearer dev-token', Accept: 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  delete process.env.OPENWOP_V1_SUNSET;
  delete process.env.OPENWOP_V1_DEPRECATION;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  delete process.env.OPENWOP_V1_SUNSET;
  await new Promise<void>((r) => server.close(() => r()));
});

const get = (path: string, headers: Record<string, string> = AUTH) => fetch(`${base}${path}`, { headers });

describe('ADR 0654 — v1 deprecation signalling (steward ruling 4ad9)', () => {
  it('every /v1 response carries Deprecation (RFC 9745 @date) + Link, and NO Sunset until the host holds a date', async () => {
    for (const path of ['/v1/runs', '/v1/workflows/does-not-exist', vendorTwin('/runs')]) {
      const res = await get(path);
      expect(res.headers.get('deprecation'), path).toMatch(/^@\d+$/);
      expect(res.headers.get('link'), path).toContain('rel="deprecation"');
      expect(res.headers.get('sunset'), path).toBeNull(); // the clock's notBefore is a floor, not a date this host holds
    }
  });

  it('the v1 discovery document (header-less /.well-known) is deprecated too; the v2 representation is not', async () => {
    const v1 = await get('/.well-known/openwop', { Accept: 'application/json' });
    expect(v1.headers.get('openwop-version')).toBe('1.1');
    expect(v1.headers.get('deprecation')).toMatch(/^@\d+$/);
    const v2 = await get('/.well-known/openwop', { Accept: 'application/json', 'OpenWOP-Version': '2' });
    expect(v2.headers.get('openwop-version')).toBe('2.0');
    expect(v2.headers.get('deprecation')).toBeNull();
  });

  it('an unversioned major-2 response carries NO deprecation signal (v2 is not going away)', async () => {
    const res = await get('/runs', { ...AUTH, 'OpenWOP-Version': '2' });
    expect(res.headers.get('openwop-version')).toBe('2.0');
    expect(res.headers.get('deprecation')).toBeNull();
    expect(res.headers.get('sunset')).toBeNull();
  });

  it('OPENWOP_V1_SUNSET=<date> adds Sunset (rel="sunset"); garbage adds nothing; OPENWOP_V1_DEPRECATION=off silences all of it', async () => {
    process.env.OPENWOP_V1_SUNSET = '2027-01-15';
    let res = await get('/v1/runs');
    expect(res.headers.get('sunset')).toBe('Fri, 15 Jan 2027 00:00:00 GMT');
    expect(res.headers.get('link')).toContain('rel="sunset"');
    process.env.OPENWOP_V1_SUNSET = 'not-a-date';
    res = await get('/v1/runs');
    expect(res.headers.get('sunset')).toBeNull();
    expect(res.headers.get('deprecation')).toMatch(/^@\d+$/);
    delete process.env.OPENWOP_V1_SUNSET;
    process.env.OPENWOP_V1_DEPRECATION = 'off';
    expect(v1DeprecationHeaders()).toBeNull();
    expect((await get('/v1/runs')).headers.get('deprecation')).toBeNull();
    delete process.env.OPENWOP_V1_DEPRECATION;
  });
});

describe('ADR 0654 — the three host-extension reads have their vendor twin', () => {
  it(`GET ${vendorTwin('/runs')} answers exactly like GET /v1/runs`, async () => {
    const a = await get('/v1/runs?limit=5');
    const b = await get(`${vendorTwin('/runs')}?limit=5`);
    expect(b.status).toBe(a.status);
    expect(await b.json()).toEqual(await a.json());
  });

  it('DELETE and the events token are registered on the twin (a missing run is a 404 from the handler, not a routing miss)', async () => {
    const del = await fetch(`${base}${vendorTwin('/runs/00000000-0000-4000-8000-000000000000')}`, { method: 'DELETE', headers: AUTH });
    expect([404, 403]).toContain(del.status);
    expect(((await del.json()) as { error?: string }).error).not.toBe('route_not_found');
    const tok = await get(vendorTwin('/runs/00000000-0000-4000-8000-000000000000/events/token'));
    expect([404, 403]).toContain(tok.status);
    expect(((await tok.json()) as { error?: string }).error).not.toBe('route_not_found');
  });

  it('the canonical vendor address reaches the same handler (through the RFC 0181 mount or, before it, the derived prefix)', async () => {
    const res = await get(`${VENDOR_ROOT}/runs?limit=5`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await (await get('/v1/runs?limit=5')).json());
  });
});
