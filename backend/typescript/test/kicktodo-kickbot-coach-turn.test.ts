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
 *  - an award occasion is keyed per award, not per day;
 *  - the reminder-loop chain carries the second node after `remind`;
 *  - the node skips honestly on a host without the op.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { setNotificationBackend } from '../src/notifications/emitter.js';
import { setNotificationMuteResolver } from '../src/host/notificationPolicy.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { setEnrollmentSnooze } from '../src/features/kicktodo-core/progressService.js';
import { ensureKickBot, KICKBOT_ROSTER_ID } from '../src/features/kicktodo-core/kickbotService.js';
import { findByDmKey, dmKeyOf, userRef, agentRef, getConversationMeta } from '../src/host/conversationStore.js';
import { listJobsForSubject } from '../src/host/schedulingService.js';
import { kickbotConversationFor, enqueueKickbotCoachTurn, localDayIn } from '../src/features/kicktodo-core/kickbotCoachTurnService.js';
import { KICKTODO_CONVENE_TURN_WORKFLOW_ID, KICKTODO_CONVENE_CREDENTIAL_REF, seedKicktodoConveneTurnWorkflow } from '../src/features/kicktodo-core/conveneTurnWorkflow.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { buildKicktodoLoopWorkflow } from '../src/features/kicktodo-core/builtinWorkflows.js';

const T = 'tenant-coach-turn';
const OWNER = 'user:coach-owner';
const OTHER = 'user:coach-other';
let enrollmentId = '';

beforeAll(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  setNotificationBackend(storage);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  const draft = await createDraft({
    tenantId: T, title: 'Coach Turn Challenge', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'walk', day: 1, title: 'Morning walk', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: OWNER, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  enrollmentId = enrollment.id;
  seedKicktodoConveneTurnWorkflow();
});

afterAll(async () => {
  __resetHostExtPersistence();
  const { getAgentRegistry } = await import('../src/executor/agentRegistry.js');
  getAgentRegistry()._resetForTest();
});

describe('the participant’s 1:1 with KickBot (ADR 0689)', () => {
  it('opens by the chat route’s dmKey, resumes idempotently, and is per participant — never the tenant-scoped welcome id', async () => {
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
    const { vi } = await import('vitest');
    const { default: agentRunnerNode } = await import('../src/host/agentRunnerNode.js');
    const queued = await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'reminder' });
    expect(queued.queued).toBe(true);
    const job = (await listJobsForSubject(T, { kind: 'user', id: OWNER })).find((j) => j.jobId === queued.jobId);
    expect(job?.configurable).toBeDefined();
    // Production offers the turn KickBot's tools, because the queued job names none, so
    // the model call goes through `callAIWithTools`. An earlier version of this test
    // passed `offerTools: []`, which took the cheap `callAI` path and stayed green while
    // every production turn failed on the tools path (`provider_not_supported` for the
    // managed tier, fixed in #3902). The test must take the path production takes.
    expect((job!.configurable as Record<string, unknown>)['offerTools']).toBeUndefined();
    const callAI = vi.fn(async () => { throw new Error('the coach turn must offer tools; callAI is the cheap path'); });
    const callAIWithTools = vi.fn(async () => ({
      content: 'One small step today: the morning walk.',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'test',
    }));
    const out = await agentRunnerNode.execute({
      tenantId: T,
      runId: 'run-coach-turn-exec',
      inputs: { ...(job!.configurable as Record<string, unknown>), conversationId: undefined },
      config: {},
      configurable: {},
      emit: async () => {},
      callAI,
      callAIWithTools,
    } as never);
    expect(out.status, JSON.stringify(out)).toBe('success');
    expect(callAI).not.toHaveBeenCalled();
    expect(callAIWithTools).toHaveBeenCalledTimes(1);
    const req = (callAIWithTools.mock.calls[0] as unknown[])[0] as { tools?: unknown[] };
    expect(Array.isArray(req.tools) && req.tools.length).toBeGreaterThan(0);
  });
});

describe('enqueueKickbotCoachTurn — reminder occasion', () => {
  it('enqueues ONE fire-now coach turn as KickBot into the DM, idempotent per enrollment per local day', async () => {
    const first = await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'reminder' });
    expect(first.queued).toBe(true);
    expect(first.conversationId).toBe(await kickbotConversationFor(T, OWNER));
    const again = await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'reminder' });
    expect(again.queued).toBe(true);
    expect(again.jobId).toBe(first.jobId); // same local day ⇒ same job, re-put not duplicated

    const jobs = (await listJobsForSubject(T, { kind: 'user', id: OWNER })).filter((j) => j.metadata?.['purpose'] === 'kickbot-coach-turn');
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
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
    // The workflow it fires is the existing convene turn-workflow — one agent-runner node.
    const wf = getRegisteredWorkflow(KICKTODO_CONVENE_TURN_WORKFLOW_ID);
    expect(wf?.nodes).toHaveLength(1);
    expect(wf?.nodes[0]?.typeId).toBe('local.openwop-app.agent-runner');
  });

  it('honest skips: wrong owner → not-found (uniform); snoozed → not-active; muted → muted', async () => {
    expect(await enqueueKickbotCoachTurn(T, { ownerSubject: OTHER, enrollmentId, occasion: 'reminder' })).toEqual({ queued: false, reason: 'not-found' });
    await setEnrollmentSnooze(T, enrollmentId, OWNER, true);
    expect(await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'reminder' })).toEqual({ queued: false, reason: 'not-active' });
    await setEnrollmentSnooze(T, enrollmentId, OWNER, false);
    setNotificationMuteResolver(async () => true);
    try {
      expect(await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'reminder' })).toEqual({ queued: false, reason: 'muted' });
    } finally {
      setNotificationMuteResolver(async () => false);
    }
  });

  it('an award occasion is keyed per award, not per day', async () => {
    const a = await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'award', awardKind: 'first-check-in' });
    const b = await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'award', awardKind: 'streak-7' });
    const a2 = await enqueueKickbotCoachTurn(T, { ownerSubject: OWNER, enrollmentId, occasion: 'award', awardKind: 'first-check-in' });
    expect(a.queued && b.queued && a2.queued).toBe(true);
    expect(a.jobId).not.toBe(b.jobId);
    expect(a2.jobId).toBe(a.jobId);
    const jobs = (await listJobsForSubject(T, { kind: 'user', id: OWNER })).filter((j) => j.metadata?.['purpose'] === 'kickbot-coach-turn');
    expect(jobs.map((j) => j.metadata?.['occasion']).sort()).toEqual(['award', 'award', 'reminder']);
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
    const mod = await import(new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href);
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
