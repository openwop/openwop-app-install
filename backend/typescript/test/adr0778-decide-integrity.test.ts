/**
 * ADR 0778 — the interrupts inbox's decide integrity, witnessed on the REAL
 * executor + event log through `resolveAndResume`, the one choke point every
 * decide lane shares.
 *
 *  - D1 (`APWF-1`, fail-open): an accept that LOSES the resolve claim to a
 *    reject / the timeout sweep used to append `interrupt.resolved{accepted}`
 *    and resume the run anyway, completing a rejected gate.
 *  - D3 (`APWF-3`): a run cancel left the run's OWN gates open and decidable.
 *  - D4 (`APWF-4`): the token lane invented `anon-N` voters and ignored group ACLs.
 *  - D5 (`APWF-5`): MCP consumed a quorum gate before voting, stranding the run.
 *  - D7 (`APWF-7`): the lazy timeout lived in one route, not the choke point.
 *  - C1: the timer sweep claims first, so its resume must be PRECLAIMED or D1
 *    strands every timed wait.
 *
 * Tracker: TST-BDC-2 (docs/steward/TEST-ASSESSMENT.md).
 *
 * Red when (sabotage-witnessed, wave 60): the accept path stops claiming (or
 * audits an override before it claims); a lost claim always or never returns
 * quietly; a closed run log is not mapped to 409; the run cancel stops closing
 * its own gates or lets a failed close abort it; the terminal-run refusal
 * moves after the claim; the token lane stops requiring a named `voter`;
 * ledger votes stop deduplicating by voter; a group ACL stops checking
 * eligibility or the signed voter binding; MCP stops refusing a gate that
 * needs a named approver; the lazy timeout leaves the choke point; the timer
 * sweep's resume is not preclaimed.
 *
 * Double guards (recorded, wave 60):
 *  - a voterless quorum vote is refused by `assertTokenQuorumVote` ("on this
 *    lane must name its `voter`", the OUTER check, asserted by message) and
 *    again by `recordQuorumVote` ("must identify its voter"), which the token
 *    lane therefore never reaches.
 *  - a group ACL vote needs BOTH eligibility and the signed per-approver link;
 *    the "outside the group" cases send a VALID signature so eligibility is the
 *    check that refuses, and the real-member case refuses an unsigned member.
 *
 * @see docs/adr/0778-interrupts-inbox-decide-integrity.md
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { setChatStorage } from '../src/host/chatSurface.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { executeRun } from '../src/executor/executor.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { __awaitRunResumeChainForTests, resolveAndResume, timerResumeContinuation } from '../src/routes/interrupts.js';
import { cancelRunAndCascade } from '../src/host/runCancel.js';
import { resumeInterrupt } from '../src/host/mcpSemantics.js';
import { tallyDecisions } from '../src/host/reviewDecisionLedger.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Principal, RunRecord } from '../src/types.js';
import { installRejectedGateRouter } from './support/rejectedGateRouter.js';
import { createGroup, createMember } from '../src/host/accessControlService.js';
import { signVoterBinding } from '../src/host/interruptVoterBinding.js';
import { getEventLog } from '../src/executor/eventLog.js';

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0778-')) });
setChatStorage(storage);
const hostSuite = createHostAdapterSuite({ storage });
installRejectedGateRouter(storage, hostSuite);

const WF = {
  single: 'wf.adr0778.single',
  quorumOpen: 'wf.adr0778.quorum-open',
  quorumGroup: 'wf.adr0778.quorum-group',
  groupSingle: 'wf.adr0778.group-single',
  timed: 'wf.adr0778.timed',
  clarify: 'wf.adr0778.clarify',
  override: 'wf.adr0778.override',
} as const;

function gateWorkflow(workflowId: string, gate: { typeId: string; config: Record<string, unknown> }): WorkflowDefinition {
  return {
    workflowId,
    nodes: [
      { nodeId: 'gate', typeId: gate.typeId, config: gate.config },
      { nodeId: 'after', typeId: 'core.noop', config: {} },
    ],
    edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'after', triggerRule: 'all_success' }],
  };
}

beforeAll(() => {
  ensureNodesRegistered();
  registerHostWorkflow(gateWorkflow(WF.single, { typeId: 'core.approvalGate', config: { prompt: 'Ship it?' } }));
  registerHostWorkflow(gateWorkflow(WF.quorumOpen, { typeId: 'core.approvalGate', config: { prompt: 'Two of you', requiredApprovals: 2, approversList: [], actions: ['accept', 'reject'] } }));
  registerHostWorkflow(gateWorkflow(WF.quorumGroup, { typeId: 'core.approvalGate', config: { prompt: 'The group decides', requiredApprovals: 2, approverGroupRefs: ['grp-adr0778-approvers'], actions: ['accept', 'reject'] } }));
  registerHostWorkflow(gateWorkflow(WF.groupSingle, { typeId: 'core.approvalGate', config: { prompt: 'The group decides', approverGroupRefs: ['grp-adr0778-approvers'], actions: ['accept', 'reject'] } }));
  registerHostWorkflow(gateWorkflow(WF.timed, { typeId: 'core.approvalGate', config: { prompt: 'Quick!', timeoutMs: 1 } }));
  registerHostWorkflow(gateWorkflow(WF.override, { typeId: 'core.interrupt', config: { kind: 'approval', data: { prompt: 'Two, or an override', requiredApprovals: 2, actions: ['accept', 'reject', 'override'], override: { requiredRole: 'owner' }, overrideBypassesQuorum: true } } }));
  registerHostWorkflow(gateWorkflow(WF.clarify, { typeId: 'core.interrupt', config: { kind: 'clarification', data: { prompt: 'Which one?' } } }));
});

async function suspended(workflowId: string, metadata: Record<string, unknown> = {}): Promise<{ run: RunRecord; interruptId: string }> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-adr0778-${Math.random().toString(36).slice(2)}`, workflowId, tenantId: 'default',
    status: 'pending', inputs: {}, metadata, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const def = (await hostSuite.workflowCatalog.getWorkflow(workflowId))!.definition;
  const status = (await executeRun(storage, run, def)).status;
  expect(status.startsWith('waiting')).toBe(true);
  const [open] = await storage.listOpenInterrupts(run.runId);
  return { run: (await storage.getRun(run.runId))!, interruptId: open!.interruptId };
}

/** A store whose FIRST read of `interruptId` returns the row as it was, then lets
 *  a competing decision win the claim — the interleaving a real race produces
 *  (the accept read the open row; the sweep/reject claimed before it wrote). */
