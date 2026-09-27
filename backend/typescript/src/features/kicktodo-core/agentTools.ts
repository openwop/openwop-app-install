/**
 * KickTodo chat tools (ADR 0414 P4; ADR 0308 seam) — the read grounding for
 * KickBot and the handoff skills: "what is on my plate today?" answered from
 * ACTUAL app state instead of a guess. Registered via the ONE
 * `registerFeatureAgentTool` seam; pack-allowlisted (never silently added to
 * the ADR 0315 default-on baseline).
 *
 * Vuln-scan posture (the goals-tool precedent): app-state reads FAIL EMPTY
 * without an acting user — a scheduled/system turn with no human principal
 * must not enumerate a participant's plan.
 */

import { createHash } from 'node:crypto';
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { getAgentRegistry } from '../../executor/agentRegistry.js';
import { runAgentDispatch } from '../../host/agentDispatch.js';
import { registerJob, listJobsForSubject, ONE_SHOT_CRON } from '../../host/schedulingService.js';
import { upsertAgentToolAllowlistOverride, clearAgentToolAllowlistOverride } from '../../host/agentToolAllowlistService.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { surfaceDispatchedRun, type TurnRunDispatchSink } from '../../host/turnRunDispatch.js';
import { createLogger } from '../../observability/logger.js';
import { hasKicktodoEnrollmentAuthority } from '../featureRoute.js';
import { KICKTODO_CONVENE_TURN_WORKFLOW_ID, KICKTODO_CONVENE_CREDENTIAL_REF } from './conveneTurnWorkflow.js';
import { KICKTODO_REPLAN_WORKFLOW_ID } from './builtinWorkflows.js';
import { todayFor, journalFor, planFor, submitCheckIn, CheckInDeniedError, EvidenceRequiredError } from './todayService.js';
import { getCard } from '../../host/kanbanService.js';
import { progressFor } from './progressService.js';
import { listEnrollmentsFor } from './enrollmentService.js';

const log = createLogger('kicktodo.agent-tools');

export const KICKTODO_TODAY_TOOL_ID = 'openwop:kicktodo.today';
export const KICKTODO_PROGRESS_TOOL_ID = 'openwop:kicktodo.progress';
export const KICKTODO_JOURNAL_TOOL_ID = 'openwop:kicktodo.journal';
export const KICKTODO_PLAN_TOOL_ID = 'openwop:kicktodo.plan';
export const KICKTODO_CONVENE_TOOL_ID = 'openwop:kicktodo.convene';
export const KICKTODO_REPLAN_TOOL_ID = 'openwop:kicktodo.replan';
export const KICKTODO_LOG_CHECKIN_TOOL_ID = 'openwop:kicktodo.log-checkin';

/** A default forward+recent window for the Plan read when the model passes none:
 *  the last 3 days (recent misses to recover) through the next 14 (what's coming).
 *  `planFor` itself hard-caps the span at 31 days and self-scopes by owner. UTC
 *  day boundaries are fine here — this is coaching context, not a scheduler tick,
 *  and `planFor` maps each activity to its own enrollment-tz local date. */
function defaultPlanWindow(): { from: string; to: string } {
  const day = 86_400_000;
  const now = Date.now();
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(now - 3 * day), to: iso(now + 14 * day) };
}

/** KickBot's FIXED roster id (SSoT: `kickbotService.KICKBOT_ROSTER_ID` =
 *  `host:${slugify('KickBot')}`). Inlined here — NOT imported — because
 *  `kickbotService` imports this module for the tool ids at its top-level
 *  `KICKBOT_TOOL_ALLOWLIST` const, so importing it back would make that const
 *  read an as-yet-undefined tool id under a bidirectional module cycle. The
 *  persona `KickBot` is fixed at creation, so this id never changes. Used only to
 *  attribute the inline `workflow_run` turn KickBot dispatches. */
const KICKBOT_TURN_AGENT_ID = 'host:kickbot';

