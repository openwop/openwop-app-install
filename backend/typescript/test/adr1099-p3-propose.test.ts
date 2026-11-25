/**
 * ADR 1099 D6 (P3) — a collaborator's proposals write nothing until a member
 * approves each one.
 *
 *  - a `propose` tool's items are held as one `collab-proposal` approval each, and
 *    `apply` is not called;
 *  - a rerun with the same idempotency keys adds nothing;
 *  - approving one applies exactly that one, with the scope rebuilt from the grant;
 *    rejecting another writes nothing and redacts its summary and payload;
 *  - a revoke between propose and approve refuses the approve (409), and reject
 *    still works;
 *  - an `apply` that throws reopens the approval;
 *  - the collaborator's erasure cancels their pending proposals;
 *  - malformed proposals are refused before anything is held.
 *
 * Sabotage notes (each reds a case below):
 *  - calling `apply` inside `holdProposals` reds "writes nothing";
 *  - a random approval id instead of the derived one reds "a rerun adds nothing";
 *  - dropping the grant check in `decideCollabProposal` reds "revoke";
 *  - dropping the reject redaction reds "approving applies exactly that item".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getUser } from '../src/features/users/usersService.js';
import type { CollaboratorGrant } from '../src/host/externalCollaborators.js';
import { checkProposals, registerClientProjectTool, type ClientToolScope } from '../src/host/clientProjectTools.js';
import { __resetCollabTurnCapsForTests, __setCollabTurnModelForTests } from '../src/host/collaboratorTurn.js';
import { eraseApprovalSubject, getApproval, listApprovals } from '../src/host/approvalService.js';
import { OpenwopError } from '../src/types.js';
import { PROJECTS_CLIENT_PORTAL_TOGGLE } from '../src/features/projects/clientPortal.js';

const ANSWER = 'openwop:client.project.answer-probe';
const LEAD_ONLY = 'openwop:client.project.lead-only-probe';
/** Who `LEAD_ONLY`'s mayDecide admits. */
let leadUserId = '';
/** When set, the next apply refuses with the adopter's own 403. */
let refuseNextApply = false;
let BASE: string;
let server: http.Server;
/** What `apply` was called with, in order. */
const applied: Array<{ scope: ClientToolScope; payload: Record<string, unknown>; approvalId: string }> = [];
let failNextApply = false;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const portal = getToggleDefault(PROJECTS_CLIENT_PORTAL_TOGGLE);
  if (portal) await saveConfig({ ...portal, status: 'on' }, 'test');
  // An interview answer tool: one proposal per answered field.
  registerClientProjectTool({
    id: ANSWER, kind: 'project', featureId: 'test-adopter', effect: 'propose', action: 'view',
    description: 'Send answers for the firm to review.',
    inputSchema: { type: 'object', properties: { submission: { type: 'string' }, answers: { type: 'object' } } },
    async run(_scope, input) {
      const submission = String(input.submission ?? 's1');
      const answers = (input.answers ?? {}) as Record<string, string>;
      return { proposals: Object.entries(answers).map(([field, value]) => ({ groupKey: submission, idempotencyKey: `${submission}:${field}`, summary: `${field}: ${value}`, payload: { field, value } })) };
    },
    async apply(scope, payload, ctx) {
      if (failNextApply) { failNextApply = false; throw new Error('store down'); }
      if (refuseNextApply) { refuseNextApply = false; throw new OpenwopError('forbidden', 'Only the lead designer can confirm a choice.', 403, { code: 'not_lead_designer' }); }
      applied.push({ scope, payload, approvalId: ctx.approvalId });
    },
  });
  // A tool whose proposals only one person may decide.
  registerClientProjectTool({
    id: LEAD_ONLY, kind: 'project', featureId: 'test-adopter', effect: 'propose', action: 'view',
    description: 'Lead-decided answers.', inputSchema: { type: 'object', properties: { answers: { type: 'object' } } },
    async run(_scope, input) {
      return { proposals: Object.entries((input.answers ?? {}) as Record<string, string>).map(([field, value]) => ({ groupKey: 'lead', idempotencyKey: `lead:${field}`, summary: `${field}: ${value}`, payload: { field, value } })) };
    },
    async apply(scope, payload, ctx) { applied.push({ scope, payload, approvalId: ctx.approvalId }); },
    mayDecide: async (_scope, { userId }) => userId === leadUserId,
    deciderLabel: "the project's lead designer",
  });
}, 120_000);
afterEach(async () => {
  __setCollabTurnModelForTests(undefined);
  await __resetCollabTurnCapsForTests();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T; raw: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1] ?? cookie; }
    const raw = res.status === 204 ? '' : await res.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T, raw };
  };
  return { post: <T>(p: string, b?: unknown) => call<T>('POST', p, b), del: <T>(p: string) => call<T>('DELETE', p) };
}
const C = (orgId: string): string => `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/collaborators`;
const TURN = (grantId: string): string => `/host/openwop-app/collab/grants/${grantId}/turn`;
const DECIDE = (approvalId: string, verb: 'claim' | 'reject'): string => `/host/openwop-app/approvals/${encodeURIComponent(approvalId)}/${verb}`;

