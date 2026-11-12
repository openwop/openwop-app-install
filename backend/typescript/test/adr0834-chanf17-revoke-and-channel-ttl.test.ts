/**
 * ADR 0834 FW2-D1 follow-up (CHAN-F17) — an owner can REVOKE an approval they gave, and a
 * pending ask from a messaging channel EXPIRES.
 *
 *  (a) ledger, revoke: an approved row (a tool-wide grant, or a one-call approval not yet
 *      used) is removed, so the next call is asked about again; a pending or missing row
 *      is `no_approval`; a row re-decided since the owner looked is `approval_changed`;
 *  (b) ledger, expiry: a pending CHANNEL ask past its TTL cannot be decided (approve or
 *      deny ⇒ `approval_expired`, and the row is removed); a re-ask starts it over; an
 *      in-app ask never expires; the TTL is read from `OPENWOP_CHANNEL_APPROVAL_TTL_MIN`;
 *      an APPROVED, unused one-call channel approval stops answering the TTL after it was
 *      given (an in-app one does not);
 *  (c) route: DELETE requires the reviewed `resolvedAt` (400), refuses a visible
 *      non-owner participant (403), answers 204 for the owner and 409 for a second try;
 *      GET carries `expiresAt` on a pending channel ask only, and POST on an expired one
 *      is a 409 `approval_expired`.
 *
 * Red when: a revoke leaves the approval usable; a revoke works without the version or
 * for a non-owner; an expired channel ask can still be approved; an in-app ask expires;
 * the client is not told when a channel ask expires; an old channel approval still lets
 * its call through.
 *
 * The ledger cases move the clock RELATIVE to the real now (never to a calendar date), so
 * the date-bomb sweep cannot red them; the route case shrinks the TTL instead.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  listToolApprovals, makeApprovalGrant, approvalExpiresAt, recordToolApprovalRequested, resolveToolApproval, revokeToolApproval,
  CHANNEL_ASK_TTL_DEFAULT_MIN, type ToolApprovalRecord,
} from '../src/features/conversation-tools/approvalLedger.js';

const TOOL = 'openwop:feature.code-exec.nodes.run';
const X = { code: 'print(1)' };
const T = 't-chanf17';
const HOUR = 3_600_000;

async function row(conv: string): Promise<ToolApprovalRecord | undefined> {
  return (await listToolApprovals(T, conv)).find((a) => a.toolName === TOOL);
}
async function approve(conv: string, grain: 'call' | 'conversation', lane: 'app' | 'channel' = 'app') {
  await recordToolApprovalRequested(T, conv, TOOL, { input: X, lane });
  const out = await resolveToolApproval(T, conv, TOOL, 'approved', 'user:owner', (await row(conv))!.requestedAt, grain);
  expect(out.ok, 'fixture: approved').toBe(true);
  return (await row(conv))!;
}
const later = (ms: number): void => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + ms); };

describe('ledger (sqlite)', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => { process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long'; initHostExtPersistence(storage); });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });
  afterEach(() => { vi.useRealTimers(); delete process.env.OPENWOP_CHANNEL_APPROVAL_TTL_MIN; });

  it('(a) revoking a tool-wide grant removes it, and the next call is asked about again', async () => {
    const granted = await approve('a1', 'conversation');
    expect(makeApprovalGrant([granted], { singleUse: false, requireDigest: false }).check(TOOL, 'baseline', { other: 1 }, 'c1'), 'control: the grant answers any call').toBe(true);
    expect(await revokeToolApproval(T, 'a1', TOOL, granted.resolvedAt!)).toEqual({ ok: true });
    expect(await row('a1')).toBeUndefined();
    expect(makeApprovalGrant(await listToolApprovals(T, 'a1'), { singleUse: false, requireDigest: false }).check(TOOL, 'baseline', X, 'c2')).toBe(false);
    await recordToolApprovalRequested(T, 'a1', TOOL, { input: X });
    expect((await row('a1'))?.status).toBe('pending');
  });

  it('(a) an unused one-call approval can be revoked; a pending, missing or re-decided row cannot', async () => {
    const once = await approve('a2', 'call');
    expect(await revokeToolApproval(T, 'a2', TOOL, 'not-the-version-shown')).toEqual({ ok: false, reason: 'approval_changed' });
    expect((await row('a2'))?.status, 'a refused revoke changes nothing').toBe('approved');
    expect(await revokeToolApproval(T, 'a2', TOOL, once.resolvedAt!)).toEqual({ ok: true });
    expect(await revokeToolApproval(T, 'a2', TOOL, once.resolvedAt!)).toEqual({ ok: false, reason: 'no_approval' });
    await recordToolApprovalRequested(T, 'a3', TOOL, { input: X });
    const pending = (await row('a3'))!;
    expect(await revokeToolApproval(T, 'a3', TOOL, pending.requestedAt)).toEqual({ ok: false, reason: 'no_approval' });
    expect((await row('a3'))?.status).toBe('pending');
  });

  it('(b) a pending channel ask past its TTL cannot be approved or denied, and is removed', async () => {
    await recordToolApprovalRequested(T, 'b1', TOOL, { input: X, lane: 'channel' });
    const asked = (await row('b1'))!;
    expect(Date.parse(approvalExpiresAt(asked)!) - Date.parse(asked.requestedAt)).toBe(CHANNEL_ASK_TTL_DEFAULT_MIN * 60_000);
    later(CHANNEL_ASK_TTL_DEFAULT_MIN * 60_000 + 1000);
    expect(await resolveToolApproval(T, 'b1', TOOL, 'approved', 'user:owner', asked.requestedAt, 'call')).toEqual({ ok: false, reason: 'approval_expired' });
    expect(await row('b1')).toBeUndefined();

    await recordToolApprovalRequested(T, 'b2', TOOL, { input: X, lane: 'channel' });
    const b2 = (await row('b2'))!;
    later(CHANNEL_ASK_TTL_DEFAULT_MIN * 60_000 + 1000);
    expect(await resolveToolApproval(T, 'b2', TOOL, 'denied', 'user:owner', b2.requestedAt)).toEqual({ ok: false, reason: 'approval_expired' });
  });

  it('(b) an approved, unused one-call channel approval stops answering after the TTL; an in-app one does not', async () => {
    const ch = await approve('b5', 'call', 'channel');
    expect(Date.parse(approvalExpiresAt(ch)!) - Date.parse(ch.resolvedAt!)).toBe(CHANNEL_ASK_TTL_DEFAULT_MIN * 60_000);
    const app = await approve('b6', 'call', 'app');
    expect(approvalExpiresAt(app)).toBeUndefined();
    const grant = () => makeApprovalGrant([ch, app], { singleUse: true, requireDigest: true });
    expect(grant().check(TOOL, 'baseline', X, 'c0'), 'control: in date, the exact call is answered').toBe(true);
    later(CHANNEL_ASK_TTL_DEFAULT_MIN * 60_000 + 1000);
    const g = grant();
    expect(g.check(TOOL, 'baseline', X, 'c1'), 'the in-app row still answers').toBe(true);
    expect(g.spent()).toEqual([app]);
    expect(makeApprovalGrant([ch], { singleUse: true, requireDigest: true }).check(TOOL, 'baseline', X, 'c2'), 'the expired channel row answers nothing').toBe(false);
  });

  it('(b) a re-ask starts an expired channel ask over; an in-app ask never expires; the TTL is configurable', async () => {
    process.env.OPENWOP_CHANNEL_APPROVAL_TTL_MIN = '30';
    await recordToolApprovalRequested(T, 'b3', TOOL, { input: X, lane: 'channel', origin: 'policy' });
    later(31 * 60_000);
    await recordToolApprovalRequested(T, 'b3', TOOL, { input: X, lane: 'channel', origin: 'baseline' });
    const renewed = (await row('b3'))!;
    // Started over, not refreshed: the dead ask's origin is not carried into the new one.
    expect(renewed).toMatchObject({ status: 'pending', origin: 'baseline' });
    expect((await resolveToolApproval(T, 'b3', TOOL, 'approved', 'user:owner', renewed.requestedAt, 'call')).ok).toBe(true);

    await recordToolApprovalRequested(T, 'b4', TOOL, { input: X, lane: 'app' });
    const inApp = (await row('b4'))!;
    expect(approvalExpiresAt(inApp)).toBeUndefined();
    later(400 * 24 * HOUR);
    expect((await resolveToolApproval(T, 'b4', TOOL, 'approved', 'user:owner', inApp.requestedAt, 'call')).ok).toBe(true);
  });
});

describe('(c) the approvals routes', () => {
  let BASE = '';
  let server: http.Server;
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const { createApp } = await import('../src/index.js');
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  }, 120_000);
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
  afterEach(() => { delete process.env.OPENWOP_CHANNEL_APPROVAL_TTL_MIN; });

  type Body = { sessionId?: string; user?: { userId: string }; approvals?: Array<Record<string, unknown>>; message?: string; details?: { reason?: string } };
  const client = () => {
    let cookie = '';
    return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const h = res.headers as { getSetCookie?: () => string[] };
      for (const sc of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(sc); if (m?.[1]) cookie = m[1]; }
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as Body };
    };
  };

  it('revoke needs the version and the owner; GET says when a channel ask expires; an expired ask is a 409', async () => {
    const tenant = 't-chanf17-route';
    const member = client();
    const memberId = (await member('POST', '/host/openwop-app/test/login', { email: 'member@chanf17.dev', tenantId: tenant })).body.user?.userId;
    const owner = client();
    await owner('POST', '/host/openwop-app/test/login', { email: 'owner@chanf17.dev', tenantId: tenant });
    const sid = (await owner('POST', '/host/openwop-app/chat/sessions', { title: 'F17', participants: [`user:${memberId}`] })).body.sessionId!;
    const scope = `/host/openwop-app/conversation-tools/sessions/${sid}/capability-scope`;
    const one = (tool: string) => `/host/openwop-app/conversation-tools/sessions/${sid}/approvals/${tool}`;
    const find = async (tool: string) => (await owner('GET', scope)).body.approvals?.find((a) => a.toolName === tool);

    await recordToolApprovalRequested(tenant, sid, 'tool.a', { input: X, lane: 'app' });
    expect((await find('tool.a'))?.expiresAt, 'an in-app ask carries no expiry').toBeUndefined();
    expect((await owner('POST', one('tool.a'), { decision: 'approved', requestedAt: (await find('tool.a'))?.requestedAt, grain: 'conversation' })).status).toBe(200);
    const resolvedAt = String((await find('tool.a'))?.resolvedAt);

    expect((await owner('DELETE', one('tool.a'))).status, 'the version is required').toBe(400);
    expect((await member('GET', scope)).status, 'control: the participant sees the conversation').toBe(200);
    const refused = await member('DELETE', `${one('tool.a')}?resolvedAt=${encodeURIComponent(resolvedAt)}`);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe('Only the conversation owner may revoke its tool calls.');
    expect((await find('tool.a'))?.status, 'the refused revoke did not land').toBe('approved');
    expect((await owner('DELETE', `${one('tool.a')}?resolvedAt=${encodeURIComponent(resolvedAt)}`)).status).toBe(204);
    expect(await find('tool.a')).toBeUndefined();
    const again = await owner('DELETE', `${one('tool.a')}?resolvedAt=${encodeURIComponent(resolvedAt)}`);
    expect(again.status).toBe(409);
    expect(again.body.details?.reason).toBe('no_approval');

    await recordToolApprovalRequested(tenant, sid, 'tool.b', { input: X, lane: 'channel' });
    const asked = (await find('tool.b'))!;
    expect(Date.parse(String(asked.expiresAt)) - Date.parse(String(asked.requestedAt))).toBe(CHANNEL_ASK_TTL_DEFAULT_MIN * 60_000);
    // A real server holds real session cookies, so the clock is not faked here: the TTL is
    // shrunk to ~6 ms instead (it is read per check, from the ask's own requestedAt).
    process.env.OPENWOP_CHANNEL_APPROVAL_TTL_MIN = '0.0001';
    await new Promise((r) => setTimeout(r, 25));
    const expired = await owner('POST', one('tool.b'), { decision: 'approved', requestedAt: asked.requestedAt });
    expect(expired.status).toBe(409);
    expect(expired.body.details?.reason).toBe('approval_expired');
  });
});
