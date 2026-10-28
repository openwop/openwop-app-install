/**
 * ADR 0942 P1 — the autonomy policy frozen at run start, through REAL run
 * creation paths (the run-insert seam, `POST /runs`, `:fork`, the redrive route
 * and a sub-workflow child built the way the dispatcher builds one).
 *
 * Exit criteria (phase row P1): a fork after a loosen keeps the old policy; a
 * caller-supplied stamp is stripped; a child inherits; a branch fork re-asks
 * before every effect; an MCP-started run cannot auto-send.
 *
 * Sabotage notes (each run, 2026-10-20):
 *  - drop `campaignAutonomy` from RESERVED_RUN_METADATA_KEYS → red (the forged stamp survives POST /runs);
 *  - delete the contributor's `derivedFromRun` block → red (no attended posture; an unstamped redrive acquires one).
 *    (Removing only its final `return {}` stays green: the `parentRunId` guard covers forks and the
 *    posture return covers redrives — defence in depth, recorded so nobody re-runs it as a witness);
 *  - drop the `parentRunId` early return → red (a child of an unstamped parent acquires a stamp);
 *  - drop the redrive inheritance loop in workflowDebug.ts → red (the redrive has no stamp);
 *  - drop the hash check in `parseAutonomyStamp` → red (a tampered stamp is honoured);
 *  - drop `mcpOrigin` from the stamp and the live `source` read → red (the MCP run auto-sends).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { inheritedRunMetadata } from '../src/host/inheritedRunMetadata.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import {
  AUTONOMY_STAMP_KEY, AUTONOMY_TOGGLE, FORK_POSTURE_KEY, bindClientPresetIfAbsent, presetPolicy, resolveCampaignAction,
  runAutonomyOf, savePolicy, type FrozenAutonomy,
} from '../src/host/autonomyPolicy/index.js';
import type { RunRecord } from '../src/types.js';
import { bareRunId } from './support/bareRunId.js';

const TENANT = 'default';
const TOKEN = 'dev-token';
const SRC_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
let server: http.Server;
let storage: Storage;
let BASE: string;
let orgId: string;
let campaign: MarketingCampaign;
let fixtureWorkflowId: string;
let n = 0;

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

async function jf<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: (res.status === 204 ? undefined : await res.json()) as T }; // JSON boundary
}

const runRow = async (runId: string): Promise<RunRecord> => {
  const r = await storage.getRun(bareRunId(runId));
  if (!r) throw new Error(`run ${runId} not found`);
  return r;
};
const metaOf = async (runId: string): Promise<Record<string, unknown>> => ((await runRow(runId)).metadata ?? {}) as Record<string, unknown>;
const stampOf = async (runId: string): Promise<FrozenAutonomy | undefined> => (await metaOf(runId))[AUTONOMY_STAMP_KEY] as FrozenAutonomy | undefined;

/** Insert a campaign run the way a campaign service does (host path, through the seam). */
async function insertCampaignRun(extraMeta: Record<string, unknown> = {}, extra: Partial<RunRecord> = {}): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `r942-${Date.now()}-${n++}`, workflowId: fixtureWorkflowId, tenantId: TENANT, status: 'completed', inputs: {},
    metadata: { campaignOrchestration: stampCampaignRun(campaign, { role: 'spine' }), ...extraMeta }, configurable: {},
    createdAt: now, updatedAt: now, ...extra,
  };
  await insertRunWithStartContext(storage, run);
  await getEventLog().append({ runId: run.runId, type: 'log.message', payload: { message: 'adr0942 fork point' } });
  return run;
}

