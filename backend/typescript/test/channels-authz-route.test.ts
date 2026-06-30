/**
 * CHN-1 / CHN-2 — channel-management authorization at the HTTP boundary (ADR 0126).
 *
 * Service-level tests can't observe the route's caller-resolution
 * (`req.userId ?? req.principal?.principalId`), which is exactly where the IDOR fix
 * lives. Two API keys map to two distinct `bearer:<prefix>` principals that SHARE the
 * `default` tenant (api-key path sets no req.tenantId), so this exercises a real
 * within-tenant IDOR: one principal must NOT be able to read or self-add to another
 * principal's private channel, and the owner (an api-key principal, so `req.userId` is
 * undefined) MUST still be able to manage — the regression guard for the owner-stamp
 * falling back to the principal id.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';

const OWNER_KEY = 'ownerkey-aaaaaaaa';
const OTHER_KEY = 'otherkey-bbbbbbbb';
const CH = '/v1/host/openwop-app/channels';

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_API_KEYS = `${OWNER_KEY},${OTHER_KEY}`;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function call(method: string, path: string, key: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('channel management authz (route-level, CHN-1/CHN-2)', () => {
  it('owner (api-key principal) manages; a different principal cannot read or self-add to a private channel', async () => {
    // Owner creates a private channel.
    const created = await call('POST', CH, OWNER_KEY, { name: 'war-room', visibility: 'private' });
    expect(created.status).toBe(201);
    const id = created.body.channel.conversationId as string;
    expect(id).toBeTruthy();

    // Owner can read + manage their own channel even as an api-key principal
    // (owner stamped from principalId, req.userId is undefined) — finding #1 guard.
    const ownerGet = await call('GET', `${CH}/${id}`, OWNER_KEY);
    expect(ownerGet.status).toBe(200);
    // ADR 0154 — GET returns a server-computed owner flag the FE gates manage UI on.
    expect(ownerGet.body.channel.viewerIsOwner).toBe(true);
    expect((await call('PATCH', `${CH}/${id}`, OWNER_KEY, { name: 'war-room-2' })).status).toBe(200);

    // CHN-2: a different principal is 404-masked on read of a private channel.
    expect((await call('GET', `${CH}/${id}`, OTHER_KEY)).status).toBe(404);

    // CHN-1: a different principal cannot self-add (the IDOR), nor manage.
    expect((await call('POST', `${CH}/${id}/members`, OTHER_KEY, { userId: 'bearer:otherkey' })).status).toBe(404);
    expect((await call('PATCH', `${CH}/${id}`, OTHER_KEY, { name: 'hijacked' })).status).toBe(404);

    // And the private channel's messages stay unreadable to the other principal.
    expect((await call('GET', `${CH}/${id}/messages`, OTHER_KEY)).status).toBe(403);
    // ADR 0154 FU-6 — the live message stream is membership-gated too (same
    // assertChannelAccess gate as messages/presence → 403 for a non-member).
    expect((await call('GET', `${CH}/${id}/stream`, OTHER_KEY)).status).toBe(403);
  });

  it('owner adds/removes an agent member; non-owner cannot; unknown agent 404s (ADR 0154 Phase 4)', async () => {
    getAgentRegistry().register({
      agentId: 'test.helper', persona: 'Helper', modelClass: 'general',
      systemPrompt: 'help', packName: 'test', packVersion: '0', toolAllowlist: [],
    });
    const created = await call('POST', CH, OWNER_KEY, { name: 'ai-room', visibility: 'public' });
    const id = created.body.channel.conversationId as string;

    // An unknown agent is rejected at add-time (validated against the registry).
    expect((await call('POST', `${CH}/${id}/members`, OWNER_KEY, { agentId: 'no.such.agent' })).status).toBe(404);
    // A non-owner (public member) cannot add an agent.
    expect((await call('POST', `${CH}/${id}/members`, OTHER_KEY, { agentId: 'test.helper' })).status).toBe(403);
    // The owner adds the registered agent...
    const added = await call('POST', `${CH}/${id}/members`, OWNER_KEY, { agentId: 'test.helper' });
    expect(added.status).toBe(200);
    expect((added.body.channel.participants ?? []).map((p: any) => p.subjectRef)).toContain('agent:test.helper');
    // ...and can remove it.
    const removed = await call('DELETE', `${CH}/${id}/agents/test.helper`, OWNER_KEY);
    expect(removed.status).toBe(200);
    expect((removed.body.channel.participants ?? []).map((p: any) => p.subjectRef)).not.toContain('agent:test.helper');
  });

  it('a public channel is readable by another principal but still owner-only to manage', async () => {
    const created = await call('POST', CH, OWNER_KEY, { name: 'town-square', visibility: 'public' });
    const id = created.body.channel.conversationId as string;
    // Public read is allowed for another tenant member...
    const otherGet = await call('GET', `${CH}/${id}`, OTHER_KEY);
    expect(otherGet.status).toBe(200);
    // ...but they are NOT the owner (ADR 0154 server-computed flag → read-only UI).
    expect(otherGet.body.channel.viewerIsOwner).toBe(false);
    // ...but management is still 403 (they can see it, so not masked).
    expect((await call('PATCH', `${CH}/${id}`, OTHER_KEY, { name: 'x' })).status).toBe(403);
    expect((await call('POST', `${CH}/${id}/members`, OTHER_KEY, { userId: 'intruder' })).status).toBe(403);
  });

  it('public-channel discovery + self-join; private channels are not discoverable (ADR 0154 FU-4)', async () => {
    const pub = await call('POST', CH, OWNER_KEY, { name: 'townhall', visibility: 'public' });
    const pubId = pub.body.channel.conversationId as string;
    const priv = await call('POST', CH, OWNER_KEY, { name: 'secret', visibility: 'private' });
    const privId = priv.body.channel.conversationId as string;

    // OTHER discovers the public channel (joined:false) but NOT the private one.
    const disc = (await call('GET', CH, OTHER_KEY)).body.channels as any[];
    expect(disc.map((c) => c.conversationId)).toContain(pubId);
    expect(disc.map((c) => c.conversationId)).not.toContain(privId);
    expect(disc.find((c) => c.conversationId === pubId).joined).toBe(false);
    // Discovery rows are the MINIMAL shape — no roster/owner leak (H1).
    const pubRow = disc.find((c) => c.conversationId === pubId);
    expect(pubRow.participants).toBeUndefined();
    expect(pubRow.ownerUserId).toBeUndefined();

    // OTHER self-joins the public channel and can then read it.
    expect((await call('POST', `${CH}/${pubId}/join`, OTHER_KEY)).status).toBe(200);
    const disc2 = (await call('GET', CH, OTHER_KEY)).body.channels as any[];
    expect(disc2.find((c) => c.conversationId === pubId).joined).toBe(true);
    expect((await call('GET', `${CH}/${pubId}/messages`, OTHER_KEY)).status).toBe(200);

    // OTHER cannot self-join the private channel (404-masked, no existence leak).
    expect((await call('POST', `${CH}/${privId}/join`, OTHER_KEY)).status).toBe(404);
  });
});
