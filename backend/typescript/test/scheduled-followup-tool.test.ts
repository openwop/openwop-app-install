/**
 * ADR 0309 — `openwop:tasks.schedule-followup`: the one-shot follow-through
 * tool + the D1 one-shot scheduling primitive it rides.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { SCHEDULE_FOLLOWUP_TOOL_ID, MAX_PENDING_FOLLOWUPS_PER_USER } from '../src/features/scheduled-agent-chats/agentTools.js';
import { SCHEDULED_CHAT_TURN_WORKFLOW_ID } from '../src/features/scheduled-agent-chats/scheduledChatTurnWorkflow.js';
import { getJob, registerJob, markJobFired, listJobsForSubject } from '../src/host/schedulingService.js';
import { TOOL_GROUNDED_COMMITMENTS } from '../src/host/chatContext.js';

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
  const provider = createAgentToolProvider({ tenantId: TENANT, runId: 'run-adr0309', ...scope });
  return provider.executeTool({ name: SCHEDULE_FOLLOWUP_TOOL_ID, input });
}
const FULL_SCOPE = { actingUserId: 'u-fut', agentProfileId: 'host:iris', conversationId: 'conv-fut' };
const inOneHour = (): string => new Date(Date.now() + 3_600_000).toISOString();

describe('ADR 0309 D1 — one-shot scheduling primitive', () => {
  it("cronExpr 'once' + firstFireAtMs fires exactly once, then the job is SPENT (row retained)", async () => {
    const at = Date.now() + 3_600_000;
    const r = await registerJob({ jobId: 'once-test-1', tenantId: TENANT, cronExpr: 'once', firstFireAtMs: at, workflowId: 'wf-x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.job.nextFireAt).toBe(at);
    await markJobFired('once-test-1', 1, 'run-1', at);
    const spent = await getJob('once-test-1');
    expect(spent?.nextFireAt).toBeUndefined(); // never fires again
    expect(spent?.lastRunAt).toBeTruthy();     // but the row survives for the Schedules tab
  });

  it('GC-R2: a TYPO\u2019d cron + firstFireAtMs stays INERT \u2014 the one-shot sentinel is opt-in (public route safety)', async () => {
    const r = await registerJob({ jobId: 'once-test-3', tenantId: TENANT, cronExpr: 'every 5 minutes', firstFireAtMs: Date.now() + 3_600_000, workflowId: 'wf-x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Pre-ADR-0309 behavior preserved: unparseable non-sentinel cadence never fires.
    expect(r.job.nextFireAt).toBeUndefined();
  });

  it('a recurring cron is unaffected by the fallback (computeNextFire still wins)', async () => {
    const r = await registerJob({ jobId: 'once-test-2', tenantId: TENANT, cronExpr: '*/5 * * * *', firstFireAtMs: Date.now() + 999_999_999, workflowId: 'wf-x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A parseable cadence computes its own next fire — the one-shot fallback never overrides it.
    expect(r.job.nextFireAt).toBeLessThan(Date.now() + 10 * 60_000);
  });
});

