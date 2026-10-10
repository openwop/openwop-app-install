/**
 * ADR 0854 D1 — "Ask someone else to decide" on ONE pending approval.
 * Real app, real executor (an approval gate with an approver list), real routes.
 *   - an eligible approver hands it to another ELIGIBLE approver with a note; the
 *     target reads it; the handing person can still decide (the vote is unchanged);
 *   - refused: a target outside the approver list (422), a target in the list
 *     whose role cannot respond (422), handing to yourself (422), a caller who
 *     cannot decide it (403), a note without an intent (400);
 *   - DSAR erases the handing person's note and identity.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { executeRun } from '../src/executor/executor.js';
import { ERASED } from '../src/host/subjectErasureRedaction.js';
import { eraseApprovalHandoffSubject, getApprovalHandoff } from '../src/features/structured-handoffs/approvalHandoffs.js';
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
const R = '/host/openwop-app/reviews';
const NOTE = { intent: 'Legal sign-off on the EU copy', openQuestions: ['Is the GDPR line final?'] };

async function setup() {
  const tenantId = `org:ah-${Date.now()}-${n++}`;
  const people: Record<'a' | 'b' | 'c' | 'd', { c: ReturnType<typeof client>; id: string }> = {} as never;
  for (const k of ['a', 'b', 'c', 'd'] as const) {
    const c = client();
    const id = (await c.post('/host/openwop-app/test/login', { email: `ah-${k}-${n++}@acme.test`, tenantId })).body.user.userId as string;
    people[k] = { c, id };
  }
  const orgId = (await people.a.c.post('/host/openwop-app/orgs', { name: 'ApproveCo' })).body.orgId as string;
  for (const k of ['b', 'c'] as const) await createMember({ tenantId, orgId, subject: people[k].id, displayName: k, roles: ['editor'] });
  await createMember({ tenantId, orgId, subject: people.d.id, displayName: 'd', roles: ['viewer'] });
  const wf = `wf.ah.${n++}`;
  registerHostWorkflow({
    workflowId: wf, name: wf, version: '1.0.0',
    nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Ship the EU page?', approverRefs: [people.a.id, people.b.id, people.d.id] } }, { nodeId: 'after', typeId: 'core.noop', config: {} }],
    edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'after' }],
  } as unknown as WorkflowDefinition);
  const now = new Date().toISOString();
  const run: RunRecord = { runId: `run-ah-${n++}`, workflowId: wf, tenantId, status: 'pending', inputs: {}, metadata: { approverOrgId: orgId }, configurable: {}, createdAt: now, updatedAt: now };
  await insertRunWithStartContext(storage, run);
  const def = (await hostSuite.workflowCatalog.getWorkflow(wf))!.definition;
  expect((await executeRun(storage, (await storage.getRun(run.runId))!, def)).status.startsWith('waiting')).toBe(true);
  const [it] = await storage.listOpenInterrupts(run.runId);
  return { tenantId, people, reviewId: `interrupt:${it!.interruptId}` };
}

describe('ADR 0854 D1 — approval handoffs', () => {
  it('an eligible approver hands it to another eligible approver; the target reads the note; the giver can still decide', async () => {
    const s = await setup();
    const r = await s.people.a.c.post(`${R}/${s.reviewId}/handoff`, { to: s.people.b.id, handoff: NOTE });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const seen = await s.people.b.c.get(`${R}/${s.reviewId}/handoff`);
    expect(seen.status).toBe(200);
    expect(seen.body.handoff).toMatchObject({ to: s.people.b.id, by: s.people.a.id, note: { intent: NOTE.intent, producedBy: 'human' } });
    // No authority moved: A still decides, through the unchanged decide route.
    const decided = await s.people.a.c.post(`${R}/${s.reviewId}/actions/approve`, {});
    expect(decided.status, JSON.stringify(decided.body)).toBeLessThan(300);
  });

  it('refused: outside the list, in the list without respond, yourself, a caller who cannot decide, no intent', async () => {
    const s = await setup();
    const url = `${R}/${s.reviewId}/handoff`;
    expect((await s.people.a.c.post(url, { to: s.people.c.id, handoff: NOTE })).status).toBe(422);
    expect((await s.people.a.c.post(url, { to: s.people.d.id, handoff: NOTE })).status).toBe(422);
    expect((await s.people.a.c.post(url, { to: s.people.a.id, handoff: NOTE })).status).toBe(422);
    expect((await s.people.c.c.post(url, { to: s.people.b.id, handoff: NOTE })).status).toBe(403);
    expect((await s.people.a.c.post(url, { to: s.people.b.id, handoff: { openQuestions: ['x'] } })).status).toBe(400);
    expect(await getApprovalHandoff(s.tenantId, s.reviewId)).toBeNull();
  });

  it("DSAR erases the handing person's note and identity", async () => {
    const s = await setup();
    await s.people.a.c.post(`${R}/${s.reviewId}/handoff`, { to: s.people.b.id, handoff: NOTE });
    await eraseApprovalHandoffSubject(s.tenantId, `user:${s.people.a.id}`);
    expect(await getApprovalHandoff(s.tenantId, s.reviewId)).toMatchObject({ by: ERASED, to: s.people.b.id, note: { intent: ERASED, openQuestions: [] } });
  });
});
