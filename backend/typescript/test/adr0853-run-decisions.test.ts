/**
 * ADR 0853 D6 — a project run that REPORTS decisions feeds them in as suggestions.
 * Real app, real executor, the real run-terminal seam:
 *   - a completed, project-stamped run whose output has `decisions` ⇒ one
 *     suggestion each (strings or `{summary}`), linked to the run, capped;
 *   - an unstamped run, or a run without `decisions` ⇒ nothing.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { executeRun } from '../src/executor/executor.js';
import { listSuggestions } from '../src/features/team-intent-ledger/suggestions.js';
import { MAX_PER_RUN, reportedDecisions } from '../src/features/team-intent-ledger/runDecisionsSource.js';
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
  registerHostWorkflow({ workflowId: 'wf.d6.echo', name: 'echo', version: '1.0.0', nodes: [{ nodeId: 'echo', typeId: 'core.identity', config: {} }], edges: [] } as unknown as WorkflowDefinition);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) as any };
  };
  return { post: (p: string, b?: unknown) => call('POST', p, b) };
}
async function setup() {
  const tenantId = `org:d6-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: `d6-${n++}@acme.test`, tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'MeetCo' })).body.orgId as string;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string; boardId: string };
  expect((await owner.post(`/host/openwop-app/team-ledger/projects/${proj.id}`)).status).toBe(201);
  return { tenantId, ownerId, projectId: proj.id, boardId: proj.boardId };
}
async function runEcho(s: { tenantId: string; ownerId: string; boardId: string }, inputs: unknown, onProject = true): Promise<string> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-d6-${n++}`, workflowId: 'wf.d6.echo', tenantId: s.tenantId, status: 'pending', inputs,
    metadata: onProject ? { kanban: { boardId: s.boardId, cardId: 'c1' }, actingUserId: s.ownerId } : {},
    configurable: {}, createdAt: now, updatedAt: now,
  };
  await insertRunWithStartContext(storage, run);
  const def = (await hostSuite.workflowCatalog.getWorkflow('wf.d6.echo'))!.definition;
  const r = await executeRun(storage, (await storage.getRun(run.runId))!, def);
  expect(r.status).toBe('completed');
  return run.runId;
}

describe('ADR 0853 D6 — runs that report decisions', () => {
  it('reads strings and {summary}; drops blanks; caps', () => {
    expect(reportedDecisions({ decisions: ['A', { summary: 'B' }, '  ', 3, { x: 1 }] })).toEqual(['A', 'B']);
    expect(reportedDecisions({ decisions: Array.from({ length: 30 }, (_, i) => `d${i}`) })).toHaveLength(MAX_PER_RUN);
    expect(reportedDecisions({ other: 1 })).toEqual([]);
  });

  it('a completed project run reporting decisions ⇒ one suggestion each, linked to the run', async () => {
    const s = await setup();
    const runId = await runEcho(s, { decisions: ['Ship EU first', { summary: 'Price stays at $49' }] });
    await vi.waitFor(async () => expect(await listSuggestions(s.tenantId, s.projectId)).toHaveLength(2), { timeout: 5000 });
    const list = await listSuggestions(s.tenantId, s.projectId);
    expect(list.map((x) => x.text).sort()).toEqual(['Price stays at $49', 'Ship EU first']);
    expect(list[0]!.source).toMatchObject({ kind: 'meeting', link: `/runs/${runId}` });
  });

  it('an unstamped run, or one with no decisions ⇒ nothing', async () => {
    const s = await setup();
    await runEcho(s, { decisions: ['Not a project run'] }, false);
    await runEcho(s, { summary: 'no decisions field' });
    await new Promise((r) => setTimeout(r, 300));
    expect(await listSuggestions(s.tenantId, s.projectId)).toHaveLength(0);
  });
});
