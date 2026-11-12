/**
 * ADR 1042 D9 (security review H2) — on a channel-ingress turn an approval
 * covers ONE call. The conversation default (ADR 0132) is per tool for the rest
 * of the conversation, with any arguments; for a channel, where the words come
 * from people outside the workspace, that is too wide.
 *
 * The hook spends an approval on the first call it lets through and asks again
 * for the next one (same tool, any arguments). CHAN-F3: the turn CLAIMS its
 * approvals before it runs (`claimApprovedToolApprovals`, a compare-and-delete), so
 * two instances cannot both spend one; the spent claim stays deleted and the rest
 * are handed back (`returnUnspentToolApprovals`), so a later turn asks again too. FW2-D1
 * (CHAN-F2) adds argument binding on top: see `adr0834-fw2d1-argument-bound-approvals.test.ts`;
 * the `approvalsForTurn` block below covers how each lane uses and settles approvals.
 *
 * Red when: single-use is ignored (the second call is allowed); a spend is not
 * reported; spending removes a pending or denied row; a policy ask is satisfied
 * by a baseline-only approval under single-use.
 * Sabotage-witnessed 2026-11-03: removing the `spent.has(name)` check turned the
 * second-call case red; removing the `status !== 'approved'` guard in
 * the old `spendToolApproval` turned the pending/denied case red (CHAN-F3 replaced it
 * with the claim; its `status === 'approved'` guard is re-witnessed below).
 * Wave 87: letting a baseline-only approval answer a `policy` ask in the
 * single-use branch (dropping `origin !== 'policy' &&`) turns the policy-ask
 * case red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFirewallHook, SENSITIVE_APPROVAL_TOOLS } from '../src/features/capability-firewall/firewallHook.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { approvalsForTurn } from '../src/host/conversationToolLoop.js';
import {
  claimApprovedToolApprovals, listToolApprovals, recordToolApprovalRequested, resolveToolApproval, returnUnspentToolApprovals,
} from '../src/features/conversation-tools/approvalLedger.js';

const TOOL = 'openwop:feature.code-exec.nodes.run';

function hook(singleUse: boolean, spent: string[], approved: { baseline?: string; policy?: string } = { baseline: TOOL }, enforce = false) {
  return buildFirewallHook({
    rules: [],
    // Enforce + default require-approval: with no rules, every call falls through to a
    // `policy`-origin ask (ADR 0834 D2), the one a baseline-only approval must not answer.
    ...(enforce ? { mode: 'enforce' as const, defaultDenyVerdict: 'require-approval' as const } : {}),
    requireApprovalTools: SENSITIVE_APPROVAL_TOOLS,
    bypassApproval: false,
    ...(approved.baseline ? { approvedBaselineTools: new Set([approved.baseline]) } : {}),
    ...(approved.policy ? { approvedTools: new Set([approved.policy]) } : {}),
    ...(singleUse ? { singleUseApprovals: true, onApprovalSpent: (n: string) => { spent.push(n); } } : {}),
  });
}

describe('the firewall hook', () => {
  it('with single-use, one approval lets exactly one call through and the next asks again', () => {
    const spent: string[] = [];
    const h = hook(true, spent);
    expect(h.evaluate([], TOOL).decision).toBe('allow');
    expect(spent).toEqual([TOOL]);
    // A second call of the same tool (whatever its arguments) waits for a new approval.
    expect(h.evaluate([TOOL], TOOL).decision).toBe('require-approval');
    expect(spent).toEqual([TOOL]);
  });

  it('without single-use (the main chat), the approval still covers every call', () => {
    const spent: string[] = [];
    const h = hook(false, spent);
    expect(h.evaluate([], TOOL).decision).toBe('allow');
    expect(h.evaluate([TOOL], TOOL).decision).toBe('allow');
    expect(spent).toEqual([]);
  });

  it('an unapproved tool is not allowed by single-use either', () => {
    const spent: string[] = [];
    expect(hook(true, spent, {}).evaluate([], TOOL).decision).toBe('require-approval');
    expect(spent).toEqual([]);
  });

  it('with single-use, a baseline-only approval does not satisfy a policy ask', () => {
    const spent: string[] = [];
    const baselineOnly = hook(true, spent, { baseline: TOOL }, true).evaluate([], TOOL);
    expect(baselineOnly).toMatchObject({ decision: 'require-approval', origin: 'policy' });
    expect(spent).toEqual([]);
    // Positive control, same posture: a policy approval answers ONE call, then is spent.
    const spent2: string[] = [];
    const h = hook(true, spent2, { policy: TOOL }, true);
    expect(h.evaluate([], TOOL).decision).toBe('allow');
    expect(spent2).toEqual([TOOL]);
    expect(h.evaluate([TOOL], TOOL).decision).toBe('require-approval');
  });
});

describe('claim before use (CHAN-F3: two instances cannot spend one approval)', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => { initHostExtPersistence(storage); });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });
  const OTHER = 'openwop:feature.code-exec.nodes.other';

  it('two concurrent turns reading the same approval: exactly one claims it', async () => {
    await recordToolApprovalRequested('t-su', 'conv-1', TOOL, { input: { code: 'a' } });
    expect((await resolveToolApproval('t-su', 'conv-1', TOOL, 'approved', 'user:o')).ok).toBe(true);
    const seen = await listToolApprovals('t-su', 'conv-1'); // both instances read this
    const [a, b] = await Promise.all([claimApprovedToolApprovals(seen), claimApprovedToolApprovals(seen)]);
    expect([a.length, b.length].sort()).toEqual([0, 1]);
    expect(await listToolApprovals('t-su', 'conv-1')).toEqual([]);
  });

  it('claims only approved rows: a pending ask and a denial stay', async () => {
    await recordToolApprovalRequested('t-su', 'conv-2', TOOL);
    await recordToolApprovalRequested('t-su', 'conv-2', OTHER);
    await resolveToolApproval('t-su', 'conv-2', OTHER, 'denied', 'user:o');
    expect(await claimApprovedToolApprovals(await listToolApprovals('t-su', 'conv-2'))).toEqual([]);
    expect((await listToolApprovals('t-su', 'conv-2')).map((r) => r.status).sort()).toEqual(['denied', 'pending']);
  });

  it('a spent claim stays gone, an unspent one comes back, and never over a newer row', async () => {
    for (const tool of [TOOL, OTHER]) {
      await recordToolApprovalRequested('t-su', 'conv-3', tool);
      await resolveToolApproval('t-su', 'conv-3', tool, 'approved', 'user:o');
    }
    const claimed = await claimApprovedToolApprovals(await listToolApprovals('t-su', 'conv-3'));
    expect(claimed).toHaveLength(2);
    // While the turn holds OTHER's claim, the owner is asked again and the ask is pending.
    await recordToolApprovalRequested('t-su', 'conv-3', OTHER, { input: { code: 'fresh' } });
    await returnUnspentToolApprovals(claimed, new Set([TOOL]));
    const rows = await listToolApprovals('t-su', 'conv-3');
    expect(rows.map((r) => [r.toolName, r.status])).toEqual([[OTHER, 'pending']]);
  });

  it('an unspent claim with no newer row is returned as it was', async () => {
    await recordToolApprovalRequested('t-su', 'conv-4', TOOL);
    await resolveToolApproval('t-su', 'conv-4', TOOL, 'approved', 'user:o');
    const before = await listToolApprovals('t-su', 'conv-4');
    const claimed = await claimApprovedToolApprovals(before);
    await returnUnspentToolApprovals(claimed, new Set());
    expect(await listToolApprovals('t-su', 'conv-4')).toEqual(before);
  });
});

describe('approvalsForTurn — what a turn may use, per lane (CHAN-F3, FW2-D1)', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => { initHostExtPersistence(storage); });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });
  const INPUT = { code: 'print(1)' };
  async function approved(conv: string, grain: 'call' | 'conversation' = 'call'): Promise<void> {
    await recordToolApprovalRequested('t-at', conv, TOOL, { input: INPUT });
    const pending = (await listToolApprovals('t-at', conv))[0]!;
    await resolveToolApproval('t-at', conv, TOOL, 'approved', 'user:o', pending.requestedAt, grain);
  }

  it('a channel turn can use only what it claimed; a concurrent channel turn can use nothing', async () => {
    await approved('c1');
    const rows = await listToolApprovals('t-at', 'c1');
    const [a, b] = await Promise.all([
      approvalsForTurn({ channelTurn: true, actsAsOwner: true, approvals: rows }),
      approvalsForTurn({ channelTurn: true, actsAsOwner: true, approvals: rows }),
    ]);
    // Asked about the same exact call, exactly one of the two turns holds an approval.
    expect([a.grant.check(TOOL, 'baseline', INPUT, 'k-a'), b.grant.check(TOOL, 'baseline', INPUT, 'k-b')].sort()).toEqual([false, true]);
    expect(await listToolApprovals('t-at', 'c1')).toEqual([]); // claimed and spent
    await Promise.all([a.settle(), b.settle()]);
    expect(await listToolApprovals('t-at', 'c1')).toEqual([]); // spent ⇒ not handed back
  });

  it('a channel turn hands back a claim it did not spend', async () => {
    await approved('c2');
    const before = await listToolApprovals('t-at', 'c2');
    const turn = await approvalsForTurn({ channelTurn: true, actsAsOwner: true, approvals: before });
    await turn.settle();
    expect(await listToolApprovals('t-at', 'c2')).toEqual(before);
  });

  it('a channel turn cannot use a tool-wide approval (fails closed: the owner is asked again)', async () => {
    await approved('c2b', 'conversation');
    const turn = await approvalsForTurn({ channelTurn: true, actsAsOwner: true, approvals: await listToolApprovals('t-at', 'c2b') });
    expect(turn.grant.check(TOOL, 'baseline', INPUT, 'k')).toBe(false);
    await turn.settle();
    expect((await listToolApprovals('t-at', 'c2b')).map((r) => r.grain)).toEqual(['conversation']); // handed back, unused
  });

  it('an in-app turn keeps a tool-wide approval and deletes a one-call approval it spent', async () => {
    await approved('c3', 'conversation');
    const wide = await approvalsForTurn({ channelTurn: false, actsAsOwner: true, approvals: await listToolApprovals('t-at', 'c3') });
    expect(wide.grant.check(TOOL, 'baseline', { other: true }, 'k1')).toBe(true);
    expect(wide.grant.check(TOOL, 'baseline', INPUT, 'k2')).toBe(true);
    await wide.settle();
    expect((await listToolApprovals('t-at', 'c3')).map((r) => r.status)).toEqual(['approved']);

    await approved('c3b', 'call');
    const once = await approvalsForTurn({ channelTurn: false, actsAsOwner: true, approvals: await listToolApprovals('t-at', 'c3b') });
    expect(once.grant.check(TOOL, 'baseline', INPUT, 'k1')).toBe(true);
    expect(once.grant.check(TOOL, 'baseline', INPUT, 'k2')).toBe(false); // one call
    await once.settle();
    expect(await listToolApprovals('t-at', 'c3b')).toEqual([]);
  });

  it('a turn not acting as the owner can use nothing and claims nothing', async () => {
    await approved('c4');
    const rows = await listToolApprovals('t-at', 'c4');
    for (const channelTurn of [true, false]) {
      expect((await approvalsForTurn({ channelTurn, actsAsOwner: false, approvals: rows })).grant.check(TOOL, 'baseline', INPUT, 'k')).toBe(false);
    }
    expect(await listToolApprovals('t-at', 'c4')).toEqual(rows);
  });
});
