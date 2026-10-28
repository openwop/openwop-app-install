/**
 * ADR 0942 P4b — the veto window. A notify-after step with `vetoWindowMs` waits on a
 * TIMER the notified people may veto; it is never an approval silence grants.
 *
 *   - the gate opens a TIMER interrupt (not an approval) flagged `autonomy.vetoWindow`,
 *     opens one veto record, and lists it on the campaign;
 *   - no veto ⇒ the timer sweep resumes it ⇒ success `{vetoWindow:'elapsed'}`;
 *   - a recipient vetoes over the route ⇒ the timer's resume FAILS `autonomy_vetoed`;
 *   - a non-recipient gets 404; a second veto (or one after the deadline) gets 409;
 *   - nobody can end the window early: a session resolve and an MCP retry are refused;
 *   - re-entry is idempotent (a replayed/resumed gate finds the same record, no new one);
 *   - a CHOKEPOINT reached with a veto-window decision resolves to approve (it cannot wait).
 *
 * What turns it red: the gate suspending as an approval; the early-resolve refusal
 * removed (either lane); the veto outcome not read on resume; a non-recipient allowed;
 * the chokepoint fallback dropped (it would proceed as plain notify-after).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { executeRun } from '../src/executor/executor.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { __awaitRunResumeChainForTests, resolveAndResume, timerResumeContinuation } from '../src/routes/interrupts.js';
import { sweepDueTimers } from '../src/executor/timerResume.js';
import { resumeInterrupt } from '../src/host/mcpSemantics.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { resolveNotificationRecipients } from '../src/host/approverResolution.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { buildCampaignStudioSurface } from '../src/features/campaign-orchestration/surface.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import { AUTONOMY_TOGGLE, bindClientPresetIfAbsent, enforceCampaignAction, getVeto, listOpenVetoes, presetRules, savePolicy, type ActionRule } from '../src/host/autonomyPolicy/index.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Principal, RunRecord } from '../src/types.js';
import { nodes as orchestrationNodes } from '../../../packs/feature.campaign-orchestration.nodes/index.mjs';
import { bareRunId } from './support/bareRunId.js';

let TENANT = '';
const GATE = 'feature.campaign-orchestration.nodes.autonomy-gate';
const WF = 'wf.adr0942.veto-window';
/** The validator's floor for a veto window is one hour (ADR 0942 P0). */
const WINDOW_MS = 3_600_000;
let server: http.Server;
let BASE = '';
let storage: Storage;
let hostSuite: HostAdapterSuite;
let orgId: string;
let campaign: MarketingCampaign;
let n = 0;
/** Real users (a session needs one): requester, a second admin, an editor. */
const U = { requester: '', admin2: '', editor: '' };

