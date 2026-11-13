/**
 * ADR 1108 — campaign-orchestration.run's channel-child gate honours the listed
 * operator's plan exemption, and still refuses a customer on the plan.
 *
 * Plan shape chosen so a CUSTOMER can reach the child gate: the free plan
 * includes `campaign-brief` and `campaign-orchestration` but not
 * `campaign-channels` (the five channel children's owning feature). Before
 * ADR 1108 the pre-check (`firstChildRefusal`) and the sub-workflow dispatcher
 * checked the children with an EMPTY subject, so the operator was refused here
 * too even though every route served them. Companion of
 * `tool-lane-operator-plan-exempt.test.ts` (boot-time plan config differs).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createScopedAgentToolProvider } from '../src/host/agentToolProvider.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { CAMPAIGN_ORCH_RUN_TOOL_ID } from '../src/features/campaign-orchestration/agentTools.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { startWorkflowRun } from '../src/host/runStarter.js';
import { dispatchSubWorkflow } from '../src/executor/subWorkflowDispatcher.js';
import { CHANNEL_WORKFLOW_IDS } from '../src/features/campaign-channels/channelWorkflows.js';
import { ORCHESTRATION_ID } from '../src/features/campaign-orchestration/orchestrationWorkflow.js';

const OPERATOR_PERSONAL = 'user:operator-child-0001';
const CUSTOMER_PERSONAL = 'user:customer-child-0001';
const FREE_WS = 'ws:free-child-gate-0001';
const ENV = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_AUTH_DISABLE_COOKIES: 'true',
  OPENWOP_SUPERADMIN_TENANTS: OPERATOR_PERSONAL,
  OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_mktg: 'marketing' }),
  OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify({ free: ['billing', 'campaign-brief', 'campaign-orchestration'], pro: ['billing'] }),
};
const saved: Record<string, string | undefined> = {};
let server: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;
const briefs: Record<'op' | 'cu', string> = { op: '', cu: '' };

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  for (const id of ['campaign-brief', 'campaign-orchestration', 'campaign-channels', 'billing']) {
    const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  for (const [who, user] of [['op', 'operator-child'], ['cu', 'customer-child']] as const) {
    const org = await createOrg({ tenantId: FREE_WS, createdBy: user, name: `${who} Co`, ownerSubject: user });
    briefs[who] = (await createBrief(FREE_WS, org.orgId, user, { name: `${who} Launch`, productName: 'Acme' })).id;
  }
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

const run = (actingUserId: string, personalTenant: string, planExempt: boolean, briefId: string) =>
  createScopedAgentToolProvider({ tenantId: FREE_WS, runId: 'run-child-gate', actingUserId, personalTenant, ...(planExempt ? { planExempt: true } : {}) })
    .executeTool({ name: CAMPAIGN_ORCH_RUN_TOOL_ID, input: { briefId } });

describe('campaign-orchestration.run — the channel-child gate', () => {
  it('the operator passes the child gate in a workspace whose plan lacks campaign-channels', async () => {
    const out = await run('operator-child', OPERATOR_PERSONAL, true, briefs.op);
    expect(out.isError, out.content).toBeFalsy();
    const body = JSON.parse(out.content) as { runId?: string };
    expect(typeof body.runId).toBe('string');
    expect((await storage.getRun(body.runId!))?.metadata).toMatchObject({ planExempt: true });
  });

  it('control: a customer in the same workspace reaches the child gate and is refused on the PLAN', async () => {
    const out = await run('customer-child', CUSTOMER_PERSONAL, false, briefs.cu);
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'forbidden', reason: 'not_entitled', feature: 'campaign-channels' });
  });

  it('control: a forged stamp on a customer turn changes nothing', async () => {
    const out = await run('customer-child', CUSTOMER_PERSONAL, true, briefs.cu);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'forbidden', reason: 'not_entitled', feature: 'campaign-channels' });
  });
});

describe('sub-workflow dispatch — a channel child of the parent run', () => {
  async function parent(actingUserId: string, personalTenant: string, planExempt: boolean, briefId: string): Promise<string> {
    const id = await startWorkflowRun({ storage, hostSuite }, {
      tenantId: FREE_WS, workflowId: ORCHESTRATION_ID, inputs: { briefId },
      metadata: { actingUserId }, personalTenant, ...(planExempt ? { planExempt: true as const } : {}),
    });
    expect(id).toBeTruthy();
    return id!;
  }
  const child = (parentRunId: string) => dispatchSubWorkflow({
    parentRunId, parentTenantId: FREE_WS, childWorkflowId: CHANNEL_WORKFLOW_IDS[0]!, parentNodeId: 'test-node', onChildFailure: 'continue',
  });

  it('an operator-stamped parent launches the child under the exemption, and the child carries the stamp', async () => {
    const result = await child(await parent('operator-child', OPERATOR_PERSONAL, true, briefs.op));
    const row = await storage.getRun(result.childRunId);
    expect(row?.metadata).toMatchObject({ planExempt: true, planExemptPersonalTenant: OPERATOR_PERSONAL, orgScopeSubject: 'operator-child' });
    // The authority-bearing key is NOT copied: a child has no actor (ADR 0627 / 0832 D3).
    expect((row!.metadata as Record<string, unknown>).personalTenant).toBeUndefined();
  });

  it('a child in the operator\'s OWN personal tenant gets no implicit-owner personalTenant', async () => {
    const parentId = await startWorkflowRun({ storage, hostSuite }, {
      tenantId: OPERATOR_PERSONAL, workflowId: ORCHESTRATION_ID, inputs: { briefId: 'cb-none' },
      metadata: { actingUserId: 'operator-child' }, personalTenant: OPERATOR_PERSONAL, planExempt: true,
    });
    const result = await dispatchSubWorkflow({ parentRunId: parentId!, parentTenantId: OPERATOR_PERSONAL, childWorkflowId: CHANNEL_WORKFLOW_IDS[0]!, parentNodeId: 'test-node', onChildFailure: 'continue' });
    const meta = (await storage.getRun(result.childRunId))!.metadata as Record<string, unknown>;
    expect(meta.planExempt).toBe(true);
    expect(meta.personalTenant).toBeUndefined();
    expect(meta.actingUserId).toBeUndefined();
  });

  it('control: a stamped parent whose operator has since been DE-LISTED gives the child nothing, and it is refused', async () => {
    const parentId = await parent('operator-child', OPERATOR_PERSONAL, true, briefs.op);
    process.env.OPENWOP_SUPERADMIN_TENANTS = 'user:someone-else';
    try {
      await expect(child(parentId)).rejects.toMatchObject({ code: 'subworkflow_feature_refused' });
    } finally {
      process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR_PERSONAL;
    }
  });

  it('control: a customer parent\'s child is refused on the plan (subworkflow_feature_refused)', async () => {
    await expect(child(await parent('customer-child', CUSTOMER_PERSONAL, false, briefs.cu))).rejects.toMatchObject({ code: 'subworkflow_feature_refused' });
  });
});
