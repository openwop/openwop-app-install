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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  CAMPAIGN_INTEL_BUDGET_OPTIMIZE_TOOL_ID,
  CAMPAIGN_INTEL_FORECAST_TOOL_ID,
  CAMPAIGN_INTEL_PLAN_BUDGET_TOOL_ID,
  CAMPAIGN_INTEL_PACING_TOOL_ID,
  CAMPAIGN_INTEL_ATTRIBUTION_TOOL_ID,
  CAMPAIGN_INTEL_CAPS_TOOL_ID,
  CAMPAIGN_INTEL_PROPOSE_REALLOCATION_TOOL_ID,
} from '../src/features/campaign-intel/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
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
  // Seed the performance store with two platforms of differing ROAS (2 days
  // each — below the forecaster's 4-day creative-fatigue minimum).
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
// The toggle defaults OFF and `readGate` checks it FIRST — every case sets it
// itself so the file passes alone and shuffled (no inherited state).
beforeEach(async () => { await setToggle('on'); });

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
  // ADR 0952 D8 — the Media Buyer widening (+2).
  CAMPAIGN_INTEL_CAPS_TOOL_ID,
  CAMPAIGN_INTEL_PROPOSE_REALLOCATION_TOOL_ID,
];

describe('CFP-1 — registration + pack parity', () => {
  it('all three tools register into the builtin surface (dispatchable)', () => {
    const ids = builtinAgentToolIds();
    for (const id of ALL_IDS) expect(ids).toContain(id);
  });

  it('the agent pack allowlist is EXACTLY the registered ids', () => {
    const packDir = new URL('../../../packs/vendor.openwop-app.campaign-intel.agents/', import.meta.url);
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
    const packDir = new URL('../../../packs/vendor.openwop-app.campaign-intel.agents/', import.meta.url);
    const prompt = readFileSync(new URL('prompts/intelligence-analyst.md', packDir), 'utf8');
    for (const id of ALL_IDS) expect(prompt).toContain(id);
  });

  it('R2 CC-SP-17: the exemplar answers never model a currency symbol on store figures', () => {
    // The store's figures are not guaranteed single-currency and there is no
    // FX; an exemplar like "Shift ~$1,200" teaches the model to mint the exact
    // label the round-1 UI work removed. Pin the de-$-ed exemplars so the
    // symbol cannot silently return.
    const packDir = new URL('../../../packs/vendor.openwop-app.campaign-intel.agents/', import.meta.url);
    const prompt = readFileSync(new URL('prompts/intelligence-analyst.md', packDir), 'utf8');
    expect(prompt).not.toMatch(/[~+]\$\d/);
  });
});

