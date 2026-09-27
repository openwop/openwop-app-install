/**
 * Per-tenant tamper-evident audit hash-chain (ADR 0301 / CDP-F).
 *
 * Covers:
 *   1. genesis (seq 0, prevHash '0'*64) + sequential appends chain correctly —
 *      each entry's prevHash equals the prior entry's entryHash;
 *   2. CONCURRENCY — N simultaneous appends for ONE tenant produce contiguous
 *      seqs 1..N with no gaps/dupes and a chain that verifies (the CAS +
 *      per-tenant mutex hold; the chain never forks);
 *   3. verifyChain → ok on a clean chain, brokenAt on a store-mutated payload;
 *   4. per-tenant isolation (tenant A's appends never touch B's chain);
 *   5. the seeded consent + approval appends land on the chain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  appendAudit,
  verifyChain,
  listChain,
  getAuditHead,
  canonicalize,
  __resetAuditChain,
  __tamperEntryForTest,
  AUDIT_KIND_CONSENT_CHANGE,
  AUDIT_KIND_GOVERNANCE_DECISION,
} from '../src/host/auditChainService.js';
import { recordConsent, __resetConsentStore } from '../src/features/consent/consentService.js';
import { createApproval, resolveApproval, __resetApprovalStore } from '../src/host/approvalService.js';

const GENESIS_PREV = '0'.repeat(64);

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});
afterAll(() => { __resetHostExtPersistence(); });
beforeEach(async () => { await __resetAuditChain(); });

describe('audit hash-chain — genesis + sequential integrity', () => {
  it('lazily creates a genesis seq-0 entry and chains each append to the prior hash', async () => {
    const t = 'org:seq';
    const e1 = await appendAudit(t, 'k', { n: 1 });
    const e2 = await appendAudit(t, 'k', { n: 2 });
    const e3 = await appendAudit(t, 'k', { n: 3 });
    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);

    const chain = await listChain(t);
    expect(chain.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    // genesis
    expect(chain[0].seq).toBe(0);
    expect(chain[0].prevHash).toBe(GENESIS_PREV);
    // every entry links to the prior entryHash
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].prevHash).toBe(chain[i - 1].entryHash);
    }
    expect(await verifyChain(t)).toEqual({ ok: true });
    expect(await getAuditHead(t)).toEqual({ seq: 3, headHash: e3.entryHash });
  });

  it('canonicalize is key-order independent (reproducible hash input)', () => {
    expect(canonicalize({ b: 1, a: { d: 4, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 4 }, b: 1 }));
    // arrays preserve order; nested objects sort
    expect(canonicalize({ x: [{ z: 2, y: 1 }] })).toBe('{"x":[{"y":1,"z":2}]}');
  });
});

describe('audit hash-chain — CONCURRENCY (the CAS guard)', () => {
  // Run several times to catch any flakiness in the serialization.
  for (let round = 0; round < 5; round++) {
    it(`N concurrent appends for one tenant → contiguous seqs 1..N, no gaps/dupes, chain verifies (round ${round})`, async () => {
      const t = `org:race-${round}`;
      await __resetAuditChain();
      const N = 20;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) => appendAudit(t, 'race', { i })),
      );
      const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // 1..N exactly once
      expect(new Set(seqs).size).toBe(N); // no dupes

      const chain = await listChain(t);
      expect(chain.map((e) => e.seq)).toEqual(Array.from({ length: N + 1 }, (_, i) => i)); // 0..N, gap-free
      for (let i = 1; i < chain.length; i++) expect(chain[i].prevHash).toBe(chain[i - 1].entryHash);
      expect(await verifyChain(t)).toEqual({ ok: true }); // the chain never forked
      expect((await getAuditHead(t))?.seq).toBe(N);
    });
  }
});

describe('audit hash-chain — verifyChain tamper detection', () => {
  it('returns ok on a clean chain and brokenAt when a stored payload is mutated', async () => {
    const t = 'org:tamper';
    await appendAudit(t, 'k', { v: 'a' });
    await appendAudit(t, 'k', { v: 'b' }); // seq 2
    await appendAudit(t, 'k', { v: 'c' });
    expect(await verifyChain(t)).toEqual({ ok: true });

    // Mutate seq 2's payload WITHOUT re-hashing — the stored entryHash now lies.
    await __tamperEntryForTest(t, 2, (e) => ({ ...e, payload: { v: 'TAMPERED' } }));
    expect(await verifyChain(t)).toEqual({ ok: false, brokenAt: 2 });
  });

  it('detects a broken prev-hash linkage', async () => {
    const t = 'org:relink';
    await appendAudit(t, 'k', { v: 1 });
    await appendAudit(t, 'k', { v: 2 });
    // Rewrite seq 1's prevHash to a wrong value (linkage break at seq 1).
    await __tamperEntryForTest(t, 1, (e) => ({ ...e, prevHash: 'f'.repeat(64) }));
    expect(await verifyChain(t)).toEqual({ ok: false, brokenAt: 1 });
  });

  it('an empty (never-appended) tenant verifies ok', async () => {
    expect(await verifyChain('org:empty')).toEqual({ ok: true });
    expect(await getAuditHead('org:empty')).toBeNull();
  });
});

describe('audit hash-chain — per-tenant isolation', () => {
  it('appends to tenant A never touch tenant B', async () => {
    const a = 'org:iso-a';
    const b = 'org:iso-b';
    await appendAudit(a, 'k', { who: 'a1' });
    await appendAudit(a, 'k', { who: 'a2' });
    await appendAudit(b, 'k', { who: 'b1' });

    expect((await getAuditHead(a))?.seq).toBe(2);
    expect((await getAuditHead(b))?.seq).toBe(1);
    const aChain = await listChain(a);
    const bChain = await listChain(b);
    expect(aChain.every((e) => e.tenantId === a)).toBe(true);
    expect(bChain.every((e) => e.tenantId === b)).toBe(true);
    // B's chain hash-space is independent of A's.
    expect(await verifyChain(a)).toEqual({ ok: true });
    expect(await verifyChain(b)).toEqual({ ok: true });
  });
});

describe('audit hash-chain — seeded appends land', () => {
  beforeEach(async () => { await __resetConsentStore(); await __resetApprovalStore(); });

  it('recording consent appends a consent.change entry', async () => {
    const t = 'org:consent-audit';
    await recordConsent({ tenantId: t, subjectKey: 'sub-1', categories: { analytics: true }, source: 'test' });
    const chain = await listChain(t);
    const consentEntries = chain.filter((e) => e.kind === AUDIT_KIND_CONSENT_CHANGE);
    expect(consentEntries.length).toBe(1);
    // ADR 0657 D11 (CONS-26) — the chain is un-redactable and DSAR-exempt: a subject HASH, never the raw key.
    expect(consentEntries[0].payload.subjectKey).toBeUndefined();
    expect(typeof consentEntries[0].payload.subjectHash).toBe('string');
    expect(await verifyChain(t)).toEqual({ ok: true });
  });

  it('resolving an approval appends a governance.decision entry (only on the winning claim)', async () => {
    const t = 'org:approval-audit';
    const appr = await createApproval({ tenantId: t, rosterId: 'r1', persona: 'p', workflowId: 'wf', proposal: 'do it' });
    const resolved = await resolveApproval(appr.approvalId, { status: 'approved' });
    expect(resolved?.changed).toBe(true);
    // A second resolve is a no-op (changed:false) and appends nothing.
    const again = await resolveApproval(appr.approvalId, { status: 'approved' });
    expect(again?.changed).toBe(false);

    const decisions = (await listChain(t)).filter((e) => e.kind === AUDIT_KIND_GOVERNANCE_DECISION);
    expect(decisions.length).toBe(1);
    expect(decisions[0].payload.approvalId).toBe(appr.approvalId);
    expect(decisions[0].payload.outcome).toBe('approved');
    expect(await verifyChain(t)).toEqual({ ok: true });
  });
});

describe('GRADE DATA-2 — orphan-entry self-heal', () => {
  it('a stale head (crash between entry CAS and head advance) is adopted, not a permanent wedge', async () => {
    const t = 'ws:heal-test';
    const a = await appendAudit(t, 'test.one', {});
    // Simulate the crash window: force the head BACK to the previous seq while
    // entry `a.seq` exists — the exact state a mid-append crash leaves behind.
    const { __forceHeadForTest } = await import('../src/host/auditChainService.js');
    await __forceHeadForTest(t, a.seq - 1, a.prevHash);
    // The next append must adopt the orphan and continue the chain, not spin
    // to exhaustion.
    const b = await appendAudit(t, 'test.two', {});
    expect(b.seq).toBe(a.seq + 1);
    expect(b.prevHash).toBe(a.entryHash);
    expect(await verifyChain(t)).toEqual({ ok: true });
  });
});
