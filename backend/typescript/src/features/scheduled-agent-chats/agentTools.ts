/**
 * ADR 0309 — `openwop:tasks.schedule-followup`: the governed way for a chat
 * agent to KEEP "I'll have it ready before your meeting".
 *
 * ADR 0308 P0 forbids promising future work because nothing runs after a turn
 * ends. This tool grounds such a promise in a real mechanism: a ONE-SHOT
 * scheduler job (cron sentinel `'once'` + `firstFireAtMs` — ADR 0309 D1) that
 * fires this feature's existing turn-workflow, whose agent-runner posts the
 * reply back into the SAME conversation as a live assistant turn (ADR 0125).
 *
 * Governance:
 *  - acting-user-required — the human's request IS the gate (roster autonomy /
 *    approvals guard UNPROMPTED heartbeat work, not user-asked follow-ups;
 *    cost is bounded at fire time by the tenant autonomous-run budget);
 *  - the delivery destination is UNFORGEABLE — the tool takes no conversation
 *    input; `scope.conversationId` (threaded from `run.metadata.chatSessionId`
 *    by the tool loop) is the only target, fail-closed when absent;
 *  - deterministic jobId (content-hashed) so a provider retry re-puts the same
 *    row instead of double-scheduling (the GD-0308-1 pattern);
 *  - bounded: future-only, the scheduler's existing 30-day horizon, a per-user
 *    pending cap, task length capped.
 */
import { createHash } from 'node:crypto';
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { listJobsForSubject, registerJob, MAX_FUTURE_HORIZON_MS, ONE_SHOT_CRON } from '../../host/schedulingService.js';
import { parseCron, computeNextFire } from '../../host/cronSchedule.js';
import { SCHEDULED_CHAT_TURN_WORKFLOW_ID } from './scheduledChatTurnWorkflow.js';

export const SCHEDULE_FOLLOWUP_TOOL_ID = 'openwop:tasks.schedule-followup';
export const SCHEDULE_RECURRING_TOOL_ID = 'openwop:tasks.schedule-recurring';

/** Pending (un-fired) follow-ups one user may hold — accumulation guard. */
export const MAX_PENDING_FOLLOWUPS_PER_USER = 10;
/** Active (never self-retiring) recurring chats one user may hold — a recurring job
 *  fires forever until paused/cancelled, so this bounds standing autonomous load. A
 *  tighter cap than the one-shot's because each entry is perpetual, not spent-on-fire. */
export const MAX_ACTIVE_RECURRING_PER_USER = 5;
const TASK_MAX = 2_000;
/** A follow-up must be at least this far out — "in one minute" is a normal turn. */
const MIN_LEAD_MS = 60_000;
/** The tightest recurring cadence allowed — hourly, matching the product's offered
 *  cadences (hourly/daily/weekdays/weekly). A finer cron (every minute / every 30m) is
 *  an autonomous-cost runaway, so it is refused (the "safe subset" — the recurring
 *  analogue of the one-shot's MIN_LEAD_MS). */
const MIN_RECURRING_INTERVAL_MS = 3_600_000;

/** True when `tz` is a resolvable IANA timezone. A cron with no zone fires against
 *  server-local (UTC) wall-clock, so a bad/absent zone would fire the user's "9am" at
 *  the wrong moment silently — the recurring analogue of the GC-R3 one-shot fix. */
function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function toolError(error: string, message: string): { content: string; isError: true } {
  return { content: JSON.stringify({ error, message }), isError: true };
}

