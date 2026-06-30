/**
 * conversationTransport — turns→bubbles mapping + flag default + the gate-open
 * wait that guards the first turn against the background-dispatch race.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const openConversation = vi.fn();
const listOpenInterrupts = vi.fn();
const getRun = vi.fn();

vi.mock('../conversationClient.js', async (importActual) => ({
  ...(await importActual<typeof import('../conversationClient.js')>()),
  openConversation: (...a: unknown[]) => openConversation(...a),
}));
vi.mock('../../client/interruptsClient.js', () => ({
  listOpenInterrupts: (...a: unknown[]) => listOpenInterrupts(...a),
}));
vi.mock('../../client/runsClient.js', async (importActual) => ({
  ...(await importActual<typeof import('../../client/runsClient.js')>()),
  getRun: (...a: unknown[]) => getRun(...a),
}));

import { turnsToBubbles, openConversationSession, streamDeltaFromEvent, exchangeSettleSignal, exchangeErrorPayload, toolActivityFromEvent, titledFromEvent } from '../conversationTransport.js';
import type { ConversationTurn } from '../conversationClient.js';

const turn = (p: Partial<ConversationTurn> & Pick<ConversationTurn, 'messageId' | 'role' | 'turnIndex' | 'from'>): ConversationTurn => ({
  content: '', ts: 0, ...p,
});

describe('turnsToBubbles', () => {
  it('drops system turns; maps user→user and agent→assistant with wire attribution', () => {
    const bubbles = turnsToBubbles([
      turn({ messageId: 'c:0:system', role: 'system', turnIndex: 0, from: 'system', content: 'opened' }),
      turn({ messageId: 'c:1:user', role: 'user', turnIndex: 1, from: 'user', content: 'hi @devon', to: 'a:devon' }),
      turn({ messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'a:devon', content: 'Hey!', agent: { agentId: 'a:devon' } }),
      turn({ messageId: 'c:3:system', role: 'system', turnIndex: 3, from: 'system', content: 'closed' }),
    ]);
    expect(bubbles).toEqual([
      { id: 'c:1:user', role: 'user', content: 'hi @devon' },
      { id: 'c:2:agent', role: 'assistant', content: 'Hey!', agentPersona: 'a:devon' },
    ]);
  });

  it('omits agentPersona for the default assistant', () => {
    const bubbles = turnsToBubbles([turn({ messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'assistant', content: 'hello' })]);
    expect(bubbles[0]).toEqual({ id: 'c:2:agent', role: 'assistant', content: 'hello' });
  });
});

describe('streamDeltaFromEvent — Phase 2 replay-guard', () => {
  it('returns the chunk for a fresh ai.message.chunk (sequence > startSeq)', () => {
    expect(streamDeltaFromEvent({ type: 'ai.message.chunk', sequence: 5, payload: { chunk: 'hi ' } }, 3)).toBe('hi ');
  });
  it('ignores a REPLAYED delta from a prior turn (sequence <= startSeq)', () => {
    expect(streamDeltaFromEvent({ type: 'ai.message.chunk', sequence: 3, payload: { chunk: 'old' } }, 3)).toBeNull();
    expect(streamDeltaFromEvent({ type: 'ai.message.chunk', sequence: 1, payload: { chunk: 'older' } }, 3)).toBeNull();
  });
  it('ignores non-chunk events and malformed payloads', () => {
    expect(streamDeltaFromEvent({ type: 'conversation.exchanged', sequence: 9, payload: { turn: {} } }, 0)).toBeNull();
    expect(streamDeltaFromEvent({ type: 'ai.message.chunk', sequence: 9, payload: {} }, 0)).toBeNull();
    expect(streamDeltaFromEvent({ type: 'ai.message.chunk', payload: { chunk: 'no-seq' } }, 0)).toBeNull();
  });
});

describe('exchangeSettleSignal — Phase 3 async settle classification', () => {
  it('returns "agent" for a fresh agent conversation.exchanged turn', () => {
    expect(exchangeSettleSignal({ type: 'conversation.exchanged', sequence: 7, payload: { turn: { role: 'agent' } } }, 3)).toBe('agent');
  });
  it('returns "error" for a fresh ai.message.error', () => {
    expect(exchangeSettleSignal({ type: 'ai.message.error', sequence: 7, payload: { message: 'boom' } }, 3)).toBe('error');
  });
  it('ignores the user-turn echo, deltas, and replayed/older events', () => {
    expect(exchangeSettleSignal({ type: 'conversation.exchanged', sequence: 7, payload: { turn: { role: 'user' } } }, 3)).toBeNull();
    expect(exchangeSettleSignal({ type: 'ai.message.chunk', sequence: 7, payload: { chunk: 'hi' } }, 3)).toBeNull();
    expect(exchangeSettleSignal({ type: 'conversation.exchanged', sequence: 3, payload: { turn: { role: 'agent' } } }, 3)).toBeNull();
    expect(exchangeSettleSignal({ type: 'ai.message.error', payload: {} }, 3)).toBeNull();
  });
  it('extracts the error code + message off the terminal event', () => {
    expect(exchangeErrorPayload({ payload: { code: 'credential_unavailable', message: 'no key' } })).toEqual({ code: 'credential_unavailable', message: 'no key' });
    expect(exchangeErrorPayload({ payload: {} })).toEqual({});
    expect(exchangeErrorPayload({})).toEqual({});
  });
});

describe('titledFromEvent — ADR 0151 auto-title', () => {
  it('returns the title for a fresh conversation.titled event', () => {
    expect(titledFromEvent({ type: 'conversation.titled', sequence: 9, payload: { title: 'Refactor Auth' } }, 3)).toBe('Refactor Auth');
  });
  it('ignores other event types, replayed/older events, and empty/malformed titles', () => {
    expect(titledFromEvent({ type: 'ai.message.chunk', sequence: 9, payload: { title: 'x' } }, 3)).toBeNull();
    expect(titledFromEvent({ type: 'conversation.titled', sequence: 3, payload: { title: 'old fold' } }, 3)).toBeNull();
    expect(titledFromEvent({ type: 'conversation.titled', sequence: 9, payload: { title: '' } }, 3)).toBeNull();
    expect(titledFromEvent({ type: 'conversation.titled', sequence: 9, payload: {} }, 3)).toBeNull();
    expect(titledFromEvent({ type: 'conversation.titled', payload: { title: 'no seq' } }, 3)).toBeNull();
  });
});

describe('openConversationSession — waits for the gate before the first turn', () => {
  afterEach(() => { openConversation.mockReset(); listOpenInterrupts.mockReset(); getRun.mockReset(); });

  it('resolves only once the gate interrupt is open (guards the dispatch race)', async () => {
    openConversation.mockResolvedValue({ runId: 'run-1' });
    // First poll: gate not open yet (background dispatch in flight); then it opens.
    listOpenInterrupts
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ interruptId: 'i-gate', nodeId: 'gate', kind: 'conversation' }]);
    getRun.mockResolvedValue({ status: 'running' });

    const { runId, nodeId } = await openConversationSession({});
    expect(runId).toBe('run-1');
    expect(nodeId).toBe('gate');
    expect(listOpenInterrupts.mock.calls.length).toBeGreaterThanOrEqual(2); // it polled, didn't return early
  });

  it('fails fast with a readable error if the run terminates before the gate opens', async () => {
    openConversation.mockResolvedValue({ runId: 'run-2' });
    listOpenInterrupts.mockResolvedValue([]);       // gate never opens
    getRun.mockResolvedValue({ status: 'failed' });  // run died first
    await expect(openConversationSession({})).rejects.toThrow(/could not start \(run failed\)/);
  });
});

describe('toolActivityFromEvent — ADR 0089 Phase 2 tool progress', () => {
  it('maps agent.toolCalled / toolReturned with replay guard', () => {
    expect(toolActivityFromEvent({ type: 'agent.toolCalled', sequence: 5, payload: { callId: 'c1', toolName: 'search', agentId: 'a' } }, 3))
      .toEqual({ kind: 'tool-called', callId: 'c1', toolName: 'search', agentId: 'a' });
    expect(toolActivityFromEvent({ type: 'agent.toolReturned', sequence: 6, payload: { callId: 'c1', toolName: 'search', status: 'ok' } }, 3))
      .toEqual({ kind: 'tool-returned', callId: 'c1', toolName: 'search', status: 'ok' });
    expect(toolActivityFromEvent({ type: 'agent.reasoned', sequence: 4, payload: { agentId: 'a' } }, 3))
      .toEqual({ kind: 'reasoned', agentId: 'a' });
  });
  it('drops replayed (≤ startSeq) and non-tool events', () => {
    expect(toolActivityFromEvent({ type: 'agent.toolCalled', sequence: 3, payload: { callId: 'c1' } }, 3)).toBeNull();
    expect(toolActivityFromEvent({ type: 'ai.message.chunk', sequence: 9, payload: { chunk: 'x' } }, 0)).toBeNull();
    expect(toolActivityFromEvent({ type: 'agent.toolCalled', payload: {} }, 0)).toBeNull();
  });
});
