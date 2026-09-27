/**
 * chat-first-port A3 — `openwop:tasks.schedule-recurring`: the recurring sibling of
 * `schedule-followup`. Creates a real cron-cadence scheduled chat bound (unforgeably)
 * to THIS conversation, driven from chat.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { SCHEDULE_RECURRING_TOOL_ID, MAX_ACTIVE_RECURRING_PER_USER } from '../src/features/scheduled-agent-chats/agentTools.js';
import { SCHEDULED_CHAT_TURN_WORKFLOW_ID } from '../src/features/scheduled-agent-chats/scheduledChatTurnWorkflow.js';
import { getJob, listJobsForSubject } from '../src/host/schedulingService.js';
import { DEFAULT_ON_AGENT_TOOL_IDS } from '../src/host/agentToolAllowlistService.js';

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
  it('registers as a builtin and is in the ADR 0315 default-on baseline', () => {
    expect(builtinAgentToolIds()).toContain(SCHEDULE_RECURRING_TOOL_ID);
    expect(DEFAULT_ON_AGENT_TOOL_IDS).toContain(SCHEDULE_RECURRING_TOOL_ID);
  });

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
    for (const [input, code] of [
      [{ task: 'T', cronExpr: 'every 5 minutes', timezone: 'America/New_York' }, 'validation_error'], // unparseable cron
      [{ task: 'T', cronExpr: '0 9 * * *' }, 'validation_error'],                                     // no timezone
      [{ task: 'T', cronExpr: '0 9 * * *', timezone: 'Mars/Phobos' }, 'validation_error'],            // bad timezone
      [{ task: 'T', cronExpr: '* * * * *', timezone: 'UTC' }, 'cadence_too_frequent'],                // every minute
      [{ task: 'T', cronExpr: '*/30 * * * *', timezone: 'UTC' }, 'cadence_too_frequent'],             // every 30m
      [{ task: 'T', cronExpr: '0,30 9 * * *', timezone: 'UTC' }, 'cadence_too_frequent'],              // intra-window cluster (Phase-5 review MEDIUM-1)
    ] as const) {
      const out = await runTool(input, FULL_SCOPE);
      expect(out.isError, JSON.stringify(input)).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: code });
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
    const mine = await listJobsForSubject(TENANT, { kind: 'user', id: 'u-rec' });
    expect(mine.filter((j) => j.jobId === payload.jobId)).toHaveLength(1);
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