async function fork(runId: string, mode: 'replay' | 'branch'): Promise<string> {
  const r = await jf<{ runId: string }>(`/runs/${encodeURIComponent(`${TENANT}/${runId}`)}:fork`, { method: 'POST', body: JSON.stringify({ fromSeq: 0, mode }) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.runId;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await setToggle('campaign-orchestration', true);
  await setToggle(AUTONOMY_TOGGLE, true);
  orgId = (await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Client A', ownerSubject: 'u-1' })).orgId;
  await bindClientPresetIfAbsent(TENANT, orgId, 'guarded@1', 'u-1');
  const brief = await createBrief(TENANT, orgId, 'u-1', { name: 'Spring launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  campaign = (await ensureDraftCampaign(TENANT, brief, 'u-1')).campaign;
  const disco = await jf<{ fixtures?: string[] }>('/.well-known/openwop');
  fixtureWorkflowId = disco.body.fixtures?.[0] ?? 'openwop-app.uppercase';
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0942 D4 — the stamp at run start', () => {
  it('a fresh campaign run is stamped with the client default, rules inline', async () => {
    const run = await insertCampaignRun();
    const stamp = await stampOf(run.runId);
    const guarded = presetPolicy('guarded@1');
    expect(stamp).toMatchObject({ v: 1, policyId: 'preset:guarded', version: 1, hash: guarded.hash, source: 'client', campaignId: campaign.id, orgId });
    expect(stamp?.rules).toEqual(guarded.rules);
    const ra = runAutonomyOf(await runRow(run.runId));
    expect(ra).toMatchObject({ bound: true, floors: {} });
    expect(ra.policy?.hash).toBe(guarded.hash);
  });

  it('no stamp while the sub-toggle is off; a bound unstamped run resolves to the fail-closed fallback', async () => {
    await setToggle(AUTONOMY_TOGGLE, false);
    const run = await insertCampaignRun();
    await setToggle(AUTONOMY_TOGGLE, true);
    expect(await stampOf(run.runId)).toBeUndefined();
    const ra = runAutonomyOf(await runRow(run.runId));
    expect(ra).toMatchObject({ bound: true, policy: null, reason: 'absent' });
    expect(resolveCampaignAction({ policy: ra.policy, actionClass: 'ads.publish', facts: {} }).decision.outcome).toBe('approve');
  });

  it('a non-campaign run is not bound and gets no stamp', async () => {
    const now = new Date().toISOString();
    const run: RunRecord = { runId: `r942-plain-${n++}`, workflowId: fixtureWorkflowId, tenantId: TENANT, status: 'completed', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
    await insertRunWithStartContext(storage, run);
    expect(await stampOf(run.runId)).toBeUndefined();
    expect(runAutonomyOf(await runRow(run.runId)).bound).toBe(false);
  });

  it('a tag naming a campaign that does not exist gets the fallback stamp, marked dangling', async () => {
    const ghost = { ...campaign, id: 'cmp_ghostghostghostghostghost' };
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `r942-ghost-${n++}`, workflowId: fixtureWorkflowId, tenantId: TENANT, status: 'completed', inputs: {},
      metadata: { campaignOrchestration: stampCampaignRun(ghost, { role: 'spine' }) }, configurable: {}, createdAt: now, updatedAt: now,
    };
    await insertRunWithStartContext(storage, run);
    expect(await stampOf(run.runId)).toMatchObject({ policyId: 'preset:review-everything', source: 'default', dangling: true });
  });

  it('a caller-supplied stamp or posture is stripped from POST /runs', async () => {
    const forged = { v: 1, policyId: 'preset:autopilot', version: 1, hash: presetPolicy('autopilot@1').hash, rules: presetPolicy('autopilot@1').rules, campaignId: campaign.id, orgId };
    const created = await jf<{ runId: string }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId: fixtureWorkflowId, inputs: {}, metadata: { campaignAutonomy: forged, campaignForkPosture: 'relaxed', note: 'kept' } }),
    });
    expect(created.status).toBe(201);
    const meta = await metaOf(created.body.runId);
    expect(meta[AUTONOMY_STAMP_KEY]).toBeUndefined();
    expect(meta[FORK_POSTURE_KEY]).toBeUndefined();
    expect(meta.note).toBe('kept');
  });

  it('a tampered stamp is not honoured', async () => {
    const run = await insertCampaignRun();
    const stamp = await stampOf(run.runId);
    if (!stamp) throw new Error('expected a stamp');
    const tampered = { ...stamp, rules: presetPolicy('autopilot@1').rules };
    const ra = runAutonomyOf({ metadata: { ...(await metaOf(run.runId)), [AUTONOMY_STAMP_KEY]: tampered } });
    expect(ra).toMatchObject({ bound: true, policy: null, reason: 'hash_mismatch' });
  });
});

