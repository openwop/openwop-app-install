/**
 * ADR 1099 P5 (D8, answer 8) — one witness that a collaborator's erasure reaches
 * EVERY store the client portal writes, through the host's one erasure runner
 * (`eraseSubject`, the DSAR lane), not a store's own hook called by hand.
 *
 * The collaborator leaves a unique marker in each store:
 *  - an APPROVED message (it joined their client thread, P3c);
 *  - a PENDING message (a held `collab-proposal`, P3a);
 *  - the turn memory of an answered turn (P3d).
 * After `eraseSubject(tenant, email:<theirs>)`:
 *  - no approval row, no thread and no turn memory still holds the marker;
 *  - the pending proposal is cancelled (it can never apply), the applied one keeps
 *    its row (the firm's record) but loses the person's words and label;
 *  - their grant no longer opens the portal (uniform 404);
 *  - a SECOND collaborator on the same project keeps all of theirs (the control:
 *    an eraser that wiped the whole project would pass the first half).
 *
 * Sabotage-witnessed (2026-11-27, one at a time, each red): unregistering the
 * client-thread hook ("no thread"), the turn-memory hook ("no turn memory"), and
 * the collab-proposal redactor's text fields ("no approval row"); erasing every
 * collaborator of the project instead of the subject ("the control").
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
import { __resetCollabTurnCapsForTests, __setCollabTurnModelForTests } from '../src/host/collaboratorTurn.js';
import { readTurnMemory } from '../src/host/collaboratorTurnMemory.js';
import { listApprovals } from '../src/host/approvalService.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { PROJECTS_CLIENT_PORTAL_TOGGLE } from '../src/features/projects/clientPortal.js';
import { CLIENT_MESSAGE_TOOL } from '../src/features/projects/clientThread.js';

let BASE: string;
let server: http.Server;

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
}, 120_000);
afterEach(async () => { __setCollabTurnModelForTests(undefined); await __resetCollabTurnCapsForTests(); });
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
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
type Client = ReturnType<typeof client>;
const C = (orgId: string): string => `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/collaborators`;
const THREADS = (projectId: string): string => `/host/openwop-app/projects/${projectId}/client-threads`;
const CLAIM = (approvalId: string): string => `/host/openwop-app/approvals/${encodeURIComponent(approvalId)}/claim`;
interface Thread { collaboratorId: string; label: string; entries: Array<{ text: string }> }

async function firm() {
  const tenantId = 'ws:t-1099p5';
  const admin = client();
  expect((await admin.post('/host/openwop-app/test/login', { email: 'owner-p5@studio.test', tenantId })).status).toBe(201);
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Riverside renovation' });
  const p = await admin.post<{ id: string }>('/host/openwop-app/projects', { orgId: org.body.orgId, name: 'Kitchen and bath' });
  return { tenantId, orgId: org.body.orgId, projectId: p.body.id, admin };
}
let n = 0;
async function collaborator(f: { orgId: string; projectId: string; admin: Client }, displayName: string) {
  const person = client();
  const v = await person.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `p5-${n++}@outside.test` });
  const email = (await getUser(v.body.user.userId))?.email ?? '';
  const inv = await f.admin.post<{ collaborator: { collaboratorId: string }; invite: { token: string } }>(C(f.orgId), { kind: 'client-stakeholder', email, displayName });
  expect(inv.status, inv.raw).toBe(201);
  expect((await person.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token })).status).toBe(200);
  const collaboratorId = inv.body.collaborator.collaboratorId;
  const g = await f.admin.post<{ grant: CollaboratorGrant }>(`${C(f.orgId)}/${collaboratorId}/grants`, { resource: { kind: 'project', id: f.projectId }, actions: ['view', 'comment'], expiresInDays: 30 });
  expect(g.status, g.raw).toBe(201);
  return { person, email, collaboratorId, grantId: g.body.grant.grantId };
}
/** One answered turn in which the model sends `message` to the firm. The
 *  collaborator's own words (`said`) land in the host-kept turn memory. */
