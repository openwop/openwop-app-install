import { describe, it, expect } from 'vitest';
import { chatSessionReducer } from '../chatSessionReducer.js';
import type { ChatSession, ChatMessage } from '../../types.js';

function msg(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content: 'x', createdAt: '2026-01-01T00:00:00Z', ...over };
}
function session(messages: ChatMessage[]): ChatSession {
  return { id: 's1', title: 'T', messages, createdAt: '2026-01-01T00:00:00Z' };
}

describe('chatSessionReducer', () => {
  it('appends a message immutably', () => {
    const s = session([msg('a')]);
    const next = chatSessionReducer(s, { type: 'appendMessage', message: msg('b') });
    expect(next.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(s.messages).toHaveLength(1); // original untouched
    expect(next).not.toBe(s);
  });

  it('updates a message by id and returns the same object when no match', () => {
    const s = session([msg('a', { content: 'old' })]);
    const updated = chatSessionReducer(s, { type: 'updateMessage', id: 'a', patch: { content: 'new' } });
    expect(updated.messages[0]!.content).toBe('new');
    const noop = chatSessionReducer(s, { type: 'updateMessage', id: 'zzz', patch: { content: 'x' } });
    expect(noop).toBe(s);
  });

  it('replaces and removes messages', () => {
    const s = session([msg('a'), msg('b')]);
    expect(chatSessionReducer(s, { type: 'replaceMessages', messages: [msg('c')] }).messages.map((m) => m.id)).toEqual(['c']);
    expect(chatSessionReducer(s, { type: 'removeMessage', id: 'a' }).messages.map((m) => m.id)).toEqual(['b']);
  });

  it('sets title (identity-stable when unchanged)', () => {
    const s = session([]);
    expect(chatSessionReducer(s, { type: 'setTitle', title: 'New' }).title).toBe('New');
    expect(chatSessionReducer(s, { type: 'setTitle', title: 'T' })).toBe(s);
  });

  it('sets and clears feedback', () => {
    const s = session([msg('a')]);
    expect(chatSessionReducer(s, { type: 'setFeedback', id: 'a', feedback: 'positive' }).messages[0]!.feedback).toBe('positive');
    const withFb = chatSessionReducer(s, { type: 'setFeedback', id: 'a', feedback: 'positive' });
    const cleared = chatSessionReducer(withFb, { type: 'setFeedback', id: 'a', feedback: null });
    expect(cleared.messages[0]!.feedback).toBeUndefined();
    expect('feedback' in cleared.messages[0]!).toBe(false);
  });

  it('truncates from a message id (drops it and everything after)', () => {
    const s = session([msg('a'), msg('b'), msg('c')]);
    expect(chatSessionReducer(s, { type: 'truncateFrom', id: 'b' }).messages.map((m) => m.id)).toEqual(['a']);
    expect(chatSessionReducer(s, { type: 'truncateFrom', id: 'missing' })).toBe(s);
  });
});
