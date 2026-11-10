/**
 * CFP-1 — the Campaign Brief Strategist's chat tools (vendor.openwop-app.campaign-brief.agents).
 * Before this the pack allowlisted raw `feature.campaign-brief.nodes.*` typeIds
 * that project into NO conversational tool, so the Strategist resolved zero tools
 * and the flagship kernel + market-intel pipeline had no igniter. These tests
 * boot the REAL app (the ADR 0308 registration seam) and assert: the reads
 * (get-brief, validate) fail EMPTY without an acting user and fail closed on the
 * toggle; the actions (research.run, generate-kernel) fail TYPED and ignite the
 * feature's builtin workflows via the shared run-starter.
 *
 * Wave 30 (grade-tests): the write-scope gate is driven by a real VIEWER member
 * (read but not write) — before, the only "reader" was a stranger refused at the
 * read gate, so the `forbidden` branch was never run. The validate verdict and the
 * ignited workflow id are asserted, not just the presence of a key / a runId.
 * Sabotage-witnessed: dropping the write check, the toggle check, the read gate,
 * the platform pick or the claim release each reds a case here.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  CAMPAIGN_BRIEF_GET_TOOL_ID,
  CAMPAIGN_BRIEF_VALIDATE_TOOL_ID,
  CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID,
  CAMPAIGN_BRIEF_GENERATE_KERNEL_TOOL_ID,
  runResearchRunTool,
  runGenerateKernelTool,
} from '../src/features/campaign-brief/agentTools.js';
import { MARKET_INTEL_WORKFLOW_ID, KERNEL_WORKFLOW_ID } from '../src/features/campaign-brief/intelWorkflows.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { openStorage } from '../src/storage/index.js';
import { claimIgnition, ignitionKey, recordIgnitionRun } from '../src/host/ignitionGuard.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { createBrief, setKernel, updateBrief, validateBrief } from '../src/features/campaign-brief/briefService.js';

/** ADR 1020 — research.run argues an APPROVED, current kernel, so its fixtures carry one. */
const KERNEL = { headline: 'Pick faster', supportingStatement: 'Save hours', proofPoints: ['40%'], primaryCta: 'Demo', secondaryCta: '', tone: 'direct', channelTones: {}, sourceDocIds: [], generatedAt: '2026-10-31T00:00:00Z' };
async function briefWithKernel(name: string): Promise<string> {
  const b = await createBrief(TENANT, orgId, 'u-1', { name, productName: 'Acme' });
  await setKernel(TENANT, b.id, KERNEL);
  return b.id;
}

const TENANT = 'default';
const ALL_IDS = [
  CAMPAIGN_BRIEF_GET_TOOL_ID,
  CAMPAIGN_BRIEF_VALIDATE_TOOL_ID,
  CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID,
  CAMPAIGN_BRIEF_GENERATE_KERNEL_TOOL_ID,
];

let server: http.Server;
let orgId: string;
let briefId: string;

