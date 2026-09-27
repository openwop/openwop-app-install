/**
 * ADR 0631 — THE ORIGIN SERVES THE MAJOR-2 PATH SPACE AND THE SPA ON THE SAME ROOTS.
 *
 * `spec/v2/path-manifest.json` roots the whole v2 path space at the discovery
 * host (`serverUrl: https://{host}`). On production, Firebase Hosting rewrote
 * only `/api`, `/v1`, `/.well-known` to Cloud Run, so 14 of the 15 manifest
 * roots answered `200 text/html` (the SPA shell) with no `OpenWOP-Version` —
 * found by the corpus steward's second-party witness (crosstalk `fdc6`,
 * 2026-09-05): every one of its 17 fails was this shape. Advertising a major
 * is a claim about the path space (P4-SPEC-15); the origin was not honoring it.
 *
 * The fix routes every manifest root to the backend. Two of them (`agents`,
 * `runs`) are ALSO SPA pages, and hosting cannot key on a request header — so
 * the backend decides: a request naming a major gets the API; a headerless
 * request that prefers HTML (a browser navigation) gets the SPA shell the
 * backend already serves for `/` (ADR 0384); a headerless request that does
 * not prefer HTML keeps today's JSON 404. One owner for the shell (publishing),
 * one owner for "what an unversioned path means" (the negotiator).
 *
 * Each leg is load-bearing under a distinct sabotage: drop the Accept check →
 * leg 3 fails; drop the header check → leg 2 fails; register on `/runs` only →
 * leg 4 fails; forget `Vary` → leg 5 fails; let `/v1` fall through → leg 6.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

const SHELL = '<!doctype html><html><head><title>shell</title></head><body>SPA-SHELL-MARKER</body></html>';
let shellServer: http.Server;
let server: http.Server;
let base = '';

beforeAll(async () => {
  shellServer = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(SHELL); });
  await new Promise<void>((r) => shellServer.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_SPA_SHELL_URL = `http://127.0.0.1:${(shellServer.address() as AddressInfo).port}/index.html`;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => shellServer.close(() => r()));
  delete process.env.OPENWOP_SPA_SHELL_URL;
});

async function get(path: string, headers: Record<string, string>) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: 'Bearer dev-token', ...headers } });
  return { status: res.status, type: res.headers.get('content-type') ?? '', ver: res.headers.get('openwop-version'), vary: (res.headers.get('vary') ?? '').toLowerCase(), cache: res.headers.get('cache-control') ?? '', body: await res.text() };
}
const HTML = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

describe('ADR 0631 — a manifest root serves the SPA shell to a browser and the API to a client', () => {
  it('1. headerless browser navigation to /runs/<id> → the SPA shell (200 text/html)', async () => {
    const r = await get('/runs/some-run-id', HTML);
    expect(r.status).toBe(200);
    expect(r.type).toContain('text/html');
    expect(r.body).toContain('SPA-SHELL-MARKER');
    expect(r.cache, 'a dual-purpose path must never be cached by a CDN').toContain('no-store');
  });

  it('2. the same path naming major 2 → the API (JSON, OpenWOP-Version: 2.0), never the shell', async () => {
    const r = await get('/runs/some-run-id', { ...HTML, 'OpenWOP-Version': '2' });
    expect(r.ver).toBe('2.0');
    expect(r.type).toContain('application/json');
    expect(r.body).not.toContain('SPA-SHELL-MARKER');
    expect(JSON.parse(r.body).error).toBe('not_found');
  });

  it('3. headerless but NOT preferring HTML (a curl / SDK) → today\'s JSON 404, not the shell', async () => {
    const r = await get('/runs/some-run-id', { Accept: '*/*' });
    expect(r.status).toBe(404);
    expect(r.type).toContain('application/json');
    expect(r.body).not.toContain('SPA-SHELL-MARKER');
  });

  it('4. every manifest root falls through the same way — bare /agents and a non-SPA root /tools', async () => {
    for (const p of ['/agents', '/agents/agent-1', '/tools', '/webhooks/x']) {
      const r = await get(p, HTML);
      expect(r.status, p).toBe(200);
      expect(r.body, p).toContain('SPA-SHELL-MARKER');
    }
  });

  it('5. the responses declare what they vary on (OpenWOP-Version on the API branch, Accept on the shell branch)', async () => {
    const api = await get('/runs/some-run-id', { ...HTML, 'OpenWOP-Version': '2' });
    expect(api.vary).toContain('openwop-version');
    const shell = await get('/runs/some-run-id', HTML);
    expect(shell.vary).toContain('accept');
  });

  it('6. a versioned path never falls through: /v1/runs/<id> from a browser is still the JSON 404', async () => {
    const r = await get('/v1/runs/some-run-id', HTML);
    expect(r.status).toBe(404);
    expect(r.type).toContain('application/json');
  });
});