export function registerScheduledFollowupTool(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: SCHEDULE_FOLLOWUP_TOOL_ID,
      description:
        'Schedule yourself to follow up LATER in THIS conversation — you will run again at the given time with the '
        + 'task you write here, and your reply will post into this same conversation. Use it when the user asks for '
        + 'something by/at a future time ("before my 3pm", "tomorrow morning"). Only after this succeeds may you '
        + 'promise the follow-up. Write `task` as instructions to your future self, including everything needed '
        + '(you will not see this turn\'s context again).',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Instructions to your future self — self-contained, specific, with any data you must carry forward.' },
          runAtISO: { type: 'string', description: 'When to run, ISO-8601 with timezone (e.g. 2026-07-08T14:45:00Z). Must be in the future, within 30 days. Pick a time BEFORE any deadline the user named.' },
        },
        required: ['task', 'runAtISO'],
      },
    },
    async run(input, scope) {
      const actingUserId = scope.actingUserId;
      if (!actingUserId) {
        return toolError('acting_user_required', 'Follow-ups can only be scheduled from a human-initiated turn.');
      }
      const conversationId = scope.conversationId;
      if (!conversationId) {
        return toolError('conversation_required', 'Follow-ups can only be scheduled from inside a conversation — the reply has nowhere to land.');
      }
      const agentId = scope.agentProfileId;
      if (!agentId) {
        return toolError('agent_required', 'Follow-ups need a specific agent to run as — this turn has none.');
      }
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      if (!task) return toolError('validation_error', '`task` is required.');
      if (task.length > TASK_MAX) return toolError('validation_error', `\`task\` must be at most ${TASK_MAX} characters.`);
      const runAtISO = typeof input.runAtISO === 'string' ? input.runAtISO.trim() : '';
      // Grade-pass fix GC-R3: a timezone-NAIVE string parses as SERVER-local
      // time (UTC on Cloud Run) — the user's "3pm" would fire at the wrong
      // moment silently. Require an explicit offset so the model states one.
      if (runAtISO && !/(Z|[+-]\d{2}:?\d{2})$/.test(runAtISO)) {
        return toolError('validation_error', '`runAtISO` must carry an explicit timezone (a trailing Z or ±hh:mm offset) — ask the user for their timezone if you are unsure.');
      }
      const runAtMs = Date.parse(runAtISO);
      if (!Number.isFinite(runAtMs)) return toolError('validation_error', '`runAtISO` must be a valid ISO-8601 timestamp.');
      const now = Date.now();
      if (runAtMs < now + MIN_LEAD_MS) return toolError('validation_error', '`runAtISO` must be at least a minute in the future — do near-term work in this turn instead.');
      if (runAtMs - now > MAX_FUTURE_HORIZON_MS) {
        return toolError('horizon_exceeded', 'Follow-ups can be scheduled at most 30 days out — tell the user and offer a nearer check-in.');
      }

      // Accumulation guard: pending (un-fired) follow-ups for THIS user.
      const mine = await listJobsForSubject(scope.tenantId, { kind: 'user', id: actingUserId });
      const pending = mine.filter((j) => j.metadata?.['tool'] === SCHEDULE_FOLLOWUP_TOOL_ID && typeof j.nextFireAt === 'number');
      if (pending.length >= MAX_PENDING_FOLLOWUPS_PER_USER) {
        return toolError('too_many_followups', `The user already has ${pending.length} pending follow-ups — ask them to clear some (their Schedules list) before adding more.`);
      }

      // Deterministic id: an identical retried call re-puts the same row (never
      // double-schedules); a genuinely different follow-up hashes to a new job.
      const key = createHash('sha256')
        .update([scope.runId ?? conversationId, SCHEDULE_FOLLOWUP_TOOL_ID, task, runAtISO].join('\u0000'))
        .digest('hex').slice(0, 32);
      const result = await registerJob({
        jobId: `followup:${key}`,
        tenantId: scope.tenantId,
        cronExpr: ONE_SHOT_CRON, // ADR 0309 D1 — explicit sentinel + firstFireAtMs = one-shot
        firstFireAtMs: runAtMs,
        workflowId: SCHEDULED_CHAT_TURN_WORKFLOW_ID,
        ownerSubject: { kind: 'user', id: actingUserId }, // the human's Schedules tab lists + cancels it
        agentId,
        metadata: {
          tool: SCHEDULE_FOLLOWUP_TOOL_ID,
          actingUserId, // flows onto the fired run — same tool scope there (ADR 0308)
          ...(scope.runId ? { sourceRunId: scope.runId } : {}),
        },
        configurable: {
          agentId,
          task,
          conversationId,
          credentialRef: 'managed:openwop-free', // scheduled-chat parity — no BYOK at fire
        },
      }, now);
      if (!result.ok) {
        return toolError(result.error.code, result.error.message);
      }
      return {
        content: JSON.stringify({
          scheduled: true,
          jobId: result.job.jobId,
          runAt: new Date(runAtMs).toISOString(),
          deliversTo: 'this conversation',
          note: 'Follow-up scheduled. You may now promise it — state the exact time back to the user. They can cancel it from their Schedules list.',
        }),
      };
    },
  });
}