function racing(base: Storage, interruptId: string, competitor: unknown): Storage {
  let fired = false;
  return new Proxy(base, {
    get(target, key, receiver) {
      if (key === 'getInterrupt') {
        return async (id: string) => {
          const row = await base.getInterrupt(id);
          if (id === interruptId && !fired) {
            fired = true;
            expect(await base.resolveInterrupt(id, competitor, new Date().toISOString())).toBe(true);
          }
          return row;
        };
      }
      const v = Reflect.get(target, key, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

describe('ADR 0778 D1 — the accept path claims, like both reject paths', () => {
  it('an accept that LOSES the claim to a rejection is refused and resumes nothing (was: fail-open)', async () => {
    const { run, interruptId } = await suspended(WF.single);
    const store = racing(storage, interruptId, { action: 'reject', reason: 'timeout' });
    await expect(resolveAndResume(store, hostSuite, interruptId, { action: 'accept' }, { capabilityToken: true }))
      .rejects.toMatchObject({ httpStatus: 409 });
    await __awaitRunResumeChainForTests(run.runId);
    const events = await storage.listEvents(run.runId);
    expect(
      events.some((e) => e.type === 'interrupt.resolved' && (e.payload as { action?: string }).action === 'accept'),
      'the loser recorded an acceptance the store never made',
    ).toBe(false);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'gate'), 'the loser completed a rejected gate').toBe(false);
    expect(events.some((e) => e.type === 'node.started' && e.nodeId === 'after'), 'the loser released the all_success branch').toBe(false);
  });

  it('a vote that TIPS a quorum but loses the claim to the TIMEOUT is a 409, not "OK" (grade-code APCD-2)', async () => {
    const { interruptId } = await suspended(WF.quorumOpen);
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'accept', voter: 'approver-a' }, { capabilityToken: true });
    const store = racing(storage, interruptId, { action: 'reject', reason: 'timeout' });
    await expect(resolveAndResume(store, hostSuite, interruptId, { action: 'accept', voter: 'approver-b' }, { capabilityToken: true }))
      .rejects.toMatchObject({ httpStatus: 409, message: 'interrupt already resolved — a different decision won' });
  });

  it('a REJECT that loses the claim to an ACCEPT is a 409, not "OK" (grade-code APCD-3)', async () => {
    const { interruptId } = await suspended(WF.single);
    const store = racing(storage, interruptId, { action: 'accept' });
    await expect(resolveAndResume(store, hostSuite, interruptId, { action: 'reject' }, { capabilityToken: true }))
      .rejects.toMatchObject({ httpStatus: 409, message: 'interrupt already resolved — a different decision won' });
  });

  it('a claim won as the run log closes answers 409, not a 500 (grade-code APCD-6)', async () => {
    const { run, interruptId } = await suspended(WF.single);
    // A cancel lands between the terminal-run read and the claim: the log closes.
    const store = new Proxy(storage, {
      get(target, key, receiver) {
        if (key === 'resolveInterrupt') {
          return async (...args: Parameters<Storage['resolveInterrupt']>) => {
            await getEventLog().append({ runId: run.runId, type: 'run.cancelled', payload: { reason: 'raced' } });
            return storage.resolveInterrupt(...args);
          };
        }
        const v = Reflect.get(target, key, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await expect(resolveAndResume(store, hostSuite, interruptId, { action: 'accept' }, { capabilityToken: true }))
      .rejects.toMatchObject({ httpStatus: 409 });
  });

  it('a vote that TIPS a quorum but loses the claim to an identical tip returns quietly (C2)', async () => {
    const { interruptId } = await suspended(WF.quorumOpen);
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'accept', voter: 'approver-a' }, { capabilityToken: true });
    const store = racing(storage, interruptId, { action: 'accept', voter: 'approver-c' });
    await expect(resolveAndResume(store, hostSuite, interruptId, { action: 'accept', voter: 'approver-b' }, { capabilityToken: true }))
      .resolves.toBeUndefined();
  });
});

describe('ADR 0778 D3 — a cancelled run closes its own gates', () => {
  it('cancel resolves the run\'s own open interrupt with the cascade marker; deciding it is 409', async () => {
    const { run, interruptId } = await suspended(WF.single);
    expect(await cancelRunAndCascade(storage, run, 'user-cancelled')).toBe('cancelled');
    expect(await storage.listOpenInterrupts(run.runId), 'the gate outlived its run').toHaveLength(0);
    expect((await storage.getInterrupt(interruptId))?.resolvedValue).toMatchObject({ cancelled: true });
    await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'accept' }, { capabilityToken: true }))
      .rejects.toMatchObject({ httpStatus: 409 });
  });

  it('a failing gate close does not abort the cancel (compensation + cascade still run — grade-code APCD-4)', async () => {
    const { run } = await suspended(WF.single);
    const flaky = new Proxy(storage, {
      get(target, key, receiver) {
        if (key === 'resolveInterrupt') return async () => { throw new Error('transient db error'); };
        const v = Reflect.get(target, key, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await expect(cancelRunAndCascade(flaky, run, 'user-cancelled')).resolves.toBe('cancelled');
    // The cancel completed past the failed close: the run is cancelled, and the
    // gate the failed write could not close is still open (the terminal-run rule
    // keeps it out of every inbox).
    expect((await storage.getRun(run.runId))?.status).toBe('cancelled');
    expect(await storage.listOpenInterrupts(run.runId)).toHaveLength(1);
  });

  it('a stray open gate on a TERMINAL run is refused before any claim, and stays unconsumed', async () => {
    const { run, interruptId } = await suspended(WF.single);
    await storage.updateRun(run.runId, { status: 'failed' });
    await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'accept' }, { capabilityToken: true }))
      .rejects.toMatchObject({ httpStatus: 409 });
    expect((await storage.getInterrupt(interruptId))?.resolvedAt, 'the refusal consumed the interrupt').toBeUndefined();
  });
});

describe('ADR 0778 D4 — the token lane counts real, eligible voters', () => {
  it('a voterless vote on an OPEN quorum gate is 400, and nothing is recorded (was: `anon-N`)', async () => {
    const { interruptId } = await suspended(WF.quorumOpen);
    for (let i = 0; i < 2; i++) {
      await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'accept' }, { capabilityToken: true }))
        .rejects.toMatchObject({ httpStatus: 400, message: 'A quorum vote on this lane must name its `voter`.' });
    }
    const tally = await tallyDecisions(interruptId);
    expect(tally.accepts.length + tally.rejects.length).toBe(0);
    expect((await storage.getInterrupt(interruptId))?.resolvedAt, 'two voterless POSTs met the quorum').toBeUndefined();
  });

  it('one token voter voting twice counts ONCE — a repeated name cannot meet the quorum', async () => {
    const { run, interruptId } = await suspended(WF.quorumOpen);
    for (let i = 0; i < 3; i++) {
      await resolveAndResume(storage, hostSuite, interruptId, { action: 'accept', voter: 'approver-same' }, { capabilityToken: true });
    }
    const tally = await tallyDecisions(interruptId);
    expect(tally.accepts).toHaveLength(1);
    expect((await storage.getInterrupt(interruptId))?.resolvedAt).toBeUndefined();
    expect((await storage.getRun(run.runId))?.status).toBe('waiting-approval');
  });

  it('the open quorum contract still counts distinct NAMED voters (conformance-interrupt-quorum)', async () => {
    const { run, interruptId } = await suspended(WF.quorumOpen);
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'accept', voter: 'approver-1' }, { capabilityToken: true });
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'accept', voter: 'approver-2' }, { capabilityToken: true });
    await __awaitRunResumeChainForTests(run.runId);
    expect((await storage.getRun(run.runId))?.status).toBe('completed');
  });

  it('a GROUP-only quorum gate refuses a voter outside the group (was: any voter, no signature)', async () => {
    const { interruptId } = await suspended(WF.quorumGroup);
    const token = (await storage.getInterrupt(interruptId))!.token;
    for (const voter of ['mallory-1', 'mallory-2']) {
      // A VALID signed link for a non-member: eligibility is what refuses it.
      await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'accept', voter, voterSig: signVoterBinding(token, voter) }, { capabilityToken: true }))
        .rejects.toMatchObject({ httpStatus: 403, message: 'The `voter` is not an eligible approver for this gate.' });
    }
    expect((await storage.getInterrupt(interruptId))?.resolvedAt).toBeUndefined();
  });

  it('a REAL group member votes with their signed link, and two of them meet the quorum', async () => {
    // The positive half: "emailed recipients are unaffected" (ADR 0778 D4(c)).
    const ORG = 'org-adr0778';
    const alice = await createMember({ tenantId: 'default', orgId: ORG, displayName: 'Alice', subject: 'member-adr0778-alice' });
    const bob = await createMember({ tenantId: 'default', orgId: ORG, displayName: 'Bob', subject: 'member-adr0778-bob' });
    const g = await createGroup({ tenantId: 'default', orgId: ORG, name: 'adr0778-approvers', memberIds: [alice.memberId, bob.memberId] });
    const wf = `wf.adr0778.real-group.${Date.now()}`;
    registerHostWorkflow(gateWorkflow(wf, { typeId: 'core.approvalGate', config: { prompt: 'The group decides', requiredApprovals: 2, approverGroupRefs: [g.groupId], actions: ['accept', 'reject'] } }));
    const { run, interruptId } = await suspended(wf, { approverOrgId: ORG });
    const token = (await storage.getInterrupt(interruptId))!.token;
    // A member WITHOUT the signature is refused — the shared token is not enough.
    await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'accept', voter: 'member-adr0778-alice' }, { capabilityToken: true }))
      .rejects.toMatchObject({ httpStatus: 403, message: 'This vote requires the signed per-approver link from your notification email.' });
    for (const voter of ['member-adr0778-alice', 'member-adr0778-bob']) {
      await resolveAndResume(storage, hostSuite, interruptId, { action: 'accept', voter, voterSig: signVoterBinding(token, voter) }, { capabilityToken: true });
    }
    await __awaitRunResumeChainForTests(run.runId);
    expect((await storage.getRun(run.runId))?.status).toBe('completed');
  });

  it('a GROUP-only single-approver gate refuses a voter outside the group (was: open)', async () => {
    const { interruptId } = await suspended(WF.groupSingle);
    const token = (await storage.getInterrupt(interruptId))!.token;
    await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'accept', voter: 'mallory', voterSig: signVoterBinding(token, 'mallory') }, { capabilityToken: true }))
      .rejects.toMatchObject({ httpStatus: 403, message: 'The `voter` is not an eligible approver for this gate.' });
    expect((await storage.getInterrupt(interruptId))?.resolvedAt).toBeUndefined();
  });
});

