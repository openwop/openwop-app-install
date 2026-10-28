/**
 * ADR 0962 P0 — an external agent can never satisfy a campaign gate (D4.1 as
 * corrected, D4.2) and the A2A side door is closed for campaign agents (D8).
 *
 *   - RATCHETS (real chain loader): every approval-gate node in a campaign chain is
 *     the 0942 autonomy gate or one of the identity-pinned OPEN gates (shrink-only:
 *     a new open gate is a reviewed diff); every chain in a campaign pack has a
 *     `campaign-` id and no other chain does (the provenance key the MCP guard reads).
 *   - PARITY: the guard's plain metadata keys equal the features' exported keys.
 *   - THE PREDICATE: tag, client stamp, chain provenance and a campaign ancestor are
 *     each campaign runs; a plain run is not; a missing ancestor fails closed.
 *   - MCP ROUND TRIP (route, `tools/call` + `inputResponses`): a campaign gate's
 *     retry is refused and the gate stays open; the SAME workflow without campaign
 *     provenance still resolves (positive control: the refusal is the guard's).
 *   - A2A: the 0.3 card lists no campaign agent; `message/send` to one is refused on
 *     both lanes exactly as an unknown agent is; a non-campaign pack agent is still
 *     listed (positive control).
 *
 * What turns it red: dropping the `isCampaignRun` check in `resumeInterrupt` (the
 * round trip resolves), any one predicate arm, a renamed metadata key, a new open
 * gate or a non-`campaign-` chain id in a campaign pack, `a2aExposed:false` left off
 * a campaign agent, or the card and router reading different lists.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { MCP_CURRENT_VERSION, MCP_META_CLIENT_CAPABILITIES, MCP_META_PROTOCOL_VERSION } from '../src/host/mcpProfile.js';
import { _resetChainRegistryForTest, listChains, loadWorkflowChainPacks } from '../src/host/workflowChainPackLoader.js';
import { APPROVAL_GATE_TYPE_IDS } from '../src/host/approvalGateTypeIds.js';
import {
  CAMPAIGN_CHAIN_ID_PREFIX, CAMPAIGN_CLIENT_STAMP_METADATA_KEY, CAMPAIGN_RUN_TAG_METADATA_KEY, isCampaignRun, isApprovalGate,
} from '../src/host/campaignRunGuard.js';
import { CAMPAIGN_RUN_TAG_KEY } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { CAMPAIGN_OPS_RUN_STAMP } from '../src/features/campaign-ops/surface.js';
import { buildA2aCard03, isA2aDispatchable } from '../src/host/a2aCard.js';
import { handleA2aRequest } from '../src/host/a2aServer.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import type { RunRecord } from '../src/types.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CAMPAIGN_PACK_PREFIX = 'core.openwop.workflows.campaign-';
const AUTONOMY_GATE = 'feature.campaign-orchestration.nodes.autonomy-gate';

/** Open (ACL-less) gates on campaign chains, pinned BY IDENTITY. Shrink-only: ACLs
 *  land here once P1's client stamping makes role refs resolvable (D4.1b). Until
 *  then the MCP guard is what keeps an external agent off them.
 *
 *  The three ADR 0955 P5 journey blueprints (abandoned-signup, post-webinar,
 *  welcome-email-sms) add a `#signoff` of the SAME kind as welcome-series and
 *  re-engage-contact: a per-contact human sign-off before the first send, on a run
 *  usually started outside a campaign (no `approverOrgId`, so a role ACL would
 *  resolve to nobody). They are NOT routed through the 0942 autonomy gate: under an
 *  `auto` policy that gate would let a journey start sending with no human at all,
 *  which is a behaviour change, not a repair. ADR 0962 § D4.1 correction 2026-10-25. */
const OPEN_GATES = [
  'campaign-journeys.abandoned-signup#signoff',
  'campaign-journeys.post-webinar#signoff',
  'campaign-journeys.re-engage-contact#signoff',
  'campaign-journeys.welcome-email-sms#signoff',
  'campaign-journeys.welcome-series#signoff',
  'campaign-studio.channel.ad-variants#approve',
  'campaign-studio.channel.creative-briefs#approve',
  'campaign-studio.channel.email-sequence#approve',
  'campaign-studio.channel.landing-page#approve',
  'campaign-studio.channel.social-posts#approve',
  'campaign-studio.market-intel#approve',
  'campaign-studio.messaging-kernel#approve',
];

const bare = (typeId: string): string => typeId.replace(/@.*$/, '');

