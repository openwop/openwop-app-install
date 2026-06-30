/**
 * ENG-10 (CODEBASE-ASSESSMENT.md): the empty-completion diagnostic, extracted
 * from the bootstrap/nodes.ts god module, is now independently testable.
 */
import { describe, it, expect } from 'vitest';
import { diagnoseEmptyCompletion } from '../src/bootstrap/emptyCompletionDiagnostic.js';
import type { DispatchResult } from '../src/providers/dispatch.js';

const base = (over: Partial<DispatchResult>): DispatchResult =>
  ({ provider: 'anthropic', model: 'claude-x', completion: '', ...over } as DispatchResult);

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
  });

  it('falls back when there is no finishReason at all', () => {
    expect(diagnoseEmptyCompletion(base({}))).toMatch(/no finishReason/i);
  });
});
