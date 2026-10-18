/**
 * ADR 0831 P2 — the run stamp and read-before-act, on real runs.
 *
 *   - a run on the project's BOARD (host-written `kanban.boardId`) is stamped with
 *     the ledger's CURRENT version (asserted after the ledger has moved past 1);
 *   - the binding is checked against the run's acting user: a user who cannot read
 *     the project gets no stamp even if their run names the board;
 *   - a caller cannot pre-set `teamLedger` through `POST /runs` (reserved key);
 *   - `:fork` over the real route keeps the source's version after the ledger
 *     moves, and never GAINS a stamp its source lacked (ADR 0604);
 *   - the context provider returns the state AT the stamped version, fenced as
 *     untrusted, and nothing for another tenant;
 *   - the live dispatch puts the fenced block before `Task:`.
 *
 * Sabotage-witnessed (w29): a stamp pinned to version 1, the acting-user access
 * check dropped, `teamLedger` un-reserved, `derivedFromRun` ignored, `stateAt`
 * returning the latest, the fence dropped, the blocks dropped from dispatch.
 * Honest double guards (no single sabotage reds them): the fork keeping v1 is held
 * by BOTH `derivedFromRun` and run-start's "fork-copied values win" merge; the
 * other-tenant read is held by BOTH the provider's tenant check and the
 * tenant-scoped `stateAt`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { createMember } from '../src/host/accessControlService.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { fromWireRunId, toWireRunId } from '../src/host/v2Ids.js';
import { collectRunContextBlocks } from '../src/host/runContextProviders.js';
import { readTeamLedgerStamp } from '../src/features/team-intent-ledger/runStamp.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { runAgentDispatchLive } from '../src/host/agentDispatch.js';
import type { AiCallRequest, AiCallResult } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';
import { getLedger } from '../src/features/team-intent-ledger/ledgerStore.js';
import type { TeamLedger } from '../src/features/team-intent-ledger/types.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The response fields this file reads, typed against the real records (an absent field fails the case). */
interface Body { ledger: TeamLedger; user: { userId: string }; orgId: string; id: string; boardId: string; runId: string; fixtures?: string[] }
interface Res { status: number; body: Body }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as Body };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
/** A v2 response carries the minted, tenant-bound run id (`<tenant>/<id>`); storage keys the local id. */
function localRunId(wire: string, tenantId: string): string {
  const r = fromWireRunId(wire, tenantId);
  if (!r.ok) throw new Error(`run id ${wire} is not this tenant's`);
  return r.runId;
}
const email = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