describe('ADR 0962 D4.1 — ratchets over the real chain loader', () => {
  let chains: Array<{ packName: string; chainId: string; nodes: Array<{ id: string; typeId: string; config: Record<string, unknown> }> }>;
  beforeAll(() => {
    _resetChainRegistryForTest();
    const out = loadWorkflowChainPacks({ roots: [join(REPO, 'examples', 'workflow-chain-packs')] });
    expect(out.errors.filter((e) => e.pack.includes('campaign'))).toEqual([]);
    chains = listChains().map((c) => ({
      packName: c.packName, chainId: c.chain.chainId,
      nodes: c.chain.dag.nodes.map((n) => ({ id: n.id, typeId: bare(n.typeId), config: (n.config ?? {}) as Record<string, unknown> })),
    }));
  });

  it('every gate in a campaign chain is the autonomy gate or a pinned open gate', () => {
    const campaign = chains.filter((c) => c.packName.startsWith(CAMPAIGN_PACK_PREFIX));
    expect(campaign.length).toBeGreaterThanOrEqual(10);
    const open: string[] = [];
    let autonomyGates = 0;
    for (const c of campaign) {
      for (const n of c.nodes) {
        if (n.typeId === AUTONOMY_GATE) { autonomyGates += 1; continue; }
        if (!APPROVAL_GATE_TYPE_IDS.has(n.typeId)) continue;
        const acl = ['approverRefs', 'approverGroupRefs', 'approverRoleRefs'].some((k) => Array.isArray(n.config[k]) && (n.config[k] as unknown[]).length > 0);
        if (!acl) open.push(`${c.chainId}#${n.id}`);
      }
    }
    expect(autonomyGates).toBeGreaterThanOrEqual(1);
    expect(open.sort()).toEqual(OPEN_GATES);
  });

  it('campaign chains, and only campaign chains, have a `campaign-` id (the guard\'s provenance key)', () => {
    for (const c of chains) {
      expect(c.chainId.startsWith(CAMPAIGN_CHAIN_ID_PREFIX), `${c.packName} → ${c.chainId}`).toBe(c.packName.startsWith(CAMPAIGN_PACK_PREFIX));
    }
  });

  it('the guard\'s metadata keys are the features\' keys', () => {
    expect(CAMPAIGN_RUN_TAG_METADATA_KEY).toBe(CAMPAIGN_RUN_TAG_KEY);
    expect(CAMPAIGN_CLIENT_STAMP_METADATA_KEY).toBe(CAMPAIGN_OPS_RUN_STAMP);
  });
});

describe('ADR 0962 D4.1 — isCampaignRun', () => {
  const runs = new Map<string, RunRecord>();
  const defs = new Map<string, WorkflowDefinition>();
  const run = (runId: string, workflowId: string, metadata: Record<string, unknown> = {}, parentRunId?: string): void => {
    const now = new Date().toISOString();
    const r: RunRecord = { runId, workflowId, tenantId: 't', status: 'waiting-approval', inputs: {}, configurable: {}, createdAt: now, updatedAt: now, metadata, ...(parentRunId ? { parentRunId } : {}) };
    runs.set(runId, r);
  };
  const def = (workflowId: string, chainId?: string): void => {
    defs.set(workflowId, { workflowId, nodes: [], edges: [], ...(chainId ? { metadata: { chainId } } : {}) } as WorkflowDefinition);
  };
  const storage = { getRun: async (id: string) => runs.get(id) ?? null };
  const suite = { workflowCatalog: { getWorkflow: async (id: string) => (defs.has(id) ? { workflowId: id, definition: defs.get(id)! } : null) } };
  const is = (id: string): Promise<boolean> => isCampaignRun(storage, suite, id);

  beforeAll(() => {
    def('plain'); def('chained', 'campaign-studio.channel.landing-page'); def('other-chain', 'notebooks.digest');
    run('plain', 'plain');
    run('tagged', 'plain', { [CAMPAIGN_RUN_TAG_METADATA_KEY]: { campaignId: 'c', orgId: 'o' } });
    run('stamped', 'plain', { [CAMPAIGN_CLIENT_STAMP_METADATA_KEY]: { orgId: 'o' } });
    run('provenance', 'chained');
    run('non-campaign-chain', 'other-chain');
    run('child', 'plain', {}, 'tagged');
    run('orphan', 'plain', {}, 'gone');
  });

  it.each(['tagged', 'stamped', 'provenance', 'child'])('%s is a campaign run', async (id) => {
    expect(await is(id)).toBe(true);
  });
  it('a plain run and a non-campaign chain run are not', async () => {
    expect(await is('plain')).toBe(false);
    expect(await is('non-campaign-chain')).toBe(false);
  });
  it('unavailable definitions, missing runs and malformed campaign provenance fail closed', async () => {
    run('unknown-definition', 'not-installed');
    run('malformed-provenance', 'plain', { [CAMPAIGN_RUN_TAG_METADATA_KEY]: 'unreadable' });
    expect(await is('unknown-definition')).toBe(true);
    expect(await is('missing-run')).toBe(true);
    expect(await is('malformed-provenance')).toBe(true);
    expect(await isApprovalGate(storage, suite, { runId: 'unknown-definition', nodeId: 'unknown', kind: 'clarification' })).toBe(true);
  });

  it('an external-event wait for an actual spend approval is a gate too', async () => {
    expect(await isApprovalGate(storage, suite, { runId: 'tagged', nodeId: 'publish', kind: 'external-event', data: { key: 'approval:real-approval-id' } })).toBe(true);
  });

  it('a missing ancestor fails closed', async () => {
    expect(await is('orphan')).toBe(true);
  });
});

