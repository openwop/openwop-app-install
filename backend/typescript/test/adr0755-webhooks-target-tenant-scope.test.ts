/**
 * ADR 0755 code-review M1 — `webhooks:manage` holds in the tenant the webhook
 * operation RUNS in, not only the caller's active tenant.
 *
 * `resolveWebhookTenant` honours an explicit `tenantId` for a shared workspace the
 * caller is a member of. Its scope gate resolved `webhooks:manage` in the ACTIVE
 * tenant, so under RFC 0049 enforcement an admin at home who is a mere viewer in
 * the shared workspace managed that workspace's webhooks. Enforcement ON here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createMember, createOrg } from '../src/host/accessControlService.js';

const HOME = 'home-0755';
const WS = 'ws-0755-shared';
// Env keys present `bearer:<first 8 chars>`.
const MIXED = 'mixd0755-admin-home-viewer-ws';
const WSADMIN = 'wsad0755-admin-in-ws';
const saved: Record<string, string | undefined> = {};
let BASE = '';
let server: http.Server;

beforeAll(async () => {
  for (const k of ['OPENWOP_API_KEYS', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_DEPLOY_POSTURE', 'OPENWOP_AUTHORIZATION_ENFORCEMENT']) saved[k] = process.env[k];
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_API_KEYS = `${MIXED}:${HOME},${WSADMIN}:${HOME}`;
  process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
  process.env.OPENWOP_DEPLOY_POSTURE = 'bearer-shared';
  process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await createOrg({ tenantId: HOME, orgId: HOME, name: 'Home', createdBy: 'test' });
  await createOrg({ tenantId: WS, orgId: WS, name: 'Shared', createdBy: 'test' });
  await createMember({ tenantId: HOME, orgId: HOME, subject: 'bearer:mixd0755', displayName: 'Mixed', roles: ['admin'] });
  await createMember({ tenantId: WS, orgId: WS, subject: 'bearer:mixd0755', displayName: 'Mixed', roles: ['viewer'] });
  await createMember({ tenantId: HOME, orgId: HOME, subject: 'bearer:wsad0755', displayName: 'WS admin', roles: ['admin'] });
  await createMember({ tenantId: WS, orgId: WS, subject: 'bearer:wsad0755', displayName: 'WS admin', roles: ['admin'] });
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

const list = (key: string, tenantId?: string) =>
  fetch(`${BASE}/v1/webhooks${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''}`, { headers: { authorization: `Bearer ${key}` } });

describe('webhooks:manage in the target tenant (enforcement on)', () => {
  it('CONTROL: an admin manages webhooks in their own active tenant', async () => {
    const r = await list(MIXED);
    expect(r.status, await r.text()).toBe(200);
  });

  it('an admin at home who is a viewer in the shared workspace is refused there, with the scope challenge', async () => {
    const r = await list(MIXED, WS);
    expect(r.status).toBe(403);
    const body = (await r.json()) as { details?: { requiredScope?: string } };
    expect(body.details?.requiredScope).toBe('webhooks:manage');
    expect(r.headers.get('www-authenticate') ?? '').toMatch(/error="insufficient_scope"/);
  });

  it('CONTROL: an admin of the shared workspace manages its webhooks', async () => {
    const r = await list(WSADMIN, WS);
    expect(r.status, await r.text()).toBe(200);
  });
});