describe('ADR 0778 D5 — MCP never consumes a gate that needs a named approver', () => {
  const principal: Principal = { principalId: 'mcp:peer', tenants: ['default'], token: 'mcp-peer-test-token' };
  const deps = { storage, hostSuite, principal };

  it('a quorum gate is refused and stays OPEN for the inbox (was: consumed, run stranded)', async () => {
    const { run, interruptId } = await suspended(WF.quorumOpen);
    const out = await resumeInterrupt(deps, interruptId, { action: 'accept', voter: 'peer' });
    expect(out.kind).toBe('failed');
    expect((await storage.getInterrupt(interruptId))?.resolvedAt, 'MCP consumed a gate it could not decide').toBeUndefined();
    expect((await storage.getRun(run.runId))?.status).toBe('waiting-approval');
  });

  it('a single-approver gate still resolves over MCP, exactly once', async () => {
    const { run, interruptId } = await suspended(WF.single);
    const first = await resumeInterrupt(deps, interruptId, { action: 'accept' });
    expect(first.kind).not.toBe('failed');
    const replay = await resumeInterrupt(deps, interruptId, { action: 'accept' });
    expect(replay.kind).toBe('failed');
    await __awaitRunResumeChainForTests(run.runId);
    const accepted = (await storage.listEvents(run.runId)).filter((e) => e.type === 'interrupt.resolved');
    expect(accepted).toHaveLength(1);
  });
});