const setToggle = async (id: string, on: boolean): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
};
const cookieFor = (userId: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant: `ws:home-${userId}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const post = async (userId: string, path: string, body: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${BASE}/host/openwop-app/campaign-orchestration${path}`, { method: 'POST', headers: { cookie: cookieFor(userId), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

async function gateRun(): Promise<{ run: RunRecord; interruptId?: string; status: string }> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-veto-${n++}-${Math.random().toString(36).slice(2, 8)}`, workflowId: WF, tenantId: TENANT, status: 'pending', inputs: {},
    metadata: { campaignOrchestration: stampCampaignRun(campaign, { role: 'spine' }), actingUserId: U.requester },
    configurable: {}, createdAt: now, updatedAt: now,
  };
  await insertRunWithStartContext(storage, run);
  const def = (await hostSuite.workflowCatalog.getWorkflow(WF))?.definition;
  if (!def) throw new Error('gate workflow not registered');
  const stored = (await storage.getRun(run.runId)) ?? run;
  const status = (await executeRun(storage, stored, def)).status;
  const [open] = await storage.listOpenInterrupts(run.runId);
  return { run: (await storage.getRun(run.runId)) ?? stored, ...(open ? { interruptId: open.interruptId } : {}), status };
}
const statusOf = async (runId: string): Promise<string | undefined> => (await storage.getRun(runId))?.status;
/** Fire every due timer as the daemon would, `ms` past now. */
const fireTimers = async (ms: number): Promise<number> => {
  vi.setSystemTime(Date.now() + ms);
  return sweepDueTimers(storage, timerResumeContinuation(storage, hostSuite), Date.now());
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  getNodeRegistry().register({
    typeId: GATE, version: '1.1.0',
    execute: async (ctx) => {
      const r = await orchestrationNodes[GATE](ctx);
      if (r.status === 'success') return { status: 'success', outputs: r.outputs };
      return { status: 'failure', error: { code: r.error?.code ?? 'pack_node_error', message: r.error?.message ?? 'Pack node returned non-success outcome' } };
    },
  });
  registerHostWorkflow({
    workflowId: WF, name: WF, version: '1.0.0',
    nodes: [
      { nodeId: 'kernel-approve', typeId: GATE, config: { actionClass: 'plan.approve', prompt: 'Run the plan?' } },
      { nodeId: 'after', typeId: 'core.noop', config: {} },
    ],
    edges: [{ edgeId: 'e1', sourceNodeId: 'kernel-approve', targetNodeId: 'after', triggerRule: 'all_success' }],
  } as unknown as WorkflowDefinition);
  await setToggle('campaign-orchestration', true);
  await setToggle(AUTONOMY_TOGGLE, true);
  TENANT = (await createWorkspace({ name: 'Veto Agency', ownerSubject: 'oidc:veto-owner' })).tenantId;
  orgId = (await createOrg({ tenantId: TENANT, createdBy: 'u-owner', name: 'Client A', ownerSubject: 'u-owner' })).orgId;
  for (const [key, role] of [['requester', 'admin'], ['admin2', 'admin'], ['editor', 'editor']] as const) {
    const u = await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:veto-${key}`, source: 'oidc' });
    U[key] = u.userId;
    await createMember({ tenantId: TENANT, orgId: TENANT, subject: u.userId, displayName: key, roles: ['viewer'] });
    await createMember({ tenantId: TENANT, orgId, subject: u.userId, displayName: key, roles: [role] });
  }
  await bindClientPresetIfAbsent(TENANT, orgId, 'guarded@1', 'u-owner');
  const brief = await createBrief(TENANT, orgId, 'u-owner', { name: 'Veto launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  campaign = (await ensureDraftCampaign(TENANT, brief, 'u-owner')).campaign;
  // plan.approve: notify-after to admins, with a one-hour veto window.
  const rules: ActionRule[] = presetRules('guarded@1').map((r) => (r.actionClass === 'plan.approve'
    ? { actionClass: 'plan.approve', default: { outcome: 'notify-after', notify: { roleRefs: ['admin'], channels: ['inbox'], digest: 'immediate', vetoWindowMs: WINDOW_MS } } }
    : r));
  await savePolicy({ tenantId: TENANT, orgId, campaignId: campaign.id, input: { kind: 'custom', name: 'Plans run unless vetoed', basePreset: 'guarded@1', rules }, actor: 'u-owner', expected: null });
}, 120_000);
afterAll(async () => { vi.useRealTimers(); await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0942 P4b — the veto window is a timer, never an approval', () => {
  it('addresses canonical members, including a member whose user account lives in another home tenant', async () => {
    const home = await upsertFromPrincipal({ tenantId: 'user:veto-home', principalId: 'oidc:member-from-home', source: 'oidc' });
    const stranger = await upsertFromPrincipal({ tenantId: 'user:veto-stranger', principalId: 'oidc:not-a-member', source: 'oidc' });
    await createMember({ tenantId: TENANT, orgId, subject: home.userId, displayName: 'Home member', roles: ['admin'] });
    const recipients = await resolveNotificationRecipients({ approverRoleRefs: ['admin'] }, { tenantId: TENANT, orgId });
    expect(recipients).toEqual(expect.arrayContaining([U.requester, U.admin2, home.userId]));
    expect(recipients).not.toContain(stranger.userId);
    const foreign = await createOrg({ tenantId: 'foreign-veto', createdBy: stranger.userId, name: 'Foreign', ownerSubject: stranger.userId });
    await createMember({ tenantId: 'foreign-veto', orgId: foreign.orgId, subject: stranger.userId, displayName: 'Foreign admin', roles: ['admin'] });
    expect(await resolveNotificationRecipients({ approverRoleRefs: ['admin'] }, { tenantId: TENANT, orgId: foreign.orgId })).toBeNull();
  });

  it('does not treat a failed reviewer notice as sent, and retry fills it once', async () => {
    const insert = vi.spyOn(storage, 'insertNotification').mockRejectedValue(new Error('inbox unavailable'));
    let run: RunRecord;
    try {
      const result = await gateRun();
      run = result.run;
      expect(result.status).toBe('failed');
    } finally { insert.mockRestore(); }
    const [win] = (await listOpenVetoes(TENANT, campaign.id)).filter(w => w.runId === run.runId);
    if (!win) throw new Error('expected unnotified window');
    expect(win.notifiedAt).toBeUndefined();
    const surface = buildCampaignStudioSurface({ tenantId: TENANT, runId: run.runId });
    const args = { actionClass: 'plan.approve', vetoKey: 'kernel-approve' };
    await surface.autonomyResolve(args);
    expect((await getVeto(TENANT, campaign.id, win.vetoId))?.notifiedAt).toBeTruthy();
    const notices = async () => (await storage.listNotifications({ tenantId: TENANT }))
      .filter(n => n.type === 'campaign.autonomy.notice' && n.metadata?.runId === run.runId);
    const first = await notices();
    expect(first.length).toBeGreaterThan(0);
    await surface.autonomyResolve(args);
    expect((await notices()).map(n => n.notificationId).sort()).toEqual(first.map(n => n.notificationId).sort());
  });

  it('cannot close another run\'s window or its own window before the deadline', async () => {
    const { run } = await gateRun();
    const [win] = (await listOpenVetoes(TENANT, campaign.id)).filter((v) => v.runId === run.runId);
    if (!win) throw new Error('expected window');
    const other = await gateRun();
    const foreign = buildCampaignStudioSurface({ tenantId: TENANT, runId: other.run.runId });
    expect(await foreign.autonomyVetoOutcome({ campaignId: campaign.id, vetoId: win.vetoId })).toMatchObject({ outcome: 'vetoed', reason: 'veto_record_unreadable' });
    expect((await getVeto(TENANT, campaign.id, win.vetoId))?.status).toBe('open');
    const own = buildCampaignStudioSurface({ tenantId: TENANT, runId: run.runId });
    expect(await own.autonomyVetoOutcome({ campaignId: campaign.id, vetoId: win.vetoId })).toMatchObject({ outcome: 'vetoed', reason: 'veto_window_pending' });
    expect((await getVeto(TENANT, campaign.id, win.vetoId))?.status).toBe('open');
  });
  it('opens a TIMER (not an approval), flagged, with one open record listed on the campaign', async () => {
    const { interruptId, run } = await gateRun();
    if (!interruptId) throw new Error('expected a waiting gate');
    const it = await storage.getInterrupt(interruptId);
    expect(it?.kind).toBe('timer');
    expect(it?.data).toMatchObject({ seconds: WINDOW_MS / 1000, autonomy: { vetoWindow: true } });
    const open = (await listOpenVetoes(TENANT, campaign.id)).filter((v) => v.runId === run.runId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ actionClass: 'plan.approve', status: 'open' });
  });

  it('no veto ⇒ the timer sweep resumes it and the step proceeds', async () => {
    const { run, interruptId } = await gateRun();
    if (!interruptId) throw new Error('expected a waiting gate');
    expect(await fireTimers(0)).toBe(0); // not due yet
    expect(await fireTimers(WINDOW_MS + 1000)).toBeGreaterThanOrEqual(1);
    await __awaitRunResumeChainForTests(run.runId);
    expect(await statusOf(run.runId)).toBe('completed');
  });

  it('a replay fork serves the completed veto gate\'s recorded output without opening another window', async () => {
    const { run } = await gateRun();
    await fireTimers(WINDOW_MS + 1000);
    await __awaitRunResumeChainForTests(run.runId);
    expect(await statusOf(run.runId)).toBe('completed');
    const recorded = (await storage.listEvents(run.runId)).find(e => e.type === 'node.completed' && e.nodeId === 'kernel-approve')?.payload;
    expect(recorded).toMatchObject({ outputs: { decision: 'notify-after', vetoWindow: 'elapsed' } });
    const response = await fetch(`${BASE}/runs/${encodeURIComponent(`${TENANT}/${run.runId}`)}:fork`, {
      method: 'POST', headers: { cookie: cookieFor(U.requester), 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'replay', fromSeq: 0 }),
    });
    const body = await response.json() as { runId?: string };
    expect(response.status, JSON.stringify(body)).toBe(201);
    const forkId = bareRunId(body.runId ?? '');
    expect(forkId).not.toBe('');
    await vi.waitFor(async () => expect(await statusOf(forkId)).toBe('completed'), { timeout: 8000, interval: 25 });
    const reproduced = (await storage.listEvents(forkId)).find(e => e.type === 'node.completed' && e.nodeId === 'kernel-approve')?.payload;
    expect(reproduced).toMatchObject({ outputs: (recorded as { outputs: unknown }).outputs });
    expect((await listOpenVetoes(TENANT, campaign.id)).filter(w => w.runId === forkId)).toEqual([]);
  });

  it('a recipient\'s veto fails the step when the timer fires; a second veto is 409; a non-recipient sees 404', async () => {
    const { run } = await gateRun();
    const [win] = (await listOpenVetoes(TENANT, campaign.id)).filter((v) => v.runId === run.runId);
    if (!win) throw new Error('expected an open window');
    expect((await post(U.editor, `/campaigns/${campaign.id}/vetoes/${win.vetoId}`)).status).toBe(404);
    const v = await post(U.requester, `/campaigns/${campaign.id}/vetoes/${win.vetoId}`, { reason: 'Wrong audience' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect((await post(U.admin2, `/campaigns/${campaign.id}/vetoes/${win.vetoId}`)).status).toBe(409);
    await fireTimers(WINDOW_MS + 1000);
    await __awaitRunResumeChainForTests(run.runId);
    expect(await statusOf(run.runId)).toBe('failed');
    const events = await storage.listEvents(run.runId);
    expect(JSON.stringify(events)).toContain('autonomy_vetoed');
  });

  it('nobody can end the window early: a session resolve and an MCP retry are refused', async () => {
    const { run, interruptId } = await gateRun();
    if (!interruptId) throw new Error('expected a waiting gate');
    await expect(resolveAndResume(storage, hostSuite, interruptId, { elapsed: true }, { subjectRef: U.admin2 }))
      .rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_veto_window' } });
    const deps = { storage, hostSuite, principal: { principalId: U.requester, tenants: [TENANT] } as unknown as Principal };
    expect((await resumeInterrupt(deps, interruptId, { elapsed: true })).kind).toBe('failed');
    expect((await storage.getInterrupt(interruptId))?.resolvedAt).toBeUndefined();
    expect(await statusOf(run.runId)).not.toBe('completed');
  });
});

describe('ADR 0942 P4b — a chokepoint cannot wait, so it asks instead', () => {
  it('a veto-window notify-after reached at a chokepoint resolves to approve', async () => {
    const { run } = await gateRun();
    const verdict = await enforceCampaignAction({ storage, tenantId: TENANT, runId: run.runId }, { actionClass: 'plan.approve', facts: {} });
    expect(verdict.kind).toBe('approve');
  });
});
