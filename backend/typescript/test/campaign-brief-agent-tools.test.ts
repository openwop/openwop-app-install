/**
 * CFP-1 — the Campaign Brief Strategist's chat tools (feature.campaign-brief.agents).
 * Before this the pack allowlisted raw `feature.campaign-brief.nodes.*` typeIds
 * that project into NO conversational tool, so the Strategist resolved zero tools
 * and the flagship kernel + market-intel pipeline had no igniter. These tests
 * boot the REAL app (the ADR 0308 registration seam) and assert: the reads
 * (get-brief, validate) fail EMPTY without an acting user and fail closed on the
 * toggle; the actions (research.run, generate-kernel) fail TYPED and ignite the
 * feature's builtin workflows via the shared run-starter.
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
} from '../src/features/campaign-brief/agentTools.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { openStorage } from '../src/storage/index.js';
import { claimIgnition, ignitionKey } from '../src/host/ignitionGuard.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';

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
  const brief = await createBrief(TENANT, orgId, 'u-1', { name: 'Launch Brief', productName: 'Acme' } as never);
  briefId = brief.id;
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
    const packDir = new URL('../../../packs/feature.campaign-brief.agents/', import.meta.url);
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
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_GET_TOOL_ID, input: { briefId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setToggle('on');
  });

  it('get-brief fails EMPTY (not error) without an acting user', async () => {
    const out = await provider().executeTool({ name: CAMPAIGN_BRIEF_GET_TOOL_ID, input: { briefId } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ brief: null });
  });

  it('get-brief never reads a brief the caller cannot access (uniform not-found)', async () => {
    const out = await provider({ actingUserId: 'stranger' }).executeTool({ name: CAMPAIGN_BRIEF_GET_TOOL_ID, input: { briefId } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ brief: null });
  });

  it('validate returns the completeness verdict', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_VALIDATE_TOOL_ID, input: { briefId } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toHaveProperty('enabledChannels');
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
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID, input: { briefId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setToggle('on');
  });

  it('research.run forbids a reader without write scope', async () => {
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
    const fresh = await createBrief(TENANT, orgId, 'u-1', { name: 'Retry Brief', productName: 'Acme' } as never);
    const failingDeps: StartRunDeps = {
      storage: await openStorage('memory://'),
      hostSuite: {
        workflowCatalog: { getWorkflow: async () => null },
        providerPolicyResolver: { resolveForRun: async () => [] },
      },
    };
    const out = await runResearchRunTool(failingDeps, { briefId: fresh.id, platform: 'linkedin' }, { tenantId: TENANT, actingUserId: 'u-1' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'dispatch_failed' });
    // The claim was released: an honest retry re-claims immediately (would be
    // refused if the failed dispatch had left the latch behind).
    const key = ignitionKey('campaign-brief.research.run', fresh.id);
    expect((await claimIgnition(TENANT, key)).claimed).toBe(true);
  });

  // DATA-4 — the release must also happen when startWorkflowRun THROWS, not only
  // when it returns null. A throwing catalog stands in for a dispatch that blows up.
  it('research.run releases the ignition claim when dispatch THROWS', async () => {
    await setToggle('on');
    const fresh = await createBrief(TENANT, orgId, 'u-1', { name: 'Throw Brief', productName: 'Acme' } as never);
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
    const key = ignitionKey('campaign-brief.research.run', fresh.id);
    expect((await claimIgnition(TENANT, key)).claimed).toBe(true);
  });
});
