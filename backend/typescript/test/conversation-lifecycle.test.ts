/**
 * ADR 0288 P2 (grade-data CHAT-1) — deleting a conversation via the REAL route
 * cleans every sidecar that previously orphaned: the four host-owned stores
 * (feedback, reactions, read-state, exchange-idem) directly, and the two
 * feature-owned ones through the conversation-lifecycle seam (intent-ledger's
 * per-conversation row point-deleted; comments on the deleted messages pruned).
 * A bystander conversation's sidecars survive untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { setMessageFeedback, listFeedbackForTenant } from '../src/host/messageFeedbackStore.js';
import { addReaction, listReactionsForConversation } from '../src/host/messageReactionsStore.js';
import { setReadMarker, getReadMarker } from '../src/host/conversationReadState.js';
import { claimExchange } from '../src/host/conversationExchangeIdem.js';
import { saveLedger, getLedger } from '../src/features/intent-ledger/ledgerStore.js';
import { createComment, listThread } from '../src/features/comments/commentsService.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';

/** ADR 0659 D1 — `listThread` now answers `null` when the target is absent OR invisible.
 *  Every fixture here creates a real resource and is not testing that gate, so a null is
 *  a genuine failure rather than an expected branch. */
async function listThreadOrFail(...args: Parameters<typeof listThread>): Promise<NonNullable<Awaited<ReturnType<typeof listThread>>>> {
  const rows = await listThread(...args);
  if (rows === null) throw new Error('listThread resolved no target — the fixture did not create it');
  return rows;
}

let BASE: string;
let server: Server;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  if (res.status === 204) return { status: 204, body: undefined as unknown as T };
  return { status: res.status, body: (await res.json()) as T };
}

async function makeConversation(title: string, msgId: string): Promise<{ sessionId: string; tenantId: string }> {
  const r = await jsonFetch<{ sessionId: string; tenantId: string }>('/v1/host/openwop-app/chat/sessions', {
    method: 'POST', body: JSON.stringify({ title }),
  });
  await jsonFetch(`/v1/host/openwop-app/chat/sessions/${r.body.sessionId}/messages`, {
    method: 'POST', body: JSON.stringify({ messageId: msgId, role: 'user', content: 'hello' }),
  });
  return r.body;
}

describe('conversation deletion cleans sidecars (ADR 0288 P2)', () => {
  it('host sidecars cleaned directly; intent-ledger + comments via the seam; bystander intact', async () => {
    const doomed = await makeConversation('Doomed chat', 'msg-doomed-1');
    const keeper = await makeConversation('Keeper chat', 'msg-keeper-1');
    // The create response carries no tenantId; bearer-authed requests have no
    // req.tenantId and this route buckets them under `_anon` (tenantFromReq).
    const T = '_anon';

    // Seed every sidecar for BOTH conversations.
    for (const { sessionId, msg } of [
      { sessionId: doomed.sessionId, msg: 'msg-doomed-1' },
      { sessionId: keeper.sessionId, msg: 'msg-keeper-1' },
    ]) {
      await setMessageFeedback({ tenantId: T, conversationId: sessionId, messageId: msg, subjectRef: 'user:u1', rating: 'up' });
      await addReaction({ tenantId: T, conversationId: sessionId, messageId: msg, subjectRef: 'user:u1', emoji: '👍' });
      await setReadMarker(T, sessionId, 'user:u1', new Date().toISOString());
      await claimExchange(T, sessionId, `ex-${msg}`, Date.now());
      await saveLedger({
        ledgerId: `led-${sessionId}`, tenantId: T, conversationId: sessionId, goal: 'demo mission',
        allowed: [], forbidden: [], requireApproval: [], successCriteria: [], status: 'draft', proposedBy: 'extractor',
        createdAt: new Date().toISOString(),
      });
      await createComment({ tenantId: T, orgId: 'org-1', resourceType: 'chat_message', resourceId: `${sessionId}#${msg}`, body: 'a note', authorId: 'u1' , caller: { subject: 'u1' }});
    }

    const del = await jsonFetch(`/v1/host/openwop-app/chat/sessions/${doomed.sessionId}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    // Host sidecars: gone for doomed, intact for keeper.
    const feedback = await listFeedbackForTenant(T);
    expect(feedback.some((f) => f.conversationId === doomed.sessionId)).toBe(false);
    expect(feedback.some((f) => f.conversationId === keeper.sessionId)).toBe(true);
    expect((await listReactionsForConversation(T, doomed.sessionId)).size).toBe(0);
    expect((await listReactionsForConversation(T, keeper.sessionId)).size).toBe(1);
    expect(await getReadMarker(T, doomed.sessionId, 'user:u1')).toBeNull();
    expect(await getReadMarker(T, keeper.sessionId, 'user:u1')).not.toBeNull();

    // Feature sidecars via the seam.
    expect(await getLedger(T, doomed.sessionId)).toBeNull();
    expect(await getLedger(T, keeper.sessionId)).not.toBeNull();
    // ADR 0659 D1 — the conversation is gone, so its thread does not resolve at all.
    // Stronger than the old empty-list assertion: it proves the TARGET died, not just the rows.
    expect(await listThread(T, 'org-1', 'chat_message', `${doomed.sessionId}#msg-doomed-1`, PREAUTHORIZED_CALLER)).toBeNull();
    expect(await listThreadOrFail(T, 'org-1', 'chat_message', `${keeper.sessionId}#msg-keeper-1`, PREAUTHORIZED_CALLER)).toHaveLength(1);
  });
});
