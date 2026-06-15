/**
 * conversationTransport — turns→bubbles mapping + flag default.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { turnsToBubbles, conversationChatEnabled } from '../conversationTransport.js';
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

describe('conversationChatEnabled', () => {
  afterEach(() => { try { localStorage.removeItem('openwop:chat-conversation'); } catch { /* jsdom */ } });
  it('is OFF by default (no env, no localStorage)', () => {
    expect(conversationChatEnabled()).toBe(false);
  });
  it('opt-in via localStorage', () => {
    localStorage.setItem('openwop:chat-conversation', '1');
    expect(conversationChatEnabled()).toBe(true);
  });
});
