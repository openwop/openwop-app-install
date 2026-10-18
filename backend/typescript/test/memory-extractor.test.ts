/**
 * ADR 0120 Phase 2c — fact-line parser (`parseFactLines`, pure). The model's raw output is
 * untrusted text that becomes durable memory, so the parser is the bound: bullets stripped,
 * 4..280 chars, NONE/n-a sentinels dropped, case-insensitive dedupe, at most 10 facts (the
 * FIRST ten, in order).
 *
 * Witnessed (wave 25 probes): narrowing the strip regex, `< 4` → `< 1` / `< 0`, a dead
 * sentinel regex, no dedupe, a cap of 100, and `> 280` → `> 1000` each red their case.
 */
import { describe, it, expect } from 'vitest';
import { parseFactLines } from '../src/features/memory-auto-extract/memoryExtractor.js';

describe('parseFactLines', () => {
  it('strips bullets/numbering + trims', () => {
    expect(parseFactLines('- Prefers dark mode\n* Works at Acme\n1. Lives in Berlin')).toEqual([
      'Prefers dark mode', 'Works at Acme', 'Lives in Berlin',
    ]);
  });
  it('drops the NONE sentinel + too-short lines', () => {
    expect(parseFactLines('NONE')).toEqual([]);
    expect(parseFactLines('no facts')).toEqual([]);
    expect(parseFactLines('ok\nLikes cats')).toEqual(['Likes cats']); // "ok" too short
    // the boundary: 3 chars dropped, 4 kept
    expect(parseFactLines('abc')).toEqual([]);
    expect(parseFactLines('abcd')).toEqual(['abcd']);
  });
  it('dedupes case-insensitively', () => {
    expect(parseFactLines('Likes cats\nLIKES CATS\nlikes cats')).toEqual(['Likes cats']);
  });
  it('caps the count at 10', () => {
    const raw = Array.from({ length: 25 }, (_, i) => `Fact number ${i}`).join('\n');
    expect(parseFactLines(raw)).toEqual(Array.from({ length: 10 }, (_, i) => `Fact number ${i}`));
  });
  it('drops an over-long line', () => {
    expect(parseFactLines('x'.repeat(400))).toEqual([]);
    // the boundary: 280 kept, 281 dropped
    expect(parseFactLines('y'.repeat(280))).toEqual(['y'.repeat(280)]);
    expect(parseFactLines('y'.repeat(281))).toEqual([]);
  });
  it('handles empty/blank input', () => {
    expect(parseFactLines('')).toEqual([]);
    expect(parseFactLines('   \n  \n')).toEqual([]);
  });
});