let n = 0;
async function setup() {
  const tenantId = `ws:t-1099p3-${n++}`;
  const admin = client();
  const login = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `owner-p3-${n}@studio.test`, tenantId });
  expect(login.status).toBe(201);
  const adminUserId = login.body.user.userId;
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Riverside renovation' });
  const p = await admin.post<{ id: string }>('/host/openwop-app/projects', { orgId: org.body.orgId, name: 'Kitchen and bath' });
  const person = client();
  const v = await person.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `client-p3-${n++}@outside.test` });
  const email = (await getUser(v.body.user.userId))?.email ?? '';
  const inv = await admin.post<{ collaborator: { collaboratorId: string }; invite: { token: string } }>(C(org.body.orgId), { kind: 'client-stakeholder', email, displayName: 'The Garcias' });
  expect(inv.status, inv.raw).toBe(201);
  expect((await person.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token })).status).toBe(200);
  const collaboratorId = inv.body.collaborator.collaboratorId;
  const g = await admin.post<{ grant: CollaboratorGrant }>(`${C(org.body.orgId)}/${collaboratorId}/grants`, { resource: { kind: 'project', id: p.body.id }, actions: ['view'], expiresInDays: 30 });
  expect(g.status, g.raw).toBe(201);
  return { tenantId, orgId: org.body.orgId, projectId: p.body.id, admin, adminUserId, person, collaboratorId, grantId: g.body.grant.grantId };
}

/** The model answers: one propose call with these answers, then text. */
function answering(answers: Record<string, string>, seen: AiToolCallRequest[] = [], tool = ANSWER) {
  let round = 0;
  return async (r: AiToolCallRequest): Promise<AiToolCallResult> => {
    seen.push(r);
    if (round++ === 0) return { content: '', toolCalls: [{ id: 'c1', name: tool, input: { submission: 'intake-1', answers } }] };
    return { content: 'Sent.', toolCalls: [] };
  };
}
const pendingOf = async (tenantId: string) => (await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'collab-proposal');

