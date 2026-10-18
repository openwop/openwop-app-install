/**
 * XCH-TL-1 (ADR 0831 P3) — the grade-pass findings on the team-ledger agent
 * tools, each pinned. The model is told the truth: invalid input is REFUSED with
 * a typed error it can repair, never silently rewritten and reported as success.
 *
 *   - HIGH: `baseVersion` is required and range-checked, never filled in, so the
 *     stale-base guard on accept still holds for an agent's proposal;
 *   - MEDIUM: over-long, non-string, secret-shaped, empty and too-many items are
 *     refused; `[]` still clears a list on purpose;
 *   - MEDIUM: the tool echoes the STORED patch (deduped), and `decisionDocumentIds`
 *     REPLACES the list on accept;
 *   - LOW: a visible project with no ledger is `no_ledger`, distinct from `not_found`;
 *   - LOW: the owner's queue is bounded — the 51st proposal is a `conflict` and is not stored.
 *
 * Sabotage-witnessed (w29): the baseVersion range check, filling a missing
 * baseVersion, the stale guard, the length / secret / list-cap / empty-item
 * checks, echoing the input instead of the stored patch, merging instead of
 * replacing decision ids, no_ledger collapsed into not_found, the pending cap
 * off by one, and tool errors losing `isError` — each turns its case red.
 * Cited by docs/steward/LLM-EXCHANGE-AUDIT.md (XCH-TL-1).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { TEAM_LEDGER_GET_TOOL_ID, TEAM_LEDGER_PROPOSE_TOOL_ID } from '../src/features/team-intent-ledger/agentTools.js';
import { getLedger, listDeltas, proposeDelta, LEDGER_LIMITS } from '../src/features/team-intent-ledger/ledgerStore.js';
import { createDocument } from '../src/features/documents/documentsService.js';
import type { LedgerState, TeamLedger } from '../src/features/team-intent-ledger/types.js';

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

/** The response fields this file reads, typed against the real records (an absent field fails the case). */
interface Body { ledger: TeamLedger; state: LedgerState; user: { userId: string }; orgId: string; id: string }
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
const email = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

async function setup() {
  const tenantId = `org:tlt-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('tlt-owner'), tenantId })).body.user.userId;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'ToolCo' })).body.orgId;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string };
  await owner.patch(`/host/openwop-app/projects/${proj.id}`, { charter: { goal: 'Ship the launch', objectives: ['EU live'] } });
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  expect((await owner.post(L)).status).toBe(201);
  return { tenantId, orgId, owner, ownerId, projectId: proj.id, L };
}

const call = (tenantId: string, scope: { actingUserId?: string; agentProfileId?: string }, name: string, input: Record<string, unknown>) =>
  createAgentToolProvider({ tenantId, runId: 'run-tlt-1', ...scope }).executeTool({ name, input });
/** A tool result's JSON: the success fields this file reads, or a typed error. */
interface ToolOut { error?: string; message?: string; deltaId: string; patch: Record<string, unknown> }
const parse = (r: { content: string }): ToolOut => JSON.parse(r.content) as ToolOut;

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
    // Spaced text: an unbroken 300-char blob would ALSO trip the secret-shaped check, masking the length check.
    const long = (max: number) => 'word '.repeat(Math.ceil(max / 5) + 1).trim();
    expect((await err(s.tenantId, s.ownerId, p({ inScope: [long(LEDGER_LIMITS.line)] }))).message).toMatch(/the limit is 300/);
    expect((await err(s.tenantId, s.ownerId, p({ inScope: [{}] }))).error).toBe('validation_error');
    expect((await err(s.tenantId, s.ownerId, p({ inScope: [`key sk-ant-${'a'.repeat(40)}`] }))).message).toMatch(/secret-shaped/);
    expect((await err(s.tenantId, s.ownerId, p({ inScope: [''] }))).error).toBe('validation_error');
    expect((await err(s.tenantId, s.ownerId, p({ objectives: Array.from({ length: LEDGER_LIMITS.objectives + 1 }, (_, i) => `o${i}`) }))).message).toMatch(/limit is 20/);
    expect((await err(s.tenantId, s.ownerId, p({ goal: long(LEDGER_LIMITS.goal) }))).message).toMatch(/the limit is 200/);
    // An explicitly empty list is still allowed: it clears the list on purpose.
    const cleared = parse(await call(s.tenantId, { actingUserId: s.ownerId }, P, p({ openQuestions: [] })));
    expect(cleared.patch).toEqual({ openQuestions: [] });
  });

  it('MEDIUM — the stored patch is echoed, and decisionDocumentIds REPLACES the list', async () => {
    const s = await setup();
    const d1 = await createDocument({ tenantId: s.tenantId, orgId: s.orgId, title: 'Decision — A', kind: 'decision-record', format: 'markdown', provenance: { producedBy: { kind: 'user', id: s.ownerId } }, createdBy: s.ownerId });
    const d2 = await createDocument({ tenantId: s.tenantId, orgId: s.orgId, title: 'Decision — B', kind: 'decision-record', format: 'markdown', provenance: { producedBy: { kind: 'user', id: s.ownerId } }, createdBy: s.ownerId });
    expect((await s.owner.post(`${s.L}/write`, { patch: { decisionDocumentIds: [d1.documentId] }, why: 'first' })).status).toBe(200);
    // Sent with a duplicate; stored deduped — the echo must be what was STORED, not what was sent.
    const r = parse(await call(s.tenantId, { actingUserId: s.ownerId }, P, { projectId: s.projectId, patch: { decisionDocumentIds: [d2.documentId, d2.documentId] }, why: 'second', baseVersion: 2 }));
    expect(r.patch).toEqual({ decisionDocumentIds: [d2.documentId] });
    expect((await s.owner.post(`${s.L}/deltas/${r.deltaId}/accept`)).status).toBe(200);
    expect((await s.owner.get(s.L)).body.state.decisionDocumentIds).toEqual([d2.documentId]); // replaced, as the description now says
  });

  it('LOW — a visible project with no ledger is `no_ledger`, distinct from not_found', async () => {
    const tenantId = `org:tlg-${Date.now()}-${n++}`;
    const owner = client();
    const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('tlg-owner'), tenantId })).body.user.userId;
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'NoLedgerCo' })).body.orgId;
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
    // Refused, not stored: the queue still holds exactly the cap.
    expect((await listDeltas(s.tenantId, ledger.ledgerId)).filter((d) => d.status === 'proposed')).toHaveLength(LEDGER_LIMITS.pending);
  });
});
