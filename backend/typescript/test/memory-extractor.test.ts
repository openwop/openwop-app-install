/**
 * ADR 0120 Phase 2c — fact-line parser.
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
  });
  it('dedupes case-insensitively', () => {
    expect(parseFactLines('Likes cats\nLIKES CATS\nlikes cats')).toEqual(['Likes cats']);
  });
  it('caps the count at 10', () => {
    const raw = Array.from({ length: 25 }, (_, i) => `Fact number ${i}`).join('\n');
    expect(parseFactLines(raw).length).toBe(10);
  });
  it('drops an over-long line', () => {
    expect(parseFactLines('x'.repeat(400))).toEqual([]);
  });
  it('handles empty/blank input', () => {
    expect(parseFactLines('')).toEqual([]);
    expect(parseFactLines('   \n  \n')).toEqual([]);
  });
});
