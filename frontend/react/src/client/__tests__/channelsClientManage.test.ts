/**
 * ADR 0154 Phase 2 — channel management client wrappers: each hits the EXACT route +
 * method + body and unwraps the `{ channel }` envelope (the owner-only gate is
 * enforced server-side).
 *
 * What breaks it: a wrapper calling a sibling route (`/archive` vs `/archived` — a
 * substring URL check could not tell them apart, w26 probe `fe-archive`), the wrong
 * verb, a body key the route does not read, or returning the raw envelope.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renameChannel, archiveChannel, addChannelMember, removeChannelMember, getChannel } from '../channelsClient.js';
import { config } from '../config.js';

afterEach(() => { vi.unstubAllGlobals(); });

const url = (path: string): string => `${config.baseUrl}/host/openwop-app/channels${path}`;
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function stub(body: unknown, status = 200) {
  const m = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonRes(body, status));
  vi.stubGlobal('fetch', m);
  return m;
}

describe('channels management client', () => {
  it('renameChannel PATCHes the channel with the new name', async () => {
    const m = stub({ channel: { conversationId: 'c1', channel: { name: 'x', visibility: 'public' } } });
    const r = await renameChannel('c1', 'x');
    const [u, init] = m.mock.calls[0]!;
    expect(String(u)).toBe(url('/c1'));
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'x' });
    expect(r.conversationId).toBe('c1');
  });

  it('archiveChannel POSTs to /archive', async () => {
    const m = stub({}, 200);
    await archiveChannel('c1');
    const [u, init] = m.mock.calls[0]!;
    expect(String(u)).toBe(url('/c1/archive'));
    expect(init?.method).toBe('POST');
  });

  it('addChannelMember POSTs the userId to /members', async () => {
    const m = stub({ channel: { conversationId: 'c1' } });
    const r = await addChannelMember('c1', 'u2');
    const [u, init] = m.mock.calls[0]!;
    expect(String(u)).toBe(url('/c1/members'));
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ userId: 'u2' });
    expect(r.conversationId).toBe('c1');
  });

  it('removeChannelMember DELETEs /members/:userId', async () => {
    const m = stub({ channel: { conversationId: 'c1' } });
    const r = await removeChannelMember('c1', 'u2');
    const [u, init] = m.mock.calls[0]!;
    expect(String(u)).toBe(url('/c1/members/u2'));
    expect(init?.method).toBe('DELETE');
    expect(r.conversationId).toBe('c1');
  });

  it('getChannel GETs the channel meta', async () => {
    const m = stub({ channel: { conversationId: 'c1', participants: [] } });
    const d = await getChannel('c1');
    const [u, init] = m.mock.calls[0]!;
    expect(String(u)).toBe(url('/c1'));
    expect(init?.method ?? 'GET').toBe('GET');
    expect(d.conversationId).toBe('c1');
  });
});