describe('ADR 0942 D4/D10.4 — fork, redrive and children', () => {
  it('a fork after a loosen keeps the old policy; a branch fork is attended and re-asks before every effect', async () => {
    const src = await insertCampaignRun();
    const before = await stampOf(src.runId);
    // Loosen the campaign to Autopilot AFTER the source started.
    await savePolicy({ tenantId: TENANT, orgId, campaignId: campaign.id, input: { kind: 'preset', preset: 'autopilot@1' }, actor: 'u-1', expected: null });
    const fresh = await insertCampaignRun();
    expect((await stampOf(fresh.runId))?.policyId).toBe('preset:autopilot'); // non-vacuity: the loosen took effect
    for (const mode of ['replay', 'branch'] as const) {
      const f = await fork(src.runId, mode);
      expect(await stampOf(f), mode).toEqual(before);
      expect((await metaOf(f))[FORK_POSTURE_KEY], mode).toBe(mode === 'branch' ? 'attended' : undefined);
    }
    // A branch fork of an AUTOPILOT run still asks before sending.
    const branch = runAutonomyOf(await runRow(await fork(fresh.runId, 'branch')));
    expect(branch.floors.forkPosture).toBe('attended');
    expect(resolveCampaignAction({ policy: presetPolicy('autopilot@1'), actionClass: 'lead.contact', facts: { spendMinor: 0, audienceSize: 1, regulatedCategory: false, findingsHigh: 0, firstForDestination: false } }).decision.outcome).toBe('notify-after');
    expect(resolveCampaignAction({ policy: branch.policy, actionClass: 'lead.contact', facts: { spendMinor: 0, audienceSize: 1, regulatedCategory: false, findingsHigh: 0, firstForDestination: false }, floors: branch.floors }).decision.outcome).toBe('approve');
  });

  it('a redrive runs under its source\'s policy and is attended', async () => {
    const src = await insertCampaignRun();
    const before = await stampOf(src.runId);
    await storage.updateRun(bareRunId(src.runId), { status: 'failed' });
    const r = await jf<{ results?: Array<{ redriveRunId?: string; error?: string }> }>('/host/openwop-app/runs/redrive', { method: 'POST', body: JSON.stringify({ runIds: [src.runId] }) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = r.body.results?.[0]?.redriveRunId;
    if (!id) throw new Error(`redrive refused: ${JSON.stringify(r.body)}`);
    expect(await stampOf(id)).toEqual(before);
    expect((await metaOf(id))[FORK_POSTURE_KEY]).toBe('attended');
  });

  it('a redrive of a run born without a stamp stays without one after the toggle turns on (absence is inherited)', async () => {
    await setToggle(AUTONOMY_TOGGLE, false);
    const src = await insertCampaignRun();
    await setToggle(AUTONOMY_TOGGLE, true);
    expect(await stampOf(src.runId)).toBeUndefined();
    await storage.updateRun(bareRunId(src.runId), { status: 'failed' });
    const r = await jf<{ results?: Array<{ redriveRunId?: string }> }>('/host/openwop-app/runs/redrive', { method: 'POST', body: JSON.stringify({ runIds: [src.runId] }) });
    const id = r.body.results?.[0]?.redriveRunId;
    if (!id) throw new Error(`redrive refused: ${JSON.stringify(r.body)}`);
    expect(await stampOf(id)).toBeUndefined();
  });

  it('a child inherits its parent\'s stamp verbatim, and an unstamped parent\'s child stays unstamped', async () => {
    const parent = await insertCampaignRun();
    const child = async (p: RunRecord): Promise<string> => {
      const now = new Date().toISOString();
      const run: RunRecord = {
        runId: `r942-child-${n++}`, workflowId: fixtureWorkflowId, tenantId: TENANT, status: 'pending', inputs: {},
        // Exactly the dispatcher's shape: the reserved-stripped handoff + the inherited keys from the PARENT ROW.
        metadata: { ...inheritedRunMetadata(p.metadata as Record<string, unknown>) }, configurable: {}, parentRunId: p.runId, createdAt: now, updatedAt: now,
      };
      await insertRunWithStartContext(storage, run);
      return run.runId;
    };
    expect(await stampOf(await child(await runRow(parent.runId)))).toEqual(await stampOf(parent.runId));
    await setToggle(AUTONOMY_TOGGLE, false);
    const bare = await insertCampaignRun();
    await setToggle(AUTONOMY_TOGGLE, true);
    expect(await stampOf(await child(await runRow(bare.runId)))).toBeUndefined();
  });
});

describe('ADR 0942 D10.3 — MCP-started runs', () => {
  it('the MCP run constructor writes the origin marker itself, with no caller merge', () => {
    const src = readFileSync(join(SRC_ROOT, 'host', 'mcpSemantics.ts'), 'utf8');
    expect(src).toMatch(/metadata: \{ launchResolved: wf\.launchResolved, source: 'mcp-server-mount', trustBoundary: 'untrusted', actingUserId: deps\.principal\.principalId \}/);
  });

  it('an MCP-started campaign run cannot auto-send, even on Autopilot', async () => {
    const run = await insertCampaignRun({ source: 'mcp-server-mount', trustBoundary: 'untrusted' });
    const stamp = await stampOf(run.runId);
    expect(stamp?.mcpOrigin).toBe(true);
    const ra = runAutonomyOf(await runRow(run.runId));
    const r = resolveCampaignAction({ policy: presetPolicy('autopilot@1'), actionClass: 'email.campaign-send', facts: { spendMinor: 0, audienceSize: 1, regulatedCategory: false, findingsHigh: 0, firstForDestination: false }, floors: ra.floors });
    expect(r.decision.outcome).toBe('approve');
    expect(r.reasons).toContain('floor:mcp_origin');
  });
});
