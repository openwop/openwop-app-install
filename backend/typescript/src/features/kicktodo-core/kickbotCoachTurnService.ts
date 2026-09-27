/**
 * ADR 0689 — KickBot speaks first.
 *
 * Two things live here, and the second is why the first exists:
 *
 *  1. `kickbotConversationFor(tenant, participant)` — the participant's OWN
 *     1:1 with KickBot, opened-or-resumed by the SAME dmKey the chat route
 *     uses (`POST /chat/conversations/open {type:'agent', subjectRef}` in
 *     `routes/chatSessions.ts`): `dmKeyOf(userRef(owner), agentRef(rosterId))`.
 *     This is the conversation the sidebar shows under the guide's name. It is
 *     NOT `ensureKickBot().conversationId` — that id is tenant-scoped
 *     (`subjectConversationId(tenant, agent)`), which in a shared participant
 *     workspace (ADR 0684) is ONE conversation for every member. A proactive
 *     turn that posted there would put one participant's day in front of
 *     everyone. So the guide speaks only into the DM.
 *
 *  2. `enqueueKickbotCoachTurn` — the gated, idempotent enqueue of ONE
 *     proactive turn: a fire-now one-shot job on the EXISTING convene turn-workflow
 *     (`openwop-app.kicktodo.convene-turn`, one host `agent-runner` node whose
 *     `configurable` carries agentId/task/credentialRef/conversationId). The
 *     proactive lane adds NO new in-tree workflow: the pin-site ratchet
 *     (`test/workflow-pin-site-ratchet.test.ts`) is shrink-only by design, and the
 *     convene workflow already IS this shape — only the agent and the task differ.
 *     Gates, in order, all honest skips rather than errors:
 *       - the enrollment exists and belongs to the participant (uniform
 *         `not-found`, no existence leak);
 *       - the enrollment is `active` — snooze pauses KickBot exactly as it
 *         pauses reminders (deck slide 14: never a guilt ping);
 *       - for a reminder occasion, something is still pending today;
 *       - the participant's app-level mute / quiet hours (ADR 0457) — the
 *         producer consults it, the emitter does not.
 *     Idempotence rides the scheduler's deterministic jobId (an identical
 *     enqueue re-puts the same row): one reminder turn per enrollment per
 *     LOCAL day, one award turn per award. A retry, a chain replay, or two
 *     callers on the same tick cannot make the guide say the same thing twice.
 *
 * What a proactive turn can do is what a chat turn can do — the run-lane
 * firewall gates the same allowlist, so the one write (`log-checkin`) still
 * raises an approval card. The task text is advisory and says so.
 */
import { createHash, randomUUID } from 'node:crypto';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { ensureConversationMeta, findByDmKey, dmKeyOf, userRef, agentRef } from '../../host/conversationStore.js';
import { registerJob, ONE_SHOT_CRON } from '../../host/schedulingService.js';
import { isNotificationMuted } from '../../host/notificationPolicy.js';
import { createLogger } from '../../observability/logger.js';
import { ensureKickBot } from './kickbotService.js';
import { getEnrollment } from './enrollmentService.js';
import { todayFor } from './todayService.js';
import { KICKTODO_CONVENE_TURN_WORKFLOW_ID, KICKTODO_CONVENE_CREDENTIAL_REF } from './conveneTurnWorkflow.js';

const log = createLogger('kicktodo.kickbotCoachTurn');

export type CoachTurnOccasion = 'reminder' | 'award';

export interface CoachTurnRequest {
  ownerSubject: string;
  enrollmentId: string;
  occasion: CoachTurnOccasion;
  /** The award kind, for an `award` occasion (also the idempotence key). */
  awardKind?: string;
}

export type CoachTurnSkipReason = 'not-found' | 'not-active' | 'nothing-pending' | 'muted' | 'schedule-unavailable';

export interface CoachTurnOutcome {
  queued: boolean;
  reason?: CoachTurnSkipReason;
  jobId?: string;
  conversationId?: string;
}

