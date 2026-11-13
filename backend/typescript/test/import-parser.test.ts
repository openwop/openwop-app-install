/**
 * ADR 0119 Phase 4a / ADR 0992 D2, D7 — conversation import parsers
 * (`features/chat-export/importParser.ts`).
 *
 * Guards: a malformed input is a typed `OpenwopError` 400 (`validation_error`, with
 * `details.reason`), never a plain Error the middleware maps to a 500; an ARRAY (a
 * ChatGPT data-export archive) is refused as `reason: 'archive'` by BOTH parsers; a
 * message whose content is not a string is skipped; an unknown role is carried as
 * written (ADR 0992 D2: defaulting it to 'user' made a workflow card re-import as
 * speech); `createdAt` is carried through; the ChatGPT mapping tree is walked from
 * `current_node` and reversed into chronological order; a cyclic tree terminates;
 * `create_time` (epoch seconds) is read and a value no Date can hold is dropped.
 *
 * Every refusal is asserted by its reason and message, so a TypeError (null guard
 * removed) or a neighbouring refusal cannot stand in for the one a case names. The
 * openwop version leg carries `messages: []`, so ONLY the version check can refuse it.
 *
 * Sabotages each red their case (wave 106 probes w106g2-ip-*): the archive checks, the
 * version check, the null guard, the content skip, the unknown-role spelling, the
 * createdAt carry, the reverse, the mapping guard, the cycle guard (weakened, since
 * REMOVING it outright hangs the synchronous walk on a self-cycle), the seconds→ms
 * scale and the finite-date check.
 */
import { describe, it, expect } from 'vitest';
import { OpenwopError } from '../src/types.js';
import { parseOpenwopExport, parseChatGptExport } from '../src/features/chat-export/importParser.js';

/** What `fn` threw; fails the case if it did not throw. */
function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  throw new Error('expected a throw');
}

describe('parseOpenwopExport', () => {
  it('round-trips the openwop-v1 shape', () => {
    const out = parseOpenwopExport({
      version: 'openwop-v1',
      conversation: { sessionId: 'c1', title: 'Plan', createdAt: 'x' },
      messages: [{ role: 'user', content: 'q', createdAt: 't1' }, { role: 'assistant', content: 'a', createdAt: 't2' }],
    });
    expect(out).toEqual({ title: 'Plan', turns: [{ role: 'user', content: 'q', createdAt: 't1' }, { role: 'assistant', content: 'a', createdAt: 't2' }] });
  });
  it('rejects a non-openwop payload', () => {
    // `messages: []` is present, so the VERSION check alone must refuse it.
    const versionErr = thrown(() => parseOpenwopExport({ version: 'other', messages: [] }));
    expect(versionErr).toBeInstanceOf(OpenwopError);
    expect(versionErr).toMatchObject({ code: 'validation_error', httpStatus: 400, message: 'Not an OpenWOP conversation export (openwop-v1).', details: { field: 'data', reason: 'not_openwop' } });
    // null must be refused by the guard, not by a TypeError on `null.version`.
    const nullErr = thrown(() => parseOpenwopExport(null));
    expect(nullErr).toBeInstanceOf(OpenwopError);
    expect(nullErr).toMatchObject({ code: 'validation_error', details: { reason: 'not_openwop' } });
  });
  it('ADR 0992 D7 — refuses a multi-conversation archive with a typed 400 naming it', () => {
    for (const err of [
      thrown(() => parseOpenwopExport([{ version: 'openwop-v1', messages: [] }])),
      thrown(() => parseChatGptExport([{ mapping: {} }])),
    ]) {
      expect(err).toBeInstanceOf(OpenwopError);
      expect(err).toMatchObject({ code: 'validation_error', httpStatus: 400, message: expect.stringMatching(/archive of several conversations/), details: { reason: 'archive' } });
    }
  });
  // ADR 0992 D2 — an unknown role is carried as written (the importer skips and
  // counts it); defaulting it to 'user' made a workflow card re-import as speech.
  it('skips malformed messages + carries an unknown role as written', () => {
    const out = parseOpenwopExport({ version: 'openwop-v1', messages: [{ role: 'weird', content: 'x' }, { content: 123 }, { content: 'y' }] });
    expect(out.turns).toEqual([{ role: 'weird', content: 'x' }, { role: 'unknown', content: 'y' }]);
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
    expect(out).toEqual({ title: 'GPT chat', turns: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi there' }] });
  });
  it('rejects a non-ChatGPT payload', () => {
    const err = thrown(() => parseChatGptExport({}));
    expect(err).toBeInstanceOf(OpenwopError);
    expect(err).toMatchObject({ code: 'validation_error', httpStatus: 400, message: 'Not a ChatGPT conversation export.', details: { reason: 'not_chatgpt' } });
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
    // 1700000000.5 s, converted by hand: 2023-11-14T22:13:20.500Z.
    expect(out.turns).toEqual([{ role: 'user', content: 'x', createdAt: '2023-11-14T22:13:20.500Z' }, { role: 'assistant', content: 'y' }]);
  });
});
