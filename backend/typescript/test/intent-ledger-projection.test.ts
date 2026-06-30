/**
 * ADR 0136 Phase 1 — the pure ledger→scope projection + the run.metadata stamp.
 */
import { describe, it, expect } from 'vitest';
import { ledgerToScope, computeIntentLedgerStamp, readIntentLedgerStamp, INTENT_LEDGER_KEY } from '../src/features/intent-ledger/ledgerProjection.js';
import type { IntentLedger } from '../src/features/intent-ledger/types.js';

const base: IntentLedger = {
  ledgerId: 'l1', tenantId: 't', conversationId: 'c', goal: 'Draft the Q3 report',
  allowed: ['kb.search', 'openwop:ai.research'], forbidden: ['email.send'], requireApproval: ['crm.contact.update'],
  successCriteria: ['a report artifact exists'], expiresAtRelMs: 3_600_000,
  status: 'approved', proposedBy: 'extractor', createdAt: '2026-06-24T00:00:00.000Z',
};

describe('ledgerToScope', () => {
  it('projects allowed/forbidden/requireApproval onto the ADR 0132 scope', () => {
    expect(ledgerToScope(base)).toEqual({
      mode: 'restricted', enabled: ['kb.search', 'openwop:ai.research'], disabled: ['email.send'], requireApproval: ['crm.contact.update'],
    });
  });
});

describe('computeIntentLedgerStamp', () => {
  it('stamps an APPROVED ledger (scope config + goal + successCriteria + relative TTL)', () => {
    const out = computeIntentLedgerStamp({}, base, '2026-06-24T00:00:00.000Z');
    expect(out![INTENT_LEDGER_KEY]).toMatchObject({
      scope: { mode: 'restricted', enabled: ['kb.search', 'openwop:ai.research'] },
      goal: 'Draft the Q3 report', successCriteria: ['a report artifact exists'], expiresAtRelMs: 3_600_000,
    });
  });
  it('does NOT stamp a draft/rejected ledger (only approved governs a run)', () => {
    expect(computeIntentLedgerStamp({}, { ...base, status: 'draft' }, 'x')).toBeNull();
    expect(computeIntentLedgerStamp({}, null)).toBeNull();
  });
  it('REPLAY GUARD — returns null when already stamped', () => {
    expect(computeIntentLedgerStamp({ [INTENT_LEDGER_KEY]: { scope: {}, goal: 'old', successCriteria: [] } }, base)).toBeNull();
  });
  it('preserves other metadata keys', () => {
    const out = computeIntentLedgerStamp({ modelRoute: { provider: 'anthropic' } }, base);
    expect(out).toMatchObject({ modelRoute: { provider: 'anthropic' }, [INTENT_LEDGER_KEY]: { goal: 'Draft the Q3 report' } });
  });
});

describe('readIntentLedgerStamp', () => {
  it('reads a well-formed stamp; null on malformed/absent', () => {
    const md = computeIntentLedgerStamp({}, base, 'x')!;
    expect(readIntentLedgerStamp(md)).toMatchObject({ goal: 'Draft the Q3 report', expiresAtRelMs: 3_600_000 });
    expect(readIntentLedgerStamp(undefined)).toBeNull();
    expect(readIntentLedgerStamp({ [INTENT_LEDGER_KEY]: { goal: 'x' } })).toBeNull(); // no scope
  });
});