async function send(c: { person: Client; grantId: string }, said: string, message: string): Promise<void> {
  let round = 0;
  __setCollabTurnModelForTests(async (_r: AiToolCallRequest): Promise<AiToolCallResult> =>
    round++ === 0 ? { content: '', toolCalls: [{ id: 'c1', name: CLIENT_MESSAGE_TOOL, input: { message } }] } : { content: 'Sent to the firm.', toolCalls: [] });
  const r = await c.person.post(`/host/openwop-app/collab/grants/${c.grantId}/turn`, { message: said });
  expect(r.status, r.raw).toBe(200);
}
const proposalOf = async (tenantId: string, text: string) =>
  (await listApprovals(tenantId, 'pending')).find((a) => a.kind === 'collab-proposal' && a.collabProposal?.summary === text);
const allProposals = async (tenantId: string) =>
  [...(await listApprovals(tenantId, 'pending')), ...(await listApprovals(tenantId, 'approved')), ...(await listApprovals(tenantId, 'rejected'))]
    .filter((a) => a.kind === 'collab-proposal');

describe('ADR 1099 P5 — a collaborator\'s erasure reaches every client-portal store', () => {
  it('erases the subject\'s words everywhere, keeps the firm\'s records, and leaves the other collaborator alone', async () => {
    const f = await firm();
    const garcia = await collaborator(f, 'The Garcias');
    const builder = await collaborator(f, 'Oak Builders');

    // Garcia: one approved message, one pending, and remembered turns.
    await send(garcia, 'GARCIA-TURN-1 please pass this on', 'GARCIA-APPROVED move the walkthrough');
    const approved = await proposalOf(f.tenantId, 'GARCIA-APPROVED move the walkthrough');
    expect((await f.admin.post(CLAIM(approved!.approvalId))).status).toBe(200);
    await send(garcia, 'GARCIA-TURN-2 one more', 'GARCIA-PENDING the tile is wrong');
    const pending = await proposalOf(f.tenantId, 'GARCIA-PENDING the tile is wrong');
    expect(pending).toBeDefined();

    // The control: the builder's approved message and remembered turn.
    await send(builder, 'BUILDER-TURN framing is done', 'BUILDER-APPROVED framing done');
    const bApproved = await proposalOf(f.tenantId, 'BUILDER-APPROVED framing done');
    expect((await f.admin.post(CLAIM(bApproved!.approvalId))).status).toBe(200);

    // Before: every store holds Garcia's marker (so "after" is not vacuous).
    expect(JSON.stringify(await allProposals(f.tenantId))).toContain('GARCIA-PENDING');
    expect(JSON.stringify((await f.admin.get<{ threads: Thread[] }>(THREADS(f.projectId))).body.threads)).toContain('GARCIA-APPROVED');
    expect(JSON.stringify(await readTurnMemory(garcia.grantId))).toContain('GARCIA-TURN-1');

    // Erase Garcia through the ONE DSAR lane.
    await eraseSubject(f.tenantId, `email:${garcia.email}`);

    // No approval row holds Garcia's words or the firm's label for them.
    const rows = await allProposals(f.tenantId);
    expect(JSON.stringify(rows)).not.toMatch(/GARCIA-|The Garcias/);
    // The pending one can never apply; the applied one stays as the firm's record.
    const p = rows.find((a) => a.approvalId === pending!.approvalId);
    expect(p?.status).not.toBe('pending');
    expect(rows.find((a) => a.approvalId === approved!.approvalId)?.status).toBe('approved');
    // No thread holds it, and no turn memory.
    const threads = (await f.admin.get<{ threads: Thread[] }>(THREADS(f.projectId))).body.threads;
    expect(JSON.stringify(threads)).not.toContain('GARCIA-');
    expect(threads.find((t) => t.collaboratorId === garcia.collaboratorId)).toBeUndefined();
    expect(await readTurnMemory(garcia.grantId)).toEqual([]);
    // The grant no longer opens the portal.
    expect((await garcia.person.get(`/host/openwop-app/collab/grants/${garcia.grantId}`)).status).toBe(404);

    // The control keeps everything.
    expect(JSON.stringify(rows)).toContain('BUILDER-APPROVED');
    expect(threads.find((t) => t.collaboratorId === builder.collaboratorId)?.entries.map((e) => e.text)).toEqual(['BUILDER-APPROVED framing done']);
    expect(JSON.stringify(await readTurnMemory(builder.grantId))).toContain('BUILDER-TURN');
    expect((await builder.person.get(`/host/openwop-app/collab/grants/${builder.grantId}`)).status).toBe(200);
  });
});