/** ADR 0442 P5 — the CLOSED set of specialist HANDOFF skills KickBot may convene
 *  (D2 taxonomy). Short name → the pack agentId. Closed by design: convening is
 *  not an open agent-dispatch primitive — only these bounded, read-only advisory
 *  workers, resolved by this map (never a free-form agentId from the model). */
const CONVENABLE_SPECIALISTS: Readonly<Record<string, string>> = {
  'plan-builder': 'feature.kicktodo.agents.plan-builder',
  'safety-reviewer': 'feature.kicktodo.agents.safety-reviewer',
  'progress-verifier': 'feature.kicktodo.agents.progress-verifier',
  'accountability-steward': 'feature.kicktodo.agents.accountability-steward',
};

/** The read-only tool surface KickBot OFFERS a convened specialist. The
 *  specialist's OWN allowlist intersects this (RFC 0002 §A14), so a specialist
 *  can never receive a tool it doesn't declare — and this offered set carries NO
 *  domain-write/egress tool, so a convened specialist cannot write domain state
 *  (the P5 typed-contract guarantee, test-enforced). */
const SPECIALIST_OFFERED_TOOLS = [KICKTODO_TODAY_TOOL_ID, KICKTODO_PROGRESS_TOOL_ID, 'openwop:kicktodo.circles'];

/** Pending (un-fired) convened specialists one participant may hold — bounds live
 *  managed spend + keeps KickBot from fanning out a swarm of specialist runs. */
const MAX_PENDING_CONVENES = 5;

/** The short specialist names KickBot may convene (the closed set). */
export function convenableSpecialists(): string[] {
  return Object.keys(CONVENABLE_SPECIALISTS);
}

/**
 * ADR 0442 P5 (leave-no-trace, code-review hygiene) — clear the read-only
 * confinement overrides `conveneSpecialist` wrote for the specialists in this
 * tenant. Called on KickBot teardown so a convene's durable per-(tenant,agent)
 * override does not persist after the guide is gone. Best-effort.
 */
export async function clearConvenedSpecialistOverrides(tenantId: string): Promise<void> {
  for (const agentId of Object.values(CONVENABLE_SPECIALISTS)) {
    try { await clearAgentToolAllowlistOverride(tenantId, agentId); } catch { /* best-effort */ }
  }
}

/**
 * ADR 0442 P5 — KickBot convenes a bounded specialist HANDOFF skill. Two steps,
 * the endorsed orchestrator-worker split:
 *
 *  1. SYNC contract-check via the shared deterministic `runAgentDispatch` (no
 *     model, no credential): validate the handoff task against the specialist's
 *     schema and confirm its read-only tool confinement BEFORE spending a live
 *     turn — a malformed task is a cheap typed failure, never a wasted run.
 *  2. LIVE convening (async, post-back): fire the specialist ON THE MANAGED TIER
 *     via the existing agent-turn seam — a fire-now one-shot scheduler job running
 *     `KICKTODO_CONVENE_TURN_WORKFLOW_ID`, whose agent-runner runs the specialist
 *     live and posts its advisory reply BACK into KickBot's conversation. This is
 *     the `openwop:tasks.schedule-followup` seam (ADR 0309): a chat-time feature
 *     tool's scope carries no run-starter deps (`storage`/`hostSuite`) so it
 *     cannot `startWorkflowRun`, but it CAN reach the process-global scheduler —
 *     and a synchronous nested live sub-agent inside a tool turn is the discouraged
 *     pattern (cost/blocking/recursion); async post-back is the endorsed split.
 *
 * A convened specialist can never write domain state. On the sync check that is
 * `filterTools` over its read-only allowlist; on the LIVE run it requires an ADR
 * 0104 full-replace tool-allowlist OVERRIDE (set here before firing) — because
 * `runAgentDispatchLive` would otherwise UNION the ADR 0315 default-on baseline
 * (writes + `ai.research.web` egress + `schedule-followup` recursion) onto the
 * allowlist. The override makes the live surface EXACTLY the read-only set.
 * Fail-empty without a human principal; a closed
 * allowlist (never a free-form agentId); unknown/uninstalled specialists are honest
 * typed errors; fail-SOFT to the validated contract when there is no conversation
 * to post into or the run cannot be scheduled.
 */
