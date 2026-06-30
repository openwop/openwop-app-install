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

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { mintRunStreamToken, verifyRunStreamToken } from '../src/host/runStreamToken.js';
import { type RunRecord } from '../src/types.js';
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

const RUN_A: RunRecord = {
  runId: 'run-tok-A', workflowId: 'wf', tenantId: 'tenant-A', status: 'completed',
  inputs: {}, metadata: {}, configurable: {}, createdAt: 'now', updatedAt: 'now',
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await (app.locals.storage as Storage).insertRun({ ...RUN_A });
  await new Promise<void>((res) => {
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('stream-token capability (HTTP)', () => {
  const code = (path: string, headers: Record<string, string> = {}): Promise<number> =>
    fetch(`${BASE}${path}`, { headers }).then((r) => r.status);

  it('the OWNER (wildcard operator) can mint a token', async () => {
    const r = await fetch(`${BASE}/v1/runs/run-tok-A/events/token`, { headers: { authorization: 'Bearer dev-token' } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { streamToken?: string };
    expect(typeof body.streamToken).toBe('string');
    expect(verifyRunStreamToken('run-tok-A', body.streamToken!)).toBe(true);
  });

  it('a NON-owner (anon, different tenant) cannot mint — 404', async () => {
    expect(await code('/v1/runs/run-tok-A/events/token')).toBe(404);
  });

  it('a valid token authorizes the cross-tenant SSE; a bogus one does not', async () => {
    const minted = mintRunStreamToken('run-tok-A');
    // anon caller (different tenant) + valid token → authorized (run is
    // completed, so the stream flushes + closes).
    expect(await code(`/v1/runs/run-tok-A/events?streamToken=${encodeURIComponent(minted)}`, { accept: 'text/event-stream' })).toBe(200);
    // bogus token → falls through to the tenant gate → 404.
    expect(await code('/v1/runs/run-tok-A/events?streamToken=v1.99999999999.bogus', { accept: 'text/event-stream' })).toBe(404);
    // a token for ANOTHER run does not authorize this one.
    const other = mintRunStreamToken('some-other-run');
    expect(await code(`/v1/runs/run-tok-A/events?streamToken=${encodeURIComponent(other)}`, { accept: 'text/event-stream' })).toBe(404);
  });
});
