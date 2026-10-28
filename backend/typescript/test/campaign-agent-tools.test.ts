/**
 * CFP-1 regression pin (CHAT-FIRST-PORT-AUDIT #1, E3 campaign cluster) — the
 * Campaign Strategist + Channel Generator resolve REAL tools at dispatch.
 *
 * Before this fix both packs allowlisted node typeIds that no provider
 * registers, so `compileAgentTools` dropped every one and the personas could
 * call nothing. This test boots the REAL app (the ADR 0308 D2 registration seam
 * is what's under test) and asserts:
 *   - both packs' allowlists are EXACTLY the registered tool ids (no phantom
 *     node ids left), and every entry is in `builtinAgentToolIds()` — the
 *     resolved surface the dispatch lanes intersect against;
 *   - the read tools ground (readiness/catalog), fail EMPTY without an acting
 *     human, and honor the per-tenant toggle;
 *   - the run/generate tools ignite the registered workflow, fail TYPED without
 *     an acting human / with the toggle off / on bad input, and share the
 *     brief's org-scope predicate (a same-tenant non-member `u-2` gets EMPTY
 *     reads and a typed `forbidden` on the actions).
 *
 * Both toggles DEFAULT OFF, so every case starts from both ON (`beforeEach`)
 * and a toggle-off case restores in `finally` (wave 30: two cases passed only
 * because an earlier case had turned the toggle on, and the "fails EMPTY
 * without an acting human" cases would have passed for the toggle reason on
 * another order).
 *
 * The "ids are in builtinAgentToolIds()" claim is owned by the CFP-1 tripwire
 * `agent-allowlist-resolution.test.ts` (wave 30 cut the duplicate case here:
 * un-registering the tools reds both files).
 *
 * Sabotage witnesses (wave 30): each tool's acting-user guard, toggle check,
 * org-scope predicate (`hasOrgScope` → true), not-found, channel validation,
 * workflow id, and the pack allowlist reds its named case.
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
import {
  CAMPAIGN_ORCH_STATUS_TOOL_ID,
  CAMPAIGN_ORCH_GET_TOOL_ID,
  CAMPAIGN_ORCH_RUN_TOOL_ID,
  CAMPAIGN_ORCH_AUTONOMY_TOOL_ID,
} from '../src/features/campaign-orchestration/agentTools.js';
import {
  CAMPAIGN_CHANNELS_LIST_TOOL_ID,
  CAMPAIGN_CHANNELS_GENERATE_TOOL_ID,
} from '../src/features/campaign-channels/agentTools.js';

const TENANT = 'default';
let server: http.Server;
let orgId: string;
let briefId: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  orgId = org.orgId;
  const brief = await createBrief(TENANT, orgId, 'u-1', {
    name: 'Launch',
    channels: [{ type: 'email_sequence', enabled: true, config: {} }],
  });
  briefId = brief.id;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
};
beforeEach(async () => {
  await setToggle('campaign-orchestration', 'on');
  await setToggle('campaign-channels', 'on');
});

/** Run `fn` with one toggle OFF, restoring it even if an assertion throws. */
async function withToggleOff(id: string, fn: () => Promise<void>): Promise<void> {
  await setToggle(id, 'off');
  try { await fn(); } finally { await setToggle(id, 'on'); }
}

const provider = (scope: { actingUserId?: string } = {}) => createAgentToolProvider({ tenantId: TENANT, ...scope });
const exec = (name: string, input: Record<string, unknown>, scope: { actingUserId?: string } = {}) =>
  provider(scope).executeTool({ name, input });

describe('CFP-1 — the campaign packs allowlist EXACTLY the registered tool ids', () => {
  const readAllowlist = (dir: string): string[] => {
    const manifest = JSON.parse(readFileSync(new URL(`../../../packs/${dir}/pack.json`, import.meta.url), 'utf8')) as {
      agents: { toolAllowlist: string[] }[];
    };
    return [...manifest.agents[0]!.toolAllowlist].sort();
  };

  it('the strategist allowlist is exactly [status, get-campaign, get-autonomy, run]', () => {
    expect(readAllowlist('vendor.openwop-app.campaign-orchestration.agents')).toEqual(
      [CAMPAIGN_ORCH_STATUS_TOOL_ID, CAMPAIGN_ORCH_GET_TOOL_ID, CAMPAIGN_ORCH_AUTONOMY_TOOL_ID, CAMPAIGN_ORCH_RUN_TOOL_ID].sort(),
    );
  });
  it('the generator allowlist is exactly [channels, generate]', () => {
    expect(readAllowlist('vendor.openwop-app.campaign-channels.agents')).toEqual(
      [CAMPAIGN_CHANNELS_LIST_TOOL_ID, CAMPAIGN_CHANNELS_GENERATE_TOOL_ID].sort(),
    );
  });
});

