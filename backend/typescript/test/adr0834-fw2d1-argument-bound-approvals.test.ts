/**
 * ADR 0834 FW2-D1 (CHAN-F2, corrected 2026-11-10) — an approval covers what the approver
 * was shown. The default grain, `call`, binds the approval to an HMAC digest of the held
 * call's full canonical input and covers ONE call; `conversation` (in-app only, chosen
 * explicitly) keeps the old per-tool grain.
 *
 *  (a) ledger: an approved `call` row re-opens as `pending` when the agent asks again with
 *      different arguments, and is kept when only the key order differs; the digest is
 *      KEYED (not a bare hash of the input) and survives the decision; a too-long input is
 *      flagged `inputTruncated`; a `channel` ask refuses the `conversation` grain;
 *  (b) the grant: a `call` approval answers only the exact call, once; a tool-wide row
 *      answers any call in-app and none on a channel turn (`requireDigest`); two gates
 *      asking about ONE call agree and spend ONE row, a `policy` row answering both;
 *  (c) the firewall hook built with the grant allows the exact call and holds another;
 *  (d) the ADR 0132 scope fold takes denials and in-app tool-wide approvals only — never
 *      a `call` approval, and on a channel turn no approval at all (the scope-gate gap the
 *      CHAN-F2 architecture review found: it folded every row, claimed or not);
 *  (e) the approvals route: `grain` defaults to `call`, is validated, `conversation` on a
 *      channel ask is a 400 `grain_not_allowed`, and the digest never reaches the client.
 *
 * Red when: an approval covers different arguments; a reordered input re-asks; the
 * digest is a bare SHA-256; one call spends two rows or two gates disagree; a channel turn
 * uses a tool-wide approval; the scope fold widens on a `call` row or on a channel turn;
 * the route accepts a conversation grant for a channel ask or exposes the digest.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { buildFirewallHook, SENSITIVE_APPROVAL_TOOLS } from '../src/features/capability-firewall/firewallHook.js';
import { canonicalize } from '../src/host/canonicalJson.js';
import {
  listToolApprovals, makeApprovalGrant, recordToolApprovalRequested, resolveToolApproval, scopeFoldRows, toolInputDigest,
  REQUESTED_INPUT_MAX_CHARS, type ToolApprovalRecord,
} from '../src/features/conversation-tools/approvalLedger.js';

const TOOL = 'openwop:feature.code-exec.nodes.run';
const X = { code: 'print(1)', lang: 'python' };
const X_REORDERED = { lang: 'python', code: 'print(1)' };
const Y = { code: 'import os; os.remove("/")', lang: 'python' };
const T = 't-fw2d1';

async function pendingRow(conv: string): Promise<ToolApprovalRecord> {
  const r = (await listToolApprovals(T, conv)).find((a) => a.toolName === TOOL);
  expect(r, 'fixture: a row exists').toBeDefined();
  return r!;
}
async function approve(conv: string, input: Record<string, unknown>, grain: 'call' | 'conversation' = 'call', lane: 'app' | 'channel' = 'app', origin: 'baseline' | 'policy' = 'baseline') {
  await recordToolApprovalRequested(T, conv, TOOL, { input, lane, origin });
  return resolveToolApproval(T, conv, TOOL, 'approved', 'user:owner', (await pendingRow(conv)).requestedAt, grain);
}

describe('ledger and grant (sqlite)', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => { process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long'; initHostExtPersistence(storage); });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });

  it('(a) a one-call approval is re-asked for different arguments, kept for a reordered input, and keeps its keyed digest', async () => {
    expect((await approve('a1', X)).ok).toBe(true);
    const approved = await pendingRow('a1');
    expect(approved).toMatchObject({ status: 'approved', grain: 'call', inputDigest: toolInputDigest(X) });
    expect(approved.requestedInput).toBeUndefined(); // the display copy is cleared on decision
    // Keyed: not a bare SHA-256 of the canonical input (which would let a ledger reader test guesses).
    expect(approved.inputDigest).not.toBe(createHash('sha256').update(`toolapproval:v1:${canonicalize(X)}`).digest('base64url'));
    expect(toolInputDigest(X_REORDERED)).toBe(toolInputDigest(X));

    await recordToolApprovalRequested(T, 'a1', TOOL, { input: X_REORDERED });
    expect((await pendingRow('a1')).status).toBe('approved');
    await recordToolApprovalRequested(T, 'a1', TOOL, { input: Y });
    const reopened = await pendingRow('a1');
    expect(reopened).toMatchObject({ status: 'pending', inputDigest: toolInputDigest(Y) });
    expect(reopened.requestedInput).toContain('os.remove');
  });

  it('(a) a too-long input is flagged, and a channel ask refuses the conversation grain', async () => {
    await recordToolApprovalRequested(T, 'a2', TOOL, { input: { code: 'x'.repeat(REQUESTED_INPUT_MAX_CHARS + 10) } });
    expect((await pendingRow('a2')).inputTruncated).toBe(true);
    await recordToolApprovalRequested(T, 'a2b', TOOL, { input: X });
    expect((await pendingRow('a2b')).inputTruncated).toBeUndefined();

    expect(await approve('a3', X, 'conversation', 'channel')).toEqual({ ok: false, reason: 'grain_not_allowed' });
    expect((await pendingRow('a3')).status).toBe('pending');
    expect((await approve('a3', X, 'call', 'channel')).ok).toBe(true);
  });

  it('(b) a call approval answers only the exact call, once; tool-wide rows depend on the lane', async () => {
    await approve('b1', X);
    const rows = await listToolApprovals(T, 'b1');
    const g = makeApprovalGrant(rows, { singleUse: false, requireDigest: false });
    expect(g.check(TOOL, 'baseline', Y, 'call-y')).toBe(false);
    expect(g.check(TOOL, 'baseline', X_REORDERED, 'call-x')).toBe(true);
    expect(g.check(TOOL, 'baseline', X, 'call-x2')).toBe(false); // spent by call-x
    expect(g.spent().map((r) => r.toolName)).toEqual([TOOL]);

    await approve('b2', X, 'conversation');
    const wide = await listToolApprovals(T, 'b2');
    const inApp = makeApprovalGrant(wide, { singleUse: false, requireDigest: false });
    expect([inApp.check(TOOL, 'baseline', X, 'k1'), inApp.check(TOOL, 'baseline', Y, 'k2')]).toEqual([true, true]);
    expect(inApp.spent()).toEqual([]);
    expect(makeApprovalGrant(wide, { singleUse: true, requireDigest: true }).check(TOOL, 'baseline', X, 'k')).toBe(false);
  });

  it('(b) two gates asking about one call agree and spend one row; a policy row answers both', async () => {
    await approve('b3', X, 'call', 'app', 'policy');
    const g = makeApprovalGrant(await listToolApprovals(T, 'b3'), { singleUse: false, requireDigest: false });
    expect(g.check(TOOL, 'baseline', X, 'one-call')).toBe(true); // the scope gate
    expect(g.check(TOOL, 'policy', X, 'one-call')).toBe(true); // the firewall, same call
    expect(g.spent()).toHaveLength(1);
    expect(g.check(TOOL, 'baseline', X, 'next-call')).toBe(false);

    await approve('b4', X); // a baseline-only row
    const b = makeApprovalGrant(await listToolApprovals(T, 'b4'), { singleUse: false, requireDigest: false });
    expect(b.check(TOOL, 'policy', X, 'c')).toBe(false); // ADR 0834 D2
  });

  it('(c) the firewall hook built with the grant allows the exact call and holds another', async () => {
    await approve('c1', X);
    const grant = makeApprovalGrant(await listToolApprovals(T, 'c1'), { singleUse: false, requireDigest: false });
    const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: false, grant });
    expect(hook.evaluate([], TOOL, Y, 'y').decision).toBe('require-approval');
    expect(hook.evaluate([], TOOL, X, 'x').decision).toBe('allow');
    expect(hook.evaluate([], TOOL, X, 'x-again').decision).toBe('require-approval');
    expect(hook.evaluate([], TOOL).decision).toBe('require-approval'); // no input ⇒ a call row answers nothing
  });

  it('(d) the scope fold takes denials and in-app tool-wide approvals only', () => {
    const row = (toolName: string, status: ToolApprovalRecord['status'], grain?: 'call' | 'conversation'): ToolApprovalRecord =>
      ({ tenantId: T, conversationId: 'd', toolName, status, requestedAt: 'x', ...(grain ? { grain } : {}) });
    const rows = [row('denied', 'denied'), row('call', 'approved', 'call'), row('wide', 'approved', 'conversation'), row('legacy', 'approved'), row('pending', 'pending')];
    expect(scopeFoldRows(rows, false).map((r) => r.toolName)).toEqual(['denied', 'wide', 'legacy']);
    expect(scopeFoldRows(rows, true).map((r) => r.toolName)).toEqual(['denied']);
  });
});

describe('(e) the approvals route', () => {
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

  it('defaults to call, validates the grain, refuses a conversation grant for a channel ask, and never exposes the digest', async () => {
    let cookie = '';
    const c = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const h = res.headers as { getSetCookie?: () => string[] };
      for (const sc of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(sc); if (m?.[1]) cookie = m[1]; }
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as { sessionId?: string; approvals?: Array<Record<string, unknown>>; approval?: Record<string, unknown>; details?: { reason?: string } } };
    };
    const tenant = 't-fw2d1-route';
    await c('POST', '/host/openwop-app/test/login', { email: 'owner@fw2d1.dev', tenantId: tenant });
    const sid = (await c('POST', '/host/openwop-app/chat/sessions', { title: 'FW2-D1' })).body.sessionId!;
    const scope = `/host/openwop-app/conversation-tools/sessions/${sid}/capability-scope`;
    const approveP = (tool: string) => `/host/openwop-app/conversation-tools/sessions/${sid}/approvals/${tool}`;
    const pendingAt = async (tool: string) => String((await c('GET', scope)).body.approvals?.find((a) => a.toolName === tool)?.requestedAt);

    await recordToolApprovalRequested(tenant, sid, 'tool.a', { input: X, lane: 'app' });
    expect((await c('GET', scope)).body.approvals?.every((a) => !('inputDigest' in a))).toBe(true);
    expect((await c('POST', approveP('tool.a'), { decision: 'approved', requestedAt: await pendingAt('tool.a'), grain: 'forever' })).status).toBe(400);
    const def = await c('POST', approveP('tool.a'), { decision: 'approved', requestedAt: await pendingAt('tool.a') });
    expect(def.status).toBe(200);
    expect(def.body.approval).toMatchObject({ status: 'approved', grain: 'call' });
    expect(def.body.approval && 'inputDigest' in def.body.approval).toBe(false);

    await recordToolApprovalRequested(tenant, sid, 'tool.b', { input: X, lane: 'channel' });
    const refused = await c('POST', approveP('tool.b'), { decision: 'approved', requestedAt: await pendingAt('tool.b'), grain: 'conversation' });
    expect(refused.status).toBe(400);
    expect(refused.body.details?.reason).toBe('grain_not_allowed');
  });
});
