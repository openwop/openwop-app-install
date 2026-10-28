/**
 * The SPA's live run stream on major 2: `GET /runs/{tenant-bound id}/events?streamToken=…`
 * with NO cookie (the SSE base is cross-origin, `config.sseBaseUrl` → `*.run.app`,
 * where the session cookie cannot follow) — `frontend/react/src/client/streamsClient.ts`
 * `boundStream` + `credentialedFetch`.
 *
 * The auth layer admits the token as a credential and gives the request a FRESH
 * anon session, so the caller's tenant is never the run's. `v2Identity` compared
 * the bound id's tenant segment against that anon tenant and refused
 * `403 id_tenant_mismatch` before the route ever verified the token. MEASURED on
 * prod 2026-10-01: 18/18 v2 stream-token requests answered 403.
 * `run-stream-token.test.ts` drove only the BARE id on major 2, which the overlap
 * still admits under the caller's tenant, so it could not see this.
 *
 * Each admit leg has a refusal twin, so the token — not the path — is what admits.
 *
 * DOUBLE GUARD (named): a presented token is verified twice — by `v2Identity`
 * (`streamTokenAdmits`) and again by the route (`runAccess.loadReadableRun`). So
 * dropping the identity layer's verify alone stays green (probe
 * 8fw4g4-stb-verify, vacuous by design); the shared piece both call,
 * `verifyRunStreamToken`, is probed as 8fw4g4-stb-verify-shared-r2.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { mintRunStreamToken } from '../src/host/runStreamToken.js';
import { toWireRunId } from '../src/host/v2Ids.js';
import type { RunRecord } from '../src/types.js';
import type { Storage } from '../src/storage/storage.js';

const RUN: RunRecord = {
  runId: 'run-v2tok-bound-0000001', workflowId: 'wf', tenantId: 'tenant-a', status: 'completed',
  inputs: {}, metadata: {}, configurable: {}, createdAt: '2026-01-15T10:00:00.000Z', updatedAt: '2026-01-15T10:00:05.000Z',
};
const OTHER: RunRecord = { ...RUN, runId: 'run-v2tok-bound-0000002' };
const BOUND = encodeURIComponent(toWireRunId(RUN.runId, RUN.tenantId));
const SSE = { accept: 'text/event-stream', 'openwop-version': '2' };

let server: http.Server;
let base = '';
const saved = { cookies: process.env.OPENWOP_AUTH_DISABLE_COOKIES };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES; // the anon mint is part of the path under test
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await (app.locals.storage as Storage).insertRun({ ...RUN });
  await (app.locals.storage as Storage).insertRun({ ...OTHER });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (saved.cookies === undefined) delete process.env.OPENWOP_AUTH_DISABLE_COOKIES; else process.env.OPENWOP_AUTH_DISABLE_COOKIES = saved.cookies;
  await new Promise<void>((r) => server.close(() => r()));
});

async function get(path: string): Promise<{ status: number; error?: string; challenge: string }> {
  const res = await fetch(`${base}${path}`, { headers: SSE });
  const text = await res.text();
  let error: string | undefined;
  try { error = (JSON.parse(text) as { error?: string }).error; } catch { /* SSE body */ }
  return { status: res.status, error, challenge: res.headers.get('www-authenticate') ?? '' };
}

describe('v2 run stream: a stream token admits the tenant-bound id, cookie-less', () => {
  it('a valid token for this run streams it (200, an event stream)', async () => {
    const tok = encodeURIComponent(mintRunStreamToken(RUN.runId));
    const res = await fetch(`${base}/runs/${BOUND}/events?streamToken=${tok}`, { headers: SSE });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.text();
  });

  it('refusal twin: with NO token the same bound id is refused — no credential at all, 401', async () => {
    // Corrected in grade-tests wave 63: this was titled "still the tenant
    // mismatch" and accepted [401, 403]. MEASURED: it is the AUTH layer's 401 —
    // with no token a cookie-less request presents no credential, so the request
    // never reaches the identity layer's tenant check (which is why skipping that
    // check stayed green: probe 8fw4g4-stb-tenant-skip, vacuous).
    const r = await get(`/runs/${BOUND}/events`);
    expect(r.status).toBe(401);
    expect(r.error).toBe('unauthenticated');
  });

  it('refusal twin: a token for ANOTHER run does not admit this one — a rejected credential, 401', async () => {
    // The token was the caller's whole authority and does not verify for THIS
    // run, so it is answered as `runAccess.loadReadableRun` answers it: 401
    // invalid_token (mint a new one), not the identity layer's 403.
    const tok = encodeURIComponent(mintRunStreamToken(OTHER.runId));
    const res = await fetch(`${base}/runs/${BOUND}/events?streamToken=${tok}`, { headers: SSE });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    await res.text();
  });

  it('refusal twin: a forged token does not admit it', async () => {
    const r = await get(`/runs/${BOUND}/events?streamToken=v1.99999999999.forged`);
    expect(r.status).toBe(401);
    expect(r.error).toBe('unauthenticated');
    expect(r.challenge).toContain('error="invalid_token"');
  });

  it('scope: the token admits ONLY the events stream, not the run snapshot', async () => {
    const tok = encodeURIComponent(mintRunStreamToken(RUN.runId));
    // The auth layer reads a token as a credential only on the events stream, so
    // here nothing was presented: 401 before the id is even resolved.
    const r = await get(`/runs/${BOUND}?streamToken=${tok}`);
    expect(r.status).toBe(401);
    expect(r.error).toBe('unauthenticated');
  });
});
