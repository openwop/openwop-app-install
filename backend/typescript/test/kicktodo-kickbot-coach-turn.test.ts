/**
 * ADR 0689 — KickBot speaks first.
 *
 *  - the participant's 1:1 with KickBot is opened-or-resumed by the SAME dmKey
 *    the chat route uses, so the sidebar and the proactive turn share ONE
 *    conversation; two participants get two conversations; the tenant-scoped
 *    welcome id is never the target;
 *  - a reminder occasion enqueues ONE fire-now job on the EXISTING convene
 *    turn-workflow (no new in-tree workflow — the pin-site ratchet is shrink-only),
 *    as KickBot, on the managed tier, into that DM, carrying `actingUserId` so
 *    the guide's gated read tools authorize; a second enqueue the same local
 *    day re-puts the SAME job (idempotent);
 *  - honest skips: wrong owner (uniform not-found), snoozed (not-active),
 *    muted (quiet hours), nothing pending;
 *
 * Isolation (grade-tests w41): every case enrolls its OWN participant, so jobs,
 * DMs and check-ins never leak between cases and the file passes under shuffle.
 *  - an award occasion is keyed per award, not per day;
 *  - the reminder-loop chain carries the second node after `remind`;
 *  - the node skips honestly on a host without the op.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { setNotificationBackend } from '../src/notifications/emitter.js';
import { setNotificationMuteResolver } from '../src/host/notificationPolicy.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { setEnrollmentSnooze } from '../src/features/kicktodo-core/progressService.js';
import { todayFor, submitCheckIn } from '../src/features/kicktodo-core/todayService.js';
import { ensureKickBot, KICKBOT_ROSTER_ID } from '../src/features/kicktodo-core/kickbotService.js';
import { findByDmKey, dmKeyOf, userRef, agentRef, getConversationMeta } from '../src/host/conversationStore.js';
import { listJobsForSubject, type ScheduledJob } from '../src/host/schedulingService.js';
import { kickbotConversationFor, enqueueKickbotCoachTurn, localDayIn } from '../src/features/kicktodo-core/kickbotCoachTurnService.js';
import { KICKTODO_CONVENE_TURN_WORKFLOW_ID, KICKTODO_CONVENE_CREDENTIAL_REF, seedKicktodoConveneTurnWorkflow } from '../src/features/kicktodo-core/conveneTurnWorkflow.js';
import { getChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { buildKicktodoLoopWorkflow } from '../src/features/kicktodo-core/builtinWorkflows.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import agentRunnerNode from '../src/host/agentRunnerNode.js';
import type { AiToolCallRequest, AiToolCallResult, NodeContext } from '../src/executor/types.js';

const T = 'tenant-coach-turn';
let challengeId = '';

/** A participant of their own: a fresh enrollment in the shared published challenge. */
async function participant(owner: string): Promise<string> {
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: owner, challengeId, challengeVersion: 1, timezone: 'UTC' });
  return enrollment.id;
}

async function coachJobs(owner: string): Promise<ScheduledJob[]> {
  return (await listJobsForSubject(T, { kind: 'user', id: owner })).filter((j) => j.metadata?.['purpose'] === 'kickbot-coach-turn');
}

