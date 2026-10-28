/**
 * ADR 0997 D5 — the conversation-search client. It THROWS on a failed request (it
 * used to return `[]`, so the rail showed a broken search as "no matches", CSU-2),
 * passes `truncated` through, and sends the query URL-encoded.
 *
 * What breaks it: a `catch` that swallows the failure again, or dropping
 * `truncated` from the result.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchChatConversations } from '../chatSessionsClient.js';
import { config } from '../config.js';

afterEach(() => { vi.unstubAllGlobals(); });

function stub(body: unknown, status = 200) {
  const m = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', m);
  return m;
}

describe('searchChatConversations', () => {
  it('returns hits and truncated from the route', async () => {
    const m = stub({ hits: [{ conversationId: 'c1', title: 't', snippet: 's', score: 1 }], truncated: true });
    const r = await searchChatConversations('café plan');
    expect(String(m.mock.calls[0]![0])).toBe(`${config.baseUrl}/host/openwop-app/chat/search?q=caf%C3%A9%20plan`);
    expect(r).toEqual({ hits: [{ conversationId: 'c1', title: 't', snippet: 's', score: 1 }], truncated: true });
  });

  it('throws on a failed request instead of reporting no matches', async () => {
    stub({ error: 'internal', message: 'boom' }, 500);
    await expect(searchChatConversations('plan')).rejects.toThrow(/internal/);
  });

  it('does not call the server for a blank query', async () => {
    const m = stub({ hits: [] });
    expect(await searchChatConversations('   ')).toEqual({ hits: [], truncated: false });
    expect(m).not.toHaveBeenCalled();
  });
});
