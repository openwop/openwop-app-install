/**
 * Run-scoped stream capability token (ADR 0088 follow-up) — `host/runStreamToken`
 * + its wiring into `host/runAccess.loadReadableRun` and the
 * `GET /v1/runs/:id/events/token` mint endpoint.
 *
 * The gap this closes: a BYOK user with no account (anon) has no ID token and
 * an anon session can't tenant-match cross-origin, so their run-event SSE 404s.
 * The token is minted SAME-ORIGIN (where the anon cookie authenticates) and
 * presented on the cross-origin SSE.
 *
 * @see src/host/runStreamToken.ts
 */

import { mintAnonSession, signSession } from '../src/middleware/cookieSession.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { mintRunStreamToken, verifyRunStreamToken } from '../src/host/runStreamToken.js';
import { type RunRecord } from '../src/types.js';
import { toWireRunId } from '../src/host/v2Ids.js';
import { VENDOR_ROOT } from '../src/middleware/protocolVersion.js';
import type { Storage } from '../src/storage/storage.js';

// ── Unit ───────────────────────────────────────────────────────────────────

describe('runStreamToken (unit)', () => {
  it('mint → verify round-trips for the same run', () => {
    const t = mintRunStreamToken('run-A');
    expect(verifyRunStreamToken('run-A', t)).toBe(true);
  });

  it('rejects a token minted for a DIFFERENT run', () => {
    const t = mintRunStreamToken('run-A');
    expect(verifyRunStreamToken('run-B', t)).toBe(false);
  });

  it('rejects an expired token', () => {
    const t0 = 1_000_000_000_000; // fixed mint instant
    const t = mintRunStreamToken('run-A', t0);
    // 2h later — past the 1h TTL.
    expect(verifyRunStreamToken('run-A', t, t0 + 2 * 3600_000)).toBe(false);
    // still valid 30min later.
    expect(verifyRunStreamToken('run-A', t, t0 + 1800_000)).toBe(true);
  });

  it('rejects malformed / forged tokens without throwing', () => {
    for (const bad of ['', 'garbage', 'v1.notanumber.sig', 'v2.99999999999.sig', 'v1.99999999999.', `v1.99999999999.${'x'.repeat(43)}`]) {
      expect(verifyRunStreamToken('run-A', bad)).toBe(false);
    }
  });

  it('SEC-3: a token is a DETERMINISTIC capability over (runId, exp) — same second ⇒ identical, later second ⇒ different', () => {
    const t0 = 1_000_000_000_000;
    // Two mints within the same UTC second are intentionally IDENTICAL — the token
    // is an idempotent capability over (runId, exp-second), not a random nonce. So
    // re-minting doesn't invalidate an in-flight token, and both still verify.
    const a = mintRunStreamToken('run-A', t0);
    const b = mintRunStreamToken('run-A', t0 + 500); // same UTC second
    expect(a).toBe(b);
    expect(verifyRunStreamToken('run-A', a, t0)).toBe(true);
    // A mint in a LATER second carries a later `exp` ⇒ a different token (the exp
    // advances), and it is still valid.
    const c = mintRunStreamToken('run-A', t0 + 1000); // next UTC second
    expect(c).not.toBe(a);
    expect(verifyRunStreamToken('run-A', c, t0 + 1000)).toBe(true);
  });
});

// ── HTTP boundary ────────────────────────────────────────────────────────────

let server: http.Server;
let BASE: string;

// ADR 0812 P3c-0 — ported off the v1 wire. Ids are 16+ characters so they can be
// tenant-bound, protocol paths carry the bound id the CALLER would send, and the
// mint route is the vendor address the SPA uses.
const A = 'run-tok-A-0123456789';
const ANON_RUN = 'run-tok-anon-0123456789';
const RUN_A: RunRecord = {
  runId: A, workflowId: 'wf', tenantId: 'tenant-A', status: 'completed',
  inputs: {}, metadata: {}, configurable: {}, createdAt: 'now', updatedAt: 'now',
};

