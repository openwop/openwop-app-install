/**
 * reconstructConversation — folds a run's conversation events into the ordered
 * thread (wire-native attribution; supersedes the #203 client-side labeling).
 */
import { describe, it, expect } from 'vitest';
import { reconstructConversation, type RunEvent, type ConversationTurn } from '../conversationClient.js';

const turn = (p: Partial<ConversationTurn> & Pick<ConversationTurn, 'messageId' | 'role' | 'turnIndex' | 'from'>): ConversationTurn => ({
  content: '', ts: 0, ...p,
});

describe('reconstructConversation', () => {
  it('folds opened + exchanged + closed turns in turnIndex order', () => {
    const events: RunEvent[] = [
      { type: 'conversation.opened', payload: { conversationId: 'c', initialTurn: turn({ messageId: 'c:0:system', role: 'system', turnIndex: 0, from: 'system' }) } },
      { type: 'node.message', payload: {} }, // unrelated, ignored
      { type: 'conversation.exchanged', payload: { conversationId: 'c', turn: turn({ messageId: 'c:1:user', role: 'user', turnIndex: 1, from: 'user', content: 'hi @devon', to: 'a:devon' }) } },
      { type: 'conversation.exchanged', payload: { conversationId: 'c', turn: turn({ messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'a:devon', content: 'Hey!', agent: { agentId: 'a:devon' } }) } },
      { type: 'conversation.closed', payload: { conversationId: 'c', finalTurn: turn({ messageId: 'c:3:system', role: 'system', turnIndex: 3, from: 'system' }) } },
    ];
    const turns = reconstructConversation(events);
    expect(turns.map((t) => t.turnIndex)).toEqual([0, 1, 2, 3]);
    expect(turns.map((t) => t.role)).toEqual(['system', 'user', 'agent', 'system']);
    // Agent attribution is carried from the wire.
    expect(turns[2]!.from).toBe('a:devon');
    expect(turns[2]!.agent?.agentId).toBe('a:devon');
    // The user's addressee is preserved.
    expect(turns[1]!.to).toBe('a:devon');
  });

  it('dedups on messageId (idempotent re-fold / replay) and sorts out-of-order', () => {
    const t1 = turn({ messageId: 'c:1:user', role: 'user', turnIndex: 1, from: 'user' });
    const events: RunEvent[] = [
      { type: 'conversation.exchanged', payload: { turn: turn({ messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'a' }) } },
      { type: 'conversation.exchanged', payload: { turn: t1 } },
      { type: 'conversation.exchanged', payload: { turn: t1 } }, // duplicate (replay) — ignored
    ];
    const turns = reconstructConversation(events);
    expect(turns.map((t) => t.turnIndex)).toEqual([1, 2]); // deduped + sorted
  });
});