/**
 * ADR 0125 / chat-first-port A3 — `openwop:tasks.schedule-recurring`: the governed
 * way for a chat agent to keep "I'll check in with you every morning".
 *
 * The recurring sibling of `schedule-followup`: same governance shape (acting-user
 * gated, unforgeable `scope.conversationId` binding, deterministic content-hashed
 * jobId, jobs owned by the acting user + listed in the shared Schedules panel), but a
 * real cron cadence instead of a one-shot fire. It creates the SAME kind of scheduled
 * chat the org-admin surface does (turn-workflow bound to a conversation) — no parallel
 * scheduler — driven from chat so scheduled chats are creatable where the user asks for
 * them, not only from the admin page (the A3 "chat-first" honesty gap).
 *
 * Governance additions over the one-shot:
 *  - the cadence is validated against a SAFE SUBSET — a parseable 5-field cron whose
 *    fires are no closer than an hour apart (a finer cron is an autonomous-cost runaway);
 *  - an IANA `timezone` is REQUIRED so "9am" fires at the user's wall-clock, not UTC;
 *  - a per-user ACTIVE cap (recurring jobs never self-retire, unlike spent one-shots).
 */
export function registerScheduledRecurringTool(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: SCHEDULE_RECURRING_TOOL_ID,
      description:
        'Schedule yourself to run on a RECURRING cadence in THIS conversation — you will run again on every '
        + 'occurrence with the task you write here, and each reply posts into this same conversation. Use it when the '
        + 'user asks for something repeating ("every morning", "each Monday", "hourly"). Only after this succeeds may '
        + 'you promise the recurring check-in. Write `task` as instructions to your future self, including everything '
        + 'needed (you will not see this turn\'s context again).',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Instructions to your future self — self-contained, specific, with any data you must carry forward. This runs on EVERY occurrence.' },
          cronExpr: { type: 'string', description: 'A standard 5-field cron cadence (minute hour day-of-month month day-of-week), e.g. "0 9 * * 1-5" for 9am on weekdays. Must fire at most once an hour.' },
          timezone: { type: 'string', description: "The user's IANA timezone (e.g. America/New_York) — the cadence fires at their local wall-clock. Ask the user if you are unsure." },
        },
        required: ['task', 'cronExpr', 'timezone'],
      },
    },
    async run(input, scope) {
      const actingUserId = scope.actingUserId;
      if (!actingUserId) {
        return toolError('acting_user_required', 'Recurring chats can only be scheduled from a human-initiated turn.');
      }
      const conversationId = scope.conversationId;
      if (!conversationId) {
        return toolError('conversation_required', 'Recurring chats can only be scheduled from inside a conversation — the reply has nowhere to land.');
      }
      const agentId = scope.agentProfileId;
      if (!agentId) {
        return toolError('agent_required', 'Recurring chats need a specific agent to run as — this turn has none.');
      }
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      if (!task) return toolError('validation_error', '`task` is required.');
      if (task.length > TASK_MAX) return toolError('validation_error', `\`task\` must be at most ${TASK_MAX} characters.`);
      const cronExpr = typeof input.cronExpr === 'string' ? input.cronExpr.trim() : '';
      if (!cronExpr) return toolError('validation_error', '`cronExpr` is required.');
      if (parseCron(cronExpr) === null) {
        return toolError('validation_error', '`cronExpr` must be a valid 5-field cron expression (minute hour day-of-month month day-of-week).');
      }
      const timezone = typeof input.timezone === 'string' ? input.timezone.trim() : '';
      if (!timezone) {
        return toolError('validation_error', '`timezone` is required — pass the user\'s IANA timezone (e.g. America/New_York) so the cadence fires at their local wall-clock time.');
      }
      if (!isValidTimeZone(timezone)) {
        return toolError('validation_error', '`timezone` must be a valid IANA timezone (e.g. America/New_York).');
      }
      // Safe subset: two consecutive fires must be at least an hour apart. This both
      // refuses a runaway cadence (`* * * * *`, `*/30 …`) and proves the cron actually
      // fires within the horizon (a null first-fire = a dead schedule the daemon skips).
      const now = Date.now();
      const firstFire = computeNextFire(cronExpr, now, timezone);
      if (firstFire === null) {
        return toolError('validation_error', '`cronExpr` has no fire time within the 30-day horizon — pick a real recurring cadence.');
      }
      // Walk the fire sequence across a >24h probe window and reject if ANY
      // adjacent pair is closer than the floor. Checking only the first pair is
      // evadable by an intra-window cluster cron (e.g. `0,30 9 * * *` invoked
      // between the clustered fires — Phase-5 review MEDIUM-1).
      let prevFire = firstFire;
      for (let i = 0; i < 25; i++) {
        const nextFire = computeNextFire(cronExpr, prevFire, timezone);
        if (nextFire === null) break;
        if (nextFire - prevFire < MIN_RECURRING_INTERVAL_MS) {
          return toolError('cadence_too_frequent', 'Recurring chats can fire at most once an hour — use a coarser schedule (e.g. hourly, daily, weekly).');
        }
        prevFire = nextFire;
      }

      // Accumulation guard: ACTIVE recurring chats for THIS user (a recurring job never
      // self-retires, so an enabled job counts toward the standing load).
      const mine = await listJobsForSubject(scope.tenantId, { kind: 'user', id: actingUserId });
      const active = mine.filter((j) => j.metadata?.['tool'] === SCHEDULE_RECURRING_TOOL_ID && j.enabled !== false);
      if (active.length >= MAX_ACTIVE_RECURRING_PER_USER) {
        return toolError('too_many_recurring', `The user already has ${active.length} recurring chats — ask them to pause or remove some (their Schedules list) before adding more.`);
      }

      // Deterministic id: an identical retried call re-puts the same row (never
      // double-schedules); a genuinely different cadence/task hashes to a new job.
      const key = createHash('sha256')
        .update([scope.runId ?? conversationId, SCHEDULE_RECURRING_TOOL_ID, task, cronExpr, timezone].join('\u0000'))
        .digest('hex').slice(0, 32);
      const result = await registerJob({
        jobId: `recurring:${key}`,
        tenantId: scope.tenantId,
        cronExpr, // a recurring cadence — the daemon recomputes nextFireAt after each fire
        timezone,
        workflowId: SCHEDULED_CHAT_TURN_WORKFLOW_ID,
        ownerSubject: { kind: 'user', id: actingUserId }, // the human's Schedules tab lists + pauses/cancels it
        agentId,
        metadata: {
          tool: SCHEDULE_RECURRING_TOOL_ID,
          actingUserId, // flows onto each fired run — same tool scope there (ADR 0308)
          ...(scope.runId ? { sourceRunId: scope.runId } : {}),
        },
        configurable: {
          agentId,
          task,
          conversationId,
          credentialRef: 'managed:openwop-free', // scheduled-chat parity — no BYOK at fire
        },
      }, now);
      if (!result.ok) {
        return toolError(result.error.code, result.error.message);
      }
      return {
        content: JSON.stringify({
          scheduled: true,
          jobId: result.job.jobId,
          cronExpr,
          timezone,
          nextRunAt: result.job.nextFireAt ? new Date(result.job.nextFireAt).toISOString() : null,
          deliversTo: 'this conversation',
          note: 'Recurring chat scheduled. You may now confirm it — state the cadence back to the user. They can pause or cancel it from their Schedules list.',
        }),
      };
    },
  });
}
