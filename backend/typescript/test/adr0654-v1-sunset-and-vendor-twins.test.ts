import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { VENDOR_ROOT, vendorPath } from '../src/middleware/protocolVersion.js';

/**
 * ADR 0654 deprecated v1 here (2026-09-11) with Deprecation / Sunset / Link on
 * every `/v1` response. ADR 0812 P3c removed v1, and with it that signal: there
 * is no major left to deprecate. What still holds:
 * - no response carries a deprecation signal (v2 is not going away, and `/v1`
 *   is a 410, not a deprecated contract);
 * - the three host-extension operations that lived at protocol-shaped `/v1`
 *   paths (`GET /runs` list, `DELETE /runs/{id}`, the events token, steward
 *   `cc6c`) are reached at their RFC 0181 vendor address.
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

describe('ADR 0812 P3c — no deprecation signal is left', () => {
  it('an unversioned major-2 response and the discovery document carry none', async () => {
    for (const [path, headers] of [
      ['/runs', { ...AUTH, 'OpenWOP-Version': '2' }],
      ['/.well-known/openwop', { Accept: 'application/json' }],
    ] as const) {
      const res = await get(path, headers);
      expect(res.headers.get('openwop-version'), path).toBe('2.0');
      expect(res.headers.get('deprecation'), path).toBeNull();
      expect(res.headers.get('sunset'), path).toBeNull();
    }
  });

  it('a /v1 path is a 410 with no Deprecation, even with the old sunset knob set', async () => {
    process.env.OPENWOP_V1_SUNSET = '2027-01-15';
    const res = await get('/v1/runs');
    expect(res.status).toBe(410);
    expect(res.headers.get('deprecation')).toBeNull();
    expect(res.headers.get('sunset')).toBeNull();
    delete process.env.OPENWOP_V1_SUNSET;
  });
});

describe('ADR 0654 — the three host-extension operations live at their vendor address', () => {
  it(`GET ${vendorPath('/runs')} answers 200`, async () => {
    const res = await get(`${VENDOR_ROOT}/runs?limit=5`);
    expect(res.status).toBe(200);
  });

  it('DELETE and the events token are registered there (a missing run is a 404 from the handler, not a routing miss)', async () => {
    const del = await fetch(`${base}${vendorPath('/runs/00000000-0000-4000-8000-000000000000')}`, { method: 'DELETE', headers: AUTH });
    expect([404, 403]).toContain(del.status);
    expect(((await del.json()) as { error?: string }).error).not.toBe('route_not_found');
    const tok = await get(vendorPath('/runs/00000000-0000-4000-8000-000000000000/events/token'));
    expect([404, 403]).toContain(tok.status);
    expect(((await tok.json()) as { error?: string }).error).not.toBe('route_not_found');
  });
});
