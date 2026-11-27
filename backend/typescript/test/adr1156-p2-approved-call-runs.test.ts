/**
 * ADR 1156 P2 — the call a person approved on its card is run by the next turn, before the
 * model, with exactly the approved arguments.
 *
 * Drives the real chat tool turn (`runConversationAgentToolTurn`) with a scripted managed
 * model, a probe tool held by the conversation's own scope, and the real ledger. Pins:
 *  1. after a one-call approval, the next turn runs the call before its first model call,
 *     even when the model makes no call; the model reads the result and the note; the card
 *     settles `ran`; the row is gone;
 *  2. at most once: a later turn does not run it again, and two turns started together run
 *     it once between them;
 *  3. it never runs for a fork (even the owner's own), for someone other than the owner, on
 *     a channel turn, outside the run window, or with the kill switch off; each leaves the
 *     approval in place for P1's model re-attempt;
 *  4. the sealed input opens only for its own row and digest; a tampered one does not run;
 *  5. only a one-call approval keeps the sealed input: a denial and a tool-wide approval
 *     drop it;
 *  6. a tool that refuses the approved call settles `refused`, in the tool's words; a call a
 *     gate refuses before its approval is checked (no longer in scope) settles `refused`
 *     and does not run;
 *  7. a sealed input whose window passed is dropped on the next turn, whoever acts;
 *  8. erasing the approver drops the sealed input;
 *  9. under KMS, a plaintext-marked input does not open;
 * 10. the retention daemon's default-window sweep drops a lapsed input with no later turn,
 *     except under legal hold;
 * 11. a PENDING ask keeps its sealed input through a turn and a sweep that run before the
 *     decision, so the approval that follows still runs the call;
 * 12. ...but only for 24 h after the ask (user decision 2026-11-26): past it, the sweep
 *     drops the input, and the approval then works as in P1.
 *
 * Sabotage notes: skipping the approved round reds 1; replacing the claim with a plain read
 * reds 2's concurrency case; dropping the `forkMode` check reds 3's fork case; dropping the
 * digest check in `openSealedInput` reds 4; keeping the sealed input on every decision reds
 * 5; dropping `settledUnspent` reds 6's scope case; not calling `dropLapsedSealedInputs` from
 * the turn reds 7; keeping `sealedInput` in the DSAR eraser reds 8; accepting the plaintext
 * marker under KMS reds 9; not registering `sweepLapsedSealedInputs` reds 10; reading a
 * pending row as lapsed in `sealedInputLapsed` reds 11; never lapsing a pending row reds 12.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const script = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown> | null>, tool: '', seen: [] as string[] }));
vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return {
    ...actual,
    dispatchManagedToolsRound: vi.fn(async (req: { messages: unknown }) => {
      script.seen.push(JSON.stringify(req.messages));
      const next = script.calls.shift();
      if (next) return { text: '', toolUses: [{ id: `c-${script.seen.length}`, name: script.tool, input: next }] };
      return { text: 'done', toolUses: [] };
    }),
  };
});

import { registerFeatureAgentTool } from '../src/host/agentToolProvider.js';
import { runConversationAgentToolTurn, approvedCallId } from '../src/host/conversationToolLoop.js';
import { APPROVED_CALLS_NOTE } from '../src/host/agentDispatch.js';
import { ensureConversationMeta, setConversationCapabilityScope } from '../src/host/conversationStore.js';
import { listToolApprovals, resolveToolApproval, claimApprovedCallsToRun, openSealedInput, eraseConversationToolApprovalsSubject } from '../src/features/conversation-tools/approvalLedger.js';
import { configureKmsClient, createLocalAesKmsClient, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';
import { ERASED } from '../src/host/subjectErasureRedaction.js';
import { randomBytes } from 'node:crypto';
import { runDefaultWindowSweeps } from '../src/host/retentionPurger.js';
import { setRetentionHold, clearRetentionHold } from '../src/host/retentionHold.js';
import type { ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import type { RunRecord } from '../src/types.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';

const PROBE = 'openwop:adr1156p2.board-edit';
const T = 't-1156p2';
const OWNER = 'owner-1156p2';
const ran: Array<Record<string, unknown>> = [];
let refuse = false;

let reset: () => void = () => {};
beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_APPROVED_CALL_RUN;
  const { initHostExtPersistence, __resetHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
  const { openStorage } = await import('../src/storage/index.js');
  initHostExtPersistence(await openStorage('memory://'));
  reset = __resetHostExtPersistence;
  registerFeatureAgentTool({
    contentTrust: 'trusted', effect: 'write',
    def: { name: PROBE, description: 'ADR 1156 P2 probe', inputSchema: { type: 'object' } },
    run: async (input: Record<string, unknown>) => {
      if (refuse) return { content: JSON.stringify({ message: 'The board changed since this was proposed.' }), isError: true };
      ran.push(input);
      return { content: 'moved' };
    },
  });
});
afterAll(() => { reset(); delete process.env.OPENWOP_APPROVED_CALL_RUN; delete process.env.OPENWOP_APPROVED_CALL_RUN_WINDOW_MIN; _resetKmsForTesting(); });

const agent: ResolvedAgentManifest = {
  agentId: 'adr1156p2-agent', persona: 'P', modelClass: 'chat', systemPrompt: 'sp', toolAllowlist: [PROBE],
  packName: 'test.adr1156p2', packVersion: '0.0.1',
};
const AT = '2026-01-01T00:00:00.000Z';
const noPolicies: ProviderPolicyResolver = { resolveForRun: async () => [] };
/** A full input, nested and key-order-sensitive, so a lossy store would show. */
const INPUT = { to: 'the window', items: [{ id: 'b', z: 1, a: 2 }, { id: 'a' }], note: 'keep the lamp' };

