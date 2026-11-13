/**
 * ADR 0148 Phase 3 (A1) — token-budgeted transcript windowing.
 *
 * Guards: `windowTranscript` keeps a CONTIGUOUS newest suffix — at most
 * `keepLastTurns` turns, within `maxChars` accumulated newest-first, stopping at
 * the first turn that overflows (an older small turn is never packed in past a
 * gap) — returned in chronological order, with an honest `omittedCount`; always
 * admits the newest turn; never mutates its input. `transcriptBudgetConfig` reads
 * its three env knobs (defaults 20 / 24000 / half the turn cap, invalid ⇒ default).
 *
 * ADR 1003 D2 added the stepped window: the first kept turn is rounded UP to a
 * multiple of `stepTurns` (counted from turn 0), so a provider prefix cache can
 * hit between steps; it never keeps more than the caps, always keeps the newest
 * turn (the `turns.length - 1` clamp), and `stepTurns` 1 or absent is the
 * original window. `voiceSeedBudgetConfig` keeps the caps and never steps.
 *
 * Sabotage (grade-tests w28, re-probed w107): `break`→`continue`, dropping the
 * reverse, an off-by-one turn cap, a zero omittedCount, starving the newest turn,
 * mutating the input, rounding the step down, dropping the newest-turn clamp,
 * reporting the caps' omittedCount on the stepped path, a call-dependent step,
 * deriving the default step from the default cap (or rounding it up), or letting
 * the voice seed step each turn a case red. Determinism (the same conversation
 * windows the same way on every call) is held by the exact 14-call literal in
 * "the first kept turn is stable": w107 cut a separate "is deterministic" case,
 * because the call-dependent-step probe (w107g1-tb-nondet) reds that literal case
 * too. Equivalent mutant: the
 * `firstByCaps === 0` short-circuit (with nothing omitted the rounded index is 0
 * either way).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { windowTranscript, transcriptBudgetConfig, voiceSeedBudgetConfig } from '../src/host/transcriptBudget.js';

interface Turn { id: number; text: string }
const sizeOf = (t: Turn) => t.text.length;
const mk = (n: number, len = 10): Turn[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, text: 'x'.repeat(len) }));

afterEach(() => {
  delete process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_KEEP_TURNS;
  delete process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_MAX_CHARS;
  delete process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_STEP_TURNS;
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
    expect(transcriptBudgetConfig()).toEqual({ keepLastTurns: 20, maxChars: 24_000, stepTurns: 10 });
  });
  it('reads env overrides', () => {
    // An ODD cap: the default step is floor(7 / 2) = 3, so rounding it up (4)
    // or reading the default cap (10) both show.
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_KEEP_TURNS = '7';
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_MAX_CHARS = '5000';
    expect(transcriptBudgetConfig()).toEqual({ keepLastTurns: 7, maxChars: 5000, stepTurns: 3 });
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_STEP_TURNS = '4';
    expect(transcriptBudgetConfig().stepTurns).toBe(4);
  });
  it('ignores invalid env (falls back to defaults)', () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_KEEP_TURNS = 'nonsense';
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_MAX_CHARS = '-5';
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_STEP_TURNS = '0';
    expect(transcriptBudgetConfig()).toEqual({ keepLastTurns: 20, maxChars: 24_000, stepTurns: 10 });
  });
});

// ADR 1003 D2 — the window holds still between steps, so a provider prefix
// cache can hit. Sabotage: removing the round-up (or rounding DOWN, which
// breaks the caps) reds these cases.
describe('windowTranscript — stepped (ADR 1003 D2)', () => {
  const cfg = { keepLastTurns: 6, maxChars: 1_000_000, stepTurns: 3 };

  it('the first kept turn is stable across appends within a step, then jumps by one step', () => {
    const firsts: number[] = [];
    for (let n = 1; n <= 14; n++) firsts.push(windowTranscript(mk(n), cfg, sizeOf).kept[0].id);
    // Caps alone would give 0,0,0,0,0,0,1,2,3,4,5,6,7,8 (a new prefix every turn).
    expect(firsts).toEqual([0, 0, 0, 0, 0, 0, 3, 3, 3, 6, 6, 6, 9, 9]);
  });

  it('never keeps more than the caps allow, and always keeps the newest turn', () => {
    for (let n = 1; n <= 30; n++) {
      const { kept, omittedCount } = windowTranscript(mk(n), cfg, sizeOf);
      expect(kept.length).toBeLessThanOrEqual(cfg.keepLastTurns);
      // Stepping drops at most stepTurns − 1 turns below what the caps keep.
      expect(kept.length).toBeGreaterThan(Math.min(n, cfg.keepLastTurns) - cfg.stepTurns);
      expect(kept[kept.length - 1].id).toBe(n - 1);
      expect(omittedCount + kept.length).toBe(n);
    }
    // Char cap, stepped: 10-char turns under a 35-char cap keep 3 by the caps
    // (first 7), rounded up to 8 → [8, 9].
    const r = windowTranscript(mk(10), { keepLastTurns: 20, maxChars: 35, stepTurns: 4 }, sizeOf);
    expect(r.kept.map((t) => t.id)).toEqual([8, 9]);
    expect(r.omittedCount).toBe(8);
    // The newest turn survives a round-up past the end: one 1000-char turn fits
    // a 100-char cap (first 9), and 9 rounded up to 12 is clamped back to 9.
    const solo = windowTranscript(mk(10, 1000), { keepLastTurns: 20, maxChars: 100, stepTurns: 4 }, sizeOf);
    expect(solo.kept.map((t) => t.id)).toEqual([9]);
    expect(solo.omittedCount).toBe(9);
  });

  it('stepTurns 1 (or absent) is exactly the original slide-by-one window', () => {
    for (let n = 1; n <= 12; n++) {
      const a = windowTranscript(mk(n), { keepLastTurns: 5, maxChars: 1_000_000, stepTurns: 1 }, sizeOf);
      const b = windowTranscript(mk(n), { keepLastTurns: 5, maxChars: 1_000_000 }, sizeOf);
      expect(a.kept.map((t) => t.id)).toEqual(b.kept.map((t) => t.id));
      expect(b.kept[0].id).toBe(Math.max(0, n - 5));
    }
  });
});

// ADR 1003 D2 — the voice seed is composed once, so it never steps (stepping
// would only drop turns there). Sabotage: returning the stepped config reds it.
describe('voiceSeedBudgetConfig', () => {
  it('keeps the caps and never steps, whatever the step env says', () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_KEEP_TURNS = '6';
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_STEP_TURNS = '4';
    expect(voiceSeedBudgetConfig()).toEqual({ keepLastTurns: 6, maxChars: 24_000, stepTurns: 1 });
  });
});
