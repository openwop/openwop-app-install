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

  it('lossless: minifies + drops structurally-empty fields, preserving every row', () => {
    const input = sparseListPayload();
    const out = compactToolOutput(input, { mode: 'lossless' });
    const parsed = JSON.parse(out);
    // every row preserved (no elision in lossless mode)
    expect(parsed.items).toHaveLength(40);
    // empty fields dropped
    expect(parsed.items[0].metadata).not.toHaveProperty('tags'); // [] dropped
    expect(parsed.items[0].metadata.nested).not.toHaveProperty('a'); // null dropped
    expect(parsed.items[0].metadata.nested).not.toHaveProperty('b'); // "" dropped
    // non-empty values preserved (0 is NOT empty)
    expect(parsed.items[0].metadata.nested.c).toBe(0);
    expect(parsed.items[0].id).toBe('usr_0');
    // material reduction on a sparse payload
    expect(out.length).toBeLessThan(input.length * 0.6);
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
