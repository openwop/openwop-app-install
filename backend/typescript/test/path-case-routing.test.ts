/**
 * Paths are case-sensitive (ADR 0795, found in review; live on production
 * 2026-10-01). Express routes case-insensitively by default, while every path
 * predicate in this host compares exactly — so `POST /V1/runs` reached the
 * `/runs` handler having skipped the ADR 0750 rule that a credential-less
 * protocol call is 401. Cookie posture ON, as deployed: that is the posture in
 * which the skipped rule let a session be minted and the call proceed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE = ''; let server: http.Server;
const saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_SESSION_SECRET']) saved[k] = process.env[k];
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'path-case', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const AUTH = { authorization: 'Bearer dev-token' };
const post = (path: string, extra: Record<string, string> = {}): Promise<Response> =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', ...extra }, body: JSON.stringify({ workflowId: 'openwop-app.uppercase', inputs: {} }) });

describe('paths are case-sensitive', () => {
  it('CONTROL: a credential-less run create is 401', async () => {
    expect((await post('/runs')).status).toBe(401);
  });

  // ADR 0812 P3c-0 — the `/V1/runs` / `/v1/RUNS` / `/v1/Runs` spellings retired with the
  // `/v1` path space; the case variants of the unversioned path replace them. Asked WITH a
  // credential, so the only thing standing between the request and a 201 is the router.
  it('CONTROL: the canonical spelling, with a credential, reaches the run-create handler', async () => {
    expect((await post('/runs', AUTH)).status).toBe(201);
  });

  it.each(['/RUNS', '/Runs', '/rUns'])('%s does not reach the run-create handler (it did: 201)', async (path) => {
    const res = await post(path, AUTH);
    expect(res.status).toBe(404);
  });

  it('CONTROL: the canonical spelling of a public path still answers', async () => {
    expect((await fetch(`${BASE}/.well-known/openwop`, { headers: { connection: 'close' } })).status).toBe(200);
  });
});
