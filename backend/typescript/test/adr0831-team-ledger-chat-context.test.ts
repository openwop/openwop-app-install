/**
 * ADR 0831 B3 — a project chat's turns carry the team intent ledger.
 *
 * Workflow agents got the ledger through the run stamp (P2); chat turns never
 * collected run context blocks, so an agent in the project's own room worked
 * without it. Real app, real sign-ins, the real composer (`composeChatContext`,
 * which text chat and voice both use):
 *
 *   - a project group chat's scaffold carries the ledger block, at the current
 *     version, INSIDE the BEGIN/END UNTRUSTED fence (ledger text can be
 *     agent-proposed; it reaches the model as data), for a caller who can read it;
 *   - it is LIVE per turn: after the owner accepts a change, the next compose
 *     shows the new version and the change;
 *   - nothing for a caller who cannot read a private project (positive control:
 *     the owner's turn in the same room still carries it), no ledger, or a
 *     conversation with no owner subject.
 *
 * Sabotage-witnessed (w29): the provider unregistered, the caller access check
 * dropped, the fence dropped, a stale (v2) state served. Ceilings: "no ledger"
 * can only fail by fabricating one; "no owner subject" is held first by the
 * composer (`if (!subject) return ''`), and removing that crashes the compose
 * rather than leaking a block.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { ensureConversationMeta, subjectConversationId } from '../src/host/conversationStore.js';
import { composeChatContext } from '../src/host/chatContext.js';

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

/** The response fields this file reads (an absent field fails the case). */
interface Body { user: { userId: string }; orgId: string; id: string }
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
const LEDGER_HEAD = 'Team intent ledger for project';

async function setup(opts: { ledger?: boolean } = {}) {
  const tenantId = `org:tlc-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('tlc-owner'), tenantId })).body.user.userId;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'ChatCo' })).body.orgId;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string };
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  if (opts.ledger !== false) {
    expect((await owner.post(L)).status).toBe(201);
    const w = await owner.post(`${L}/write`, { patch: { inScope: ['EU launch'] }, why: 'kickoff', baseVersion: 1 });
    expect(w.status, JSON.stringify(w.body)).toBeLessThan(300);
  }
  const conversationId = subjectConversationId(tenantId, { kind: 'project', id: proj.id });
  await ensureConversationMeta(tenantId, conversationId, { type: 'group', ownerUserId: ownerId, ownerSubject: { kind: 'project', id: proj.id } });
  return { tenantId, orgId, owner, ownerId, projectId: proj.id, L, conversationId };
}
const compose = (tenantId: string, conversationId: string, callerUserId?: string) =>
  composeChatContext(tenantId, { conversationId, ...(callerUserId ? { callerUserId } : {}), seedText: 'what are we doing?' });

describe('ADR 0831 B3 — the team ledger reaches a project chat', () => {
  it('a project chat carries the fenced ledger block at the current version', async () => {
    const s = await setup();
    const { systemPrompt } = await compose(s.tenantId, s.conversationId, s.ownerId);
    // The ledger text sits INSIDE one BEGIN/END UNTRUSTED fence (no END between the open and the ledger lines).
    expect(systemPrompt).toMatch(/BEGIN UNTRUSTED CONTENT(?:(?!END UNTRUSTED CONTENT)[\s\S])*Team intent ledger for project "Launch", version 2(?:(?!END UNTRUSTED CONTENT)[\s\S])*- In scope: EU launch[\s\S]*?END UNTRUSTED CONTENT/);
  });

  it('is live per turn: an accepted change shows on the next compose', async () => {
    const s = await setup();
    const w = await s.owner.post(`${s.L}/write`, { patch: { outOfScope: ['US launch'] }, why: 'later', baseVersion: 2 });
    expect(w.status, JSON.stringify(w.body)).toBeLessThan(300);
    const { systemPrompt } = await compose(s.tenantId, s.conversationId, s.ownerId);
    expect(systemPrompt).toContain(`${LEDGER_HEAD} "Launch", version 3`);
    expect(systemPrompt).toContain('Out of scope: US launch');
  });

  it('nothing when the project has no ledger', async () => {
    const s = await setup({ ledger: false });
    expect((await compose(s.tenantId, s.conversationId, s.ownerId)).systemPrompt).not.toContain(LEDGER_HEAD);
  });

  it("nothing for a caller who cannot read a private project; a member's turn still carries it", async () => {
    const s = await setup();
    expect((await s.owner.patch(`/host/openwop-app/projects/${s.projectId}/visibility`, { visibility: 'private' })).status).toBeLessThan(300);
    const outsider = client();
    const outsiderId = (await outsider.post('/host/openwop-app/test/login', { email: email('tlc-outsider'), tenantId: s.tenantId })).body.user.userId;
    await createMember({ tenantId: s.tenantId, orgId: s.orgId, subject: outsiderId, displayName: 'O', roles: ['viewer'] });
    expect((await compose(s.tenantId, s.conversationId, outsiderId)).systemPrompt).not.toContain(LEDGER_HEAD);
    expect((await compose(s.tenantId, s.conversationId, s.ownerId)).systemPrompt).toContain(LEDGER_HEAD);
  });

  it('nothing for a conversation with no owner subject', async () => {
    const s = await setup();
    const plain = `conv-plain-${n++}`;
    await ensureConversationMeta(s.tenantId, plain, { type: 'agent', ownerUserId: s.ownerId });
    expect((await compose(s.tenantId, plain, s.ownerId)).systemPrompt).not.toContain(LEDGER_HEAD);
  });
});
