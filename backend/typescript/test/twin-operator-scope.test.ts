/**
 * TWIN-5 — the OPERATOR-PRINCIPAL ALLOW witness.
 *
 * `features/twin/routes.ts` declared its own `requireTenantScope` over
 * `resolveEffectiveAccess(tenantOf(req), { subject })` — the third hand-rolled copy
 * of that predicate in the repo. Beyond the org-first-match non-determinism and
 * the fail-open-on-undefined arm, it lacked the WILDCARD OPERATOR EXIT the
 * canonical helper has (`features/featureRoute.ts:262`), so an env-API-key /
 * admin-token / conformance-harness principal — which has no member row anywhere —
 * got a hard 403 on a scope it can never obtain.
 *
 * That is a REFUSAL, and the `AGMEM-1` closeout's lesson is that six refuse-only
 * cases pass a refuse-everything gate. This is the ALLOW half: it fails if the
 * canonical helper is ever swapped back for a local copy, and it fails if the
 * wildcard exit is deleted.
 *
 * @see docs/adr/0589-twin-tenancy-and-recall-audience.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let server: http.Server;
let BASE = '';

/** `k-op:*` is the wildcard operator principal; `k-a:tenant-a` is the control. */
const KEYS = 'k-op:*,k-a:tenant-a';

async function call(key: string, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
}

let rosterId = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_API_KEYS = KEYS;
  delete process.env.OPENWOP_API_KEY;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('twin-recall');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  // A REAL agent in the operator's own tenant. Without it `requireOwnedAgent`
  // 404s BEFORE the scope gate and this whole file measures nothing — the
  // vacuity mode that a 'not 403' assertion is most prone to.
  const r = await call('k-op', '/v1/host/openwop-app/roster', 'POST', { persona: 'Aide', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  rosterId = r.body.rosterId;
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_API_KEYS;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
});

describe('TWIN-5 — the twin admin lane uses the canonical tenant-scope gate', () => {
  it('a WILDCARD operator principal can READ the twin link of a real agent (200, not 403)', async () => {
    const res = await call('k-op', `/v1/host/openwop-app/agents/${encodeURIComponent(rosterId)}/twin`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.link).toBe(null);
  });

  it('and can WRITE it — the scope the local copy could never grant an operator', async () => {
    const res = await call('k-op', `/v1/host/openwop-app/agents/${encodeURIComponent(rosterId)}/twin`, 'PUT', { userId: 'user:some-person' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.link.userId).toBe('user:some-person');
  });

  it('the 404 path is still ordered FIRST, so the two assertions above are not measuring it', async () => {
    const res = await call('k-op', '/v1/host/openwop-app/agents/no-such-agent/twin');
    expect(res.status).toBe(404);
  });
});
