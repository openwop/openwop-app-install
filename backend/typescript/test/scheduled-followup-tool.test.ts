/**
 * ADR 0309 — `openwop:tasks.schedule-followup`: the one-shot follow-through
 * tool + the D1 one-shot scheduling primitive it rides.
 *
 * Guards (witnessing sabotage, /grade-tests w25 g2):
 *  - D1: the `'once'` sentinel is OPT-IN (GC-R2 — a typo'd cron + firstFireAtMs never
 *    becomes a one-shot; dropping the `=== ONE_SHOT_CRON` test reds) and a parseable
 *    cadence's own next fire wins over firstFireAtMs (preferring it reds). The spend of a
 *    fired one-shot is `adr0787-schedule-cadence.test.ts`'s ("a spent one-shot …").
 *  - D2: fail-closed without acting user / conversation / agent (authz); GC-R3 naive
 *    timestamps refused; lead-time + horizon bounds; the job binds THIS conversation,
 *    is owned by the acting user, and dispatches on the HOST-OWNED managed credential
 *    (a BYOK ref reds); a retry re-puts the SAME deterministic job (a salted id reds);
 *    the per-user pending cap.
 *  - ADR 0701 boot order: after a real boot the turn-workflow is registered — the chain
 *    packs load before the feature seeds (moved here from scheduled-agent-chats.test.ts,
 *    whose old case pinned the silent-swallow hazard instead of the boot order).
 *  - D3: the P0 scaffold forbids pointing the user at an unconfirmed place (the
 *    three-paths sentence is `kanban-add-todo-tool.test.ts`'s).
 * Registration through `feature.ts` is witnessed by every D2 case (an unregistered tool
 * schedules nothing).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { SCHEDULE_FOLLOWUP_TOOL_ID, MAX_PENDING_FOLLOWUPS_PER_USER } from '../src/features/scheduled-agent-chats/agentTools.js';
import { SCHEDULED_CHAT_TURN_WORKFLOW_ID } from '../src/features/scheduled-agent-chats/scheduledChatTurnWorkflow.js';
import { getJob, registerJob, listJobsForSubject, MAX_FUTURE_HORIZON_DAYS } from '../src/host/schedulingService.js';
import { getChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';
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

describe('ADR 0701 — boot registers the scheduled-chat turn-workflow', () => {
  it('chain packs load BEFORE the feature seeds, so the turn-workflow resolves after boot', () => {
    // `registerChainBackedWorkflow` swallows a missing chain into a logged error, so a boot
    // reorder (seed before `loadWorkflowChainPacks`) would leave every scheduled chat
    // firing at nothing. This is the boot, not a unit: the definition must be there.
    const def = getChainBackedWorkflow(SCHEDULED_CHAT_TURN_WORKFLOW_ID);
    expect(def, 'the feature-seeded turn-workflow is registered after createApp').toBeTruthy();
    expect(def!.nodes.map((n) => n.typeId)).toEqual(['local.openwop-app.agent-runner']);
  });
});

describe('ADR 0309 D1 — one-shot scheduling primitive', () => {
  it('GC-R2: a TYPO\u2019d cron + firstFireAtMs never becomes a surprise one-shot \u2014 the sentinel is opt-in', async () => {
    // CORRECTED (ADR 0787 D6): an ENABLED typo is now REFUSED at write
    // (`invalid_cron`) instead of stored inert behind a 201 — the GC-R2 property
    // (it never fires as a one-shot) holds more strongly. A DISABLED typo (a
    // portability import) is still stored inert, and judged when enabled.
    const r = await registerJob({ jobId: 'once-test-3', tenantId: TENANT, cronExpr: 'every 5 minutes', firstFireAtMs: Date.now() + 3_600_000, workflowId: 'wf-x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_cron');
    const off = await registerJob({ jobId: 'once-test-3b', tenantId: TENANT, cronExpr: 'every 5 minutes', firstFireAtMs: Date.now() + 3_600_000, workflowId: 'wf-x', enabled: false });
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.job.nextFireAt).toBeUndefined();
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
      // ADR 0787 D6 — the horizon is the ONE advertised constant (366 days, was 30).
      [new Date(Date.now() + (MAX_FUTURE_HORIZON_DAYS + 1) * 24 * 3_600_000).toISOString(), 'horizon_exceeded'],
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
    // Identical retry re-puts the SAME job (no double-schedule): same id, and the user's
    // follow-up count does not move (counted before/after — other cases also schedule for u-fut).
    const followupsOfUser = async () => (await listJobsForSubject(TENANT, { kind: 'user', id: 'u-fut' }))
      .filter((j) => j.metadata?.['tool'] === SCHEDULE_FOLLOWUP_TOOL_ID).length;
    const before = await followupsOfUser();
    const retry = await runTool(input, FULL_SCOPE);
    expect((JSON.parse(retry.content) as { jobId: string }).jobId).toBe(payload.jobId);
    expect(await followupsOfUser()).toBe(before);
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
    // The three-paths sentence ('SCHEDULE it with a scheduling tool') is pinned by
    // kanban-add-todo-tool.test.ts; this file owns the no-unconfirmed-place rule.
    expect(TOOL_GROUNDED_COMMITMENTS).toContain('Never tell the user to check a place');
  });
});
