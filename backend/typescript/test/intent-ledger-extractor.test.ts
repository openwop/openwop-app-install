/**
 * ADR 0136 Phase 2 — the fail-closed `validateLedgerInput` gate.
 *
 * CFP A13: the bespoke `llmExtractLedger`/`parseLedgerDraft`/`isComplexRequest`
 * managed-LLM extractor was removed — model-authored drafting now rides the
 * `openwop:intent-ledger.draft-contract` agent tool (see intent-ledger-agent-tools.test.ts),
 * and both it and the REST /draft route run THIS validator, so it is the closed-world
 * gate model output passes before it reaches the store.
 *
 * What turns it red (sabotage-probed, /grade-tests w29): dropping the goal guard
 * (a blank goal is accepted), widening the string-array check, accepting a
 * non-positive expiry, or not defaulting absent arrays to [].
 * (Store save/read-back was cut in w29: `getLedger` mis-keying reds
 * intent-ledger-agent-tools 'the owner drafts a contract…' and 'refuses to clobber…'.)
 */
import { describe, it, expect } from 'vitest';
import { validateLedgerInput } from '../src/features/intent-ledger/ledgerStore.js';

describe('validateLedgerInput (fail-closed)', () => {
  it('accepts a well-formed draft', () => {
    expect(validateLedgerInput({ goal: 'g', allowed: ['a'], successCriteria: ['s'] })).toEqual({ goal: 'g', allowed: ['a'], forbidden: [], requireApproval: [], successCriteria: ['s'] });
  });
  it('rejects a missing or blank goal', () => {
    expect(() => validateLedgerInput({})).toThrow(/goal is required/);
    expect(() => validateLedgerInput({ goal: '   ' })).toThrow(/goal is required/);
  });
  it('rejects a non-string array', () => {
    expect(() => validateLedgerInput({ goal: 'g', allowed: [1] })).toThrow(/allowed MUST be a string array/);
  });
  it('rejects a non-positive expiry', () => {
    expect(() => validateLedgerInput({ goal: 'g', expiresAtRelMs: -5 })).toThrow(/expiresAtRelMs MUST be a positive/);
  });
});
