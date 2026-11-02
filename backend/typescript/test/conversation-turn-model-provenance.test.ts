/**
 * ADR 0124 Phase 2d / RFC 0109 — the model-provenance stamp (`agent.model`) resolved for
 * the answering agent's turn. Resolves run inputs → a legacy stamp the conversation
 * can call → this turn's route (ADR 1016) → per-exchange override; non-secret;
 * `undefined` when unresolved.
 *
 * TST-CKC-9. Red when the 'unknown' model sentinel is stamped as a model (case 4)
 * or the per-exchange override stops taking precedence (case 3).
 */
import { describe, it, expect } from 'vitest';
import { resolveModelProvenance } from '../src/host/conversationExchange.js';
import type { RunRecord } from '../src/types.js';

const run = (inputs: Record<string, unknown>, metadata: Record<string, unknown> = {}): RunRecord => ({
  runId: 'r', workflowId: 'openwop-app.conversation', tenantId: 't', status: 'waiting-input',
  inputs, metadata, configurable: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('resolveModelProvenance (ADR 0124 Phase 2d / RFC 0109)', () => {
  it('resolves { provider, model } from run inputs', () => {
    expect(resolveModelProvenance(run({ provider: 'anthropic', model: 'claude-opus-4-8' })))
      .toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' });
  });

  it('a legacy stamped modelRoute the conversation can call takes precedence over run inputs', () => {
    expect(resolveModelProvenance(run({ provider: 'anthropic', model: 'claude-haiku-4-5', credentialRef: 'anthropic' }, { modelRoute: { provider: 'anthropic', model: 'claude-opus-4-8' } })))
      .toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' });
  });

  it('ADR 1016 (MRC-4) — a managed conversation\'s stamp is NOT provenance: dispatch never honoured it', () => {
    // No ref = the managed default. The managed tier answered, so naming the stamped
    // model would be a false RFC 0109 `agent.model`.
    expect(resolveModelProvenance(run({ provider: 'openai', model: 'gpt-x' }, { modelRoute: { provider: 'anthropic', model: 'claude-opus-4-8' } })))
      .toEqual({ provider: 'openai', model: 'gpt-x' });
  });

  it('ADR 1016 D3 — this turn\'s ROUTE is the provenance (it is what dispatched)', () => {
    expect(resolveModelProvenance(run({ provider: 'anthropic', model: 'claude-haiku-4-5', credentialRef: 'anthropic' }), undefined, undefined, { provider: 'anthropic', model: 'claude-opus-5-5' }))
      .toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
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
