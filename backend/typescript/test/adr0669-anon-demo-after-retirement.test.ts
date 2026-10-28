import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';

/**
 * ADR 0669 rehearsal, the anonymous DEMO visitor leg.
 *
 * Once v1 retires, a header-less request defaults to major 2, and a major-2
 * protocol request with no credential is refused 401 without minting a session
 * (ADR 0750). The SPA's first-visit bootstrap (`refreshBackendSession`) is
 * exactly such a request, a credential-less `GET /host/openwop-app/users/me`.
 * If the cut stopped minting there, every demo visitor would be locked out on
 * retirement day with every other rehearsal leg green.
 *
 * Measured 2026-09-30 before this file existed: it still mints on both sides of
 * the cut. This pins the retired side; the pre-cut control went with major 1
 * (ADR 0812 P3c). The 401 leg keeps the mint from passing vacuously.
 *
 * Tracker TST-BG3-25. Red when the auth middleware's no-credential refusal stops being
 * scoped to protocol requests (`/users/me` then gets the 401 and no cookie), the
 * refusal is skipped (a credential-less v2 read is no longer the ADR 0750 401), or
 * the anonymous mint stops setting the session cookie.
 */
let server: Server;
let base = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
}, 120_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const V2 = { 'OpenWOP-Version': '2.0', accept: 'application/json' };

/** The demo visitor's first two calls: the SPA's `/me` bootstrap, then a v2 read. */
async function firstVisit() {
  const me = await fetch(`${base}/host/openwop-app/users/me`);
  const cookie = (me.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const withSession = await fetch(`${base}/runs`, { headers: { ...V2, cookie } });
  const withoutSession = await fetch(`${base}/runs`, { headers: V2 });
  return {
    cookie,
    withSession: withSession.status,
    withoutSession: withoutSession.status,
    refusal: (await withoutSession.json().catch(() => ({}))) as { error?: string; message?: string },
    challenge: withoutSession.headers.get('www-authenticate') ?? '',
  };
}

describe('ADR 0669 — the anonymous demo visitor survives the cut', () => {
  it('RETIRED: the credential-less /users/me bootstrap mints a session, and a v2 read with it succeeds', async () => {
    const r = await firstVisit();
    expect(r.cookie, '/users/me must set the session cookie').toMatch(/^__session=/);
    expect(r.withSession, 'a v2 read carrying the minted session').toBe(200);
    // The refusal the bootstrap exists to recover from, still in force (ADR 0750) —
    // the no-credential 401 itself, not a bearer or expired-session 401.
    expect(r.withoutSession, 'a v2 read with no credential at all').toBe(401);
    expect(r.refusal.message).toBe('No credential presented. Authenticate, or establish a session first.');
    expect(r.challenge).toMatch(/^Bearer/);
  });
});
