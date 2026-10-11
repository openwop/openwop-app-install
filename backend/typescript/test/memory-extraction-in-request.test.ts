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
 *
 * (Since ADR 0741 the service runs with CPU always allocated, so the 16-minute stall above no
 * longer reproduces in prod. The await stays correct regardless: a detached continuation is the
 * wrong shape, and the bound below is what keeps a hung provider from wedging the close.)
 *
 * Witnessed (wave 12 probes): racing a pre-resolved arm reds legs 1+2; ignoring the budget knob,
 * a too-late or zero bound reds leg 2; rethrowing from the catch reds leg 3; downgrading either
 * WARN to debug / deleting it reds leg 3 / leg 2 (asserted on the real emitted log line); removing
 * either short-circuit reds leg 4; an un-awaited call site reds leg 5.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunRecord } from '../src/types.js';
import type { ConversationTurn } from '../src/host/conversation.js';

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

const AT = '2026-01-01T00:00:00.000Z';
const run: RunRecord = {
  runId: 'r1', workflowId: 'w1', tenantId: 't1', status: 'completed', inputs: {},
  metadata: { actingUserId: 'user:abc' }, configurable: {}, createdAt: AT, updatedAt: AT,
};
const turns: ConversationTurn[] = [{ messageId: 'c1:0:user', turnIndex: 0, from: 'u', content: 'hello there', ts: 0, role: 'user' }];

// The real logger writes one JSON line per event to stdout; capture them so the WARN claim is
// asserted on what an operator actually sees, not on the source text.
let logLines: Array<{ level?: string; msg?: string; [k: string]: unknown }> = [];
const warned = (msg: string) => logLines.find((l) => l.level === 'warn' && l.msg === msg);

beforeEach(() => {
  extractSpy.mockReset();
  process.env['OPENWOP_MEMORY_EXTRACTION_BUDGET_MS'] = String(TEST_BUDGET_MS);
  logLines = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { logLines.push(JSON.parse(line)); } catch { /* not a log line */ }
    }
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { delete process.env['OPENWOP_MEMORY_EXTRACTION_BUDGET_MS']; });

describe('ADR 0699 D1 — extraction finishes IN-REQUEST', () => {
  it('leg 1: the call does not resolve until the extraction has finished', async () => {
    // A generous bound: this leg claims "awaits completion", not "beats the bound", so the 30 ms
    // extraction must never race a 40 ms budget on a contended machine.
    process.env['OPENWOP_MEMORY_EXTRACTION_BUDGET_MS'] = '5000';
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
    // …and said so, at WARN: a silent abandon is how a dead lane stays invisible.
    expect(warned('memory_extraction_abandoned'), 'the abandon is logged at warn').toMatchObject({ budgetMs: TEST_BUDGET_MS });
  });

  it('leg 3: a rejected extraction resolves the close (best-effort is still best-effort)', async () => {
    extractSpy.mockImplementation(async () => { throw new Error('provider down'); });
    await expect(maybeExtractMemoryOnClose(run, turns), 'a failure must not fail the close').resolves.toBeUndefined();
    // Best-effort, not silent: the failure is logged at WARN (not debug) with its cause.
    expect(warned('memory_extraction_failed'), 'the failure is logged at warn').toMatchObject({ error: 'provider down' });
  });

  it('leg 4: no acting user and empty transcripts short-circuit without calling extraction', async () => {
    // A well-behaved stub, so a removed guard reds the spy assertion below rather than a TypeError
    // from `.then` on the reset spy's `undefined`.
    extractSpy.mockResolvedValue({ extracted: 0, skipped: null });
    await maybeExtractMemoryOnClose({ ...run, metadata: {} }, turns);
    // NOTE: a blank MESSAGE is not an empty transcript — each turn renders as
    // `${from}: ${text}`, so "   " still yields "u:". The empty case is no turns.
    await maybeExtractMemoryOnClose(run, []);
    expect(extractSpy, 'neither path reaches the op').not.toHaveBeenCalled();
  });
});

// CEILING: leg 5 is a source-shape tripwire. The call-site await is wiring; asserting it
// behaviourally needs a `handleConversationResolve` harness (the conversation stack), which costs
// far more than the claim. `void maybeExtractMemoryOnClose(...)` reds it (probe witnessed).
describe('ADR 0699 D1 — the shape, pinned', () => {
  it('leg 5: the close-hook call site AWAITS — a bare call would restore the defect', () => {
    const src = codeOf(join(SRC, 'host', 'conversationExchange.ts'));
    expect(src, 'the fire-and-forget shape must not return').toMatch(/await maybeExtractMemoryOnClose\(/);
    expect(src, 'and must not be called un-awaited').not.toMatch(/^\s*maybeExtractMemoryOnClose\(/m);
  });
  // leg 6 (a source grep for `logger.warn(...)`) was replaced in wave 12 by the behavioural
  // log-line assertions in legs 2 and 3.
});
