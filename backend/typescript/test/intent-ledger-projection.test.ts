/**
 * ADR 0136 Phase 1 — the pure ledger→scope projection + the run.metadata stamps.
 *
 * ADR 0896 D4: one stamp per APPROVAL, append-only. The stamp carries the run's TTL
 * anchor, the one thing a `:fork` reads back. What turns it red: rewriting an existing
 * entry (a fork would restart the clock), stamping a non-approved ledger, dropping
 * other metadata keys, matching a stamp of another approval (the anchor of an earlier
 * mission would expire a new one), or letting a new approval inherit a legacy stamp.
 */
import { describe, it, expect } from 'vitest';
import { ledgerToScope, readApprovalStamp, readIntentLedgerStamp, withApprovalStamp, INTENT_LEDGER_KEY, INTENT_LEDGER_APPROVALS_KEY } from '../src/features/intent-ledger/ledgerProjection.js';
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

describe('withApprovalStamp (ADR 0896 D4 — one stamp per approval)', () => {
  const approved: IntentLedger = { ...base, approvedAt: '2026-06-24T00:00:00.000Z' };
  const KEY = 'l1@2026-06-24T00:00:00.000Z';
  it('stamps an APPROVED ledger under its approval key (scope config + goal + criteria + TTL + anchor)', () => {
    const out = withApprovalStamp({}, approved, '2026-06-24T01:00:00.000Z');
    expect((out![INTENT_LEDGER_APPROVALS_KEY] as Record<string, unknown>)[KEY]).toEqual({
      ledgerId: 'l1', approvedAt: '2026-06-24T00:00:00.000Z', conversationId: 'c',
      scope: { mode: 'restricted', enabled: ['kb.search', 'openwop:ai.research'], disabled: ['email.send'], requireApproval: ['crm.contact.update'] },
      goal: 'Draft the Q3 report', successCriteria: ['a report artifact exists'], expiresAtRelMs: 3_600_000,
      resolvedAt: '2026-06-24T01:00:00.000Z',
    });
  });
  it('does NOT stamp a draft/rejected ledger (only approved governs a run)', () => {
    expect(withApprovalStamp({}, { ...approved, status: 'draft' }, 'x')).toBeNull();
    expect(withApprovalStamp({}, null, 'x')).toBeNull();
  });
  it('REPLAY GUARD — never rewrites this approval\'s entry (a fork re-reads the recorded anchor)', () => {
    const once = withApprovalStamp({}, approved, 'first')!;
    expect(withApprovalStamp(once, approved, 'second')).toBeNull();
    expect(readApprovalStamp(once, approved)?.resolvedAt).toBe('first');
  });
  it('APPENDS a later approval beside the earlier one (a conversation-long run sees both)', () => {
    const a = withApprovalStamp({ modelRoute: { provider: 'anthropic' } }, approved, 'first')!;
    const later: IntentLedger = { ...approved, approvedAt: '2026-06-25T00:00:00.000Z' };
    const b = withApprovalStamp(a, later, 'second')!;
    expect(readApprovalStamp(b, approved)?.resolvedAt).toBe('first');
    expect(readApprovalStamp(b, later)?.resolvedAt).toBe('second');
    expect(b).toMatchObject({ modelRoute: { provider: 'anthropic' } });
  });
});

describe('readApprovalStamp / readIntentLedgerStamp', () => {
  it('a stamp of ANOTHER approval never matches; a legacy stamp matches only a legacy row', () => {
    const approved: IntentLedger = { ...base, approvedAt: '2026-06-24T00:00:00.000Z' };
    const md = withApprovalStamp({}, approved, 'x')!;
    expect(readApprovalStamp(md, { ...approved, approvedAt: '2026-06-25T00:00:00.000Z' })).toBeNull();
    expect(readApprovalStamp(md, { ...approved, ledgerId: 'l2' })).toBeNull();
    const legacyMd = { [INTENT_LEDGER_KEY]: { conversationId: 'c', scope: { mode: 'restricted' }, goal: 'g', successCriteria: [], resolvedAt: 'legacy-anchor' } };
    expect(readApprovalStamp(legacyMd, base)?.resolvedAt).toBe('legacy-anchor'); // legacy row (no approvedAt)
    expect(readApprovalStamp(legacyMd, approved)).toBeNull(); // a new approval never inherits it
  });
  it('reads a well-formed legacy stamp; null on malformed/absent', () => {
    const md = { [INTENT_LEDGER_KEY]: { conversationId: 'c', scope: { mode: 'restricted' }, goal: 'Draft the Q3 report', successCriteria: [], expiresAtRelMs: 3_600_000, resolvedAt: 'x' } };
    expect(readIntentLedgerStamp(md)).toMatchObject({ conversationId: 'c', goal: 'Draft the Q3 report', expiresAtRelMs: 3_600_000, resolvedAt: 'x' });
    expect(readIntentLedgerStamp(undefined)).toBeNull();
    expect(readIntentLedgerStamp({ [INTENT_LEDGER_KEY]: { goal: 'x' } })).toBeNull(); // no scope
  });
});
