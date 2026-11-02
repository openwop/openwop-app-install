/**
 * ADR 1001 D1/D3 — the agent node's side of a clarification: dispatch, and when
 * the turn stops on an accepted `openwop:ask-user` call, checkpoint it and
 * suspend through the REAL executor (`ctx.suspend`), then continue from the
 * checkpoint with the person's answer.
 *
 * The re-entry algorithm (`ctx.suspend` THROWS on its first call; a resume
 * re-runs the node from the top with one seeded resolution):
 *   1. read this node's latest checkpoint;
 *   2. present → suspend on ITS key (seeded, or served from the node's own
 *      resolved row via `durable`), seed the effect-ordinal cursor (D3.3), and
 *      continue from the checkpoint — no tool or model call before the ask is
 *      repeated;
 *   3. absent → a full dispatch.
 * Every ask writes its checkpoint BEFORE suspending, so a crash between the two
 * re-raises the same key on re-entry.
 *
 * Kept out of `agentRunnerNode.ts` so the node only chooses whether the run
 * opted in (the frozen stamp) and supplies its dispatch.
 */
import type { NodeContext, NodeOutcome } from '../executor/types.js';
import type { AgentDispatchRequest, AgentDispatchResult } from './agentDispatch.js';
import { hostExtStorage } from './hostExtPersistence.js';
import { stripSecretsFromPersisted } from '../byok/ephemeralRunSecrets.js';
import { peekNodeActivityOrdinal, seedNodeActivity } from './effectIdentity.js';
import {
  AGENT_CLARIFICATION_PROFILE,
  clarificationAnswerMessage,
  clarificationCorrelationId,
  clarificationDataOf,
  clarificationKey,
  clarificationResumeSchema,
  clarificationTimeoutMs,
  parseClarificationResume,
  type LiftedQuestion,
} from './clarificationLift.js';
import { latestClarificationCheckpoint, saveClarificationCheckpoint } from './clarificationCheckpoint.js';

/** ADR 1001 D5 — the run-start stamp (`run.metadata[CLARIFICATION_STAMP_KEY]`),
 *  frozen once so a fork of a run born before the toggle flipped replays the
 *  prompt it was recorded with. */
export const CLARIFICATION_STAMP_KEY = 'openwop-app.agentClarification';
export interface ClarificationStamp { v: 1; cap: number }

export function readClarificationStamp(metadata: Record<string, unknown> | undefined): ClarificationStamp | null {
  const s = metadata?.[CLARIFICATION_STAMP_KEY] as { v?: unknown; cap?: unknown } | undefined;
  if (!s || s.v !== 1 || typeof s.cap !== 'number' || !Number.isInteger(s.cap) || s.cap < 1) return null;
  return { v: 1, cap: s.cap };
}

/** What the model is told when its paused turn is too large to checkpoint. */
export const CHECKPOINT_TOO_LARGE_NOTICE =
  'You cannot pause to ask a question at this point: this step holds too much context to save. '
  + 'Do not ask again. Finish with what you have and say clearly what is missing.';

type Dispatch = (extra: Pick<AgentDispatchRequest, 'clarification' | 'resumeFrom'>) => Promise<AgentDispatchResult>;

export type ClarifyingDispatchOutcome =
  | { kind: 'result'; result: AgentDispatchResult }
  | { kind: 'failure'; outcome: NodeOutcome };

function suspendPayload(a: {
  round: number; digest: string; questions: readonly LiftedQuestion[]; contextType?: string;
  askedBy?: string; approverRefs?: string[]; untrusted: boolean; causationId: string;
}): Record<string, unknown> {
  return {
    kind: 'clarification',
    // The events an ask causes carry its minted id as `causationId`; the
    // executor stamps it on `node.suspended` / `interrupt.requested` and strips
    // this host key.
    __causationId: a.causationId,
    key: clarificationKey(a.round, a.digest),
    durable: true,
    profile: AGENT_CLARIFICATION_PROFILE,
    ...clarificationDataOf(a.questions, a.contextType),
    ...(a.askedBy ? { askedBy: a.askedBy } : {}),
    round: a.round,
    timeoutMs: clarificationTimeoutMs(),
    resumeSchema: clarificationResumeSchema(a.questions),
    ...(a.approverRefs && a.approverRefs.length > 0 ? { approverRefs: a.approverRefs } : {}),
    // D4 — refuses capability-token lanes even with no acting person to name.
    ...(a.untrusted ? { untrustedContext: true } : {}),
  };
}

