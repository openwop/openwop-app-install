/**
 * the sole-admin self-approval ADR (D1/D2) — the sole-admin self-approval escape on an autonomy gate, through
 * the REAL executor, the real campaign-orchestration autonomy-gate pack node and the
 * ONE resolve choke point (`resolveAndResume`). Setup mirrors
 * `adr0942-p2-autonomy-gate.test.ts`, plus a client org whose only member is its owner.
 *
 * What must hold (user decision 2026-11-15, the sole-admin self-approval ADR):
 *  - the only admin who could decide the gate may approve their own request, as a
 *    person in their own session, and the decision is audited;
 *  - a second admin, added while the gate waits, restores the two-person rule;
 *  - a non-admin requester, an API key / non-session lane, a quorum gate, an
 *    MCP-origin run and an attended branch fork never get the escape.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createOrg } from '../src/host/accessControlService.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { executeRun } from '../src/executor/executor.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { __awaitRunResumeChainForTests, resolveAndResume } from '../src/routes/interrupts.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { isHumanSignInSubject, soleAdminSelfApproval } from '../src/host/autonomyPolicy/selfApproval.js';
import { listChain } from '../src/host/auditChainService.js';
import type { RunSubjectV2 } from '../src/host/runOwner.js';
import {
  AUTONOMY_TOGGLE, bindClientPresetIfAbsent,
} from '../src/host/autonomyPolicy/index.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';
import { nodes as orchestrationNodes } from '../../../packs/feature.campaign-orchestration.nodes/index.mjs';

const TENANT = 'default';
const GATE = 'feature.campaign-orchestration.nodes.autonomy-gate';
const WF = 'wf.adr1131.sole-admin-gate';
let server: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;
let orgId: string;
let campaign: MarketingCampaign;
let soloOrgId: string;
let soloCampaign: MarketingCampaign;
let n = 0;

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

async function gateRun(opts: { tagged?: boolean; actingUserId?: string; extra?: Record<string, unknown>; campaign?: MarketingCampaign } = {}): Promise<{ run: RunRecord; interruptId?: string; status: string }> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-adr1131-${n++}-${Math.random().toString(36).slice(2, 8)}`, workflowId: WF, tenantId: TENANT, status: 'pending', inputs: {},
    metadata: {
      ...(opts.tagged === false ? {} : { campaignOrchestration: stampCampaignRun(opts.campaign ?? campaign, { role: 'spine' }) }),
      actingUserId: opts.actingUserId ?? 'u-requester',
      ...(opts.extra ?? {}),
    },
    configurable: {}, createdAt: now, updatedAt: now,
  };
  await insertRunWithStartContext(storage, run, { admission: { plan: 'exempt:test-fixture' } });
  const def = (await hostSuite.workflowCatalog.getWorkflow(WF))?.definition;
  if (!def) throw new Error('gate workflow not registered');
  const stored = (await storage.getRun(run.runId)) ?? run;
  const status = (await executeRun(storage, stored, def)).status;
  const [open] = await storage.listOpenInterrupts(run.runId);
  return { run: (await storage.getRun(run.runId)) ?? stored, ...(open ? { interruptId: open.interruptId } : {}), status };
}

const statusOf = async (runId: string): Promise<string | undefined> => (await storage.getRun(runId))?.status;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo).port; res(); }); });
  // The pack node, wrapped the way `packs/tarballLoader.ts` wraps every pack node
  // (a non-success return becomes `failure` with the node's own code).
  getNodeRegistry().register({
    typeId: GATE, version: '1.0.0',
    execute: async (ctx) => {
      const r = await orchestrationNodes[GATE](ctx);
      if (r.status === 'success') return { status: 'success', outputs: r.outputs };
      return { status: 'failure', error: { code: r.error?.code ?? 'pack_node_error', message: r.error?.message ?? 'Pack node returned non-success outcome' } };
    },
  });
  const def: WorkflowDefinition = {
    workflowId: WF,
    nodes: [
      { nodeId: 'kernel-approve', typeId: GATE, config: { actionClass: 'plan.approve', prompt: 'Approve the messaging kernel?' } },
      { nodeId: 'after', typeId: 'core.noop', config: {} },
    ],
    edges: [{ edgeId: 'e1', sourceNodeId: 'kernel-approve', targetNodeId: 'after', triggerRule: 'all_success' }],
  };
  registerHostWorkflow(def);
  await setToggle('campaign-orchestration', true);
  await setToggle(AUTONOMY_TOGGLE, true);
  orgId = (await createOrg({ tenantId: TENANT, createdBy: 'u-owner', name: 'Client A', ownerSubject: 'u-owner' })).orgId;
  for (const [subject, role] of [['u-requester', 'admin'], ['u-admin-2', 'admin'], ['u-admin-3', 'admin'], ['u-editor', 'editor']] as const) {
    await createMember({ tenantId: TENANT, orgId, subject, displayName: subject, roles: [role] });
  }
  await bindClientPresetIfAbsent(TENANT, orgId, 'guarded@1', 'u-owner');
  const brief = await createBrief(TENANT, orgId, 'u-owner', { name: 'Spring launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  campaign = (await ensureDraftCampaign(TENANT, brief, 'u-owner')).campaign;
  // the sole-admin self-approval ADR — a client org whose ONLY member is its owner, u-solo.
  soloOrgId = (await createOrg({ tenantId: TENANT, createdBy: 'u-solo', name: 'One-person firm', ownerSubject: 'u-solo' })).orgId;
  await bindClientPresetIfAbsent(TENANT, soloOrgId, 'guarded@1', 'u-solo');
  const soloBrief = await createBrief(TENANT, soloOrgId, 'u-solo', { name: 'Solo launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  soloCampaign = (await ensureDraftCampaign(TENANT, soloBrief, 'u-solo')).campaign;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const session = (subjectId: string): RunSubjectV2 => ({ issuer: 'urn:openwop-app:session', subjectId, tenant: TENANT, lane: 'session', kind: 'user' });
const REFUSED = { httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } };

describe('the sole-admin self-approval ADR (D1) — the sole admin may approve their own autonomy gate', () => {
  it('the only admin approves their own request from their session, and it is audited', async () => {
    const before = (await listChain(TENANT)).length;
    const { run, interruptId } = await gateRun({ campaign: soloCampaign, actingUserId: 'u-solo' });
    if (!interruptId) throw new Error('expected an open gate');
    expect((await storage.getInterrupt(interruptId))?.data).toMatchObject({ autonomy: { actionClass: 'plan.approve' } });
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'approve' }, { subjectRef: 'u-solo', resolvedBy: session('u-solo') });
    await __awaitRunResumeChainForTests(run.runId);
    expect(await statusOf(run.runId)).toBe('completed');
    const rows = (await listChain(TENANT)).slice(before).filter((e) => e.kind === 'autonomy.self_approval.sole_admin');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ gateId: interruptId, surface: 'interrupt', decider: 'u-solo', orgId: soloOrgId, reason: 'sole_admin', otherApprovers: 0 });
  });

  it('the same vote without a session (API-key / host lane) is refused and the gate stays open', async () => {
    const { run, interruptId } = await gateRun({ campaign: soloCampaign, actingUserId: 'u-solo' });
    if (!interruptId) throw new Error('expected an open gate');
    await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'approve' }, { subjectRef: 'u-solo' })).rejects.toMatchObject(REFUSED);
    const { key } = await issueApiKey({ scopes: ['*'], tenantId: TENANT, name: 'solo key', createdBy: 'u-solo' });
    await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'approve' }, { subjectRef: `apikey:${key.keyId}`, resolvedBy: session(`apikey:${key.keyId}`) })).rejects.toMatchObject({ httpStatus: 403 });
    expect((await storage.getInterrupt(interruptId))?.resolvedAt).toBeUndefined();
    expect(await statusOf(run.runId)).toBe('waiting-approval');
  });

  it('a second admin added while the gate waits restores the two-person rule at decide time', async () => {
    const own = await (async () => {
      const org = (await createOrg({ tenantId: TENANT, createdBy: 'u-solo-b', name: 'Growing firm', ownerSubject: 'u-solo-b' })).orgId;
      await bindClientPresetIfAbsent(TENANT, org, 'guarded@1', 'u-solo-b');
      const b = await createBrief(TENANT, org, 'u-solo-b', { name: 'Growing launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
      return { org, campaign: (await ensureDraftCampaign(TENANT, b, 'u-solo-b')).campaign };
    })();
    const { run, interruptId } = await gateRun({ campaign: own.campaign, actingUserId: 'u-solo-b' });
    if (!interruptId) throw new Error('expected an open gate');
    await createMember({ tenantId: TENANT, orgId: own.org, subject: 'u-second-admin', displayName: 'Second admin', roles: ['admin'] });
    await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'approve' }, { subjectRef: 'u-solo-b', resolvedBy: session('u-solo-b') })).rejects.toMatchObject(REFUSED);
    expect(await statusOf(run.runId)).toBe('waiting-approval');
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'approve' }, { subjectRef: 'u-second-admin', resolvedBy: session('u-second-admin') });
    await __awaitRunResumeChainForTests(run.runId);
    expect(await statusOf(run.runId)).toBe('completed');
  });

  it('in the shared client org (other admins present) the requester stays refused even from a session', async () => {
    const { interruptId } = await gateRun();
    if (!interruptId) throw new Error('expected an open gate');
    await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'approve' }, { subjectRef: 'u-requester', resolvedBy: session('u-requester') })).rejects.toMatchObject(REFUSED);
  });
});

describe('the sole-admin self-approval ADR (D1) — the floors the escape never crosses', () => {
  const base = () => ({ tenantId: TENANT, orgId: soloOrgId, gateId: `g-${n++}`, voter: 'u-solo', humanSession: true, submitters: [], refs: { approverRoleRefs: ['owner', 'admin'] }, quorum: false, surface: 'test' });
  const run = (metadata: Record<string, unknown> = {}, forkMode?: 'branch') => ({ tenantId: TENANT, metadata: { actingUserId: 'u-solo', ...metadata }, ...(forkMode ? { forkMode } : {}) });

  it('the baseline (person, admin, nobody else) is allowed — so each refusal below is the floor', async () => {
    expect(await soleAdminSelfApproval({ ...base(), runs: [run()] })).toMatchObject({ allowed: true, record: { reason: 'sole_admin', otherApprovers: 0 } });
  });
  it('a non-admin requester is refused', async () => {
    await createMember({ tenantId: TENANT, orgId: soloOrgId, subject: 'u-solo-editor', displayName: 'Editor', roles: ['editor'] });
    expect(await soleAdminSelfApproval({ ...base(), voter: 'u-solo-editor', runs: [run({ actingUserId: 'u-solo-editor' })] })).toEqual({ allowed: false, why: 'not_admin' });
  });
  it.each([
    ['not a session', { humanSession: false }, 'not_a_person'],
    ['an agent identity', { voter: 'agent:planner' }, 'not_a_person'],
    ['a quorum gate', { quorum: true }, 'quorum'],
  ] as const)('%s is refused', async (_label, patch, why) => {
    expect(await soleAdminSelfApproval({ ...base(), ...patch, runs: [run()] })).toEqual({ allowed: false, why });
  });
  it('an MCP-origin run is refused', async () => {
    expect(await soleAdminSelfApproval({ ...base(), runs: [run({ source: 'mcp-server-mount' })] })).toEqual({ allowed: false, why: 'mcp_origin' });
  });
  it('an attended branch fork is refused', async () => {
    expect(await soleAdminSelfApproval({ ...base(), runs: [run({}, 'branch')] })).toEqual({ allowed: false, why: 'attended_fork' });
  });
  it('a named approver other than the requester means refused', async () => {
    expect(await soleAdminSelfApproval({ ...base(), refs: { approverRefs: ['u-named-reviewer'] }, runs: [run()] })).toEqual({ allowed: false, why: 'other_approver' });
  });
  it('any failure inside the check is a refusal, never an escape', async () => {
    const broken = { tenantId: TENANT, get metadata(): Record<string, unknown> { throw new Error('storage unavailable'); } };
    expect(await soleAdminSelfApproval({ ...base(), runs: [broken] })).toEqual({ allowed: false, why: 'error' });
  });
});

describe('Sole-admin ADR D1 — "a person" is read only from the auth Subject', () => {
  const subject = (lane: RunSubjectV2['lane'], kind: RunSubjectV2['kind']): RunSubjectV2 => ({ issuer: 'urn:test', subjectId: 's', tenant: TENANT, lane, kind });
  it.each([
    ['the app session', subject('session', 'user'), true],
    ['an OIDC sign-in', subject('oidc', 'user'), true],
    ['a SAML sign-in', subject('saml', 'user'), true],
    ['an API key (workload)', subject('api-key', 'workload'), false],
    ['an anonymous surface', subject('anonymous', 'anonymous'), false],
    ['no Subject at all', undefined, false],
  ] as const)('%s → %s', (_label, s, expected) => {
    expect(isHumanSignInSubject(s)).toBe(expected);
  });
});
