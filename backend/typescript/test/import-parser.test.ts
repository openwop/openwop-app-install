/**
 * ADR 0119 Phase 4a — conversation import parsers (`features/chat-export/importParser.ts`).
 *
 * What turns each case red (wave-24 probes): dropping the `version` check or the `!o`
 * guard (rejects — the openwop leg carries `messages: []` so ONLY the version check can
 * refuse it, and the messages are pinned so a TypeError cannot stand in for the typed
 * refusal); not skipping non-string content / echoing an unknown role (skips malformed);
 * not reversing the parent walk (chronological); dropping the mapping guard (rejects a
 * non-ChatGPT payload); weakening the cycle guard (cyclic tree — note that REMOVING it
 * outright hangs the synchronous walk on a self-cycle rather than failing).
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
    // `messages: []` is present, so the VERSION check alone must refuse it.
    expect(() => parseOpenwopExport({ version: 'other', messages: [] })).toThrow(/not an openwop-v1 export/);
    // null must be refused by the guard, not by a TypeError on `null.version`.
    expect(() => parseOpenwopExport(null)).toThrow(/not an openwop-v1 export/);
    let code: unknown;
    try { parseOpenwopExport({ version: 'other', messages: [] }); } catch (e) { code = (e as { code?: unknown }).code; }
    expect(code).toBe('validation_error');
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
    expect(() => parseChatGptExport({})).toThrow(/not a ChatGPT export/);
  });
  it('tolerates a cyclic/partial tree without throwing', () => {
    const out = parseChatGptExport({ current_node: 'a', mapping: { a: { message: { author: { role: 'user' }, content: { parts: ['x'] } }, parent: 'a' } } });
    expect(out.turns).toEqual([{ role: 'user', content: 'x' }]);
  });
});
