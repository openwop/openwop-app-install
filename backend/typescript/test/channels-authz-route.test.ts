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
 *
 * Sabotage-witnessed (wave 26): `caller()` without the principal fallback, the
 * getChannel / assertChannelManage 404 masks, the owner-only 403, the message
 * and stream membership gates, the agent registry check, the discovery filter +
 * minimal row shape, the private-join mask and the `joined` flag each red a case.
 * Denied writes are asserted to NOT land (roster / name re-read by the owner).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';

const OWNER_KEY = 'ownerkey-aaaaaaaa';
const OTHER_KEY = 'otherkey-bbbbbbbb';
const CH = '/host/openwop-app/channels';

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_API_KEYS = `${OWNER_KEY},${OTHER_KEY}`;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Participant { subjectRef: string; role: 'owner' | 'member' }
interface ChannelDetail {
  conversationId: string;
  viewerIsOwner?: boolean;
  channel?: { name: string };
  participants?: Participant[];
}
interface DiscoveryRow { conversationId: string; joined: boolean; participants?: unknown; ownerUserId?: unknown }
interface Body { channel?: ChannelDetail; channels?: DiscoveryRow[] }

async function call(method: string, path: string, key: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Body) : {} };
}

/** Status of a held SSE stream: read the headers, then abort — never the body,
 *  so a broken gate fails fast instead of hanging the case (and server.close). */
async function streamStatus(path: string, key: string): Promise<number> {
  const ac = new AbortController();
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: ac.signal });
    return res.status;
  } finally {
    ac.abort();
  }
}

const refs = (d: ChannelDetail | undefined): string[] => (d?.participants ?? []).map((p) => p.subjectRef);
const rows = (b: Body): DiscoveryRow[] => b.channels ?? [];

