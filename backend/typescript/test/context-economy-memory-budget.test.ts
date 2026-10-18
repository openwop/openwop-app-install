/**
 * ADR 0148 Phase 4 (A4) — memory injection budget (the SOFT policy; the RFC 0113
 * hard policy is witnessed by rfc0113-memory-budget.test.ts).
 *
 * Guards: `budgetByChars` keeps a contiguous priority-order PREFIX within the char
 * budget (it stops at the first overflow — it never skips an item to pack a
 * smaller later one), always keeps the first item under the soft policy, and never
 * mutates its input; `memoryBudgetConfig` reads OPENWOP_CONTEXT_ECONOMY_MEMORY_MAX_CHARS
 * (default 8000, invalid ⇒ default).
 *
 * Sabotage (grade-tests w28): `break`→`continue`, dropping the keep-first
 * exemption, widening the cap, mutating the items, or renaming the env knob each
 * turn a case red.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { budgetByChars, memoryBudgetConfig } from '../src/host/memoryBudget.js';

interface Item { id: number; content: string }
const sizeOf = (i: Item) => i.content.length;
const mk = (n: number, len = 100): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, content: 'x'.repeat(len) }));
const mkSizes = (sizes: number[]): Item[] => sizes.map((len, id) => ({ id, content: 'x'.repeat(len) }));

afterEach(() => {
  delete process.env.OPENWOP_CONTEXT_ECONOMY_MEMORY_MAX_CHARS;
});

describe('budgetByChars', () => {
  it('keeps everything under budget, in priority order', () => {
    const items = mk(3, 100);
    expect(budgetByChars(items, 10_000, sizeOf)).toEqual(items);
  });

  it('drops overflow from the TAIL (lowest priority), keeping the front', () => {
    const items = mkSizes([100, 100, 200, 10]);
    const kept = budgetByChars(items, 250, sizeOf);
    // 100+100=200 ok; item 2 (400>250) STOPS — item 3 (would total 210) is not packed in.
    expect(kept.map((i) => i.id)).toEqual([0, 1]);
  });

  it('always keeps the first item even if it alone exceeds the budget', () => {
    const items = mk(3, 1000);
    expect(budgetByChars(items, 100, sizeOf).map((i) => i.id)).toEqual([0]);
  });

  it('empty input → empty', () => {
    expect(budgetByChars([], 100, sizeOf)).toEqual([]);
  });

  it('does not mutate the input', () => {
    const items = mk(5, 100);
    const snap = JSON.stringify(items);
    budgetByChars(items, 150, sizeOf);
    expect(JSON.stringify(items)).toBe(snap);
  });
});

describe('memoryBudgetConfig', () => {
  it('defaults to 8000 chars', () => {
    expect(memoryBudgetConfig()).toEqual({ maxChars: 8_000 });
  });
  it('reads env override', () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_MEMORY_MAX_CHARS = '3000';
    expect(memoryBudgetConfig()).toEqual({ maxChars: 3000 });
  });
  it('ignores invalid env', () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_MEMORY_MAX_CHARS = '0';
    expect(memoryBudgetConfig()).toEqual({ maxChars: 8_000 });
  });
});
