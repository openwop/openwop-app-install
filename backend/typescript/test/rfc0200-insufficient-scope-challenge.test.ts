/**
 * RFC 0200 §B.1 — a 403 for INSUFFICIENT SCOPE names what was missing.
 *
 * `requireProtocolScope` refused with `403 forbidden` and no challenge, so a
 * client had no machine-readable way to learn which scope to request. The
 * conformance row `0200.challenge-403-scope` could therefore never execute on
 * this host. The refusal now carries
 * `WWW-Authenticate: Bearer error="insufficient_scope", scope="runs:create", …`
 * while the body stays `forbidden` (§B.4) and no status changes (§B.3).
 *
 * Enforcement (`OPENWOP_AUTHORIZATION_ENFORCEMENT`) is read per call, so it is
 * switched on here without rebuilding the app. The low-scope key is a
 * NON-wildcard env bearer with no membership: it resolves to zero scopes and is
 * refused fail-closed. Its 8-char prefix is distinct from `dev-token` because env
 * bearers are identified by `bearer:<first 8 chars>`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const LOW = 'lowscope-key-0200';
let server: Server;
let base = '';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_STORAGE_DSN', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_API_KEYS', 'OPENWOP_AUTHORIZATION_ENFORCEMENT']) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_API_KEYS = `dev-token:*,${LOW}:tenant-lowscope`;
  const { createApp } = await import('../src/index.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT = 'true';
}, 120_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((r) => server.close(() => r()));
});

const createRun = (key: string): Promise<Response> =>
  fetch(`${base}/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ workflowId: 'openwop-app.uppercase', inputs: { text: 'x' } }),
  });

describe('RFC 0200 §B.1 — the insufficient-scope challenge', () => {
  it('a credential lacking runs:create gets 403 with Bearer error="insufficient_scope", scope="runs:create"', async () => {
    const r = await createRun(LOW);
    expect(r.status, 'fail-closed: no membership ⇒ no scope').toBe(403);
    const challenge = r.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch(/^Bearer\b/);
    expect(challenge).toMatch(/error="insufficient_scope"/);
    expect(challenge).toMatch(/scope="runs:create"/);
    expect(challenge).toMatch(/resource_metadata="/);
    const body = (await r.json()) as { error?: string };
    expect(body.error, '§B.4: the body envelope is unchanged').toBe('forbidden');
  });

  it('a wildcard operator credential is not refused and carries no challenge', async () => {
    const r = await createRun('dev-token');
    expect(r.status).toBe(201);
    expect(r.headers.get('www-authenticate')).toBeNull();
  });
});
