/**
 * CC-CTX-1 — the per-client context block (ADR 0944 D5) honours the listed
 * operator's plan exemption (ADR 1108), and still applies the plan to everyone else.
 *
 * Found reading source during the Campaign Studio deployed retest (prod f1b882654,
 * 2026-11-13), as the residue of CC-AUTH-6 / CC-MCP-1: `clientContext.ts` checked
 * every source feature with `featureAccessRefusal(featureId, tenantId)` and no
 * subject. In a workspace whose plan does not include the marketing bundle, a run
 * the operator started was told "Past performance — not in this workspace plan"
 * although campaign-connectors is switched on. The block reaches agent prompts only,
 * so this could not be observed in the UI; this test is the witness.
 *
 * Controls: the same run WITHOUT the stamp still gets the plan reason (the fix grants
 * nothing to a customer); campaign-connectors switched OFF is still left out for the
 * operator ("turned off").
 *
 * Sabotage witness: drop the subject from `performanceSection`'s refusal (or from
 * `clientContextForRun`) → the operator case goes red with the plan reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { CAMPAIGN_OPS_RUN_STAMP } from '../src/features/campaign-ops/surface.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { clientContextForRun } from '../src/features/campaign-ops/clientContext.js';
import { importCsv } from '../src/features/campaign-connectors/performanceService.js';
import type { RunRecord } from '../src/types.js';

const OPERATOR_PERSONAL = 'user:ccctx1-operator';
let TENANT: string;
let CLIENT: string;
let OP_USER: string;
const saved: Record<string, string | undefined> = {};
const ENV = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  OPENWOP_SUPERADMIN_TENANTS: OPERATOR_PERSONAL,
  // A narrowed plan: the marketing bundle (campaign-connectors) is sold, so a free workspace is not entitled to it.
  OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_marketing: 'marketing' }),
  OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify({ free: ['billing'], pro: ['billing'] }),
};
const toggle = async (id: string, on: boolean) => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
};

async function newRun(exempt: boolean): Promise<string> {
  const runId = `run-ctx1-${randomBytes(5).toString('hex')}`;
  const now = new Date().toISOString();
  const metadata: Record<string, unknown> = {
    [CAMPAIGN_OPS_RUN_STAMP]: { orgId: CLIENT }, actingUserId: OP_USER,
    ...(exempt ? { planExempt: true, personalTenant: OPERATOR_PERSONAL } : {}),
  };
  await insertRunWithStartContext(hostExtStorage(), {
    runId, workflowId: 'w', tenantId: TENANT, status: 'running', inputs: null,
    metadata, configurable: {}, createdAt: now, updatedAt: now,
  } as RunRecord, { admission: { plan: 'exempt:test-fixture' }, tenantId: TENANT });
  return runId;
}
async function blockOf(runId: string): Promise<string> {
  const out = await clientContextForRun(TENANT, runId);
  if (!out || 'refused' in out) throw new Error(`no client context: ${JSON.stringify(out)}`);
  return out.snapshot.block;
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['campaign-ops', 'campaign-connectors', 'billing']) await toggle(id, true);
  // brand / kb are always-on features with no toggle default (the ADR 0944 P2 fixture skips them the same way).
  for (const id of ['brand', 'kb']) { if (getToggleDefault(id)) await toggle(id, true); }
  TENANT = (await createWorkspace({ name: 'Free Agency', ownerSubject: 'oidc:ccctx1-owner' })).tenantId;
  OP_USER = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:ccctx1-operator', source: 'oidc' })).userId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: OP_USER, displayName: 'Operator', roles: ['admin'] });
  CLIENT = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'CC-CTX-1 Client' })).orgId;
  await createMember({ tenantId: TENANT, orgId: CLIENT, subject: OP_USER, displayName: 'Operator', roles: ['editor'] });
  await createClient({ tenantId: TENANT, orgId: CLIENT, name: 'CC-CTX-1 Client', createdBy: 'seed' });
  await importCsv(TENANT, CLIENT, ['Platform,Campaign,Day,Cost,Impr.,Clicks,Conversions,Revenue', 'Google,CTX1-SEARCH,2026-01-01,1000,10000,100,40,4000'].join('\n'));
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('CC-CTX-1 — client context block, operator plan exemption', () => {
  it('a run the listed operator started includes Past performance in a narrowed-plan workspace', async () => {
    const block = await blockOf(await newRun(true));
    expect(block).toContain('CTX1-SEARCH');
    expect(block).not.toContain('Past performance\n(Not included: not in this workspace plan.)');
  });
  it('control: the same run without the stamp still gets the plan reason', async () => {
    const block = await blockOf(await newRun(false));
    expect(block).toContain('## Past performance\n(Not included: not in this workspace plan.)');
    expect(block).not.toContain('CTX1-SEARCH');
  });
  it('control: campaign-connectors switched OFF is still left out for the operator', async () => {
    await toggle('campaign-connectors', false);
    try {
      const block = await blockOf(await newRun(true));
      expect(block).toContain('## Past performance\n(Not included: turned off.)');
    } finally { await toggle('campaign-connectors', true); }
  });
});
