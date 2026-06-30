/**
 * ADR 0154 Phase 2 — channel management client wrappers: assert each hits the
 * right route + method + body (the owner-only gate is enforced server-side).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renameChannel, archiveChannel, addChannelMember, removeChannelMember, getChannel } from '../channelsClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('channels management client', () => {
  it('renameChannel PATCHes the channel with the new name', async () => {
    const m = vi.fn(async () => jsonRes({ channel: { conversationId: 'c1', channel: { name: 'x', visibility: 'public' } } }));
    vi.stubGlobal('fetch', m);
    const r = await renameChannel('c1', 'x');
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toContain('/channels/c1');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'x' });
    expect(r.conversationId).toBe('c1');
  });

  it('archiveChannel POSTs to /archive', async () => {
    const m = vi.fn(async () => jsonRes({}));
    vi.stubGlobal('fetch', m);
    await archiveChannel('c1');
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toContain('/channels/c1/archive');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('addChannelMember POSTs the userId to /members', async () => {
    const m = vi.fn(async () => jsonRes({ channel: { conversationId: 'c1' } }));
    vi.stubGlobal('fetch', m);
    await addChannelMember('c1', 'u2');
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toContain('/channels/c1/members');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ userId: 'u2' });
  });

  it('removeChannelMember DELETEs /members/:userId', async () => {
    const m = vi.fn(async () => jsonRes({ channel: { conversationId: 'c1' } }));
    vi.stubGlobal('fetch', m);
    await removeChannelMember('c1', 'u2');
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toContain('/channels/c1/members/u2');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('getChannel GETs the channel meta', async () => {
    const m = vi.fn(async () => jsonRes({ channel: { conversationId: 'c1', participants: [] } }));
    vi.stubGlobal('fetch', m);
    const d = await getChannel('c1');
    const [url] = m.mock.calls[0]!;
    expect(String(url)).toContain('/channels/c1');
    expect(d.conversationId).toBe('c1');
  });
});