const ANON_OWNER = mintAnonSession();

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await (app.locals.storage as Storage).insertRun({ ...RUN_A });
  await (app.locals.storage as Storage).insertRun({ ...RUN_A, runId: ANON_RUN, tenantId: ANON_OWNER.tenantId });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('stream-token capability (HTTP)', () => {
  const code = (path: string, headers: Record<string, string> = {}): Promise<number> =>
    fetch(`${BASE}${path}`, { headers }).then((r) => r.status);
  /** The run's events stream as a caller acting in `tenant` spells it on the v2 wire. */
  const events = (runId: string, tenant: string): string => `/runs/${encodeURIComponent(toWireRunId(runId, tenant))}/events`;
  /** What the SPA sends cross-origin: the id bound to the RUN's tenant. */
  const runEvents = events(A, 'tenant-A');
  const mint = (runId: string): string => `${VENDOR_ROOT}/runs/${encodeURIComponent(runId)}/events/token`;
  const V2 = { 'openwop-version': '2' };

  it('the OWNER (wildcard operator) can mint a token', async () => {
    const r = await fetch(`${BASE}${mint(A)}`, { headers: { authorization: 'Bearer dev-token' } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { streamToken?: string };
    expect(typeof body.streamToken).toBe('string');
    expect(verifyRunStreamToken(A, body.streamToken!)).toBe(true);
  });

  it('a NON-owner (anon, different tenant) cannot mint — 404', async () => {
    // A real anon SESSION (ADR 0750 major-1 extension: a request with no
    // credential at all is refused 401 before the ownership check).
    expect(await code(mint(A), { cookie: `__session=${signSession(mintAnonSession())}` })).toBe(404);
  });

  it('a streamToken IS a credential: the cookie-less cross-origin SSE on the bound id is served (v2)', async () => {
    const minted = mintRunStreamToken(A);
    expect(await code(`${runEvents}?streamToken=${encodeURIComponent(minted)}`, { accept: 'text/event-stream', ...V2 })).toBe(200);
  });

  it('a valid token authorizes the cross-tenant SSE; a bogus one does not', async () => {
    const minted = mintRunStreamToken(A);
    const sse = { accept: 'text/event-stream', ...V2 };
    // anon caller (different tenant) + valid token → authorized (run is
    // completed, so the stream flushes + closes).
    expect(await code(`${runEvents}?streamToken=${encodeURIComponent(minted)}`, sse)).toBe(200);
    // bogus token, and nothing else presented → a REJECTED credential: 401, not
    // the identity layer's 403 nor the tenant gate's 404 (both told an
    // expired-token viewer the run was not theirs).
    expect(await code(`${runEvents}?streamToken=v1.99999999999.bogus`, sse)).toBe(401);
    // a token for ANOTHER run does not authorize this one.
    const other = mintRunStreamToken('some-other-run-0123456789');
    expect(await code(`${runEvents}?streamToken=${encodeURIComponent(other)}`, sse)).toBe(401);
  });

  it('a rejected token answers 401 invalid_token, for a fresh visitor and a returning anon cookie, absent run or not', async () => {
    const bogus = 'streamToken=v1.99999999999.bogus';
    const sse = { accept: 'text/event-stream', ...V2 };
    const r = await fetch(`${BASE}${runEvents}?${bogus}`, { headers: sse });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('error="invalid_token"');
    // A returning anon cookie is still a principal this host minted, not a credential.
    expect(await code(`${runEvents}?${bogus}`, { ...sse, cookie: `__session=${signSession(mintAnonSession())}` })).toBe(401);
    // An absent run answers the same as an unowned one — nothing about existence leaks.
    expect(await code(`${events('no-such-run-0123456789', 'tenant-A')}?${bogus}`, sse)).toBe(401);
  });

  it('a stale token never costs a caller the access their OTHER credential grants', async () => {
    const bogus = 'streamToken=v1.99999999999.bogus';
    const sse = { accept: 'text/event-stream', ...V2 };
    // The anon OWNER, same-origin: the cookie owns the run, the URL token is stale.
    expect(await code(`${events(ANON_RUN, ANON_OWNER.tenantId)}?${bogus}`, { ...sse, cookie: `__session=${signSession(ANON_OWNER)}` })).toBe(200);
    // A real credential (the wildcard operator, acting in `default`) with a stale token.
    expect(await code(`${events(A, 'default')}?${bogus}`, { ...sse, authorization: 'Bearer dev-token' })).toBe(200);
    // …and a real credential that does NOT own the run keeps its 404: the token
    // was not the whole of its authority, so this is not a credential rejection.
    expect(await code(`${events('no-such-run-0123456789', 'default')}?${bogus}`, { ...sse, authorization: 'Bearer dev-token' })).toBe(404);
    // …nor does a real credential naming ANOTHER tenant's bound id turn into a 401:
    // it keeps the identity layer's refusal.
    expect(await code(`${runEvents}?${bogus}`, { ...sse, authorization: 'Bearer dev-token' })).toBe(403);
  });
});