describe('CFP-1 — budget-optimize: grounded read + gates', () => {
  it('recommends a reallocation over the ACTUAL performance store', async () => {
    const out = await provider({ actingUserId: OWNER }).executeTool({ name: CAMPAIGN_INTEL_BUDGET_OPTIMIZE_TOOL_ID, input: { orgId: ORG_ID } });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { reallocations: { platform: string; changeAmount: number }[]; projectedRoasGain: number };
    expect(parsed.reallocations.length).toBe(2);
    // Seeded: meta 2000 spend / 2700 revenue (ROAS 1.35), google 2000 / 7800
    // (3.9); shift = min(20% of 4000, 2000) = 800; gain = 800 x (3.9 - 1.35).
    const meta = parsed.reallocations.find((r) => r.platform === 'meta')!;
    const google = parsed.reallocations.find((r) => r.platform === 'google')!;
    expect(meta.changeAmount).toBe(-800); // trimmed from the low-ROAS platform
    expect(google.changeAmount).toBe(800);
    expect(parsed.projectedRoasGain).toBe(2040);
  });

  it('fails closed when the toggle is off (typed, not a throw)', async () => {
    await setToggle('off');
    try {
      const out = await provider({ actingUserId: OWNER }).executeTool({ name: CAMPAIGN_INTEL_BUDGET_OPTIMIZE_TOOL_ID, input: { orgId: ORG_ID } });
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    } finally {
      await setToggle('on');
    }
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
  it('returns per-campaign forecasts from the store (fatigue needs >=4 days; 2 seeded)', async () => {
    const out = await provider({ actingUserId: OWNER }).executeTool({ name: CAMPAIGN_INTEL_FORECAST_TOOL_ID, input: { orgId: ORG_ID } });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { forecasts: { campaignName: string; platform: string; creativeFatigue: { detected: boolean }; projection: { projectedSpend: number; projectedConversions: number } }[] };
    const got = parsed.forecasts
      .map((f) => ({ campaignName: f.campaignName, platform: f.platform, detected: f.creativeFatigue.detected, spend: f.projection.projectedSpend, conv: f.projection.projectedConversions }))
      .sort((a, b) => a.campaignName.localeCompare(b.campaignName));
    // 1000/day x 30; meta 18 conv / 2 days x 30 = 270; google 78 / 2 x 30 = 1170.
    expect(got).toEqual([
      { campaignName: 'A', platform: 'meta', detected: false, spend: 30000, conv: 270 },
      { campaignName: 'B', platform: 'google', detected: false, spend: 30000, conv: 1170 },
    ]);
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
    const parsed = JSON.parse(out.content) as { plan: { verdict: string; platforms: { platform: string; allocationMinor: number }[] } };
    // CPA: meta 2000/18 -> 11111 minor, google 2000/78 -> 2564; ~166 expected
    // conversions vs a target of 100 (ratio ~1.66, far from either band edge).
    expect(parsed.plan.verdict).toBe('feasible');
    expect(parsed.plan.platforms.map((p) => p.platform).sort()).toEqual(['google', 'meta']);
    expect(parsed.plan.platforms.reduce((s, p) => s + p.allocationMinor, 0)).toBe(500000);
    const alloc = (name: string): number => parsed.plan.platforms.find((p) => p.platform === name)!.allocationMinor;
    expect(alloc('google')).toBeGreaterThan(alloc('meta'));
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

/** The header's "EACH tool" claim — authz + fail-empty for the three read
 *  tools the budget-optimize cases above do not cover. 'stranger' is a
 *  SAME-tenant non-member (the provider is pinned to TENANT), so the org
 *  access predicate — not a tenant guard — is what refuses it. */
const OTHER_TOOLS: Array<{ id: string; input: Record<string, unknown>; empty: Record<string, unknown> }> = [
  { id: CAMPAIGN_INTEL_PACING_TOOL_ID, input: {}, empty: { rows: [], unplanned: 0, note: 'No acting user — nothing to read.' } },
  { id: CAMPAIGN_INTEL_ATTRIBUTION_TOOL_ID, input: {}, empty: { rows: [], email: [], unattributedConversions: 0, note: 'No acting user — nothing to read.' } },
  { id: CAMPAIGN_INTEL_PLAN_BUDGET_TOOL_ID, input: { totalBudgetMinor: 500000, targetConversions: 100 }, empty: { plan: null } },
  { id: CAMPAIGN_INTEL_CAPS_TOOL_ID, input: {}, empty: { caps: [] } },
  { id: CAMPAIGN_INTEL_PROPOSE_REALLOCATION_TOOL_ID, input: {}, empty: { outcome: 'no_change', dropped: [] } },
];

describe('ADR 0952 D8 — the Media Buyer tools', () => {
  it('propose-reallocation needs workspace:WRITE (a viewer reads caps but cannot propose), and never changes a budget', async () => {
    await createMember({ orgId: ORG_ID, tenantId: TENANT, displayName: 'V', subject: 'viewer-1', roles: ['viewer'] });
    const caps = await provider({ actingUserId: 'viewer-1' }).executeTool({ name: CAMPAIGN_INTEL_CAPS_TOOL_ID, input: { orgId: ORG_ID } });
    expect(JSON.parse(caps.content)).toEqual({ caps: [] });
    const refused = await provider({ actingUserId: 'viewer-1' }).executeTool({ name: CAMPAIGN_INTEL_PROPOSE_REALLOCATION_TOOL_ID, input: { orgId: ORG_ID } });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content)).toMatchObject({ error: 'forbidden_scope', requiredScope: 'workspace:write' });
    // The owner may propose; with no dispatched campaigns there is nothing to move.
    const owner = await provider({ actingUserId: OWNER }).executeTool({ name: CAMPAIGN_INTEL_PROPOSE_REALLOCATION_TOOL_ID, input: { orgId: ORG_ID } });
    expect(JSON.parse(owner.content)).toEqual({ outcome: 'no_change', dropped: [] });
  });
});

describe('CFP-1 — every read tool shares the authority + fail-empty posture', () => {
  it.each(OTHER_TOOLS)('$id: a same-tenant non-member is forbidden_scope', async ({ id, input }) => {
    const out = await provider({ actingUserId: 'stranger' }).executeTool({ name: id, input: { orgId: ORG_ID, ...input } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'forbidden_scope', requiredScope: 'workspace:read' });
  });

  it.each(OTHER_TOOLS)('$id: no acting user fails EMPTY (no isError)', async ({ id, input, empty }) => {
    const out = await provider().executeTool({ name: id, input: { orgId: ORG_ID, ...input } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject(empty);
  });

  it.each(OTHER_TOOLS)('$id: the org owner reads (positive control for the refusals above)', async ({ id, input }) => {
    const out = await provider({ actingUserId: OWNER }).executeTool({ name: id, input: { orgId: ORG_ID, ...input } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).not.toHaveProperty('error');
  });
});
