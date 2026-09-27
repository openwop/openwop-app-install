/**
 * ADR 0099 — the pure compaction kernel. No I/O, no deps, deterministic.
 */
import { describe, it, expect } from 'vitest';
import { compactToolOutput } from '../src/features/tool-output-compaction/compact.js';

/** A representative empty-field-heavy tool output (a list result). */
function sparseListPayload(rows = 40): string {
  const items = Array.from({ length: rows }, (_, i) => ({
    id: `usr_${i}`,
    name: `User ${i}`,
    email: `user${i}@example.com`,
    created_at: `2026-06-0${(i % 9) + 1}T12:00:00Z`,
    metadata: { role: i % 2 ? 'admin' : 'member', active: true, score: 0, tags: [], nested: { a: null, b: '', c: 0 } },
  }));
  return JSON.stringify({ items }, null, 2);
}

describe('compactToolOutput', () => {
  it('mode "off" is identity', () => {
    const input = sparseListPayload();
    expect(compactToolOutput(input, { mode: 'off' })).toBe(input);
  });

  it('is deterministic (same input → byte-identical output)', () => {
    const input = sparseListPayload();
    expect(compactToolOutput(input, { mode: 'lossless' })).toBe(compactToolOutput(input, { mode: 'lossless' }));
    expect(compactToolOutput(input, { mode: 'lossy' })).toBe(compactToolOutput(input, { mode: 'lossy' }));
  });

  /**
   * TOCC-3 / TOCWF-7 (ADR 0604) — THIS TEST USED TO PIN THE DEFECT.
   *
   * It was named "lossless: minifies + drops structurally-empty fields" and
   * asserted `not.toHaveProperty('tags')` — i.e. it encoded that the mode named
   * LOSSLESS deletes information, and called that passing. A test that asserts
   * the wrong behaviour is worse than no test: it defends the defect against
   * every future reader. `lossless` now means what the word means, and the
   * dropping half is exercised under `lossy`, below.
   */
  /**
   * ADR 0604 review H2 — THIS ASSERTION USED TO BE BLIND BY CONSTRUCTION.
   *
   * It read `expect(JSON.parse(out)).toEqual(JSON.parse(input))`. Both sides go
   * through the same `JSON.parse`, so a defect IN the round trip is invisible
   * to it: `{"a": 9007199254740993}` became `{"a":9007199254740992}` and
   * `{"status":"ok","status":"degraded"}` became `{"status":"degraded"}`, and
   * this test stayed green through both. A round-trip oracle cannot measure the
   * round trip — it was the third instance of that family in this batch, and it
   * shipped inside the cure for the second.
   *
   * The preservation property is about the STRING the model reads, so the
   * witness compares STRINGS. It walks input and output with two pointers and
   * proves the strongest statement that is actually true: **the output is the
   * input with some whitespace characters deleted.** Nothing is written, so
   * nothing can be normalised.
   */
  const LOSSLESS_FIXTURES = [
    sparseListPayload(),
    JSON.stringify({ results: [], query: 'q' }),
    JSON.stringify({ ok: false, error: '' }),
    JSON.stringify({ agents: [], workflows: [], roster: [], autonomyLevels: [] }),
    JSON.stringify({ type: 'object', required: [], properties: { a: { enum: ['x', 'y'] } } }),
    JSON.stringify({ a: { b: [], c: '' }, d: 1 }),
    // Byte-level cases the parse-based oracle could not see (review H2):
    '{"a": 9007199254740993}', //          an id past Number.MAX_SAFE_INTEGER
    '{"a": 1e400}', //                     overflows to Infinity ⇒ used to serialise as `null`
    '{"x": 1.0, "y": 1e2, "z": -0}', //    literal forms JSON.stringify rewrites
    '{"status":"ok","status":"degraded"}', // duplicate key: the first used to vanish
    '{"s": "  spaced\\tvalue  ", "t": "a\\u00e9b"}', // whitespace + escapes INSIDE strings
    '[\n  1,\n  {"k": [ ]}\n]',
  ];

  it('lossless is ACTUALLY lossless — the output is the input MINUS whitespace (STRING comparison)', () => {
    const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
    for (const input of LOSSLESS_FIXTURES) {
      const out = compactToolOutput(input, { mode: 'lossless' });
      // Two pointers: every output char must be the next input char; every
      // input char that is skipped must be whitespace. This is a complete proof
      // that the transform only DELETES, and only deletes whitespace.
      let i = 0;
      for (let o = 0; o < out.length; o += 1) {
        while (i < input.length && input[i] !== out[o]) {
          expect(isWs(input[i]!), `lossless deleted a NON-whitespace char at ${i} of ${input}`).toBe(true);
          i += 1;
        }
        expect(i, `lossless emitted a character not present in ${input}`).toBeLessThan(input.length);
        i += 1;
      }
      for (; i < input.length; i += 1) {
        expect(isWs(input[i]!), `lossless truncated ${input} at ${i}`).toBe(true);
      }
      // …and it is still the same JSON value (this catches whitespace deleted
      // from INSIDE a string literal, which the walk above cannot distinguish).
      expect(JSON.parse(out)).toEqual(JSON.parse(input));
    }
  });

  it('lossless preserves the exact BYTES a re-serialising kernel silently rewrote', () => {
    // The four measured cases, pinned as literals rather than as a property, so
    // a future "just JSON.stringify it" refactor names itself immediately.
    expect(compactToolOutput('{"a": 9007199254740993}', { mode: 'lossless' })).toBe('{"a":9007199254740993}');
    expect(compactToolOutput('{"a": 1e400}', { mode: 'lossless' })).toBe('{"a":1e400}');
    expect(compactToolOutput('{"x": 1.0}', { mode: 'lossless' })).toBe('{"x":1.0}');
    expect(compactToolOutput('{"status":"ok","status":"degraded"}', { mode: 'lossless' }))
      .toBe('{"status":"ok","status":"degraded"}');
  });

  it('LOSSY still normalises those bytes — documented, because lossy says so', () => {
    // Not a defect: `lossy` rebuilds the value, so IEEE-754 and last-key-wins
    // apply. Recorded here so the class is known rather than rediscovered, and
    // so the difference between the two modes is a pinned fact.
    expect(compactToolOutput('{"a": 9007199254740993, "b": 0}', { mode: 'lossy' })).toBe('{"a":9007199254740992,"b":0}');
    expect(compactToolOutput('{"a": 1e400, "b": 0}', { mode: 'lossy' })).toBe('{"a":null,"b":0}');
    expect(compactToolOutput('{"status":"ok","status":"degraded"}', { mode: 'lossy' })).toBe('{"status":"degraded"}');
  });

  it('lossless preserves the four empties whose ABSENCE would be a different claim', () => {
    // Each of these was measured being destroyed before ADR 0604. An honest
    // "we looked and found nothing" must not become "no information".
    const honestEmpty = JSON.stringify({ results: [], query: 'q' });
    expect(compactToolOutput(honestEmpty, { mode: 'lossless' })).toBe(honestEmpty);
    const failEmpty = JSON.stringify({ agents: [], workflows: [], roster: [], autonomyLevels: [] });
    expect(compactToolOutput(failEmpty, { mode: 'lossless' })).toBe(failEmpty); // was `{}`
    const errored = JSON.stringify({ ok: false, error: '' });
    expect(compactToolOutput(errored, { mode: 'lossless' })).toBe(errored);
    const schema = JSON.stringify({ type: 'object', required: [] });
    expect(JSON.parse(compactToolOutput(schema, { mode: 'lossless' }))).toHaveProperty('required');
  });

  it('lossless still minifies — the one saving it can make honestly', () => {
    const input = sparseListPayload();
    const out = compactToolOutput(input, { mode: 'lossless' });
    // The fixture is INDENTED (`JSON.stringify(..., null, 2)`), so there is real
    // whitespace to strip. Note the measured caveat in `compact.ts`: 0 of 336
    // agent-tool `JSON.stringify` call sites indent, so this saving is ~0 on
    // real tool output. The floor proves the transform still runs, not that the
    // feature saves anything in production.
    expect(out.length).toBeLessThan(input.length);
    expect(out).not.toContain('\n');
    // Review H2 — the saving did not shrink when `lossless` stopped
    // re-serialising. On a fixture with no non-round-tripping literals the two
    // strategies are BYTE-IDENTICAL, so the claim in `compact.ts`'s header is
    // pinned here rather than asserted in prose.
    expect(out).toBe(JSON.stringify(JSON.parse(input)));
  });

  it('lossy drops empties but DISCLOSES what it dropped (never a silent absence)', () => {
    // Eight empty fields in one object — enough that naming them still costs
    // fewer bytes than carrying them, so the never-regress guard lets it through.
    const input = JSON.stringify({ a: '', b: '', c: '', d: '', e: '', f: '', g: '', h: '', ok: false, q: 'x' });
    const parsed = JSON.parse(compactToolOutput(input, { mode: 'lossy' }));
    expect(parsed).not.toHaveProperty('a');
    // NOTE (ADR 0604): eight is deliberately MORE than the default lossy
    // head+tail+1, so this also witnesses that the disclosure array is itself
    // exempt from elision — the first draft of the fix truncated its own marker
    // to `['a','b','c',{_elided:4},'h']`.
    expect(parsed._emptied).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']); // present-and-empty, NAMED
    expect(parsed.ok).toBe(false); // `false`/`0` are NOT empty
    expect(parsed.q).toBe('x');
  });

  it('lossy declines to drop when the disclosure would cost more than the empties', () => {
    // The honest consequence of disclosure, pinned deliberately: on a payload
    // with one or two empty fields, naming them is BIGGER than keeping them, so
    // the never-regress guard returns the original untouched. Compaction that
    // cannot pay for its own honesty simply does not happen — it never buys the
    // saving by going silent.
    const input = JSON.stringify({ ok: false, error: '', results: [], query: 'q' });
    expect(compactToolOutput(input, { mode: 'lossy' })).toBe(input);
  });

  it('lossy leaves an object that already owns `_emptied` alone (never clobbers a real field)', () => {
    const input = JSON.stringify({ _emptied: 'a real payload field', tags: [] });
    const parsed = JSON.parse(compactToolOutput(input, { mode: 'lossy' }));
    expect(parsed._emptied).toBe('a real payload field');
    expect(parsed.tags).toEqual([]);
  });

  it('lossy: elides long homogeneous arrays, preserving the true count', () => {
    const input = sparseListPayload();
    const out = compactToolOutput(input, { mode: 'lossy', head: 3, tail: 1 });
    const parsed = JSON.parse(out);
    // head(3) + marker + tail(1)
    expect(parsed.items).toHaveLength(5);
    expect(parsed.items[3]).toEqual({ _elided: 36 }); // 40 - 3 - 1
    expect(parsed.items[0].id).toBe('usr_0');
    expect(parsed.items[4].id).toBe('usr_39');
    expect(out.length).toBeLessThan(input.length * 0.2);
  });

  it('lossy: short arrays are left intact (≤ head+tail+1)', () => {
    const input = JSON.stringify({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const out = compactToolOutput(input, { mode: 'lossy', head: 3, tail: 1 });
    expect(JSON.parse(out).items).toHaveLength(3);
  });

  it('non-JSON content passes through untouched', () => {
    const prose = 'The deployment failed: connection refused at 10.0.0.4:5432.';
    expect(compactToolOutput(prose, { mode: 'lossless' })).toBe(prose);
    expect(compactToolOutput(prose, { mode: 'lossy' })).toBe(prose);
  });

  it('malformed JSON is returned unchanged (never throws)', () => {
    const broken = '{"items": [{"id": 1}, {"id":';
    expect(() => compactToolOutput(broken, { mode: 'lossy' })).not.toThrow();
    expect(compactToolOutput(broken, { mode: 'lossless' })).toBe(broken);
  });

  it('never regresses: returns the original when compaction would not shrink it', () => {
    const tiny = '[1,2,3]';
    expect(compactToolOutput(tiny, { mode: 'lossless' }).length).toBeLessThanOrEqual(tiny.length);
  });

  it('respects minChars (skips small payloads)', () => {
    const small = JSON.stringify({ a: null, b: 'x' });
    expect(compactToolOutput(small, { mode: 'lossless', minChars: 1000 })).toBe(small);
  });

  it('defaults head/tail when omitted in lossy mode', () => {
    const input = JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ id: i })) });
    const out = compactToolOutput(input, { mode: 'lossy' });
    const parsed = JSON.parse(out);
    // default head 3 + marker + tail 1
    expect(parsed.items).toHaveLength(5);
    expect(parsed.items[3]).toEqual({ _elided: 16 });
  });
});