async function setup() {
  const tenantId = `org:tls-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('tls-owner'), tenantId })).body.user.userId;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'StampCo' })).body.orgId;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string; boardId: string };
  await owner.patch(`/host/openwop-app/projects/${proj.id}`, { charter: { goal: 'Ship the launch', objectives: ['EU live'] } });
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  expect((await owner.post(L)).status).toBe(201);
  return { tenantId, orgId, owner, ownerId, projectId: proj.id, boardId: proj.boardId, L };
}

async function boardRun(tenantId: string, boardId: string, actingUserId: string | undefined, extra: Record<string, unknown> = {}, workflowId = 'wf.test.tls'): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    // ≥16 chars: the v2 opaque grammar, so the id can be tenant-bound on a major-2 path.
    runId: `run-tls-${String(n++).padStart(12, '0')}`, workflowId, tenantId, status: 'pending', inputs: {},
    metadata: { kanban: { boardId, cardId: 'c1' }, ...(actingUserId ? { actingUserId } : {}), ...extra },
    configurable: {}, createdAt: now, updatedAt: now,
  };
  await insertRunWithStartContext(storage, run);
  return (await storage.getRun(run.runId))!;
}

describe('ADR 0831 P2 — run stamp', () => {
  it('a run on the project board is stamped with the current version', async () => {
    const s = await setup();
    // Move the ledger past its creation version, so "current" is distinguishable from 1.
    expect((await s.owner.post(`${s.L}/write`, { patch: { inScope: ['EU'] }, why: 'v2' })).body.ledger.version).toBe(2);
    const run = await boardRun(s.tenantId, s.boardId, s.ownerId);
    expect(readTeamLedgerStamp(run.metadata)).toEqual({ ledgerId: (await getLedger(s.tenantId, s.projectId))!.ledgerId, version: 2 });
  });

  it('a user who cannot read the project gets no stamp, even naming its board', async () => {
    const s = await setup();
    // Make the project private, then use a co-tenant viewer who is not a member.
    expect((await s.owner.patch(`/host/openwop-app/projects/${s.projectId}/visibility`, { visibility: 'private' })).status).toBe(200);
    const viewer = client();
    const viewerId = (await viewer.post('/host/openwop-app/test/login', { email: email('tls-viewer'), tenantId: s.tenantId })).body.user.userId;
    await createMember({ tenantId: s.tenantId, orgId: s.orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
    expect(readTeamLedgerStamp((await boardRun(s.tenantId, s.boardId, viewerId)).metadata)).toBeUndefined();
    expect(readTeamLedgerStamp((await boardRun(s.tenantId, s.boardId, s.ownerId)).metadata)).toBeDefined();
  });

  it('a caller cannot pre-set teamLedger through POST /runs', async () => {
    const s = await setup();
    const disco = await s.owner.get('/.well-known/openwop');
    const workflowId = disco.body?.fixtures?.[0] ?? 'openwop-app.uppercase';
    const r = await s.owner.post('/runs', { workflowId, inputs: {}, metadata: { teamLedger: { ledgerId: 'tl_forged', version: 99 } } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const run = await storage.getRun(localRunId(r.body.runId, s.tenantId));
    // Not board-bound, so the honest outcome is NO stamp — the forged one is stripped, not kept.
    expect(readTeamLedgerStamp(run!.metadata)).toBeUndefined();
    expect((run!.metadata as Record<string, unknown>).teamLedger).toBeUndefined();
  });

  it(':fork over the real route keeps the source version after the ledger moves', async () => {
    const s = await setup();
    const disco = await s.owner.get('/.well-known/openwop');
    const workflowId = disco.body?.fixtures?.[0] ?? 'openwop-app.uppercase';
    // A board-bound run on a REAL workflow, so the fork route can resolve it.
    const src = await boardRun(s.tenantId, s.boardId, s.ownerId, {}, workflowId);
    expect(readTeamLedgerStamp(src.metadata)?.version).toBe(1);
    // The fork route forks from an event; give the source log one.
    await getEventLog().append({ runId: src.runId, type: 'run.started', payload: { workflowId } });
    expect((await s.owner.post(`${s.L}/write`, { patch: { goal: 'Ship the EU launch first' }, why: 'Scope cut' })).body.ledger.version).toBe(2);
    const forked = await s.owner.post(`/runs/${encodeURIComponent(toWireRunId(src.runId, s.tenantId))}:fork`, { fromSeq: 0, mode: 'replay' });
    expect(forked.status, JSON.stringify(forked.body)).toBe(201);
    const fork = await storage.getRun(localRunId(forked.body.runId, s.tenantId));
    expect(readTeamLedgerStamp(fork!.metadata)?.version).toBe(1); // NOT 2: the fork acts on what its source acted on
  });
});

describe('ADR 0831 P2 — a fork never GAINS a stamp its source was born without (ADR 0604)', () => {
  it('a source born without a stamp (e.g. while the ledger was still toggled) stays unstamped on a fork', async () => {
    const s = await setup();
    const disco = await s.owner.get('/.well-known/openwop');
    const workflowId = disco.body?.fixtures?.[0] ?? 'openwop-app.uppercase';
    const born = await boardRun(s.tenantId, s.boardId, s.ownerId, {}, workflowId);
    const { teamLedger: _dropped, ...unstamped } = born.metadata as Record<string, unknown>;
    await storage.updateRun(born.runId, { metadata: unstamped });
    const src = (await storage.getRun(born.runId))!;
    expect(readTeamLedgerStamp(src.metadata)).toBeUndefined();
    await getEventLog().append({ runId: src.runId, type: 'run.started', payload: { workflowId } });
    const forked = await s.owner.post(`/runs/${encodeURIComponent(toWireRunId(src.runId, s.tenantId))}:fork`, { fromSeq: 0, mode: 'replay' });
    expect(forked.status, JSON.stringify(forked.body)).toBe(201);
    expect(readTeamLedgerStamp((await storage.getRun(localRunId(forked.body.runId, s.tenantId)))!.metadata)).toBeUndefined();
  });
});

describe('ADR 0831 P2 — read before act', () => {
  it('the provider returns the state AT the stamped version, fenced', async () => {
    const s = await setup();
    const v1run = await boardRun(s.tenantId, s.boardId, s.ownerId);
    await s.owner.post(`${s.L}/write`, { patch: { goal: 'Ship the EU launch first', openQuestions: ['Is the date fixed?'] }, why: 'Scope cut' });
    const v2run = await boardRun(s.tenantId, s.boardId, s.ownerId);

    const [b1] = await collectRunContextBlocks({ tenantId: s.tenantId, runId: v1run.runId });
    expect(b1).toContain('BEGIN UNTRUSTED CONTENT');
    expect(b1).toContain('version 1');
    expect(b1).toContain('Goal: Ship the launch');
    expect(b1).not.toContain('Is the date fixed?');

    const [b2] = await collectRunContextBlocks({ tenantId: s.tenantId, runId: v2run.runId });
    expect(b2).toContain('version 2');
    expect(b2).toContain('Goal: Ship the EU launch first');
    expect(b2).toContain('Open question: Is the date fixed?');

    // Another tenant asking for this run gets nothing.
    expect(await collectRunContextBlocks({ tenantId: 'org:someone-else', runId: v2run.runId })).toEqual([]);
  });

  it('the live dispatch places the blocks before Task:', async () => {
    const registry = getAgentRegistry();
    registry._resetForTest();
    registry.register({ agentId: 'test.ledger-reader', persona: 'R', modelClass: 'chat', systemPrompt: 'You are R.', packName: 'test', packVersion: '0', toolAllowlist: [] });
    const callAI = vi.fn<(req: AiCallRequest) => Promise<AiCallResult>>(async () => ({ content: 'ok' }));
    await runAgentDispatchLive({ agentId: 'test.ledger-reader', task: 'Draft the brief' }, { callAI, contextBlocks: ['BEGIN UNTRUSTED CONTENT\n- Goal: X\nEND UNTRUSTED CONTENT'] });
    const text = JSON.stringify(callAI.mock.calls[0]![0]);
    expect(text.indexOf('Goal: X')).toBeGreaterThan(-1);
    expect(text.indexOf('Task:')).toBeGreaterThan(text.indexOf('Goal: X'));
  });
});