describe('ADR 1099 P3 — proposals write nothing before approval', () => {
  it('holds one approval per item, writes nothing, and a rerun adds nothing', async () => {
    const s = await setup();
    applied.length = 0;
    const seen: AiToolCallRequest[] = [];
    __setCollabTurnModelForTests(answering({ countertop: 'quartz', sink: 'undermount' }, seen));
    expect((await s.person.post(TURN(s.grantId), { message: 'Here are my answers.' })).status).toBe(200);
    expect(applied).toHaveLength(0);
    const pending = await pendingOf(s.tenantId);
    expect(pending).toHaveLength(2);
    expect(pending.map((a) => a.collabProposal?.idempotencyKey).sort()).toEqual(['intake-1:countertop', 'intake-1:sink']);
    expect(pending.every((a) => a.orgId === s.orgId && a.collabProposal?.groupKey === 'intake-1' && a.collabProposal?.grantId === s.grantId)).toBe(true);
    expect(JSON.stringify(seen[1]?.messages)).toContain('pending_review');

    // The same interview again: nothing new.
    __setCollabTurnModelForTests(answering({ countertop: 'quartz', sink: 'undermount' }));
    expect((await s.person.post(TURN(s.grantId), { message: 'Sending again.' })).status).toBe(200);
    expect(await pendingOf(s.tenantId)).toHaveLength(2);
    expect(applied).toHaveLength(0);
  });

  it('approving applies exactly that item on the grant\'s scope; rejecting writes nothing', async () => {
    const s = await setup();
    applied.length = 0;
    __setCollabTurnModelForTests(answering({ countertop: 'quartz', sink: 'undermount' }));
    await s.person.post(TURN(s.grantId), { message: 'Answers.' });
    const [a, b] = (await pendingOf(s.tenantId)).sort((x, y) => String(x.collabProposal?.idempotencyKey).localeCompare(String(y.collabProposal?.idempotencyKey)));
    const ok = await s.admin.post<{ status: string }>(DECIDE(a!.approvalId, 'claim'));
    expect(ok.status, ok.raw).toBe(200);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ approvalId: a!.approvalId, payload: { field: 'countertop', value: 'quartz' } });
    expect(applied[0]?.scope).toMatchObject({ tenantId: s.tenantId, orgId: s.orgId, resourceKind: 'project', resourceId: s.projectId, grantId: s.grantId, collaboratorId: s.collaboratorId });
    const no = await s.admin.post(DECIDE(b!.approvalId, 'reject'));
    expect(no.status, no.raw).toBe(200);
    expect(applied).toHaveLength(1);
    // A rejected item keeps no copy of the collaborator's words; its keys stay.
    const rejected = await getApproval(b!.approvalId);
    expect(rejected?.status).toBe('rejected');
    expect(JSON.stringify(rejected?.collabProposal?.payload)).toBe('{}');
    expect(JSON.stringify(rejected)).not.toContain('undermount');
    expect(rejected?.collabProposal?.idempotencyKey).toBe('intake-1:sink');
    // A second approve of the first is a no-op, not a second apply.
    await s.admin.post(DECIDE(a!.approvalId, 'claim'));
    expect(applied).toHaveLength(1);
  });

  it('a revoke between propose and approve refuses the approve; reject still works', async () => {
    const s = await setup();
    applied.length = 0;
    __setCollabTurnModelForTests(answering({ countertop: 'quartz' }));
    await s.person.post(TURN(s.grantId), { message: 'Answers.' });
    const [a] = await pendingOf(s.tenantId);
    expect((await s.admin.del(`${C(s.orgId)}/${s.collaboratorId}/grants/${s.grantId}`)).status).toBe(200);
    const ok = await s.admin.post<{ details?: { reason?: string } }>(DECIDE(a!.approvalId, 'claim'));
    expect(ok.status, ok.raw).toBe(409);
    expect(ok.body.details?.reason).toBe('collab_grant_ended');
    expect(applied).toHaveLength(0);
    expect((await getApproval(a!.approvalId))?.status).toBe('pending');
    expect((await s.admin.post(DECIDE(a!.approvalId, 'reject'))).status).toBe(200);
  });

  it('an apply that throws reopens the approval', async () => {
    const s = await setup();
    applied.length = 0;
    __setCollabTurnModelForTests(answering({ countertop: 'quartz' }));
    await s.person.post(TURN(s.grantId), { message: 'Answers.' });
    const [a] = await pendingOf(s.tenantId);
    failNextApply = true;
    const r = await s.admin.post(DECIDE(a!.approvalId, 'claim'));
    expect(r.status, r.raw).toBe(500);
    expect((await getApproval(a!.approvalId))?.status).toBe('pending');
    expect((await s.admin.post(DECIDE(a!.approvalId, 'claim'))).status).toBe(200);
    expect(applied).toHaveLength(1);
  });

  it('a tool that names its decider refuses anyone else, for approve and reject, with a clean 403', async () => {
    const s = await setup();
    applied.length = 0;
    __setCollabTurnModelForTests(answering({ tile: 'zellige' }, [], LEAD_ONLY));
    await s.person.post(TURN(s.grantId), { message: 'Answers.' });
    const [a] = await pendingOf(s.tenantId);
    leadUserId = 'someone-else';
    for (const verb of ['claim', 'reject'] as const) {
      const r = await s.admin.post<{ message?: string; details?: { reason?: string; decider?: string } }>(DECIDE(a!.approvalId, verb));
      expect(r.status, r.raw).toBe(403);
      expect(r.body.details).toMatchObject({ reason: 'collab_not_decider', decider: "the project's lead designer" });
    }
    expect((await getApproval(a!.approvalId))?.status).toBe('pending');
    leadUserId = s.adminUserId;
    expect((await s.admin.post(DECIDE(a!.approvalId, 'claim'))).status).toBe(200);
    expect(applied).toHaveLength(1);
  });

  it('an apply that refuses with its own 4xx passes it through and leaves the row pending', async () => {
    const s = await setup();
    applied.length = 0;
    __setCollabTurnModelForTests(answering({ countertop: 'quartz' }));
    await s.person.post(TURN(s.grantId), { message: 'Answers.' });
    const [a] = await pendingOf(s.tenantId);
    refuseNextApply = true;
    const r = await s.admin.post<{ details?: { code?: string } }>(DECIDE(a!.approvalId, 'claim'));
    expect(r.status, r.raw).toBe(403);
    expect(r.body.details?.code).toBe('not_lead_designer');
    expect((await getApproval(a!.approvalId))?.status).toBe('pending');
  });

  it('the collaborator\'s erasure cancels their pending proposals', async () => {
    const s = await setup();
    __setCollabTurnModelForTests(answering({ countertop: 'quartz' }));
    await s.person.post(TURN(s.grantId), { message: 'Answers.' });
    const [a] = await pendingOf(s.tenantId);
    await eraseApprovalSubject(s.tenantId, s.collaboratorId);
    const after = await getApproval(a!.approvalId);
    expect(after?.status).toBe('rejected');
    expect(JSON.stringify(after?.collabProposal?.payload ?? {})).not.toContain('quartz');
  });

  it('malformed proposals are refused before anything is held', () => {
    const ok = { groupKey: 'g', idempotencyKey: 'k', summary: 's', payload: { a: 1 } };
    expect(checkProposals('t', { proposals: [ok] })).toHaveLength(1);
    expect(() => checkProposals('t', {})).toThrow(/proposals/);
    expect(() => checkProposals('t', { proposals: Array.from({ length: 11 }, () => ok) })).toThrow(/at most/);
    expect(() => checkProposals('t', { proposals: [{ ...ok, idempotencyKey: '' }] })).toThrow(/idempotencyKey/);
    expect(() => checkProposals('t', { proposals: [{ ...ok, payload: 'x' }] })).toThrow(/payload/);
    // Scope keys in a payload are dropped, never applied.
    expect(checkProposals('t', { proposals: [{ ...ok, payload: { projectId: 'other', a: 1 } }] })[0]?.payload).toEqual({ a: 1 });
    expect(() => registerClientProjectTool({ id: 'openwop:client.project.no-apply', kind: 'project', featureId: 'x', effect: 'propose', action: 'view', description: 'x', inputSchema: { type: 'object', properties: {} }, run: async () => ({ proposals: [] }) } as never)).toThrow(/apply/);
  });
});