export async function conveneSpecialist(
  input: Record<string, unknown>,
  scope: { tenantId: string; actingUserId?: string | undefined; agentProfileId?: string | undefined; conversationId?: string | undefined; runId?: string | undefined },
): Promise<{ content: string; isError?: boolean }> {
  // Fail-empty without a human principal — a scheduled/system turn must not
  // convene a specialist over a participant (the kicktodo-tools predicate).
  if (!scope.actingUserId) return { content: JSON.stringify({ error: 'acting_user_required' }), isError: true };
  const specialist = typeof input.specialist === 'string' ? input.specialist : '';
  const agentId = CONVENABLE_SPECIALISTS[specialist];
  if (!agentId) {
    return { content: JSON.stringify({ error: 'unknown_specialist', allowed: convenableSpecialists() }), isError: true };
  }
  const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
  const context = typeof input.context === 'string' ? input.context.trim() : '';
  // Resolve BEFORE dispatch so an uninstalled pack is an honest typed error,
  // not a thrown AgentNotFoundError. (Pack agents resolve tenant-less.)
  const resolved = getAgentRegistry().get(agentId);
  if (!resolved) {
    return { content: JSON.stringify({ error: 'specialist_unavailable', specialist }), isError: true };
  }

  // 1) SYNC contract-check + confinement (no model call).
  const provenance = {
    ...(scope.agentProfileId ? { parentAgentId: scope.agentProfileId } : {}),
    // Derived from the RESOLVED manifest (no hand-held version to drift from the pin).
    ...(resolved.packVersion ? { specialistVersion: resolved.packVersion } : {}),
  };
  const check = runAgentDispatch({
    agentId,
    task: { goal, ...(context ? { context } : {}) },
    availableTools: SPECIALIST_OFFERED_TOOLS,
    validateHandoff: true,
    provenance,
  });
  if (check.status === 'failed') {
    // A malformed handoff task is a typed failure — nothing was run.
    return {
      content: JSON.stringify({ specialist, status: 'failed', ...(check.error ? { error: check.error } : {}), note: 'Handoff contract validation failed — no specialist was run.' }),
      isError: true,
    };
  }

  // 2) LIVE convening (async post-back). Needs a conversation to post into.
  const baseRecord = {
    specialist,
    agentId,
    persona: resolved.persona,
    toolSurface: check.toolSurface, // read-only allowlist — no write/egress tool
    ...(Object.keys(provenance).length ? { provenance } : {}),
  };
  const conversationId = scope.conversationId;
  if (!conversationId) {
    return { content: JSON.stringify({ ...baseRecord, status: 'validated', note: 'Handoff contract + read-only confinement validated. No conversation to post live advice into — convene from a chat turn.' }) };
  }
  // Bound convening: cap pending convened specialists for this participant.
  try {
    const mine = await listJobsForSubject(scope.tenantId, { kind: 'user', id: scope.actingUserId });
    const pending = mine.filter((j) => j.metadata?.['tool'] === KICKTODO_CONVENE_TOOL_ID && typeof j.nextFireAt === 'number');
    if (pending.length >= MAX_PENDING_CONVENES) {
      return { content: JSON.stringify({ error: 'too_many_convenes', message: `${pending.length} specialists are already working — wait for them to reply before convening more.` }), isError: true };
    }
  } catch { /* best-effort cap — never block on the count */ }

  // CONFINE THE LIVE RUN to the specialist's READ-ONLY manifest allowlist. This is
  // load-bearing: without an ADR 0104 override, `runAgentDispatchLive` computes
  // `effectiveToolAllowlist(manifest, undefined)` = manifest ∪ the ADR 0315
  // DEFAULT-ON baseline (kanban.add-todo, documents.draft, email.draft,
  // ai.research.web egress, tasks.schedule-followup, …) — which would hand a
  // convened "read-only advisory" specialist live WRITE + EGRESS + a recursion
  // vector. A FULL-REPLACE override = the manifest allowlist makes
  // `effectiveToolAllowlist` return EXACTLY the read-only set (no baseline union),
  // so the live agent-runner offers the specialist ONLY its read tools. Set it
  // BEFORE firing; fail-SOFT if it can't be set (never run an unconfined specialist).
  try {
    await upsertAgentToolAllowlistOverride(scope.tenantId, agentId, {
      toolAllowlist: resolved.toolAllowlist ?? [],
      note: 'ADR 0442 P5 — read-only confinement for a convened KickTodo specialist (excludes the ADR 0315 write/egress baseline).',
      updatedBy: 'system:kickbot-convene',
    });
  } catch {
    return { content: JSON.stringify({ ...baseRecord, status: 'validated', note: 'Handoff contract validated, but the specialist could not be confined for a live run just now.' }) };
  }

  // Deterministic jobId (retry-safe): an identical convene re-puts the same row.
  const key = createHash('sha256').update([conversationId, agentId, goal].join('|')).digest('hex').slice(0, 32);
  const prompt = [`A KickTodo participant needs your help. ${goal}`, ...(context ? [`Context: ${context}`] : [])].join('\n');
  try {
    await registerJob({
      jobId: `kickbot-convene:${key}`,
      tenantId: scope.tenantId,
      cronExpr: ONE_SHOT_CRON,
      firstFireAtMs: Date.now(), // fire on the next tick — convene now
      workflowId: KICKTODO_CONVENE_TURN_WORKFLOW_ID,
      ownerSubject: { kind: 'user', id: scope.actingUserId }, // the participant's Schedules tab lists/cancels it
      agentId,
      metadata: { tool: KICKTODO_CONVENE_TOOL_ID, actingUserId: scope.actingUserId, ...(scope.runId ? { sourceRunId: scope.runId } : {}) },
      configurable: { agentId, task: prompt, conversationId, credentialRef: KICKTODO_CONVENE_CREDENTIAL_REF },
    });
  } catch {
    // Fail-SOFT: the contract is validated even if the live run can't be scheduled.
    return { content: JSON.stringify({ ...baseRecord, status: 'validated', note: 'Handoff contract validated, but the live specialist run could not be scheduled just now.' }) };
  }
  return {
    content: JSON.stringify({
      ...baseRecord,
      status: 'convened',
      note: `The ${specialist} is reviewing now (read-only — it proposes, it cannot change your plan); if it has advice it will post into this conversation shortly. Tell the participant you've asked it, but don't invent its answer.`,
    }),
  };
}

