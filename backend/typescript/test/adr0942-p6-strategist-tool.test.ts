/**
 * ADR 0942 P6 — the Strategist's `get-autonomy` read tool.
 *
 *   - it projects the SAME read model the GET route and the panel serve
 *     (`describePolicy`), through the SAME access predicate (`autonomyAccess.ts`);
 *   - it fails EMPTY without an acting human, with either toggle off, for a
 *     same-tenant non-member, and for a missing campaign;
 *   - the shared predicate's two caller arms are both witnessed: a subject who is
 *     not a member reads nothing; the tenant's own principal (the route's
 *     no-user request) reads it;
 *   - `ALWAYS_APPLIES` covers every layer rule id the resolver raises, so a new
 *     floor cannot reach a run without the model being told it applies;
 *   - the pack allowlists it, and no tool in the allowlist can write a policy.
 *
 * What turns it red: dropping any guard in `runAutonomyTool`, widening the access
 * union to an optional subject (the stranger case), re-deriving the projection
 * instead of reading `describePolicy`, or a new `raise(…)` layer in resolve.ts
 * without a line in explain.ts.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import {
  CAMPAIGN_ORCH_AUTONOMY_TOOL_ID, CAMPAIGN_ORCH_GET_TOOL_ID, CAMPAIGN_ORCH_RUN_TOOL_ID, CAMPAIGN_ORCH_STATUS_TOOL_ID,
} from '../src/features/campaign-orchestration/agentTools.js';
import { readableCampaign } from '../src/features/campaign-orchestration/autonomyAccess.js';
import { ALWAYS_APPLIES, AUTONOMY_TOGGLE, describePolicy, projectPolicyForModel } from '../src/host/autonomyPolicy/index.js';

const TENANT = 'default';
let server: http.Server;
let orgId: string;
let campaignId: string;

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status }, 'test');
};
async function withToggleOff(id: string, fn: () => Promise<void>): Promise<void> {
  await setToggle(id, 'off');
  try { await fn(); } finally { await setToggle(id, 'on'); }
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  orgId = (await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' })).orgId;
  const brief = await createBrief(TENANT, orgId, 'u-1', { name: 'Launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  campaignId = (await finalizeFromBrief(TENANT, brief, 'u-1')).id;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => {
  await setToggle('campaign-orchestration', 'on');
  await setToggle(AUTONOMY_TOGGLE, 'on');
});

const exec = (input: Record<string, unknown>, scope: { actingUserId?: string } = {}) =>
  createAgentToolProvider({ tenantId: TENANT, ...scope }).executeTool({ name: CAMPAIGN_ORCH_AUTONOMY_TOOL_ID, input });
const EMPTY = { autonomy: null };

describe('ADR 0942 P6 — get-autonomy (read)', () => {
  it('projects the same read model the route serves, for a member', async () => {
    const out = await exec({ campaignId }, { actingUserId: 'u-1' });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { autonomy: { steps: Array<{ step: string; stage?: string; outcome: string }> } };
    const expected = projectPolicyForModel(campaignId, await describePolicy(TENANT, orgId, campaignId));
    expect(parsed.autonomy).toEqual(JSON.parse(JSON.stringify(expected)));
    // One step per class, and one per review stage.
    expect(parsed.autonomy.steps.filter((s) => s.step === 'creative.review').map((s) => s.stage)).toEqual(['internal', 'compliance', 'client']);
  });

  it('fails EMPTY without an acting human', async () => {
    expect(JSON.parse((await exec({ campaignId }, {})).content)).toEqual(EMPTY);
  });

  it.each(['campaign-orchestration', AUTONOMY_TOGGLE])('fails EMPTY with %s off', async (toggle) => {
    await withToggleOff(toggle, async () => {
      expect(JSON.parse((await exec({ campaignId }, { actingUserId: 'u-1' })).content)).toEqual(EMPTY);
    });
  });

  it('fails EMPTY for a same-tenant non-member and for a missing campaign', async () => {
    expect(JSON.parse((await exec({ campaignId }, { actingUserId: 'u-2' })).content)).toEqual(EMPTY);
    expect(JSON.parse((await exec({ campaignId: 'no-such-campaign' }, { actingUserId: 'u-1' })).content)).toEqual(EMPTY);
  });

  it('the shared predicate: a non-member subject reads nothing; the tenant principal reads it', async () => {
    expect(await readableCampaign(TENANT, { subject: 'u-2' }, campaignId)).toBeNull();
    expect((await readableCampaign(TENANT, { subject: 'u-1' }, campaignId))?.id).toBe(campaignId);
    expect((await readableCampaign(TENANT, { tenantPrincipal: true }, campaignId))?.id).toBe(campaignId);
  });
});

describe('ADR 0942 P6 — what the model is told', () => {
  it('ALWAYS_APPLIES covers every layer rule id the resolver raises', () => {
    const src = readFileSync(new URL('../src/host/autonomyPolicy/resolve.ts', import.meta.url), 'utf8');
    const raised = new Set([...src.matchAll(/raise\([^;]*'((?:floor|ceiling|agent|live):[a-z-]+)'\)/g)].map((m) => m[1]!));
    expect(raised.size).toBeGreaterThan(5);
    for (const id of raised) expect(ALWAYS_APPLIES[id], id).toBeTruthy();
  });

  it('the Strategist allowlists the read tool, and nothing in its allowlist writes a policy or approves', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../packs/vendor.openwop-app.campaign-orchestration.agents/pack.json', import.meta.url), 'utf8')) as {
      agents: Array<{ toolAllowlist: string[] }>;
    };
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual([CAMPAIGN_ORCH_AUTONOMY_TOOL_ID, CAMPAIGN_ORCH_GET_TOOL_ID, CAMPAIGN_ORCH_RUN_TOOL_ID, CAMPAIGN_ORCH_STATUS_TOOL_ID].sort());
    for (const id of manifest.agents[0]!.toolAllowlist) expect(id).not.toMatch(/autonomy\.(set|put|loosen)|approve|policy\.(set|save)/);
  });
});
