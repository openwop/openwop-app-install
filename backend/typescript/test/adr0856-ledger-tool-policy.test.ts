/**
 * ADR 0856 — a team ledger's tool policy narrows the tools agents use in its
 * project's chats, through the ONE gate (`resolveConversationToolGate`).
 *   - the policy is changed only by an owner-accepted delta; it has NO allow
 *     list (any other key is refused); ids are validated and bounded;
 *   - in the project chat and a bound channel: a forbidden tool is removed from
 *     the enabled set, a require-approval tool is gated; nothing outside the
 *     ceiling is ever enabled;
 *   - the narrowing KEEPS applying when the bound project turns private;
 *   - nothing for an unbound conversation or with the toggle off.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { ensureConversationMeta, setConversationCapabilityScope, subjectConversationId } from '../src/host/conversationStore.js';
import { resolveConversationToolGate } from '../src/host/conversationToolScope.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) as any };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
const CEILING = ['openwop:web.search', 'openwop:email.send', 'openwop:docs.read'];
const POLICY = { forbidden: ['openwop:email.send'], requireApproval: ['openwop:web.search'] };

async function setup() {
  const tenantId = `org:tp-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: `tp-${n++}@acme.test`, tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'ToolCo' })).body.orgId as string;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string };
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  expect((await owner.post(L)).status).toBe(201);
  const chat = subjectConversationId(tenantId, { kind: 'project', id: proj.id });
  await ensureConversationMeta(tenantId, chat, { type: 'group', ownerUserId: ownerId, ownerSubject: { kind: 'project', id: proj.id } });
  const ch = await owner.post('/host/openwop-app/channels', { name: `tp-${n++}`, visibility: 'public' });
  const channelId = ch.body.channel.conversationId as string;
  expect((await owner.put(`/host/openwop-app/channels/${channelId}/project`, { projectId: proj.id })).status).toBe(200);
  const loose = (await owner.post('/host/openwop-app/channels', { name: `loose-${n++}`, visibility: 'public' })).body.channel.conversationId as string;
  return { tenantId, owner, projectId: proj.id, L, chat, channelId, loose };
}
const gate = (tenantId: string, conversationKey: string) => resolveConversationToolGate({ tenantId, conversationKey, ceiling: CEILING, approvals: [] });

describe('ADR 0856 — the ledger tool policy', () => {
  it('only an accepted delta sets it; no allow list; ids validated', async () => {
    const s = await setup();
    expect((await s.owner.post(`${s.L}/write`, { patch: { toolPolicy: { ...POLICY, enabled: ['x'] } }, why: 'w', baseVersion: 1 })).status).toBe(400);
    expect((await s.owner.post(`${s.L}/write`, { patch: { toolPolicy: { forbidden: ['bad id!'], requireApproval: [] } }, why: 'w', baseVersion: 1 })).status).toBe(400);
    expect((await s.owner.post(`${s.L}/write`, { patch: { toolPolicy: { forbidden: Array.from({ length: 51 }, (_, i) => `t${i}`), requireApproval: [] } }, why: 'w', baseVersion: 1 })).status).toBe(400);
    expect((await gate(s.tenantId, s.chat)).scope).toBeUndefined(); // nothing yet
    const ok = await s.owner.post(`${s.L}/write`, { patch: { toolPolicy: POLICY }, why: 'keep email out', baseVersion: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
    expect((await s.owner.get(s.L)).body.state.toolPolicy).toEqual(POLICY);
  });

  it('narrows the project chat and a bound channel; never enables beyond the ceiling; nothing for an unbound one', async () => {
    const s = await setup();
    await s.owner.post(`${s.L}/write`, { patch: { toolPolicy: POLICY }, why: 'w', baseVersion: 1 });
    for (const c of [s.chat, s.channelId]) {
      const { scope } = await gate(s.tenantId, c);
      expect(scope, c).toBeDefined();
      expect(scope!.enabled).not.toContain('openwop:email.send');
      expect(scope!.requireApproval).toContain('openwop:web.search');
      expect(scope!.enabled.every((t) => CEILING.includes(t))).toBe(true);
    }
    expect((await gate(s.tenantId, s.loose)).scope).toBeUndefined();
  });

  it("only ADDS to a conversation's own narrowing — never replaces (so never widens) it", async () => {
    const s = await setup();
    await setConversationCapabilityScope(s.tenantId, s.chat, { mode: 'restricted', disabled: ['openwop:docs.read'] });
    await s.owner.post(`${s.L}/write`, { patch: { toolPolicy: POLICY }, why: 'w', baseVersion: 1 });
    const { scope } = await gate(s.tenantId, s.chat);
    expect(scope!.enabled).not.toContain('openwop:docs.read'); // the conversation's own restriction survives
    expect(scope!.enabled).not.toContain('openwop:email.send'); // and the ledger's is added
  });

  it('keeps narrowing after the bound project turns private', async () => {
    const s = await setup();
    await s.owner.post(`${s.L}/write`, { patch: { toolPolicy: POLICY }, why: 'w', baseVersion: 1 });
    expect((await s.owner.patch(`/host/openwop-app/projects/${s.projectId}/visibility`, { visibility: 'private' })).status).toBeLessThan(300);
    expect((await gate(s.tenantId, s.channelId)).scope!.enabled).not.toContain('openwop:email.send');
  });
});