let n = 0;
interface TurnOpts { actingUserId?: string; forkMode?: 'replay' | 'branch'; channel?: boolean }
async function conversation(): Promise<{ session: string; turn: (input: Record<string, unknown> | null, o?: TurnOpts) => ReturnType<typeof runConversationAgentToolTurn> }> {
  const session = `sess-1156p2-${n++}`;
  await ensureConversationMeta(T, session, { type: 'agent', ownerUserId: OWNER });
  await setConversationCapabilityScope(T, session, { mode: 'restricted', requireApproval: [PROBE] });
  let k = 0;
  return {
    session,
    turn: (input, o = {}) => {
      const run: RunRecord = {
        runId: `r-${session}`, workflowId: 'adr1156p2.chat', tenantId: T, status: 'running',
        inputs: { credentialRef: 'managed:openwop-free' },
        metadata: { actingUserId: o.actingUserId ?? OWNER, chatSessionId: session, ...(o.channel ? { channelIngress: true } : {}) },
        configurable: {}, createdAt: AT, updatedAt: AT,
        ...(o.forkMode ? { parentRunId: 'r-source', forkMode: o.forkMode } : {}),
      };
      script.calls = [input];
      script.tool = PROBE;
      k += 1;
      return runConversationAgentToolTurn({
        run, agent, systemPrompt: 'sp', history: [{ role: 'user', content: 'go' }],
        runId: run.runId, nodeId: 'gate', conversationId: `${run.runId}:gate:0`, policyResolver: noPolicies,
        turnMessageId: `${run.runId}:gate:0:${k}:agent`,
      });
    },
  };
}
const rowOf = async (session: string) => (await listToolApprovals(T, session)).find((r) => r.toolName === PROBE);
/** Hold the call on turn 1, then decide it. */
async function heldThen(c: Awaited<ReturnType<typeof conversation>>, decision: 'approved' | 'denied' = 'approved', grain: 'call' | 'conversation' = 'call') {
  await c.turn(INPUT);
  const r = await rowOf(c.session);
  expect(r?.status, 'fixture: an ask is pending').toBe('pending');
  expect(r?.sealedInput, 'fixture: an in-app ask is sealed').toBeTruthy();
  const out = await resolveToolApproval(T, c.session, PROBE, decision, OWNER, r!.requestedAt, grain);
  expect(out.ok).toBe(true);
}
const ASK1 = (session: string) => `r-${session}:gate:0:1:agent`;

