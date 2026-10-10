/**
 * ADR 0846 D6 — the agent-activity feeds (the dashboard's AgentFleet tile) are run
 * data, so they take the `runs:read` gate `GET /runs` takes. Before this, a key
 * narrowed away from `runs:read` read every agent run's status and workflow
 * through them. RED on `origin/main` (f8a3ea22e) for both routes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';

let server: http.Server;
let BASE = '';
const TENANT = 'adr0846-activity';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_AUTHORIZATION_ENFORCEMENT']) saved[k] = process.env[k];
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT; // key narrowing holds in the default posture
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0846-activity', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function key(scopes: string[]): Promise<string> {
  return (await issueApiKey({ tenantId: TENANT, name: 'adr0846', createdBy: 'user:adr0846', scopes })).token;
}
const get = (path: string, token: string): Promise<Response> => fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });

// Every host route already demands `workspace:read` of a key (the key-lane floor), so
// the hole is a key holding THAT but not `runs:read` — e.g. a docs/CMS integration key.
const FEEDS = ['/host/openwop-app/fleet/activity', '/host/openwop-app/roster/no-such-member/activity'];

describe('ADR 0846 D6 — agent activity requires runs:read', () => {
  it.each(FEEDS)('%s refuses a key narrowed away from runs:read', async (path) => {
    const res = await get(path, await key(['workspace:read']));
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate') ?? '').toMatch(/insufficient_scope/);
  });

  it.each(FEEDS)('CONTROL: %s is not refused for scope with runs:read', async (path) => {
    const res = await get(path, await key(['workspace:read', 'runs:read']));
    expect(res.status, 'without this leg a route refusing every key passes the one above').not.toBe(403);
  });
});