describe('campaign-orchestration.status (read)', () => {
  it('grounds brief readiness for an acting human', async () => {
    const out = await exec(CAMPAIGN_ORCH_STATUS_TOOL_ID, { briefId }, { actingUserId: 'u-1' });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { brief: { hasKernel: boolean; enabledChannels: string[]; setup: { ready: boolean } } };
    expect(parsed.brief.hasKernel).toBe(false);
    expect(parsed.brief.enabledChannels).toContain('email_sequence');
    expect(parsed.brief.setup.ready).toBe(false); // no brand/persona/kb bound
  });
  it('fails EMPTY without an acting human', async () => {
    // Toggle is ON (beforeEach) — the empty answer is the acting-user guard's.
    const out = await exec(CAMPAIGN_ORCH_STATUS_TOOL_ID, { briefId }, {});
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ campaigns: [], brief: null });
  });
  it('fails EMPTY when the toggle is off', async () => {
    await withToggleOff('campaign-orchestration', async () => {
      const out = await exec(CAMPAIGN_ORCH_STATUS_TOOL_ID, { briefId }, { actingUserId: 'u-1' });
      expect(JSON.parse(out.content)).toEqual({ campaigns: [], brief: null });
    });
  });
  it('org-scope: a same-tenant non-member reads EMPTY (the brief is never projected)', async () => {
    const out = await exec(CAMPAIGN_ORCH_STATUS_TOOL_ID, { briefId }, { actingUserId: 'u-2' });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ campaigns: [], brief: null });
  });
});

describe('campaign-orchestration.run (action)', () => {
  it('ignites the orchestration workflow for an authorized human', async () => {
    const out = await exec(CAMPAIGN_ORCH_RUN_TOOL_ID, { briefId }, { actingUserId: 'u-1' });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { runId: string; workflowId: string };
    expect(parsed.runId).toBeTruthy();
    expect(parsed.workflowId).toBe('campaign-studio.campaign-orchestration');
  });
  it('fails TYPED without an acting human', async () => {
    const out = await exec(CAMPAIGN_ORCH_RUN_TOOL_ID, { briefId }, {});
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });
  it('fails TYPED when the toggle is off', async () => {
    await withToggleOff('campaign-orchestration', async () => {
      const out = await exec(CAMPAIGN_ORCH_RUN_TOOL_ID, { briefId }, { actingUserId: 'u-1' });
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    });
  });
  it('org-scope: a same-tenant non-member is refused with a typed forbidden (no run)', async () => {
    const out = await exec(CAMPAIGN_ORCH_RUN_TOOL_ID, { briefId }, { actingUserId: 'u-2' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'forbidden' });
  });
  it('fails TYPED for an unknown brief', async () => {
    const out = await exec(CAMPAIGN_ORCH_RUN_TOOL_ID, { briefId: 'missing' }, { actingUserId: 'u-1' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'not_found' });
  });
});

describe('campaign-channels.channels (read)', () => {
  it('lists the five channels + brief readiness for an acting human', async () => {
    const out = await exec(CAMPAIGN_CHANNELS_LIST_TOOL_ID, { briefId }, { actingUserId: 'u-1' });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { channels: { channel: string; workflowId: string }[]; brief: { hasKernel: boolean } };
    expect(parsed.channels.map((c) => c.channel).sort()).toEqual(
      ['ad_variants', 'creative_briefs', 'email_sequence', 'landing_page', 'social_posts'],
    );
    expect(parsed.channels.find((c) => c.channel === 'email_sequence')?.workflowId).toBe('campaign-studio.channel.email-sequence');
    expect(parsed.brief.hasKernel).toBe(false);
  });
  it('fails EMPTY without an acting human', async () => {
    // Toggle is ON (beforeEach) — the empty answer is the acting-user guard's.
    const out = await exec(CAMPAIGN_CHANNELS_LIST_TOOL_ID, { briefId }, {});
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ channels: [] });
  });
  it('org-scope: a same-tenant non-member gets the static catalog but NO brief readiness', async () => {
    const out = await exec(CAMPAIGN_CHANNELS_LIST_TOOL_ID, { briefId }, { actingUserId: 'u-2' });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { channels: unknown[]; brief: unknown };
    expect(parsed.channels).toHaveLength(5);
    expect(parsed.brief).toBeNull();
  });
});

describe('campaign-channels.generate (action)', () => {
  it('ignites the channel workflow for an authorized human', async () => {
    const out = await exec(CAMPAIGN_CHANNELS_GENERATE_TOOL_ID, { briefId, channel: 'email_sequence' }, { actingUserId: 'u-1' });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { runId: string; channel: string; workflowId: string };
    expect(parsed.runId).toBeTruthy();
    expect(parsed.channel).toBe('email_sequence');
    expect(parsed.workflowId).toBe('campaign-studio.channel.email-sequence');
  });
  it('rejects an invalid channel with a typed error listing the valid set', async () => {
    const out = await exec(CAMPAIGN_CHANNELS_GENERATE_TOOL_ID, { briefId, channel: 'billboard' }, { actingUserId: 'u-1' });
    expect(out.isError).toBe(true);
    const parsed = JSON.parse(out.content) as { error: string; validChannels: string[] };
    expect(parsed.error).toBe('validation_error');
    expect(parsed.validChannels).toContain('landing_page');
  });
  it('fails TYPED when the toggle is off', async () => {
    await withToggleOff('campaign-channels', async () => {
      const out = await exec(CAMPAIGN_CHANNELS_GENERATE_TOOL_ID, { briefId, channel: 'email_sequence' }, { actingUserId: 'u-1' });
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    });
  });
  it('org-scope: a same-tenant non-member is refused with a typed forbidden (no channel run)', async () => {
    const out = await exec(CAMPAIGN_CHANNELS_GENERATE_TOOL_ID, { briefId, channel: 'social_posts' }, { actingUserId: 'u-2' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'forbidden' });
  });
});