/** The turn scope a chat tool call carries (mirrors the creator tool's ToolScope). */
export interface ReplanToolScope {
  tenantId: string;
  actingUserId?: string | undefined;
  agentProfileId?: string | undefined;
  conversationId?: string | undefined;
  runId?: string | undefined;
  /** Present on the conversation transport — see `host/turnRunDispatch.ts`. */
  onRunDispatched?: TurnRunDispatchSink | undefined;
}

/** A compact, model-facing summary of the participant's REAL state for the replan
 *  composer's task (the tool reads under the acting user; the composer ALSO holds
 *  the two read tools for deeper reads). Fail-soft — a read miss yields the intent
 *  alone rather than blocking the replan. */
async function composeReplanTask(tenantId: string, actingUserId: string, enrollmentId: string, intent: string): Promise<string> {
  const lines: string[] = [`The participant wants: "${intent}".`];
  try {
    const progress = await progressFor(tenantId, enrollmentId);
    if (progress) {
      lines.push(
        `Enrollment ${enrollmentId}: ${progress.state}, day ${progress.currentDay} of ${progress.durationDays}, `
        + `${progress.completedActivities}/${progress.totalRequiredActivities} activities done.`,
      );
    }
    const today = await todayFor(tenantId, actingUserId);
    const mine = today.enrollments.find((e) => e.enrollmentId === enrollmentId);
    if (mine) {
      const pending = mine.actions.filter((a) => a.card && !a.card.completed);
      lines.push(
        pending.length === 0
          ? "Nothing is pending for this enrollment today."
          : `Pending today (${pending.length}): ` + pending.map((a) => `${a.card!.id} — ${a.card!.title}`).join('; ') + '.',
      );
    }
  } catch { /* fail-soft — the composer still has its own read tools + the intent */ }
  lines.push('Propose a closed-world plan revision (schedule / substitution / recovery lanes only) that answers this intent, or an empty revision if it cannot be honestly expressed in those lanes.');
  return lines.join('\n');
}