const setToggle = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('campaign-brief');
  if (d) await saveConfig({ ...d, status }, 'test');
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  orgId = org.orgId;
  briefId = await briefWithKernel('Launch Brief');
  // A VIEWER in the brief's org: workspace:read, no workspace:write.
  await createMember({ orgId, tenantId: TENANT, displayName: 'Reader', subject: 'u-reader', roles: ['viewer'] });
  await setToggle('on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function provider(scope: { actingUserId?: string; runId?: string; conversationId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

describe('CFP-1 — campaign-brief agent tools register + allowlist parity', () => {
  it('all four tools register into the builtin surface', () => {
    const ids = builtinAgentToolIds();
    for (const id of ALL_IDS) expect(ids).toContain(id);
  });

  it('the pack allowlist is exactly the four registered tool ids (all offerable)', () => {
    const packDir = new URL('../../../packs/vendor.openwop-app.campaign-brief.agents/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as { agents: { toolAllowlist: string[] }[] };
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual([...ALL_IDS].sort());
    const universe = new Set(builtinAgentToolIds());
    for (const id of manifest.agents[0]!.toolAllowlist) expect(universe.has(id)).toBe(true);
  });
});

describe('CFP-1 — reads: toggle honesty + empty-without-acting-user', () => {
  it('get-brief reads the brief + its validation for the org owner', async () => {
    await setToggle('on');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_GET_TOOL_ID, input: { briefId } });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { brief: { id: string; name: string; messaging?: unknown; status?: string; objective?: unknown } | null; validation: { valid: boolean } };
    expect(parsed.brief?.id).toBe(briefId);
    expect(parsed.validation).toBeTruthy();
    // R2 CB-SP-10 — the projection omitted the sections the tool tells the
    // model to ground in: the human-authored messaging (value prop, proof
    // points), objective and status were invisible to the strategist.
    expect(parsed.brief?.messaging).toBeTruthy();
    expect(parsed.brief?.status).toBeTruthy();
    expect(parsed.brief).toHaveProperty('objective');
  });

  it('get-brief fails closed (typed) when the toggle is OFF', async () => {
    await setToggle('off');
    try {
      const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_GET_TOOL_ID, input: { briefId } });
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    } finally { await setToggle('on'); }
  });

  it('get-brief fails EMPTY (not error) without an acting user', async () => {
    const out = await provider().executeTool({ name: CAMPAIGN_BRIEF_GET_TOOL_ID, input: { briefId } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ brief: null });
    // The no-actor branch answered (the not-found fallback would ALSO be brief:null).
    expect(JSON.parse(out.content).note).toMatch(/No acting user/);
  });

  it('get-brief never reads a brief the caller cannot access (uniform not-found)', async () => {
    const out = await provider({ actingUserId: 'stranger' }).executeTool({ name: CAMPAIGN_BRIEF_GET_TOOL_ID, input: { briefId } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ brief: null });
  });

  it('validate returns the completeness verdict', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_VALIDATE_TOOL_ID, input: { briefId } });
    expect(out.isError).toBeFalsy();
    // The seeded brief has no persona, no value prop and no enabled channel — the
    // REAL verdict names them (the not-found / no-actor branches return issues: []).
    const verdict = JSON.parse(out.content) as { valid: boolean; issues: Array<{ field: string }>; enabledChannels: string[] };
    expect(verdict).toMatchObject({ valid: false, enabledChannels: [] });
    expect(verdict.issues.map((i) => i.field)).toEqual(expect.arrayContaining(['personaIds', 'messaging.primaryValueProp', 'channels']));
  });
});

