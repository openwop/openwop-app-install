/**
 * ADR 0151 Phase 1 — `sanitizeTitle` (OQ-5): a misbehaving free model degrades to the
 * placeholder, never worse. Pure + deterministic; covers quote-stripping, the "Title:"
 * preamble, newline collapse, the length cap, and garbage→null.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeTitle } from '../src/features/chat-autotitle/titleGenerator.js';

describe('ADR 0151 — sanitizeTitle', () => {
  it('returns a clean short title unchanged', () => {
    expect(sanitizeTitle('Refactor the auth middleware')).toBe('Refactor the auth middleware');
  });

  it('strips wrapping straight + smart quotes and backticks', () => {
    expect(sanitizeTitle('"Deploy pipeline"')).toBe('Deploy pipeline');
    expect(sanitizeTitle('“Deploy pipeline”')).toBe('Deploy pipeline');
    expect(sanitizeTitle('`Deploy pipeline`')).toBe('Deploy pipeline');
  });

  it('drops a leading "Title:" / "Title -" preamble', () => {
    expect(sanitizeTitle('Title: Plan the migration')).toBe('Plan the migration');
    expect(sanitizeTitle('title - Plan the migration')).toBe('Plan the migration');
  });

  it('collapses newlines and whitespace runs', () => {
    expect(sanitizeTitle('Plan\n  the   migration')).toBe('Plan the migration');
  });

  it('hard-caps length on a word boundary', () => {
    const long = 'Discuss the quarterly revenue forecast and the hiring plan for engineering next year';
    const out = sanitizeTitle(long)!;
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith(' ')).toBe(false);
    expect(long.startsWith(out)).toBe(true);
  });

  it('returns null for empty / sentinel / too-short garbage', () => {
    expect(sanitizeTitle('')).toBeNull();
    expect(sanitizeTitle('   ')).toBeNull();
    expect(sanitizeTitle('NONE')).toBeNull();
    expect(sanitizeTitle('New chat')).toBeNull();
    expect(sanitizeTitle('untitled')).toBeNull();
    expect(sanitizeTitle('x')).toBeNull();
  });
});
