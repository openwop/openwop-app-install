/**
 * ADR 0120 Phase 2 — the consent-gated extraction op, at the unit layer (deps injected).
 *
 * Guards: no grant ⇒ no LLM call and no write (FAIL-CLOSED); facts are trimmed, blanks dropped,
 * and at most MAX_FACTS (10) written, in order; an empty transcript is skipped before the LLM.
 * Trust is NOT this op's job — the binding stamps `source:'auto-extract'` ⇒ untrusted, pinned
 * in `memory-extraction-binding.test.ts` (AGMEM-2).
 *
 * Witnessed (wave 12 probes): removing the `isGranted` gate, the `.trim()` map, the blank
 * filter, the `.slice(0, MAX_FACTS)` cap, changing MAX_FACTS, or the empty-transcript check
 * each reds its case.
 */
import { describe, it, expect, vi } from 'vitest';
import { runMemoryExtraction, type ExtractionDeps } from '../src/features/memory-auto-extract/extractionOp.js';

function deps(granted: boolean, facts: string[]): ExtractionDeps & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    isGranted: async () => granted,
    extract: async () => facts,
    addNote: async (_t, _s, fact) => { written.push(fact); },
  };
}

describe('runMemoryExtraction', () => {
  it('FAIL-CLOSED: no grant ⇒ nothing extracted, addNote NEVER called', async () => {
    const d = deps(false, ['the user likes cats']);
    const extractSpy = vi.spyOn(d, 'extract');
    const r = await runMemoryExtraction('t', 'user:a', 'I love cats', d);
    expect(r).toEqual({ extracted: 0, skipped: 'no-consent' });
    expect(d.written).toHaveLength(0);
    expect(extractSpy).not.toHaveBeenCalled(); // no LLM call without consent
  });

  it('with consent, extracts + writes each trimmed, non-blank fact via addNote', async () => {
    const d = deps(true, ['likes cats', 'lives in Berlin', '  ', 'works in design']);
    const r = await runMemoryExtraction('t', 'user:a', 'chat text', d);
    expect(r).toEqual({ extracted: 3, skipped: null }); // blank filtered
    expect(d.written).toEqual(['likes cats', 'lives in Berlin', 'works in design']);
  });

  it('caps the number of facts written', async () => {
    const d = deps(true, Array.from({ length: 25 }, (_, i) => `fact ${i}`));
    const r = await runMemoryExtraction('t', 'user:a', 'x', d);
    // EXACTLY the first ten, in order — `<= 10` passed at 0, at 9, or for any smaller cap.
    expect(r).toEqual({ extracted: 10, skipped: null });
    expect(d.written).toEqual(Array.from({ length: 10 }, (_, i) => `fact ${i}`));
  });

  it('skips empty conversation', async () => {
    const d = deps(true, ['x']);
    expect(await runMemoryExtraction('t', 'user:a', '   ', d)).toEqual({ extracted: 0, skipped: 'empty' });
    expect(d.written).toHaveLength(0);
  });
});
