/**
 * ENG-10 (docs/steward/CODEBASE-ASSESSMENT.md): the empty-completion diagnostic, extracted
 * from the bootstrap/nodes.ts god module, is now independently testable.
 *
 * Tracker TST-CXE-4. Red when (bootstrap/emptyCompletionDiagnostic.ts): the
 * blockReason branch stops winning; `max_tokens` stops being a max-tokens
 * finish; the Gemini 2.5 reasoning branch is removed or reaches `-lite`; or the
 * no-finishReason fallback changes its diagnosis.
 */
import { describe, it, expect } from 'vitest';
import { diagnoseEmptyCompletion } from '../src/bootstrap/emptyCompletionDiagnostic.js';
import type { DispatchResult } from '../src/providers/dispatch.js';

const base = (over: Partial<DispatchResult>): DispatchResult => ({
  ...over,
  provider: over.provider ?? 'anthropic',
  model: over.model ?? 'claude-x',
  completion: over.completion ?? '',
});

describe('diagnoseEmptyCompletion', () => {
  it('prefers an authoritative blockReason', () => {
    const msg = diagnoseEmptyCompletion(base({ blockReason: 'SAFETY' }));
    expect(msg).toMatch(/blocked by anthropic \(SAFETY\)/i);
    expect(msg).toContain('[provider=anthropic');
  });

  it('reports a max-tokens finish', () => {
    expect(diagnoseEmptyCompletion(base({ finishReason: 'max_tokens' }))).toMatch(/max-tokens/i);
  });

  it('special-cases a Gemini 2.5 clean STOP with zero output', () => {
    const msg = diagnoseEmptyCompletion(base({ provider: 'google', model: 'gemini-2.5-pro', finishReason: 'STOP' }));
    expect(msg).toMatch(/internal reasoning consumed/i);
    // The no-reasoning `-lite` model is excluded from that diagnosis.
    const lite = diagnoseEmptyCompletion(base({ provider: 'google', model: 'gemini-2.5-flash-lite', finishReason: 'STOP' }));
    expect(lite).not.toMatch(/internal reasoning consumed/i);
    expect(lite).toMatch(/^Provider stopped cleanly with zero visible text\./);
  });

  it('falls back when there is no finishReason at all', () => {
    expect(diagnoseEmptyCompletion(base({}))).toMatch(/no finishReason/i);
  });
});
