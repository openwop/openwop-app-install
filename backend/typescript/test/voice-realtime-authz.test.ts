/**
 * RTV-1 — the realtime voice /config surface (provider + BYOK credentialRef binding) is
 * superadmin-gated (ADR 0141/0142). A non-admin signed-in user MUST NOT read or repoint the
 * tenant's realtime provider (which could downgrade governed OpenAI → lower-assurance
 * Gemini). The wildcard admin bearer (dev-token) may. Cookie harness mirrors menu-config.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { voiceFeature } from '../src/features/voice/feature.js';

let BASE: string;
let server: http.Server;
let n = 0;
const RT = '/v1/host/openwop-app/voice/realtime';
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_SUPERADMIN_TENANTS; // only the wildcard bearer is superadmin
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://localhost:${(server.address() as AddressInfo).port}`; res(); }); });
  await saveConfig({ ...voiceFeature.toggleDefault!, status: 'on' }, 'test');
});
afterAll(async () => { await __clearToggleStore(); await new Promise<void>((res) => server.close(() => res())); });

const admin = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, { method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

/** A signed-in but NON-superadmin caller (personal tenant), via the test seam. */
async function normalClient(): Promise<(method: string, path: string, body?: unknown) => Promise<Response>> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) {
      const m = /(__session=[^;]+)/.exec(ck);
      if (m?.[1]) cookie = m[1];
    }
    return res;
  };
  const login = await call('POST', '/v1/host/openwop-app/test/login', { email: `rtv-${n++}@x.test` });
  expect(login.status).toBe(201);
  return call;
}

describe('RTV-1 — realtime /config is superadmin-gated', () => {
  it('the wildcard admin bearer can PUT + GET the config', async () => {
    expect((await admin('PUT', `${RT}/config`, { provider: 'gemini-live', credentialRef: 'rt-k' })).status).toBe(200);
    expect((await admin('GET', `${RT}/config`)).status).toBe(200);
  });

  it('a non-superadmin signed-in user is 403 on both PUT and GET', async () => {
    const user = await normalClient();
    expect((await user('PUT', `${RT}/config`, { provider: 'openai-realtime', credentialRef: 'evil' })).status).toBe(403);
    expect((await user('GET', `${RT}/config`)).status).toBe(403);
  });
});