describe('ADR 0309 D2 — the schedule-followup tool', () => {
  it('registers as a builtin', () => {
    expect(builtinAgentToolIds()).toContain(SCHEDULE_FOLLOWUP_TOOL_ID);
  });

  it('fails closed without acting user / conversation / agent', async () => {
    for (const [scope, code] of [
      [{ agentProfileId: 'a', conversationId: 'c' }, 'acting_user_required'],
      [{ actingUserId: 'u', agentProfileId: 'a' }, 'conversation_required'],
      [{ actingUserId: 'u', conversationId: 'c' }, 'agent_required'],
    ] as const) {
      const out = await runTool({ task: 'T', runAtISO: inOneHour() }, scope);
      expect(out.isError, code).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: code });
    }
  });

  it('GC-R3: a timezone-NAIVE runAtISO is refused \u2014 server-local parsing would fire at the wrong moment', async () => {
    const naive = new Date(Date.now() + 3_600_000).toISOString().replace('Z', '');
    const out = await runTool({ task: 'T', runAtISO: naive }, FULL_SCOPE);
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content) as { error: string; message: string }).toMatchObject({ error: 'validation_error' });
    expect((JSON.parse(out.content) as { message: string }).message).toContain('timezone');
    // An explicit offset works.
    const offset = await runTool({ task: 'T', runAtISO: new Date(Date.now() + 3_600_000).toISOString().replace('Z', '+00:00') }, { ...FULL_SCOPE, runId: 'run-tz' });
    expect(offset.isError, offset.content).toBeFalsy();
  });

  it('validates the time: past, sub-minute, and beyond-horizon all refuse', async () => {
    for (const [runAtISO, code] of [
      [new Date(Date.now() - 1000).toISOString(), 'validation_error'],
      [new Date(Date.now() + 10_000).toISOString(), 'validation_error'],
      [new Date(Date.now() + 40 * 24 * 3_600_000).toISOString(), 'horizon_exceeded'],
      ['not-a-date', 'validation_error'],
    ] as const) {
      const out = await runTool({ task: 'T', runAtISO }, FULL_SCOPE);
      expect(out.isError, runAtISO).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: code });
    }
  });

  it('schedules a one-shot job carrying the frozen task into THIS conversation, idempotent on retry', async () => {
    const runAtISO = inOneHour();
    const input = { task: 'Pull the uptime report and summarize it for the 3pm meeting.', runAtISO };
    const first = await runTool(input, FULL_SCOPE);
    expect(first.isError, first.content).toBeFalsy();
    const payload = JSON.parse(first.content) as { scheduled: boolean; jobId: string };
    expect(payload.scheduled).toBe(true);
    const job = await getJob(payload.jobId);
    expect(job?.workflowId).toBe(SCHEDULED_CHAT_TURN_WORKFLOW_ID);
    expect(job?.cronExpr).toBe('once');
    expect(job?.nextFireAt).toBe(Date.parse(runAtISO));
    expect(job?.ownerSubject).toEqual({ kind: 'user', id: 'u-fut' });
    expect(job?.configurable).toMatchObject({ agentId: 'host:iris', conversationId: 'conv-fut', credentialRef: 'managed:openwop-free' });
    expect(job?.metadata).toMatchObject({ tool: SCHEDULE_FOLLOWUP_TOOL_ID, actingUserId: 'u-fut' });
    // Identical retry re-puts the SAME job (no double-schedule).
    const retry = await runTool(input, FULL_SCOPE);
    expect((JSON.parse(retry.content) as { jobId: string }).jobId).toBe(payload.jobId);
    const mine = await listJobsForSubject(TENANT, { kind: 'user', id: 'u-fut' });
    expect(mine.filter((j) => j.jobId === payload.jobId)).toHaveLength(1);
  });

  it('caps pending follow-ups per user', async () => {
    const scope = { actingUserId: 'u-cap', agentProfileId: 'host:iris', conversationId: 'conv-cap' };
    for (let i = 0; i < MAX_PENDING_FOLLOWUPS_PER_USER; i += 1) {
      const out = await runTool({ task: `T${i}`, runAtISO: inOneHour() }, { ...scope, runId: `run-${i}` });
      expect(out.isError, out.content).toBeFalsy();
    }
    const over = await runTool({ task: 'one too many', runAtISO: inOneHour() }, { ...scope, runId: 'run-over' });
    expect(over.isError).toBe(true);
    expect(JSON.parse(over.content)).toMatchObject({ error: 'too_many_followups' });
  });
});

describe('ADR 0309 D3 — the P0 carve-out', () => {
  it('the scaffold now permits promised work that a scheduling tool actually scheduled', () => {
    expect(TOOL_GROUNDED_COMMITMENTS).toContain('SCHEDULE it with a scheduling tool');
    expect(TOOL_GROUNDED_COMMITMENTS).toContain('Never tell the user to check a place');
  });
});
