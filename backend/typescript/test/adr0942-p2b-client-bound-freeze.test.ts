/**
 * ADR 0942 P2b — a CLIENT-bound run (no campaign) freezes the client's policy.
 *
 * Real app (memory storage). Runs are inserted through the real run-start seam
 * (`insertRunWithStartContext`), carrying only the host-written ADR 0921
 * campaign-ops stamp the way a client-scoped service starts one. Cases:
 *   - a client-bound run with no campaign gets the client's policy (Guarded,
 *     source `client`, no campaignId, approverOrgId = the client) and its
 *     `report.publish` gate asks role-routed approvers on that client — never
 *     `legacy`;
 *   - a client with no binding resolves to the stricter fallback, not Guarded,
 *     and the contributor writes nothing;
 *   - an org that is not a client gets the fallback, marked dangling;
 *   - a campaign-tagged run still freezes the campaign override (precedence);
 *   - toggles OFF ⇒ no stamp ⇒ today's posture (legacy).
 *
 * Sabotage witnesses (each reds the named case; run 2026-10-20):
 *   - `registerClientAutonomyStamp()` removed from campaign-ops `feature.ts`:
 *     "a client-bound run…" (no stamp; the gate goes legacy);
 *   - `clientBoundOrg(metadata) !== null` dropped from `runAutonomyOf.bound`:
 *     "…stamp is missing… fails closed" (an unstamped client-bound run went
 *     legacy). A STAMPED run is bound by its stamp either way.
 *   - Precedence is held twice: the client arm returns early on a campaign tag,
 *     and the merge is first-writer-wins with the campaign contributor
 *     registered first. Removing the early return alone stays green (measured);
 *     it is the guard that keeps precedence independent of registration order.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { createClient, deleteClient, updateClient } from '../src/features/campaign-ops/clientService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import {
  AUTONOMY_STAMP_KEY, AUTONOMY_TOGGLE, decideGate, deleteBindingsForOrg, enforceCampaignAction, getBinding, savePolicy, type FrozenAutonomy,
} from '../src/host/autonomyPolicy/index.js';

const TENANT = 'default';
const OPS = 'openwop-app.campaignOps';
let storage: Storage;
let n = 0;

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

async function insertRun(metadata: Record<string, unknown>): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `r942b-${Date.now()}-${n++}`, workflowId: 'openwop-app.uppercase', tenantId: TENANT, status: 'running', inputs: {},
    metadata, configurable: {}, createdAt: now, updatedAt: now,
  };
  await insertRunWithStartContext(storage, run);
  const stored = await storage.getRun(run.runId);
  if (!stored) throw new Error('run not stored');
  return stored;
}
const stampOf = (r: RunRecord): FrozenAutonomy | undefined => (r.metadata as Record<string, unknown>)[AUTONOMY_STAMP_KEY] as FrozenAutonomy | undefined;

async function newClient(): Promise<string> {
  return (await createClient({ tenantId: TENANT, createdBy: 'u-1', name: `Client ${randomBytes(3).toString('hex')}` })).orgId;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
});
afterAll(() => undefined);
beforeEach(async () => {
  await setToggle('campaign-orchestration', true);
  await setToggle(AUTONOMY_TOGGLE, true);
});

describe('ADR 0942 P2b — the client-bound freeze', () => {
  it('the effect chokepoint uses a client-only stamp and refuses a deleted client', async () => {
    const orgId = await newClient();
    await updateClient(TENANT, orgId, { mode: 'live' });
    const run = await insertRun({ [OPS]: { orgId } });
    const deps = { storage, tenantId: TENANT, runId: run.runId };
    expect(await enforceCampaignAction(deps, { actionClass: 'ads.budget', facts: { spendMinor: 100 } })).toMatchObject({ kind: 'approve', orgId });
    await deleteClient(TENANT, orgId);
    expect(await enforceCampaignAction(deps, { actionClass: 'ads.budget', facts: { spendMinor: 100 } })).toMatchObject({ kind: 'blocked', reason: 'client_not_live' });
  });

  it('the effect chokepoint applies the gate\'s client-scope refusal and keeps a corrupt frozen stamp bound with toggles off', async () => {
    const orgId = await newClient();
    await updateClient(TENANT, orgId, { mode: 'live' });
    const run = await insertRun({ [OPS]: { orgId } });
    const deps = { storage, tenantId: TENANT, runId: run.runId };
    await storage.updateRun(run.runId, { metadata: { ...run.metadata, campaignOrchestration: { campaignId: 'wrong-campaign', orgId: 'other-org' } } });
    expect(await enforceCampaignAction(deps, { actionClass: 'ads.budget', facts: {} })).toMatchObject({ kind: 'blocked', reason: 'approver_org_mismatch' });
    await storage.updateRun(run.runId, { metadata: { ...run.metadata, [AUTONOMY_STAMP_KEY]: { v: 1, orgId, rules: [] } } });
    await setToggle(AUTONOMY_TOGGLE, false);
    expect(await enforceCampaignAction(deps, { actionClass: 'ads.budget', facts: {} })).toMatchObject({ kind: 'approve', orgId });
  });
  it('a client-bound run with no campaign gets the client policy and role-routed approvers, never legacy', async () => {
    const orgId = await newClient();
    const run = await insertRun({ [OPS]: { orgId } });
    const stamp = stampOf(run);
    expect(stamp).toMatchObject({ source: 'client', orgId, policyId: 'preset:guarded' });
    expect(stamp?.campaignId).toBeUndefined();
    expect((run.metadata as Record<string, unknown>).approverOrgId).toBe(orgId);
    const v = decideGate({ run, actionClass: 'report.publish', facts: {}, toggleOn: true });
    expect(v.mode).toBe('approve');
    if (v.mode !== 'approve') throw new Error('expected approve');
    expect(v.interruptData.approverRoleRefs?.length).toBeGreaterThan(0);
    expect(v.interruptData.autonomy).toMatchObject({ actionClass: 'report.publish', policyId: 'preset:guarded' });
  });

  it('a client with no binding resolves to the stricter fallback, and nothing is written', async () => {
    const orgId = await newClient();
    await deleteBindingsForOrg(TENANT, orgId);
    const run = await insertRun({ [OPS]: { orgId } });
    expect(stampOf(run)).toMatchObject({ source: 'default', orgId, policyId: 'preset:review-everything' });
    expect(await getBinding(TENANT, orgId)).toBeNull();
    expect(decideGate({ run, actionClass: 'report.publish', facts: {}, toggleOn: true }).mode).toBe('approve');
  });

  it('an org that is not a client gets the fallback, marked dangling', async () => {
    const orgId = (await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Not a client' })).orgId;
    const run = await insertRun({ [OPS]: { orgId } });
    expect(stampOf(run)).toMatchObject({ source: 'default', orgId, dangling: true });
  });

  it('a campaign-tagged run still freezes the campaign override (campaign beats client default)', async () => {
    const orgId = await newClient();
    const brief = await createBrief(TENANT, orgId, 'u-1', { name: 'Spring', channels: [] });
    const { campaign } = await ensureDraftCampaign(TENANT, brief, 'u-1');
    await savePolicy({ tenantId: TENANT, orgId, campaignId: campaign.id, input: { kind: 'preset', preset: 'review-everything@1' }, actor: 'u-1', expected: null });
    const run = await insertRun({ [OPS]: { orgId }, campaignOrchestration: stampCampaignRun(campaign, { role: 'spine' }) });
    expect(stampOf(run)).toMatchObject({ source: 'campaign', orgId, campaignId: campaign.id, policyId: 'preset:review-everything' });
  });

  it('a client-bound run whose stamp is missing (a contributor failed) fails closed, never legacy', () => {
    // Contributors are fail-soft, so a client-bound run can reach a gate unstamped.
    const run = { metadata: { [OPS]: { orgId: 'org-x' } } };
    const v = decideGate({ run, actionClass: 'report.publish', facts: {}, toggleOn: true });
    expect(v.mode).not.toBe('legacy');
    expect(v).toMatchObject({ mode: 'blocked', reason: 'approver_org_mismatch' });
  });

  it.each([false, true])('conflicting trusted client scopes refuse before approver resolution, stamped=%s', async (stamped) => {
    const orgId = await newClient();
    const original = await insertRun({ [OPS]: { orgId } });
    const metadata: RunRecord['metadata'] = { ...original.metadata, campaignOrchestration: { campaignId: 'cmp-conflict', orgId: 'other-org' } };
    if (!stamped) delete metadata[AUTONOMY_STAMP_KEY];
    const v = decideGate({ run: { ...original, metadata }, actionClass: 'report.publish', facts: {}, toggleOn: true });
    expect(v).toMatchObject({ mode: 'blocked', reason: 'approver_org_mismatch' });
  });

  it('a malformed frozen policy cannot become legacy when the live toggle is off', () => {
    const run = { metadata: { [OPS]: { orgId: 'org-x' }, [AUTONOMY_STAMP_KEY]: { v: 1, orgId: 'org-x', rules: [] }, approverOrgId: 'org-x' } };
    expect(decideGate({ run, actionClass: 'report.publish', facts: {}, toggleOn: false }).mode).toBe('approve');
  });

  it('toggles OFF ⇒ no stamp ⇒ today\'s posture', async () => {
    const orgId = await newClient();
    await setToggle(AUTONOMY_TOGGLE, false);
    const run = await insertRun({ [OPS]: { orgId } });
    expect(stampOf(run)).toBeUndefined();
    expect(decideGate({ run, actionClass: 'report.publish', facts: {}, toggleOn: false }).mode).toBe('legacy');
  });
});
