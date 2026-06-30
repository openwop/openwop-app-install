/**
 * ADR 0117 — branchConversation threads fromSeq (per-message branch, Phase 4) and omits
 * it (branch-from-end, Phase 2c). The backend bounds-checks fromSeq.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { branchConversation } from '../../client/chatSessionsClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

function captureFetch() {
  const m = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sessionId: 'child' }) } as unknown as Response));
  vi.stubGlobal('fetch', m);
  return m;
}

describe('branchConversation', () => {
  it('POSTs { fromSeq } when a per-message seq is given (Phase 4)', async () => {
    const m = captureFetch();
    await branchConversation('parent', 5);
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toContain('/chat/sessions/parent/branch');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ fromSeq: 5 });
  });

  it('POSTs {} when no seq (branch-from-end, Phase 2c)', async () => {
    const m = captureFetch();
    await branchConversation('parent');
    expect(JSON.parse((m.mock.calls[0]![1] as RequestInit).body as string)).toEqual({});
  });
});
