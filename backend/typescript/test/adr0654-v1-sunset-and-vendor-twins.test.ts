import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';


/**
 * ADR 0654 deprecated v1 here (2026-09-11) with Deprecation / Sunset / Link on
 * every `/v1` response. ADR 0812 P3c removed v1, and with it that signal: there
 * is no major left to deprecate. What still holds:
 * - no response carries a deprecation signal (v2 is not going away, and `/v1`
 *   is a 410, not a deprecated contract);
 * - the three host-extension operations that lived at protocol-shaped `/v1`
 *   paths (`GET /runs` list, `DELETE /runs/{id}`, the events token, steward
 *   `cc6c`) are reached at their RFC 0181 vendor address.
 *
 * Tracker TST-BG3-22. Red when: the vendor `GET /runs`, `DELETE /runs/:id` or the
 * events-token route is no longer registered at `/host/openwop-app/…` (a routing
 * miss is the catch-all's `not_found` / "No route matches this request.", which the
 * handler's own `run_not_found` refusal is not); a `/v1` path stops answering 410; or
 * a Deprecation/Sunset header comes back (nothing sets one today — a reintroduction
 * guard). The 410 itself is also pinned by adr0812-v1-default.test.ts.
 */
const VENDOR = '/host/openwop-app';
const MISSING_RUN = '00000000-0000-4000-8000-000000000000';
const CATCH_ALL = 'No route matches this request.';
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
    try {
      const res = await get('/v1/runs');
      expect(res.status).toBe(410);
      expect(res.headers.get('deprecation')).toBeNull();
      expect(res.headers.get('sunset')).toBeNull();
    } finally {
      delete process.env.OPENWOP_V1_SUNSET;
    }
  });
});

describe('ADR 0654 — the three host-extension operations live at their vendor address', () => {
  it(`GET ${VENDOR}/runs answers 200 with the run list`, async () => {
    const res = await get(`${VENDOR}/runs?limit=5`);
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { runs?: unknown }).runs)).toBe(true);
  });

  it('DELETE and the events token are registered there (a missing run is a 404 from the handler, not a routing miss)', async () => {
    // The HANDLER's refusal for a missing run — not the catch-all routing miss, which
    // is also a 404 (error 'not_found', message 'No route matches this request.').
    const del = await fetch(`${base}${VENDOR}/runs/${MISSING_RUN}`, { method: 'DELETE', headers: AUTH });
    expect(del.status).toBe(404);
    const delBody = (await del.json()) as { error?: string; message?: string };
    expect(delBody.error).toBe('run_not_found');
    expect(delBody.message).not.toBe(CATCH_ALL);
    const tok = await get(`${VENDOR}/runs/${MISSING_RUN}/events/token`);
    expect(tok.status).toBe(404);
    const tokBody = (await tok.json()) as { error?: string; message?: string };
    expect(tokBody.error).toBe('run_not_found');
    expect(tokBody.message).not.toBe(CATCH_ALL);
  });
});