describe('channel management authz (route-level, CHN-1/CHN-2)', () => {
  it('owner (api-key principal) manages; a different principal cannot read or self-add to a private channel', async () => {
    // Owner creates a private channel.
    const created = await call('POST', CH, OWNER_KEY, { name: 'war-room', visibility: 'private' });
    expect(created.status).toBe(201);
    const id = created.body.channel!.conversationId;
    expect(id).toBeTruthy();

    // Owner can read + manage their own channel even as an api-key principal
    // (owner stamped from principalId, req.userId is undefined) — finding #1 guard.
    const ownerGet = await call('GET', `${CH}/${id}`, OWNER_KEY);
    expect(ownerGet.status).toBe(200);
    // ADR 0154 — GET returns a server-computed owner flag the FE gates manage UI on.
    expect(ownerGet.body.channel?.viewerIsOwner).toBe(true);
    expect((await call('PATCH', `${CH}/${id}`, OWNER_KEY, { name: 'war-room-2' })).status).toBe(200);

    // CHN-2: a different principal is 404-masked on read of a private channel.
    expect((await call('GET', `${CH}/${id}`, OTHER_KEY)).status).toBe(404);

    // CHN-1: a different principal cannot self-add (the IDOR), nor manage.
    expect((await call('POST', `${CH}/${id}/members`, OTHER_KEY, { userId: 'bearer:otherkey' })).status).toBe(404);
    expect((await call('PATCH', `${CH}/${id}`, OTHER_KEY, { name: 'hijacked' })).status).toBe(404);
    // ...and neither denied write landed: the roster is still the owner alone,
    // and the name is the owner's rename.
    const after = (await call('GET', `${CH}/${id}`, OWNER_KEY)).body.channel;
    expect(after?.channel?.name).toBe('war-room-2');
    expect((after?.participants ?? []).filter((p) => p.role !== 'owner')).toEqual([]);

    // And the private channel's messages stay unreadable to the other principal.
    expect((await call('GET', `${CH}/${id}/messages`, OTHER_KEY)).status).toBe(403);
    // ADR 0154 FU-6 — the live message stream is membership-gated too (same
    // assertChannelAccess gate as messages/presence → 403 for a non-member).
    expect(await streamStatus(`${CH}/${id}/stream`, OTHER_KEY)).toBe(403);
    // Positive control: the owner's stream opens (so the 403 is the gate, not a dead route).
    expect(await streamStatus(`${CH}/${id}/stream`, OWNER_KEY)).toBe(200);
  });

  it('owner adds/removes an agent member; non-owner cannot; unknown agent 404s (ADR 0154 Phase 4)', async () => {
    getAgentRegistry().register({
      agentId: 'test.helper', persona: 'Helper', modelClass: 'general',
      systemPrompt: 'help', packName: 'test', packVersion: '0', toolAllowlist: [],
    });
    // PRIVATE: both env keys are the tenant's operator credential, i.e. workspace
    // admins, and ADR 0879 D3 makes an admin the manager of last resort for every
    // channel it can SEE. A private room it is not in stays invisible to it (404).
    // The non-owner, non-admin 403 is pinned with real Editors in
    // `adr0879-channels-security.test.ts`.
    const created = await call('POST', CH, OWNER_KEY, { name: 'ai-room', visibility: 'private' });
    const id = created.body.channel!.conversationId;

    // An unknown agent is rejected at add-time (validated against the registry).
    expect((await call('POST', `${CH}/${id}/members`, OWNER_KEY, { agentId: 'no.such.agent' })).status).toBe(404);
    // Another principal cannot add an agent to a private room it cannot see.
    expect((await call('POST', `${CH}/${id}/members`, OTHER_KEY, { agentId: 'test.helper' })).status).toBe(404);
    // The owner adds the registered agent...
    const added = await call('POST', `${CH}/${id}/members`, OWNER_KEY, { agentId: 'test.helper' });
    expect(added.status).toBe(200);
    expect(refs(added.body.channel)).toContain('agent:test.helper');
    // ...and can remove it.
    const removed = await call('DELETE', `${CH}/${id}/agents/test.helper`, OWNER_KEY);
    expect(removed.status).toBe(200);
    expect(refs(removed.body.channel)).not.toContain('agent:test.helper');
  });

  it('a public channel is readable by another principal; an operator key manages it as an admin; non-members are never added', async () => {
    const created = await call('POST', CH, OWNER_KEY, { name: 'town-square', visibility: 'public' });
    const id = created.body.channel!.conversationId;
    // Public read is allowed for another tenant member...
    const otherGet = await call('GET', `${CH}/${id}`, OTHER_KEY);
    expect(otherGet.status).toBe(200);
    // ...but they are NOT the owner (ADR 0154 server-computed flag → read-only UI).
    expect(otherGet.body.channel?.viewerIsOwner).toBe(false);
    // ADR 0879 D3 — the other env key is the tenant's operator credential (a
    // workspace admin), so it manages a public channel it can see; ADR 0879 D4 — but
    // nobody adds an id that is not a member of the workspace (404).
    expect((await call('PATCH', `${CH}/${id}`, OTHER_KEY, { name: 'renamed-by-admin' })).status).toBe(200);
    expect((await call('POST', `${CH}/${id}/members`, OTHER_KEY, { userId: 'intruder' })).status).toBe(404);
    const after = (await call('GET', `${CH}/${id}`, OWNER_KEY)).body.channel;
    expect(after?.channel?.name).toBe('renamed-by-admin');
    expect(refs(after)).not.toContain('user:intruder');
  });

  it('public-channel discovery + self-join; private channels are not discoverable (ADR 0154 FU-4)', async () => {
    const pub = await call('POST', CH, OWNER_KEY, { name: 'townhall', visibility: 'public' });
    const pubId = pub.body.channel!.conversationId;
    const priv = await call('POST', CH, OWNER_KEY, { name: 'secret', visibility: 'private' });
    const privId = priv.body.channel!.conversationId;

    // OTHER discovers the public channel (joined:false) but NOT the private one.
    const disc = rows((await call('GET', CH, OTHER_KEY)).body);
    expect(disc.map((c) => c.conversationId)).toContain(pubId);
    expect(disc.map((c) => c.conversationId)).not.toContain(privId);
    expect(disc.find((c) => c.conversationId === pubId)?.joined).toBe(false);
    // Discovery rows are the MINIMAL shape — no roster/owner leak (H1).
    const pubRow = disc.find((c) => c.conversationId === pubId);
    expect(pubRow?.participants).toBeUndefined();
    expect(pubRow?.ownerUserId).toBeUndefined();

    // OTHER self-joins the public channel and can then read it.
    expect((await call('POST', `${CH}/${pubId}/join`, OTHER_KEY)).status).toBe(200);
    const disc2 = rows((await call('GET', CH, OTHER_KEY)).body);
    expect(disc2.find((c) => c.conversationId === pubId)?.joined).toBe(true);
    expect((await call('GET', `${CH}/${pubId}/messages`, OTHER_KEY)).status).toBe(200);

    // OTHER cannot self-join the private channel (404-masked, no existence leak).
    expect((await call('POST', `${CH}/${privId}/join`, OTHER_KEY)).status).toBe(404);
  });
});
