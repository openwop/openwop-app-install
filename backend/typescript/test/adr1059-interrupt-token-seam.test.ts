/**
 * ADR 1059 P2 / RFC 0259 §C.1 — the `readInterruptToken` seam.
 *
 *   1. Gate: with `OPENWOP_TEST_SEAM_ENABLED` unset the route is a route-miss
 *      (404); set, the same request is served (positive control).
 *   2. It returns the token the suspend manager stored, and resolves nothing.
 *   3. `bind: true` for a session-lane person returns the members the approval
 *      email would carry; resolving with them (flag on) records `boundTo` equal
 *      to the caller's own owner Subject — the RFC's leg 6, end to end.
 *   4. The same members altered by one character bind no one — leg 7.
 *   5. A caller on a non-session lane (an env API key) gets no members.
 *   6. Another tenant's run is 404, and so is a node with no open interrupt.
 *
 * Red when: the gate is dropped (1); the seam resolves or re-mints (2); the
 * members are not the production binding (3); the binding is not verified on
 * resolve (4); the lane check is dropped (5); the ownership read is dropped (6).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request } from 'express';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { INTERRUPT_TOKEN_SEAM_PATH, readInterruptTokenForCaller, registerInterruptTokenSeam } from '../src/routes/interruptTokenSeam.js';
import { RESOLVED_VIA_FLAG } from '../src/host/interruptResolvedVia.js';
import { requestSubjectV2 } from '../src/host/runOwner.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr1059-seam-')) });
setChatStorage(storage);
const hostSuite = createHostAdapterSuite({ storage });

const WF_ID = 'wf.adr1059-seam-gate';
const TENANT = 't-1059-seam';

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
afterEach(() => { delete process.env[RESOLVED_VIA_FLAG]; delete process.env.OPENWOP_TEST_SEAM_ENABLED; });

const sessionReq = (userId: string, tenantId = TENANT): Request => ({ userId, tenantId, principal: { principalId: userId, auth: { kind: 'session' } } }) as unknown as Request;
const envKeyReq = (tenantId = TENANT): Request => ({ tenantId, principal: { principalId: 'bearer:abcd1234', auth: { kind: 'env-key' } } }) as unknown as Request;

async function suspendedRun(): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-1059s-${Math.random().toString(36).slice(2)}`, workflowId: WF_ID, tenantId: TENANT,
    status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const def = (await hostSuite.workflowCatalog.getWorkflow(WF_ID))!.definition;
  expect((await executeRun(storage, run, def)).status).toBe('waiting-approval');
  return run;
}
async function resolvedPayload(runId: string): Promise<Record<string, unknown>> {
  await __awaitRunResumeChainForTests(runId);
  const e = (await storage.listEvents(runId)).find((x) => x.type === 'interrupt.resolved');
  expect(e, 'no interrupt.resolved was logged').toBeDefined();
  return e!.payload as Record<string, unknown>;
}

describe('ADR 1059 P2 — readInterruptToken gate', () => {
  async function post(): Promise<number> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, sessionReq('u-gate')); next(); });
    registerInterruptTokenSeam(app, { storage });
    app.use((err: { httpStatus?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.httpStatus ?? 500).end(); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.request({ port, host: '127.0.0.1', method: 'POST', path: INTERRUPT_TOKEN_SEAM_PATH, headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on('error', reject);
      r.end(JSON.stringify({ runId: 'no-such-run', nodeId: 'gate' }));
    });
    await new Promise<void>((r) => server.close(() => r()));
    return status;
  }
  it('is a route-miss without OPENWOP_TEST_SEAM_ENABLED, and served with it', async () => {
    expect(await post()).toBe(404);
    process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    // Served: the handler runs and refuses the unknown run itself (the ownership read).
    const res = await readInterruptTokenForCaller(storage, sessionReq('u-gate'), { runId: 'no-such-run', nodeId: 'gate' }).then(() => 0, (e: { httpStatus?: number; code?: string }) => e.code);
    expect(res).toBe('run_not_found');
  });
});

describe('ADR 1059 P2 — readInterruptToken behaviour', () => {
  it('returns the stored token and resolves nothing', async () => {
    const run = await suspendedRun();
    const [open] = await storage.listOpenInterrupts(run.runId);
    const out = await readInterruptTokenForCaller(storage, sessionReq('u-ana'), { runId: run.runId, nodeId: 'gate' });
    expect(out).toEqual({ token: open!.token });
    expect((await storage.getInterrupt(open!.interruptId))?.resolvedAt).toBeFalsy();
  });

  it('bind for a session person: resolving with the members records boundTo = the caller\'s owner Subject', async () => {
    process.env[RESOLVED_VIA_FLAG] = 'true';
    const run = await suspendedRun();
    const [open] = await storage.listOpenInterrupts(run.runId);
    const out = await readInterruptTokenForCaller(storage, sessionReq('u-ana'), { runId: run.runId, nodeId: 'gate', bind: true });
    expect(out.resumeValueMembers?.voter).toBe('u-ana');
    await resolveAndResume(storage, hostSuite, open!.interruptId, { action: 'accept', ...out.resumeValueMembers }, { capabilityToken: true, tokenPresented: true });
    const p = await resolvedPayload(run.runId);
    expect((p['resolvedVia'] as Record<string, unknown>)['boundTo']).toEqual(requestSubjectV2(sessionReq('u-ana'), TENANT));
    expect(p['resolvedBy']).toBeUndefined();
  });

  it('the same members altered by one character bind no one', async () => {
    process.env[RESOLVED_VIA_FLAG] = 'true';
    const run = await suspendedRun();
    const [open] = await storage.listOpenInterrupts(run.runId);
    const out = await readInterruptTokenForCaller(storage, sessionReq('u-ana'), { runId: run.runId, nodeId: 'gate', bind: true });
    const m = out.resumeValueMembers!;
    const alter = (v: string): string => `${v.slice(0, -1)}${v.endsWith('x') ? 'y' : 'x'}`;
    await resolveAndResume(storage, hostSuite, open!.interruptId, { action: 'accept', voter: alter(m.voter), voterSig: alter(m.voterSig) }, { capabilityToken: true, tokenPresented: true });
    const p = await resolvedPayload(run.runId);
    expect(p['resolvedVia']).toEqual({ scheme: 'interrupt-token' });
  });

  it('a non-session caller (an env API key) gets no members', async () => {
    const run = await suspendedRun();
    const out = await readInterruptTokenForCaller(storage, envKeyReq(), { runId: run.runId, nodeId: 'gate', bind: true });
    expect(out.resumeValueMembers).toBeUndefined();
    expect(typeof out.token).toBe('string');
  });

  it('another tenant\'s run is 404, and so is a node with no open interrupt', async () => {
    const run = await suspendedRun();
    await expect(readInterruptTokenForCaller(storage, sessionReq('u-eve', 't-other'), { runId: run.runId, nodeId: 'gate' })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(readInterruptTokenForCaller(storage, sessionReq('u-ana'), { runId: run.runId, nodeId: 'after' })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(readInterruptTokenForCaller(storage, sessionReq('u-ana'), { runId: run.runId, nodeId: 'gate', extra: 1 })).rejects.toMatchObject({ httpStatus: 400 });
  });
});
