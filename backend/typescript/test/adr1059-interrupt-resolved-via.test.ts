/**
 * ADR 1059 / RFC 0259 — a token resolution records its instrument
 * (`interrupt.resolved.resolvedVia`), never an unauthenticated Subject in
 * `resolvedBy`, and a host binding of the link as `boundTo`.
 *
 *   1. Flag off (the default): a token resolution records neither `resolvedVia`
 *      nor `resolvedBy`, and the advert carries no `interrupt.resolvedVia`.
 *   2. Flag on, unbound: `resolvedVia { scheme: 'interrupt-token' }`, no
 *      `boundTo`, still no `resolvedBy` (§A.1); the advert claims the facet.
 *   3. Flag on, a host-signed voter: `boundTo` is the Subject the session lane
 *      stamps for that user (`requestSubjectV2` on a session request, the
 *      owner mapping — §A.4), and `resolvedBy` stays absent.
 *   4. Flag on, a forged signature binds no one.
 *   5. Flag on, a `capabilityToken` lane that presented NO token (the MCP and
 *      inbound-webhook resumes) records no `resolvedVia`.
 *   6. Flag on, an interrupt that declares eligibility refuses an unbound token
 *      resolution (`resolved_via_unbound`) and accepts a signed one; flag off it
 *      does not refuse on this ground.
 *
 * Red when: the emitters stop spreading `resolvedVia` (2, 3); the binding check
 * is dropped or a body voter is trusted (4); `tokenPresented` is ignored (5); the
 * eligibility refusal is removed (6); the flag gate is removed (1). Sabotage
 * record in ADR 1059 §Tests.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { setChatStorage } from '../src/host/chatSurface.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { executeRun } from '../src/executor/executor.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { __awaitRunResumeChainForTests, resolveAndResume } from '../src/routes/interrupts.js';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import { signVoterBinding } from '../src/host/interruptVoterBinding.js';
import { RESOLVED_VIA_FLAG } from '../src/host/interruptResolvedVia.js';
import { requestSubjectV2 } from '../src/host/runOwner.js';
import type { AppConfig } from '../src/index.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr1059-')) });
setChatStorage(storage);
const hostSuite = createHostAdapterSuite({ storage });

const WF_ID = 'wf.adr1059-gate';
const TENANT = 't-1059';
const CONFIG: AppConfig = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false };
const TOKEN_LANE = { capabilityToken: true, tokenPresented: true } as const;

beforeAll(() => {
  ensureNodesRegistered();
  const def: WorkflowDefinition = {
    workflowId: WF_ID,
    nodes: [
      { nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Approve?' } },
      { nodeId: 'after', typeId: 'core.noop', config: {} },
    ],
    edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'after' }],
  };
  registerHostWorkflow(def);
});
afterEach(() => { delete process.env[RESOLVED_VIA_FLAG]; });

async function suspendedGate(): Promise<{ run: RunRecord; interrupt: InterruptRecord }> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-1059-${Math.random().toString(36).slice(2)}`, workflowId: WF_ID, tenantId: TENANT,
    status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const def = (await hostSuite.workflowCatalog.getWorkflow(WF_ID))!.definition;
  expect((await executeRun(storage, run, def)).status).toBe('waiting-approval');
  const [interrupt] = await storage.listOpenInterrupts(run.runId);
  return { run, interrupt: interrupt! };
}

async function resolvedPayload(runId: string): Promise<Record<string, unknown>> {
  await __awaitRunResumeChainForTests(runId);
  const e = (await storage.listEvents(runId)).find((x) => x.type === 'interrupt.resolved');
  expect(e, 'no interrupt.resolved was logged').toBeDefined();
  return e!.payload as Record<string, unknown>;
}

const sessionReq = (userId: string): Request => ({ userId, tenantId: TENANT, principal: { principalId: userId, auth: { kind: 'session' } } }) as unknown as Request;

describe('ADR 1059 — flag off (the default)', () => {
  it('a token resolution records neither resolvedVia nor resolvedBy, and the facet is not advertised', async () => {
    const { run, interrupt } = await suspendedGate();
    await resolveAndResume(storage, hostSuite, interrupt.interruptId, { action: 'accept', voter: 'u-ana', voterSig: signVoterBinding(interrupt.token, 'u-ana') }, TOKEN_LANE);
    const p = await resolvedPayload(run.runId);
    expect(p['resolvedVia']).toBeUndefined();
    expect(p['resolvedBy']).toBeUndefined();
    expect((buildV2Advertisement(CONFIG)['interrupt'] as Record<string, unknown>)['resolvedVia']).toBeUndefined();
  });
});

describe('ADR 1059 — flag on', () => {
  it('an unbound token resolution records scheme interrupt-token, no boundTo, no resolvedBy; the facet is advertised', async () => {
    process.env[RESOLVED_VIA_FLAG] = 'true';
    const { run, interrupt } = await suspendedGate();
    await resolveAndResume(storage, hostSuite, interrupt.interruptId, { action: 'accept' }, TOKEN_LANE);
    const p = await resolvedPayload(run.runId);
    expect(p['resolvedVia']).toEqual({ scheme: 'interrupt-token' });
    expect(p['resolvedBy']).toBeUndefined();
    expect((buildV2Advertisement(CONFIG)['interrupt'] as Record<string, unknown>)['resolvedVia']).toBe(true);
  });

  it('a token REJECT records resolvedVia too (the single-approver reject emitter)', async () => {
    process.env[RESOLVED_VIA_FLAG] = 'true';
    const { run, interrupt } = await suspendedGate();
    await resolveAndResume(storage, hostSuite, interrupt.interruptId, { action: 'reject' }, TOKEN_LANE);
    const p = await resolvedPayload(run.runId);
    expect(p).toMatchObject({ decision: 'rejected', action: 'reject', resolvedVia: { scheme: 'interrupt-token' } });
    expect(p['resolvedBy']).toBeUndefined();
  });

  it('a host-signed voter is boundTo, the Subject the session lane stamps for that user; resolvedBy stays absent', async () => {
    process.env[RESOLVED_VIA_FLAG] = 'true';
    const { run, interrupt } = await suspendedGate();
    await resolveAndResume(storage, hostSuite, interrupt.interruptId, { action: 'accept', voter: 'u-ana', voterSig: signVoterBinding(interrupt.token, 'u-ana') }, TOKEN_LANE);
    const p = await resolvedPayload(run.runId);
    const owner = requestSubjectV2(sessionReq('u-ana'), TENANT);
    expect(owner).toMatchObject({ kind: 'user', lane: 'session', tenant: TENANT });
    expect(p['resolvedVia']).toEqual({
      scheme: 'interrupt-token', boundTo: owner, mintedAt: interrupt.createdAt,
      ...(interrupt.expiresAt ? { expiresAt: interrupt.expiresAt } : {}),
    });
    expect(p['resolvedBy']).toBeUndefined();
  });

  it('a forged voter signature binds no one', async () => {
    process.env[RESOLVED_VIA_FLAG] = 'true';
    const { run, interrupt } = await suspendedGate();
    await resolveAndResume(storage, hostSuite, interrupt.interruptId, { action: 'accept', voter: 'u-ana', voterSig: signVoterBinding(interrupt.token, 'u-mallory') }, TOKEN_LANE);
    const p = await resolvedPayload(run.runId);
    expect(p['resolvedVia']).toEqual({ scheme: 'interrupt-token' });
  });

  it('a capabilityToken lane that presented no token (MCP, inbound webhook) records no resolvedVia', async () => {
    process.env[RESOLVED_VIA_FLAG] = 'true';
    const { run, interrupt } = await suspendedGate();
    await resolveAndResume(storage, hostSuite, interrupt.interruptId, { action: 'accept' }, { capabilityToken: true });
    const p = await resolvedPayload(run.runId);
    expect(p['resolvedVia']).toBeUndefined();
  });
});

describe('ADR 1059 — an interrupt that declares eligibility (RFC 0259 §A.4)', () => {
  async function aclClarification(): Promise<InterruptRecord> {
    const now = new Date().toISOString();
    const runId = `run-1059-acl-${Math.random().toString(36).slice(2)}`;
    await storage.insertRun({ runId, workflowId: WF_ID, tenantId: TENANT, status: 'waiting-input', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now });
    const rec = { interruptId: `i-${runId}`, runId, nodeId: 'ask', kind: 'clarification', token: `tok-${runId}`, data: { approverRefs: ['u-ana'], questions: [{ id: 'q', question: 'Why?' }] }, createdAt: now } as unknown as InterruptRecord;
    await storage.insertInterrupt(rec);
    return rec;
  }

  it('flag on: an unbound token resolution is refused before anything is claimed', async () => {
    process.env[RESOLVED_VIA_FLAG] = 'true';
    const rec = await aclClarification();
    await expect(resolveAndResume(storage, hostSuite, rec.interruptId, { voter: 'u-ana', answers: [{ id: 'q', answer: 'x' }] }, TOKEN_LANE))
      .rejects.toMatchObject({ code: 'forbidden', details: { reason: 'resolved_via_unbound' } });
    expect((await storage.getInterrupt(rec.interruptId))?.resolvedAt).toBeFalsy();
  });

  it('flag on: a signed voter is not refused on this ground', async () => {
    process.env[RESOLVED_VIA_FLAG] = 'true';
    const rec = await aclClarification();
    const outcome = await resolveAndResume(storage, hostSuite, rec.interruptId, { voter: 'u-ana', voterSig: signVoterBinding(rec.token, 'u-ana'), answers: [{ id: 'q', answer: 'x' }] }, TOKEN_LANE).then(() => null, (e: unknown) => e);
    expect((outcome as { details?: { reason?: unknown } } | null)?.details?.reason).not.toBe('resolved_via_unbound');
  });

  it('flag off: the same unbound resolution is not refused on this ground', async () => {
    const rec = await aclClarification();
    const outcome = await resolveAndResume(storage, hostSuite, rec.interruptId, { voter: 'u-ana', answers: [{ id: 'q', answer: 'x' }] }, TOKEN_LANE).then(() => null, (e: unknown) => e);
    expect((outcome as { details?: { reason?: unknown } } | null)?.details?.reason).not.toBe('resolved_via_unbound');
  });
});
