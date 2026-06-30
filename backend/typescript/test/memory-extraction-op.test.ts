/**
 * ADR 0120 Phase 2 — consent-gated extraction op (fail-closed).
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

  it('with consent, extracts + writes each fact (untrusted, via addNote)', async () => {
    const d = deps(true, ['likes cats', 'lives in Berlin', '  ', 'works in design']);
    const r = await runMemoryExtraction('t', 'user:a', 'chat text', d);
    expect(r.extracted).toBe(3); // blank filtered
    expect(d.written).toEqual(['likes cats', 'lives in Berlin', 'works in design']);
  });

  it('caps the number of facts written', async () => {
    const d = deps(true, Array.from({ length: 25 }, (_, i) => `fact ${i}`));
    const r = await runMemoryExtraction('t', 'user:a', 'x', d);
    expect(r.extracted).toBeLessThanOrEqual(10);
    expect(d.written.length).toBeLessThanOrEqual(10);
  });

  it('skips empty conversation', async () => {
    const d = deps(true, ['x']);
    expect(await runMemoryExtraction('t', 'user:a', '   ', d)).toEqual({ extracted: 0, skipped: 'empty' });
    expect(d.written).toHaveLength(0);
  });
});
