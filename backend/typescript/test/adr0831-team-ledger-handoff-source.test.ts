/**
 * ADR 0831 P3 — a structured handoff record (ADR 0829) as a write-back source.
 *
 * Real app, real sign-ins. The card path goes over HTTP (the assign route is
 * what announces the note); the run path announces through the core seam with a
 * run the P2 contributor really stamped.
 *
 *   - a card note on the project's board with a NEW open question ⇒ exactly one
 *     proposed delta: author = the person, source = handoff, the list is the
 *     ledger's plus the new question, version unchanged (nothing accepts);
 *   - the same note announced again (same ref) ⇒ still one;
 *   - questions already on the ledger (case/space-insensitive) or no questions
 *     ⇒ nothing; toggle OFF ⇒ nothing; a board that is not a project's ⇒ nothing;
 *   - a VIEWER's note stays a note (propose needs write, as everywhere else);
 *   - a run's record: proposed as the agent, only with an acting user who can
 *     write; no acting user ⇒ nothing.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { createMember } from '../src/host/accessControlService.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { notifyHandoffRecorded } from '../src/host/handoff/handoffObservers.js';
import { normalizeHandoffRecord } from '../src/host/handoff/handoffRecord.js';
import type { RunRecord } from '../src/types.js';

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

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
type Client = ReturnType<typeof client>;
const email = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
const K = '/host/openwop-app/kanban';

async function setup() {
  const tenantId = `org:tlh-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('tlh-owner'), tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'HandCo' })).body.orgId as string;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string; boardId: string };
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  expect((await owner.post(L)).status).toBe(201);
  // One question already on the ledger, so "already held" is exercised.
  const seeded = await owner.post(`${L}/write`, { patch: { openQuestions: ['Is the date fixed?'] }, why: 'seed', baseVersion: 1 });
  expect(seeded.status, JSON.stringify(seeded.body)).toBeLessThan(300);
  return { tenantId, orgId, owner, ownerId, projectId: proj.id, boardId: proj.boardId, L };
}

async function cardOn(c: Client, boardId: string): Promise<string> {
  const r = await c.post(`${K}/boards/${boardId}/cards`, { columnId: 'todo', title: 'Launch brief' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const assignWithNote = (c: Client, cardId: string, openQuestions: string[]) =>
  c.post(`${K}/cards/${cardId}/assign`, { assigneeRole: 'editor', handoff: { intent: 'Finish the launch brief', openQuestions } });
const handoffDeltas = async (c: Client, L: string): Promise<any[]> =>
  ((await c.get(`${L}/deltas`)).body.deltas as any[]).filter((d) => d.source?.kind === 'handoff');

describe('ADR 0831 P3 — handoff notes propose open questions to the ledger', () => {
  it('a card note with a new question ⇒ ONE proposed delta, as the person, nothing accepted; re-announcing adds none', async () => {
    const s = await setup();
    const before = (await s.owner.get(s.L)).body.ledger.version as number;
    const cardId = await cardOn(s.owner, s.boardId);
    const r = await assignWithNote(s.owner, cardId, ['is the date  FIXED?', 'Who signs off on copy?']);
    expect(r.status).toBe(200);

    const ds = await handoffDeltas(s.owner, s.L);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      status: 'proposed',
      author: { kind: 'user', id: s.ownerId },
      patch: { openQuestions: ['Is the date fixed?', 'Who signs off on copy?'] },
      baseVersion: before,
    });
    expect(ds[0].source.ref).toMatch(new RegExp(`^card:${cardId}:`));
    expect(ds[0].why).toContain('Finish the launch brief');
    expect((await s.owner.get(s.L)).body.ledger.version).toBe(before);

    // The same note again (a retry) — same ref ⇒ no second proposal. The stored
    // note is the record (asserted: an undefined record would be swallowed by
    // the fail-soft seam and this leg would pass for the wrong reason).
    const stored = r.body.card.handoff;
    expect(stored.openQuestions).toHaveLength(2);
    await notifyHandoffRecorded({ tenantId: s.tenantId, record: stored, origin: { kind: 'card', cardId, boardId: s.boardId, ref: ds[0].source.ref, by: s.ownerId } });
    expect(await handoffDeltas(s.owner, s.L)).toHaveLength(1);
    // Positive control for the dedupe: a DIFFERENT ref with the same note does propose.
    await notifyHandoffRecorded({ tenantId: s.tenantId, record: stored, origin: { kind: 'card', cardId, boardId: s.boardId, ref: `${ds[0].source.ref}:other`, by: s.ownerId } });
    expect(await handoffDeltas(s.owner, s.L)).toHaveLength(2);
  });

  it('only questions the ledger already holds, or none ⇒ nothing proposed', async () => {
    const s = await setup();
    expect((await assignWithNote(s.owner, await cardOn(s.owner, s.boardId), ['  is the date fixed? '])).status).toBe(200);
    expect((await assignWithNote(s.owner, await cardOn(s.owner, s.boardId), [])).status).toBe(200);
    expect(await handoffDeltas(s.owner, s.L)).toHaveLength(0);
  });

  it('a board that is not a project board ⇒ nothing', async () => {
    const s = await setup();
    const b = await s.owner.post(`${K}/boards`, { name: 'Loose' });
    expect((await assignWithNote(s.owner, await cardOn(s.owner, b.body.id), ['A brand new question?'])).status).toBe(200);
    expect(await handoffDeltas(s.owner, s.L)).toHaveLength(0);
  });

  it("a viewer's note is announced but proposes nothing (propose needs write)", async () => {
    const s = await setup();
    const cardId = await cardOn(s.owner, s.boardId);
    const viewer = client();
    const viewerId = (await viewer.post('/host/openwop-app/test/login', { email: email('tlh-viewer'), tenantId: s.tenantId })).body.user.userId as string;
    await createMember({ tenantId: s.tenantId, orgId: s.orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
    // The viewer cannot assign over HTTP; announce as they would have.
    const record = normalizeHandoffRecord({ intent: 'x', openQuestions: ['A brand new question?'] }, 'human')!;
    await notifyHandoffRecorded({ tenantId: s.tenantId, record, origin: { kind: 'card', cardId, boardId: s.boardId, ref: `card:${cardId}:v`, by: viewerId } });
    expect(await handoffDeltas(s.owner, s.L)).toHaveLength(0);
  });

  it("a run's record ⇒ proposed as the agent with a writing acting user; no acting user ⇒ nothing", async () => {
    const s = await setup();
    const mkRun = async (actingUserId?: string): Promise<string> => {
      const now = new Date().toISOString();
      const run: RunRecord = {
        runId: `run-tlh-${n++}`, workflowId: 'wf.test.tlh', tenantId: s.tenantId, status: 'pending', inputs: {},
        metadata: { kanban: { boardId: s.boardId, cardId: 'c1' }, ...(actingUserId ? { actingUserId } : {}) },
        configurable: {}, createdAt: now, updatedAt: now,
      };
      await insertRunWithStartContext(storage, run);
      return run.runId;
    };
    const record = normalizeHandoffRecord({ intent: 'Draft the EU page', openQuestions: ['Which legal entity?'] }, 'agent')!;

    const anon = await mkRun(undefined);
    await notifyHandoffRecorded({ tenantId: s.tenantId, record, origin: { kind: 'run', runId: anon, ref: 'dispatch:e0:w', agentId: 'agent.sup' } });
    expect(await handoffDeltas(s.owner, s.L)).toHaveLength(0);

    const runId = await mkRun(s.ownerId);
    await notifyHandoffRecorded({ tenantId: s.tenantId, record, origin: { kind: 'run', runId, ref: 'dispatch:e1:w', agentId: 'agent.sup' } });
    const ds = await handoffDeltas(s.owner, s.L);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ status: 'proposed', author: { kind: 'agent', id: 'agent.sup' }, source: { kind: 'handoff', ref: 'dispatch:e1:w' } });
    expect(ds[0].patch.openQuestions).toEqual(['Is the date fixed?', 'Which legal entity?']);
  });
});
