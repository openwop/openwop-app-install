/**
 * XCH-TL-1 — the grade-pass findings on the team-ledger tools, each pinned.
 * (Original header of the shared harness follows.)
 * ADR 0831 P3 — the team-ledger agent tools, on a real app.
 *
 *   - both are registered builtins (and NOT on the default-on baseline: the
 *     chief-of-staff pack allowlists them);
 *   - no acting user ⇒ a typed failure, never an empty success;
 *   - the tool shares the route's predicate: a stranger and a toggle-OFF tenant
 *     get the same `not_found`; a viewer can read but `propose` is `forbidden`;
 *   - `propose` only proposes: the version does not move, the author is the
 *     agent, the source is the run; the owner then accepts it over HTTP;
 *   - invalid patches come back as typed tool errors.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { TEAM_LEDGER_GET_TOOL_ID, TEAM_LEDGER_PROPOSE_TOOL_ID } from '../src/features/team-intent-ledger/agentTools.js';
import { getDelta, getLedger, proposeDelta, LEDGER_LIMITS } from '../src/features/team-intent-ledger/ledgerStore.js';
import { createDocument } from '../src/features/documents/documentsService.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
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
const email = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

async function setup() {
  const tenantId = `org:tlt-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('tlt-owner'), tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'ToolCo' })).body.orgId as string;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string };
  await owner.patch(`/host/openwop-app/projects/${proj.id}`, { charter: { goal: 'Ship the launch', objectives: ['EU live'] } });
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  expect((await owner.post(L)).status).toBe(201);
  return { tenantId, orgId, owner, ownerId, projectId: proj.id, L };
}

const call = (tenantId: string, scope: { actingUserId?: string; agentProfileId?: string }, name: string, input: Record<string, unknown>) =>
  createAgentToolProvider({ tenantId, runId: 'run-tlt-1', ...scope }).executeTool({ name, input });
const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, any>;

describe('XCH-TL-1 — grade-pass fixes', () => {
  const P = TEAM_LEDGER_PROPOSE_TOOL_ID;
  const err = async (tenantId: string, who: string, input: Record<string, unknown>) => {
    const r = await call(tenantId, { actingUserId: who }, P, input);
    expect(r.isError, r.content).toBe(true);
    return parse(r);
  };

  it('HIGH — baseVersion is required and checked, never filled in', async () => {
    const s = await setup();
    const base = { projectId: s.projectId, patch: { inScope: ['EU'] }, why: 'w' };
    for (const bad of [undefined, 0, 2, 1.5, '1', 999]) {
      const e = await err(s.tenantId, s.ownerId, bad === undefined ? base : { ...base, baseVersion: bad });
      expect(e.error, String(bad)).toBe('validation_error');
      expect(e.message).toMatch(/baseVersion/);
    }
    // The stale-base guard now holds: a proposal made at v1 after the ledger moved needs `rebased`.
    const ok = parse(await call(s.tenantId, { actingUserId: s.ownerId }, P, { ...base, baseVersion: 1 }));
    await s.owner.post(`${s.L}/write`, { patch: { outOfScope: ['APAC'] }, why: 'moved on' });
    expect((await s.owner.post(`${s.L}/deltas/${ok.deltaId}/accept`)).status).toBe(409);
  });

  it('MEDIUM — refuses instead of rewriting (long, non-string, secret-shaped, empty, too many objectives)', async () => {
    const s = await setup();
    const p = (patch: Record<string, unknown>) => ({ projectId: s.projectId, patch, why: 'w', baseVersion: 1 });
    expect((await err(s.tenantId, s.ownerId, p({ inScope: ['x'.repeat(LEDGER_LIMITS.line + 1)] }))).error).toBe('validation_error');
    expect((await err(s.tenantId, s.ownerId, p({ inScope: [{}] }))).error).toBe('validation_error');
    expect((await err(s.tenantId, s.ownerId, p({ inScope: [`key sk-ant-${'a'.repeat(40)}`] }))).message).toMatch(/secret-shaped/);
    expect((await err(s.tenantId, s.ownerId, p({ inScope: [''] }))).error).toBe('validation_error');
    expect((await err(s.tenantId, s.ownerId, p({ objectives: Array.from({ length: LEDGER_LIMITS.objectives + 1 }, (_, i) => `o${i}`) }))).message).toMatch(/limit is 20/);
    expect((await err(s.tenantId, s.ownerId, p({ goal: 'g'.repeat(LEDGER_LIMITS.goal + 1) }))).error).toBe('validation_error');
    // An explicitly empty list is still allowed: it clears the list on purpose.
    const cleared = parse(await call(s.tenantId, { actingUserId: s.ownerId }, P, p({ openQuestions: [] })));
    expect(cleared.patch).toEqual({ openQuestions: [] });
  });

  it('MEDIUM — the stored patch is echoed, and decisionDocumentIds REPLACES the list', async () => {
    const s = await setup();
    const d1 = await createDocument({ tenantId: s.tenantId, orgId: s.orgId, title: 'Decision — A', kind: 'decision-record', format: 'markdown', createdBy: s.ownerId } as never);
    const d2 = await createDocument({ tenantId: s.tenantId, orgId: s.orgId, title: 'Decision — B', kind: 'decision-record', format: 'markdown', createdBy: s.ownerId } as never);
    expect((await s.owner.post(`${s.L}/write`, { patch: { decisionDocumentIds: [d1.documentId] }, why: 'first' })).status).toBe(200);
    const r = parse(await call(s.tenantId, { actingUserId: s.ownerId }, P, { projectId: s.projectId, patch: { decisionDocumentIds: [d2.documentId] }, why: 'second', baseVersion: 2 }));
    expect(r.patch).toEqual({ decisionDocumentIds: [d2.documentId] });
    expect((await s.owner.post(`${s.L}/deltas/${r.deltaId}/accept`)).status).toBe(200);
    expect((await s.owner.get(s.L)).body.state.decisionDocumentIds).toEqual([d2.documentId]); // replaced, as the description now says
  });

  it('LOW — a visible project with no ledger is `no_ledger`, distinct from not_found', async () => {
    const tenantId = `org:tlg-${Date.now()}-${n++}`;
    const owner = client();
    const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('tlg-owner'), tenantId })).body.user.userId as string;
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'NoLedgerCo' })).body.orgId as string;
    const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Bare' })).body as { id: string };
    const g = await call(tenantId, { actingUserId: ownerId }, TEAM_LEDGER_GET_TOOL_ID, { projectId: proj.id });
    expect(parse(g).error).toBe('no_ledger');
    expect(parse(await call(tenantId, { actingUserId: ownerId }, TEAM_LEDGER_GET_TOOL_ID, { projectId: 'project-nope' })).error).toBe('not_found');
  });

  it('LOW — the owner queue is bounded', async () => {
    const s = await setup();
    const ledger = (await getLedger(s.tenantId, s.projectId))!;
    for (let i = 0; i < LEDGER_LIMITS.pending; i++) {
      await proposeDelta({ ledger, patch: { inScope: [`a${i}`] }, why: 'w', author: { kind: 'agent', id: 'loop' }, baseVersion: 1 });
    }
    const e = await err(s.tenantId, s.ownerId, { projectId: s.projectId, patch: { inScope: ['one more'] }, why: 'w', baseVersion: 1 });
    expect(e.error).toBe('conflict');
    expect(await getDelta(s.tenantId, 'tld_none')).toBeNull();
  });
});
