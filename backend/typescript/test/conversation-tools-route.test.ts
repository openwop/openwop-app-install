/**
 * ADR 0132 Phase 4 — capability-scope REST (route + RBAC harness). Boots the real
 * app and drives: unknown-session 404, auth + visibility (IDOR-safe 404 for a non-owner),
 * set/get the scope config, owner-gated write, and resolve a per-tool approval.
 *
 * TST-CKC-7 (protected: authz / IDOR). Every authz case uses SAME-tenant cookie
 * users (an explicit shared `tenantId`), so the refusal comes from the route's own
 * visibility / owner checks, never from an earlier tenant miss. Red when:
 *  - a session with NO meta reads as the permissive unowned default instead of 404
 *    (case 1; the feature's toggle graduated to always-on in #854, ADR 0134);
 *  - visibility stops being checked for a same-tenant non-member (case 3);
 *  - an invalid scope mode is accepted (case 4);
 *  - the approval route stops requiring the reviewed `requestedAt` (case 5);
 *  - a visible NON-owner participant may change the scope or approve a tool call
 *    (case 6 — the owner gate, asserted by its exact refusal).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { recordToolApprovalRequested } from '../src/features/conversation-tools/approvalLedger.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The response bodies these routes answer with (narrow local views). */
interface ErrorBody { error?: string; message?: string; details?: { reason?: string } }
interface LoginBody { user?: { userId: string } }
interface SessionBody { sessionId: string }
interface ApprovalView { toolName: string; status: string; requestedAt: string; requestedInput?: string }
interface ScopeBody { scope?: Record<string, unknown>; approvals?: ApprovalView[] }
interface ApproveBody { approval?: ApprovalView }
type Body = ErrorBody & LoginBody & SessionBody & ScopeBody & ApproveBody;
interface Res { status: number; body: Body }

function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m?.[1]) cookie = m[1]; }
    const text = res.status === 204 ? '' : await res.text();
    const parsed: Body = text ? JSON.parse(text) : { sessionId: '' };
    return { status: res.status, body: parsed };
  };
}

const SCOPE_PATH = (sid: string) => `/host/openwop-app/conversation-tools/sessions/${sid}/capability-scope`;
const APPROVE_PATH = (sid: string, tool: string) => `/host/openwop-app/conversation-tools/sessions/${sid}/approvals/${tool}`;

