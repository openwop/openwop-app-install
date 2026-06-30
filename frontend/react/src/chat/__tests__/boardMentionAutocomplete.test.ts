import { describe, it, expect } from 'vitest';
import {
  detectBoardMentionState,
  filterBoardMentions,
  type BoardMentionEntry,
} from '../BoardMentionAutocomplete.js';

describe('detectBoardMentionState', () => {
  it('fires on `@@` at start with an empty query', () => {
    expect(detectBoardMentionState('@@', 2)).toEqual({ atPos: 0, query: '' });
  });

  it('captures the query between `@@` and the cursor', () => {
    expect(detectBoardMentionState('@@time', 6)).toEqual({ atPos: 0, query: 'time' });
  });

  it('captures only up to the caret when the caret is mid-token', () => {
    expect(detectBoardMentionState('@@timeless', 5)).toEqual({ atPos: 0, query: 'tim' });
  });

  it('fires after leading whitespace', () => {
    expect(detectBoardMentionState('ask @@titans', 12)).toEqual({ atPos: 4, query: 'titans' });
  });

  it('does NOT fire for a single `@` (that is the agent picker)', () => {
    expect(detectBoardMentionState('@nora', 5)).toBeNull();
  });

  it('does NOT fire when `@@` is glued to a preceding word', () => {
    expect(detectBoardMentionState('a@@b', 4)).toBeNull();
  });

  it('does NOT fire across whitespace', () => {
    expect(detectBoardMentionState('@@titans now', 12)).toBeNull();
  });
});

describe('filterBoardMentions', () => {
  const boards: BoardMentionEntry[] = [
    { handle: 'titans', name: 'Living Titans', advisorCount: 4 },
    { handle: 'timeless', name: 'Timeless Council', advisorCount: 4 },
    { handle: 'founders', name: 'Founders', advisorCount: 3 },
  ];

  it('returns all boards for an empty query', () => {
    expect(filterBoardMentions(boards, '').map((b) => b.handle)).toEqual(['titans', 'timeless', 'founders']);
  });

  it('matches on handle, case-insensitively', () => {
    expect(filterBoardMentions(boards, 'TI').map((b) => b.handle)).toEqual(['titans', 'timeless']);
  });

  it('matches on name', () => {
    expect(filterBoardMentions(boards, 'council').map((b) => b.handle)).toEqual(['timeless']);
  });
});
