/**
 * ADR 0812 P3a regression (prod rev 00874, rolled back 2026-10-06): on a host
 * that has RETIRED 1.x, a header-less browser navigation to a shared run link
 * (`/runs/<id>`, Accept preferring `text/html`) must reach the SPA shell. It
 * must not hit v2Identity's bare-id 400.
 *
 * #4445 made RUN_PATH's `/v1` prefix optional. The negotiator stamps a shell
 * navigation major 2 but deliberately does not rewrite it, so the guard caught
 * the page request and answered `400 validation_error` with JSON. Every shared
 * run link broke.
 *
 * FIXED by #4467 (c258c9fce): v2Identity skips an unversioned match from a client
 * that is not a protocol client. This file is the RETIRED-HOST witness for that fix.
 *
 * Why nothing caught it: the suite pinned v1 as SERVED (test/setup/pinV1Served.ts,
 * removed in ADR 0812 P3c), and on a host that still served v1 a bare id was
 * admitted, so no test ever saw the 400. This file runs retired, as prod does, and keeps
 * protocol-client legs as positive controls: the guard must still refuse a bare
 * id from an API client.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

const SHELL = '<!doctype html><html><head><title>shell</title></head><body>SPA-SHELL-MARKER</body></html>';
const BARE = '0b6f2a3e-5d1c-4e8a-9f00-1a2b3c4d5e6f';
let shellServer: http.Server;
let server: http.Server;
let base = '';
let savedNoCookies: string | undefined;

beforeAll(async () => {
  savedNoCookies = process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  shellServer = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(SHELL); });
  await new Promise<void>((r) => shellServer.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_SPA_SHELL_URL = `http://127.0.0.1:${(shellServer.address() as AddressInfo).port}/index.html`;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => shellServer.close(() => r()));
  delete process.env.OPENWOP_SPA_SHELL_URL;
  // Restore the cookie switch so it cannot leak into a later file in this worker.
  if (savedNoCookies === undefined) Reflect.deleteProperty(process.env, 'OPENWOP_AUTH_DISABLE_COOKIES'); else process.env.OPENWOP_AUTH_DISABLE_COOKIES = savedNoCookies;
});

async function get(path: string, headers: Record<string, string>) {
  const res = await fetch(`${base}${path}`, { headers: { 'User-Agent': 'Mozilla/5.0', Authorization: 'Bearer dev-token', ...headers } });
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
}
const HTML = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

describe('ADR 0812 P3a regression — a shared run link on a host that retired 1.x', () => {
  it('a header-less BROWSER navigation to /runs/<bare id> reaches the SPA shell (it was a 400 on rev 00874)', async () => {
    const r = await get(`/runs/${BARE}`, HTML);
    expect(r.status, r.body.slice(0, 200)).toBe(200);
    expect(r.type).toContain('text/html');
    expect(r.body).toContain('SPA-SHELL-MARKER');
  });

  it('POSITIVE CONTROL: an API client on the same path still gets the bare-id 400 (the guard holds)', async () => {
    const r = await get(`/runs/${BARE}`, { Accept: 'application/json' });
    expect(r.status, r.body.slice(0, 200)).toBe(400);
    expect(r.type).toContain('application/json');
    expect(JSON.parse(r.body).error).toBe('validation_error');
  });

  it('POSITIVE CONTROL: naming the contract makes even an html-preferring client a protocol client, and it gets the 400', async () => {
    const r = await get(`/runs/${BARE}`, { ...HTML, 'OpenWOP-Version': '2' });
    expect(r.status, r.body.slice(0, 200)).toBe(400);
    expect(r.body).not.toContain('SPA-SHELL-MARKER');
  });
});