/**
 * ADR 0459 §3.1 / P1 — ACTION: ignite the participant-replan workflow for the
 * participant's OWN enrollment. Participant-authority via the SHARED
 * `hasKicktodoEnrollmentAuthority` predicate (the enrollment routes use the same
 * one — route and tool cannot drift); fails typed without it. Composes the
 * composer's task from the participant's stated intent + a real-state summary,
 * dispatches an ORDINARY run (the approval gate + core.fail branch apply), and
 * persists the inline `workflow_run` turn. `deps` is closure-bound at
 * registration; exposed as the first argument for direct testing.
 */
export async function runReplanTool(deps: StartRunDeps, input: Record<string, unknown>, scope: ReplanToolScope): Promise<{ content: string; isError?: boolean }> {
  if (!scope.actingUserId) {
    return { content: JSON.stringify({ error: 'acting_user_required' }), isError: true };
  }
  const enrollmentId = typeof input.enrollmentId === 'string' ? input.enrollmentId.trim() : '';
  const intent = typeof input.intent === 'string' ? input.intent.trim() : '';
  if (!enrollmentId) {
    return { content: JSON.stringify({ error: 'validation_error', message: 'Pass the `enrollmentId` to replan.' }), isError: true };
  }
  if (!intent) {
    return { content: JSON.stringify({ error: 'validation_error', message: 'Pass your `intent` — what you want to change about the plan.' }), isError: true };
  }
  // Participant authority — a foreign/absent enrollment is a uniform not_found (the
  // route posture). A scheduled/system turn (no acting user) already failed above.
  if (!(await hasKicktodoEnrollmentAuthority(scope.tenantId, enrollmentId, scope.actingUserId))) {
    return { content: JSON.stringify({ error: 'not_found', message: 'Enrollment not found.' }), isError: true };
  }
  const task = await composeReplanTask(scope.tenantId, scope.actingUserId, enrollmentId, intent);
  const runId = await startWorkflowRun(deps, {
    tenantId: scope.tenantId,
    workflowId: KICKTODO_REPLAN_WORKFLOW_ID,
    inputs: {
      enrollmentId,
      ownerSubject: scope.actingUserId,
      participantIntent: task,
      ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
    },
    metadata: {
      actingUserId: scope.actingUserId,
      ...(scope.conversationId ? { chatSessionId: scope.conversationId } : {}),
      kicktodoReplan: { enrollmentId },
    },
  });
  if (!runId) {
    return { content: JSON.stringify({ error: 'dispatch_failed', message: 'The replan workflow could not start.' }), isError: true };
  }
  await surfaceDispatchedRun(scope, deps.storage, { runId, agentId: KICKBOT_TURN_AGENT_ID, workflowId: KICKTODO_REPLAN_WORKFLOW_ID, workflowName: 'Plan revision' }, 'kicktodo-replan-run');
  log.info('kicktodo_replan_dispatched', { tenantId: scope.tenantId, enrollmentId, runId });
  return {
    content: JSON.stringify({
      runId,
      enrollmentId,
      note: "Proposing changes now — the approval card appears in this chat (or in your Reviews rail if the chat view hasn't caught up). Nothing changes to your plan until you approve it. Tell the participant you've proposed changes; don't invent the specifics.",
    }),
  };
}

