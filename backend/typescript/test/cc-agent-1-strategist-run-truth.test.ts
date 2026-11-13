/**
 * CC-AGENT-1 — the Campaign Strategist is told what the run it starts will do,
 * and can read the campaign's effective review policy.
 *
 * MEASURED on app.openwop.dev (373d4863a, 2026-11-12, operator in a FREE-plan
 * workspace): after `campaign-orchestration.run` the Strategist said "Kernel:
 * already approved and not stale, so the run uses it rather than generating a
 * new one" — but `campaign-studio.campaign-orchestration` always runs
 * validate → generate-kernel → kernel-approve, and it gated a NEW kernel. The run
 * tool returned only `{runId, briefId, campaignId, workflowId}`, so the model
 * guessed. In the same turn `get-autonomy` returned `{autonomy: null}` while the
 * campaign page showed the effective default ("Review everything"): the tool
 * resolved the autonomy toggles for the TENANT only, so the operator's plan
 * exemption never reached it (`autonomyToggleOn(tenantId)`).
 *
 * Pins: the run result carries `steps` naming the kernel regeneration and its
 * approval; get-autonomy answers the plan-exempt operator in a free workspace;
 * control: a customer in the same free workspace still reads nothing.
 *
 * Red when: the run result loses `steps` / the regeneration line, or the
 * autonomy read goes back to a tenant-only toggle resolve.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createScopedAgentToolProvider, type AgentToolCallScope } from '../src/host/agentToolProvider.js';
import { CAMPAIGN_ORCH_AUTONOMY_TOOL_ID, CAMPAIGN_ORCH_RUN_TOOL_ID, ORCHESTRATION_RUN_STEP_NODES } from '../src/features/campaign-orchestration/agentTools.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOrg } from '../src/host/accessControlService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { AUTONOMY_TOGGLE } from '../src/host/autonomyPolicy/index.js';

const OPERATOR_PERSONAL = 'user:operator-cca1';
const CUSTOMER_PERSONAL = 'user:customer-cca1';
const FREE_WS = 'ws:free-workspace-cca1';

let server: http.Server;
let campaignId = '';
let briefId = '';
const saved: Record<string, string | undefined> = {};
const ENV = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  OPENWOP_TEST_AUTH_ENABLED: 'true',
  OPENWOP_SUPERADMIN_TENANTS: OPERATOR_PERSONAL,
  OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_mktg: 'marketing' }),
  OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify({ free: ['billing'], pro: ['billing'] }),
};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  for (const id of ['campaign-brief', 'campaign-orchestration', 'campaign-channels', AUTONOMY_TOGGLE, 'billing']) {
    const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const org = await createOrg({ tenantId: FREE_WS, createdBy: 'operator-cca1', name: 'Op Co', ownerSubject: 'operator-cca1' });
  const brief = await createBrief(FREE_WS, org.orgId, 'operator-cca1', { name: 'Launch', productName: 'Acme', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  briefId = brief.id;
  campaignId = (await finalizeFromBrief(FREE_WS, brief, 'operator-cca1')).id;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

function call(scope: Omit<AgentToolCallScope, 'runId'>, name: string, input: Record<string, unknown>) {
  return createScopedAgentToolProvider({ runId: 'run-cca1', ...scope }).executeTool({ name, input });
}
const operator = { tenantId: FREE_WS, actingUserId: 'operator-cca1', personalTenant: OPERATOR_PERSONAL, planExempt: true };
const customer = { tenantId: FREE_WS, actingUserId: 'customer-cca1', personalTenant: CUSTOMER_PERSONAL };

describe('CC-AGENT-1 — get-autonomy honours the operator exemption', () => {
  it('the plan-exempt operator in a free workspace reads the effective policy', async () => {
    const out = await call(operator, CAMPAIGN_ORCH_AUTONOMY_TOOL_ID, { campaignId });
    const parsed = JSON.parse(out.content) as { autonomy: { steps?: unknown[] } | null };
    expect(parsed.autonomy, out.content).not.toBeNull();
    expect(Array.isArray(parsed.autonomy?.steps) && parsed.autonomy!.steps!.length > 0).toBe(true);
  });

  it('control: a customer in the same free workspace reads nothing', async () => {
    const out = await call(customer, CAMPAIGN_ORCH_AUTONOMY_TOOL_ID, { campaignId });
    expect(JSON.parse(out.content)).toMatchObject({ autonomy: null });
  });
});

describe('CC-AGENT-1 — the run result says what the run will do', () => {
  it('names the kernel regeneration and its approval gate', async () => {
    const out = await call(operator, CAMPAIGN_ORCH_RUN_TOOL_ID, { briefId });
    expect(out.isError, out.content).toBeFalsy();
    const parsed = JSON.parse(out.content) as { runId?: string; steps?: string[] };
    expect(parsed.runId).toBeTruthy();
    expect(Array.isArray(parsed.steps)).toBe(true);
    const text = parsed.steps!.join(' | ');
    expect(text).toMatch(/new messaging kernel/i);
    expect(text).toMatch(/even if the brief already has an approved kernel/i);
    expect(text).toMatch(/approv/i);
  });
});

describe('CC-AGENT-1 — the steps the model is told cover the chain, in order', () => {
  it('ORCHESTRATION_RUN_STEP_NODES flattens to exactly the campaign-orchestration chain node ids', () => {
    const pack = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'workflow-chain-packs', 'campaign-orchestration', 'pack.json'), 'utf8')) as {
      chains: Array<{ chainId: string; dag: { nodes: Array<{ id: string }> } }>;
    };
    const chain = pack.chains.find((c) => c.chainId === 'campaign-studio.campaign-orchestration');
    expect(chain).toBeTruthy();
    expect(ORCHESTRATION_RUN_STEP_NODES.flatMap((s) => s.nodes)).toEqual(chain!.dag.nodes.map((n) => n.id));
  });
});
