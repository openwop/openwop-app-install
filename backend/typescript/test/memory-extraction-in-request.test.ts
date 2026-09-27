/**
 * ADR 0699 — the extraction ran where CPU is not guaranteed, and said nothing when it
 * did not finish.
 *
 * `maybeExtractMemoryOnClose` was fire-and-forget one line before
 * `handleConversationResolve` returns, so an LLM call taking seconds continued after
 * the response flushed. `ARCHITECTURE.md:147` measures that shape under Cloud Run's
 * `cpu-throttling=true` as "effectively never" resumed (16+ min, #3056) and names
 * awaiting in-request as the only place CPU is guaranteed.
 *
 * BORN RED: before the fix the function returned `void` synchronously, so leg 1's
 * "the work is finished when the call resolves" could not hold.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const codeOf = (p: string): string =>
  readFileSync(p, 'utf8').split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  }).join('\n');

const extractSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/features/memory-auto-extract/extractionBinding.js', () => ({
  extractConversationMemory: extractSpy,
}));
vi.mock('../src/features/memory-auto-extract/memoryExtractor.js', () => ({
  llmExtractFacts: vi.fn(async () => []),
}));

const { maybeExtractMemoryOnClose, memoryExtractionBudgetMs } =
  await import('../src/host/exchange/persistExchange.js');

// Real timers with a tiny budget, NOT fake timers. The first cut used
// `vi.useFakeTimers()` here; when leg 2's assertion failed, its `finally` restore did
// not take effect before the cascade and the fake clock POISONED legs 3 and 4 plus the
// beforeEach hook (30s timeout). Three red legs, one real cause — and the two
// "failures" downstream were artifacts of the instrument, not the subject.
const TEST_BUDGET_MS = 40;

const run = { tenantId: 't1', metadata: { actingUserId: 'user:abc' } } as never;
const turns = [{ role: 'user', from: 'u', content: 'hello there' }] as never;

beforeEach(() => {
  extractSpy.mockReset();
  process.env['OPENWOP_MEMORY_EXTRACTION_BUDGET_MS'] = String(TEST_BUDGET_MS);
});

describe('ADR 0699 D1 — extraction finishes IN-REQUEST', () => {
  it('leg 1: the call does not resolve until the extraction has finished', async () => {
    let settled = false;
    extractSpy.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      settled = true;
      return { extracted: 1, skipped: null };
    });
    await maybeExtractMemoryOnClose(run, turns);
    // The whole point: the caller awaits, so by the time we are here the work is DONE.
    // Under the old fire-and-forget shape this was false by construction.
    expect(settled, 'awaiting the close means the extraction really ran').toBe(true);
  });

  it('leg 2: a hung extraction is ABANDONED at the budget — close is never wedged', async () => {
    expect(memoryExtractionBudgetMs(), 'the knob is in effect, or this leg proves nothing').toBe(TEST_BUDGET_MS);
    extractSpy.mockImplementation(() => new Promise(() => { /* never settles */ }));
    const started = Date.now();
    await maybeExtractMemoryOnClose(run, turns);
    const waited = Date.now() - started;
    // It RETURNED despite the extraction never settling — that is the invariant.
    expect(waited, 'it waited for the bound').toBeGreaterThanOrEqual(TEST_BUDGET_MS - 5);
    expect(waited, 'and then gave up rather than wedging the close').toBeLessThan(TEST_BUDGET_MS + 2000);
  });

  it('leg 3: a rejected extraction resolves the close (best-effort is still best-effort)', async () => {
    extractSpy.mockImplementation(async () => { throw new Error('provider down'); });
    await expect(maybeExtractMemoryOnClose(run, turns), 'a failure must not fail the close').resolves.toBeUndefined();
  });

  it('leg 4: no acting user and empty transcripts short-circuit without calling extraction', async () => {
    await maybeExtractMemoryOnClose({ tenantId: 't1', metadata: {} } as never, turns);
    // NOTE: a blank MESSAGE is not an empty transcript — each turn renders as
    // `${from}: ${text}`, so "   " still yields "u:". The empty case is no turns.
    await maybeExtractMemoryOnClose(run, [] as never);
    expect(extractSpy, 'neither path reaches the op').not.toHaveBeenCalled();
  });
});

describe('ADR 0699 D1 — the shape, pinned', () => {
  it('leg 5: the close-hook call site AWAITS — a bare call would restore the defect', () => {
    const src = codeOf(join(SRC, 'host', 'conversationExchange.ts'));
    expect(src, 'the fire-and-forget shape must not return').toMatch(/await maybeExtractMemoryOnClose\(/);
    expect(src, 'and must not be called un-awaited').not.toMatch(/^\s*maybeExtractMemoryOnClose\(/m);
  });

  it('leg 6: the failure is logged at WARN, not debug', () => {
    const src = codeOf(join(SRC, 'host', 'exchange', 'persistExchange.ts'));
    expect(src, 'a debug swallow is how a dead lane stays invisible').not.toMatch(/logger\.debug\([^)]*memory[ _]extraction/i);
    expect(src).toMatch(/logger\.warn\('memory_extraction_failed'/);
    expect(src).toMatch(/logger\.warn\('memory_extraction_abandoned'/);
  });
});
