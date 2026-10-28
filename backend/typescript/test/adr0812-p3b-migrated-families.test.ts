/**
 * ADR 0812 P3b — the family-by-family routing flip.
 *
 * ADR 0812 P3b is COMPLETE: every route registers UNVERSIONED and the negotiator
 * rewrites nothing. (Historically: a family in the migrated list registered unversioned; the negotiator
 * stops rewriting it onto `/v1`, and while v1 is still served it strips an
 * inbound `/v1` onto the same route. This file pins three things:
 * - a migrated family answers on its unversioned path, and its `/v1` spelling
 *   is 410 (P3c removed the served-v1 shim with major 1);
 * - an unrewritten vendor path never reaches the SPA shell mounted on `/host/*`
 *   (the shell's vendor exclusion, live for the first time here);
 * - no migrated family keeps a `/v1`-keyed registration, which would 404 now that
 *   nothing rewrites onto it.
 * Tracker: TST-BVC-3.
 *
 * Red when (wave 60 probes w60g4-p3b-*): the SPA shell's vendor exclusion is
 * skipped (the shell then answers a browser on a vendor path; the same guard
 * is witnessed by `adr0812-p3b-shell-vs-protocol`'s vendor case); a route is
 * registered under `/v1` at runtime or in source.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createApp } from '../src/index.js';
import { V1_PATH_PREFIX as V1, VENDOR_ROOT } from '../src/middleware/protocolVersion.js';

const MARK = 'SPA-SHELL-MARKER';
let shellServer: http.Server;
let server: http.Server;
let base = '';
let routePaths: string[] = [];
const saved = {
  cookies: process.env.OPENWOP_AUTH_DISABLE_COOKIES,
  dsn: process.env.OPENWOP_STORAGE_DSN,
  seam: process.env.OPENWOP_TEST_SEAM_ENABLED,
  packsTest: process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED,
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
  // The seams register only when enabled, and the route-table check must SEE them
  // (a /v1-anchored seam route was invisible until these were on).
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  // Every path the REAL app registered, string or array (Express 4 internals, read only).
  type Layer = { route?: { path?: unknown }; name?: string; handle?: { stack?: Layer[] } };
  const stack = (app as unknown as { _router?: { stack?: Layer[] } })._router?.stack ?? [];
  const walk = (layers: Layer[]): void => {
    for (const l of layers) {
      const p = l.route?.path;
      for (const one of Array.isArray(p) ? p : [p]) {
        if (typeof one === 'string') routePaths.push(one);
        // A RegExp route (`/^\/v1\/runs\/([^/:]+):fork$/`) is checked by its LITERAL
        // prefix: unescape `\/`, cut at the first regex metacharacter. Without this,
        // regex-registered routes were invisible to the check (found 2026-10-07:
        // the /packs-test tarball routes kept a /v1 anchor through final batch 1).
        else if (one instanceof RegExp) routePaths.push(one.source.replace(/^\^/, '').replace(/\\\//g, '/').split(/[([?*+.$|\\]/, 1)[0] ?? '');
      }
      if (l.handle?.stack) walk(l.handle.stack);
    }
  };
  walk(stack);
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => shellServer.close(() => r()));
  delete process.env.OPENWOP_SPA_SHELL_URL;
  if (saved.cookies === undefined) delete process.env.OPENWOP_AUTH_DISABLE_COOKIES; else process.env.OPENWOP_AUTH_DISABLE_COOKIES = saved.cookies;
  if (saved.dsn === undefined) delete process.env.OPENWOP_STORAGE_DSN; else process.env.OPENWOP_STORAGE_DSN = saved.dsn;
  if (saved.seam === undefined) delete process.env.OPENWOP_TEST_SEAM_ENABLED; else process.env.OPENWOP_TEST_SEAM_ENABLED = saved.seam;
  if (saved.packsTest === undefined) delete process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED; else process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED = saved.packsTest;
});

async function get(path: string, headers: Record<string, string> = { Accept: 'application/json' }) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: 'Bearer dev-token', ...headers }, redirect: 'manual' });
  const body = await res.text();
  return { status: res.status, type: res.headers.get('content-type') ?? '', body, shell: body.includes(MARK) };
}

const HEARTBEAT = `${VENDOR_ROOT}/heartbeat/settings`;

describe('ADR 0812 P3b — a migrated family', () => {
  it('answers on the unversioned path, and its /v1 spelling is 410', async () => {
    const bare = await get(HEARTBEAT);
    expect(bare.status, bare.body.slice(0, 200)).toBe(200);
    expect(bare.type).toContain('application/json');
    const r = await get(`${V1}${HEARTBEAT}`);
    expect(r.status).toBe(410);
  });

  it('a browser GET on a migrated vendor path never gets the SPA shell (the /host/* exclusion)', async () => {
    const browser = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0' };
    // #4445's prod regression only appeared with 1.x RETIRED, which the suite's
    // pinned-served default never exercised; since ADR 0812 P3c it is the only posture.
    const miss = await get(`${VENDOR_ROOT}/heartbeat/zz-missing`, browser);
    expect(miss.shell, 'an unrewritten vendor path fell through to the /host/* shell').toBe(false);
    expect(miss.status).toBe(404);
    const real = await get(HEARTBEAT, browser);
    expect(real.shell, 'the real route must answer a browser, not the shell').toBe(false);
    expect(real.status, real.body.slice(0, 160)).toBe(200);
  });
});

describe('ADR 0812 P3b — the REAL route table has no /v1 route for a migrated family', () => {
  it('reads a non-trivial route table (non-vacuous)', () => {
    expect(routePaths.length).toBeGreaterThan(500);
    expect(routePaths).toContain(HEARTBEAT);
  });

  it('no registered path starts with /v1 at all (it would 404: nothing rewrites onto it)', () => {
    // Catches what a source grep cannot: a path built at runtime (`/v1${x}`,
    // vendorTwin, a prefix imported from another module).
    const offenders = routePaths.filter((p) => p === V1 || p.startsWith(`${V1}/`));
    expect(offenders).toEqual([]);
  });
});

describe('ADR 0812 P3b — ratchet: a migrated family keeps no /v1 registration', () => {
  const SRC = join(__dirname, '..', 'src');
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.includes('__tests__') ? [p] : [];
    });
  }
  // Comment lines are prose; a line marked `ADR 0812 KEEP` is a deliberate,
  // explained exception (a persisted key, a third-party-held URL, an inbound match).
  const code = (f: string): string => readFileSync(f, 'utf8').split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !l.includes('ADR 0812 KEEP')).join('\n');

  it('no source line registers a route on a /v1 literal or through vendorTwin', () => {
    const offenders: string[] = [];
    const REG = /\.(?:get|post|put|patch|delete|all|use|head|options|route)\(\s*\[?\s*(?:['`]\/v1\/|vendorTwin\(|\/\^\\\/v1)/;
    for (const f of walk(SRC)) {
      for (const [i, line] of code(f).split('\n').entries()) {
        if (REG.test(line)) offenders.push(`${relative(SRC, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
