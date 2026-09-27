/**
 * CFP-1 repair (docs/chat-first-port/e4-campaign-connectors-intel.md, C14) —
 * the Campaign Intelligence Analyst's REAL chat tools.
 *
 * The bug: the agent pack allowlisted three surface-backed node typeIds that no
 * host registrant provides, so `compileAgentTools` silently dropped them and the
 * Analyst ran in the ONE chat with zero tools (hallucinated numbers). This asserts
 * the fix: the three ids now RESOLVE (`builtinAgentToolIds()`), the pack allowlist
 * matches exactly, and each tool grounds in the performance store with the routes'
 * authority (org RBAC), fails EMPTY without an acting user, and fails TYPED on the
 * toggle / bad model input. Boots the REAL app (the ADR 0308 D2 registration seam).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  CAMPAIGN_INTEL_BUDGET_OPTIMIZE_TOOL_ID,
  CAMPAIGN_INTEL_FORECAST_TOOL_ID,
  CAMPAIGN_INTEL_PLAN_BUDGET_TOOL_ID,
  CAMPAIGN_INTEL_PACING_TOOL_ID,
  CAMPAIGN_INTEL_ATTRIBUTION_TOOL_ID,
} from '../src/features/campaign-intel/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { importCsv } from '../src/features/campaign-connectors/performanceService.js';

const TENANT = 'default';
const OWNER = 'u-1';
let ORG_ID: string;

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // The org RBAC gate mirrors the HTTP route path — the owner holds workspace:read.
  const org = await createOrg({ tenantId: TENANT, createdBy: OWNER, name: 'Acme', ownerSubject: OWNER });
  ORG_ID = org.orgId;
  // Seed the performance store with two platforms of differing ROAS + a fatiguing run.
  const csv = [
    'Platform,Campaign,Day,Cost,Impr.,Clicks,Conversions,Revenue',
    'Meta,A,2026-01-01,1000,10000,100,10,1500',   // ROAS 1.5
    'Meta,A,2026-01-02,1000,10000,40,8,1200',     // CTR drop → fatigue
    'Google,B,2026-01-01,1000,10000,100,40,4000', // ROAS 4.0
    'Google,B,2026-01-02,1000,10000,90,38,3800',
  ].join('\n');
  await importCsv(TENANT, ORG_ID, csv);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setToggle = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('campaign-intel');
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

const ALL_IDS = [
  CAMPAIGN_INTEL_BUDGET_OPTIMIZE_TOOL_ID,
  CAMPAIGN_INTEL_FORECAST_TOOL_ID,
  CAMPAIGN_INTEL_PLAN_BUDGET_TOOL_ID,
  // R2 CI-SP-10 — the Analyst can finally READ the sections the page
  // deep-links it from.
  CAMPAIGN_INTEL_PACING_TOOL_ID,
  CAMPAIGN_INTEL_ATTRIBUTION_TOOL_ID,
];

describe('CFP-1 — registration + pack parity', () => {
  it('all three tools register into the builtin surface (dispatchable)', () => {
    const ids = builtinAgentToolIds();
    for (const id of ALL_IDS) expect(ids).toContain(id);
  });

  it('the agent pack allowlist is EXACTLY the registered ids', () => {
    const packDir = new URL('../../../packs/feature.campaign-intel.agents/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as {
      agents: { toolAllowlist: string[] }[];
    };
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual([...ALL_IDS].sort());
  });

  it('R2 CI-SP-10 review fold-in: every allowlisted tool is NAMED in the system prompt', () => {
    // agent-prompt-tool-ids is ONE-directional (mentioned ids must exist); it
    // never required allowlisted ids to be MENTIONED, so the prompt could say
    // "you act only through these three" while the allowlist held five — a
    // model told that under-uses the pacing tool it was deep-linked to answer
    // with. This pin closes the other direction for this pack.
    const packDir = new URL('../../../packs/feature.campaign-intel.agents/', import.meta.url);
    const prompt = readFileSync(new URL('prompts/intelligence-analyst.md', packDir), 'utf8');
    for (const id of ALL_IDS) expect(prompt).toContain(id);
  });

  it('R2 CC-SP-17: the exemplar answers never model a currency symbol on store figures', () => {
    // The store's figures are not guaranteed single-currency and there is no
    // FX; an exemplar like "Shift ~$1,200" teaches the model to mint the exact
    // label the round-1 UI work removed. Pin the de-$-ed exemplars so the
    // symbol cannot silently return.
    const packDir = new URL('../../../packs/feature.campaign-intel.agents/', import.meta.url);
    const prompt = readFileSync(new URL('prompts/intelligence-analyst.md', packDir), 'utf8');
    expect(prompt).not.toMatch(/[~+]\$\d/);
  });
});

describe('CFP-1 — budget-optimize: grounded read + gates', () => {
  it('recommends a reallocation over the ACTUAL performance store', async () => {
    await setToggle('on');
    const out = await provider({ actingUserId: OWNER }).executeTool({ name: CAMPAIGN_INTEL_BUDGET_OPTIMIZE_TOOL_ID, input: { orgId: ORG_ID } });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { reallocations: { platform: string; changeAmount: number }[]; projectedRoasGain: number };
    expect(parsed.reallocations.length).toBe(2);
    expect(parsed.projectedRoasGain).toBeGreaterThan(0);
    const meta = parsed.reallocations.find((r) => r.platform === 'meta')!;
    expect(meta.changeAmount).toBeLessThan(0); // trimmed from the low-ROAS platform
  });

  it('fails closed when the toggle is off (typed, not a throw)', async () => {
    await setToggle('off');
    const out = await provider({ actingUserId: OWNER }).executeTool({ name: CAMPAIGN_INTEL_BUDGET_OPTIMIZE_TOOL_ID, input: { orgId: ORG_ID } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setToggle('on');
  });

  it('FAILS EMPTY without an acting user (no isError — a system turn reads nothing)', async () => {
    const out = await provider().executeTool({ name: CAMPAIGN_INTEL_BUDGET_OPTIMIZE_TOOL_ID, input: { orgId: ORG_ID } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content).reallocations).toEqual([]);
  });

  it('missing orgId is a TYPED error the loop can repair from', async () => {
    const out = await provider({ actingUserId: OWNER }).executeTool({ name: CAMPAIGN_INTEL_BUDGET_OPTIMIZE_TOOL_ID, input: {} });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'org_required' });
  });

  it('shares the routes authority — a non-member is forbidden', async () => {
    const out = await provider({ actingUserId: 'stranger' }).executeTool({ name: CAMPAIGN_INTEL_BUDGET_OPTIMIZE_TOOL_ID, input: { orgId: ORG_ID } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'forbidden_scope' });
  });
});

describe('CFP-1 — forecast: grounded read', () => {
  it('returns per-campaign forecasts including creative-fatigue', async () => {
    const out = await provider({ actingUserId: OWNER }).executeTool({ name: CAMPAIGN_INTEL_FORECAST_TOOL_ID, input: { orgId: ORG_ID } });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { forecasts: { campaignName: string; creativeFatigue: { detected: boolean } }[] };
    expect(parsed.forecasts.length).toBeGreaterThan(0);
    expect(parsed.forecasts.every((f) => typeof f.creativeFatigue.detected === 'boolean')).toBe(true);
  });

  it('fails empty without an acting user', async () => {
    const out = await provider().executeTool({ name: CAMPAIGN_INTEL_FORECAST_TOOL_ID, input: { orgId: ORG_ID } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content).forecasts).toEqual([]);
  });
});

describe('CFP-1 — plan-budget: deterministic goal planning + input validation', () => {
  it('returns a plan with a feasibility verdict', async () => {
    const out = await provider({ actingUserId: OWNER }).executeTool({
      name: CAMPAIGN_INTEL_PLAN_BUDGET_TOOL_ID,
      input: { orgId: ORG_ID, totalBudgetMinor: 500000, targetConversions: 100 },
    });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { plan: { verdict: string; platforms: unknown[] } };
    expect(['feasible', 'stretch', 'infeasible']).toContain(parsed.plan.verdict);
  });

  it('rejects a non-positive goal as a TYPED validation error (money math never sees it)', async () => {
    const out = await provider({ actingUserId: OWNER }).executeTool({
      name: CAMPAIGN_INTEL_PLAN_BUDGET_TOOL_ID,
      input: { orgId: ORG_ID, totalBudgetMinor: -5, targetConversions: 100 },
    });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'validation_error', field: 'totalBudgetMinor' });
  });
});