beforeAll(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  setNotificationBackend(storage);
  setNotificationMuteResolver(async () => false);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  const draft = await createDraft({
    tenantId: T, title: 'Coach Turn Challenge', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'walk', day: 1, title: 'Morning walk', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  challengeId = draft.id;
  // The convene turn-workflow is chain-backed (drained off the in-tree pin site), so
  // its pack must be loaded before the seed can register it under its id.
  _resetChainRegistryForTest();
  loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  seedKicktodoConveneTurnWorkflow();
});

afterAll(() => {
  __resetHostExtPersistence();
  getAgentRegistry()._resetForTest();
});

describe('the participant’s 1:1 with KickBot (ADR 0689)', () => {
  it('opens by the chat route’s dmKey, resumes idempotently, and is per participant — never the tenant-scoped welcome id', async () => {
    const OWNER = 'user:coach-dm-a';
    const OTHER = 'user:coach-dm-b';
    const bot = await ensureKickBot(T);
    const a1 = await kickbotConversationFor(T, OWNER);
    const a2 = await kickbotConversationFor(T, OWNER);
    expect(a2).toBe(a1);
    // The SAME key `POST /chat/conversations/open {type:'agent', subjectRef}` computes.
    const viaRoute = await findByDmKey(T, dmKeyOf(userRef(OWNER), agentRef(KICKBOT_ROSTER_ID)));
    expect(viaRoute?.conversationId).toBe(a1);
    expect(viaRoute?.type).toBe('agent');
    expect(viaRoute?.ownerUserId).toBe(OWNER);
    expect(await hostExtStorage().getChatSession(T, a1)).not.toBeNull();
    // A second participant in the SAME tenant gets a DIFFERENT conversation.
    const b = await kickbotConversationFor(T, OTHER);
    expect(b).not.toBe(a1);
    // And neither is the tenant-scoped welcome conversation.
    expect(a1).not.toBe(bot.conversationId);
    expect(b).not.toBe(bot.conversationId);
    expect((await getConversationMeta(T, a1))?.participants.map((p) => p.subjectRef)).toContain(agentRef(KICKBOT_ROSTER_ID));
  });
});

describe('the queued coach turn RUNS — not just its job shape (kicktodo.com 2026-09-16)', () => {
  // The first version of this suite asserted `configurable.agentId === KICKBOT_ROSTER_ID`
  // and never executed the turn. On production every reminder turn then failed
  // `agent_not_found: agent 'host:kickbot' is not installed on this host` (fixed in #3896),
  // and the participant was pushed "Workflow failed". An assertion on the job's shape
  // passes whether or not the registry can resolve the id; only running it cannot.
  it('the enqueued job\'s configurable dispatches through the agent-runner node to KickBot', async () => {
    const OWNER = 'user:coach-run';
    const enrollmentId = await participant(OWNER);
    const queued = await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'reminder' });
    expect(queued.queued).toBe(true);
    const job = (await coachJobs(OWNER)).find((j) => j.jobId === queued.jobId);
    if (!job?.configurable) throw new Error('the queued coach turn must carry a configurable');
    // Production offers the turn KickBot's tools, because the queued job names none, so
    // the model call goes through `callAIWithTools`. An earlier version of this test
    // passed `offerTools: []`, which took the cheap `callAI` path and stayed green while
    // every production turn failed on the tools path (`provider_not_supported` for the
    // managed tier, fixed in #3902). The test must take the path production takes.
    expect(job.configurable['offerTools']).toBeUndefined();
    const callAI = vi.fn(async (): Promise<AiToolCallResult> => { throw new Error('the coach turn must offer tools; callAI is the cheap path'); });
    const callAIWithTools = vi.fn(async (_req: AiToolCallRequest): Promise<AiToolCallResult> => ({
      content: 'One small step today: the morning walk.',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'test',
    }));
    const ctx: NodeContext = {
      runId: 'run-coach-turn-exec',
      nodeId: 'coach-turn',
      tenantId: T,
      attempt: 1,
      secrets: {},
      inputs: { ...job.configurable, conversationId: undefined },
      config: {},
      configurable: {},
      emit: async () => ({ eventId: 'evt-coach-turn', sequence: 0 }),
      callAI,
      callAIWithTools,
    };
    const out = await agentRunnerNode.execute(ctx);
    expect(out.status, JSON.stringify(out)).toBe('success');
    expect(callAI).not.toHaveBeenCalled();
    expect(callAIWithTools).toHaveBeenCalledTimes(1);
    const req = callAIWithTools.mock.calls[0]?.[0];
    expect(req?.tools.length ?? 0).toBeGreaterThan(0);
  });
});

