/** ADR 0304 P2 — the pure board-voice turn queue: which turns get spoken, in order. */
import { describe, expect, it } from 'vitest';
import { collectSpeakableTurns } from '../turnQueue.js';
import type { ChatMessage } from '../../types.js';

const msg = (over: Partial<ChatMessage> & { id: string }): ChatMessage => ({
  role: 'assistant',
  content: 'A considered answer.',
  createdAt: '2026-07-06T00:00:00.000Z',
  ...over,
});

describe('collectSpeakableTurns', () => {
  it('collects new settled assistant turns in conversation order, attributed per agent', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '@@growth-board what next?' }),
      msg({ id: 'a1', agentId: 'chair-1', content: 'Framing the question…' }),
      msg({ id: 'a2', agentId: 'advisor-ada' }),
      msg({ id: 'a3', agentId: 'advisor-bo' }),
    ];
    expect(collectSpeakableTurns(messages, new Set())).toEqual([
      { messageId: 'a1', agentId: 'chair-1', text: 'Framing the question…' },
      { messageId: 'a2', agentId: 'advisor-ada', text: 'A considered answer.' },
      { messageId: 'a3', agentId: 'advisor-bo', text: 'A considered answer.' },
    ]);
  });

  it('never re-voices seen turns (the session-start baseline)', () => {
    const messages = [msg({ id: 'a1' }), msg({ id: 'a2' })];
    expect(collectSpeakableTurns(messages, new Set(['a1']))).toEqual([
      { messageId: 'a2', text: 'A considered answer.' },
    ]);
  });

  it('skips streaming, errored, tombstoned, and empty turns', () => {
    const messages = [
      msg({ id: 's1', isStreaming: true }),
      msg({ id: 'e1', meta: { error: { code: 'provider_error', message: 'boom' } } }),
      msg({ id: 'd1', meta: { deletedAt: '2026-07-06T00:00:00.000Z' } }),
      msg({ id: 'w1', content: '   ' }),
      msg({ id: 'ok', agentId: 'advisor-ada' }),
    ];
    expect(collectSpeakableTurns(messages, new Set()).map((t) => t.messageId)).toEqual(['ok']);
  });

  it('an unattributed assistant turn is speakable with no agentId (host default voice)', () => {
    const turns = collectSpeakableTurns([msg({ id: 'a1' })], new Set());
    expect(turns).toHaveLength(1);
    expect(turns[0]).not.toHaveProperty('agentId');
  });
});