describe('campaign brief tool monetary grounding', () => {
  async function readBudget(budget?: { totalMinor?: number; currency?: string; perChannel?: { ad_variants?: number; landing_page?: number } }) {
    const brief = await createBrief(TENANT, orgId, 'u-1', { name: 'Money grounding', ...(budget ? { budget } : {}) });
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_GET_TOOL_ID, input: { briefId: brief.id } });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content);
    // Presentation must not reinterpret the durable/raw contract or validation.
    expect(parsed.brief.budget).toEqual(brief.budget ?? null);
    expect(parsed.validation).toEqual(validateBrief(brief));
    return parsed;
  }

  it.each([
    { currency: 'USD', totalMinor: 30000, major: '300.00' },
    { currency: 'JPY', totalMinor: 30000, major: '30000' },
    { currency: 'KWD', totalMinor: 30000, major: '30.000' },
    { currency: 'USD', totalMinor: 0, major: '0.00' },
    { currency: 'KWD', totalMinor: 1, major: '0.001' },
    { currency: 'USD', totalMinor: Number.MAX_SAFE_INTEGER, major: '90071992547409.91' },
  ])('grounds $currency $totalMinor minor as $major major without rounding', async ({ currency, totalMinor, major }) => {
    const parsed = await readBudget({ currency, totalMinor });
    expect(parsed.budgetPresentation).toEqual({ unit: 'major_currency_units', currency, minorUnitExponent: currency === 'JPY' ? 0 : currency === 'KWD' ? 3 : 2, total: { status: 'available', major }, perChannel: {} });
  });

  it('keeps an absent budget absent without inventing money', async () => {
    expect((await readBudget()).budgetPresentation).toBeNull();
  });

  it('presents allocations independently without inventing a missing total or channel', async () => {
    const parsed = await readBudget({ currency: 'KWD', perChannel: { ad_variants: 1234, landing_page: 0 } });
    expect(parsed.budgetPresentation).toEqual({ unit: 'major_currency_units', currency: 'KWD', minorUnitExponent: 3, total: { status: 'unavailable', reason: 'amount_missing' }, perChannel: { ad_variants: { status: 'available', major: '1.234' }, landing_page: { status: 'available', major: '0.000' } } });
  });

  it.each([
    { label: 'absent', budget: { totalMinor: 30000 }, currency: null, reason: 'currency_missing' },
    { label: 'blank', budget: { totalMinor: 30000, currency: '' }, currency: null, reason: 'currency_missing' },
    { label: 'unsupported', budget: { totalMinor: 30000, currency: 'ZZZ' }, currency: 'ZZZ', reason: 'unsupported_currency' },
  ])('refuses to guess the $label currency', async ({ budget, currency, reason }) => {
    const parsed = await readBudget(budget);
    expect(parsed.budgetPresentation).toEqual({ unit: 'major_currency_units', currency, minorUnitExponent: null, total: { status: 'unavailable', reason }, perChannel: {} });
  });

  it('does not claim exact major amounts for unsafe stored integers', async () => {
    const parsed = await readBudget({ currency: 'USD', totalMinor: Number.MAX_SAFE_INTEGER + 1, perChannel: { ad_variants: Number.MAX_SAFE_INTEGER + 1 } });
    expect(parsed.budgetPresentation).toEqual({
      unit: 'major_currency_units', currency: 'USD', minorUnitExponent: 2,
      total: { status: 'unavailable', reason: 'invalid_amount' },
      perChannel: { ad_variants: { status: 'unavailable', reason: 'invalid_amount' } },
    });
  });

  it('never adds presentation to a denied or actorless read', async () => {
    const brief = await createBrief(TENANT, orgId, 'u-1', { name: 'Private money', budget: { currency: 'USD', totalMinor: 30000 } });
    for (const scope of [{ actingUserId: 'stranger' }, {}]) {
      const out = await provider(scope).executeTool({ name: CAMPAIGN_BRIEF_GET_TOOL_ID, input: { briefId: brief.id } });
      expect(JSON.parse(out.content)).toMatchObject({ brief: null });
      expect(JSON.parse(out.content)).not.toHaveProperty('budgetPresentation');
    }
    await setToggle('off');
    try {
      const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_GET_TOOL_ID, input: { briefId: brief.id } });
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
      expect(JSON.parse(out.content)).not.toHaveProperty('budgetPresentation');
    } finally { await setToggle('on'); }
  });
});

