/**
 * ADR 0954 P1 — lead binding, the grade projection, the `grade-lead` node and
 * chain, and the client-scoped routes (route level: createApp + listen + cookie).
 *
 * Exit criteria (witnessed):
 *  - a grade for client A is a 404 to an operator who holds client B only, on
 *    every lead route;
 *  - an older run cannot overwrite a newer grade (the ADR 0837 A7 rule);
 * plus: the real chain grades a bound lead end to end; a contact belongs to one
 * client; a run started for client A cannot grade client B's lead; models need
 * `host:members:manage` on the client; the sub-toggle gates everything.
 *
 * Sabotage-witnessed (P1): dropping the `pendingRunId` check in
 * `recordLeadGrade` reds "an older run cannot overwrite"; dropping the 404
 * conversion in `authorizeLeadClient` reds the B-only case; dropping the stamp
 * check in the `gradeLead` surface op reds "a run started for client A".
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { buildCrmSurface } from '../src/features/crm/surface.js';
import { getLeadBindingId, getLeadGrade, getLeadRoutingDecision, listLeadProfiles, getPendingGrade, getPendingLeadRoute, recordLeadGrade, stampPendingGrade, bindLead } from '../src/features/crm/leadIntel/leadStore.js';
import { contentHashOf, V0_CONTENT } from '../src/features/crm/leadIntel/model.js';
import { activateModel, resolveActiveModel, saveModelVersion } from '../src/features/crm/leadIntel/modelStore.js';
import { GRADE_LEAD_WORKFLOW_ID, ROUTE_LEAD_WORKFLOW_ID, LEAD_INTEL_RUN_STAMP, LEAD_INTEL_TOGGLE } from '../src/features/crm/leadIntel/constants.js';
import { fromWireRunId, toWireRunId } from '../src/host/v2Ids.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { sweepDispatchOutbox } from '../src/host/runDispatchSweeper.js';
import { startWorkflowRun } from '../src/host/runStarter.js';
import { DISPATCH_OUTBOX_HINT_GRACE_MS } from '../src/host/runInsert.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import type { RunRecord } from '../src/types.js';
import { latestRoutingPolicy, saveRoutingPolicy } from '../src/features/crm/leadIntel/routingPolicy.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let orgA: string;
let orgB: string;
let admin: string;
let opA: string;
let opB: string;
let hostSuite: HostAdapterSuite;
const cookies: Record<string, string> = {};

const cookieFor = (userId: string, home: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant: home, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
async function call<T = Record<string, unknown>>(who: string, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<{ status: number; body: T; raw: string; replay: boolean }> {
  const res = await fetch(`${BASE}/host/openwop-app/crm/clients${path}`, {
    method, headers: { cookie: cookies[who]!, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw, replay: res.headers.get('openwop-idempotent-replay') === 'true' };
}
const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  hostSuite = app.locals.hostSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await setToggle('crm', 'on');
  await setToggle(LEAD_INTEL_TOGGLE, 'on');
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:li-owner' })).tenantId;
  const mk = async (p: string): Promise<string> => (await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:li-${p}`, source: 'oidc' })).userId;
  admin = await mk('admin'); opA = await mk('op-a'); opB = await mk('op-b');
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin, displayName: 'Admin', roles: ['admin'] });
  for (const u of [opA, opB]) await createMember({ tenantId: TENANT, orgId: TENANT, subject: u, displayName: u, roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: opA, displayName: 'opA', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgB, subject: opB, displayName: 'opB', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: admin, displayName: 'Admin', roles: ['admin'] });
  for (const [k, u] of Object.entries({ admin, opA, opB })) cookies[k] = cookieFor(u, `ws:home-${k}`);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { vi.restoreAllMocks(); });

const newContact = async (name: string): Promise<string> =>
  (await createContact({ tenantId: TENANT, name, email: `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@example.test`, stage: 'lead' } as Parameters<typeof createContact>[0])).contactId;

async function waitForGrade(orgId: string, contactId: string, runId: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if ((await getLeadGrade(TENANT, orgId, contactId))?.runId === runId) return;
    const run = await hostExtStorage().getRun(runId);
    if (run && ['failed', 'cancelled'].includes(run.status)) throw new Error(`grade run ended: ${JSON.stringify(run.error)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('grade never recorded');
}

describe('ADR 0954 P1 — leads per client', () => {
  it('the real chain grades a bound lead; the B-only operator gets 404 on every A route', async () => {
    const contactId = await newContact('Avery');
    const bound = await call('opA', 'POST', `/${orgA}/leads`, { contactId, source: 'form' });
    expect(bound.status, bound.raw).toBe(201);
    const started = await call<{ runId: string; modelId: string; modelVersion: number }>('opA', 'POST', `/${orgA}/leads/${contactId}/grade`);
    expect(started.status, started.raw).toBe(202);
    expect(started.body).toMatchObject({ modelId: 'v0', modelVersion: 0 });
    await waitForGrade(orgA, contactId, started.body.runId);
    const seen = await call<{ grade: { band: string; score: number } }>('opA', 'GET', `/${orgA}/leads/${contactId}/grade`);
    expect(seen.status).toBe(200);
    expect(seen.body.grade).toMatchObject({ band: 'F', score: 0 });
    const explained = await call<{ stale: boolean }>('opA', 'GET', `/${orgA}/leads/${contactId}/grade?explain=1`);
    expect(explained.body.stale).toBe(false);

    for (const [method, path] of [['GET', `/${orgA}/leads`], ['GET', `/${orgA}/leads/${contactId}/grade`], ['POST', `/${orgA}/leads/${contactId}/grade`], ['POST', `/${orgA}/leads`], ['GET', `/${orgA}/leads/models/active`]] as const) {
      const r = await call('opB', method, path, method === 'POST' && path.endsWith('/leads') ? { contactId } : undefined);
      expect(r.status, `${method} ${path}: ${r.raw}`).toBe(404);
    }
    // The workspace root is never a client.
    expect((await call('admin', 'GET', `/${TENANT}/leads`)).status).toBe(404);
  });

  it('a contact belongs to one client', async () => {
    const contactId = await newContact('Blake');
    expect((await call('opA', 'POST', `/${orgA}/leads`, { contactId })).status).toBe(201);
    expect((await call('opA', 'POST', `/${orgA}/leads`, { contactId })).status).toBe(200); // idempotent
    const other = await call('opB', 'POST', `/${orgB}/leads`, { contactId });
    expect(other.status).toBe(409);
  });

  it('an older run cannot overwrite a newer grade', async () => {
    const contactId = await newContact('Casey');
    await bindLead({ tenantId: TENANT, orgId: orgA, contactId, source: 'manual', boundBy: opA });
    const bindingId = await getLeadBindingId(TENANT, orgA, contactId);
    const pin = { bindingId, modelId: 'v0', modelVersion: 0, modelHash: contentHashOf(V0_CONTENT), definitionHash: 'd'.repeat(64), requesterHash: 'e'.repeat(64) };
    await stampPendingGrade(TENANT, orgA, contactId, 'run-old', pin);
    await stampPendingGrade(TENANT, orgA, contactId, 'run-new', pin);
    const g = { modelId: 'v0', modelVersion: 0, modelHash: pin.modelHash, score: 1, band: 'E' as const, parts: {}, inputsDigest: 'x', truncated: false };
    expect(await recordLeadGrade(TENANT, orgA, contactId, 'run-new', { ...g, score: 7 }, bindingId)).toBe('recorded');
    expect(await recordLeadGrade(TENANT, orgA, contactId, 'run-old', { ...g, score: 99 }, bindingId)).toBe('superseded');
    expect(await recordLeadGrade(TENANT, orgA, contactId, 'run-fork-of-new', { ...g, score: 99 }, bindingId)).toBe('superseded');
    expect((await getLeadGrade(TENANT, orgA, contactId))?.score).toBe(7);
  });

  it('a run started for client A cannot grade client B’s lead', async () => {
    const contactId = await newContact('Drew');
    await bindLead({ tenantId: TENANT, orgId: orgB, contactId, source: 'manual', boundBy: opB });
    const runId = `run-li-${randomBytes(4).toString('hex')}`;
    await hostExtStorage().insertRun({
      runId, workflowId: 'w', tenantId: TENANT, status: 'running', inputs: null,
      metadata: { [LEAD_INTEL_RUN_STAMP]: { orgId: orgA, contactId } }, configurable: {}, createdAt: 'x', updatedAt: 'x',
    });
    const surface = buildCrmSurface({ tenantId: TENANT, runId } as BundleScope);
    await expect(surface.gradeLead!({ orgId: orgB, contactId })).rejects.toMatchObject({ details: { reason: 'wrong_client' } });
  });

  it('models need host:members:manage on the client; the sub-toggle gates the routes', async () => {
    const model = { signals: [{ signalId: 'funnel.completion', weight: 10 }], bands: { A: 50, B: 40, C: 30, D: 20, E: 10 } };
    const byOp = await call('opA', 'POST', `/${orgA}/leads/models/standard`, { expectedVersion: 0, model });
    expect(byOp.status).toBe(403);
    const byAdmin = await call<{ model: { version: number } }>('admin', 'POST', `/${orgA}/leads/models/standard`, { expectedVersion: 0, model });
    expect(byAdmin.status, byAdmin.raw).toBe(201);
    expect((await call('admin', 'POST', `/${orgA}/leads/models/standard`, { expectedVersion: 0, model: { ...model, signals: [{ signalId: 'nope', weight: 1 }] } })).status).toBe(422);
    expect((await call('admin', 'POST', `/${orgA}/leads/models/standard/activate`, { version: 1, expected: null })).status).toBe(200);
    const active = await call<{ modelId: string; version: number }>('opA', 'GET', `/${orgA}/leads/models/active`);
    expect(active.body).toMatchObject({ modelId: 'standard', version: 1 });

    await setToggle(LEAD_INTEL_TOGGLE, 'off');
    try {
      expect((await call('opA', 'GET', `/${orgA}/leads`)).status).toBe(404);
    } finally {
      await setToggle(LEAD_INTEL_TOGGLE, 'on');
    }
  });
});

async function completedRun(runId: string): Promise<RunRecord> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const run = await hostExtStorage().getRun(runId);
    if (run?.status === 'completed') return run;
    if (run && ['failed', 'cancelled'].includes(run.status)) throw new Error(`lead run ended: ${JSON.stringify(run.error)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('lead run did not complete');
}

async function changeActiveModel(): Promise<string> {
  const current = await resolveActiveModel(TENANT, orgA);
  const modelId = `pin-${randomBytes(4).toString('hex')}`;
  await saveModelVersion({ tenantId: TENANT, orgId: orgA, modelId, expectedVersion: 0, content: V0_CONTENT, actor: admin });
  await activateModel({ tenantId: TENANT, orgId: orgA, modelId, version: 1, actor: admin, expected: current.modelId === 'v0' ? null : { modelId: current.modelId, version: current.version } });
  return modelId;
}
async function publicPost(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await fetch(`${BASE}${path}`, { method: 'POST', headers: { cookie: cookies.admin!, 'content-type': 'application/json', 'OpenWOP-Version': '2' }, body: JSON.stringify(body) });
  const raw = await response.text();
  return { status: response.status, body: JSON.parse(raw) as Record<string, unknown>, raw };
}

describe('ADR 0954 P1 — host-pinned starts, retries and real forks', () => {
  it.each([
    { phase: 'before', mode: 'grade', workflowId: GRADE_LEAD_WORKFLOW_ID },
    { phase: 'after', mode: 'grade', workflowId: GRADE_LEAD_WORKFLOW_ID },
    { phase: 'before', mode: 'route', workflowId: ROUTE_LEAD_WORKFLOW_ID },
    { phase: 'after', mode: 'route', workflowId: ROUTE_LEAD_WORKFLOW_ID },
  ] as const)('an uncertain $phase-insert $mode retries the same run and model after the active model changes', async ({ phase, mode, workflowId }) => {
    const contactId = await newContact(`Retry-${mode}-${phase}`);
    await bindLead({ tenantId: TENANT, orgId: orgA, contactId, source: 'manual', boundBy: opA });
    const selected = await resolveActiveModel(TENANT, orgA);
    const requestKey = `grade-retry-${randomBytes(8).toString('hex')}`;
    const storage = hostExtStorage();
    const insert = storage.insertRun.bind(storage);
    const get = storage.getRun.bind(storage);
    let attemptedRun: string | undefined;
    let uncertainRead: string | undefined;
    const getFault = vi.spyOn(storage, 'getRun').mockImplementation(async (runId) => {
      if (runId === uncertainRead) { uncertainRead = undefined; throw new Error('acknowledgement cannot be confirmed'); }
      return get(runId);
    });
    const insertFault = vi.spyOn(storage, 'insertRun').mockImplementation(async (run, opts) => {
      const stamp = run.metadata?.[LEAD_INTEL_RUN_STAMP] as { contactId?: unknown } | undefined;
      if (!attemptedRun && run.workflowId === workflowId && stamp?.contactId === contactId) {
        attemptedRun = run.runId;
        expect(await getPendingGrade(TENANT, orgA, contactId)).toMatchObject({ runId: attemptedRun, pin: { modelId: selected.modelId, modelVersion: selected.version, modelHash: selected.contentHash } });
        if (mode === 'route') expect(await getPendingLeadRoute(TENANT, orgA, contactId)).toMatchObject({ runId: attemptedRun, pin: { routingEpoch: 1, modelId: selected.modelId, modelVersion: selected.version } });
        expect(opts?.idempotencyCommit).toMatchObject({ key: requestKey, responseStatus: 202 });
        if (phase === 'after') { await insert(run, opts); uncertainRead = run.runId; }
        throw new Error(`uncertain ${phase}-insert stop`);
      }
      return insert(run, opts);
    });
    const first = await call('opA', 'POST', `/${orgA}/leads/${contactId}/${mode}`, undefined, requestKey);
    expect(first.status, first.raw).toBe(500);
    insertFault.mockRestore(); getFault.mockRestore();
    expect(attemptedRun).toEqual(expect.any(String));
    const replacement = await changeActiveModel();
    expect(replacement).not.toBe(selected.modelId);
    const retried = await call<{ runId: string; modelId: string; modelVersion: number; routingEpoch?: number }>('opA', 'POST', `/${orgA}/leads/${contactId}/${mode}`, undefined, requestKey);
    expect(retried.status, retried.raw).toBe(202);
    expect(retried.body).toEqual({ runId: attemptedRun, modelId: selected.modelId, modelVersion: selected.version, ...(mode === 'route' ? { routingEpoch: 1 } : {}) });
    expect(retried.replay).toBe(phase === 'after');
    if (phase === 'after') {
      // createApp disables interval daemons in tests. Drive the real durable
      // outbox worker, as a restarted process does after the lost insert ack.
      const accepted = await storage.getRun(retried.body.runId);
      expect(accepted?.status).toBe('pending');
      const due = Date.parse(accepted!.createdAt) + DISPATCH_OUTBOX_HINT_GRACE_MS + 1;
      expect(await sweepDispatchOutbox({ storage, hostSuite }, 'lead-recovery', due)).toBe(1);
    }
    await waitForGrade(orgA, contactId, retried.body.runId);
    expect(await getLeadGrade(TENANT, orgA, contactId)).toMatchObject({ runId: attemptedRun, modelId: selected.modelId, modelVersion: selected.version, modelHash: selected.contentHash });
    if (mode === 'route') {
      let decision = await getLeadRoutingDecision(TENANT, orgA, contactId, 1);
      for (let attempt = 0; attempt < 300 && !decision; attempt++) {
        const current = await storage.getRun(retried.body.runId);
        if (current && ['failed', 'cancelled'].includes(current.status)) throw new Error(`routing run ended: ${JSON.stringify(current.error)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        decision = await getLeadRoutingDecision(TENANT, orgA, contactId, 1);
      }
      expect(decision).toMatchObject({ runId: attemptedRun, routingEpoch: 1 });
      await completedRun(retried.body.runId);
      expect(await getPendingGrade(TENANT, orgA, contactId)).toBeNull();
    }
    const runs = await storage.listRuns({ tenantId: TENANT, workflowId });
    expect(runs.filter((run) => (run.inputs as { contactId?: unknown } | null)?.contactId === contactId)).toHaveLength(1);
  });

  it.each(['grade', 'route'] as const)('%s uses the frozen model and an actual branch fork cannot replace its grade or assignment', async (mode) => {
    const contactId = await newContact(`Frozen-and-forked-${mode}`);
    if (mode === 'route') {
      const policy = await latestRoutingPolicy(TENANT, orgA);
      await saveRoutingPolicy({ tenantId: TENANT, orgId: orgA, expectedVersion: policy?.version ?? 0, rules: [{ ruleId: 'frozen-owner', strategy: 'named', named: opA }], actor: admin });
    }
    await bindLead({ tenantId: TENANT, orgId: orgA, contactId, source: 'manual', boundBy: opA });
    const selected = await resolveActiveModel(TENANT, orgA);
    const started = await call<{ runId: string }>('opA', 'POST', `/${orgA}/leads/${contactId}/${mode}`);
    expect(started.status, started.raw).toBe(202);
    await waitForGrade(orgA, contactId, started.body.runId);
    await completedRun(started.body.runId);
    const originalDecision = mode === 'route' ? await getLeadRoutingDecision(TENANT, orgA, contactId, 1) : null;
    if (mode === 'route') expect(originalDecision?.chosen).toBe(opA);
    const replacement = await changeActiveModel();
    const surface = buildCrmSurface({ tenantId: TENANT, runId: started.body.runId } as BundleScope);
    await expect(surface.gradeLead!({ orgId: orgA, contactId, modelId: replacement, modelVersion: 1 })).rejects.toMatchObject({ details: { reason: 'model_pin_mismatch' } });
    expect(await surface.gradeLead!({ orgId: orgA, contactId })).toMatchObject({ outcome: 'superseded', modelId: selected.modelId, modelVersion: selected.version });
    const fork = await publicPost(`/runs/${encodeURIComponent(toWireRunId(started.body.runId, TENANT))}:fork`, { fromSeq: 0, mode: 'branch' });
    expect(fork.status, fork.raw).toBe(201);
    expect(fork.body.runId).toEqual(expect.any(String));
    const decoded = fromWireRunId(fork.body.runId as string, TENANT);
    if (!decoded.ok) throw new Error('fork returned a foreign run id');
    let forked = await hostExtStorage().getRun(decoded.runId);
    for (let i = 0; i < 300 && forked && !['completed', 'failed', 'cancelled'].includes(forked.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      forked = await hostExtStorage().getRun(decoded.runId);
    }
    expect(forked?.status, JSON.stringify(forked)).toBe('completed');
    expect(forked?.parentRunId).toBe(started.body.runId);
    expect(await getLeadGrade(TENANT, orgA, contactId)).toMatchObject({ runId: started.body.runId, modelId: selected.modelId, modelVersion: selected.version });
    if (mode === 'route') {
      expect(await getLeadRoutingDecision(TENANT, orgA, contactId, 1)).toEqual(originalDecision);
      expect(await getLeadRoutingDecision(TENANT, orgA, contactId, 2)).toBeNull();
    }
  });

  it.each(['grade', 'route'] as const)('a public metadata-spoof request cannot mint a trusted %s pin', async (mode) => {
    const contactId = await newContact(`Spoofed-pin-${mode}`);
    await bindLead({ tenantId: TENANT, orgId: orgA, contactId, source: 'manual', boundBy: opA });
    const created = await publicPost('/runs', {
      workflowId: mode === 'route' ? ROUTE_LEAD_WORKFLOW_ID : GRADE_LEAD_WORKFLOW_ID,
      inputs: { orgId: orgA, contactId, modelId: 'v0', modelVersion: 0, ...(mode === 'route' ? { routingEpoch: 1 } : {}) },
      metadata: { [LEAD_INTEL_RUN_STAMP]: { orgId: orgA, contactId, bindingId: await getLeadBindingId(TENANT, orgA, contactId), modelId: 'v0', modelVersion: 0, modelHash: contentHashOf(V0_CONTENT), definitionHash: 'd'.repeat(64) } },
    });
    expect(created.status, created.raw).toBe(201);
    const decoded = fromWireRunId(created.body.runId as string, TENANT);
    if (!decoded.ok) throw new Error('public create returned a foreign run id');
    const stored = await hostExtStorage().getRun(decoded.runId);
    expect(stored?.metadata).not.toHaveProperty(LEAD_INTEL_RUN_STAMP);
    const surface = buildCrmSurface({ tenantId: TENANT, runId: decoded.runId } as BundleScope);
    await expect(mode === 'route' ? surface.routeLead!({ orgId: orgA, contactId, routingEpoch: 1 }) : surface.gradeLead!({ orgId: orgA, contactId })).rejects.toMatchObject({ details: { reason: 'wrong_client' } });
    expect(await getLeadGrade(TENANT, orgA, contactId)).toBeNull();
  });
  it('a param-less internal routing chain refuses at its first node without assigning any lead', async () => {
    const storage = hostExtStorage();
    const before = await listLeadProfiles(TENANT, orgA);
    const runId = await startWorkflowRun({ storage, hostSuite }, { tenantId: TENANT, workflowId: ROUTE_LEAD_WORKFLOW_ID, inputs: {}, orgScopeSubject: opA });
    if (!runId) throw new Error('the internal routing workflow did not resolve');
    let run = await storage.getRun(runId);
    for (let attempt = 0; attempt < 300 && run && !['completed', 'failed', 'cancelled'].includes(run.status); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50)); run = await storage.getRun(runId);
    }
    expect(run?.status).toBe('failed'); expect(run?.error).toMatchObject({ code: 'validation_error' });
    const events = await storage.listEvents(runId);
    const failed = events.filter((event) => event.type === 'node.failed');
    expect(failed).toHaveLength(1); expect(failed[0]?.nodeId).toMatch(/_grade$/);
    expect(events.some((event) => event.nodeId?.endsWith('_route'))).toBe(false);
    expect(await listLeadProfiles(TENANT, orgA)).toEqual(before);
  });

  it('a completed route permits a later grade without requiring an extra routing round', async () => {
    const contactId = await newContact('Grade-after-route');
    await bindLead({ tenantId: TENANT, orgId: orgA, contactId, source: 'manual', boundBy: opA });
    const route = await call<{ runId: string; routingEpoch: number }>('opA', 'POST', `/${orgA}/leads/${contactId}/route`);
    expect(route.status, route.raw).toBe(202); await completedRun(route.body.runId);
    const original = await getLeadRoutingDecision(TENANT, orgA, contactId, route.body.routingEpoch);
    expect(original).not.toBeNull();
    const completed = (await hostExtStorage().listEvents(route.body.runId)).find((event) => event.type === 'run.completed');
    expect(completed?.payload).toMatchObject({ outputs: { success: true, chosen: original?.chosen, unassigned: original?.chosen === null } });
    expect(await hostExtStorage().listOpenInterrupts(route.body.runId)).toHaveLength(0);
    const grade = await call<{ runId: string }>('opA', 'POST', `/${orgA}/leads/${contactId}/grade`);
    expect(grade.status, grade.raw).toBe(202); expect(grade.body.runId).not.toBe(route.body.runId);
    await completedRun(grade.body.runId);
    expect(await getLeadGrade(TENANT, orgA, contactId)).toMatchObject({ runId: grade.body.runId });
    expect(await getLeadRoutingDecision(TENANT, orgA, contactId, route.body.routingEpoch)).toEqual(original);
    expect(await getLeadRoutingDecision(TENANT, orgA, contactId, route.body.routingEpoch + 1)).toBeNull();
  });

});

describe('lead model route ownership', () => {
  it('models named grade and active remain readable through unambiguous version routes', async () => {
    for (const modelId of ['grade', 'active']) {
      const saved = await call('admin', 'POST', `/${orgA}/leads/models/${modelId}`, { expectedVersion: 0, model: V0_CONTENT });
      expect(saved.status, saved.raw).toBe(201);
      const read = await call<{ versions: Array<{ modelId: string; version: number }> }>('opA', 'GET', `/${orgA}/leads/models/${modelId}/versions`);
      expect(read.status, read.raw).toBe(200);
      expect(read.body.versions).toEqual([expect.objectContaining({ modelId, version: 1 })]);
    }
    const legacy = await call<{ versions: Array<{ modelId: string }> }>('opA', 'GET', `/${orgA}/leads/models/grade`);
    expect(legacy.status, legacy.raw).toBe(200);
    expect(legacy.body.versions).toEqual([expect.objectContaining({ modelId: 'grade' })]);
    const selected = await call('opA', 'GET', `/${orgA}/leads/models/active`);
    expect(selected.status, selected.raw).toBe(200);
    expect(selected.body).toHaveProperty('modelId');
    expect(selected.body).not.toHaveProperty('versions');
  });
});
