/**
 * ADR 0819 §1 — the paywall bypass proved on the PRODUCTION plan shape.
 *
 * Prod sets OPENWOP_BILLING_PLAN_FEATURES with a `free` plan that includes most
 * features but NOT the priced marketing bundle, which `campaign-brief` belongs
 * to. On `origin/main` the Campaign Brief Strategist's `get-brief` tool resolved
 * the toggle alone, so a free-plan tenant read a full brief through chat while
 * every HTTP route for the same feature returned the plan 403. Written RED
 * against `origin/main` source.
 *
 * Tracker TST-DCA-2. Red when the campaign-brief tool's `featureEnabled` reads the
 * toggle alone (`resolveToggle`) instead of the access resolver `resolveOne`
 * (grade-tests w70 probe `pp-brief-gate`).
 *
 * CORRECTED (ADR 1108): the tool now resolves through the kit
 * (`resolveFeatureAccess`), and the refusal code is `not_entitled`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { CAMPAIGN_BRIEF_GET_TOOL_ID } from '../src/features/campaign-brief/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createBrief, type BriefInput } from '../src/features/campaign-brief/briefService.js';

const TENANT = 'default';
let server: http.Server;
let briefId: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  // The prod shape: marketing is priced, and `free` lists non-marketing features only.
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_mktg: 'marketing', price_crm: 'crm', price_agents: 'agents' });
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing', 'strategy', 'priority-matrix', 'forms'], pro: ['billing'] });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  for (const id of ['billing', 'campaign-brief']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  const input: BriefInput = { name: 'Launch Brief', productName: 'Acme' };
  briefId = (await createBrief(TENANT, org.orgId, 'u-1', input)).id;
});
afterAll(async () => {
  delete process.env.OPENWOP_BILLING_BUNDLE_PRICES;
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0819 S1 on the prod plan shape — a priced-not-free feature through chat', () => {
  it('a free-plan tenant cannot read a campaign brief through the Strategist tool', async () => {
    const out = await createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-1' })
      .executeTool({ name: CAMPAIGN_BRIEF_GET_TOOL_ID, input: { briefId } });
    expect(out.content, 'the brief leaked through chat').not.toContain('Launch Brief');
    expect(out.isError).toBe(true);
    // ADR 1108 D6 — the refusal is the PLAN's (`not_entitled`); this used to pin
    // `feature_disabled`, which told the model to flip a toggle that was on.
    expect((JSON.parse(out.content) as { error?: string }).error).toBe('not_entitled');
  });

  it('positive control: the same call serves an entitled tenant (the host operator)', async () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = TENANT;
    try {
      const out = await createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-1' })
        .executeTool({ name: CAMPAIGN_BRIEF_GET_TOOL_ID, input: { briefId } });
      expect(out.isError, out.content).toBeFalsy();
      expect(out.content).toContain('Launch Brief');
    } finally {
      delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    }
  });
});