describe('enqueueKickbotCoachTurn — reminder occasion', () => {
  it('enqueues ONE fire-now coach turn as KickBot into the DM, idempotent per enrollment per local day', async () => {
    const OWNER = 'user:coach-rem';
    const enrollmentId = await participant(OWNER);
    expect(await coachJobs(OWNER)).toHaveLength(0); // this participant's own count starts at 0
    const first = await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'reminder' });
    expect(first.queued).toBe(true);
    expect(first.conversationId).toBe(await kickbotConversationFor(T, OWNER));
    const again = await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'reminder' });
    expect(again.queued).toBe(true);
    expect(again.jobId).toBe(first.jobId); // same local day ⇒ same job, re-put not duplicated

    const jobs = await coachJobs(OWNER);
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    if (!job) throw new Error('one coach-turn job expected');
    expect(job.jobId).toBe(first.jobId);
    expect(job.workflowId).toBe(KICKTODO_CONVENE_TURN_WORKFLOW_ID);
    expect(job.agentId).toBe(KICKBOT_ROSTER_ID);
    expect(job.rosterId).toBe(KICKBOT_ROSTER_ID);
    expect(job.configurable?.['agentId']).toBe(KICKBOT_ROSTER_ID);
    expect(job.configurable?.['conversationId']).toBe(first.conversationId);
    expect(job.configurable?.['credentialRef']).toBe(KICKTODO_CONVENE_CREDENTIAL_REF); // managed — no BYOK
    expect(job.metadata?.['actingUserId']).toBe(OWNER); // the guide's gated read tools authorize
    expect(job.metadata?.['occasion']).toBe('reminder');
    // The task is advisory and names the pending action; it never guilt-trips.
    expect(String(job.configurable?.['task'])).toMatch(/Morning walk/);
    expect(String(job.configurable?.['task'])).toMatch(/Never guilt-trip/);
    expect(String(job.configurable?.['task'])).toMatch(/never log a check-in/);
    // The workflow it fires is the existing convene turn-workflow — one agent-runner node,
    // now CHAIN-BACKED under the same id (`core.openwop.workflows.kicktodo-convene-turn`).
    // The wiring is asserted, not just the registration (the ADR 0703 D3 lesson): the job
    // drives the node through `configurable`, so each port MUST read its bare run variable.
    const wf = getChainBackedWorkflow(KICKTODO_CONVENE_TURN_WORKFLOW_ID);
    expect(wf?.nodes).toHaveLength(1);
    expect(wf?.nodes[0]?.typeId).toBe('local.openwop-app.agent-runner');
    expect(wf?.nodes[0]?.outputRole, 'the single terminal node keeps the primary role the literal declared').toBe('primary');
    for (const port of ['agentId', 'task', 'credentialRef', 'conversationId']) {
      expect(wf?.nodes[0]?.inputs?.[port], `${port} is bound to its run variable`).toEqual({ type: 'variable', variableName: port });
      expect(job.configurable?.[port], `the job supplies ${port}`).toBeDefined();
    }
  });

  it('honest skips: wrong owner → not-found (uniform); snoozed → not-active; muted → muted', async () => {
    const OWNER = 'user:coach-skip';
    const OTHER = 'user:coach-skip-other';
    const enrollmentId = await participant(OWNER);
    expect(await enqueueKickbotCoachTurn(T, { ownerSubject: OTHER, enrollmentId, occasion: 'reminder' })).toEqual({ queued: false, reason: 'not-found' });
    await setEnrollmentSnooze(T, enrollmentId, OWNER, true);
    expect(await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'reminder' })).toEqual({ queued: false, reason: 'not-active' });
    await setEnrollmentSnooze(T, enrollmentId, OWNER, false);
    setNotificationMuteResolver(async () => true);
    try {
      expect(await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'reminder' })).toEqual({ queued: false, reason: 'muted' });
    } finally {
      setNotificationMuteResolver(async () => false); // the beforeAll value (no mutes)
    }
    expect(await coachJobs(OWNER)).toHaveLength(0); // no skip enqueued anything
  });

  it('honest skip: nothing pending today → nothing-pending (never a guilt ping)', async () => {
    const OWNER = 'user:coach-done';
    const enrollmentId = await participant(OWNER);
    const today = await todayFor(T, OWNER);
    const card = today.enrollments.find((e) => e.enrollmentId === enrollmentId)?.actions[0]?.occurrence.cardId;
    if (!card) throw new Error('the day-1 action must be due today');
    await submitCheckIn(T, OWNER, card, {});
    expect(await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'reminder' })).toEqual({ queued: false, reason: 'nothing-pending' });
    expect(await coachJobs(OWNER)).toHaveLength(0);
  });

  it('an award occasion is keyed per award, not per day', async () => {
    const OWNER = 'user:coach-award';
    const enrollmentId = await participant(OWNER);
    const a = await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'award', awardKind: 'first-check-in' });
    const b = await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'award', awardKind: 'streak-7' });
    const a2 = await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'award', awardKind: 'first-check-in' });
    expect(a.queued && b.queued && a2.queued).toBe(true);
    expect(a.jobId).not.toBe(b.jobId);
    expect(a2.jobId).toBe(a.jobId);
    const jobs = await coachJobs(OWNER);
    expect(jobs.map((j) => j.jobId).sort()).toEqual([a.jobId, b.jobId].sort()); // two awards ⇒ exactly two jobs
    expect(jobs.every((j) => j.metadata?.['occasion'] === 'award')).toBe(true);
    expect(String(jobs.find((j) => j.jobId === a.jobId)?.configurable?.['task'])).toMatch(/first-check-in/);
  });

  it('localDayIn is the participant’s calendar day, and survives a bad zone', () => {
    const at = new Date('2026-09-15T23:30:00Z');
    expect(localDayIn('UTC', at)).toBe('2026-09-15');
    expect(localDayIn('Pacific/Auckland', at)).toBe('2026-09-16');
    expect(localDayIn('Not/AZone', at)).toBe('2026-09-15');
  });
});

