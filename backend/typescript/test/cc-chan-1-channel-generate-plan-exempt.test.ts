/**
 * CC-CHAN-1 — the Channel Generator's `openwop:campaign-channels.generate` starts
 * the channel run for the listed operator in a free-plan workspace (ADR 1108).
 *
 * Observed live on app.openwop.dev (build 373d4863a, 2026-11-12 02:45Z and
 * 02:52–02:54Z, QA workspace ws:8941aa35, Anthropic Claude Sonnet 5.5): every
 * call to `generate` came back `forbidden` (5×) and the turn ended
 * `tool_rounds_exhausted`, while the read tool `campaign-channels.channels`
 * worked. Cloud Run logs pinned the branch: `workflow_launch_refused_feature
 * {blockedBy:'plan', featureId:'campaign-channels'}` then
 * `campaign_channel_dispatch_threw` — the tool passed every gate of its own and
 * then `startWorkflowRun` refused the run at the run-start plan gate, because
 * the tool never forwarded the operator's exemption (`forwardedPlanExemption`),
 * unlike the campaign-brief and campaign-orchestration tools ADR 1108 fixed.
 *
 * Pins: the operator's generate starts a run stamped `planExempt`; controls — a
 * customer in the same free workspace is refused as a PLAN refusal
 * (`forbidden`, reason `not_entitled`), and a stamp whose person is not listed
 * grants nothing.
 *
 * Sabotage witness: drop `...forwardedPlanExemption(scope)` from
 * `runChannelGenerateTool`'s `startWorkflowRun` call ⇒ "the operator's generate
 * starts the channel run" goes red (`forbidden`, `not_entitled`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createScopedAgentToolProvider, type AgentToolCallScope } from '../src/host/agentToolProvider.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { CAMPAIGN_CHANNELS_GENERATE_TOOL_ID } from '../src/features/campaign-channels/agentTools.js';
import type { Storage } from '../src/storage/storage.js';

const OPERATOR_PERSONAL = 'user:chan1-operator';
const CUSTOMER_PERSONAL = 'user:chan1-customer';
const FREE_WS = 'ws:chan1-free-workspace';

let server: http.Server;
let storage: Storage;
let operatorBriefId = '';
let customerBriefId = '';
const saved: Record<string, string | undefined> = {};
const ENV = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  OPENWOP_SUPERADMIN_TENANTS: OPERATOR_PERSONAL,
  OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_mktg: 'marketing' }),
  OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify({ free: ['billing'], pro: ['billing'] }),
};
const emailChannel = [{ type: 'email_sequence' as const, enabled: true, config: {} }];

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  for (const id of ['campaign-brief', 'campaign-channels', 'campaign-orchestration', 'billing']) {
    const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const opOrg = await createOrg({ tenantId: FREE_WS, createdBy: 'chan1-operator', name: 'Op Co', ownerSubject: 'chan1-operator' });
  operatorBriefId = (await createBrief(FREE_WS, opOrg.orgId, 'chan1-operator', { name: 'Operator launch', productName: 'Acme', channels: emailChannel })).id;
  const cuOrg = await createOrg({ tenantId: FREE_WS, createdBy: 'chan1-customer', name: 'Cu Co', ownerSubject: 'chan1-customer' });
  customerBriefId = (await createBrief(FREE_WS, cuOrg.orgId, 'chan1-customer', { name: 'Customer launch', productName: 'Acme', channels: emailChannel })).id;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

function call(scope: Omit<AgentToolCallScope, 'runId'>, input: Record<string, unknown>) {
  return createScopedAgentToolProvider({ runId: 'run-chan1', ...scope }).executeTool({ name: CAMPAIGN_CHANNELS_GENERATE_TOOL_ID, input });
}
const operator = { tenantId: FREE_WS, actingUserId: 'chan1-operator', personalTenant: OPERATOR_PERSONAL, planExempt: true };
const customer = { tenantId: FREE_WS, actingUserId: 'chan1-customer', personalTenant: CUSTOMER_PERSONAL };
const body = (r: { content: string }) => JSON.parse(r.content) as { runId?: string; error?: string; reason?: string; details?: { reason?: string } };

describe('CC-CHAN-1 — campaign-channels.generate and the operator plan exemption', () => {
  it("the operator's generate starts the channel run, stamped with the exemption", async () => {
    const r = await call(operator, { briefId: operatorBriefId, channel: 'email_sequence' });
    expect(r.isError, r.content).toBeFalsy();
    const runId = body(r).runId;
    expect(typeof runId).toBe('string');
    expect((await storage.getRun(runId!))?.metadata).toMatchObject({ planExempt: true, personalTenant: OPERATOR_PERSONAL });
  });

  it('control: a customer in the same free workspace is refused as a plan refusal', async () => {
    const r = await call(customer, { briefId: customerBriefId, channel: 'email_sequence' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not_entitled');
  });

  it('control: a stamp whose person is not listed grants nothing', async () => {
    const r = await call({ ...customer, planExempt: true }, { briefId: customerBriefId, channel: 'email_sequence' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not_entitled');
  });
});