/**
 * ADR 0442 Guide wave (Wave 2) — KickBot's ONE bounded WRITE tool: log the
 * participant's OWN check-in for today's action (optionally with a reflective
 * note or a measured value). It composes the SINGLE governed write path
 * `submitCheckIn` — never a second `checkIns.put` — which owner-checks
 * (enrollment.ownerSubject === actingSubject), enforces the activity's DECLARED
 * evidence policy, and is idempotent (a re-log wins the recorded evidence). So
 * the tool's predicate EQUALS the `POST /kicktodo/check-ins` route's (acting user
 * + the same owner-check); a foreign/absent card is a uniform `not_found`.
 *
 * Doctrine (ADR 0442): KickBot proposes; the USER decides. This tool is in
 * `SENSITIVE_APPROVAL_TOOLS`, so in `safe` mode (KickBot's default) it is deferred
 * for the one-click `interrupt.approval` card — nothing is written until the user
 * approves. It REQUIRES an EXACT `cardId` (never a fuzzy description): KickBot must
 * read `today` first, name the action to the user, and pass the real id — the
 * read-before-write discipline that guards against completing the WRONG card
 * (there is no un-check). Echoes the card's human title back so the confirmation
 * is legible. Fails typed without an acting human principal.
 */
export async function runLogCheckinTool(input: Record<string, unknown>, scope: ReplanToolScope): Promise<{ content: string; isError?: boolean }> {
  if (!scope.actingUserId) {
    return { content: JSON.stringify({ error: 'acting_user_required' }), isError: true };
  }
  const cardId = typeof input.cardId === 'string' ? input.cardId.trim() : '';
  if (!cardId) {
    return { content: JSON.stringify({ error: 'validation_error', message: 'Pass the EXACT `cardId` from the Today view — read `today` first and pick the action; never guess.' }), isError: true };
  }
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : undefined;
  const measuredValue = typeof input.measuredValue === 'number' && Number.isFinite(input.measuredValue) ? input.measuredValue : undefined;
  try {
    const ci = await submitCheckIn(scope.tenantId, scope.actingUserId, cardId, {
      ...(note !== undefined ? { note } : {}),
      ...(measuredValue !== undefined ? { measuredValue } : {}),
    });
    const card = await getCard(cardId).catch(() => null);
    log.info('kicktodo_log_checkin', { tenantId: scope.tenantId, cardId });
    return {
      content: JSON.stringify({
        recorded: true,
        cardId,
        ...(card?.title ? { cardTitle: card.title } : {}),
        ...(ci.note !== undefined ? { note: ci.note } : {}),
        ...(ci.measuredValue !== undefined ? { measuredValue: ci.measuredValue } : {}),
        guidance: `Marked "${card?.title ?? cardId}" done (the user approved on the card). Confirm it to them warmly; don't invent extra progress.`,
      }),
    };
  } catch (err) {
    // Map the domain errors to the SAME typed shapes the /check-ins route uses.
    if (err instanceof EvidenceRequiredError) {
      return { content: JSON.stringify({ error: 'validation_error', message: err.message }), isError: true };
    }
    if (err instanceof CheckInDeniedError) {
      if (err.reason === 'superseded') {
        return { content: JSON.stringify({ error: 'conflict', message: 'That action was superseded by a plan change — read `today` again for the current card.' }), isError: true };
      }
      // not-owner / occurrence-not-found → uniform not_found (the route posture; no existence leak).
      return { content: JSON.stringify({ error: 'not_found', message: 'That action was not found on your Today view.' }), isError: true };
    }
    throw err; // unexpected — the tool loop surfaces it as tool_failed
  }
}

