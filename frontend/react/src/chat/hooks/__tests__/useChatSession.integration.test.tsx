import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RunEventDoc } from '@openwop/openwop';

/**
 * Integration harness for useChatSession's run lifecycle (frontend
 * enterprise-review chat decomposition). It mocks the dispatch + SSE clients
 * (createRun / subscribeToRun / write-through), drives RunEventDoc events
 * through the captured onEvent, and asserts on the resulting session state.
 *
 * This is the prerequisite that makes the SSE `runSubscription` safe to extract
 * later: the send → subscribe → stream → finalize / cancel path is now pinned
 * by tests before any refactor touches it.
 */

// --- captured SSE handler + dispatch mocks -------------------------------
interface SubOpts {
  onEvent: (ev: RunEventDoc) => void | Promise<void>;
  onTimeout?: (kind: 'idle' | 'absolute') => void;
  onError?: (err: unknown) => void;
}
interface Captured extends SubOpts { runId: string; sub: { close: () => void } }
let captured: Captured | null = null;
let subscribeCount = 0;
const closeSpy = vi.fn();

vi.mock('../../../client/streamsClient.js', () => ({
  subscribeToRun: (runId: string, opts: SubOpts) => {
    subscribeCount += 1;
    // Distinct object per call so the hook's identity guard (only the live
    // registration self-heals) can tell re-subscriptions apart.
    const sub = { close: closeSpy };
    captured = { runId, onEvent: opts.onEvent, onTimeout: opts.onTimeout, onError: opts.onError, sub };
    return sub;
  },
}));
vi.mock('../../../client/runsClient.js', () => ({
  createRun: vi.fn(() => Promise.resolve({ runId: 'run-1' })),
  cancelRun: vi.fn(() => Promise.resolve()),
  getRun: vi.fn(() => Promise.resolve({ status: 'running' })),
  // The reconcile backfill (workflowRunSubscription) re-polls the log on
  // node.interrupt.resolved / run.completed. Empty log → a no-op union.
  pollEvents: vi.fn(() => Promise.resolve({ events: [], isComplete: true })),
  getSdkClient: vi.fn(),
}));
vi.mock('../../../client/interruptsClient.js', () => ({
  listOpenInterrupts: vi.fn(() => Promise.resolve([])),
  resolveByRun: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../client/chatSessionsClient.js', () => ({
  createChatSession: vi.fn(() => Promise.resolve()),
  appendChatMessage: vi.fn(() => Promise.resolve()),
  listChatSessionMessages: vi.fn(() => Promise.resolve([])),
  listChatSessionMessagesPage: vi.fn(() => Promise.resolve({ messages: [], nextCursor: null })),
  setConversationRun: vi.fn(() => Promise.resolve()),
  updateChatMessage: vi.fn(() => Promise.resolve()),
  getSessionFeedback: vi.fn(() => Promise.resolve({})),
}));

// ADR 0067 Phase 6: the conversation transport is the SOLE chat path. Stub the
// network seam (open / exchange / tail) but keep the real pure mappers
// (turnsToBubbles, streamDeltaFromEvent, …) so the hook's wire-reconstruction is
// exercised, not mocked away.
// `vi.hoisted` so the factory below (hoisted above imports) can reference these
// eagerly as property values — a plain `const` would not be initialized yet.
const { openConversationSessionMock, sendConversationTurnMock, fetchTurnsMock } = vi.hoisted(() => ({
  openConversationSessionMock: vi.fn(() => Promise.resolve({ runId: 'conv-run-1', nodeId: 'gate' })),
  sendConversationTurnMock: vi.fn(() => Promise.resolve({ turns: [], lastSeq: 1 })),
  fetchTurnsMock: vi.fn(() => Promise.resolve({ turns: [], lastSeq: 0 })),
}));
vi.mock('../../conversationTransport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../conversationTransport.js')>();
  return {
    ...actual,
    openConversationSession: openConversationSessionMock,
    sendConversationTurn: sendConversationTurnMock,
    fetchTurns: fetchTurnsMock,
  };
});