describe('ADR 0778 D7 — expiry is checked at the choke point', () => {
  it('an overdue gate cannot be approved through resolveAndResume (every lane, not just the node route)', async () => {
    const { run, interruptId } = await suspended(WF.timed);
    // Past the 1 ms deadline by a clock move, not a sleep.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'accept' }, { capabilityToken: true }))
        .rejects.toMatchObject({ httpStatus: 409, message: 'approval gate timed out (auto-rejected; reason: timeout)' });
    } finally {
      vi.useRealTimers();
    }
    await __awaitRunResumeChainForTests(run.runId);
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'node.started' && e.nodeId === 'after'), 'an overdue gate was approved').toBe(false);
  });
});

describe('ADR 0778 C1 — the timer sweep resume is preclaimed', () => {
  it('a row the sweep already claimed still resumes its run', async () => {
    const { run, interruptId } = await suspended(WF.clarify);
    const row = (await storage.getInterrupt(interruptId))!;
    // The sweep's claim (`timerResume.ts`), then its continuation.
    expect(await storage.resolveInterrupt(interruptId, { elapsed: true, reason: 'timer' }, new Date().toISOString())).toBe(true);
    await timerResumeContinuation(storage, hostSuite)(row);
    await __awaitRunResumeChainForTests(run.runId);
    expect((await storage.getRun(run.runId))?.status, 'the timed wait never resumed').toBe('completed');
  });
});

