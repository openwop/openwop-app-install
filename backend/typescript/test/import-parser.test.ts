/**
 * ADR 0119 Phase 4a — conversation import parsers.
 */
import { describe, it, expect } from 'vitest';
import { parseOpenwopExport, parseChatGptExport } from '../src/features/chat-export/importParser.js';

describe('parseOpenwopExport', () => {
  it('round-trips the openwop-v1 shape', () => {
    const out = parseOpenwopExport({
      version: 'openwop-v1',
      conversation: { sessionId: 'c1', title: 'Plan', createdAt: 'x' },
      messages: [{ role: 'user', content: 'q', createdAt: 't1' }, { role: 'assistant', content: 'a', createdAt: 't2' }],
    });
    expect(out.title).toBe('Plan');
    expect(out.turns).toHaveLength(2);
    expect(out.turns[0]).toMatchObject({ role: 'user', content: 'q', createdAt: 't1' });
  });
  it('rejects a non-openwop payload', () => {
    expect(() => parseOpenwopExport({ version: 'other' })).toThrow();
    expect(() => parseOpenwopExport(null)).toThrow();
  });
  it('skips malformed messages + defaults an unknown role to user', () => {
    const out = parseOpenwopExport({ version: 'openwop-v1', messages: [{ role: 'weird', content: 'x' }, { content: 123 }] });
    expect(out.turns).toHaveLength(1);
    expect(out.turns[0]!.role).toBe('user');
  });
});

describe('parseChatGptExport', () => {
  it('linearizes the mapping tree via current_node (chronological)', () => {
    const out = parseChatGptExport({
      title: 'GPT chat',
      current_node: 'n2',
      mapping: {
        root: { message: null, parent: null },
        n1: { message: { author: { role: 'user' }, content: { parts: ['hello'] } }, parent: 'root' },
        n2: { message: { author: { role: 'assistant' }, content: { parts: ['hi there'] } }, parent: 'n1' },
      },
    });
    expect(out.title).toBe('GPT chat');
    expect(out.turns.map((t) => t.content)).toEqual(['hello', 'hi there']); // chronological
    expect(out.turns[0]!.role).toBe('user');
  });
  it('rejects a non-ChatGPT payload', () => {
    expect(() => parseChatGptExport({})).toThrow();
  });
  it('tolerates a cyclic/partial tree without throwing', () => {
    const out = parseChatGptExport({ current_node: 'a', mapping: { a: { message: { author: { role: 'user' }, content: { parts: ['x'] } }, parent: 'a' } } });
    expect(out.turns).toHaveLength(1);
  });
});