import { useChatSession } from '../useChatSession.js';
import { createRun, cancelRun, pollEvents } from '../../../client/runsClient.js';
import { listOpenInterrupts } from '../../../client/interruptsClient.js';
import { createChatSession, appendChatMessage, listChatSessionMessagesPage, updateChatMessage, getSessionFeedback } from '../../../client/chatSessionsClient.js';
import { openConversationSession, sendConversationTurn } from '../../conversationTransport.js';

const CONFIG = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' };

let seq = 0;
function evt(type: string, payload: unknown): RunEventDoc {
  seq += 1;
  return { eventId: `e${seq}`, runId: 'run-1', type, payload, timestamp: '2026-01-01T00:00:00Z', sequence: seq };
}

beforeEach(() => {
  localStorage.clear();
  captured = null;
  subscribeCount = 0;
  seq = 0;
  closeSpy.mockClear();
  vi.mocked(pollEvents).mockClear();
  vi.mocked(pollEvents).mockResolvedValue({ events: [], isComplete: true });
  vi.mocked(createRun).mockClear();
  vi.mocked(cancelRun).mockClear();
  openConversationSessionMock.mockClear();
  sendConversationTurnMock.mockClear();
  // Default = a realistic SYNCHRONOUS exchange: the reply's authoritative agent
  // turn is on the wire. The hook now classifies sync-vs-async by the presence of
  // a new agent turn (not `lastSeq > cursor`), so an exchange MUST carry its agent
  // turn to take the synchronous reconcile path; an empty-turns result is the
  // async-ack case and waits for the SSE settle signal.
  sendConversationTurnMock.mockResolvedValue({
    turns: [
      { messageId: 'c:1:user', role: 'user', turnIndex: 1, from: 'user', content: 'hi', ts: 0 },
      { messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'assistant', content: 'ok', ts: 0 },
    ],
    lastSeq: 2,
  });
  fetchTurnsMock.mockClear();
  vi.mocked(createChatSession).mockClear();
  vi.mocked(appendChatMessage).mockClear();
});

