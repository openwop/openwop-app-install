/**
 * ADR 0478 — HITL completion through the real app: the SLA policy
 * (validation + RBAC floor), the ladder sweep (rung order, exactly-once,
 * delegation addressing, opt-in expiry), reasoning-at-the-gate round-trip,
 * the email-pref routes, and the decide-by-email confirm page driving a REAL
 * suspended approval gate end-to-end (GET never mutates; POST resolves).
 *
 * TST-BZB-10 (grade-tests w66). Red when: the SLA write stops consulting the
 * `host:members:manage` scope (case 1 — driven by a SAME-tenant cookie user with no
 * membership; the wildcard dev-token is a superadmin and skips the check, which made the
 * earlier version of this case unable to fail); rung ordering validation is dropped; the
 * remind rung loses its exactly-once guard or expiry stops writing `sla_expired`; the email decide route
 * drops its voter-binding refusal (404 posture) or a single bound vote resolves a quorum gate.
 * NOTE: "delegation addressing" in the first paragraph is NOT asserted — it is
 * BLOCKED-ON-PRODUCT (SLA-ESC-DELEGATE-1, see the ladder case).
 * The ladder runs in its OWN tenant: the sweep counts every pending approval of every
 * enabled policy, so a shared `default` tenant made the count order-dependent.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { bareRunId } from './support/bareRunId.js';
import { getSetCookies } from './headerCookies.js';
import { createApproval, createComposedWorkflowApproval, listApprovals } from '../src/host/approvalService.js';
import { setApprovalSlaPolicy, sweepApprovalSla } from '../src/host/approvalSla.js';
import { createDelegation } from '../src/host/approvalDelegations.js';
import { signVoterBinding } from '../src/host/interruptVoterBinding.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';
import { tallyDecisions } from '../src/host/reviewDecisionLedger.js';

describe('HITL completion (ADR 0478, sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';
  const WF_GATE = 'hitl-wf-gate';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    // Cookie sessions are ON (the test-login seam) so case 1 can act as a real
    // same-tenant member; every other case keeps the dev-token bearer.
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    expect((await call('POST', '/host/openwop-app/workflows', {
      workflowId: WF_GATE,
      nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Ship it?' } }],
      edges: [],
      metadata: { name: WF_GATE, lifecycle: { transient: true, generatedBy: 'test' } },
    })).status).toBe(201);
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  /** A cookie-session client logged into `tenantId` through the test-login seam. */
  async function cookieClient(tenantId: string, who: string): Promise<<T = unknown>(method: string, path: string, body?: unknown) => Promise<{ status: number; body: T }>> {
    let cookie = '';
    const send = async <T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      return { status: res.status, body: parsed as T };
    };
    const login = await send('POST', '/host/openwop-app/test/login', { email: `${who}-${Date.now()}@acme.test`, tenantId });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    return send;
  }

  async function call<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; text?: string }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T, text };
  }

  describe('SLA policy', () => {
    it('the WRITE consults the members-manage admin scope (review HIGH-2: expire = mass-reject)', async () => {
      // Two cookie users in ONE fresh tenant. The owner minted an org (owner role ⇒
      // host:members:manage); the second user is a member of nothing. Demo mode is OFF
      // here (`OPENWOP_DEMO_MODE` is unset), so an unknown subject resolves to zero scopes.
      // The dev-token is NOT used: it is a wildcard bearer, i.e. a superadmin, and
      // `isSuperadmin` skips the scope check entirely.
      const tenantId = `org:sla-write-${Date.now()}`;
      const owner = await cookieClient(tenantId, 'sla-owner');
      expect((await owner('POST', '/host/openwop-app/orgs', { name: 'SLA org' })).status).toBe(201);
      const stranger = await cookieClient(tenantId, 'sla-stranger');
      try {
        const refused = await stranger<{ error?: string; message?: string }>('PUT', '/host/openwop-app/approvals/sla-policy', { enabled: true, remindAfterMs: 60000 });
        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({ error: 'forbidden', message: 'Changing the approval SLA policy requires an admin (members-manage) role.' });
        // Positive control: the same write by the org owner lands.
        const put = await owner<{ enabled?: boolean }>('PUT', '/host/openwop-app/approvals/sla-policy', { enabled: true, remindAfterMs: 60000 });
        expect(put.status, JSON.stringify(put.body)).toBe(200);
        // Reads stay member-level.
        expect((await stranger('GET', '/host/openwop-app/approvals/sla-policy')).status).toBe(200);
      } finally {
        await setApprovalSlaPolicy({ tenantId, enabled: false });
      }
    });

    it('validates rungs (enabled needs one; strictly increasing; bounds)', async () => {
      await expect(setApprovalSlaPolicy({ tenantId: 'default', enabled: true })).rejects.toThrow(/at least one rung/);
      await expect(setApprovalSlaPolicy({ tenantId: 'default', enabled: true, remindAfterMs: 1000 })).rejects.toThrow(/must be/);
      await expect(setApprovalSlaPolicy({
        tenantId: 'default', enabled: true, remindAfterMs: 120000, escalateAfterMs: 60000,
      })).rejects.toThrow(/strictly increasing/);
      const ok = await setApprovalSlaPolicy({ tenantId: 'default', enabled: false });
      expect(ok.enabled).toBe(false);
    });
  });

  describe('the ladder sweep', () => {
    it('fires remind then escalate exactly once each; expiry is opt-in and rejects', async () => {
      // Its OWN tenant: the sweep counts every pending approval under every enabled
      // policy, so sharing `default` with the reasoning case made the count order-dependent.
      const tenantId = 'tenant-sla-ladder';
      const escalated: string[] = [];
      const unsub = getNotificationEmitter().subscribe((n) => {
        if (n.type === 'approval.sla-escalated' && n.tenantId === tenantId) escalated.push(n.recipientUserId ?? '(broadcast)');
      });
      try {
        await setApprovalSlaPolicy({
          tenantId, enabled: true,
          remindAfterMs: 60_000, escalateAfterMs: 120_000, expireAfterMs: 180_000,
        });
        const approval = await createApproval({
          tenantId, rosterId: 'r1', persona: 'Tester', workflowId: WF_GATE,
          proposal: 'SLA ladder probe',
          policy: { requiredApprovals: 1, approverRefs: ['user-appr-1'] },
        });
        // An active delegation so rung 2 has a delegate to address.
        await createDelegation({
          tenantId, fromSubject: 'user-appr-1', toSubject: 'user-delegate-1',
          startsAt: new Date(Date.now() - 1000).toISOString(),
          endsAt: new Date(Date.now() + 86_400_000).toISOString(),
          createdBy: 'user-appr-1',
        });

        const t0 = Date.parse(approval.createdAt);
        // Before any threshold: nothing fires.
        expect(await sweepApprovalSla(new Date(t0 + 30_000))).toBe(0);
        // Past remind: exactly one fire; a second sweep at the same age fires nothing.
        expect(await sweepApprovalSla(new Date(t0 + 61_000))).toBe(1);
        expect(await sweepApprovalSla(new Date(t0 + 62_000))).toBe(0);
        expect(escalated, 'remind is not an escalation').toEqual([]);
        // Past escalate: one more. (Addressing it to the approver's ACTIVE DELEGATE — ADR 0478
        // §1 Rung 2 — is BLOCKED-ON-PRODUCT, grade-code row SLA-ESC-DELEGATE-1: a tenant-scoped
        // `run-proposal` row resolves to no audience, so the rung broadcasts even though
        // `policy.approverRefs` names an approver with an active delegation. Not asserted here.)
        expect(await sweepApprovalSla(new Date(t0 + 121_000))).toBe(1);
        expect(escalated, 'the escalate rung fired exactly one notice').toHaveLength(1);
        // Past expire: the fail-closed rung resolves the approval rejected.
        expect(await sweepApprovalSla(new Date(t0 + 181_000))).toBe(1);
        const resolved = (await listApprovals(tenantId)).find((a) => a.approvalId === approval.approvalId);
        expect(resolved?.status).toBe('rejected');
        expect(resolved?.note).toBe('sla_expired');
        // A resolved approval never fires again (ladder hygiene).
        expect(await sweepApprovalSla(new Date(t0 + 500_000))).toBe(0);
      } finally {
        unsub();
        // Disarm the policy so later tests see today's default behavior.
        await setApprovalSlaPolicy({ tenantId, enabled: false });
      }
    });
  });

  describe('reasoning-at-the-gate', () => {
    it('a composed-workflow approval carries the agent reasoning into the row', async () => {
      const created = await createComposedWorkflowApproval({
        tenantId: 'default', workflowId: WF_GATE,
        proposal: 'Run the probe workflow',
        reasoning: 'I chose two steps because the task splits into fetch and summarize.',
        composedWorkflow: { definitionHash: 'h'.repeat(64), nodeCount: 2, edgeCount: 1 },
      });
      const row = (await listApprovals('default', 'pending')).find((a) => a.approvalId === created.approvalId);
      expect(row?.reasoning).toContain('fetch and summarize');
    });
  });

  describe('email pref routes', () => {
    it('round-trips the recipient pref; validates the address', async () => {
      const bad = await call<{ error?: string; message?: string }>('PUT', '/host/openwop-app/approvals/email-pref', { email: 'not-an-email', enabled: true });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ error: 'validation_error', message: 'A valid email address is required.' });
      const put = await call<{ email: string; enabled: boolean }>('PUT', '/host/openwop-app/approvals/email-pref', { email: 'me@example.com', enabled: true });
      expect(put.status).toBe(200);
      const get = await call<{ email?: string; enabled: boolean }>('GET', '/host/openwop-app/approvals/email-pref');
      expect(get.body.email).toBe('me@example.com');
      expect(get.body.enabled).toBe(true);
    });
  });

  describe('decide-by-email confirm page (RFC 0093 token path)', () => {
    async function settle(runId: string, until: (s: string) => boolean): Promise<string> {
      for (let i = 0; i < 200; i += 1) {
        const r = await call<{ status: string }>('GET', `/runs/${runId}`);
        if (r.body.status && until(r.body.status)) return r.body.status;
        await new Promise((res) => setTimeout(res, 25));
      }
      return 'timeout';
    }

    it('GET renders a form and NEVER mutates; POST resolves the real gate', async () => {
      const run = await call<{ runId: string }>('POST', '/runs', { workflowId: WF_GATE, inputs: {} });
      expect(run.status).toBe(201);
      expect(await settle(run.body.runId, (s) => s.startsWith('waiting'))).toContain('waiting');

      const list = await call<{ interrupts: Array<{ token: string }> }>('GET', `/host/openwop-app/runs/${bareRunId(run.body.runId)}/interrupts`);
      const token = list.body.interrupts[0]!.token;
      expect(token).toBeTruthy();

      // GET: a form, and the gate is STILL open afterwards (no mutation).
      const page = await call('GET', `/host/openwop-app/interrupt-action?token=${encodeURIComponent(token)}&action=approve`);
      expect(page.status).toBe(200);
      expect(page.text).toContain('<form');
      expect((await call<{ status: string }>('GET', `/runs/${run.body.runId}`)).body.status).toContain('waiting');

      // POST (urlencoded, as the form submits): resolves the gate.
      const res = await fetch(`${BASE}/host/openwop-app/interrupt-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, action: 'approve', voter: '', comment: 'from email' }).toString(),
      });
      expect(res.status).toBe(200);
      expect(await settle(run.body.runId, (s) => !s.startsWith('waiting') && s !== 'pending' && s !== 'running')).toBe('completed');
    });

    it('a QUORUM gate is never resolved by one emailed click (review HIGH-1 regression)', async () => {
      const WF_Q = 'hitl-wf-quorum';
      expect((await call('POST', '/host/openwop-app/workflows', {
        workflowId: WF_Q,
        nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: {
          prompt: 'Two of you must agree.', requiredApprovals: 2,
          approverRefs: ['appr-a', 'appr-b'], actions: ['accept', 'reject'],
        } }],
        edges: [],
        metadata: { name: WF_Q, lifecycle: { transient: true, generatedBy: 'test' } },
      })).status).toBe(201);
      const run = await call<{ runId: string }>('POST', '/runs', { workflowId: WF_Q, inputs: {} });
      expect(await settle(run.body.runId, (s) => s.startsWith('waiting'))).toContain('waiting');
      const list = await call<{ interrupts: Array<{ token: string; interruptId: string }> }>('GET', `/host/openwop-app/runs/${bareRunId(run.body.runId)}/interrupts`);
      const token = list.body.interrupts[0]!.token;
      const interruptId = list.body.interrupts[0]!.interruptId;

      // Grade-code H1 — every voter claim must carry the per-recipient HMAC
      // binding the email carried. The earlier version of this test posted
      // both votes with client-chosen voter ids and NO binding — it enshrined
      // the forgery it was meant to prevent (one token holder casting every
      // approver's vote).
      // A voter claim WITHOUT its binding is refused outright (404 posture).
      const forged = await fetch(`${BASE}/host/openwop-app/interrupt-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, action: 'approve', voter: 'appr-a' }).toString(),
      });
      expect(forged.status).toBe(404);
      // ...and appr-a's binding can never cast appr-b's vote.
      const crossed = await fetch(`${BASE}/host/openwop-app/interrupt-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, action: 'approve', voter: 'appr-b', sig: signVoterBinding(token, 'appr-a') }).toString(),
      });
      expect(crossed.status).toBe(404);
      expect((await call<{ status: string }>('GET', `/runs/${run.body.runId}`)).body.status).toContain('waiting');

      // ONE properly-bound emailed approve = ONE vote, never a full resolve.
      const one = await fetch(`${BASE}/host/openwop-app/interrupt-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, action: 'approve', voter: 'appr-a', sig: signVoterBinding(token, 'appr-a') }).toString(),
      });
      expect(one.status).toBe(200);
      // Wait for the vote to be RECORDED in the decision ledger (a positive signal), then
      // assert the gate is still open — a fixed sleep passed whether or not it had landed.
      await vi.waitFor(async () => {
        expect((await tallyDecisions(interruptId)).accepts, 'the first bound vote was recorded').toEqual(['appr-a']);
      }, { timeout: 5_000, interval: 25 });
      expect((await call<{ status: string }>('GET', `/runs/${run.body.runId}`)).body.status).toContain('waiting');

      // The second DISTINCT bound identity meets quorum and resolves the gate.
      const two = await fetch(`${BASE}/host/openwop-app/interrupt-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, action: 'approve', voter: 'appr-b', sig: signVoterBinding(token, 'appr-b') }).toString(),
      });
      expect(two.status).toBe(200);
      expect(await settle(run.body.runId, (s) => !s.startsWith('waiting') && s !== 'pending' && s !== 'running')).toBe('completed');
    });

    it('an unknown token is a 404; a garbage token never renders a form', async () => {
      const bad = await call('GET', '/host/openwop-app/interrupt-action?token=nope&action=approve');
      expect(bad.status).toBe(404);
      expect(bad.text ?? '').not.toContain('<form');
    });
  });
});