/** `YYYY-MM-DD` in the participant's timezone — the reminder idempotence key. */
export function localDayIn(timeZone: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * The participant's 1:1 with KickBot — open-or-resume by the chat route's own
 * dmKey so the sidebar and the proactive turn agree on ONE conversation.
 * Provisions KickBot for the tenant first (idempotent). A stale meta whose
 * session is gone is recreated, exactly as the route does.
 */
export async function kickbotConversationFor(tenantId: string, ownerSubject: string): Promise<string> {
  const bot = await ensureKickBot(tenantId);
  const subjectRef = agentRef(bot.rosterId);
  const dmKey = dmKeyOf(userRef(ownerSubject), subjectRef);
  const storage = hostExtStorage();
  const existing = await findByDmKey(tenantId, dmKey);
  if (existing) {
    const session = await storage.getChatSession(tenantId, existing.conversationId);
    if (session) return existing.conversationId;
  }
  const sessionId = randomUUID();
  const ts = new Date().toISOString();
  await storage.createChatSession({ sessionId, tenantId, title: bot.persona, createdAt: ts, updatedAt: ts, messageCount: 0 });
  const meta = await ensureConversationMeta(tenantId, sessionId, {
    type: 'agent',
    ownerUserId: ownerSubject,
    participants: [subjectRef],
    dmKey,
  });
  log.info('kickbot_dm_opened', { tenantId, conversationId: meta.conversationId });
  return meta.conversationId;
}

function taskFor(occasion: CoachTurnOccasion, persona: string, headline: string | undefined, awardKind: string | undefined): string {
  const law = 'Never guilt-trip, never list what they have not done, never log a check-in or change their plan on their behalf — you propose, they decide. Keep it under 80 words.';
  if (occasion === 'award') {
    return [
      `You are ${persona}, this participant's guide, and you are speaking first: they just earned the "${awardKind ?? 'award'}" award.`,
      'Read their progress with your tools, then celebrate the real, specific win in two or three warm sentences.',
      law,
    ].join(' ');
  }
  return [
    `You are ${persona}, this participant's guide, and you are speaking first at the time they chose for a nudge.`,
    headline ? `Today's pending action is "${headline}".` : 'Something is pending today.',
    'Read their Today and Progress with your tools, open with one warm line, and offer the single most useful next step or a lighter alternative if the day looks hard.',
    law,
  ].join(' ');
}

/** Enqueue one proactive KickBot turn for a participant (gated, idempotent, best-effort). */
export async function enqueueKickbotCoachTurn(tenantId: string, req: CoachTurnRequest): Promise<CoachTurnOutcome> {
  const e = await getEnrollment(tenantId, req.enrollmentId);
  if (!e || e.ownerSubject !== req.ownerSubject) return { queued: false, reason: 'not-found' };
  if (e.state !== 'active') return { queued: false, reason: 'not-active' };
  let headline: string | undefined;
  if (req.occasion === 'reminder') {
    const today = await todayFor(tenantId, req.ownerSubject);
    const mine = today.enrollments.find((en) => en.enrollmentId === req.enrollmentId);
    const pending = mine?.actions.find((a) => !a.checkIn);
    if (!pending) return { queued: false, reason: 'nothing-pending' };
    headline = pending.card?.title;
  }
  // ADR 0457 — the recipient's mute / quiet hours, consulted by the producer.
  if (await isNotificationMuted(tenantId, req.ownerSubject, { type: 'task.assigned', priority: 'normal' })) {
    return { queued: false, reason: 'muted' };
  }
  const bot = await ensureKickBot(tenantId);
  const conversationId = await kickbotConversationFor(tenantId, req.ownerSubject);
  const keySeed = req.occasion === 'award'
    ? `${req.enrollmentId}|award|${req.awardKind ?? ''}`
    : `${req.enrollmentId}|reminder|${localDayIn(e.timezone)}`;
  const key = createHash('sha256').update([tenantId, req.ownerSubject, keySeed].join('|')).digest('hex').slice(0, 32);
  const jobId = `kickbot-coach:${key}`;
  const task = taskFor(req.occasion, bot.persona, headline, req.awardKind);
  try {
    const res = await registerJob({
      jobId,
      tenantId,
      cronExpr: ONE_SHOT_CRON,
      firstFireAtMs: Date.now(), // fire on the next tick
      enabled: true,
      workflowId: KICKTODO_CONVENE_TURN_WORKFLOW_ID,
      // The participant owns the turn (their Schedules tab lists/cancels it);
      // attribution rides KickBot's roster id like the reminder job itself.
      ownerSubject: { kind: 'user', id: req.ownerSubject },
      rosterId: bot.rosterId,
      agentId: bot.rosterId,
      // `actingUserId` lets the guide's actingUserId-gated read tools (today,
      // progress, journal) authorize on the scheduled run (ADR 0324 scope law).
      metadata: { purpose: 'kickbot-coach-turn', occasion: req.occasion, enrollmentId: req.enrollmentId, actingUserId: req.ownerSubject },
      configurable: { agentId: bot.rosterId, task, conversationId, credentialRef: KICKTODO_CONVENE_CREDENTIAL_REF },
    });
    if (!res.ok) {
      log.warn('kickbot_coach_turn_job_failed', { jobId, error: res.error.message });
      return { queued: false, reason: 'schedule-unavailable' };
    }
  } catch (err) {
    log.warn('kickbot_coach_turn_enqueue_failed', { jobId, error: err instanceof Error ? err.message : String(err) });
    return { queued: false, reason: 'schedule-unavailable' };
  }
  log.info('kickbot_coach_turn_queued', { tenantId, occasion: req.occasion, jobId });
  return { queued: true, jobId, conversationId };
}
