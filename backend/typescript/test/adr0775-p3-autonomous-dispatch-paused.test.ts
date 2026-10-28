/**
 * ADR 0775 P3 (`ARWF-7`) — a paused roster agent (`enabled:false`) does not run
 * autonomously. Before P3 only the heartbeat, "check now" and the kanban trigger
 * honoured the switch; a schedule, a scheduled chat, a follow-up and an approved
 * proposal all kept dispatching a paused agent.
 *
 * The schedule witnesses call the daemon's real `fireJob` with the app's real
 * deps and a workflow id that does not resolve: a fire the gate lets through ends
 * `workflow-unresolved`, so the skip reason says which side of the gate it landed on.
 *
 * Red when (wave 60 probes, tracker TST-BRC-1): the daemon's `agent-paused` skip is
 * dropped; the verdict stops reading `enabled`; `jobAgentRef` reorders its sources;
 * the verdict stops reverse-scanning a registry agent id to its roster member; or the
 * approval claim stops refusing a paused member before its lock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { fireJob } from '../src/host/scheduleDaemon.js';
import { getJob, registerJob } from '../src/host/schedulingService.js';
import { createRosterEntry, updateRosterEntry } from '../src/host/rosterService.js';
import { createApproval, listApprovals } from '../src/host/approvalService.js';
import { autonomousDispatchVerdict, jobAgentRef } from '../src/host/autonomousDispatchPolicy.js';
import type { StartRunDeps } from '../src/host/runStarter.js';

let server: http.Server;
let BASE: string;
let deps: StartRunDeps;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'p3', serviceVersion: '0.0.1', enableConsoleTracer: false });
  deps = { storage: app.locals.storage, hostSuite: app.locals.hostSuite };
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
}, 120_000);
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function member(tenantId: string, agentId: string): Promise<string> {
  const e = await createRosterEntry({ tenantId, persona: `P3 ${n++}`, agentRef: { agentId, channel: 'stable' }, workflows: [] });
  return e.rosterId;
}

async function fire(job: Parameters<typeof registerJob>[0]): Promise<unknown> {
  const reg = await registerJob(job);
  if (!reg.ok) throw new Error('fixture: registerJob refused');
  const stored = await getJob(reg.job.jobId);
  return fireJob(deps, stored!, { trigger: 'schedule', applyBudget: false });
}

describe('scheduled fires skip a paused roster agent', () => {
  const T = 'tenant-p3-sched';
  const AGENT = 'core.openwop.agents.brief-writer';

  it('names the agent by rosterId, agentId or the run inputs, in that order', () => {
    expect(jobAgentRef({ rosterId: 'host:a', agentId: 'b', configurable: { agentId: 'c' } })).toBe('host:a');
    expect(jobAgentRef({ agentId: 'b', configurable: { agentId: 'c' } })).toBe('b');
    expect(jobAgentRef({ configurable: { agentId: 'c' } })).toBe('c');
    expect(jobAgentRef({ configurable: { agentId: '' } })).toBeUndefined();
    expect(jobAgentRef({})).toBeUndefined();
  });

  it('a job bound to a paused member is skipped as agent-paused; resumed, it reaches dispatch', async () => {
    const rosterId = await member(T, AGENT);
    await updateRosterEntry(T, rosterId, { enabled: false });
    const jobId = `j-p3-roster-${n++}`;
    expect(await fire({ jobId, tenantId: T, cronExpr: '* * * * *', rosterId, workflowId: 'wf.p3' })).toEqual({ skipped: 'agent-paused' });
    expect((await getJob(jobId))?.lastSkipReason).toBe('agent-paused');

    await updateRosterEntry(T, rosterId, { enabled: true });
    const after = await fireJob(deps, (await getJob(jobId))!, { trigger: 'schedule', applyBudget: false });
    // Past the gate: the dispatch itself is what ends it (the fixture workflow does not resolve).
    expect(after).toEqual({ skipped: 'workflow-unresolved' });
  });

  it('a scheduled chat or follow-up (the agent named only in the run inputs) is skipped too', async () => {
    const rosterId = await member(T, AGENT);
    await updateRosterEntry(T, rosterId, { enabled: false });
    // Follow-ups carry the profile id, which for a roster agent IS the rosterId.
    expect(await fire({ jobId: `followup:p3-${n++}`, tenantId: T, cronExpr: '* * * * *', workflowId: 'wf.p3', configurable: { agentId: rosterId } }))
      .toEqual({ skipped: 'agent-paused' });
  });

  it('a registry agent id resolves to its roster member', async () => {
    const T2 = 'tenant-p3-reverse';
    const rosterId = await member(T2, AGENT);
    await updateRosterEntry(T2, rosterId, { enabled: false });
    expect(await autonomousDispatchVerdict(T2, AGENT)).toEqual({ allowed: false, reason: 'agent-paused', rosterId });
    expect(await fire({ jobId: `j-p3-agent-${n++}`, tenantId: T2, cronExpr: '* * * * *', workflowId: 'wf.p3', agentId: AGENT }))
      .toEqual({ skipped: 'agent-paused' });
  });

  it('a job that runs no roster agent is not gated', async () => {
    expect(await autonomousDispatchVerdict(T, 'core.openwop.agents.not-on-any-roster')).toEqual({ allowed: true });
    expect(await fire({ jobId: `j-p3-none-${n++}`, tenantId: T, cronExpr: '* * * * *', workflowId: 'wf.p3' })).toEqual({ skipped: 'workflow-unresolved' });
  });
});

describe('approving a paused agent\'s proposal', () => {
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  it('is refused while the agent is paused, and the approval stays pending', async () => {
    const created = await call('POST', '/host/openwop-app/roster', { persona: `P3 proposer ${n++}`, agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
    expect(created.status).toBe(201);
    const rosterId = created.body.rosterId as string;
    const tenantId = created.body.tenantId as string;
    const approval = await createApproval({ tenantId, rosterId, persona: 'P3 proposer', workflowId: 'wf.p3-missing', proposal: 'do it' });

    expect((await call('PATCH', `/host/openwop-app/roster/${encodeURIComponent(rosterId)}`, { enabled: false })).status).toBe(200);
    const refused = await call('POST', `/host/openwop-app/approvals/${encodeURIComponent(approval.approvalId)}/claim`, {});
    expect(refused.status).toBe(409);
    expect((refused.body.details as { reason?: string } | undefined)?.reason).toBe('agent_paused');
    // The refusal took no lock: the approval is still pending.
    expect((await listApprovals(tenantId, 'pending')).map((a) => a.approvalId)).toContain(approval.approvalId);

    // Resumed, the claim passes the gate (and stops at the next check: this
    // fixture's workflow does not resolve). Still pending proves the refusal
    // took no lock.
    expect((await call('PATCH', `/host/openwop-app/roster/${encodeURIComponent(rosterId)}`, { enabled: true })).status).toBe(200);
    const resumed = await call('POST', `/host/openwop-app/approvals/${encodeURIComponent(approval.approvalId)}/claim`, {});
    expect((resumed.body.details as { reason?: string } | undefined)?.reason).not.toBe('agent_paused');
    expect(resumed.status).toBe(422);
  });
});