export async function runClarifyingDispatch(args: {
  ctx: NodeContext;
  stamp: ClarificationStamp | null;
  dispatch: Dispatch;
  /** Emit a dispatch's agent.* events onto the run (once per dispatch). */
  emitEvents: (r: AgentDispatchResult) => Promise<void>;
  /** Checked after every dispatch, BEFORE its result is acted on: a node
   *  failure here (a replay miss, ADR 1002 D4) wins over a clarification. */
  afterDispatch?: () => NodeOutcome | undefined;
}): Promise<ClarifyingDispatchOutcome> {
  const { ctx, stamp, dispatch, emitEvents } = args;
  const halted = (): ClarifyingDispatchOutcome | undefined => {
    const outcome = args.afterDispatch?.();
    return outcome ? { kind: 'failure', outcome } : undefined;
  };

  if (!stamp) {
    const r = await dispatch({});
    await emitEvents(r);
    const stop = halted();
    return stop ?? { kind: 'result', result: r };
  }

  const storage = hostExtStorage();
  const scope = { tenantId: ctx.tenantId, runId: ctx.runId, nodeId: ctx.nodeId };
  let roundsUsed = 0;
  let resumeFrom: AgentDispatchRequest['resumeFrom'];
  let mayAsk = true;
  // D4 — once a round was restricted to the acting person (its question was
  // written from untrusted context), every later round is too: that context is
  // still in the transcript the agent continues from.
  let restricted = false;

  const cp = await latestClarificationCheckpoint(storage, scope);
  if (cp) {
    if (!ctx.suspend) return { kind: 'failure', outcome: { status: 'failure', retryable: false, error: { code: 'clarification_unavailable', message: 'This run cannot pause for an answer.' } } };
    const answer = await ctx.suspend(suspendPayload({
      round: cp.round, digest: cp.questionsDigest, questions: cp.questions,
      ...(cp.contextType ? { contextType: cp.contextType } : {}),
      ...(cp.askedBy ? { askedBy: cp.askedBy } : {}),
      ...(cp.approverRefs ? { approverRefs: cp.approverRefs } : {}),
      untrusted: cp.untrusted === true,
      causationId: clarificationCorrelationId(ctx.runId, ctx.nodeId, cp.round),
    }));
    resumeFrom = { transcriptTail: cp.transcriptTail, answerMessage: clarificationAnswerMessage(parseClarificationResume(answer, cp.questions), cp.round, stamp.cap) };
    roundsUsed = cp.round;
    restricted = cp.untrusted === true || (cp.approverRefs?.length ?? 0) > 0;
    // D3.3 — continue at the ordinal the body paused at (after the executor's
    // `beginNodeActivity` rewind, before the continuation's first model round).
    seedNodeActivity(ctx.runId, ctx.nodeId, cp.ordinalCursor);
  }

  for (;;) {
    const r = await dispatch({
      ...(mayAsk ? { clarification: { roundsUsed, cap: stamp.cap, runId: ctx.runId, nodeId: ctx.nodeId, ...(restricted ? { untrustedContext: true } : {}) } } : {}),
      ...(resumeFrom ? { resumeFrom } : {}),
    });
    await emitEvents(r);
    const stop = halted();
    if (stop) return stop;
    if (r.capBreach) {
      // capabilities.md §Engine-enforced limits — emit AND fail the node.
      await ctx.emit('cap.breached', { kind: r.capBreach.kind, limit: r.capBreach.limit, observed: r.capBreach.observed },
        { causationId: clarificationCorrelationId(ctx.runId, ctx.nodeId, r.capBreach.observed) });
      return { kind: 'failure', outcome: { status: 'failure', retryable: false, error: r.error ?? { code: 'cap_breached', message: 'clarificationRounds cap breached' } } };
    }
    const pc = r.clarification;
    if (!pc) return { kind: 'result', result: r };
    if (!ctx.suspend) return { kind: 'failure', outcome: { status: 'failure', retryable: false, error: { code: 'clarification_unavailable', message: 'This run cannot pause for an answer.' } } };

    // Scrubbed of resolved run secrets once, HERE, and that same tail is both
    // stored and continued from: tool output can echo a key, and the source and
    // a replay fork must build identical requests from it.
    const transcriptTail = stripSecretsFromPersisted(pc.messages.slice(1));
    // D4 — a turn that read borrowed or untrusted context wrote its question
    // from that context: only the run's acting person may answer it.
    restricted = restricted || pc.untrusted;
    const approverRefs = restricted && ctx.actingUserId ? [ctx.actingUserId] : undefined;
    const saved = await saveClarificationCheckpoint(storage, {
      v: 1, ...scope, round: pc.round, transcriptTail, questions: pc.questions, questionsDigest: pc.digest,
      ordinalCursor: peekNodeActivityOrdinal(ctx.runId, ctx.nodeId),
      ...(pc.data.contextType ? { contextType: pc.data.contextType } : {}),
      ...(approverRefs ? { approverRefs } : {}),
      ...(restricted ? { untrusted: true } : {}),
      ...(r.persona ? { askedBy: r.persona } : {}),
      createdAt: new Date().toISOString(),
    });
    if (!saved.ok) {
      resumeFrom = { transcriptTail, answerMessage: CHECKPOINT_TOO_LARGE_NOTICE };
      mayAsk = false;
      continue;
    }
    const answer = await ctx.suspend(suspendPayload({
      round: pc.round, digest: pc.digest, questions: pc.questions,
      ...(pc.data.contextType ? { contextType: pc.data.contextType } : {}),
      ...(r.persona ? { askedBy: r.persona } : {}),
      ...(approverRefs ? { approverRefs } : {}),
      untrusted: restricted,
      causationId: pc.correlationId,
    }));
    resumeFrom = { transcriptTail, answerMessage: clarificationAnswerMessage(parseClarificationResume(answer, pc.questions), pc.round, stamp.cap) };
    roundsUsed = pc.round;
  }
}
