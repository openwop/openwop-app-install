/**
 * CC-SEARCH-1b — the jsonb writes outside the storage adapter's node-result path
 * serialize through the same sanitiser, so a lone UTF-16 surrogate cannot crash
 * them. CI-running sibling of `cc-search-1b-jsonb-writes-postgres-live.test.ts`.
 *
 * Pins: `jsonbStringify` (the shared serializer) emits no unpaired surrogate
 * escape and is `JSON.stringify` for clean values; the pgvector adapter's
 * `upsert` and the KB lexical index's `replaceNamespace` send chunk metadata
 * (often a sliced web snippet) — and the lexical term-count keys, which a
 * replacer never sees — through it.
 *
 * Red when: either adapter uses a bare `JSON.stringify` (the pre-fix code) — the
 * captured parameter then carries a lone `\ud83d` escape, which Postgres `jsonb`
 * rejects with `invalid input syntax for type json`.
 */
import { describe, expect, it } from 'vitest';
import { jsonbStringify } from '../src/storage/jsonbSafe.js';
import { createPgVectorVector, type SqlRunner } from '../src/host/vector/pgVectorVector.js';
import { createPgLexical } from '../src/host/vector/pgLexical.js';

const LONE_SURROGATE_ESCAPE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;
const HALF = 'Goal apps 😀'.slice(0, 11);

function capture(rows: Array<Record<string, unknown>> = []): { run: SqlRunner; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const run: SqlRunner = async (_sql, params) => { calls.push(params); return { rows }; };
  return { run, calls };
}

describe('CC-SEARCH-1b — shared jsonb serializer', () => {
  it('jsonbStringify replaces unpaired surrogates and leaves clean JSON identical', () => {
    const out = jsonbStringify({ a: HALF, b: ['\ude00', 'ok'], c: 'Make Room 😀' });
    expect(LONE_SURROGATE_ESCAPE.test(out)).toBe(false);
    expect(JSON.parse(out)).toEqual({ a: 'Goal apps �', b: ['�', 'ok'], c: 'Make Room 😀' });
    expect(jsonbStringify({ x: 1, y: 'plain', z: null })).toBe(JSON.stringify({ x: 1, y: 'plain', z: null }));
  });

  it('pgvector upsert sends chunk metadata through the sanitiser', async () => {
    const { run, calls } = capture();
    const vec = createPgVectorVector({ tenantId: 'cc-search-1b' }, { dim: 2, run });
    await vec.upsert({ namespace: 'kb', items: [{ id: 'c1', vector: [0.1, 0.2], metadata: { snippet: HALF } }] });
    const metaParam = calls[0]?.[4];
    expect(typeof metaParam).toBe('string');
    expect(LONE_SURROGATE_ESCAPE.test(metaParam as string)).toBe(false);
    expect(JSON.parse(metaParam as string)).toEqual({ snippet: 'Goal apps �' });
  });

  it('lexical replaceNamespace sends chunk metadata AND term-count keys through the sanitiser', async () => {
    const { run, calls } = capture([{ replaced: true }]);
    const lex = createPgLexical(run);
    await lex.replaceNamespace('cc-search-1b', 'owner-1', 'kb', 'gen-1', [{ id: 'c1', terms: `goal ${HALF.slice(-1)}`, metadata: { snippet: HALF } }]);
    const params = calls.at(-1)!;
    const metas = params[6] as string[];
    const counts = params[7] as string[];
    for (const json of [...metas, ...counts]) expect(LONE_SURROGATE_ESCAPE.test(json), json).toBe(false);
    expect(JSON.parse(metas[0]!)).toEqual({ snippet: 'Goal apps �' });
    expect(JSON.parse(counts[0]!)).toEqual({ goal: 1, '�': 1 });
  });
});