export function registerKicktodoAgentTools(deps: StartRunDeps): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_TODAY_TOOL_ID,
      description:
        "The user's KickTodo Today view: active challenge enrollments and today's due actions with completion + check-in state. "
        + 'Use it to ground coaching, explanations, and recovery suggestions in what is ACTUALLY due. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope) {
      if (!scope.actingUserId) return { content: JSON.stringify({ enrollments: [] }) };
      // actingUserId IS the caller's stable subject (`user:<hash>` — the same
      // value callerSubject(req) yields and enroll stamps as ownerSubject).
      const today = await todayFor(scope.tenantId, scope.actingUserId);
      return { content: JSON.stringify(today) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_PROGRESS_TOOL_ID,
      description:
        "Progress for one of the user's KickTodo enrollments (completed/required activities, current day, goal state). "
        + 'Use before proposing plan changes or celebrating milestones. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { enrollmentId: { type: 'string', description: 'The enrollment to report on.' } },
        required: ['enrollmentId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return { content: JSON.stringify({ progress: null }) };
      const enrollmentId = typeof input.enrollmentId === 'string' ? input.enrollmentId : '';
      // Owner check: the tool only reports the acting user's own enrollments.
      const mine = await listEnrollmentsFor(scope.tenantId, scope.actingUserId);
      if (!mine.some((e) => e.id === enrollmentId)) return { content: JSON.stringify({ progress: null }) };
      return { content: JSON.stringify({ progress: await progressFor(scope.tenantId, enrollmentId) }) };
    },
  });

  // ADR 0443 R5 — the participant's OWN journal: every check-in carrying a note or
  // measured value, newest first. Grounds reflective coaching ("last Tuesday you
  // wrote you were exhausted — how's your energy today?") in what they actually
  // recorded. Self-scoped by the acting user; fails EMPTY without a human principal
  // (a system turn never enumerates a participant's notes). Read-only.
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_JOURNAL_TOOL_ID,
      description:
        "The user's KickTodo journal: their own check-in notes and measured values across all enrollments, newest first. "
        + 'Use to ground reflective, specific coaching in what they actually wrote — never invent an entry. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max entries to return (default 50, newest first).' } },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return { content: JSON.stringify({ journal: [] }) };
      const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(Math.floor(input.limit), 200) : 50;
      const journal = await journalFor(scope.tenantId, scope.actingUserId, limit);
      return { content: JSON.stringify({ journal }) };
    },
  });

  // ADR 0443 R3 — the participant's cross-challenge Plan: upcoming + recent dated
  // actions across their active enrollments, so KickBot can look AHEAD ("you've got
  // a long run scheduled Thursday — want to plan around it?") and spot recent
  // misses, not just today. Self-scoped; fails EMPTY without a human principal.
  // Read-only, bounded (planFor hard-caps a 31-day span).
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_PLAN_TOOL_ID,
      description:
        "The user's upcoming and recent KickTodo actions across their active enrollments (a bounded date window, default "
        + 'the last 3 and next 14 days). Use to look ahead, prep for what is coming, or surface a recent miss to recover. '
        + 'Optional `from`/`to` are local dates (YYYY-MM-DD); the span is capped at 31 days. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Window start, local date YYYY-MM-DD (optional).' },
          to: { type: 'string', description: 'Window end, local date YYYY-MM-DD (optional).' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return { content: JSON.stringify({ plan: [] }) };
      const w = defaultPlanWindow();
      const from = typeof input.from === 'string' && input.from ? input.from : w.from;
      const to = typeof input.to === 'string' && input.to ? input.to : w.to;
      const plan = await planFor(scope.tenantId, scope.actingUserId, from, to);
      return { content: JSON.stringify({ plan }) };
    },
  });

  // ADR 0442 P5 — KickBot CONVENES a bounded specialist handoff skill through the
  // SHARED `agentDispatch` seam (the same DETERMINISTIC dispatch a2aServer +
  // workforceEval use — "as any named agent invokes a handoff"). A chat feature
  // tool is secret-less (no provider), so this runs the deterministic dispatch:
  // it validates the handoff task/return CONTRACT and confines the specialist to
  // its own read-only allowlist, then returns the DISPATCH RECORD — never a
  // schema stub surfaced as advice (David's-law honesty). LIVE advisory reasoning
  // rides the workflow/agentRunnerNode path (a real deferral — ADR 0442 P5
  // correction). Pack-allowlisted onto KickBot only (never the ADR 0315 default
  // baseline); fails empty without a human principal.
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_CONVENE_TOOL_ID,
      description:
        "Convene a bounded KickTodo specialist to advise on the participant's plan: plan-builder (personalize a plan), "
        + 'safety-reviewer (flag overload/contraindications), progress-verifier (check claimed progress), or '
        + 'accountability-steward (a supportive nudge). The specialist PROPOSES only — it reads the plan and reasons; '
        + 'it can NEVER write domain state (enrolling, plan revisions, check-ins ride the governed surfaces). Returns '
        + "the dispatch outcome + the specialist's confined tool surface.",
      inputSchema: {
        type: 'object',
        properties: {
          specialist: { type: 'string', enum: Object.keys(CONVENABLE_SPECIALISTS), description: 'Which specialist to convene.' },
          goal: { type: 'string', minLength: 1, description: 'What the specialist should advise on.' },
          context: { type: 'string', description: "Optional grounding (e.g. the participant's current Today/Progress)." },
        },
        required: ['specialist', 'goal'],
        additionalProperties: false,
      },
    },
    run: conveneSpecialist,
  });

  // ADR 0459 §3.1 / P1 — KickBot's ONE bounded ACTION tool: turn a participant's
  // stated intent into a CLOSED-WORLD plan revision (the three ADR 0429 lanes),
  // proposed on an inline approval card in the participant's OWN conversation, and
  // applied through the governed surface ONLY on approval. It NEVER writes domain
  // state directly — it dispatches the `openwop-app.kicktodo.replan` workflow whose
  // gate + core.fail branch decide. Participant-scoped via the SAME predicate the
  // enrollment routes use; fails typed without an acting user or on a foreign
  // enrollment. Pack-allowlisted onto KickBot ONLY (never the ADR 0315 baseline).
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_REPLAN_TOOL_ID,
      description:
        "Propose changes to the participant's OWN challenge plan from what they asked for — reschedule to a daypart, swap "
        + 'today\'s action for a publisher-declared alternative, or collapse a missed window into recovery (those lanes only; '
        + 'never new activities). This proposes a plan revision the participant approves on an inline card in this chat; NOTHING '
        + 'changes until they approve. Pass the `enrollmentId` and their `intent` in their own words. Returns the started `runId`.',
      inputSchema: {
        type: 'object',
        properties: {
          enrollmentId: { type: 'string', description: "The participant's enrollment to replan (their own)." },
          intent: { type: 'string', minLength: 1, description: 'What the participant wants to change, in their words (e.g. "move my rest days to weekends").' },
        },
        required: ['enrollmentId', 'intent'],
        additionalProperties: false,
      },
    },
    run: (input, scope) => runReplanTool(deps, input, scope),
  });

  // ADR 0442 Guide wave (Wave 2) — KickBot's ONE bounded WRITE: log the
  // participant's OWN check-in for today's action. Composes the governed
  // `submitCheckIn` (owner-check + evidence policy + idempotent). Gated by the
  // `interrupt.approval` card (this id is in SENSITIVE_APPROVAL_TOOLS), so in
  // `safe` mode nothing writes until the user approves — "you propose; the user
  // decides". Pack-allowlisted onto KickBot ONLY (never the ADR 0315 baseline).
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_LOG_CHECKIN_TOOL_ID,
      description:
        "Log the participant's OWN check-in for one of TODAY's actions — mark it done, optionally with their reflective `note` "
        + 'or a `measuredValue` (e.g. minutes, reps). Read `today` FIRST and pass the EXACT `cardId` of the action they mean; '
        + 'never guess a card. The user approves on an inline card before anything is recorded, and a check-in can\'t be undone — '
        + 'so name the action to them and only log what they confirm. Records completion + any evidence the action requires.',
      inputSchema: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: "The EXACT cardId of today's action to complete (from the `today` read — never a description)." },
          note: { type: 'string', description: 'The participant\'s reflection on this action, in their words (optional; becomes their journal entry).' },
          measuredValue: { type: 'number', description: 'A measured value if the action requires one (e.g. minutes run, pages read).' },
        },
        required: ['cardId'],
        additionalProperties: false,
      },
    },
    run: runLogCheckinTool,
  });
}
