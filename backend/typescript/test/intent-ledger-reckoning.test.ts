/**
 * ADR 0136 Phase 4 — the pure authored-vs-completed reckoning.
 */
import { describe, it, expect } from 'vitest';
import { reckonLedger } from '../src/features/intent-ledger/ledgerReckoning.js';
import type { IntentLedgerStamp } from '../src/features/intent-ledger/types.js';

const stamp: IntentLedgerStamp = {
  conversationId: 'c1', goal: 'Draft the Q3 report',
  scope: { mode: 'restricted', enabled: ['kb.search', 'openwop:ai.research'], requireApproval: ['email.send'] },
  successCriteria: ['a report artifact exists', 'no external email sent without approval'],
};

describe('reckonLedger (ADR 0136 P4)', () => {
  it('summarizes authorized vs used + criteria needs-review, withinMandate when no blocks', () => {
    const r = reckonLedger(stamp, [
      { name: 'kb.search', status: 'ok' },
      { name: 'kb.search', status: 'ok' },          // dedup
      { name: 'openwop:ai.research', status: 'ok' },
    ]);
    expect(r.goal).toBe('Draft the Q3 report');
    expect(r.authorizedTools).toEqual(['kb.search', 'openwop:ai.research']);
    expect(r.gatedTools).toEqual(['email.send']);
    expect(r.usedTools.sort()).toEqual(['kb.search', 'openwop:ai.research']);
    expect(r.blockedToolAttempts).toEqual([]);
    expect(r.withinMandate).toBe(true);
    expect(r.successCriteria).toEqual([
      { text: 'a report artifact exists', status: 'needs-review' },
      { text: 'no external email sent without approval', status: 'needs-review' },
    ]);
  });

  it('a forbidden attempt ⇒ NOT withinMandate + listed in blockedToolAttempts', () => {
    const r = reckonLedger(stamp, [
      { name: 'kb.search', status: 'ok' },
      { name: 'crm.delete', status: 'forbidden' },
    ]);
    expect(r.blockedToolAttempts).toEqual(['crm.delete']);
    expect(r.withinMandate).toBe(false);
    expect(r.usedTools).toEqual(['kb.search']);
  });

  it('handles an empty event log', () => {
    const r = reckonLedger(stamp, []);
    expect(r.usedTools).toEqual([]);
    expect(r.withinMandate).toBe(true);
  });
});
