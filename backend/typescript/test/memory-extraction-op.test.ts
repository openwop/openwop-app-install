/**
 * ADR 0120 Phase 2 / ADR 0982 D5–D6 — the consent-gated extraction op, deps injected.
 *
 * Guards: no grant ⇒ no extractor call and no write (FAIL-CLOSED); every path returns a typed
 * outcome (a provider failure is never "no facts"); a fact already in memory, typed or learned, is
 * a duplicate; a fact the person deleted is suppressed; the lane's own budget (50 learned notes,
 * 10 slots of headroom under NOTE_CAP) is never exceeded; a per-fact write failure is counted and
 * never aborts the rest; the deadline stops further writes.
 *
 * Witnessed (row 57 sabotage, see the PR): removing the grant gate, the dedupe, the forgotten
 * check, either budget term, the per-fact catch or the signal check each reds its case.
 */
import { describe, it, expect, vi } from 'vitest';
import { runMemoryExtraction, AUTO_EXTRACT_CAP, HUMAN_HEADROOM, type ExtractionDeps } from '../src/features/memory-auto-extract/extractionOp.js';
import { NOTE_CAP } from '../src/host/subjectMemory.js';
import type { ExtractorResult } from '../src/features/memory-auto-extract/memoryExtractor.js';

const ok = (...facts: string[]): ExtractorResult => ({ status: 'ok', facts: facts.map((fact) => ({ fact, category: 'other' as const })), rejected: 0 });

function deps(over: Partial<ExtractionDeps> & { result?: ExtractorResult; existingNotes?: Array<{ content: string; source: string }> } = {}): ExtractionDeps & { written: string[]; extract: ReturnType<typeof vi.fn> } {
  const written: string[] = [];
  const extract = vi.fn(async () => over.result ?? ok());
  return {
    isGranted: async () => true,
    existing: async () => over.existingNotes ?? [],
    forgotten: async () => () => false,
    write: async (f) => { written.push(f); return 'written'; },
    ...over,
    extract,
    written,
  } as ExtractionDeps & { written: string[]; extract: ReturnType<typeof vi.fn> };
}

describe('runMemoryExtraction', () => {
  it('FAIL-CLOSED: no grant ⇒ no extractor call, no write', async () => {
    const d = deps({ isGranted: async () => false, result: ok('Keeps bees') });
    expect(await runMemoryExtraction(true, d)).toEqual({ status: 'skipped', reason: 'no-consent' });
    expect(d.extract).not.toHaveBeenCalled();
    expect(d.written).toEqual([]);
  });

  it('consent revoked DURING the model call ⇒ nothing written (MAE2CD-2)', async () => {
    let granted = true;
    const d = deps({ isGranted: async () => granted, result: ok('Keeps bees') });
    d.extract.mockImplementation(async () => { granted = false; return ok('Keeps bees'); });
    expect(await runMemoryExtraction(true, d)).toEqual({ status: 'skipped', reason: 'no-consent' });
    expect(d.written).toEqual([]);
  });

  it('no user text ⇒ skipped before the extractor', async () => {
    const d = deps({ result: ok('Keeps bees') });
    expect(await runMemoryExtraction(false, d)).toEqual({ status: 'skipped', reason: 'empty' });
    expect(d.extract).not.toHaveBeenCalled();
  });

  it('extractor failures pass through as typed outcomes, never as "no facts"', async () => {
    for (const result of [
      { status: 'failed', reason: 'provider-error' },
      { status: 'failed', reason: 'invalid-output' },
      { status: 'abandoned' },
    ] as ExtractorResult[]) {
      const d = deps({ result });
      expect(await runMemoryExtraction(true, d)).toEqual(result);
      expect(d.written).toEqual([]);
    }
  });

  it('distinguishes "found nothing" from "found only unsupported facts"', async () => {
    expect(await runMemoryExtraction(true, deps({ result: ok() }))).toEqual({ status: 'no-facts' });
    expect(await runMemoryExtraction(true, deps({ result: { status: 'ok', facts: [], rejected: 2 } }))).toEqual({ status: 'rejected', rejected: 2 });
  });

  it('dedupes against existing notes of ANY source, and within the batch', async () => {
    const d = deps({ result: ok('Keeps bees.', 'Lives in Lisbon', 'lives in  lisbon'), existingNotes: [{ content: 'keeps bees', source: 'user' }] });
    const r = await runMemoryExtraction(true, d);
    expect(d.written).toEqual(['Lives in Lisbon']);
    expect(r).toMatchObject({ status: 'written', written: 1, duplicates: 2 });
  });

  it('never re-learns a fact the person deleted', async () => {
    const d = deps({ result: ok('Keeps bees', 'Lives in Lisbon'), forgotten: async () => (t) => t === 'Keeps bees' });
    expect(await runMemoryExtraction(true, d)).toMatchObject({ status: 'written', written: 1, suppressed: 1 });
    expect(d.written).toEqual(['Lives in Lisbon']);
  });

  it('stops at the learned-note cap', async () => {
    const learned = Array.from({ length: AUTO_EXTRACT_CAP - 1 }, (_, i) => ({ content: `learned ${i}`, source: 'auto-extract' }));
    const d = deps({ result: ok('Fact one', 'Fact two'), existingNotes: learned });
    expect(await runMemoryExtraction(true, d)).toMatchObject({ status: 'written', written: 1, budgetFull: true });
    // …and a close that is ALL over budget, duplicate or forgotten is `nothing-new`, not a write.
    const full = deps({ result: ok('Fact one'), existingNotes: Array.from({ length: AUTO_EXTRACT_CAP }, (_, i) => ({ content: `l ${i}`, source: 'auto-extract' })) });
    expect(await runMemoryExtraction(true, full)).toEqual({ status: 'nothing-new', duplicates: 0, suppressed: 0, budgetFull: true });
  });

  it('always leaves the person HUMAN_HEADROOM slots under NOTE_CAP', async () => {
    const typed = Array.from({ length: NOTE_CAP - HUMAN_HEADROOM - 1 }, (_, i) => ({ content: `typed ${i}`, source: 'user' }));
    const d = deps({ result: ok('Fact one', 'Fact two'), existingNotes: typed });
    expect(await runMemoryExtraction(true, d)).toMatchObject({ status: 'written', written: 1, budgetFull: true });
  });

  it('a per-fact write failure is counted and never aborts the rest; a concurrent duplicate is a duplicate', async () => {
    const d = deps({
      result: ok('Fact one', 'Fact two', 'Fact three'),
      write: async (f) => { if (f === 'Fact one') throw new Error('store'); if (f === 'Fact two') return 'duplicate'; return 'written'; },
    });
    expect(await runMemoryExtraction(true, d)).toMatchObject({ status: 'written', written: 1, duplicates: 1, failedWrites: 1 });
    const all = deps({ result: ok('Fact one'), write: async () => { throw new Error('store'); } });
    expect(await runMemoryExtraction(true, all)).toEqual({ status: 'failed', reason: 'write-error' });
  });

  it('writes nothing once the deadline has passed', async () => {
    const ac = new AbortController(); ac.abort();
    const d = deps({ result: ok('Fact one'), signal: ac.signal });
    expect(await runMemoryExtraction(true, d)).toEqual({ status: 'abandoned' });
    expect(d.written).toEqual([]);
  });
});
