/**
 * CC-MCP-1 — Campaign Studio's outside-agent read door (`bindExternal`, the
 * `campaign-studio.mcp.*` chains and the MCP mount) honours the listed operator's
 * plan exemption (ADR 1108), and still refuses a plan-blocked customer.
 *
 * Observed live on app.openwop.dev (2026-11-13 ~04:10Z): with QA client
 * org-57dd2a6a's "Outside AI agents" saved as `read` (PATCH 200, persisted across a
 * reload), the operator's runs of `campaign-studio.mcp.list` and
 * `campaign-studio.mcp.pending-gates` in a free-plan workspace FAILED with
 * `not_found` "Client not found." Mechanism: `externalRead.ts` `bindExternal`
 * resolved `campaign-ops` and `featureAccessRefusal('campaign-orchestration', …)`
 * with `{ tenantId }` only, so the run's `planExempt` never reached them, the plan
 * refused `campaign-orchestration` (the marketing bundle), and the refusal collapsed
 * to the not-found every bind refusal shares. `externalAgents` was never the cause:
 * it is checked only for an external (MCP-started) run.
 *
 * Fixture: a real client org (operator and customer are both members, so the ADR
 * 0832 org floor passes for both) registered as a campaign-ops client.
 *
 * Controls: a customer in the SAME free workspace is still the not-found, so the
 * fix grants a customer nothing; an actorless scope is the honest `no_acting_user`;
 * `campaign-orchestration` switched OFF is still the not-found for the operator.
 *
 * Sabotage witness: revert either resolve in `bindExternal` to
 * `{ tenantId: scope.tenantId }` → the operator case goes red with `not_found`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { mcpListCampaigns } from '../src/features/campaign-ops/externalRead.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';

const OPERATOR_PERSONAL = 'user:ccmcp1-operator';
const CUSTOMER_PERSONAL = 'user:ccmcp1-customer';
let TENANT: string;
let OP_USER: string;
let CU_USER: string;
let CLIENT: string;
const saved: Record<string, string | undefined> = {};
const ENV = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  OPENWOP_SUPERADMIN_TENANTS: OPERATOR_PERSONAL,
  // A narrowed plan: the marketing bundle (campaign-orchestration) is sold, so a free workspace is not entitled to it.
  OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_marketing: 'marketing' }),
  OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify({ free: ['billing'], pro: ['billing'] }),
};
const operator = (): BundleScope => ({ tenantId: TENANT, actingUserId: OP_USER, personalTenant: OPERATOR_PERSONAL, planExempt: true });
const customer = (): BundleScope => ({ tenantId: TENANT, actingUserId: CU_USER, personalTenant: CUSTOMER_PERSONAL, planExempt: true });
const actorless = (): BundleScope => ({ tenantId: TENANT });
const toggle = async (id: string, on: boolean) => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['campaign-ops', 'campaign-orchestration', 'billing']) await toggle(id, true);
  TENANT = (await createWorkspace({ name: 'Free Agency', ownerSubject: 'oidc:ccmcp1-owner' })).tenantId;
  OP_USER = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:ccmcp1-operator', source: 'oidc' })).userId;
  CU_USER = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:ccmcp1-customer', source: 'oidc' })).userId;
  for (const u of [OP_USER, CU_USER]) await createMember({ tenantId: TENANT, orgId: TENANT, subject: u, displayName: u, roles: ['admin'] });
  CLIENT = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'CC-MCP-1 Client' })).orgId;
  for (const u of [OP_USER, CU_USER]) await createMember({ tenantId: TENANT, orgId: CLIENT, subject: u, displayName: u, roles: ['editor'] });
  await createClient({ tenantId: TENANT, name: 'CC-MCP-1 Client', orgId: CLIENT, createdBy: OP_USER });
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('CC-MCP-1 — outside-agent read door, operator plan exemption', () => {
  it('the operator reads the client in a free-plan workspace', async () => {
    const out = await mcpListCampaigns(operator(), CLIENT);
    expect(out).toMatchObject({ campaigns: [] });
  });
  it('control: a customer in the same free workspace is still the not-found', async () => {
    await expect(mcpListCampaigns(customer(), CLIENT)).rejects.toMatchObject({ code: 'not_found', message: 'Client not found.' });
  });
  it('control: an actorless scope is the honest no_acting_user refusal', async () => {
    await expect(mcpListCampaigns(actorless(), CLIENT)).rejects.toMatchObject({ code: 'forbidden_scope', details: { reason: 'no_acting_user' } });
  });
  it('control: campaign-orchestration switched OFF is still the not-found for the operator', async () => {
    await toggle('campaign-orchestration', false);
    try {
      await expect(mcpListCampaigns(operator(), CLIENT)).rejects.toMatchObject({ code: 'not_found' });
    } finally { await toggle('campaign-orchestration', true); }
  });
});