describe('ADR 0962 D4.1 / D4.2 — over the MCP mount, an external agent cannot satisfy a campaign gate', () => {
  let BASE = '';
  let server: http.Server;
  let cookie = '';
  let rpcId = 0;
  const STAMP = Date.now();
  const CAMPAIGN_TOOL = `campaign_gate_probe_${STAMP}`;
  const PLAIN_TOOL = `plain_gate_probe_${STAMP}`;
  const CHAT_GATE_TOOL = `campaign_chat_gate_probe_${STAMP}`;

  async function register(workflowId: string, tool: string, chainId?: string, gateTypeId = 'core.approvalGate'): Promise<void> {
    const res = await fetch(`${BASE}/host/openwop-app/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({
        workflowId,
        ...(chainId ? { metadata: { chainId } } : {}),
        nodes: [
          { nodeId: 'expose', typeId: 'core.openwop.mcp.expose-tool', config: { name: tool, description: 'gate probe', inputSchema: { type: 'object', properties: {} } } },
          { nodeId: 'approve', typeId: gateTypeId, config: { prompt: 'Approve the draft?' } },
        ],
        edges: [{ edgeId: 'e1', sourceNodeId: 'expose', targetNodeId: 'approve' }],
      }),
    });
    expect([200, 201], await res.clone().text()).toContain(res.status);
    if (!cookie) for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m?.[1]) cookie = m[1]; }
  }

  async function call(tool: string, extra: Record<string, unknown> = {}): Promise<{ status: number; result?: Record<string, unknown>; error?: { message: string } }> {
    const res = await fetch(`${BASE}/host/openwop-app/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'MCP-Protocol-Version': MCP_CURRENT_VERSION, 'Mcp-Method': 'tools/call', 'Mcp-Name': tool, cookie },
      body: JSON.stringify({
        jsonrpc: '2.0', id: ++rpcId, method: 'tools/call',
        params: { name: tool, arguments: {}, ...extra, _meta: { [MCP_META_PROTOCOL_VERSION]: MCP_CURRENT_VERSION, [MCP_META_CLIENT_CAPABILITIES]: { elicitation: {} } } },
      }),
    });
    const body = (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } };
    return { status: res.status, ...body };
  }

  async function startAndApprove(tool: string): Promise<{ first: Awaited<ReturnType<typeof call>>; retry: Awaited<ReturnType<typeof call>>; again: Awaited<ReturnType<typeof call>> }> {
    const first = await call(tool);
    const key = Object.keys((first.result?.inputRequests ?? {}) as Record<string, unknown>)[0]!;
    const answer = { requestState: first.result?.requestState, inputResponses: { [key]: { action: 'accept', content: { action: 'approve' } } } };
    const retry = await call(tool, answer);
    const again = await call(tool, answer);
    return { first, retry, again };
  }

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
    process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    await register(`mcp.probe.campaign.${STAMP}`, CAMPAIGN_TOOL, 'campaign-studio.mcp-gate-probe');
    await register(`mcp.probe.plain.${STAMP}`, PLAIN_TOOL);
    await register(`mcp.probe.chatgate.${STAMP}`, CHAT_GATE_TOOL, 'campaign-journeys.mcp-gate-probe', 'core.chat.approvalGate');
  }, 120_000);
  afterAll(async () => {
    delete process.env.OPENWOP_MCP_SERVER_ENABLED;
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('POSITIVE CONTROL: the same gate without campaign provenance is resolved by the retry (today\'s MRTR behaviour)', async () => {
    const { first, retry } = await startAndApprove(PLAIN_TOOL);
    expect(first.result?.resultType, JSON.stringify(first)).toBe('input_required');
    expect(retry.result?.resultType, JSON.stringify(retry)).toBe('complete');
    expect(retry.result?.isError, JSON.stringify(retry)).toBe(false);
  });

  it('a campaign gate\'s retry is refused, and the gate stays open (a second retry is refused the same way, not "already resolved")', async () => {
    const { first, retry, again } = await startAndApprove(CAMPAIGN_TOOL);
    expect(first.result?.resultType, JSON.stringify(first)).toBe('input_required');
    expect(JSON.stringify(retry)).toContain('decide it in the inbox');
    // A refusal is `complete` + `isError: true` (mcpCurrentCodec `callToolResult`).
    expect(retry.result?.isError).toBe(true);
    expect(again.result?.isError).toBe(true);
    expect(JSON.stringify(again)).toContain('decide it in the inbox');
  });

  it('the journeys gate type (core.chat.approvalGate) on a campaign run is refused too', async () => {
    const { first, retry } = await startAndApprove(CHAT_GATE_TOOL);
    expect(first.result?.resultType, JSON.stringify(first)).toBe('input_required');
    expect(retry.result?.isError, JSON.stringify(retry)).toBe(true);
    expect(JSON.stringify(retry)).toContain('decide it in the inbox');
  });
});

