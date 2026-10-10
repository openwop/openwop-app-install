/**
 * ADR 0812 P3b, step 1 — pin who answers each shared root BEFORE the routing flip.
 *
 * The SPA shell and the protocol share the origin's v2 roots (ADR 0631/0646).
 * Today one mechanism keeps them apart: the negotiator rewrites a PROTOCOL client's
 * request to `/v1…` before any router runs. A browser navigation (header-less, an
 * Accept that prefers `text/html`) is left unversioned, so it reaches the shell
 * route, the only thing mounted at the bare root. Vendor paths (`/host/openwop-app/*`)
 * are rewritten whatever their Accept, so the shell never sees them.
 *
 * P3b removes the rewrite and registers routes unversioned. Who answers is then
 * decided by REGISTRATION ORDER unless it is gated explicitly. It could go wrong
 * two ways:
 * - a JSON handler registered first answers a browser on `/runs/<id>`;
 * - the shell registered first on `/host/*` captures vendor GETs a browser makes
 *   directly: an asset `<img>`, `embed.js`, the OAuth callback, a prerendered page.
 * ADR 0812 P3a already shipped one regression of this class to prod (a shell
 * navigation answered 400, rolled back; see `adr0812-shell-navigation-retired-host`).
 *
 * So this file pins today's behaviour, MEASURED on `48fcab3b2`, on a host that
 * has retired 1.x as prod has. P3b must keep it green.
 * - Every shared root, and a path under it: a browser gets the shell (200 html),
 *   and an API client gets JSON and never the shell.
 * - Vendor `/host/openwop-app/*`: a browser never gets the shell.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { v2MountedRootPrefixes } from '../src/middleware/protocolVersion.js';

const MARK = 'SPA-SHELL-MARKER';
const PROBE = 'zz-probe-0123456789abcdef';
let shellServer: http.Server;
let server: http.Server;
let base = '';
const saved = {
  cookies: process.env.OPENWOP_AUTH_DISABLE_COOKIES,
  dsn: process.env.OPENWOP_STORAGE_DSN,
};

beforeAll(async () => {
  shellServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body>${MARK}</body></html>`);
  });
  await new Promise<void>((r) => shellServer.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_SPA_SHELL_URL = `http://127.0.0.1:${(shellServer.address() as AddressInfo).port}/index.html`;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => shellServer.close(() => r()));
  delete process.env.OPENWOP_SPA_SHELL_URL;
  if (saved.cookies === undefined) delete process.env.OPENWOP_AUTH_DISABLE_COOKIES; else process.env.OPENWOP_AUTH_DISABLE_COOKIES = saved.cookies;
  if (saved.dsn === undefined) delete process.env.OPENWOP_STORAGE_DSN; else process.env.OPENWOP_STORAGE_DSN = saved.dsn;
});

const BROWSER = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0' };
const API_V2 = { Accept: 'application/json', 'OpenWOP-Version': '2' };
const API_HEADERLESS = { Accept: 'application/json' };

async function get(path: string, headers: Record<string, string>): Promise<{ status: number; type: string; shell: boolean }> {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: 'Bearer dev-token', ...headers }, redirect: 'manual' });
  const body = await res.text();
  return { status: res.status, type: res.headers.get('content-type') ?? '', shell: body.includes(MARK) };
}

describe('ADR 0812 P3b step 1 — shared roots: a browser gets the shell, an API client gets JSON', () => {
  const roots = v2MountedRootPrefixes();

  it('the root list is the manifest\'s, not empty (non-vacuous)', () => {
    expect(roots.length).toBeGreaterThanOrEqual(13);
    for (const r of ['/runs', '/agents', '/host', '/webhooks', '/workflows']) expect(roots, r).toContain(r);
  });

  it('a header-less browser navigation reaches the SPA shell on every root and below it', async () => {
    for (const r of roots) {
      for (const path of [r, `${r}/${PROBE}`]) {
        const res = await get(path, BROWSER);
        expect(res.status, path).toBe(200);
        expect(res.type, path).toContain('text/html');
        expect(res.shell, `${path}: browser must get the shell`).toBe(true);
      }
    }
  });

  // MEASURED: this leg is MASKED today. A protocol client is rewritten to `/v1…`
  // before the shell route runs, so the shell's own `isProtocolClient → next()` is
  // never exercised: deleting it leaves this file green. It becomes load-bearing
  // the moment P3b removes the rewrite, and is then this leg's witness. The P3b
  // routing PR must re-run that sabotage and show this leg going red.
  it('a protocol client gets JSON and never the shell, whether it names the version or only accepts JSON', async () => {
    for (const r of roots) {
      for (const path of [r, `${r}/${PROBE}`]) {
        for (const [label, headers] of [['OpenWOP-Version: 2', API_V2], ['Accept json only', API_HEADERLESS]] as const) {
          const res = await get(path, headers);
          expect(res.type, `${path} (${label})`).toContain('application/json');
          expect(res.shell, `${path} (${label}): an API client must never get the shell`).toBe(false);
        }
      }
    }
  });

  it('naming the contract makes an html-preferring client a protocol client', async () => {
    for (const path of ['/runs', '/agents', `/workflows/${PROBE}`]) {
      const res = await get(path, { ...BROWSER, 'OpenWOP-Version': '2' });
      expect(res.shell, path).toBe(false);
      expect(res.type, path).toContain('application/json');
    }
  });
});

describe('ADR 0812 P3b step 1 — vendor paths: a browser reaches the vendor route, never the shell', () => {
  // `/host` is a shared root, so the shell is mounted on `/host/*`. Today vendor
  // requests are rewritten before routing and never meet it. After the flip they
  // will, unless the shell gate excludes the vendor space.
  const VENDOR = [
    `/host/openwop-app/${PROBE}`,
    '/host/openwop-app/assets/zz-missing',
    '/host/openwop-app/connections/oauth/callback',
    '/host/openwop-app/public-brand',
  ];

  it('a browser GET on a vendor path is answered by the vendor route table', async () => {
    for (const path of VENDOR) {
      const res = await get(path, BROWSER);
      expect(res.shell, `${path}: a browser must not get the SPA shell on a vendor path`).toBe(false);
    }
    // Positive control: a missing vendor path is the route table's JSON 404.
    const miss = await get(`/host/openwop-app/${PROBE}`, BROWSER);
    expect(miss.status).toBe(404);
    expect(miss.type).toContain('application/json');
  });
});
