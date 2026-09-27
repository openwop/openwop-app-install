/**
 * ADR 0384 P4 — OPENWOP_SPA_SHELL_URL delivery mode (the flip's shell source).
 * The Cloud Run image does not bundle the SPA dist, so the shell is fetched
 * from Hosting's static /index.html and TTL-cached; a refresh failure serves
 * the last-good shell (stale beats broken); a non-HTML body is never cached.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { __expireShellRefreshForTests, __resetShellCacheForTests } from '../src/features/publishing/routes.js';

let PORT = 0; let server: http.Server;
let shellServer: http.Server; let SHELL_URL = '';
let shellBody = '<!doctype html><html><head></head><body>SHELL v1</body></html>';
let shellStatus = 200;
let shellHits = 0;
let condHits = 0;
let shellEtag: string | null = null;
/** When true the origin accepts the connection and NEVER answers — the
 *  starved-continuation shape (see the wedge tests). */
let shellHang = false;
const hung: http.ServerResponse[] = [];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; res(); }); });
  await new Promise<void>((res) => {
    shellServer = http.createServer((req, r) => {
      shellHits += 1;
      if (shellHang) { hung.push(r); return; } // never responds
      // Mirror Hosting: answer a matching If-None-Match with a bodyless 304.
      if (shellEtag && req.headers['if-none-match'] === shellEtag && shellStatus === 200) {
        condHits += 1; r.statusCode = 304; r.end(); return;
      }
      r.statusCode = shellStatus;
      r.setHeader('content-type', 'text/html');
      if (shellEtag) r.setHeader('etag', shellEtag);
      r.end(shellBody);
    });
    shellServer.listen(0, '127.0.0.1', () => { SHELL_URL = `http://127.0.0.1:${(shellServer.address() as AddressInfo).port}/index.html`; res(); });
  });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => shellServer.close(() => res()));
});
afterEach(() => {
  delete process.env.OPENWOP_SPA_SHELL_URL;
  delete process.env.OPENWOP_SPA_SHELL_TTL_S;
  __resetShellCacheForTests();
  shellStatus = 200;
  shellBody = '<!doctype html><html><head></head><body>SHELL v1</body></html>';
  shellHits = 0;
  condHits = 0;
  shellEtag = null;
  shellHang = false;
  for (const r of hung.splice(0)) { try { r.destroy(); } catch { /* already gone */ } }
});

const humanGet = (path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers: { 'user-agent': 'Mozilla/5.0 Safari' } }, (res) => {
      let raw = ''; res.on('data', (c) => (raw += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
    });
    req.on('error', reject); req.end();
  });

describe('ADR 0384 — shell-from-URL', () => {
  it('serves the fetched shell to humans and caches it within the TTL', async () => {
    process.env.OPENWOP_SPA_SHELL_URL = SHELL_URL;
    process.env.OPENWOP_SPA_SHELL_TTL_S = '60';
    const first = await humanGet('/p/anything');
    expect(first.status).toBe(200);
    expect(first.body).toContain('SHELL v1');
    await humanGet('/p/anything');
    expect(shellHits).toBe(1); // second request within TTL = cache hit
  });

  it('keeps serving the last-good shell when a TTL refresh fails (stale beats broken)', async () => {
    process.env.OPENWOP_SPA_SHELL_URL = SHELL_URL;
    process.env.OPENWOP_SPA_SHELL_TTL_S = '1';
    expect((await humanGet('/')).body).toContain('SHELL v1');
    shellStatus = 500; // origin breaks
    await new Promise((r) => setTimeout(r, 1100)); // TTL expires
    const stale = await humanGet('/');
    expect(stale.status).toBe(200); // refresh is fire-and-forget; stale serves
    expect(stale.body).toContain('SHELL v1');
    await new Promise((r) => setTimeout(r, 50)); // let the failed refresh settle
    expect((await humanGet('/')).body).toContain('SHELL v1'); // last-good retained
  });

  it('first fetch failure yields an honest 404 (no last-good to fall back to)', async () => {
    process.env.OPENWOP_SPA_SHELL_URL = SHELL_URL;
    shellStatus = 500;
    expect((await humanGet('/')).status).toBe(404);
  });

  it('never caches a non-HTML body (error page defense)', async () => {
    process.env.OPENWOP_SPA_SHELL_URL = SHELL_URL;
    shellBody = '{"error":"not_found"}';
    const res = await humanGet('/p/x');
    expect(res.status).toBe(404); // rejected → no shell → honest 404
  });
});

/**
 * The TTL is the public `/` OUTAGE WINDOW, not a freshness knob (verified live
 * 2026-08-02): Hosting prunes the previous build's hashed assets, so a shell
 * cached from before a frontend deploy points at a bundle that 404s into the
 * SPA rewrite and returns `text/html`, which the browser refuses as a module.
 * These pin the two properties that keep the window small and affordable.
 */