describe('capability-scope routes (ADR 0132 P4)', () => {
  // CORRECTED 2026-10-29 (wave 68): this case was "toggle OFF ⇒ 404", but the
  // `conversation-tools` toggle was GRADUATED to always-on in #854 (ADR 0134,
  // 50d0d9951) — there is no toggle to turn off, and the old `enable()` helper was
  // a silent no-op. What the case actually exercised was an UNKNOWN session id:
  // the `requireVisibleMeta` rule that a missing meta is a 404, never the permissive
  // `isVisibleTo(null) ⇒ true` default. That is the claim now.
  it('an unknown session ⇒ 404 (no permissive default for a missing meta)', async () => {
    const c = client();
    await c('POST', '/host/openwop-app/test/login', { email: 'a@test.dev', tenantId: 't-unknown' });
    const sid = (await c('POST', '/host/openwop-app/chat/sessions', { title: 'Known' })).body.sessionId;
    expect((await c('GET', SCOPE_PATH(sid))).status, 'control: a real session reads').toBe(200);
    const r = await c('GET', SCOPE_PATH('no-such-session'));
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
    expect(r.body.message).toBe('chat_session "no-such-session" not found.');
  });

  it('owner can set + read the scope; default when unset', async () => {
    const c = client();
    await c('POST', '/host/openwop-app/test/login', { email: 'owner@test.dev' });
    // create a conversation the caller owns
    const created = await c('POST', '/host/openwop-app/chat/sessions', { title: 'T' });
    const sid = created.body.sessionId;
    expect(sid).toBeTruthy();

    const empty = await c('GET', SCOPE_PATH(sid));
    expect(empty.status).toBe(200);
    expect(empty.body.scope).toEqual({ mode: 'agent-default' });

    const put = await c('PUT', SCOPE_PATH(sid), { scope: { mode: 'restricted', disabled: ['email.send'], requireApproval: ['crm.contact.update'] } });
    expect(put.status).toBe(200);
    expect(put.body.scope).toMatchObject({ mode: 'restricted', disabled: ['email.send'], requireApproval: ['crm.contact.update'] });

    const get = await c('GET', SCOPE_PATH(sid));
    expect(get.body.scope).toMatchObject({ mode: 'restricted', disabled: ['email.send'] });
  });

  it('a non-owner gets an IDOR-safe 404 (no existence leak)', async () => {
    const owner = client();
    await owner('POST', '/host/openwop-app/test/login', { email: 'owner2@test.dev', tenantId: 't-idor' });
    const created = await owner('POST', '/host/openwop-app/chat/sessions', { title: 'Private' });
    const sid = created.body.sessionId;
    expect((await owner('GET', SCOPE_PATH(sid))).status, 'control: the owner reads it').toBe(200);

    // SAME tenant, not a participant — so the meta IS found and visibility decides.
    const other = client();
    await other('POST', '/host/openwop-app/test/login', { email: 'intruder@test.dev', tenantId: 't-idor' });
    const r = await other('GET', SCOPE_PATH(sid));
    expect(r.status).toBe(404); // not 403 — no existence leak
    expect(r.body.error).toBe('not_found');
  });

  it('invalid scope shape ⇒ 400', async () => {
    const c = client();
    await c('POST', '/host/openwop-app/test/login', { email: 'val@test.dev' });
    const created = await c('POST', '/host/openwop-app/chat/sessions', { title: 'V' });
    const sid = created.body.sessionId;
    const r = await c('PUT', SCOPE_PATH(sid), { scope: { mode: 'bogus' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
    expect(r.body.message).toBe("scope.mode MUST be 'agent-default' or 'restricted'.");
  });

  // ADR 0834 D2/D3 — an approval answers a PENDING ask, and only the conversation's
  // owner (the principal its tools act as) may give it.
  it('resolve a per-tool approval: 409 with nothing pending, 200 for the owner once asked', async () => {
    const c = client();
    const login = await c('POST', '/host/openwop-app/test/login', { email: 'appr@test.dev', tenantId: 't-appr' });
    expect(login.status).toBeLessThan(300);
    const created = await c('POST', '/host/openwop-app/chat/sessions', { title: 'A' });
    const sid = created.body.sessionId;
    const unversioned = await c('POST', APPROVE_PATH(sid, 'email.send'), { decision: 'approved' });
    expect(unversioned.status).toBe(400); // approve what you saw — the version is required
    expect(unversioned.body.message).toBe('requestedAt (the pending request version you reviewed) is required.');
    const early = await c('POST', APPROVE_PATH(sid, 'email.send'), { decision: 'approved', requestedAt: '2026-01-01T00:00:00.000Z' });
    expect(early.status).toBe(409); // nothing pending — nothing approvable in advance
    expect(early.body.details?.reason).toBe('no_pending_approval');
    await recordToolApprovalRequested('t-appr', sid, 'email.send', { origin: 'baseline', input: { to: 'x@example.com' } });
    const view = await c('GET', SCOPE_PATH(sid));
    const pending = view.body.approvals?.find((a) => a.toolName === 'email.send');
    expect(pending).toMatchObject({ status: 'pending', requestedInput: expect.stringContaining('x@example.com') });
    const stale = await c('POST', APPROVE_PATH(sid, 'email.send'), { decision: 'approved', requestedAt: '1970-01-01T00:00:00.000Z' });
    expect(stale.status).toBe(409);
    expect(stale.body.details?.reason).toBe('approval_changed');
    const r = await c('POST', APPROVE_PATH(sid, 'email.send'), { decision: 'approved', requestedAt: pending!.requestedAt });
    expect(r.status).toBe(200);
    expect(r.body.approval).toMatchObject({ toolName: 'email.send', status: 'approved' });
    const get = await c('GET', SCOPE_PATH(sid));
    expect(get.body.approvals).toEqual([expect.objectContaining({ toolName: 'email.send', status: 'approved' })]);
  });

  it('owner-gated write: a visible same-tenant PARTICIPANT may not change the scope or approve', async () => {
    const member = client();
    const memberLogin = await member('POST', '/host/openwop-app/test/login', { email: 'member@test.dev', tenantId: 't-write' });
    const memberId = memberLogin.body.user?.userId;
    expect(memberId).toBeTruthy();
    const owner = client();
    await owner('POST', '/host/openwop-app/test/login', { email: 'writer-owner@test.dev', tenantId: 't-write' });
    const sid = (await owner('POST', '/host/openwop-app/chat/sessions', { title: 'Shared', participants: [`user:${memberId}`] })).body.sessionId;

    // The member SEES the conversation (so the visibility gate passes and the owner
    // gate is what is tested) …
    expect((await member('GET', SCOPE_PATH(sid))).status, 'control: a participant reads it').toBe(200);
    // … but cannot change its tool scope …
    const put = await member('PUT', SCOPE_PATH(sid), { scope: { mode: 'restricted', enabled: [] } });
    expect(put.status).toBe(403);
    expect(put.body.message).toBe('Only the conversation owner may change its tool scope.');
    expect((await owner('GET', SCOPE_PATH(sid))).body.scope, 'the refused write did not land').toEqual({ mode: 'agent-default' });
    // … nor approve a pending tool call (it would spend the owner's authority).
    await recordToolApprovalRequested('t-write', sid, 'email.send', { origin: 'baseline' });
    const pending = (await owner('GET', SCOPE_PATH(sid))).body.approvals?.find((a) => a.toolName === 'email.send');
    const approve = await member('POST', APPROVE_PATH(sid, 'email.send'), { decision: 'approved', requestedAt: pending!.requestedAt });
    expect(approve.status).toBe(403);
    expect(approve.body.message).toBe('Only the conversation owner may approve its tool calls.');
    expect((await owner('GET', SCOPE_PATH(sid))).body.approvals).toEqual([expect.objectContaining({ toolName: 'email.send', status: 'pending' })]);
  });
});
