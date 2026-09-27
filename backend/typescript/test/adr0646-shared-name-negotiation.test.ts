import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';

/**
 * ADR 0646 — content negotiation on a SHARED NAME.
 *
 * `/agents`, `/prompts` and `/runs` are each an SPA page AND a v2 protocol
 * operation, arriving at the same origin. Until ADR 0646 the only thing telling
 * them apart was that a header-less request defaulted to major 1 — which
 * retirement flips (`versioning.md` §5), turning three pages into JSON on
 * cutover day. MEASURED live 2026-09-10 before the fix:
 *   - browser GET /agents         → 200 text/html, carrying `openwop-version: 1.1`
 *     (§1.4 errata: a non-protocol response on a shared name MUST NOT)
 *   - header-less JSON GET /agents → 404 application/json
 *     (§1.3: MUST serve `preferredVersion`'s major — neither page nor operation)
 *
 * The ruling (openwop-1, crosstalk `5041`; §1.4 errata openwop #1315) admits
 * a protocol client by `OpenWOP-Version` OR an `Accept` that admits JSON
 * without preferring HTML; the shell MUST carry no version header and no JSON;
 * `Vary: Accept, OpenWOP-Version` on the name. Every case below is one row of
 * that ruling, exercised through the real listener — the negotiator and the
 * publishing shell route are separate modules, and only the wire shows whether
 * they agree.
 */
let server: Server;
let base = '';
const AUTH = { Authorization: 'Bearer dev-token' };
const SHELL = '<!doctype html><html><body data-shell="adr0646">shell</body></html>';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  // Production-shaped auth: cookie mode ON, so an anonymous browser gets the
  // shell (it has to — that is where the login lives). With cookies disabled
  // the same request is a 401 before any shell route runs, which is a test
  // harness fact, not a product one.
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // The shell is read from disk once per process; point it at a file we own
  // BEFORE the first request so the browser branch has something to serve.
  const dir = mkdtempSync(join(tmpdir(), 'adr0646-'));
  const shellFile = join(dir, 'app-shell.html');
  writeFileSync(shellFile, SHELL);
  process.env.OPENWOP_SPA_SHELL_FILE = shellFile;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  delete process.env.OPENWOP_SPA_SHELL_FILE;
  await new Promise<void>((r) => server.close(() => r()));
});

const get = (path: string, headers: Record<string, string>) => fetch(`${base}${path}`, { headers, redirect: 'manual' });
const vary = (res: Response) => (res.headers.get('vary') ?? '').toLowerCase();

describe('ADR 0646 — a shared name is decided by content negotiation, never by the v1 default', () => {
  it('a browser (prefers text/html, no header) gets the SHELL, with NO OpenWOP-Version and Vary on both signals', async () => {
    const res = await get('/agents', { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toContain('data-shell="adr0646"');
    expect(res.headers.get('openwop-version')).toBeNull();
    expect(vary(res)).toContain('accept');
    expect(vary(res)).toContain('openwop-version');
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('a header-less JSON client gets the OPERATION under preferredVersion\'s major (§1.3), not a 404', async () => {
    const res = await get('/agents', { ...AUTH, Accept: 'application/json' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('openwop-version')).toBe('1.1');
    // The SAME operation the /v1 twin serves — one implementation, two path keys.
    const twin = await get('/v1/agents', { ...AUTH, Accept: 'application/json' });
    expect(twin.status).toBe(200);
    expect(await res.json()).toEqual(await twin.json());
  });

  it('`Accept: */*` with no header is a protocol client (a bare curl), served under major 1', async () => {
    const res = await get('/agents', { ...AUTH, Accept: '*/*' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('openwop-version')).toBe('1.1');
  });

  it('`OpenWOP-Version: 2` wins over an html-preferring Accept — the header names a contract', async () => {
    const res = await get('/agents', { ...AUTH, Accept: 'text/html', 'OpenWOP-Version': '2' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('openwop-version')).toBe('2.0');
  });

  it('an Accept that admits JSON but PREFERS html is the page\'s (q-values, not presence)', async () => {
    const res = await get('/agents', { ...AUTH, Accept: 'text/html, application/json;q=0.9' });
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('openwop-version')).toBeNull();
  });

  it('an Accept that admits html but PREFERS JSON is the protocol\'s', async () => {
    const res = await get('/agents', { ...AUTH, Accept: 'application/json, text/html;q=0.9' });
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('openwop-version')).toBe('1.1');
  });

  it('the /v1 twin is untouched: versioned path, version header, JSON', async () => {
    const res = await get('/v1/agents', { ...AUTH, Accept: 'text/html' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('openwop-version')).toBe('1.1');
  });

  it('the other two shared names negotiate the same way', async () => {
    for (const name of ['/prompts', '/runs']) {
      const page = await get(name, { Accept: 'text/html' });
      expect(page.headers.get('content-type'), name).toMatch(/^text\/html/);
      expect(page.headers.get('openwop-version'), name).toBeNull();
      const api = await get(name, { ...AUTH, Accept: 'application/json' });
      expect(api.headers.get('content-type'), name).toMatch(/^application\/json/);
      expect(api.headers.get('openwop-version'), name).toBe('1.1');
    }
  });
});