describe('ADR 0778 APCD-11 — an override is audited only when it TOOK', () => {
  it('an override that loses the claim to a rejection emits NO approval.overridden and writes NO success audit row', async () => {
    const { run, interruptId } = await suspended(WF.override);
    const audit = vi.spyOn(hostSuite.auditSink, 'record');
    const store = racing(storage, interruptId, { action: 'reject', reason: 'timeout' });
    await expect(resolveAndResume(store, hostSuite, interruptId, { action: 'override', voter: 'boss', reason: 'ship it' }, { capabilityToken: true }))
      .rejects.toMatchObject({ httpStatus: 409 });
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'approval.overridden'), 'a losing override was recorded as taken').toBe(false);
    expect(audit.mock.calls.some(([entry]) => (entry as { action?: string }).action === 'approval.override'), 'a losing override was audited as a success').toBe(false);
    audit.mockRestore();
  });

  it('an override that WINS emits exactly one approval.overridden (the #4229 payload) before interrupt.resolved', async () => {
    const { run, interruptId } = await suspended(WF.override);
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'override', voter: 'boss', reason: 'ship it' }, { capabilityToken: true });
    await __awaitRunResumeChainForTests(run.runId);
    const events = await storage.listEvents(run.runId);
    const overridden = events.filter((e) => e.type === 'approval.overridden');
    expect(overridden).toHaveLength(1);
    expect(overridden[0]!.payload).toEqual({ gateId: interruptId, principal: 'boss', reason: 'ship it' });
    const iOver = events.findIndex((e) => e.type === 'approval.overridden');
    const iResolved = events.findIndex((e) => e.type === 'interrupt.resolved');
    expect(iOver).toBeGreaterThanOrEqual(0);
    expect(iOver).toBeLessThan(iResolved);
  });
});
