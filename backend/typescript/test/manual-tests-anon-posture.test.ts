/**
 * MANC-2 / MANC-5 — the manual-tests routes carry a DELIBERATE, documented authz
 * posture, and until now it rested entirely on prose.
 *
 * `routes.ts:1-14` states it: there is no admin/scope gate, because "the subject+
 * tenant key IS the authorization boundary (a caller can never read/write another
 * subject's rows)". That claim has two premises. The second — structural isolation
 * by key — is covered (same-tenant/diff-subject at `manual-tests-route.test.ts:59`,
 * cross-tenant at `man-grade-probe.test.ts` MANP-1). The FIRST — "Authed (the
 * global middleware)" — was never measured, and `subjectOf` falls back to a SHARED
 * `user:_anon` when both `userId` and `principalId` are absent (MANC-2).
 *
 * MEASURED: that fallback is inert, but not for the reason the row assumes. The
 * auth middleware does not 401 an anonymous caller by default — it auto-mints an
 * anon session, and **each visitor gets their own tenant** (`anon:<sid>`, derived
 * from their cookie). So two anonymous callers are separated by the TENANT half of
 * the key and could not collide even if both resolved to `_anon`.
 *
 * That is protection by CONSTRUCTION, which passes every test whether or not it
 * still holds. Flip the default to bearer-required, or make the anon tenant
 * constant, and the posture changes with nothing to notice. These legs pin it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveRun, getRun, listRuns } from '../src/features/manual-tests/manualTestsService.js';

let server: http.Server;
let BASE = '';
const RUNS = '/v1/host/openwop-app/manual-tests/runs';

interface Res { status: number; body: any }
/** A caller with its OWN cookie jar — i.e. its own browser. */
function visitor() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return {
    get: (p: string) => call('GET', p),
    put: (p: string, b?: unknown) => call('PUT', p, b),
    cookie: () => cookie,
  };
}

const RESULTS = { 'case-1': { status: 'pass' } };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_REQUIRE_BEARER; // the default posture is what we are pinning
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('MANC-5 — the documented posture: anonymous callers are ADMITTED, not refused', () => {
  it('an unauthenticated caller is not 401d — it is given a session (the deliberate demo-tier UX)', async () => {
    const anon = visitor();
    const r = await anon.get(RUNS);
    expect(r.status, 'a 401 here would mean the documented posture changed').toBe(200);
    expect(Array.isArray(r.body.runs)).toBe(true);
    expect(anon.cookie(), 'the caller must have been given a session to key rows on').not.toBe('');
  });

  it('...and that caller can keep their OWN runs (the feature works for the anon tier)', async () => {
    const anon = visitor();
    await anon.get(RUNS);
    const saved = await anon.put(`${RUNS}/suite-a`, { results: RESULTS });
    expect(saved.status).toBe(200);
    const read = await anon.get(`${RUNS}/suite-a`);
    expect(read.body.run?.results?.['case-1']?.status).toBe('pass');
  });
});

describe('MANC-2 — the shared `user:_anon` fallback cannot leak ACROSS visitors', () => {
  it('two separate anonymous visitors never see each other\'s runs', async () => {
    const a = visitor();
    const b = visitor();
    await a.put(`${RUNS}/shared-suite`, { results: { 'case-1': { status: 'pass', note: 'A private note' } } });
    const bRead = await b.get(`${RUNS}/shared-suite`);
    expect(bRead.status).toBe(200);
    expect(bRead.body.run, 'visitor B must not receive visitor A\'s row').toBeFalsy();
    // Non-vacuity: the note must actually be PERSISTED for A, or "B cannot see it"
    // is true for the wrong reason. (The first draft wrote `notes:` — the field is
    // `note:` — so the string was never stored and the assertion below passed on a
    // value that did not exist.)
    const aOwn = await a.get(`${RUNS}/shared-suite`);
    expect(aOwn.body.run?.results?.['case-1']?.note, 'A must really hold the note').toBe('A private note');
    const bList = await b.get(RUNS);
    expect(JSON.stringify(bList.body.runs), 'and nothing of A\'s may appear in B\'s list').not.toContain('A private note');
  });

  it('...and B writing the SAME suite key does not clobber A (distinct rows, not a shared bucket)', async () => {
    const a = visitor();
    const b = visitor();
    await a.put(`${RUNS}/collide`, { results: { 'case-1': { status: 'pass', note: 'from A' } } });
    await b.put(`${RUNS}/collide`, { results: { 'case-1': { status: 'fail', note: 'from B' } } });
    const aRead = await a.get(`${RUNS}/collide`);
    expect(aRead.body.run?.results?.['case-1']?.status, 'A\'s row survived B\'s write').toBe('pass');
    expect(aRead.body.run?.results?.['case-1']?.note).toBe('from A');
  });

  it('EITHER half of the (tenant, subject) key isolates on its own — measured, not assumed', async () => {
    // Why this leg exists: sabotaging the subject to a constant `user:_anon`, and
    // separately sabotaging the tenant to a constant, BOTH left the HTTP legs above
    // green — because either half alone still separates the rows. Only collapsing
    // BOTH reds them. So the HTTP legs prove the PROPERTY (visitors are isolated)
    // but cannot attribute it to one half; this one measures each half directly.
    const SUITE = 'halves';
    const R = (note: string) => ({ 'case-1': { status: 'pass' as const, note } });

    // Tenant half: SAME subject, different tenants.
    await saveRun('tenant-x', 'user:same', SUITE, R('x'));
    await saveRun('tenant-y', 'user:same', SUITE, R('y'));
    expect((await getRun('tenant-x', 'user:same', SUITE))?.results?.['case-1']?.note).toBe('x');

    // Subject half: SAME tenant, different subjects.
    await saveRun('tenant-z', 'user:one', SUITE, R('one'));
    await saveRun('tenant-z', 'user:two', SUITE, R('two'));
    expect((await getRun('tenant-z', 'user:one', SUITE))?.results?.['case-1']?.note).toBe('one');

    // ...and neither leaks into a listing of the other.
    expect(JSON.stringify(await listRuns('tenant-y', 'user:same'))).not.toContain('"x"');
    expect(JSON.stringify(await listRuns('tenant-z', 'user:two'))).not.toContain('"one"');
  });
});
