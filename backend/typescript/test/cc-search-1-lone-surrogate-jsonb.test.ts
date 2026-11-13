/**
 * CC-SEARCH-1 — a lone UTF-16 surrogate in node output cannot take a run down.
 *
 * MEASURED on app.openwop.dev (373d4863a, 2026-11-12): an
 * `outreach.researched-firsttouch` run died at `core.web.search` with
 * `dispatch_failed: invalid input syntax for type json` for one query while a
 * second query ran clean. Web-research text is cut by UTF-16 code units
 * (`slice(0, 300)`, `slice(0, maxBody)`), and a cut through an emoji leaves half
 * of a surrogate pair. `JSON.stringify` then emits `"\ud83d"`, and Postgres
 * `jsonb` rejects an unpaired surrogate escape with exactly that error
 * (reproduced against Postgres 15: `select '{"a":"x\ud83d"}'::jsonb`).
 *
 * Pins: `nulSafe` (the replacer every jsonb parameter goes through) replaces an
 * unpaired high or low surrogate with U+FFFD, nested and in arrays; a valid pair
 * (an emoji) and every other string are unchanged; NUL handling (ADR 0975 D10)
 * still holds.
 *
 * Red when: `nulSafe` handles only U+0000 (the pre-fix behaviour) — the
 * serialized JSON then still contains a lone `\ud83d` / `\ude00` escape.
 */
import { describe, expect, it } from 'vitest';
import { nulSafe } from '../src/storage/postgres/index.js';

/** A JSON text Postgres jsonb would reject: an unpaired surrogate escape. */
const LONE_SURROGATE_ESCAPE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;

describe('CC-SEARCH-1 — jsonb values carry no unpaired surrogates', () => {
  it('a snippet cut through an emoji serializes as well-formed JSON with U+FFFD', () => {
    const cut = 'Goal apps 😀'.slice(0, 11); // ends on the high half of the emoji
    expect(cut.endsWith('\ud83d')).toBe(true);
    const value = { results: [{ title: 'KickTodo', snippet: cut }], lowOnly: '\ude00x', nested: { a: ['ok', '\ud83d'] } };
    const json = JSON.stringify(value, nulSafe);
    expect(LONE_SURROGATE_ESCAPE.test(json)).toBe(false);
    expect(JSON.parse(json)).toEqual({ results: [{ title: 'KickTodo', snippet: 'Goal apps �' }], lowOnly: '�x', nested: { a: ['ok', '�'] } });
  });

  it('valid surrogate pairs, plain text and NUL handling are unchanged', () => {
    expect(JSON.stringify({ e: 'Make Room 😀✓', t: 'a\tb' }, nulSafe)).toBe(JSON.stringify({ e: 'Make Room 😀✓', t: 'a\tb' }));
    expect(JSON.parse(JSON.stringify({ n: 'a\u0000b\ud83d' }, nulSafe))).toEqual({ n: 'a�b�' });
  });
});
