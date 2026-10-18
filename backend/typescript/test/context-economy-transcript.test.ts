/**
 * ADR 0148 Phase 3 (A1) — token-budgeted transcript windowing.
 *
 * Guards: `windowTranscript` keeps a CONTIGUOUS newest suffix — at most
 * `keepLastTurns` turns, within `maxChars` accumulated newest-first, stopping at
 * the first turn that overflows (an older small turn is never packed in past a
 * gap) — returned in chronological order, with an honest `omittedCount`; always
 * admits the newest turn; never mutates its input. `transcriptBudgetConfig` reads
 * its two env knobs (defaults 20 / 24000, invalid ⇒ default).
 *
 * Sabotage (grade-tests w28): `break`→`continue`, dropping the reverse, an
 * off-by-one turn cap, a zero omittedCount, starving the newest turn, or mutating
 * the input each turn a case red.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { windowTranscript, transcriptBudgetConfig } from '../src/host/transcriptBudget.js';

interface Turn { id: number; text: string }
const sizeOf = (t: Turn) => t.text.length;
const mk = (n: number, len = 10): Turn[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, text: 'x'.repeat(len) }));

afterEach(() => {
  delete process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_KEEP_TURNS;
  delete process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_MAX_CHARS;
});

describe('windowTranscript', () => {
  it('keeps everything when under both caps', () => {
    const turns = mk(5);
    const { kept, omittedCount } = windowTranscript(turns, { keepLastTurns: 20, maxChars: 10_000 }, sizeOf);
    expect(kept).toEqual(turns);
    expect(omittedCount).toBe(0);
  });

  it('keeps the most-recent keepLastTurns, in chronological order', () => {
    const turns = mk(10);
    const { kept, omittedCount } = windowTranscript(turns, { keepLastTurns: 3, maxChars: 10_000 }, sizeOf);
    expect(kept.map((t) => t.id)).toEqual([7, 8, 9]); // chronological, last 3
    expect(omittedCount).toBe(7);
  });

  it('enforces the char budget (newest-first), preserving order', () => {
    const turns: Turn[] = [10, 100, 200, 50, 100].map((len, id) => ({ id, text: 'x'.repeat(len) }));
    const { kept, omittedCount } = windowTranscript(turns, { keepLastTurns: 20, maxChars: 250 }, sizeOf);
    // Newest-first: turn 4 (100), turn 3 (150); turn 2 (350>250) STOPS — turn 1
    // (would total 250) is NOT admitted past the gap. Kept in chronological order.
    expect(kept.map((t) => t.id)).toEqual([3, 4]);
    expect(omittedCount).toBe(3);
  });

  it('always admits at least the single most-recent turn even if it alone exceeds maxChars', () => {
    const turns = mk(3, 1000);
    const { kept } = windowTranscript(turns, { keepLastTurns: 20, maxChars: 100 }, sizeOf);
    expect(kept.map((t) => t.id)).toEqual([2]);
  });

  it('empty input → empty, nothing omitted', () => {
    expect(windowTranscript([], { keepLastTurns: 5, maxChars: 100 }, sizeOf)).toEqual({ kept: [], omittedCount: 0 });
  });

  it('does not mutate the input array', () => {
    const turns = mk(5);
    const snap = JSON.stringify(turns);
    windowTranscript(turns, { keepLastTurns: 2, maxChars: 100 }, sizeOf);
    expect(JSON.stringify(turns)).toBe(snap);
  });
});

describe('transcriptBudgetConfig', () => {
  it('defaults to 20 turns / 24000 chars', () => {
    expect(transcriptBudgetConfig()).toEqual({ keepLastTurns: 20, maxChars: 24_000 });
  });
  it('reads env overrides', () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_KEEP_TURNS = '6';
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_MAX_CHARS = '5000';
    expect(transcriptBudgetConfig()).toEqual({ keepLastTurns: 6, maxChars: 5000 });
  });
  it('ignores invalid env (falls back to defaults)', () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_KEEP_TURNS = 'nonsense';
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_MAX_CHARS = '-5';
    expect(transcriptBudgetConfig()).toEqual({ keepLastTurns: 20, maxChars: 24_000 });
  });
});