describe('CFP-1 — actions: typed gating + real ignition', () => {
  it('research.run requires an acting user (typed)', async () => {
    const out = await provider().executeTool({ name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID, input: { briefId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('research.run fails closed when the toggle is OFF', async () => {
    await setToggle('off');
    try {
      const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID, input: { briefId } });
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    } finally { await setToggle('on'); }
  });

  it('research.run forbids a reader without write scope', async () => {
    // A viewer can READ the brief but lacks workspace:write → typed forbidden.
    const reader = await provider({ actingUserId: 'u-reader' }).executeTool({ name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID, input: { briefId } });
    expect(reader.isError).toBe(true);
    expect(JSON.parse(reader.content)).toMatchObject({ error: 'forbidden' });
    // A stranger has no read either → uniform not_found (no existence leak).
    const out = await provider({ actingUserId: 'stranger' }).executeTool({ name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID, input: { briefId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'not_found' });
  });

  it('research.run ignites the market-intel workflow and returns a runId', async () => {
    const out = await provider({ actingUserId: 'u-1', runId: 'run-x' }).executeTool({
      name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID,
      input: { briefId, platform: 'linkedin' },
    });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { runId: string; platform: string };
    expect(parsed.runId).toBeTruthy();
    expect(parsed.platform).toBe('linkedin');
  });

  it('research.run: an unknown platform is a typed refusal, never a silent meta run (CS70WF-18)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID, input: { briefId, platform: 'myspace' } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'validation_error', validPlatforms: ['meta', 'google', 'linkedin', 'tiktok'] });
  });

  it('research.run: a run for ANOTHER platform on the same brief is a new run, not the reused one (CS70WF-18)', async () => {
    const fresh = { id: await briefWithKernel('Two platforms') };
    const first = JSON.parse((await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID, input: { briefId: fresh.id, platform: 'meta' } })).content) as { runId: string; platform: string };
    const second = JSON.parse((await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID, input: { briefId: fresh.id, platform: 'google' } })).content) as { runId: string; platform: string; ignited?: boolean };
    expect(first.runId).toBeTruthy();
    expect(second.ignited).not.toBe(false);
    expect(second.platform).toBe('google');
    expect(second.runId).not.toBe(first.runId);
  });

  it('research.run refuses before starting when the brief has no approved kernel, or a stale one (ADR 1020)', async () => {
    const none = await createBrief(TENANT, orgId, 'u-1', { name: 'No kernel', productName: 'Acme' });
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID, input: { briefId: none.id } });
    expect(JSON.parse(out.content)).toMatchObject({ error: 'kernel_required' });
    const stale = await briefWithKernel('Stale kernel');
    await updateBrief(TENANT, stale, { productName: 'Changed' });
    const out2 = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID, input: { briefId: stale } });
    expect(JSON.parse(out2.content)).toMatchObject({ error: 'kernel_stale' });
  });

  it('research.run accepts a platform in any case (Meta → meta)', async () => {
    const id = await briefWithKernel('Case');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID, input: { briefId: id, platform: 'Meta' } });
    expect(JSON.parse(out.content)).toMatchObject({ platform: 'meta' });
  });

  it('generate-kernel ignites the messaging-kernel workflow and returns a runId', async () => {
    const out = await provider({ actingUserId: 'u-1', runId: 'run-y' }).executeTool({
      name: CAMPAIGN_BRIEF_GENERATE_KERNEL_TOOL_ID,
      input: { briefId },
    });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toHaveProperty('runId');
  });

  it('generate-kernel validates its input (missing briefId → typed error)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_GENERATE_KERNEL_TOOL_ID, input: {} });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'validation_error' });
  });

  // CFPT-2 — when startWorkflowRun fails to dispatch, the igniter must RELEASE the
  // ignition claim it took, so an honest retry inside the window is not blocked by
  // a latch guarding a run that never started. Driven directly with a deps whose
  // workflowCatalog resolves NOTHING (→ startWorkflowRun returns null).
  it('research.run releases the ignition claim on a dispatch failure', async () => {
    await setToggle('on');
    // A FRESH brief so its ignition key is un-claimed (the "ignites" test above
    // already latched the shared briefId's key inside the window).
    const fresh = { id: await briefWithKernel('Retry Brief') };
    const requested: string[] = [];
    const failingDeps: StartRunDeps = {
      storage: await openStorage('memory://'),
      hostSuite: {
        workflowCatalog: { getWorkflow: async (id: string) => { requested.push(id); return null; } },
        providerPolicyResolver: { resolveForRun: async () => [] },
      },
    };
    const out = await runResearchRunTool(failingDeps, { briefId: fresh.id, platform: 'linkedin' }, { tenantId: TENANT, actingUserId: 'u-1' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'dispatch_failed' });
    // The claim was released: an honest retry re-claims immediately (would be
    // refused if the failed dispatch had left the latch behind).
    const key = ignitionKey('campaign-brief.research.run', fresh.id, 'linkedin'); // ADR 1020: the key names the platform
    expect((await claimIgnition(TENANT, key)).claimed).toBe(true);
    // research.run asked the run-starter for the MARKET-INTEL workflow, not another.
    expect(requested).toContain(MARKET_INTEL_WORKFLOW_ID);
    expect(requested).not.toContain(KERNEL_WORKFLOW_ID);
  });

  it('generate-kernel asks the run-starter for the messaging-kernel workflow (and releases on failure)', async () => {
    await setToggle('on');
    const fresh = await createBrief(TENANT, orgId, 'u-1', { name: 'Kernel Brief', productName: 'Acme' });
    const requested: string[] = [];
    const deps: StartRunDeps = {
      storage: await openStorage('memory://'),
      hostSuite: {
        workflowCatalog: { getWorkflow: async (id: string) => { requested.push(id); return null; } },
        providerPolicyResolver: { resolveForRun: async () => [] },
      },
    };
    const out = await runGenerateKernelTool(deps, { briefId: fresh.id }, { tenantId: TENANT, actingUserId: 'u-1' });
    expect(JSON.parse(out.content)).toMatchObject({ error: 'dispatch_failed' });
    expect(requested).toContain(KERNEL_WORKFLOW_ID);
    expect(requested).not.toContain(MARKET_INTEL_WORKFLOW_ID);
  });

  it('generate-kernel after a REJECTED (finished) run starts a new one instead of reusing it (grade-ux H2)', async () => {
    await setToggle('on');
    const fresh = await createBrief(TENANT, orgId, 'u-1', { name: 'Regenerate Brief', productName: 'Acme' });
    const storage = await openStorage('memory://');
    const now = new Date().toISOString();
    // The rejected kernel run still holds the 5-minute ignition claim.
    await storage.insertRun({ runId: 'run-rejected-kernel', workflowId: KERNEL_WORKFLOW_ID, tenantId: TENANT, status: 'failed', inputs: { briefId: fresh.id }, metadata: {}, configurable: {}, createdAt: now, updatedAt: now });
    const key = ignitionKey('campaign-brief.generate-kernel', fresh.id);
    expect((await claimIgnition(TENANT, key)).claimed).toBe(true);
    await recordIgnitionRun(TENANT, key, 'run-rejected-kernel');
    const requested: string[] = [];
    const deps: StartRunDeps = {
      storage,
      hostSuite: {
        workflowCatalog: { getWorkflow: async (id: string) => { requested.push(id); return null; } },
        providerPolicyResolver: { resolveForRun: async () => [] },
      },
    };
    const out = await runGenerateKernelTool(deps, { briefId: fresh.id }, { tenantId: TENANT, actingUserId: 'u-1' });
    // It tried to start a NEW run (the stand-in catalog then fails it), rather than
    // answering "reusing it" with the rejected run.
    expect(JSON.parse(out.content)).not.toMatchObject({ runId: 'run-rejected-kernel' });
    expect(requested).toContain(KERNEL_WORKFLOW_ID);
  });

  // DATA-4 — the release must also happen when startWorkflowRun THROWS, not only
  // when it returns null. A throwing catalog stands in for a dispatch that blows up.
  it('research.run releases the ignition claim when dispatch THROWS', async () => {
    await setToggle('on');
    const fresh = { id: await briefWithKernel('Throw Brief') };
    const throwingDeps: StartRunDeps = {
      storage: await openStorage('memory://'),
      hostSuite: {
        workflowCatalog: { getWorkflow: async () => { throw new Error('catalog exploded'); } },
        providerPolicyResolver: { resolveForRun: async () => [] },
      },
    };
    const out = await runResearchRunTool(throwingDeps, { briefId: fresh.id, platform: 'linkedin' }, { tenantId: TENANT, actingUserId: 'u-1' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'dispatch_failed' });
    const key = ignitionKey('campaign-brief.research.run', fresh.id, 'linkedin'); // ADR 1020: the key names the platform
    expect((await claimIgnition(TENANT, key)).claimed).toBe(true);
  });
});