describe('the reminder-loop chain and the node (ADR 0689)', () => {
  it('reminder-loop is remind → coach-turn, and the chain-backed definition carries both', () => {
    _resetChainRegistryForTest();
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    const wf = buildKicktodoLoopWorkflow('openwop-app.kicktodo.reminder-loop');
    const ids = wf.nodes.map((n) => n.nodeId);
    expect(ids.some((id) => id.endsWith('remind'))).toBe(true);
    expect(ids.some((id) => id.endsWith('coach-turn'))).toBe(true);
    expect(wf.nodes.map((n) => n.typeId)).toContain('feature.kicktodo.nodes.kickbot-coach-turn');
    const edge = (wf.edges ?? []).find((e) => e.targetNodeId.endsWith('coach-turn'));
    expect(edge?.sourceNodeId.endsWith('remind')).toBe(true);
  });

  it('the node composes the core op and skips honestly on a host without it', async () => {
    const enrollmentId = 'enr-node-unit';
    const OWNER = 'user:coach-node';
    const mod = await import(new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href);
    // The pack is untyped `.mjs`: this one boundary cast is the honest ceiling.
    const node = (mod.default as Record<string, (ctx: unknown) => Promise<{ status: string; outputs: Record<string, unknown> }>>)['feature.kicktodo.nodes.kickbot-coach-turn'];
    expect(typeof node).toBe('function');
    const calls: unknown[] = [];
    const withOp = await node({
      inputs: { enrollmentId, ownerSubject: OWNER, occasion: 'reminder' },
      features: { 'kicktodo-core': { enroll: async () => ({}), kickbotCoachTurn: async (a: unknown) => { calls.push(a); return { queued: true, conversationId: 'dm-1' }; } } },
    });
    expect(withOp).toEqual({ status: 'success', outputs: { queued: true, reason: null, conversationId: 'dm-1' } });
    expect(calls[0]).toEqual({ enrollmentId, ownerSubject: OWNER, occasion: 'reminder' });
    const without = await node({ inputs: { enrollmentId, ownerSubject: OWNER }, features: { 'kicktodo-core': { enroll: async () => ({}) } } });
    expect(without.outputs['reason']).toBe('host-lacks-op');
    expect(without.status).toBe('success');
  });
});
