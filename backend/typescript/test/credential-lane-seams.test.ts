/**
 * seams-v2 `mintLaneCredential` / `revokeLaneCredential` (RFC 0170 §B.3) and the
 * `credential_revoked` refusal they witness — ADR 0753 follow-up.
 *
 * RFC 0199's `v2-credential-interrupt` mints a FRESH Subject per run through the
 * mint seam, so a minted key must authenticate as its own Subject and be able to
 * start a run; the revocation leg is RFC 0170's (`identity.md` §2.2).
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };
const MINT = '/conformance/seams/sample/auth/credential/mint';
const REVOKE = '/conformance/seams/sample/auth/credential/revoke';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

async function mint(lane?: string): Promise<Response> {
  return fetch(`${BASE}${MINT}`, { method: 'POST', headers: H, body: JSON.stringify(lane === undefined ? {} : { lane }) });
}

describe('RFC 0170 §B.3 — mint seam (api-key lane, production issuance)', () => {
  it('mints a credential that authenticates as a NEW Subject each time', async () => {
    const a = (await (await mint('api-key')).json()) as { lane: string; credential: string; subjectId: string };
    const b = (await (await mint()).json()) as { lane: string; credential: string; subjectId: string };
    expect(a.lane).toBe('api-key');
    expect(a.credential.startsWith('owk_')).toBe(true);
    expect(a.subjectId).not.toBe(b.subjectId);
    const r = await fetch(`${BASE}/v1/runs`, { headers: { authorization: `Bearer ${a.credential}` } });
    expect(r.status).toBe(200);
  });

  it('a minted Subject can start a run (the credential-interrupt scenario needs exactly this)', async () => {
    const { credential } = (await (await mint()).json()) as { credential: string };
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${credential}` };
    const wf = `mint-seam-wf-${Date.now()}`;
    const reg = await fetch(`${BASE}/v1/host/openwop-app/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId: wf, nodes: [{ nodeId: 'n', typeId: 'core.noop' }], edges: [] }) });
    expect([200, 201]).toContain(reg.status);
    const run = await fetch(`${BASE}/v1/runs`, { method: 'POST', headers: auth, body: JSON.stringify({ workflowId: wf, inputs: {} }) });
    expect([200, 201, 202], await run.clone().text()).toContain(run.status);
  });

  it('refuses a lane it cannot mint (400 — a failure of that lane, never an "absent" 404)', async () => {
    expect((await mint('session')).status).toBe(400);
  });
});

describe('RFC 0170 §B.3 / identity.md §2.2 — revoked on the NEXT request', () => {
  it('v2: a revoked api-key credential is refused 401 credential_revoked', async () => {
    const { credential } = (await (await mint()).json()) as { credential: string };
    const auth = { authorization: `Bearer ${credential}`, 'OpenWOP-Version': '2' };
    expect((await fetch(`${BASE}/runs`, { headers: auth })).status).not.toBe(401);
    const rev = await fetch(`${BASE}${REVOKE}`, { method: 'POST', headers: H, body: JSON.stringify({ credential }) });
    expect(rev.status).toBe(200);
    const after = await fetch(`${BASE}/runs`, { headers: auth });
    expect(after.status).toBe(401);
    const body = (await after.json()) as { error?: unknown };
    const code = typeof body.error === 'string' ? body.error : (body.error as { code?: string } | undefined)?.code;
    expect(code).toBe('credential_revoked');
  });

  it('v1: the same refusal keeps the v1 code it always had (no v1 error-code change)', async () => {
    const { credential } = (await (await mint()).json()) as { credential: string };
    await fetch(`${BASE}${REVOKE}`, { method: 'POST', headers: H, body: JSON.stringify({ credential }) });
    const after = await fetch(`${BASE}/v1/runs`, { headers: { authorization: `Bearer ${credential}` } });
    expect(after.status).toBe(401);
    expect(((await after.json()) as { error: string }).error).toBe('unauthenticated');
  });

  it('revoke: 404 for a credential that matches nothing', async () => {
    expect((await fetch(`${BASE}${REVOKE}`, { method: 'POST', headers: H, body: JSON.stringify({ credential: 'owk_nope' }) })).status).toBe(404);
  });
});
