/**
 * ADR 0132 Phase 4 — capability-scope REST (route + RBAC harness). Boots the real
 * app and drives: toggle-off 404, auth + visibility (IDOR-safe 404 for a non-owner),
 * set/get the scope config, owner-gated write, and resolve a per-tool approval.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
}
async function enable(id: string): Promise<void> { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }

const SCOPE_PATH = (sid: string) => `/v1/host/openwop-app/conversation-tools/sessions/${sid}/capability-scope`;

describe('capability-scope routes (ADR 0132 P4)', () => {
  it('toggle OFF ⇒ 404', async () => {
    const c = client();
    await c('POST', '/v1/host/openwop-app/test/login', { email: 'a@test.dev' });
    const r = await c('GET', SCOPE_PATH('s1'));
    expect(r.status).toBe(404);
  });

  it('owner can set + read the scope; default when unset', async () => {
    await enable('users'); await enable('conversation-tools');
    const c = client();
    await c('POST', '/v1/host/openwop-app/test/login', { email: 'owner@test.dev' });
    // create a conversation the caller owns
    const created = await c('POST', '/v1/host/openwop-app/chat/sessions', { title: 'T' });
    const sid = created.body.sessionId;
    expect(sid).toBeTruthy();

    const empty = await c('GET', SCOPE_PATH(sid));
    expect(empty.status).toBe(200);
    expect(empty.body.scope).toEqual({ mode: 'agent-default' });

    const put = await c('PUT', SCOPE_PATH(sid), { scope: { mode: 'restricted', disabled: ['email.send'], requireApproval: ['crm.contact.update'] } });
    expect(put.status).toBe(200);
    expect(put.body.scope).toMatchObject({ mode: 'restricted', disabled: ['email.send'], requireApproval: ['crm.contact.update'] });

    const get = await c('GET', SCOPE_PATH(sid));
    expect(get.body.scope).toMatchObject({ mode: 'restricted', disabled: ['email.send'] });
  });

  it('a non-owner gets an IDOR-safe 404 (no existence leak)', async () => {
    await enable('users'); await enable('conversation-tools');
    const owner = client();
    await owner('POST', '/v1/host/openwop-app/test/login', { email: 'owner2@test.dev' });
    const created = await owner('POST', '/v1/host/openwop-app/chat/sessions', { title: 'Private' });
    const sid = created.body.sessionId;

    const other = client();
    await other('POST', '/v1/host/openwop-app/test/login', { email: 'intruder@test.dev' });
    const r = await other('GET', SCOPE_PATH(sid));
    expect(r.status).toBe(404); // not 403 — no existence leak
  });

  it('invalid scope shape ⇒ 400', async () => {
    await enable('users'); await enable('conversation-tools');
    const c = client();
    await c('POST', '/v1/host/openwop-app/test/login', { email: 'val@test.dev' });
    const created = await c('POST', '/v1/host/openwop-app/chat/sessions', { title: 'V' });
    const sid = created.body.sessionId;
    const r = await c('PUT', SCOPE_PATH(sid), { scope: { mode: 'bogus' } });
    expect(r.status).toBe(400);
  });

  it('resolve a per-tool approval (approved)', async () => {
    await enable('users'); await enable('conversation-tools');
    const c = client();
    await c('POST', '/v1/host/openwop-app/test/login', { email: 'appr@test.dev' });
    const created = await c('POST', '/v1/host/openwop-app/chat/sessions', { title: 'A' });
    const sid = created.body.sessionId;
    const r = await c('POST', `/v1/host/openwop-app/conversation-tools/sessions/${sid}/approvals/email.send`, { decision: 'approved' });
    expect(r.status).toBe(200);
    expect(r.body.approval).toMatchObject({ toolName: 'email.send', status: 'approved' });
    const get = await c('GET', SCOPE_PATH(sid));
    expect(get.body.approvals).toEqual([expect.objectContaining({ toolName: 'email.send', status: 'approved' })]);
  });
});