describe('ADR 0962 D8 — campaign agents are off the A2A surface', () => {
  const campaignAgentIds = (): Array<{ agentId: string; a2aExposed?: unknown }> => readdirSync(join(REPO, 'packs'))
    .filter((d) => /^vendor\.openwop-app\.campaign-.*\.agents$/.test(d))
    .flatMap((d) => (JSON.parse(readFileSync(join(REPO, 'packs', d, 'pack.json'), 'utf8')) as { agents: Array<{ agentId: string; a2aExposed?: unknown }> }).agents);

  it('every agent in a campaign agent pack declares a2aExposed:false (a new team agent cannot forget)', () => {
    const agents = campaignAgentIds();
    expect(agents.length).toBeGreaterThanOrEqual(5);
    for (const a of agents as Array<{ agentId: string; a2aExposed?: unknown }>) expect(a.a2aExposed, a.agentId).toBe(false);
  });

  describe('with the packs loaded', () => {
    let campaign: string[] = [];
    let listedOther: string | undefined;
    beforeAll(async () => {
      process.env.OPENWOP_STORAGE_DSN = 'memory://';
      const { loadAgentsFromManifest } = await import('../src/packs/agentLoader.js');
      for (const d of readdirSync(join(REPO, 'packs')).filter((x) => x.endsWith('.agents'))) loadAgentsFromManifest(join(REPO, 'packs', d));
      campaign = (campaignAgentIds() as Array<{ agentId: string }>).map((a) => a.agentId);
      listedOther = getAgentRegistry().list().find((a) => !a.ownerTenant && a.a2aExposed !== false && !campaign.includes(a.agentId))?.agentId;
    });

    it('the 0.3 card lists no campaign agent, and still lists other pack agents', () => {
      const ids = ((buildA2aCard03('https://h.test') as { skills: Array<{ id: string }> }).skills).map((s) => s.id);
      for (const id of campaign) expect(ids, id).not.toContain(id);
      expect(campaign.every((id) => getAgentRegistry().has(id)), 'the campaign agents are installed (non-vacuous)').toBe(true);
      expect(listedOther).toBeDefined();
      expect(ids).toContain(listedOther);
      expect(isA2aDispatchable(campaign[0]!)).toBe(false);
    });

    it.each([false, true])('message/send to a campaign agent is refused like an unknown agent (durable=%s)', async (durable) => {
      const send = (agentId: string) => handleA2aRequest(
        { jsonrpc: '2.0', id: 1, method: 'message/send', params: { agentId, message: { parts: [{ kind: 'text', text: 'hi' }] } } },
        { agentCard: {}, durableTasks: durable },
      );
      const hidden = await send(campaign[0]!);
      const unknown = await send('no.such.agent');
      expect((hidden as { error?: { code: number } }).error?.code).toBe(-32001);
      expect((hidden as { error?: { code: number } }).error?.code).toBe((unknown as { error?: { code: number } }).error?.code);
    });
  });
});