describe('ADR 1156 P2 — the approved call runs on the next turn', () => {
  it('1. runs before the model, with the approved arguments, and settles ran', async () => {
    const c = await conversation();
    await heldThen(c);
    ran.length = 0;
    script.seen.length = 0;
    const out = await c.turn(null); // the model makes no call of its own
    expect(ran).toEqual([INPUT]);
    expect(out?.settledApprovals).toEqual([{ askId: ASK1(c.session), toolName: PROBE, outcome: 'ran' }]);
    expect(out?.heldCalls ?? []).toEqual([]);
    // The model's FIRST round already sees the result and the note.
    expect(script.seen).toHaveLength(1);
    expect(script.seen[0]).toContain(`Result of ${PROBE}`);
    expect(script.seen[0]).toContain(APPROVED_CALLS_NOTE);
    const call = out?.events.find((e) => e.type === 'agent.toolCalled' && e.callId === approvedCallId({ askId: ASK1(c.session), toolName: PROBE }));
    expect(call, 'the run is recorded as a real call').toBeTruthy();
    expect(await rowOf(c.session)).toBeUndefined();
  });

  it('2. at most once: a later turn does not run it again', async () => {
    const c = await conversation();
    await heldThen(c);
    ran.length = 0;
    await c.turn(null);
    await c.turn(null);
    expect(ran).toEqual([INPUT]);
  });

  it('2b. two turns started together run it once between them', async () => {
    const c = await conversation();
    await heldThen(c);
    ran.length = 0;
    const rows = await listToolApprovals(T, c.session);
    const [a, b] = await Promise.all([claimApprovedCallsToRun(rows), claimApprovedCallsToRun(rows)]);
    expect(a.toRun.length + b.toRun.length).toBe(1);
    expect(a.lost.length + b.lost.length).toBe(1);
  });

  it('3. never for a fork, someone else, a channel turn, outside the window, or with the switch off', async () => {
    const cases: Array<[string, TurnOpts]> = [
      ['the owner\'s own fork', { forkMode: 'branch' }],
      ['a replay fork', { forkMode: 'replay' }],
      ['another participant', { actingUserId: 'someone-else' }],
      ['a channel turn', { channel: true }],
    ];
    for (const [label, o] of cases) {
      const c = await conversation();
      await heldThen(c);
      ran.length = 0;
      await c.turn(null, o);
      expect(ran, label).toEqual([]);
      expect((await rowOf(c.session))?.status, `${label}: the approval stays for P1`).toBe('approved');
    }
    const late = await conversation();
    await heldThen(late);
    const later = Date.now() + 2 * 60 * 60_000;
    expect((await claimApprovedCallsToRun(await listToolApprovals(T, late.session), later)).toRun, 'outside the window').toEqual([]);
    process.env.OPENWOP_APPROVED_CALL_RUN = 'off';
    try {
      ran.length = 0;
      await late.turn(null);
      expect(ran, 'kill switch').toEqual([]);
    } finally { delete process.env.OPENWOP_APPROVED_CALL_RUN; }
  });

  it('4. the sealed input opens only for its own row and digest', async () => {
    const c = await conversation();
    await heldThen(c);
    const row = (await rowOf(c.session))!;
    expect(await openSealedInput(row)).toEqual(INPUT);
    expect(await openSealedInput({ ...row, inputDigest: 'not-the-digest' })).toBeUndefined();
    expect(await openSealedInput({ ...row, sealedInput: `${row.sealedInput}x` })).toBeUndefined();
    expect(await openSealedInput({ ...row, sealedInput: 'toolapproval:plain:v1:{"to":"the hall"}' }), 'another input under this digest').toBeUndefined();
  });

  it('5. only a one-call approval keeps the sealed input', async () => {
    const denied = await conversation();
    await heldThen(denied, 'denied', 'call');
    expect((await rowOf(denied.session))?.sealedInput).toBeUndefined();
    const toolWide = await conversation();
    await heldThen(toolWide, 'approved', 'conversation');
    expect((await rowOf(toolWide.session))?.sealedInput).toBeUndefined();
    const once = await conversation();
    await heldThen(once, 'approved', 'call');
    expect((await rowOf(once.session))?.sealedInput).toBeTruthy();
  });

  it('6. a refusal settles refused: by the tool, or by a gate before the approval', async () => {
    const c = await conversation();
    await heldThen(c);
    refuse = true;
    try {
      const out = await c.turn(null);
      expect(out?.settledApprovals).toEqual([{ askId: ASK1(c.session), toolName: PROBE, outcome: 'refused', reason: 'The board changed since this was proposed.' }]);
    } finally { refuse = false; }

    const gone = await conversation();
    await heldThen(gone);
    await setConversationCapabilityScope(T, gone.session, { mode: 'restricted', disabled: [PROBE] });
    ran.length = 0;
    const out = await gone.turn(null);
    expect(ran).toEqual([]);
    expect(out?.settledApprovals?.[0]).toMatchObject({ askId: ASK1(gone.session), toolName: PROBE, outcome: 'refused' });
  });

  it('7. a sealed input whose window passed is dropped on the next turn, whoever acts', async () => {
    const c = await conversation();
    await heldThen(c);
    process.env.OPENWOP_APPROVED_CALL_RUN_WINDOW_MIN = '0.0001'; // 6 ms
    try {
      await new Promise((r) => setTimeout(r, 30));
      ran.length = 0;
      await c.turn(null, { actingUserId: 'someone-else' });
      expect(ran).toEqual([]);
      const row = await rowOf(c.session);
      expect(row?.status, 'the approval stays for P1').toBe('approved');
      expect(row?.sealedInput, 'the input is not kept').toBeUndefined();
    } finally { delete process.env.OPENWOP_APPROVED_CALL_RUN_WINDOW_MIN; }
  });

  it('8. erasing the approver drops the sealed input', async () => {
    const c = await conversation();
    await heldThen(c);
    await eraseConversationToolApprovalsSubject(T, OWNER);
    const row = await rowOf(c.session);
    expect(row?.resolvedBy).toBe(ERASED);
    expect(row?.status).toBe('approved');
    expect(row?.sealedInput).toBeUndefined();
  });

  it('9. under KMS, a plaintext-marked input does not open', async () => {
    const plain = await conversation();
    await heldThen(plain);
    const plainRow = (await rowOf(plain.session))!;
    expect(plainRow.sealedInput?.startsWith('toolapproval:plain:v1:'), 'fixture: sealed without KMS').toBe(true);
    configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));
    try {
      expect(await openSealedInput(plainRow)).toBeUndefined();
      const sealed = await conversation();
      await heldThen(sealed);
      const kmsRow = (await rowOf(sealed.session))!;
      expect(kmsRow.sealedInput?.startsWith('toolapproval:kms:v1:'), 'fixture: sealed with KMS').toBe(true);
      expect(await openSealedInput(kmsRow)).toEqual(INPUT);
    } finally { _resetKmsForTesting(); }
  });

  it('10. the default-window sweep drops a lapsed input with no later turn, except under hold', async () => {
    const c = await conversation();
    await heldThen(c);
    const later = Date.now() + 2 * 60 * 60_000;
    await setRetentionHold(T, 'adr1156p2 test');
    try {
      await runDefaultWindowSweeps(later);
      expect((await rowOf(c.session))?.sealedInput, 'kept under legal hold').toBeTruthy();
    } finally { await clearRetentionHold(T); }
    await runDefaultWindowSweeps(Date.now());
    expect((await rowOf(c.session))?.sealedInput, 'kept inside the window').toBeTruthy();
    await runDefaultWindowSweeps(later);
    const row = await rowOf(c.session);
    expect(row?.status, 'the approval stays for P1').toBe('approved');
    expect(row?.sealedInput).toBeUndefined();
  });
  it('11. a pending ask keeps its sealed input until it is decided', async () => {
    const c = await conversation();
    await c.turn(INPUT);
    expect((await rowOf(c.session))?.status, 'fixture: an ask is pending').toBe('pending');
    // A turn and the retention sweep both run while the ask is still pending.
    await c.turn(null);
    await runDefaultWindowSweeps(Date.now() + 2 * 60 * 60_000);
    const pending = await rowOf(c.session);
    expect(pending?.status).toBe('pending');
    expect(pending?.sealedInput, 'the pending ask keeps its input').toBeTruthy();
    expect((await resolveToolApproval(T, c.session, PROBE, 'approved', OWNER, pending!.requestedAt, 'call')).ok).toBe(true);
    ran.length = 0;
    const out = await c.turn(null);
    expect(ran, 'the approval runs the call').toEqual([INPUT]);
    expect(out?.settledApprovals?.map((a) => a.outcome)).toEqual(['ran']);
  });
  it('12. a pending ask keeps its sealed input for 24 hours, then not', async () => {
    const c = await conversation();
    await c.turn(INPUT);
    const asked = Date.parse((await rowOf(c.session))!.requestedAt);
    await runDefaultWindowSweeps(asked + 23 * 60 * 60_000);
    expect((await rowOf(c.session))?.sealedInput, 'kept inside 24 h').toBeTruthy();
    await runDefaultWindowSweeps(asked + 25 * 60 * 60_000);
    const row = await rowOf(c.session);
    expect(row?.status, 'the ask stays pending').toBe('pending');
    expect(row?.sealedInput, 'dropped after 24 h').toBeUndefined();
    expect((await resolveToolApproval(T, c.session, PROBE, 'approved', OWNER, row!.requestedAt, 'call')).ok).toBe(true);
    ran.length = 0;
    await c.turn(null);
    expect(ran, 'with no input left, the next turn does not run it (P1: the model repeats the call)').toEqual([]);
    expect((await rowOf(c.session))?.status, 'the approval stays for P1').toBe('approved');
  });
});
