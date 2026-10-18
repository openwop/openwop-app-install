/**
 * ADR 0853 D6 — a project run that REPORTS decisions feeds them in as suggestions.
 * Real app, real executor, the real run-terminal seam:
 *   - a completed, project-stamped run whose output has `decisions` ⇒ one
 *     suggestion each (strings or `{summary}`), linked to the run, capped;
 *   - a run without `decisions` ⇒ nothing.
 *
 * Sabotage-witnessed (/grade-tests w29): the cap, the `{summary}` read, the
 * blank drop, the `onAnyRunTerminal` subscription (`feature.ts`) and the
 * `meeting` source kind each red their case. The negative case awaits the
 * terminal fan-out (`fireAnyRunTerminal`) instead of sleeping, and carries a
 * positive control so "nothing" is read after the subscriber has run. An
 * "unstamped run ⇒ nothing" leg was cut: an unstamped run names no project to
 * write to, so it could not fail (probe w29g3-rn-unstamped-VAC); the stamp
 * itself is `adr0831-team-ledger-stamp.test.ts`'s claim.
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
import { fireAnyRunTerminal } from '../src/executor/runLifecycle.js';
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
  const echo: WorkflowDefinition = { workflowId: 'wf.d6.echo', nodes: [{ nodeId: 'echo', typeId: 'core.identity', config: {} }], edges: [] };
  registerHostWorkflow(echo);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The fields these legs read off a response. */
interface ResBody { user?: { userId: string }; orgId?: string; id?: string; boardId?: string }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: ResBody }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    const parsed = res.status === 204 ? undefined : ((await res.json().catch(() => undefined)) as ResBody | undefined);
    return { status: res.status, body: parsed ?? {} };
  };
  return { post: (p: string, b?: unknown) => call('POST', p, b) };
}
async function setup() {
  const tenantId = `org:d6-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: `d6-${n++}@acme.test`, tenantId })).body.user!.userId;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'MeetCo' })).body.orgId!;
  const created = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body;
  const proj = { id: created.id!, boardId: created.boardId! };
  expect((await owner.post(`/host/openwop-app/team-ledger/projects/${proj.id}`)).status).toBe(201);
  return { tenantId, ownerId, projectId: proj.id, boardId: proj.boardId };
}
async function runEcho(s: { tenantId: string; ownerId: string; boardId: string }, inputs: Record<string, unknown>): Promise<string> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-d6-${n++}`, workflowId: 'wf.d6.echo', tenantId: s.tenantId, status: 'pending', inputs,
    metadata: { kanban: { boardId: s.boardId, cardId: 'c1' }, actingUserId: s.ownerId },
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
    for (const x of list) {
      expect(x).toMatchObject({ status: 'open', source: { kind: 'meeting', link: `/runs/${runId}` }, suggestedBy: { kind: 'host', id: 'run:wf.d6.echo' } });
    }
    expect(list.map((x) => x.source.ref).sort()).toEqual([`${runId}:0`, `${runId}:1`]);
  });

  it('a project run with no decisions ⇒ nothing', async () => {
    const s = await setup();
    const quiet = await runEcho(s, { summary: 'no decisions field' });
    // Await the terminal fan-out (every subscriber) instead of sleeping. Safe:
    // a run with no decisions writes nothing, so the racing fire-and-forget copy
    // cannot double-insert.
    expect(await fireAnyRunTerminal(quiet, 'completed')).toBeGreaterThan(0);
    expect(await listSuggestions(s.tenantId, s.projectId)).toHaveLength(0);
    // Positive control: the same project, the same seam, WITH a decision ⇒ exactly one.
    await runEcho(s, { decisions: ['control'] });
    await vi.waitFor(async () => expect((await listSuggestions(s.tenantId, s.projectId)).map((x) => x.text)).toEqual(['control']), { timeout: 5000 });
  });
});
