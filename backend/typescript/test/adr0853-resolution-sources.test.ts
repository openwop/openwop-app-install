/**
 * ADR 0853 D5 — resolved approvals and answered clarifications on a project
 * run, end to end: real app, real executor, the real `resolveAndResume`.
 *
 *   - an approval gate resolved by a person ⇒ ONE suggestion ("Approved: …" /
 *     "Rejected: …") linked to the run; nothing on the ledger moves;
 *   - a clarification whose question is a ledger open question, answered ⇒ ONE
 *     proposed delta removing it, the answer as the reason; nothing accepted;
 *   - a clarification about anything else ⇒ nothing; a run on no project ⇒ nothing;
 *   - announcing the same resolution again adds nothing (idempotent).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { executeRun } from '../src/executor/executor.js';
import { __awaitRunResumeChainForTests, resolveAndResume } from '../src/routes/interrupts.js';
import { notifyInterruptResolved } from '../src/host/interruptResolutionObservers.js';
import { getLedger, listDeltas } from '../src/features/team-intent-ledger/ledgerStore.js';
import { listSuggestions } from '../src/features/team-intent-ledger/suggestions.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const wf = (id: string, gate: Record<string, unknown>) => registerHostWorkflow({
    workflowId: id, name: id, version: '1.0.0',
    nodes: [gate, { nodeId: 'after', typeId: 'core.noop', config: {} }],
    edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'after' }],
  } as unknown as WorkflowDefinition);
  wf('wf.d5.approval', { nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Ship the EU page?', rejectionPolicy: 'single-veto' } });
  wf('wf.d5.clarify-held', { nodeId: 'gate', typeId: 'core.clarificationGate', config: { question: 'Which launch date?' } });
  wf('wf.d5.clarify-other', { nodeId: 'gate', typeId: 'core.clarificationGate', config: { question: 'What colour is the button?' } });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) as any };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

async function setup() {
  const tenantId = `org:d5-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: `d5-${n++}@acme.test`, tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'ResCo' })).body.orgId as string;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string; boardId: string };
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  expect((await owner.post(L)).status).toBe(201);
  expect((await owner.post(`${L}/write`, { patch: { openQuestions: ['which launch DATE?', 'Who owns pricing?'] }, why: 'kickoff', baseVersion: 1 })).status).toBeLessThan(300);
  return { tenantId, ownerId, projectId: proj.id, boardId: proj.boardId };
}

/** A run on the project's board (so it is stamped), suspended at its gate. */
async function suspendedOnProject(s: { tenantId: string; ownerId: string; boardId: string } | null, workflowId: string) {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-d5-${n++}`, workflowId, tenantId: s?.tenantId ?? 'demo', status: 'pending', inputs: {},
    metadata: s ? { kanban: { boardId: s.boardId, cardId: 'c1' }, actingUserId: s.ownerId } : {},
    configurable: {}, createdAt: now, updatedAt: now,
  };
  await insertRunWithStartContext(storage, run);
  const def = (await hostSuite.workflowCatalog.getWorkflow(workflowId))!.definition;
  const r = await executeRun(storage, (await storage.getRun(run.runId))!, def);
  expect(r.status.startsWith('waiting')).toBe(true);
  const [interrupt] = await storage.listOpenInterrupts(run.runId);
  return { runId: run.runId, interrupt: interrupt! };
}

describe('ADR 0853 D5 — resolutions as ledger sources', () => {
  it('a resolved approval ⇒ one suggestion linked to the run; the ledger does not move', async () => {
    const s = await setup();
    const { runId, interrupt } = await suspendedOnProject(s, 'wf.d5.approval');
    await resolveAndResume(storage, hostSuite, interrupt.interruptId, { action: 'approve' }, { subjectRef: `user:${s.ownerId}` });
    await __awaitRunResumeChainForTests(runId);
    const sug = await listSuggestions(s.tenantId, s.projectId);
    expect(sug).toHaveLength(1);
    expect(sug[0]).toMatchObject({ title: 'Approved: Ship the EU page?', source: { kind: 'approval', ref: interrupt.interruptId, link: `/runs/${runId}` }, suggestedBy: { kind: 'host' } });
    expect((await getLedger(s.tenantId, s.projectId))!.version).toBe(2);
    // Announced again (a retried resolve): still one.
    await notifyInterruptResolved({ runId, interruptId: interrupt.interruptId, kind: 'approval', outcome: 'accepted', data: interrupt.data, resumeValue: {} });
    expect(await listSuggestions(s.tenantId, s.projectId)).toHaveLength(1);
  });

  it('an answered clarification that matches an open question ⇒ one proposal closing it', async () => {
    const s = await setup();
    const { runId, interrupt } = await suspendedOnProject(s, 'wf.d5.clarify-held');
    await resolveAndResume(storage, hostSuite, interrupt.interruptId, 'March 3rd', { subjectRef: `user:${s.ownerId}` });
    await __awaitRunResumeChainForTests(runId);
    const ledger = (await getLedger(s.tenantId, s.projectId))!;
    const proposals = (await listDeltas(s.tenantId, ledger.ledgerId)).filter((d) => d.source?.kind === 'run');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ status: 'proposed', why: 'Answered: March 3rd', patch: { openQuestions: ['Who owns pricing?'] } });
    expect(ledger.version).toBe(2);
    await notifyInterruptResolved({ runId, interruptId: interrupt.interruptId, kind: 'clarification', outcome: 'accepted', data: interrupt.data, resumeValue: 'March 3rd' });
    expect((await listDeltas(s.tenantId, ledger.ledgerId)).filter((d) => d.source?.kind === 'run')).toHaveLength(1);
  });

  it('a clarification about anything else, or a run on no project ⇒ nothing', async () => {
    const s = await setup();
    const other = await suspendedOnProject(s, 'wf.d5.clarify-other');
    await resolveAndResume(storage, hostSuite, other.interrupt.interruptId, 'Blue', { subjectRef: `user:${s.ownerId}` });
    await __awaitRunResumeChainForTests(other.runId);
    const loose = await suspendedOnProject(null, 'wf.d5.approval');
    await resolveAndResume(storage, hostSuite, loose.interrupt.interruptId, { action: 'approve' }, { capabilityToken: true });
    await __awaitRunResumeChainForTests(loose.runId);
    const ledger = (await getLedger(s.tenantId, s.projectId))!;
    expect((await listDeltas(s.tenantId, ledger.ledgerId)).filter((d) => d.source?.kind === 'run')).toHaveLength(0);
    expect(await listSuggestions(s.tenantId, s.projectId)).toHaveLength(0);
  });
});
