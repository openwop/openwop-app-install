/**
 * ADR 0834 — witnesses for the capability firewall's tool exits.
 *
 * Each `describe` names the defect it pins (S1–S5, B1 of the architect pass).
 * Every one was RED on `origin/main` @ a767ee948 before the fix landed; the
 * evidence is recorded in the ADR's implementation record.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let managedRound = 0;
const MANAGED_CALL: { name: string } = { name: '' };
vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return {
    ...actual,
    // Round 1 calls MANAGED_CALL.name; round 2 answers. Reset per test.
    dispatchManagedToolsRound: vi.fn(async () => {
      managedRound += 1;
      if (managedRound === 1) return { text: '', toolUses: [{ id: 'c1', name: MANAGED_CALL.name, input: {} }] };
      return { text: 'done', toolUses: [] };
    }),
  };
});

const governanceRows: Array<{ kind: string; outcome: string; detail?: Record<string, unknown> }> = [];
vi.mock('../src/host/governanceDecisionLog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/governanceDecisionLog.js')>();
  return { ...actual, recordGovernanceDecision: vi.fn(async (d: { kind: string; outcome: string; detail?: Record<string, unknown> }) => { governanceRows.push(d); }) };
});

import { buildFirewallHook, SENSITIVE_APPROVAL_TOOLS } from '../src/features/capability-firewall/firewallHook.js';
import { setPlatformRules } from '../src/features/capability-firewall/ruleStore.js';
import type { CapabilityRule } from '../src/features/capability-firewall/types.js';
import { registerFeatureAgentTool } from '../src/host/agentToolProvider.js';
import { buildLaneFirewall } from '../src/host/laneFirewall.js';
import { toolAuthorityHolds } from '../src/host/conversationVisibility.js';
import { listToolApprovals, recordToolApprovalRequested, resolveToolApproval } from '../src/features/conversation-tools/approvalLedger.js';
import { runConversationAgentToolTurn } from '../src/host/conversationToolLoop.js';
import { setConversationCapabilityScope, ensureConversationMeta } from '../src/host/conversationStore.js';
import { saveLedger } from '../src/features/intent-ledger/ledgerStore.js';
import { runAnonReadTurn } from '../src/host/anonymousActor.js';
import { executeRealtimeToolCall } from '../src/features/voice/realtime/toolBridge.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import { __clearAgentIdentityCache } from '../src/host/agentIdentity.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';
import type { Storage } from '../src/storage/index.js';

const CODE_EXEC = 'openwop:feature.code-exec.nodes.run';
const PROBE_READ = 'openwop:adr0834.probe-read';
const executed: string[] = [];

let storage: Storage;
let reset: () => void = () => {};
beforeAll(async () => {
  const { initHostExtPersistence, __resetHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
  const { openStorage } = await import('../src/storage/index.js');
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  reset = __resetHostExtPersistence;
  // Recorders under the real ids (last registration wins, this file's process only):
  // a witness must see EXECUTION, never infer it from a verdict.
  for (const [name, effect] of [[CODE_EXEC, 'write'], [PROBE_READ, 'read']] as const) {
    registerFeatureAgentTool({
      contentTrust: 'trusted', effect,
      def: { name, description: `ADR 0834 probe ${name}`, inputSchema: { type: 'object' } },
      run: async () => { executed.push(name); return { content: 'ran' }; },
    });
  }
});
afterAll(() => reset());

const policy = (verdict: CapabilityRule['verdict']): CapabilityRule => ({
  id: `p-${verdict}`, description: '', when: { with: [{ safetyTier: 'write' }] }, verdict, reason: `policy ${verdict}`,
});

describe('S2 — bypass skips only the user\'s own asks', () => {
  it('control: bypass downgrades the safe-mode BASELINE ask', () => {
    const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: true });
    expect(hook.evaluate([], CODE_EXEC).decision).toBe('allow');
  });
  it('a PLATFORM-floor require-approval survives bypass', () => {
    const hook = buildFirewallHook({ rules: [], platformRules: [policy('require-approval')], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: true });
    expect(hook.evaluate([], 'openwop:any.tool').decision).toBe('require-approval');
  });
  it('a TENANT require-approval rule survives bypass', () => {
    const hook = buildFirewallHook({ rules: [policy('require-approval')], unknownToolPolicy: 'treat-as-risky', requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: true });
    expect(hook.evaluate([], 'openwop:any.tool').decision).toBe('require-approval');
  });
  it('an ENFORCE default verdict of require-approval survives bypass', () => {
    const hook = buildFirewallHook({ rules: [], mode: 'enforce', defaultDenyVerdict: 'require-approval', requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: true });
    expect(hook.evaluate([], 'openwop:any.tool').decision).toBe('require-approval');
  });
  it('a tool that is BOTH baseline-sensitive and policy-held stays held under bypass', () => {
    const hook = buildFirewallHook({ rules: [policy('require-approval')], unknownToolPolicy: 'treat-as-risky', requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: true });
    expect(hook.evaluate([], CODE_EXEC).decision).toBe('require-approval');
  });
});

describe('S4 — off-host and arbitrary fan-out tools are held in safe mode', () => {
  // RED on origin/main was witnessed with the hook exactly as the chat lane built it
  // (`buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS,
  // gateHostMediatedEgress: true })`): both tools evaluated `allow`. The fix declares the
  // ask ON the tool; the lane factory is what every lane now builds. The two real tools
  // are pinned in the baseline by `safe-mode-baseline-census.test.ts` (it boots the app,
  // which is what registers them).
  const DECLARED = 'openwop:adr0834.probe-declared';
  beforeAll(() => {
    registerFeatureAgentTool({
      contentTrust: 'trusted', effect: 'write', safeModeApproval: { reason: 'probe reason' },
      def: { name: DECLARED, description: 'ADR 0834 declared probe', inputSchema: { type: 'object' } },
      run: async () => ({ content: 'ran' }),
    });
  });
  it('a tool that DECLARES safeModeApproval is held by the lane firewall, with its reason', async () => {
    const { hook } = await buildLaneFirewall({ tenantId: 't-0834-s4', lane: 'chat' });
    expect(hook.evaluate([], DECLARED)).toMatchObject({ decision: 'require-approval', origin: 'baseline', reason: 'probe reason' });
  });
  it('control: an undeclared probe is not held', async () => {
    const { hook } = await buildLaneFirewall({ tenantId: 't-0834-s4', lane: 'chat' });
    expect(hook.evaluate([], PROBE_READ).decision).toBe('allow');
  });
});

const agent = (allow: string[]): ResolvedAgentManifest =>
  ({ agentId: 'adr0834-agent', persona: 'P', toolAllowlist: allow } as unknown as ResolvedAgentManifest);
const chatRun = (runId: string, actingUserId: string, chatSessionId: string): RunRecord =>
  ({ runId, tenantId: 't-0834', inputs: { credentialRef: 'managed:openwop-free' }, metadata: { actingUserId, chatSessionId } } as unknown as RunRecord);

async function chatTurn(r: RunRecord, call: string, extra: Record<string, unknown>): Promise<void> {
  managedRound = 0; MANAGED_CALL.name = call; executed.length = 0;
  await runConversationAgentToolTurn({
    run: r, agent: agent([call]), systemPrompt: 'sp', history: [{ role: 'user', content: 'run it' }],
    runId: r.runId, nodeId: 'n', conversationId: `${r.runId}:n:0`,
    policyResolver: (() => undefined) as unknown as ProviderPolicyResolver,
    ...extra,
  } as Parameters<typeof runConversationAgentToolTurn>[0]);
}

describe('S1 — bypass needs the authority of the principal the tools act as', () => {
  it('control: the acting principal\'s own bypass runs the sensitive tool', async () => {
    await chatTurn(chatRun('r-s1a', 'owner-1', 'sess-s1a'), CODE_EXEC, { permissionMode: 'bypass', callerPrincipal: 'owner-1' });
    expect(executed).toEqual([CODE_EXEC]);
  });
  it('a participant\'s bypass does NOT run it as the owner', async () => {
    await chatTurn(chatRun('r-s1b', 'owner-1', 'sess-s1b'), CODE_EXEC, { permissionMode: 'bypass', callerPrincipal: 'participant-2' });
    expect(executed).toEqual([]);
  });
  it('a bypass with no caller principal does NOT run it', async () => {
    await chatTurn(chatRun('r-s1c', 'owner-1', 'sess-s1c'), CODE_EXEC, { permissionMode: 'bypass' });
    expect(executed).toEqual([]);
  });
});

describe('S3 — the anonymous widget lane is under the firewall', () => {
  afterAll(async () => { await setPlatformRules([]); });
  it('a platform deny refuses a GRANTED anonymous read (and audits it as a firewall refusal)', async () => {
    await setPlatformRules([policy('deny')]);
    executed.length = 0;
    let round = 0;
    const callAIWithTools = async (_r: AiToolCallRequest): Promise<AiToolCallResult> => {
      round += 1;
      return round === 1 ? { content: '', toolCalls: [{ id: 'a1', name: PROBE_READ, input: {} }] } : { content: 'ok', toolCalls: [] };
    };
    const turn = await runAnonReadTurn({
      storage, tenantId: 't-0834-anon', agent: { agentId: 'anon-agent', persona: 'P', systemPrompt: 'sp' } as never,
      grant: { read: [PROBE_READ], write: [] },
      surfaceSessionKey: 'w:s0834', fencedUserMessage: 'hi', callAIWithTools,
    });
    expect(executed).toEqual([]);
    const reasons = (await storage.listEvents(turn.runId))
      .filter((e) => e.type === 'authorization.decided')
      .map((e) => (e.payload as { reason: string }).reason);
    expect(reasons).not.toContain('anon-not-granted');
    expect(reasons).toContain('anon-firewall-denied');
  });
});

describe('S5 — voice honours the conversation\'s tool scope', () => {
  const VOICE_AGENT = 'adr0834.voice-agent';
  beforeAll(() => {
    getAgentRegistry().register({
      agentId: VOICE_AGENT, persona: 'Voice', modelClass: 'chat', systemPrompt: 'v',
      toolAllowlist: [PROBE_READ], packName: 'test.adr0834', packVersion: '0.0.1',
    });
    __clearAgentIdentityCache();
  });
  it('a tool the conversation disabled is refused over voice', async () => {
    await setConversationCapabilityScope('t-0834-voice', 'sess-voice', { mode: 'restricted', disabled: [PROBE_READ] });
    executed.length = 0;
    const out = await executeRealtimeToolCall({
      tenantId: 't-0834-voice', agentId: VOICE_AGENT, sessionId: 'vs-1', name: PROBE_READ, args: {},
      actingUserId: 'owner-1', conversationId: 'sess-voice',
    });
    expect(out.status).toBe('denied');
    expect(executed).toEqual([]);
  });
  it('control: with no scope the same call runs', async () => {
    executed.length = 0;
    const out = await executeRealtimeToolCall({
      tenantId: 't-0834-voice', agentId: VOICE_AGENT, sessionId: 'vs-2', name: PROBE_READ, args: {},
      actingUserId: 'owner-1', conversationId: 'sess-voice-open',
    });
    expect(out.status).toBe('ok');
    expect(executed).toEqual([PROBE_READ]);
  });
});


describe('D3 — one authority predicate for bypass and approvals', () => {
  it('holds only for the principal the tools act as', () => {
    expect(toolAuthorityHolds('owner-1', 'owner-1')).toBe(true);
    expect(toolAuthorityHolds('participant-2', 'owner-1')).toBe(false);
    expect(toolAuthorityHolds(undefined, 'owner-1')).toBe(false);
    expect(toolAuthorityHolds('owner-1', undefined)).toBe(false); // ownerless ⇒ no one
    expect(toolAuthorityHolds('', '')).toBe(false);
  });
});

describe('D2/D5 — voice: the client-set card answers only the user\'s own ask', () => {
  const VOICE_AGENT2 = 'adr0834.voice-agent-2';
  beforeAll(() => {
    getAgentRegistry().register({
      agentId: VOICE_AGENT2, persona: 'Voice', modelClass: 'chat', systemPrompt: 'v',
      toolAllowlist: [PROBE_READ, CODE_EXEC], packName: 'test.adr0834', packVersion: '0.0.1',
    });
    __clearAgentIdentityCache();
  });
  afterAll(async () => { await setPlatformRules([]); });
  const call = (name: string, extra: Record<string, unknown> = {}) => executeRealtimeToolCall({
    tenantId: 't-0834-v2', agentId: VOICE_AGENT2, sessionId: `vs-${Math.random()}`, name, args: {},
    actingUserId: 'owner-1', ...extra,
  });
  it('control: userApproved answers the safe-mode baseline ask', async () => {
    executed.length = 0;
    expect((await call(CODE_EXEC)).status).toBe('requires_approval');
    expect((await call(CODE_EXEC, { userApproved: true })).status).toBe('ok');
    expect(executed).toEqual([CODE_EXEC]);
  });
  it('userApproved does NOT answer a platform-floor ask', async () => {
    await setPlatformRules([policy('require-approval')]);
    executed.length = 0;
    expect((await call(PROBE_READ, { userApproved: true })).status).toBe('requires_approval');
    expect(executed).toEqual([]);
  });
  it('a held voice call lands in the conversation ledger as pending', async () => {
    await setPlatformRules([]);
    await call(CODE_EXEC, { conversationId: 'sess-v2-held' });
    const rows = await listToolApprovals('t-0834-v2', 'sess-v2-held');
    expect(rows).toEqual([expect.objectContaining({ toolName: CODE_EXEC, status: 'pending', origin: 'baseline' })]);
  });
});

describe('D1 / S7 — every lane writes its narrowing verdicts to the decisions log', () => {
  for (const lane of ['chat', 'run', 'dispatch', 'voice', 'anon'] as const) {
    it(`${lane}: a held call is recorded with its lane and origin`, async () => {
      governanceRows.length = 0;
      const { hook } = await buildLaneFirewall({ tenantId: 't-0834-log', lane });
      expect(hook.evaluate([], CODE_EXEC).decision).toBe('require-approval');
      expect(governanceRows).toContainEqual(expect.objectContaining({
        kind: 'firewall', outcome: 'deny',
        detail: expect.objectContaining({ toolName: CODE_EXEC, decision: 'require-approval', lane, origin: 'baseline' }),
      }));
    });
  }
});

describe('FW2-CD-1 — a run acting as someone else does not spend the owner\'s approvals', () => {
  it('a fork (acting principal ≠ owner) does not fold the owner\'s approval, and writes no ask into the owner\'s ledger', async () => {
    await ensureConversationMeta('t-0834', 'sess-owned', { type: 'agent', ownerUserId: 'owner-1' });
    await recordToolApprovalRequested('t-0834', 'sess-owned', CODE_EXEC, { origin: 'baseline' });
    const [row] = await listToolApprovals('t-0834', 'sess-owned');
    expect((await resolveToolApproval('t-0834', 'sess-owned', CODE_EXEC, 'approved', 'owner-1', row!.requestedAt)).ok).toBe(true);
    // control: the owner's own run uses the approval
    await chatTurn(chatRun('r-cd1a', 'owner-1', 'sess-owned'), CODE_EXEC, {});
    expect(executed).toEqual([CODE_EXEC]);
    // the forker's run in the same conversation does not
    await chatTurn(chatRun('r-cd1b', 'forker-2', 'sess-owned'), CODE_EXEC, {});
    expect(executed).toEqual([]);
    expect((await listToolApprovals('t-0834', 'sess-owned')).map((r) => r.status)).toEqual(['approved']);
  });
});

describe('FW2-CD-4 — an expired mission keeps the agent from acting', () => {
  it('an EXPIRED intent ledger narrows to nothing (it used to fall back to every tool)', async () => {
    await saveLedger({
      ledgerId: 'l-exp', tenantId: 't-0834', conversationId: 'sess-expired', goal: 'g', allowed: [PROBE_READ], forbidden: [],
      requireApproval: [], successCriteria: [], status: 'expired', proposedBy: 'user', createdAt: new Date().toISOString(),
    });
    await chatTurn(chatRun('r-cd4', 'owner-1', 'sess-expired'), PROBE_READ, {});
    expect(executed).toEqual([]);
  });
});
