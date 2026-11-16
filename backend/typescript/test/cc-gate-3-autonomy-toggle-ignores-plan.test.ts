/**
 * CC-GATE-3 — an exempt operator's run freezes an autonomy policy in a workspace
 * whose plan lacks `marketing`; a non-exempt customer's never does.
 *
 * MEASURED on prod 2026-11-16 (run b34a112d): a listed operator in a workspace whose
 * plan lacks the `marketing` bundle started a campaign orchestration through the
 * Strategist. The chat tool carries the operator's plan exemption (ADR 1108), but
 * `autonomyToggleOn` resolved the toggles through the plan entitlement for the
 * bare tenant (no exemption) and said OFF. The run froze no policy, and the kernel autonomy gate decided `legacy`
 * (`legacy: true` in its output): a plain approval the requester approved themselves.
 *
 * The fix keeps the plan check (a frozen policy is bounded auto-approval, a paid
 * capability) and lets only the run's ADR 1108 exemption, re-checked against the
 * allowlist, through it. Every caller that holds a run passes that scope.
 *
 * Sabotage witnesses: drop the exemption from `autonomyToggleOn` (main's code) → the
 * operator cases go red; make it toggle-only → the customer contributor cases go red.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createScopedAgentToolProvider, type AgentToolCallScope } from '../src/host/agentToolProvider.js';
import { CAMPAIGN_ORCH_RUN_TOOL_ID } from '../src/features/campaign-orchestration/agentTools.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { AUTONOMY_TOGGLE, decideGate } from '../src/host/autonomyPolicy/index.js';
import { autonomyToggleOn } from '../src/host/autonomyPolicy/service.js';
import { AUTONOMY_STAMP_KEY } from '../src/host/autonomyPolicy/frozen.js';
import { campaignAutonomyContributor } from '../src/features/campaign-orchestration/autonomyStamp.js';
import { clientAutonomyContributor } from '../src/features/campaign-ops/autonomyStamp.js';
import { CAMPAIGN_RUN_TAG_KEY } from '../src/host/campaignRefs.js';

const OPERATOR_PERSONAL = 'user:gate3-operator';
const CUSTOMER_PERSONAL = 'user:gate3-customer';
const FREE_WS = 'ws:cc-gate-3-free';
let server: http.Server;
let storage: Storage;
let briefId = '';
let orgId = '';
let operatorTag: unknown;
const saved: Record<string, string | undefined> = {};
const ENV = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  OPENWOP_SUPERADMIN_TENANTS: OPERATOR_PERSONAL,
  OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_mktg: 'marketing' }),
  OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify({ free: ['billing'], pro: ['billing'] }),
};

async function setToggle(id: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status }, 'test');
}
function call(scope: Omit<AgentToolCallScope, 'runId'>, name: string, input: Record<string, unknown>) {
  return createScopedAgentToolProvider({ runId: 'run-gate3', ...scope }).executeTool({ name, input });
}
const operator = { tenantId: FREE_WS, actingUserId: 'gate3-operator', personalTenant: OPERATOR_PERSONAL, planExempt: true };
const customer = { tenantId: FREE_WS, actingUserId: 'gate3-customer', personalTenant: CUSTOMER_PERSONAL };

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  for (const id of ['campaign-brief', 'campaign-orchestration', 'campaign-channels', 'billing', AUTONOMY_TOGGLE]) await setToggle(id, 'on');
  const org = await createOrg({ tenantId: FREE_WS, createdBy: 'gate3-operator', name: 'Gate3 Co', ownerSubject: 'gate3-operator' });
  orgId = org.orgId;
  briefId = (await createBrief(FREE_WS, org.orgId, 'gate3-operator', { name: 'Gate3 Launch', productName: 'Acme' })).id;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

describe('CC-GATE-3 — an exempt operator in a workspace without marketing', () => {
  it('the access read says ON for the operator\'s exemption, and OFF for the bare tenant (the plan still applies)', async () => {
    expect(await autonomyToggleOn(FREE_WS, { tenantId: FREE_WS, planExempt: true, personalTenant: OPERATOR_PERSONAL })).toBe(true);
    expect(await autonomyToggleOn(FREE_WS)).toBe(false);
  });

  it('an orchestration started through the Strategist tool freezes a policy, so its gates are not legacy', async () => {
    const res = await call(operator, CAMPAIGN_ORCH_RUN_TOOL_ID, { briefId });
    expect(res.isError, res.content).toBeFalsy();
    const { runId } = JSON.parse(res.content) as { runId: string };
    const run = await storage.getRun(runId);
    expect(run?.metadata).toMatchObject({ planExempt: true });
    expect(run?.metadata?.[AUTONOMY_STAMP_KEY]).toBeDefined();
    operatorTag = run?.metadata?.[CAMPAIGN_RUN_TAG_KEY];
    expect(operatorTag).toBeDefined();
    const verdict = decideGate({ run: run!, actionClass: 'plan.approve', facts: {}, toggleOn: await autonomyToggleOn(FREE_WS) });
    expect(verdict.mode).toBe('approve');
    if (verdict.mode === 'approve') expect(verdict.interruptData.autonomy).toMatchObject({ actionClass: 'plan.approve' });
  });
});

describe('CC-GATE-3 — controls', () => {
  it('a non-exempt customer in the same workspace keeps today\'s behaviour: refused at the plan gate, no run', async () => {
    const before = (await storage.listRuns({ tenantId: FREE_WS, limit: 500 })).map((r) => r.runId);
    const res = await call(customer, CAMPAIGN_ORCH_RUN_TOOL_ID, { briefId });
    const body = JSON.parse(res.content) as { error?: string; runId?: string };
    expect(body.error, res.content).toBe('not_entitled');
    expect(body.runId).toBeUndefined();
    // No run was created for the customer, so no autonomy policy froze and no gate
    // could open, whatever the toggle-only read says.
    const after = (await storage.listRuns({ tenantId: FREE_WS, limit: 500 })).map((r) => r.runId);
    expect(after).toEqual(before);
  });

  it('the campaign stamp contributor freezes nothing for a non-exempt run, or a forged exemption, on the same campaign tag', async () => {
    expect(operatorTag).toBeDefined();
    expect(await campaignAutonomyContributor({ tenantId: FREE_WS, metadata: { [CAMPAIGN_RUN_TAG_KEY]: operatorTag } })).toEqual({});
    // `planExempt` is a reserved key a caller cannot set; even if one appeared, the
    // allowlist re-check refuses a person who is not listed.
    expect(await campaignAutonomyContributor({ tenantId: FREE_WS, metadata: { [CAMPAIGN_RUN_TAG_KEY]: operatorTag, planExempt: true, personalTenant: CUSTOMER_PERSONAL } })).toEqual({});
    const op = await campaignAutonomyContributor({ tenantId: FREE_WS, metadata: { [CAMPAIGN_RUN_TAG_KEY]: operatorTag, planExempt: true, personalTenant: OPERATOR_PERSONAL } });
    expect(op[AUTONOMY_STAMP_KEY]).toBeDefined();
  });

  it('the client stamp contributor freezes nothing for a non-exempt client-bound run (any run creation, not only campaign lanes)', async () => {
    const bound = { 'openwop-app.campaignOps': { orgId } };
    expect(await clientAutonomyContributor({ tenantId: FREE_WS, metadata: bound })).toEqual({});
    expect(await clientAutonomyContributor({ tenantId: FREE_WS, metadata: { ...bound, planExempt: true, personalTenant: CUSTOMER_PERSONAL } })).toEqual({});
    const op = await clientAutonomyContributor({ tenantId: FREE_WS, metadata: { ...bound, planExempt: true, personalTenant: OPERATOR_PERSONAL } });
    expect(op[AUTONOMY_STAMP_KEY]).toBeDefined();
  });

  it('the autonomy toggle OFF still means off (today\'s posture)', async () => {
    await setToggle(AUTONOMY_TOGGLE, 'off');
    try {
      expect(await autonomyToggleOn(FREE_WS, { tenantId: FREE_WS, planExempt: true, personalTenant: OPERATOR_PERSONAL })).toBe(false);
    } finally {
      await setToggle(AUTONOMY_TOGGLE, 'on');
    }
  });
});
