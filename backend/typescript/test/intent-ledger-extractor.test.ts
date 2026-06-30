/**
 * ADR 0136 Phase 2 — the pure complexity gate + ledger-draft parser + store.
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { parseLedgerDraft, isComplexRequest } from '../src/features/intent-ledger/ledgerExtractor.js';
import { validateLedgerInput, getLedger, saveLedger } from '../src/features/intent-ledger/ledgerStore.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { IntentLedger } from '../src/features/intent-ledger/types.js';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

const ceiling = ['kb.search', 'openwop:ai.research', 'core.openwop.integration.email-send'];

describe('isComplexRequest (over-friction guard)', () => {
  it('true for a long request', () => { expect(isComplexRequest('x'.repeat(300), [])).toBe(true); });
  it('true when the ceiling has a write/exec tool', () => { expect(isComplexRequest('hi', ['core.openwop.integration.email-send'])).toBe(true); });
  it('false for a trivial chat with read-only tools', () => { expect(isComplexRequest('what time is it?', ['kb.search'])).toBe(false); });
});

describe('parseLedgerDraft (pure, defensive, ceiling-intersected)', () => {
  it('parses JSON + intersects allowed/requireApproval with the ceiling', () => {
    const raw = 'Here: {"goal":"Draft report","allowed":["kb.search","not.a.tool"],"forbidden":["core.openwop.integration.email-send"],"requireApproval":["openwop:ai.research"],"successCriteria":["report exists"],"expiresAtRelMs":3600000} done';
    const d = parseLedgerDraft(raw, ceiling);
    expect(d).toEqual({
      goal: 'Draft report', allowed: ['kb.search'], forbidden: ['core.openwop.integration.email-send'],
      requireApproval: ['openwop:ai.research'], successCriteria: ['report exists'], expiresAtRelMs: 3600000,
    });
  });
  it('NEVER throws on malformed output — returns a safe partial', () => {
    expect(parseLedgerDraft('not json at all', ceiling)).toEqual({ goal: '', allowed: [], forbidden: [], requireApproval: [], successCriteria: [] });
    expect(parseLedgerDraft('{bad json', ceiling)).toMatchObject({ goal: '' });
  });
  it('drops tools not in the ceiling (never propose beyond ceiling)', () => {
    const d = parseLedgerDraft('{"goal":"g","allowed":["ghost.tool"],"requireApproval":["other.ghost"]}', ceiling);
    expect(d.allowed).toEqual([]); expect(d.requireApproval).toEqual([]);
  });
});

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