describe('useChatSession conversation send lifecycle (integration)', () => {
  // ADR 0067 Phase 6: send() is the conversation primitive only. The per-turn
  // `openwop-app.chat.turn` send + SSE lifecycle was retired; its hook-level
  // coverage is replaced by these conversation-path tests. (The createRun + SSE
  // run machinery is still pinned by the `workflow_run lifecycle` block below,
  // which the unchanged @mention path exercises.)
  it('send() opens a conversation lazily and exchanges the turn', async () => {
    // Each exchange must carry its authoritative agent turn (with a DISTINCT
    // messageId per send) so both stay on the synchronous reconcile path — an
    // exchange with no new agent turn triggers the async settle-wait, which has no
    // stream signal in this harness.
    sendConversationTurnMock
      .mockResolvedValueOnce({ turns: [
        { messageId: 'c:1:user', role: 'user', turnIndex: 1, from: 'user', content: 'hello', ts: 0 },
        { messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'assistant', content: 'hi', ts: 0 },
      ], lastSeq: 2 } as never)
      .mockResolvedValueOnce({ turns: [
        { messageId: 'c:3:user', role: 'user', turnIndex: 3, from: 'user', content: 'again', ts: 0 },
        { messageId: 'c:4:agent', role: 'agent', turnIndex: 4, from: 'assistant', content: 'sure', ts: 0 },
      ], lastSeq: 4 } as never);
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.send('hello', CONFIG); });

    // Lazy-opened ONE conversation run, persisted its id, and exchanged once.
    expect(openConversationSessionMock).toHaveBeenCalledOnce();
    expect(sendConversationTurnMock).toHaveBeenCalledOnce();
    expect(result.current.session.conversationRunId).toBe('conv-run-1');
    expect(result.current.isSending).toBe(false);

    // A SECOND send reuses the open run (no re-open).
    await act(async () => { await result.current.send('again', CONFIG); });
    expect(openConversationSessionMock).toHaveBeenCalledOnce();
    expect(sendConversationTurnMock).toHaveBeenCalledTimes(2);
  });

  it('rebuilds the thread from the wire turns the exchange returns', async () => {
    sendConversationTurnMock.mockResolvedValueOnce({
      turns: [
        { messageId: 'c:1:user', role: 'user', turnIndex: 1, from: 'user', content: 'hi', ts: 0 },
        { messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'assistant', content: 'hello back', ts: 0 },
      ],
      lastSeq: 2,
    } as never);
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.send('hi', CONFIG); });

    const msgs = result.current.session.messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs.find((m) => m.role === 'assistant')?.content).toBe('hello back');
    expect(result.current.isSending).toBe(false);
  });

  it('persists conversation turns to the durable store so a later open restores them (blank-history regression)', async () => {
    // Without this the conversation primitive lived only in the run event log +
    // localStorage; reopening a past chat from the rail (loadSessionFromBackend,
    // which reads the chat-message store) showed BLANK history.
    sendConversationTurnMock.mockResolvedValueOnce({
      turns: [
        { messageId: 'c:1:user', role: 'user', turnIndex: 1, from: 'user', content: 'hi', ts: 0 },
        { messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'assistant', content: 'hello back', ts: 0 },
      ],
      lastSeq: 2,
    } as never);
    const { result } = renderHook(() => useChatSession());
    await act(async () => {
      await result.current.send('hi', CONFIG);
      // The persist runs in a detached async loop (sequential createSession +
      // appends); drain the macrotask queue so both writes land before asserting.
      await new Promise((r) => setTimeout(r, 0));
    });

    // Both turns are written to the durable store with a colon-sanitized id
    // (the wire `c:1:user` fails the store's `/^[A-Za-z0-9_-]{1,64}$/` pattern).
    const appended = vi.mocked(appendChatMessage).mock.calls.map((c) => c[1]);
    expect(appended.map((a) => a.messageId)).toEqual(['c_1_user', 'c_2_agent']);
    expect(appended.map((a) => a.role)).toEqual(['user', 'assistant']);
    // Unified id scheme: the LIVE message ids are the SAME canonical (sanitized)
    // ids as the persisted rows — not the wire `c:1:user` form — so feedback /
    // regenerate / reopen all key on one value (no per-path id duality, no flip).
    expect(result.current.session.messages.map((m) => m.id)).toEqual(['c_1_user', 'c_2_agent']);
  });

  it('switching conversations resets the run + accumulator (no cross-chat contamination)', async () => {
    const { result } = renderHook(() => useChatSession());
    // Chat A: opens conv-run-1 and accumulates A's turns.
    sendConversationTurnMock.mockResolvedValueOnce({ turns: [
      { messageId: 'a:1:user', role: 'user', turnIndex: 1, from: 'user', content: 'A-prompt', ts: 0 },
      { messageId: 'a:2:agent', role: 'agent', turnIndex: 2, from: 'assistant', content: 'A-reply', ts: 0 },
    ], lastSeq: 2 } as never);
    await act(async () => { await result.current.send('A-prompt', CONFIG); });
    expect(openConversationSessionMock).toHaveBeenCalledTimes(1);

    // Switch to a different saved conversation (its own backend history).
    vi.mocked(listChatSessionMessagesPage).mockResolvedValueOnce({
      messages: [{ messageId: 'b_old', role: 'user', content: JSON.stringify({ role: 'user', content: 'B-history', createdAt: '2026-01-01T00:00:00Z' }), createdAt: '2026-01-01T00:00:00Z' }],
      nextCursor: null,
    } as never);
    await act(async () => { await result.current.loadSessionFromBackend('session-B'); });
    expect(result.current.session.messages.map((m) => m.content)).toEqual(['B-history']);

    // Sending in B must open a FRESH run (the prior run ref was dropped) and must
    // NOT merge into A's stale accumulator — otherwise 'A-reply' would leak in.
    sendConversationTurnMock.mockResolvedValueOnce({ turns: [
      { messageId: 'b:1:user', role: 'user', turnIndex: 1, from: 'user', content: 'B-prompt', ts: 0 },
      { messageId: 'b:2:agent', role: 'agent', turnIndex: 2, from: 'assistant', content: 'B-reply', ts: 0 },
    ], lastSeq: 2 } as never);
    await act(async () => { await result.current.send('B-prompt', CONFIG); });
    expect(openConversationSessionMock).toHaveBeenCalledTimes(2); // fresh run for B
    const contents = result.current.session.messages.map((m) => (typeof m.content === 'string' ? m.content : ''));
    expect(contents).toContain('B-reply');
    expect(contents).not.toContain('A-reply'); // no contamination from A's accumulator
  });

  it('recovers from a stale-session 404 by opening a fresh chat (no raw error surfaced)', async () => {
    const { result } = renderHook(() => useChatSession());
    const before = result.current.session.id;
    // The conversation is scoped to a tenant the caller no longer matches (rotated
    // anon session / workspace switch / identity change), so the client surfaces
    // `not_found: chat_session "…" not found.`. The user must NOT be dead-ended on it.
    vi.mocked(listChatSessionMessagesPage).mockRejectedValueOnce(
      new Error('not_found: chat_session "stale-1" not found.'),
    );
    await act(async () => { await result.current.loadSessionFromBackend('stale-1'); });
    expect(result.current.error).toBeNull(); // recovered, not surfaced
    expect(result.current.session.messages).toEqual([]); // a fresh empty chat
    expect(result.current.session.id).not.toBe('stale-1'); // not the dead id
    expect(result.current.session.id).not.toBe(before);

    // A non-404 load error is still surfaced (transient — the user should know).
    vi.mocked(listChatSessionMessagesPage).mockRejectedValueOnce(new Error('http_error: HTTP 500'));
    await act(async () => { await result.current.loadSessionFromBackend('sess-Z'); });
    expect(result.current.error).toBe('http_error: HTTP 500');
  });

  it('restores the server-side conversationRunId on load and reuses the run on continue', async () => {
    const { result } = renderHook(() => useChatSession());
    // The reopened chat reports its backing conversation run id.
    vi.mocked(listChatSessionMessagesPage).mockResolvedValueOnce({
      messages: [{ messageId: 'm1', role: 'user', content: JSON.stringify({ role: 'user', content: 'earlier', createdAt: '2026-01-01T00:00:00Z' }), createdAt: '2026-01-01T00:00:00Z' }],
      nextCursor: null,
      conversationRunId: 'conv-run-restored',
    } as never);
    await act(async () => { await result.current.loadSessionFromBackend('sess-X'); });
    expect(result.current.session.conversationRunId).toBe('conv-run-restored');

    // Continuing the reopened chat REUSES the restored run (hydrates from it) —
    // it must NOT open a fresh run (which would orphan the old + lose context).
    sendConversationTurnMock.mockResolvedValueOnce({ turns: [
      { messageId: 'x:3:user', role: 'user', turnIndex: 3, from: 'user', content: 'more', ts: 0 },
      { messageId: 'x:4:agent', role: 'agent', turnIndex: 4, from: 'assistant', content: 'continued', ts: 0 },
    ], lastSeq: 4 } as never);
    await act(async () => { await result.current.send('more', CONFIG); });
    expect(openConversationSessionMock).not.toHaveBeenCalled();
    expect(result.current.session.messages.find((m) => m.role === 'assistant')?.content).toBe('continued');
    // No id-flip on reopen+send: every id is the canonical (colon-free) scheme,
    // never the raw wire `x:4:agent` form — so feedback/regenerate stay stable.
    expect(result.current.session.messages.every((m) => !m.id.includes(':'))).toBe(true);
  });

  it('regenerate ("Try again") re-sends the prior prompt as a fresh APPENDED exchange (not a slice/replace)', async () => {
    sendConversationTurnMock
      .mockResolvedValueOnce({ turns: [
        { messageId: 'r:1:user', role: 'user', turnIndex: 1, from: 'user', content: 'q', ts: 0 },
        { messageId: 'r:2:agent', role: 'agent', turnIndex: 2, from: 'assistant', content: 'first answer', ts: 0 },
      ], lastSeq: 2 } as never)
      .mockResolvedValueOnce({ turns: [
        { messageId: 'r:3:user', role: 'user', turnIndex: 3, from: 'user', content: 'q', ts: 0 },
        { messageId: 'r:4:agent', role: 'agent', turnIndex: 4, from: 'assistant', content: 'second answer', ts: 0 },
      ], lastSeq: 4 } as never);
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.send('q', CONFIG); });
    const assistantId = result.current.session.messages.find((m) => m.role === 'assistant')!.id;

    await act(async () => { await result.current.regenerate(assistantId, CONFIG); });
    expect(sendConversationTurnMock).toHaveBeenCalledTimes(2); // re-sent
    const contents = result.current.session.messages.map((m) => m.content);
    // Append, not replace: the original answer is PRESERVED alongside the retry.
    expect(contents).toContain('first answer');
    expect(contents).toContain('second answer');
  });

  it('restores the caller feedback onto messages on reopen (ADR 0102 Phase 3)', async () => {
    vi.mocked(listChatSessionMessagesPage).mockResolvedValueOnce({
      messages: [{ messageId: 'a1', role: 'assistant', content: JSON.stringify({ role: 'assistant', content: 'hi', createdAt: '2026-01-01T00:00:00Z' }), createdAt: '2026-01-01T00:00:00Z' }],
      nextCursor: null,
    } as never);
    vi.mocked(getSessionFeedback).mockResolvedValueOnce({ a1: 'up' } as never);
    const { result } = renderHook(() => useChatSession());
    await act(async () => {
      await result.current.loadSessionFromBackend('sess-fb');
      await new Promise((r) => setTimeout(r, 0)); // let the feedback merge land
    });
    // The 👍 set in a prior session is re-displayed on the restored message.
    expect(result.current.session.messages.find((m) => m.id === 'a1')?.feedback).toBe('positive');
  });

  it('async exchange (post-ack) settles on the SSE agent signal, then tails the wire (ADR 0079 Phase 3)', async () => {
    // A non-advancing lastSeq means the POST acked before the reply was emitted
    // (it rides the SSE past the CDN ceiling). The hook waits for the stream's
    // `conversation.exchanged`(role:agent) settle signal, then refetches + merges.
    sendConversationTurnMock.mockResolvedValueOnce({ turns: [], lastSeq: 0 } as never);
    fetchTurnsMock.mockResolvedValueOnce({
      turns: [{ messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'assistant', content: 'async reply', ts: 0 }],
      lastSeq: 2,
    } as never);
    const { result } = renderHook(() => useChatSession());
    await act(async () => {
      const p = result.current.send('hi', CONFIG);
      // Let the open + exchange microtasks flush so the run SSE is subscribed.
      for (let i = 0; i < 30 && !captured; i += 1) await Promise.resolve();
      await captured!.onEvent(evt('conversation.exchanged', { turn: { role: 'agent' } }));
      await p;
    });

    expect(result.current.session.messages.find((m) => m.role === 'assistant')?.content).toBe('async reply');
    expect(result.current.isSending).toBe(false);
  });

  it('async exchange whose chunks ALREADY advanced the seq is not mis-read as a dropped sync turn (board-cadence regression)', async () => {
    // Regression for the board-of-advisors persistence bug: under the async
    // exchange path the POST acks before the reply, but transient
    // `ai.message.chunk` deltas have already bumped lastSeq PAST the cursor. The
    // old `lastSeq > cursor` heuristic mis-read that as a completed sync turn,
    // merged an EMPTY turn set, and advanced the cursor past the chunks — silently
    // dropping the advisor's reply. The fix keys on a real new agent turn, so this
    // must still settle on the SSE signal and tail the authoritative reply.
    sendConversationTurnMock.mockResolvedValueOnce({ turns: [], lastSeq: 7 } as never);
    fetchTurnsMock.mockResolvedValueOnce({
      turns: [{ messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'assistant', content: 'advisor reply', ts: 0 }],
      lastSeq: 9,
    } as never);
    const { result } = renderHook(() => useChatSession());
    await act(async () => {
      const p = result.current.send('what is our top priority?', CONFIG);
      for (let i = 0; i < 30 && !captured; i += 1) await Promise.resolve();
      await captured!.onEvent(evt('conversation.exchanged', { turn: { role: 'agent' } }));
      await p;
    });

    expect(result.current.session.messages.find((m) => m.role === 'assistant')?.content).toBe('advisor reply');
    expect(result.current.isSending).toBe(false);
  });

  it('a failed exchange keeps the user message and appends a classified error bubble', async () => {
    sendConversationTurnMock.mockRejectedValueOnce(
      Object.assign(new Error('no key'), { code: 'credential_unavailable' }),
    );
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.send('hi', CONFIG); });

    const msgs = result.current.session.messages;
    // The optimistic user turn survives; the dangling "thinking" bubble is
    // replaced by an error bubble carrying the wire code (ErrorCard classifies it).
    expect(msgs.some((m) => m.role === 'user' && m.content === 'hi')).toBe(true);
    const err = msgs.find((m) => m.role === 'assistant');
    expect(err?.meta?.error?.code).toBe('credential_unavailable');
    expect(result.current.isSending).toBe(false);
  });
});

