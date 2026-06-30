/**
 * ADR 0136 Phase 3 — intent-ledger REST (route + RBAC harness).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
}
const T = 'il-tenant';
const u = (conv: string, suffix = ''): string => `/v1/host/openwop-app/intent-ledger/conversations/${conv}${suffix}`;

// A chat session the caller owns (so getConversationMeta yields a visible, owned meta).
async function ownedConversation(c: ReturnType<typeof client>): Promise<string> {
  const r = await c('POST', '/v1/host/openwop-app/chat/sessions', { title: 'L' });
  return r.body.sessionId;
}

describe('intent-ledger routes (ADR 0136, always-on)', () => {
  it('unknown conversation ⇒ 404 (always-on, IDOR-safe — no toggle gate)', async () => {
    const c = client();
    await c('POST', '/v1/host/openwop-app/test/login', { email: 'il-off@test.dev', tenantId: T });
    expect((await c('GET', u('any'))).status).toBe(404);
  });

  it('draft (user goal) → approve → get reflects approved; edit-after-approve 409', async () => {
    const c = client();
    await c('POST', '/v1/host/openwop-app/test/login', { email: 'il-owner@test.dev', tenantId: T });
    const conv = await ownedConversation(c);

    const draft = await c('POST', u(conv, '/draft'), { goal: 'Draft Q3 report', allowed: ['kb.search'], successCriteria: ['report exists'] });
    expect(draft.status).toBe(200);
    expect(draft.body.ledger).toMatchObject({ status: 'draft', proposedBy: 'user', goal: 'Draft Q3 report' });

    const approve = await c('POST', u(conv, '/approve'));
    expect(approve.status).toBe(200);
    expect(approve.body.ledger.status).toBe('approved');

    expect((await c('GET', u(conv))).body.ledger.status).toBe('approved');

    // an approved ledger cannot be edited
    expect((await c('PUT', u(conv), { goal: 'changed' })).status).toBe(409);
  });

  it('draft validation: missing goal + no auto-extract material ⇒ 4xx', async () => {
    const c = client();
    await c('POST', '/v1/host/openwop-app/test/login', { email: 'il-val@test.dev', tenantId: T });
    const conv = await ownedConversation(c);
    const r = await c('POST', u(conv, '/draft'), { lastUserMessage: '', ceiling: [] });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('reckoning is null when the conversation has no stamped mission run', async () => {
    const c = client();
    await c('POST', '/v1/host/openwop-app/test/login', { email: 'il-reck@test.dev', tenantId: T });
    const conv = await ownedConversation(c);
    await c('POST', u(conv, '/draft'), { goal: 'g', allowed: ['kb.search'] });
    await c('POST', u(conv, '/approve'));
    const r = await c('GET', u(conv, '/reckoning'));
    expect(r.status).toBe(200);
    expect(r.body.reckoning).toBeNull(); // approved, but no run has executed/stamped yet
  });

  it('non-owner cannot draft (IDOR/owner gate)', async () => {
    const owner = client();
    await owner('POST', '/v1/host/openwop-app/test/login', { email: 'il-a@test.dev', tenantId: T });
    const conv = await ownedConversation(owner);
    const other = client();
    await other('POST', '/v1/host/openwop-app/test/login', { email: 'il-b@test.dev', tenantId: T });
    const r = await other('POST', u(conv, '/draft'), { goal: 'sneaky' });
    expect([403, 404]).toContain(r.status);
  });
});
