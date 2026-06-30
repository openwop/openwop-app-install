/**
 * ADR 0124 Phase 2d / RFC 0109 — the model-provenance stamp (`agent.model`) resolved for
 * the answering agent's turn. Resolves run inputs → stamped modelRoute → per-exchange
 * override; non-secret; `undefined` when unresolved.
 */
import { describe, it, expect } from 'vitest';
import { resolveModelProvenance } from '../src/host/conversationExchange.js';
import type { RunRecord } from '../src/types.js';

const run = (inputs: Record<string, unknown>, metadata: Record<string, unknown> = {}): RunRecord =>
  ({ runId: 'r', tenantId: 't', inputs, metadata } as unknown as RunRecord);

describe('resolveModelProvenance (ADR 0124 Phase 2d / RFC 0109)', () => {
  it('resolves { provider, model } from run inputs', () => {
    expect(resolveModelProvenance(run({ provider: 'anthropic', model: 'claude-opus-4-8' })))
      .toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' });
  });

  it('a stamped modelRoute (read verbatim, :fork-safe) takes precedence over run inputs', () => {
    expect(resolveModelProvenance(run({ provider: 'openai', model: 'gpt-x' }, { modelRoute: { provider: 'anthropic', model: 'claude-opus-4-8' } })))
      .toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' });
  });

  it('a per-exchange override is HIGHEST precedence (the in-chat selector)', () => {
    expect(resolveModelProvenance(run({ provider: 'anthropic', model: 'claude-opus-4-8' }), { provider: 'google', model: 'gemini-x' }))
      .toEqual({ provider: 'google', model: 'gemini-x' });
  });

  it('returns undefined when the model is unresolved (no meaningless stamp)', () => {
    expect(resolveModelProvenance(run({ provider: 'anthropic' }))).toBeUndefined(); // no model
    expect(resolveModelProvenance(run({}))).toBeUndefined();                        // nothing
  });
});
