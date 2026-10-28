/**
 * ADR 0119 Phase 4a — conversation import parsers (`features/chat-export/importParser.ts`).
 *
 * What turns each case red (wave-24 probes): dropping the `version` check or the `!o`
 * guard (rejects — the openwop leg carries `messages: []` so ONLY the version check can
 * refuse it, and the messages are pinned so a TypeError cannot stand in for the typed
 * refusal); not skipping non-string content / echoing an unknown role (skips malformed);
 * not reversing the parent walk (ADR 0992: typed OpenwopError refusals, archive
 * reason, unknown roles carried as written, create_time read) (chronological); dropping the mapping guard (rejects a
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
    expect(() => parseOpenwopExport({ version: 'other', messages: [] })).toThrow(/Not an OpenWOP conversation export/);
    // null must be refused by the guard, not by a TypeError on `null.version`.
    expect(() => parseOpenwopExport(null)).toThrow(/Not an OpenWOP conversation export/);
    let code: unknown;
    try { parseOpenwopExport({ version: 'other', messages: [] }); } catch (e) { code = (e as { code?: unknown }).code; }
    expect(code).toBe('validation_error');
  });
  it('ADR 0992 D7 — refuses a multi-conversation archive with a typed 400 naming it', () => {
    let err: { httpStatus?: unknown; details?: { reason?: unknown } } = {};
    try { parseOpenwopExport([{ version: 'openwop-v1', messages: [] }]); } catch (e) { err = e as typeof err; }
    expect(err.httpStatus).toBe(400);
    expect(err.details?.reason).toBe('archive');
    expect(() => parseChatGptExport([{ mapping: {} }])).toThrow(/archive/);
  });
  // ADR 0992 D2 — an unknown role is carried as written (the importer skips and
  // counts it); defaulting it to 'user' made a workflow card re-import as speech.
  it('skips malformed messages + carries an unknown role as written', () => {
    const out = parseOpenwopExport({ version: 'openwop-v1', messages: [{ role: 'weird', content: 'x' }, { content: 123 }, { content: 'y' }] });
    expect(out.turns.map((t) => t.role)).toEqual(['weird', 'unknown']);
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
    expect(() => parseChatGptExport({})).toThrow(/Not a ChatGPT conversation export/);
  });
  it('tolerates a cyclic/partial tree without throwing', () => {
    const out = parseChatGptExport({ current_node: 'a', mapping: { a: { message: { author: { role: 'user' }, content: { parts: ['x'] } }, parent: 'a' } } });
    expect(out.turns).toEqual([{ role: 'user', content: 'x' }]);
  });
  it('ADR 0992 D2 — reads create_time (epoch seconds); ignores a value no Date can hold', () => {
    const out = parseChatGptExport({ current_node: 'b', mapping: {
      a: { message: { author: { role: 'user' }, content: { parts: ['x'] }, create_time: 1700000000.5 }, parent: null },
      b: { message: { author: { role: 'assistant' }, content: { parts: ['y'] }, create_time: 1e300 }, parent: 'a' },
    } });
    expect(out.turns[0]!.createdAt).toBe(new Date(1700000000500).toISOString());
    expect(out.turns[1]!.createdAt).toBeUndefined();
  });
});
