/**
 * ADR 0136 Phase 2 — the fail-closed ledger validation + the per-conversation store.
 *
 * CFP A13: the bespoke `llmExtractLedger`/`parseLedgerDraft`/`isComplexRequest`
 * managed-LLM extractor was removed — model-authored drafting now rides the
 * `openwop:intent-ledger.draft-contract` agent tool (see intent-ledger-agent-tools.test.ts).
 * This file keeps the pure `validateLedgerInput` gate + store CRUD coverage.
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { validateLedgerInput, getLedger, saveLedger } from '../src/features/intent-ledger/ledgerStore.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { IntentLedger } from '../src/features/intent-ledger/types.js';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('validateLedgerInput (fail-closed)', () => {
  it('accepts a well-formed draft', () => {
    expect(validateLedgerInput({ goal: 'g', allowed: ['a'], successCriteria: ['s'] })).toMatchObject({ goal: 'g', allowed: ['a'], forbidden: [], requireApproval: [], successCriteria: ['s'] });
  });
  it('rejects a missing goal + a non-string array + bad expiry', () => {
    expect(() => validateLedgerInput({})).toThrow();
    expect(() => validateLedgerInput({ goal: 'g', allowed: [1] })).toThrow();
    expect(() => validateLedgerInput({ goal: 'g', expiresAtRelMs: -5 })).toThrow();
  });
});

describe('ledgerStore CRUD (per-conversation)', () => {
  it('saves + reads back; absent → null', async () => {
    expect(await getLedger('t', 'missing')).toBeNull();
    const l: IntentLedger = { ledgerId: 'l', tenantId: 't', conversationId: 'c1', goal: 'g', allowed: [], forbidden: [], requireApproval: [], successCriteria: [], status: 'draft', proposedBy: 'extractor', createdAt: '2026-06-24T00:00:00Z' };
    await saveLedger(l);
    expect(await getLedger('t', 'c1')).toMatchObject({ ledgerId: 'l', status: 'draft' });
  });
});
