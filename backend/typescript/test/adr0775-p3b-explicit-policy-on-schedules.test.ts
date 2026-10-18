/**
 * ADR 0775 P3b (user decision 2026-10-15, "explicit rules only") — a schedule
 * honours the two rules a person wrote down for a named workflow on the agent's
 * profile: `permissions.never` refuses the slot, `hitl` turns it into ONE pending
 * approval, and approving that approval fires the job through the daemon's own
 * recipe. The autonomy level, allowlist and connection readiness stay
 * heartbeat-only, so a plain schedule of an agent at `review` still runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { fireJob } from '../src/host/scheduleDaemon.js';
import { getJob, registerJob } from '../src/host/schedulingService.js';
import { updateRosterEntry } from '../src/host/rosterService.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';
import { listApprovals } from '../src/host/approvalService.js';
import type { StartRunDeps } from '../src/host/runStarter.js';

let server: http.Server;
let BASE: string;
let deps: StartRunDeps;
let tenantId: string;
let n = 0;
const WF = `wf.p3b-gate-${Date.now()}`;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'p3b', serviceVersion: '0.0.1', enableConsoleTracer: false });
  deps = { storage: app.locals.storage, hostSuite: app.locals.hostSuite } as unknown as StartRunDeps;
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  // A gate node keeps the run non-terminal; all we need is a run that starts.
  const created = await call('POST', '/host/openwop-app/workflows', {
    workflowId: WF, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'hold' } }], edges: [],
  });
  expect(created.status).toBe(201);
}, 120_000);
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function member(): Promise<string> {
  const r = await call('POST', '/host/openwop-app/roster', { persona: `P3b ${n++}`, agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  expect(r.status).toBe(201);
  tenantId = r.body.tenantId as string;
  return r.body.rosterId as string;
}

async function job(rosterId: string): Promise<string> {
  const jobId = `j-p3b-${n++}`;
  const reg = await registerJob({ jobId, tenantId, cronExpr: '* * * * *', rosterId, workflowId: WF });
  if (!reg.ok) throw new Error('fixture: registerJob refused');
  return jobId;
}

const fire = async (jobId: string): Promise<unknown> => fireJob(deps, (await getJob(jobId))!, { trigger: 'schedule', applyBudget: false });
const pendingFor = async (jobId: string) => (await listApprovals(tenantId, 'pending')).filter((a) => a.scheduleJobId === jobId);

describe('explicit per-workflow rules on a schedule', () => {
  it('a workflow on the never list is skipped as policy-denied', async () => {
    const rosterId = await member();
    await upsertAgentProfile(tenantId, rosterId, { roleKey: 'p3b', autonomy: { specLevel: 'recommend' }, permissions: { read: [], write: [], never: [WF] } });
    const jobId = await job(rosterId);
    expect(await fire(jobId)).toEqual({ skipped: 'policy-denied' });
    expect((await getJob(jobId))?.lastSkipReason).toBe('policy-denied');
    expect(await pendingFor(jobId)).toHaveLength(0);
  });

  it('a hitl workflow files ONE pending approval across slots, and approving it runs the job', async () => {
    const rosterId = await member();
    await upsertAgentProfile(tenantId, rosterId, { roleKey: 'p3b', autonomy: { specLevel: 'recommend' }, hitl: [WF] });
    const jobId = await job(rosterId);
    expect(await fire(jobId)).toEqual({ skipped: 'awaiting-approval' });
    expect(await fire(jobId)).toEqual({ skipped: 'awaiting-approval' });
    const pending = await pendingFor(jobId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ rosterId, workflowId: WF });

    const claimed = await call('POST', `/host/openwop-app/approvals/${encodeURIComponent(pending[0]!.approvalId)}/claim`, {});
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(typeof claimed.body.runId).toBe('string');
    expect((await getJob(jobId))?.lastRunId).toBe(claimed.body.runId);
    expect(await pendingFor(jobId)).toHaveLength(0);
  });

  it('a held approval whose agent was paused since is refused and stays pending', async () => {
    const rosterId = await member();
    await upsertAgentProfile(tenantId, rosterId, { roleKey: 'p3b', autonomy: { specLevel: 'recommend' }, hitl: [WF] });
    const jobId = await job(rosterId);
    await fire(jobId);
    const [approval] = await pendingFor(jobId);
    await updateRosterEntry(tenantId, rosterId, { enabled: false });
    const refused = await call('POST', `/host/openwop-app/approvals/${encodeURIComponent(approval!.approvalId)}/claim`, {});
    expect(refused.status).toBe(409);
    expect((refused.body.details as { reason?: string }).reason).toBe('agent_paused');
    expect(await pendingFor(jobId)).toHaveLength(1);
  });

  it('the autonomy level does NOT hold a schedule: an agent at review with no listed rule still runs', async () => {
    const rosterId = await member();
    await updateRosterEntry(tenantId, rosterId, { autonomyLevel: 'review' });
    await upsertAgentProfile(tenantId, rosterId, { roleKey: 'p3b', autonomy: { specLevel: 'recommend' }, hitl: ['wf.some-other'] });
    const out = await fire(await job(rosterId));
    expect(out).toHaveProperty('runId');
  });
});
