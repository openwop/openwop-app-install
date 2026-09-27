/**
 * ADR 0561 — an env-configured API key is scoped to a tenant, and the
 * cross-tenant wildcard has to be written down.
 *
 * THE DEFECT. Every key in `OPENWOP_API_KEYS` received `tenants: ['*']`
 * unconditionally, and that is not a label — `host/runAccess.ts` returns ANY
 * run to a wildcard principal *before* the ownership check, and a dozen other
 * sites treat it as operator authority. So configuring a single API key handed
 * its holder every tenant's data. The comment on that code said "real
 * deployments narrow via a key→tenant table", describing a table that did not
 * exist: there was no way to narrow, so the wildcard was the only reachable
 * behaviour.
 *
 * It was INERT in production — the demo sets `OPENWOP_API_KEYS=""` and
 * `OPENWOP_API_KEY` is unset, so the key set was empty and no bearer matched
 * (verified against the live Cloud Run config). A loaded gun with no round
 * chambered. That is why the default could be changed cheaply, and it is the
 * honest framing: this fixes a latent grant, it does not close an active breach.
 *
 * ASSERTED AT THE WIRE, through `GET /v1/runs/:runId` — the real bypass path,
 * not the parser's own arithmetic. A test that re-derived the tenant list and
 * compared it to itself would restate the premise instead of checking it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';

let server: http.Server;
let BASE: string;

/** `k-bare` is the regression guard: before ADR 0561 a bare key WAS the
 *  wildcard, so it could read every run below. */
const KEYS = 'k-bare,k-a:tenant-a,k-b:tenant-b,k-op:*';
const RUN_IN_A = 'run-owned-by-tenant-a';

async function getRun(key: string): Promise<number> {
  const res = await fetch(`${BASE}/v1/runs/${RUN_IN_A}`, { headers: { authorization: `Bearer ${key}` } });
  return res.status;
}

/** A FILE-backed DSN, deliberately: `memory://` opens a fresh in-memory sqlite
 *  per call, so a run seeded through a second handle would be invisible to the
 *  app and every assertion below would 404 for the wrong reason — passing while
 *  measuring nothing. */
let DSN: string;
let storage: Storage;

beforeAll(async () => {
  DSN = `sqlite://${join(mkdtempSync(join(tmpdir(), 'openwop-keyscope-')), 'test.db')}`;
  process.env.OPENWOP_STORAGE_DSN = DSN;
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_API_KEYS = KEYS;
  delete process.env.OPENWOP_API_KEY;
  const app = await createApp({ port: 0, storageDsn: DSN, serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

  storage = await openStorage(DSN);
  const now = new Date().toISOString();
  await storage.insertRun({
    runId: RUN_IN_A, workflowId: 'wf', tenantId: 'tenant-a',
    status: 'completed', inputs: null, metadata: {}, configurable: {},
    createdAt: now, updatedAt: now,
  });
  // The seed must be visible to the APP, not just to this handle — otherwise a
  // 404 proves nothing about tenant scoping.
  expect(await getRun('k-op')).toBe(200);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0561 — a bare API key is NOT a cross-tenant grant', () => {
  it('a BARE key cannot read another tenant\'s run', async () => {
    // THE regression guard. This returned 200 before ADR 0561, because a bare
    // key was `tenants:['*']` and `loadReadableRun` short-circuits on it.
    expect(await getRun('k-bare')).toBe(404);
  });

  it('a key scoped to the OWNING tenant can read it', async () => {
    expect(await getRun('k-a')).toBe(200);
  });

  it('a key scoped to a DIFFERENT tenant cannot', async () => {
    // Proves the 404 above is tenant scoping, not a broken key or a route that
    // 404s for everyone — without this the first assertion would pass even if
    // the endpoint were simply dead.
    expect(await getRun('k-b')).toBe(404);
  });

  it('an EXPLICIT `:*` key still gets the operator principal', async () => {
    // The capability is preserved; it just has to be written down. The
    // conformance harness opts in exactly this way (`conformance/run.ts`).
    expect(await getRun('k-op')).toBe(200);
  });

  it('an unconfigured key authenticates nothing', async () => {
    expect(await getRun('not-a-configured-key')).not.toBe(200);
  });
});

describe('ADR 0561 — parsing edge cases resolve toward LESS authority', () => {
  /** Reboots the host with a different key config and reports what that key can
   *  reach. Each case is a config an operator could plausibly write. */
  async function reach(keys: string, key: string): Promise<number> {
    process.env.OPENWOP_API_KEYS = keys;
    const app = await createApp({ port: 0, storageDsn: DSN, serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    const s = app.listen(0, '127.0.0.1');
    await new Promise<void>((res) => s.once('listening', () => res()));
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/v1/runs/${RUN_IN_A}`, { headers: { authorization: `Bearer ${key}` } });
    await new Promise<void>((r) => s.close(() => r()));
    return res.status;
  }

  it('a trailing colon is a typo, not a wildcard request', async () => {
    // `"k1:"` is the shape an operator produces by half-writing a scope. It
    // must not be read as "all tenants".
    expect(await reach('k1:', 'k1')).toBe(404);
  });

  it('a key CONTAINING a colon still parses (split on the LAST one)', async () => {
    expect(await reach('pre:fix:tenant-a', 'pre:fix')).toBe(200);
    expect(await reach('pre:fix:tenant-b', 'pre:fix')).toBe(404);
  });

  it('whitespace around entries is tolerated', async () => {
    expect(await reach(' k1 : tenant-a , k2 ', 'k1')).toBe(200);
  });
});

describe('ADR 0561 — the built-in dev-token fallback is a DIFFERENT case', () => {
  /** Boots with NO key env at all, so `readKeyTenants` falls back to its
   *  built-in local-development default. */
  async function reachWithNoKeyEnv(key: string): Promise<number> {
    delete process.env.OPENWOP_API_KEYS;
    delete process.env.OPENWOP_API_KEY;
    const app = await createApp({ port: 0, storageDsn: DSN, serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    const s = app.listen(0, '127.0.0.1');
    await new Promise<void>((res) => s.once('listening', () => res()));
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/v1/runs/${RUN_IN_A}`, { headers: { authorization: `Bearer ${key}` } });
    await new Promise<void>((r) => s.close(() => r()));
    return res.status;
  }

  it('the UNCONFIGURED dev-token default keeps the wildcard', async () => {
    // Deliberate, and worth pinning because it looks like the bug this ADR
    // fixes. `dev-token` is not configured by an operator — it is the local-dev
    // default, already withdrawn in production by `authIsEnforced()` (SEC-2), so
    // it cannot hand a real deployment cross-tenant access. Scoping it changes
    // no production posture and breaks 166 test files' admin affordance
    // (MEASURED: 181 failures across 59 files).
    expect(await reachWithNoKeyEnv('dev-token')).toBe(200);
  });

  it('but CONFIGURING dev-token explicitly scopes it like any other key', async () => {
    // The line this ADR actually draws: configured keys are scoped, whatever
    // they are named. Without this leg, "dev-token is special" could silently
    // become "the string dev-token is always an operator".
    process.env.OPENWOP_API_KEYS = 'dev-token';
    const app = await createApp({ port: 0, storageDsn: DSN, serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    const s = app.listen(0, '127.0.0.1');
    await new Promise<void>((res) => s.once('listening', () => res()));
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/v1/runs/${RUN_IN_A}`, { headers: { authorization: 'Bearer dev-token' } });
    await new Promise<void>((r) => s.close(() => r()));
    expect(res.status).toBe(404);
  });
});
