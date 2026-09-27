/**
 * ADR 0750 — RFC 0200 §B.1 in the PRODUCTION (cookies-enabled) posture.
 *
 * MEASURED 2026-09-24 against app.openwop.dev: `GET /runs/<id>` under
 * `OpenWOP-Version: 2` with no credential at all answered 404/403 and set a fresh
 * anonymous `__session` cookie — the host admitted the request as a principal it
 * never presented. The in-memory conformance boot passed the same scenario only
 * because it runs with `OPENWOP_AUTH_DISABLE_COOKIES=true`, so this file boots
 * with cookies ENABLED. The posture is captured at `createApp`, so it is set
 * before construction, never mid-test.
 *
 * The controls matter as much as the headline: the anonymous DEMO visitor must
 * still get a session from the major-1 `/me` route, that session must still be
 * honoured on the major-2 read, and a REFUSED bearer must still say
 * `invalid_token` rather than being treated as "no credential".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

let server: Server;
let base = '';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_STORAGE_DSN']) saved[k] = process.env[k];
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES; // the production posture
  delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const { createApp } = await import('../src/index.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((r) => server.close(() => r()));
});

const RUN_ID = 'run_adr0750_does_not_exist';

describe('ADR 0750 — a major-2 request with NO credential is 401 + challenge, never a minted session', () => {
  it('answers 401 with a Bearer resource_metadata challenge, NO error code, and NO Set-Cookie', async () => {
    const r = await fetch(`${base}/runs/${RUN_ID}`, { headers: { 'OpenWOP-Version': '2' } });
    expect(r.status, 'RFC 0200 §B.1: refused before the resource is looked up').toBe(401);
    const challenge = r.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch(/^Bearer\b/i);
    expect(challenge).toMatch(/resource_metadata=/);
    expect(challenge, 'RFC 6750 §3.1: no credential presented ⇒ no error code').not.toMatch(/\berror\s*=/);
    expect(r.headers.get('set-cookie'), 'no anonymous identity may be minted for this request').toBeNull();
  });
});

describe('ADR 0750 controls — the anonymous demo visitor is unaffected', () => {
  it('the major-1 /me route still mints an anonymous session, and that session is honoured on the major-2 read', async () => {
    const me = await fetch(`${base}/v1/host/openwop-app/users/me`);
    const cookie = me.headers.get('set-cookie');
    expect(cookie, 'the SPA bootstrap route must still mint').toBeTruthy();
    const sessionPair = (cookie ?? '').split(';')[0];
    const r = await fetch(`${base}/runs/${RUN_ID}`, { headers: { 'OpenWOP-Version': '2', cookie: sessionPair } });
    expect(r.status, 'a presented session is a credential: the run lookup proceeds (not the no-credential 401)').not.toBe(401);
  });

  it('a REFUSED bearer is still invalid_token, not treated as "no credential"', async () => {
    const r = await fetch(`${base}/runs/${RUN_ID}`, {
      headers: { 'OpenWOP-Version': '2', authorization: 'Bearer not-a-real-credential-adr0750' },
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate') ?? '').toMatch(/error="invalid_token"/);
    expect(r.headers.get('set-cookie'), 'ADR 0434: never mint a new identity for a refused bearer').toBeNull();
  });

  it('major 1 is unchanged: a no-credential v1 request still gets an anonymous session', async () => {
    const r = await fetch(`${base}/v1/runs/${RUN_ID}`);
    expect(r.status).not.toBe(401);
    expect(r.headers.get('set-cookie')).toBeTruthy();
  });
});