describe('ADR 0384 — shell staleness window', () => {
  // NOTE the mock origin honours If-None-Match; the REAL Firebase Hosting does
  // NOT (measured 2026-08-03 — it answers 200+body). This asserts our client
  // SENDS a correct conditional request and handles a 304, which is what pays
  // off on a white-label host that supports it. It is NOT evidence that the
  // production window is shortened by 304s — that comes from the TTL.
  it('SENDS a conditional request and keeps the body on 304 (host-dependent benefit)', async () => {
    shellEtag = 'W/"v1"';
    process.env.OPENWOP_SPA_SHELL_URL = SHELL_URL;
    process.env.OPENWOP_SPA_SHELL_TTL_S = '1';
    expect((await humanGet('/')).body).toContain('SHELL v1');
    expect(condHits).toBe(0); // first fetch is unconditional — nothing to validate against

    await new Promise((r) => setTimeout(r, 1100)); // TTL lapses
    await humanGet('/');                            // triggers the refresh
    await new Promise((r) => setTimeout(r, 100));   // fire-and-forget settles
    expect(condHits).toBeGreaterThan(0);            // it sent If-None-Match
    expect((await humanGet('/')).body).toContain('SHELL v1'); // 304 kept the body
  });

  it('picks up a CHANGED shell on the next revalidation (the window closes)', async () => {
    shellEtag = 'W/"v1"';
    process.env.OPENWOP_SPA_SHELL_URL = SHELL_URL;
    process.env.OPENWOP_SPA_SHELL_TTL_S = '1';
    expect((await humanGet('/')).body).toContain('SHELL v1');

    // A frontend deploy: new shell, new validator (and the old assets are gone).
    shellBody = '<!doctype html><html><head></head><body>SHELL v2</body></html>';
    shellEtag = 'W/"v2"';
    await new Promise((r) => setTimeout(r, 1100));
    await humanGet('/');
    await new Promise((r) => setTimeout(r, 100));
    expect((await humanGet('/')).body).toContain('SHELL v2'); // stale shell replaced
  });

  it('defaults to a SHORT window when unconfigured (60s, not the old 300s)', async () => {
    process.env.OPENWOP_SPA_SHELL_URL = SHELL_URL;
    delete process.env.OPENWOP_SPA_SHELL_TTL_S; // exercise the default
    expect((await humanGet('/')).body).toContain('SHELL v1');
    // The default is the outage ceiling — assert it directly rather than trust
    // the comment: a 61s-old cache must be considered expired.
    const { __shellTtlMsForTests } = await import('../src/features/publishing/routes.js');
    expect(__shellTtlMsForTests()).toBe(60_000);
  });
});

/**
 * THE 2026-08-08 INCIDENT, as tests.
 *
 * `/` served a pruned bundle for 16+ minutes. Cloud Logging showed 10
 * `human_shell` lines and ZERO `spa_shell_fetch_failed` in the window: the
 * refresh had not FAILED, it had never SETTLED. Cloud Run sets
 * `cpu-throttling=true`, so once a response is flushed a detached continuation
 * may never resume — and the old `(expired && !shellRefreshing)` guard then
 * disabled every future refresh for the life of the instance.
 *
 * The suite could not have caught it: Node in a test always has CPU, so the
 * fire-and-forget promise settled inside the 100 ms sleep the old tests used.
 * These drive the STARVED shape directly — an origin that never answers — which
 * is the only faithful model of the production failure.
 */
describe('ADR 0384 — a starved refresh must not wedge the cache (2026-08-08)', () => {
  it('a refresh that never settles does NOT disable later refreshes', async () => {
    process.env.OPENWOP_SPA_SHELL_URL = SHELL_URL;
    process.env.OPENWOP_SPA_SHELL_TTL_S = '1';
    expect((await humanGet('/')).body).toContain('SHELL v1');

    // A frontend deploy lands, and the very next refresh is starved.
    shellBody = '<!doctype html><html><head></head><body>SHELL v2</body></html>';
    shellHang = true;
    await new Promise((r) => setTimeout(r, 1100));
    // This request opens a refresh that will never settle. It must still answer
    // (with the last-good shell) rather than hang on the origin.
    expect((await humanGet('/')).body).toContain('SHELL v1');

    // The origin recovers. Under the OLD guard `shellRefreshing` was still
    // non-null here, so this request took no action and `/` stayed on v1
    // forever. It must now attempt again once the wedge bound lapses.
    shellHang = false;
    __expireShellRefreshForTests();
    await new Promise((r) => setTimeout(r, 1100));
    await humanGet('/');
    expect((await humanGet('/')).body).toContain('SHELL v2');
  });

  it('a hung origin costs a BOUNDED wait, not a hung request', async () => {
    process.env.OPENWOP_SPA_SHELL_URL = SHELL_URL;
    process.env.OPENWOP_SPA_SHELL_TTL_S = '1';
    await humanGet('/');
    shellHang = true;
    await new Promise((r) => setTimeout(r, 1100));
    const t0 = Date.now();
    const res = await humanGet('/');
    const waited = Date.now() - t0;
    expect(res.body).toContain('SHELL v1');       // last-good, not a 5xx
    // Bounded by SHELL_REFRESH_AWAIT_MS (1s), NOT the 5s fetch abort.
    expect(waited).toBeLessThan(3000);
  });

  it('the refresh completes IN-REQUEST — the same response carries the new shell', async () => {
    // The other half of the fix. On a CPU-throttled host the only reliable place
    // to finish the fetch is inside a request, so a healthy origin must be
    // picked up by the request that noticed the expiry — with no sleep, which is
    // exactly what the old fire-and-forget tests had to add.
    process.env.OPENWOP_SPA_SHELL_URL = SHELL_URL;
    process.env.OPENWOP_SPA_SHELL_TTL_S = '1';
    expect((await humanGet('/')).body).toContain('SHELL v1');
    shellBody = '<!doctype html><html><head></head><body>SHELL v2</body></html>';
    shellEtag = null;
    await new Promise((r) => setTimeout(r, 1100));
    expect((await humanGet('/')).body).toContain('SHELL v2');
  });
});