const MENTION = {
  displayName: 'Uppercase', slug: 'uppercase', description: 'Uppercase the text',
  toolName: 'uppercase', workflowId: 'openwop-app.uppercase',
};

describe('useChatSession workflow_run lifecycle (integration)', () => {
  const wfRun = (result: { current: { session: { messages: Array<{ role: string; id: string; workflowRun?: unknown }> } } }) =>
    result.current.session.messages.find((m) => m.role === 'workflow_run');

  it('runWorkflowMention creates a workflow_run bubble, dispatches, and subscribes', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.runWorkflowMention(MENTION, 'hi there'); });

    const run = wfRun(result) as { workflowRun?: { status?: string; runId?: string } } | undefined;
    expect(run).toBeTruthy();
    expect(run?.workflowRun?.status).toBe('running');
    expect(run?.workflowRun?.runId).toBe('run-1');
    expect(vi.mocked(createRun)).toHaveBeenCalledOnce();
    expect(captured?.runId).toBe('run-1');
  });

  it('node.started/completed update the workflow_run progress', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.runWorkflowMention(MENTION); });

    await act(async () => {
      await captured!.onEvent(evt('node.started', { nodeId: 'upper_0' }));
    });
    let run = wfRun(result) as { workflowRun?: { runningNodeIds?: string[]; currentNodeName?: string } };
    expect(run.workflowRun?.runningNodeIds).toContain('upper_0');

    await act(async () => {
      await captured!.onEvent(evt('node.completed', { nodeId: 'upper_0', outputs: { text: 'HI' } }));
    });
    run = wfRun(result) as { workflowRun?: { completedNodeIds?: string[]; runningNodeIds?: string[] } };
    expect(run.workflowRun?.completedNodeIds).toContain('upper_0');
    expect(run.workflowRun?.runningNodeIds ?? []).not.toContain('upper_0');
  });

  it('run.completed marks the workflow_run completed and closes its subscription', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.runWorkflowMention(MENTION); });
    await act(async () => { await captured!.onEvent(evt('run.completed', { output: { text: 'HI' } })); });

    const run = wfRun(result) as { workflowRun?: { status?: string } };
    expect(run.workflowRun?.status).toBe('completed');
    expect(closeSpy).toHaveBeenCalled();
  });

  it('persists the workflow_run message at dispatch AND on HITL suspend (survives reopen)', async () => {
    vi.mocked(appendChatMessage).mockClear();
    vi.mocked(updateChatMessage).mockClear();
    const { result } = renderHook(() => useChatSession());
    await act(async () => {
      await result.current.runWorkflowMention(MENTION);
      await new Promise((r) => setTimeout(r, 0)); // let the dispatch upsert land
    });
    // Dispatch persisted the running snapshot (append), not just the user prompt —
    // so even a mid-run reopen has the card.
    expect(vi.mocked(appendChatMessage).mock.calls.some((c) => c[1].role === 'workflow_run')).toBe(true);

    // The run suspends at a HITL gate with an open interrupt.
    vi.mocked(listOpenInterrupts).mockResolvedValueOnce([
      { interruptId: 'i1', runId: 'run-1', nodeId: 'gate_1', kind: 'approval', createdAt: '2026-01-01T00:00:00Z' },
    ] as never);
    await act(async () => {
      await captured!.onEvent(evt('node.suspended', { nodeId: 'gate_1' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    // The SUSPENDED snapshot is durably re-saved WITH the HITL interrupt, so
    // reopening restores the card + the gate, not just the prompt (the reported
    // bug). Assert the gate reached the store, regardless of append-vs-update path
    // (in production a re-append 409s and the upsert falls back to PUT; the mock
    // append resolves, so either path carries the same content).
    const persistedContents = [
      ...vi.mocked(appendChatMessage).mock.calls.map((c) => c[1].content),
      ...vi.mocked(updateChatMessage).mock.calls.map((c) => c[2].content),
    ];
    expect(persistedContents.some((c) => c?.includes('gate_1'))).toBe(true);
  });

  it('re-subscribes (live) to a non-terminal workflow_run when a chat is reopened from the rail', async () => {
    const { result } = renderHook(() => useChatSession());
    const before = subscribeCount;
    // Reopen a saved chat whose persisted thread holds a SUSPENDED workflow_run.
    vi.mocked(listChatSessionMessagesPage).mockResolvedValueOnce({
      messages: [{
        messageId: 'wf_x', role: 'workflow_run', createdAt: '2026-01-01T00:00:00Z',
        content: JSON.stringify({
          role: 'workflow_run', content: '/x', createdAt: '2026-01-01T00:00:00Z',
          workflowRun: { slug: 'x', runId: 'run-9', status: 'running', completedNodeIds: [], failedNodeIds: [], nodeOutputs: {}, nodeNames: {}, totalNodes: 1, startedAt: '2026-01-01T00:00:00Z' },
        }),
      }],
      nextCursor: null,
    } as never);
    await act(async () => {
      await result.current.loadSessionFromBackend('sess-wf');
      await new Promise((r) => setTimeout(r, 0)); // let reconcile + re-subscribe fire
    });
    // The reopened run re-attached to live streaming — not frozen at the snapshot.
    expect(subscribeCount).toBeGreaterThan(before);
    expect(captured?.runId).toBe('run-9');
  });

  it('run.completed backfills node.completed events the live stream skipped', async () => {
    // Regression: a HITL run whose stream dropped/reconnected across a
    // suspend would freeze the step list at its pre-suspend snapshot even
    // after the run finished. The terminal reconcile re-polls the now-
    // complete log and union-merges the missed completions back in.
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.runWorkflowMention(MENTION); });

    // Live stream delivered upper_0 but never delivered gate_1 (gap).
    await act(async () => {
      await captured!.onEvent(evt('node.completed', { nodeId: 'upper_0', outputs: { text: 'HI' } }));
    });

    // Authoritative log carries BOTH nodes.
    vi.mocked(pollEvents).mockResolvedValueOnce({
      isComplete: true,
      events: [
        evt('node.completed', { nodeId: 'upper_0', outputs: { text: 'HI' } }),
        evt('node.completed', { nodeId: 'gate_1', outputs: { action: 'approve' } }),
        evt('run.completed', { output: {} }),
      ],
    });

    await act(async () => { await captured!.onEvent(evt('run.completed', { output: {} })); });
    // Let the fire-and-forget reconcile (poll → union-merge) settle.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const run = wfRun(result) as { workflowRun?: { status?: string; completedNodeIds?: string[] } };
    expect(run.workflowRun?.status).toBe('completed');
    expect(run.workflowRun?.completedNodeIds).toContain('upper_0');
    // Backfilled from the log even though the stream never delivered it.
    expect(run.workflowRun?.completedNodeIds).toContain('gate_1');
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('a timeout on a still-live run reconciles from the log and re-subscribes (self-heal)', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.runWorkflowMention(MENTION); });
    expect(subscribeCount).toBe(1);
    const firstSub = captured!.sub;

    // The stream idled out during a HITL suspend; meanwhile a node completed.
    // The log is the only place that knows (no SSE event will arrive).
    vi.mocked(pollEvents).mockResolvedValueOnce({
      isComplete: false,
      events: [evt('node.completed', { nodeId: 'gate_1', outputs: { action: 'approve' } })],
    });

    await act(async () => { captured!.onTimeout?.('idle'); await flush(); });

    const run = wfRun(result) as { workflowRun?: { status?: string; completedNodeIds?: string[] } };
    expect(run.workflowRun?.completedNodeIds).toContain('gate_1'); // backfilled
    expect(run.workflowRun?.status).toBe('running');              // not terminal
    expect(subscribeCount).toBe(2);                                // re-subscribed
    expect(captured!.sub).not.toBe(firstSub);                      // a fresh stream
  });

  it('a timeout after the run already ended finalizes from the log without re-subscribing', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.runWorkflowMention(MENTION); });
    expect(subscribeCount).toBe(1);

    // Stream died during a suspend; the run actually completed while it was gone.
    vi.mocked(pollEvents).mockResolvedValueOnce({
      isComplete: true,
      events: [
        evt('node.completed', { nodeId: 'gate_1', outputs: {} }),
        evt('run.completed', { output: {} }),
      ],
    });

    await act(async () => { captured!.onTimeout?.('absolute'); await flush(); });

    const run = wfRun(result) as { workflowRun?: { status?: string; completedNodeIds?: string[] } };
    expect(run.workflowRun?.status).toBe('completed');        // finalized from log
    expect(run.workflowRun?.completedNodeIds).toContain('gate_1');
    expect(closeSpy).toHaveBeenCalled();                      // sub closed
    expect(subscribeCount).toBe(1);                           // did NOT re-subscribe
  });

  it('self-heal stops re-subscribing once the backend is repeatedly unreachable', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.runWorkflowMention(MENTION); });
    // Every reconcile poll fails → backend unreachable (run gone / outage).
    vi.mocked(pollEvents).mockRejectedValue(new Error('network'));

    // Fire more timeouts than the failure budget; each targets the currently
    // registered sub (captured is overwritten on every re-subscribe).
    for (let i = 0; i < 10; i++) {
      await act(async () => { captured!.onTimeout?.('idle'); await flush(); });
    }
    // 1 initial + at most MAX_HEAL_FAILURES (5) heals, then it gives up.
    expect(subscribeCount).toBe(6);
    expect(result.current.session.messages.find((m) => m.role === 'workflow_run')).toBeTruthy();
  });

  it('reset() tears down the run subscription so a self-heal cannot re-subscribe after leaving', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.runWorkflowMention(MENTION); });
    expect(subscribeCount).toBe(1);
    const orphan = captured!;

    // Leave the session.
    await act(async () => { result.current.reset(); });
    expect(closeSpy).toHaveBeenCalled(); // the run sub was closed

    // A timeout that fires on the now-orphaned sub must NOT re-subscribe — the
    // identity guard sees its registry entry was cleared on reset.
    vi.mocked(pollEvents).mockResolvedValueOnce({
      isComplete: false,
      events: [evt('node.completed', { nodeId: 'late_1', outputs: {} })],
    });
    await act(async () => { orphan.onTimeout?.('idle'); await flush(); });
    expect(subscribeCount).toBe(1); // no resurrection
  });

  it('cancelWorkflowRun cancels the run; run.cancelled flips status', async () => {
    const { result } = renderHook(() => useChatSession());
    await act(async () => { await result.current.runWorkflowMention(MENTION); });
    const id = (wfRun(result) as { id: string }).id;

    await act(async () => { await result.current.cancelWorkflowRun(id); });
    expect(vi.mocked(cancelRun)).toHaveBeenCalledWith('run-1', expect.any(String));

    await act(async () => { await captured!.onEvent(evt('run.cancelled', {})); });
    const run = wfRun(result) as { workflowRun?: { status?: string } };
    expect(run.workflowRun?.status).toBe('cancelled');
  });
});

describe('useChatSession ephemeral mode (ADR 0073 — the builder embed)', () => {
  it('persist:false writes NO backend session/messages and NO main-chat localStorage key', async () => {
    localStorage.clear();
    vi.mocked(createChatSession).mockClear();
    vi.mocked(appendChatMessage).mockClear();
    openConversationSessionMock.mockClear();
    const { result } = renderHook(() => useChatSession({ persist: false }));
    await act(async () => { await result.current.send('author me a workflow', CONFIG); });
    // No server-side session record / message append → never appears in the
    // user's conversations rail; the live conversation still dispatched.
    expect(vi.mocked(createChatSession)).not.toHaveBeenCalled();
    expect(vi.mocked(appendChatMessage)).not.toHaveBeenCalled();
    expect(openConversationSessionMock).toHaveBeenCalledOnce();
    // No write to the shared main-chat session key → can't clobber the user's chat.
    expect(localStorage.getItem('openwop-app.chat.session')).toBeNull();
  });
});
