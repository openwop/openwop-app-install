/**
 * ADR 1042 D9 (security review H2) — on a channel-ingress turn an approval
 * covers ONE call. The conversation default (ADR 0132) is per tool for the rest
 * of the conversation, with any arguments; for a channel, where the words come
 * from people outside the workspace, that is too wide.
 *
 * The hook spends an approval on the first call it lets through and asks again
 * for the next one (same tool, any arguments); the ledger row is then removed
 * (`spendToolApproval`), so a later turn asks again too. FW2-D1 (binding the
 * approval to the shown arguments) is still deferred; this is the narrower
 * one-call grain, not argument binding.
 *
 * Red when: single-use is ignored (the second call is allowed); a spend is not
 * reported; spending removes a pending or denied row; a policy ask is satisfied
 * by a baseline-only approval under single-use.
 * Sabotage-witnessed 2026-11-03: removing the `spent.has(name)` check turned the
 * second-call case red; removing the `status !== 'approved'` guard in
 * `spendToolApproval` turned the pending/denied case red.
 * Wave 87: letting a baseline-only approval answer a `policy` ask in the
 * single-use branch (dropping `origin !== 'policy' &&`) turns the policy-ask
 * case red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFirewallHook, SENSITIVE_APPROVAL_TOOLS } from '../src/features/capability-firewall/firewallHook.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  listToolApprovals, recordToolApprovalRequested, resolveToolApproval, spendToolApproval,
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

describe('spendToolApproval', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => { initHostExtPersistence(storage); });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });

  it('removes an approved row, so the next call raises a fresh ask', async () => {
    await recordToolApprovalRequested('t-su', 'conv-1', TOOL, { input: { code: 'a' } });
    expect((await resolveToolApproval('t-su', 'conv-1', TOOL, 'approved', 'user:o')).ok).toBe(true);
    expect(await spendToolApproval('t-su', 'conv-1', TOOL)).toBe(true);
    expect(await listToolApprovals('t-su', 'conv-1')).toEqual([]);
    await recordToolApprovalRequested('t-su', 'conv-1', TOOL, { input: { code: 'b' } });
    expect((await listToolApprovals('t-su', 'conv-1')).map((r) => r.status)).toEqual(['pending']);
  });

  it('leaves a pending ask and a denial alone', async () => {
    await recordToolApprovalRequested('t-su', 'conv-2', TOOL);
    expect(await spendToolApproval('t-su', 'conv-2', TOOL)).toBe(false);
    expect((await listToolApprovals('t-su', 'conv-2')).map((r) => r.status)).toEqual(['pending']);
    await resolveToolApproval('t-su', 'conv-2', TOOL, 'denied', 'user:o');
    expect(await spendToolApproval('t-su', 'conv-2', TOOL)).toBe(false);
    expect((await listToolApprovals('t-su', 'conv-2')).map((r) => r.status)).toEqual(['denied']);
  });
});
