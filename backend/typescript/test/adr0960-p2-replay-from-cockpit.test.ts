/**
 * ADR 0960 P2 — "Replay this run" from the campaign cockpit.
 *
 * Exit criterion (ADR 0960 § Phased plan, P2): a replay fork of a campaign run
 * with an ad-launch node creates ZERO new adapter calls. The cockpit's replay is
 * the existing `:fork` (mode `replay`) — no new fork route — so this witnesses
 * that path end to end for a campaign-tagged run, then that:
 *   - the fork keeps the campaign tag (copied verbatim) and appears in the
 *     campaign's snapshot as role `fork`;
 *   - `:diff` against the source differs only in `run.started` (the fork's own
 *     owner) with an empty state diff: the "prove it" read the cockpit shows.
 *
 * The ad-launch node is a test node declared side-effecting (the same
 * classification every real ads publish node carries, `executor/sideEffects.ts`).
 * Sabotage (run 2026-10-20): dropping `sideEffecting: true` from the test node
 * reds "…zero new ad-launch calls" (the replay re-executes it).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { buildCommandSnapshot } from '../src/features/campaign-orchestration/commandService.js';
import { CAMPAIGN_RUN_TAG_KEY, stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { createOrg } from '../src/host/accessControlService.js';
import { startWorkflowRun } from '../src/host/runStarter.js';
import { bareRunId } from './support/bareRunId.js';

const TENANT = 'default';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };
let server: http.Server;
let BASE = '';
let storage: Storage;
let hostSuite: HostAdapterSuite;
let orgId: string;
const launches = new Map<string, number>();
const WF = `wf.adr0960.ad-launch.${randomBytes(3).toString('hex')}`;

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
async function untilTerminal(runId: string): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const s = (await storage.getRun(bareRunId(runId)))?.status ?? '';
    if (['completed', 'failed', 'cancelled'].includes(s)) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  return 'timeout';
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  getNodeRegistry().register({
    typeId: 'test.adr0960.ad-launch',
    version: '1.0.0',
    sideEffecting: true,
    async execute(ctx) {
      const id = bareRunId(ctx.runId);
      launches.set(id, (launches.get(id) ?? 0) + 1);
      return { status: 'success', outputs: { platformCampaignId: `mc-${id.slice(0, 6)}`, paused: true } };
    },
  });
  registerWorkflow({
    workflowId: WF,
    nodes: [
      { nodeId: 'plan', typeId: 'core.noop', config: {} },
      { nodeId: 'launch', typeId: 'test.adr0960.ad-launch', config: {} },
    ],
    edges: [{ edgeId: 'p-l', sourceNodeId: 'plan', targetNodeId: 'launch' }],
  });
  const d = getToggleDefault('campaign-orchestration');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  orgId = (await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Client A', ownerSubject: 'u-1' })).orgId;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0960 P2 — replay from the cockpit', () => {
  it('a replay fork of a campaign run with an ad-launch node makes zero new ad-launch calls, keeps the tag, and diffs clean', async () => {
    const brief = await createBrief(TENANT, orgId, 'u-1', { name: 'Ads', channels: [] });
    const { campaign } = await ensureDraftCampaign(TENANT, brief, 'u-1');
    const source = bareRunId((await startWorkflowRun({ storage, hostSuite }, {
      tenantId: TENANT, workflowId: WF, inputs: {},
      metadata: { actingUserId: 'u-1', [CAMPAIGN_RUN_TAG_KEY]: stampCampaignRun(campaign, { role: 'spine' }) },
    })) as string);
    expect(await untilTerminal(source)).toBe('completed');
    expect(launches.get(source)).toBe(1);

    // What the cockpit's "Replay this run" calls: the existing :fork, mode replay.
    const fork = await api<{ runId: string }>(`/runs/${encodeURIComponent(`${TENANT}/${source}`)}:fork`, { method: 'POST', body: JSON.stringify({ fromSeq: 0, mode: 'replay' }) });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    const forkId = bareRunId(fork.body.runId);
    expect(await untilTerminal(forkId)).toBe('completed');
    expect(launches.get(forkId) ?? 0).toBe(0);
    expect([...launches.values()].reduce((a, b) => a + b, 0)).toBe(1);

    // The fork belongs to the campaign (tag copied) and shows as a fork.
    const snap = await buildCommandSnapshot(storage, campaign);
    expect(snap.runs.find((r) => r.runId === forkId)).toMatchObject({ role: 'fork', status: 'completed' });

    // The "prove it" read: no divergence.
    const diff = await api<{ divergedAtSeq: number | null; eventDiffs: Array<{ seq: number; aEvent?: { type: string }; bEvent?: { type: string } }>; stateDiff: Record<string, unknown> }>(`/runs/${encodeURIComponent(`${TENANT}/${source}`)}:diff?against=${forkId}`);
    expect(diff.status, JSON.stringify(diff.body)).toBe(200);
    // The only difference is WHO started each run (the fork's caller is stamped
    // as its owner on run.started); every step and the final state match. The
    // cockpit reads exactly this as "the replay matched".
    expect(diff.body.eventDiffs.map((d) => [d.aEvent?.type, d.bEvent?.type])).toEqual([['run.started', 'run.started']]);
    expect(diff.body.stateDiff).toEqual({});
  });
});
