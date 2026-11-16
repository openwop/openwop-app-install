/**
 * ADR 0391 (b) / ADR 0384 — `/pricing` is a platform-origin document door.
 *
 * `/pricing` is the SPA's pricing route (it renders the `pricing` CMS page), but
 * only `/` and `/p/:slug` had crawler doors. Hosting answered a link-preview
 * crawler at `/pricing` with the bare shell: no title, description or og:* tags.
 * MEASURED on casavoga.com build 5b6a4ac81 (2026-11-16, CasaVoga ISS-061): a
 * `facebookexternalhit` GET of `/pricing` was the 6,953-byte shell, while
 * `/p/pricing` carried the full preview. The door must not be a 301 to
 * `/p/pricing`, because sign-in returns to `/pricing` to continue checkout.
 *
 * Red on `origin/main` `3052cf028` (witnessed before the fix): no backend route
 * answered `/pricing`, and it was not an auth-public path, so this host 401'd the
 * crawler.
 *
 * The bot branch sets `no-store`: the Firebase CDN strips `Vary`, so a cached
 * bot document could be served to a human (or the shell to a crawler). The
 * backend's own prerender LRU is the only cache on this path.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { isPublicPath } from '../src/middleware/auth.js';

let PORT = 0; let server: http.Server;
type Layer = { regexp?: RegExp & { fast_slash?: boolean }; route?: { path?: unknown; methods?: Record<string, boolean> }; name?: string; handle?: { stack?: Layer[] } };
let routerStack: Layer[] = [];
let TENANT = ''; let ORG = '';
const PREVIEW_BOT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const SHELL = '<!doctype html><html><head><title>shell</title></head><body><div id="root"></div></body></html>';
let shellFile = '';

function rawGet(path: string, ua: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers: { 'user-agent': ua } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_PUBLIC_BASE_URL;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; res(); }); });
  routerStack = ((app as unknown as { _router?: { stack?: Layer[] } })._router?.stack) ?? [];
  const d = getToggleDefault('users'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  const base = `http://127.0.0.1:${PORT}`;
  let cookie = '';
  const call = async (path: string, body: unknown): Promise<{ user?: { tenantId?: string }; tenantId?: string; orgId?: string }> => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return (await res.json()) as { user?: { tenantId?: string }; tenantId?: string; orgId?: string };
  };
  const login = await call('/host/openwop-app/test/login', { email: `pricing0391-${Date.now()}@acme.test` });
  TENANT = login.user?.tenantId ?? login.tenantId ?? '';
  ORG = (await call('/host/openwop-app/orgs', { name: 'Pricing Door Co' })).orgId ?? '';
  expect(TENANT).not.toBe('');
  expect(ORG).not.toBe('');
  const page = await createPage({
    tenantId: TENANT, orgId: ORG, title: 'Plans and Pricing', slug: 'pricing',
    sections: [{ type: 'richText', data: { heading: 'Plans and Pricing', text: 'Pick the plan that fits.' } }],
    createdBy: 'u1',
  });
  await transitionPage(TENANT, ORG, page.pageId, 'publish', 'u1');
  shellFile = join(mkdtempSync(join(tmpdir(), 'pricing0391-')), 'shell.html');
  writeFileSync(shellFile, SHELL);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => {
  delete process.env.OPENWOP_PUBLIC_SITE_ORG_ID;
  delete process.env.OPENWOP_SPA_SHELL_FILE;
});
const asSite = (): void => { process.env.OPENWOP_PUBLIC_SITE_ORG_ID = ORG; process.env.OPENWOP_SPA_SHELL_FILE = shellFile; };

describe('the /pricing document door', () => {
  it('`/pricing` is an auth-public path, segment-bounded', () => {
    expect(isPublicPath('/pricing')).toBe(true);
    expect(isPublicPath('/pricingx')).toBe(false);
  });

  // The public-path match is segment-bounded (`path === p || path.startsWith(p + '/')`),
  // so listing `/pricing` also makes every `/pricing/…` path public. That is safe only
  // while no route lives under it. This walks every route the app registers (routers
  // mounted at the root included) and fails if one answers below `/pricing/`. A route
  // added there later must move off this prefix, or this entry must become exact.
  it('no route is registered under `/pricing/`, which the public prefix would expose', () => {
    expect(routerStack.length).toBeGreaterThan(100); // the walk saw the real app, not an empty stack
    const probes = ['/pricing/x', '/pricing/x/y', '/pricing/x/y/z'];
    const hits: string[] = [];
    let routesSeen = 0;
    const walk = (stack: Layer[]): void => {
      for (const layer of stack) {
        if (layer.route) {
          routesSeen += 1;
          for (const p of probes) if (layer.regexp?.test(p)) hits.push(`${String(layer.route.path)} answers ${p}`);
        } else if (layer.name === 'router' && layer.handle?.stack && layer.regexp?.fast_slash) {
          walk(layer.handle.stack);
        } else if (layer.name === 'router' && layer.handle?.stack && probes.some((p) => layer.regexp?.test(p))) {
          hits.push(`a router mounted at ${String(layer.regexp)} answers under /pricing/`);
        }
      }
    };
    walk(routerStack);
    expect(routesSeen).toBeGreaterThan(100);
    expect(hits).toEqual([]);
  });

  it('an unauthenticated request below `/pricing/` reaches nothing', async () => {
    asSite();
    for (const path of ['/pricing/x', '/pricing/admin/plans']) {
      const r = await rawGet(path, HUMAN);
      expect(r.status, path).toBe(404);
    }
  });

  it('a link-preview crawler gets the pricing page prerendered, with its preview tags', async () => {
    asSite();
    const r = await rawGet('/pricing', PREVIEW_BOT);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('<title>Plans and Pricing');
    expect(r.body).toContain('<meta property="og:title" content="Plans and Pricing');
    expect(r.body).toMatch(/<meta property="og:description" content="[^"]+">/);
    expect(r.body).toMatch(/<meta name="twitter:card" content="summary(_large_image)?">/);
    expect(r.body).toContain('Pick the plan that fits.');
    expect(r.body).not.toContain('<div id="root"></div>');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(String(r.headers.vary)).toMatch(/User-Agent/i);
  });

  it('it is the same document `/p/pricing` serves, not a redirect to it', async () => {
    asSite();
    const door = await rawGet('/pricing', PREVIEW_BOT);
    const page = await rawGet('/p/pricing', PREVIEW_BOT);
    expect(door.status).toBe(200);
    expect(door.headers.location).toBeUndefined();
    expect(door.body).toBe(page.body);
  });

  it('a browser still gets the SPA shell, uncached, so sign-in can return to /pricing', async () => {
    asSite();
    const r = await rawGet('/pricing', HUMAN);
    expect(r.status).toBe(200);
    expect(r.body).toBe(SHELL);
    expect(r.headers.location).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(String(r.headers.vary)).toMatch(/User-Agent/i);
  });
});
