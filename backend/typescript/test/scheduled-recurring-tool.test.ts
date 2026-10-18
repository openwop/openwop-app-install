/**
 * chat-first-port A3 — `openwop:tasks.schedule-recurring`: the recurring sibling of
 * `schedule-followup`. Creates a real cron-cadence scheduled chat bound (unforgeably)
 * to THIS conversation, driven from chat.
 *
 * Guards (witnessing sabotage, /grade-tests w25 g2): fail-closed without acting user /
 * conversation / agent (authz); the cadence safe subset — an unparseable cron, an absent
 * or unknown IANA zone (each asserted by its OWN message: the zone checks are backed by
 * `computeNextFire`/`registerJob`, which refuse with a different message), a finer-than-
 * hourly cadence (floor → 1 min reds) with hourly exactly allowed (`<=` reds), and the
 * Phase-5 MEDIUM-1 intra-window cluster checked at a FIXED 09:15Z so the multi-pair walk
 * is the only thing that can catch it (walking one pair reds); the job keeps the zone,
 * binds THIS conversation, is owned by the acting user, dispatches on the HOST-OWNED
 * managed credential (a BYOK ref reds); a retry re-puts the SAME job; the per-user cap.
 * Registration (feature.ts) is witnessed by every case; the ADR 0315 default-on baseline
 * is pinned exactly by agent-toolallowlist-override.test.ts.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { SCHEDULE_RECURRING_TOOL_ID, MAX_ACTIVE_RECURRING_PER_USER } from '../src/features/scheduled-agent-chats/agentTools.js';
import { SCHEDULED_CHAT_TURN_WORKFLOW_ID } from '../src/features/scheduled-agent-chats/scheduledChatTurnWorkflow.js';
import { getJob, listJobsForSubject } from '../src/host/schedulingService.js';

const TENANT = 'default';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function runTool(input: Record<string, unknown>, scope: { actingUserId?: string; agentProfileId?: string; conversationId?: string; runId?: string }): Promise<{ content: string; isError?: boolean }> {
  const provider = createAgentToolProvider({ tenantId: TENANT, runId: 'run-a3', ...scope });
  return provider.executeTool({ name: SCHEDULE_RECURRING_TOOL_ID, input });
}
const FULL_SCOPE = { actingUserId: 'u-rec', agentProfileId: 'host:iris', conversationId: 'conv-rec' };
const DAILY_9AM = { task: 'Post the overnight summary.', cronExpr: '0 9 * * *', timezone: 'America/New_York' };

describe('chat-first-port A3 — the schedule-recurring tool', () => {
  it('fails closed without acting user / conversation / agent', async () => {
    for (const [scope, code] of [
      [{ agentProfileId: 'a', conversationId: 'c' }, 'acting_user_required'],
      [{ actingUserId: 'u', agentProfileId: 'a' }, 'conversation_required'],
      [{ actingUserId: 'u', conversationId: 'c' }, 'agent_required'],
    ] as const) {
      const out = await runTool(DAILY_9AM, scope);
      expect(out.isError, code).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: code });
    }
  });

  it('validates the cadence: bad cron, absent/invalid timezone, and finer-than-hourly all refuse', async () => {
    const TOO_FREQUENT = 'at most once an hour';
    for (const [input, code, message] of [
      [{ task: 'T', cronExpr: 'every 5 minutes', timezone: 'America/New_York' }, 'validation_error', '5-field cron'], // unparseable cron
      [{ task: 'T', cronExpr: '0 9 * * *' }, 'validation_error', '`timezone` is required'],                       // no timezone
      [{ task: 'T', cronExpr: '0 9 * * *', timezone: 'Mars/Phobos' }, 'validation_error', 'valid IANA timezone'],  // bad timezone
      [{ task: 'T', cronExpr: '* * * * *', timezone: 'UTC' }, 'cadence_too_frequent', TOO_FREQUENT],               // every minute
      [{ task: 'T', cronExpr: '*/30 * * * *', timezone: 'UTC' }, 'cadence_too_frequent', TOO_FREQUENT],            // every 30m
    ] as const) {
      const out = await runTool(input, FULL_SCOPE);
      expect(out.isError, JSON.stringify(input)).toBe(true);
      expect(JSON.parse(out.content), JSON.stringify(input)).toMatchObject({ error: code, message: expect.stringContaining(message) });
    }
    // Phase-5 review MEDIUM-1 — an intra-window cluster (`0,30 9 * * *`) invoked BETWEEN
    // its clustered fires: the first pair (09:30 → next day 09:00) is wide, so only walking
    // the sequence finds the 30-minute pair. Pinned to 09:15Z (only Date is faked, so the
    // app's timers keep running) — at any other time the first pair alone catches it.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.UTC(2030, 0, 2, 9, 15));
      const out = await runTool({ task: 'T', cronExpr: '0,30 9 * * *', timezone: 'UTC' }, FULL_SCOPE);
      expect(out.isError, out.content).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: 'cadence_too_frequent', message: expect.stringContaining(TOO_FREQUENT) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts an hourly cadence (exactly at the min interval)', async () => {
    const out = await runTool({ task: 'hourly check', cronExpr: '0 * * * *', timezone: 'UTC' }, { ...FULL_SCOPE, actingUserId: 'u-hourly', runId: 'run-hourly' });
    expect(out.isError, out.content).toBeFalsy();
  });

  it('schedules a recurring job carrying the task into THIS conversation, idempotent on retry', async () => {
    const first = await runTool(DAILY_9AM, FULL_SCOPE);
    expect(first.isError, first.content).toBeFalsy();
    const payload = JSON.parse(first.content) as { scheduled: boolean; jobId: string; nextRunAt: string | null };
    expect(payload.scheduled).toBe(true);
    expect(payload.nextRunAt).toBeTruthy(); // a real, computable next fire
    const job = await getJob(payload.jobId);
    expect(job?.workflowId).toBe(SCHEDULED_CHAT_TURN_WORKFLOW_ID);
    expect(job?.cronExpr).toBe('0 9 * * *');
    expect(job?.timezone).toBe('America/New_York');
    expect(job?.nextFireAt).toBeGreaterThan(Date.now()); // a live recurring schedule, not spent
    expect(job?.ownerSubject).toEqual({ kind: 'user', id: 'u-rec' });
    expect(job?.configurable).toMatchObject({ agentId: 'host:iris', task: DAILY_9AM.task, conversationId: 'conv-rec', credentialRef: 'managed:openwop-free' });
    expect(job?.metadata).toMatchObject({ tool: SCHEDULE_RECURRING_TOOL_ID, actingUserId: 'u-rec' });
    // Identical retry re-puts the SAME job (no double-schedule).
    const retry = await runTool(DAILY_9AM, FULL_SCOPE);
    expect((JSON.parse(retry.content) as { jobId: string }).jobId).toBe(payload.jobId);
    // Only this case schedules for u-rec (every validation row refuses), so exactly one job.
    const mine = await listJobsForSubject(TENANT, { kind: 'user', id: 'u-rec' });
    expect(mine.filter((j) => j.metadata?.['tool'] === SCHEDULE_RECURRING_TOOL_ID).map((j) => j.jobId)).toEqual([payload.jobId]);
  });

  it('caps active recurring chats per user', async () => {
    const scope = { actingUserId: 'u-reccap', agentProfileId: 'host:iris', conversationId: 'conv-reccap' };
    for (let i = 0; i < MAX_ACTIVE_RECURRING_PER_USER; i += 1) {
      const out = await runTool({ task: `T${i}`, cronExpr: `${i} 9 * * *`, timezone: 'UTC' }, { ...scope, runId: `run-${i}` });
      expect(out.isError, out.content).toBeFalsy();
    }
    const over = await runTool({ task: 'one too many', cronExpr: '30 9 * * *', timezone: 'UTC' }, { ...scope, runId: 'run-over' });
    expect(over.isError).toBe(true);
    expect(JSON.parse(over.content)).toMatchObject({ error: 'too_many_recurring' });
  });
});
