/**
 * ADR 0117 — branchConversation threads fromSeq (per-message branch, Phase 4) and omits
 * it (branch-from-end, Phase 2c). The backend bounds-checks fromSeq.
 *
 * What breaks it: a wrong method or path (the exact URL is asserted, so `/branches`
 * reds), dropping `fromSeq` from the body, sending a default seq on a
 * branch-from-end (which would fork at the wrong turn), or not returning the child.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { branchConversation } from '../../client/chatSessionsClient.js';
import { config } from '../../client/config.js';

afterEach(() => { vi.unstubAllGlobals(); });

function captureFetch() {
  const m = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ sessionId: 'child' }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', m);
  return m;
}

describe('branchConversation', () => {
  it('POSTs { fromSeq } when a per-message seq is given (Phase 4)', async () => {
    const m = captureFetch();
    const child = await branchConversation('parent', 5);
    expect(m).toHaveBeenCalledTimes(1);
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toBe(`${config.baseUrl}/host/openwop-app/chat/sessions/parent/branch`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ fromSeq: 5 });
    expect(child).toEqual({ sessionId: 'child' });
  });

  it('POSTs {} when no seq (branch-from-end, Phase 2c)', async () => {
    const m = captureFetch();
    await branchConversation('parent');
    const init = m.mock.calls[0]![1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({});
  });
});
