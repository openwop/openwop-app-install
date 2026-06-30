/**
 * Digital twin — Phase 1 (ADR 0044) ROUTE harness. Boots the real app and drives
 * the link + consent-grant surface:
 *   - toggle gating (404 when `twin-recall` is off)
 *   - admin links an agent to a user (workspace:write + tenant IDOR); a viewer can't
 *   - ONLY the linked user can grant/revoke (a non-linked caller is 404, fail-closed)
 *   - grant → visible to the user + on the agent link; revoke → gone
 *   - unlink revokes the grant
 *
 * Phase 1 has NO cross-subject recall — this proves only the authorization layer.
 *
 * @see docs/adr/0044-twin-cross-subject-recall.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { resolveBorrowedRecall } from '../src/features/twin/borrowedRecall.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'twin-recall']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
const enable = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

/** Owner (admin) + a member (the prospective twin) in one tenant, + a standing agent. */
async function ownerMemberAgent(role = 'editor'): Promise<{ owner: Client; member: Client; memberId: string; rosterId: string; tenantId: string }> {
  const tenantId = `org:tw-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('tw-owner'), tenantId });
  const member = client();
  const m = await member.post('/v1/host/openwop-app/test/login', { email: uniqEmail('tw-member'), tenantId });
  const r = await owner.post('/v1/host/openwop-app/roster', { persona: 'Aide', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(org.body.orgId)}/members`, { displayName: 'M', subject: m.body.user.userId, roles: [role] });
  return { owner, member, memberId: m.body.user.userId, rosterId: r.body.rosterId, tenantId };
}

const twin = (id: string): string => `/v1/host/openwop-app/agents/${encodeURIComponent(id)}/twin`;
const GRANTS = '/v1/host/openwop-app/profiles/me/twin-grants';

describe('twin — toggle gating', () => {
  it('404s when twin-recall is off', async () => {
    await enable('twin-recall', 'off');
    const { owner, rosterId } = await ownerMemberAgent();
    expect((await owner.get(twin(rosterId))).status).toBe(404);
    await enable('twin-recall', 'on');
  });
});

describe('twin — link + grant authority', () => {
  it('admin links; only the linked user can grant; revoke + unlink clear it', async () => {
    const { owner, member, memberId, rosterId } = await ownerMemberAgent();

    // Admin links the agent to the member.
    const link = await owner.put(twin(rosterId), { userId: memberId });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect(link.body.link.userId).toBe(memberId);

    // A NON-linked user (the owner) cannot grant for this agent → 404 fail-closed.
    expect((await owner.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(404);

    // The linked member grants → 201, visible to them + on the agent link.
    const g = await member.post(GRANTS, { agentId: rosterId, scopes: ['memory', 'knowledge'] });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect(g.body.grant.scopes).toEqual(['memory', 'knowledge']);
    expect((await member.get(GRANTS)).body.grants.length).toBe(1);
    expect((await owner.get(twin(rosterId))).body.grant.scopes).toEqual(['memory', 'knowledge']);

    // The member revokes → gone from the agent link's active grant.
    expect((await member.del(`${GRANTS}/${encodeURIComponent(rosterId)}`)).status).toBe(204);
    expect((await owner.get(twin(rosterId))).body.grant).toBe(null);

    // Re-grant, then unlink (admin) — unlink must also revoke.
    await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] });
    expect((await owner.del(twin(rosterId))).status).toBe(204);
    expect((await owner.get(twin(rosterId))).body.link).toBe(null);
    expect((await owner.get(twin(rosterId))).body.grant).toBe(null);
  });

  it('a viewer cannot link (403); empty scopes are rejected (400)', async () => {
    const { owner, member, memberId, rosterId } = await ownerMemberAgent('viewer');
    // The viewer member lacks workspace:write → cannot link.
    expect((await member.put(twin(rosterId), { userId: memberId })).status).toBe(403);
    // Owner links; the member grants with empty scopes → 400.
    expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
    expect((await member.post(GRANTS, { agentId: rosterId, scopes: [] })).status).toBe(400);
  });
});

const MEM = '/v1/host/openwop-app/profiles/me/memory';

describe('twin — borrowed recall gate (Phase 2)', () => {
  it('the live gate yields the owner corpus only under toggle + link + active grant', async () => {
    const { owner, member, memberId, rosterId, tenantId } = await ownerMemberAgent();
    // The member (owner of the corpus) records a personal memory.
    await member.post(MEM, { content: 'I always cc finance on vendor contracts.' });

    // No link/grant yet ⇒ the gate is closed.
    expect(await resolveBorrowedRecall(tenantId, rosterId)).toBeUndefined();

    // Admin links + the member grants `memory`.
    expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
    expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);

    // Now the gate opens; the retriever yields the owner's note.
    const retrieve = await resolveBorrowedRecall(tenantId, rosterId);
    expect(retrieve, 'gate should be open under an active grant').toBeDefined();
    const chunks = await retrieve!('vendor contract finance');
    expect(chunks.map((c) => c.content).join(' ')).toContain('cc finance on vendor contracts');

    // Revoke ⇒ the gate closes immediately (live re-check, no stamp — ADR 0044 §4).
    expect((await member.del(`${GRANTS}/${encodeURIComponent(rosterId)}`)).status).toBe(204);
    expect(await resolveBorrowedRecall(tenantId, rosterId)).toBeUndefined();

    // Re-grant, then turn the toggle off ⇒ closed (fail-closed).
    await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] });
    expect(await resolveBorrowedRecall(tenantId, rosterId)).toBeDefined();
    await enable('twin-recall', 'off');
    expect(await resolveBorrowedRecall(tenantId, rosterId)).toBeUndefined();
    await enable('twin-recall', 'on');
  });
});
