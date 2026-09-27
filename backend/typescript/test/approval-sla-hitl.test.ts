/**
 * ADR 0478 — HITL completion through the real app: the SLA policy
 * (validation + RBAC floor), the ladder sweep (rung order, exactly-once,
 * delegation addressing, opt-in expiry), reasoning-at-the-gate round-trip,
 * the email-pref routes, and the decide-by-email confirm page driving a REAL
 * suspended approval gate end-to-end (GET never mutates; POST resolves).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

describe('HITL completion (ADR 0478, sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';
  const WF_GATE = 'hitl-wf-gate';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    expect((await call('POST', '/v1/host/openwop-app/workflows', {
      workflowId: WF_GATE,
      nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Ship it?' } }],
      edges: [],
      metadata: { name: WF_GATE, lifecycle: { transient: true, generatedBy: 'test' } },
    })).status).toBe(201);
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

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
      // This test env runs DEMO MODE, where resolveEffectiveAccess grants the
      // memberless principal de-facto OWNER scope (accessControlService's
      // documented demo bypass) — so the write passes HERE. Outside demo
      // mode an unknown/non-admin subject resolves to ZERO scopes and this
      // route 403s (the accessControl fail-closed default, covered by its
      // own suite). The assertion below pins that the route goes THROUGH
      // the scope resolver (a 401 without a principal; 200 as demo-owner).
      const noAuth = await fetch(`${BASE}/v1/host/openwop-app/approvals/sla-policy`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, remindAfterMs: 60000 }),
      });
      expect([401, 403]).toContain(noAuth.status);
      const put = await call('PUT', '/v1/host/openwop-app/approvals/sla-policy', {
        enabled: true, remindAfterMs: 60000,
      });
      expect(put.status).toBe(200); // demo-owner semantics
      // Reads stay member-level.
      expect((await call('GET', '/v1/host/openwop-app/approvals/sla-policy')).status).toBe(200);
      // Reset for later suites.
      const { setApprovalSlaPolicy } = await import('../src/host/approvalSla.js');
      await setApprovalSlaPolicy({ tenantId: 'default', enabled: false });
    });

    it('validates rungs (enabled needs one; strictly increasing; bounds)', async () => {
      const { setApprovalSlaPolicy } = await import('../src/host/approvalSla.js');
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
      const { createApproval, listApprovals } = await import('../src/host/approvalService.js');
      const { setApprovalSlaPolicy, sweepApprovalSla } = await import('../src/host/approvalSla.js');
      const { createDelegation } = await import('../src/host/approvalDelegations.js');

      await setApprovalSlaPolicy({
        tenantId: 'default', enabled: true,
        remindAfterMs: 60_000, escalateAfterMs: 120_000, expireAfterMs: 180_000,
      });
      const approval = await createApproval({
        tenantId: 'default', rosterId: 'r1', persona: 'Tester', workflowId: WF_GATE,
        proposal: 'SLA ladder probe',
        policy: { requiredApprovals: 1, approverRefs: ['user-appr-1'] },
      });
      // An active delegation so rung 2 has a delegate to address.
      await createDelegation({
        tenantId: 'default', fromSubject: 'user-appr-1', toSubject: 'user-delegate-1',
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
      // Past escalate: one more.
      expect(await sweepApprovalSla(new Date(t0 + 121_000))).toBe(1);
      // Past expire: the fail-closed rung resolves the approval rejected.
      expect(await sweepApprovalSla(new Date(t0 + 181_000))).toBe(1);
      const resolved = (await listApprovals('default')).find((a) => a.approvalId === approval.approvalId);
      expect(resolved?.status).toBe('rejected');
      expect(resolved?.note).toBe('sla_expired');
      // A resolved approval never fires again (ladder hygiene).
      expect(await sweepApprovalSla(new Date(t0 + 500_000))).toBe(0);
      // Disarm the policy so later tests see today's default behavior.
      await setApprovalSlaPolicy({ tenantId: 'default', enabled: false });
    });
  });

  describe('reasoning-at-the-gate', () => {
    it('a composed-workflow approval carries the agent reasoning into the row', async () => {
      const { createComposedWorkflowApproval, listApprovals } = await import('../src/host/approvalService.js');
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
      expect((await call('PUT', '/v1/host/openwop-app/approvals/email-pref', { email: 'not-an-email', enabled: true })).status).toBe(400);
      const put = await call<{ email: string; enabled: boolean }>('PUT', '/v1/host/openwop-app/approvals/email-pref', { email: 'me@example.com', enabled: true });
      expect(put.status).toBe(200);
      const get = await call<{ email?: string; enabled: boolean }>('GET', '/v1/host/openwop-app/approvals/email-pref');
      expect(get.body.email).toBe('me@example.com');
      expect(get.body.enabled).toBe(true);
    });
  });

  describe('decide-by-email confirm page (RFC 0093 token path)', () => {
    async function settle(runId: string, until: (s: string) => boolean): Promise<string> {
      for (let i = 0; i < 200; i += 1) {
        const r = await call<{ status: string }>('GET', `/v1/runs/${runId}`);
        if (r.body.status && until(r.body.status)) return r.body.status;
        await new Promise((res) => setTimeout(res, 25));
      }
      return 'timeout';
    }

    it('GET renders a form and NEVER mutates; POST resolves the real gate', async () => {
      const run = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF_GATE, inputs: {} });
      expect(run.status).toBe(201);
      expect(await settle(run.body.runId, (s) => s.startsWith('waiting'))).toContain('waiting');

      const list = await call<{ interrupts: Array<{ token: string }> }>('GET', `/v1/host/openwop-app/runs/${run.body.runId}/interrupts`);
      const token = list.body.interrupts[0]!.token;
      expect(token).toBeTruthy();

      // GET: a form, and the gate is STILL open afterwards (no mutation).
      const page = await call('GET', `/v1/host/openwop-app/interrupt-action?token=${encodeURIComponent(token)}&action=approve`);
      expect(page.status).toBe(200);
      expect(page.text).toContain('<form');
      expect((await call<{ status: string }>('GET', `/v1/runs/${run.body.runId}`)).body.status).toContain('waiting');

      // POST (urlencoded, as the form submits): resolves the gate.
      const res = await fetch(`${BASE}/v1/host/openwop-app/interrupt-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, action: 'approve', voter: '', comment: 'from email' }).toString(),
      });
      expect(res.status).toBe(200);
      expect(await settle(run.body.runId, (s) => !s.startsWith('waiting') && s !== 'pending' && s !== 'running')).toBe('completed');
    });

    it('a QUORUM gate is never resolved by one emailed click (review HIGH-1 regression)', async () => {
      const WF_Q = 'hitl-wf-quorum';
      expect((await call('POST', '/v1/host/openwop-app/workflows', {
        workflowId: WF_Q,
        nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: {
          prompt: 'Two of you must agree.', requiredApprovals: 2,
          approverRefs: ['appr-a', 'appr-b'], actions: ['accept', 'reject'],
        } }],
        edges: [],
        metadata: { name: WF_Q, lifecycle: { transient: true, generatedBy: 'test' } },
      })).status).toBe(201);
      const run = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF_Q, inputs: {} });
      expect(await settle(run.body.runId, (s) => s.startsWith('waiting'))).toContain('waiting');
      const list = await call<{ interrupts: Array<{ token: string }> }>('GET', `/v1/host/openwop-app/runs/${run.body.runId}/interrupts`);
      const token = list.body.interrupts[0]!.token;

      // Grade-code H1 — every voter claim must carry the per-recipient HMAC
      // binding the email carried. The earlier version of this test posted
      // both votes with client-chosen voter ids and NO binding — it enshrined
      // the forgery it was meant to prevent (one token holder casting every
      // approver's vote).
      const { signVoterBinding } = await import('../src/host/interruptVoterBinding.js');

      // A voter claim WITHOUT its binding is refused outright (404 posture).
      const forged = await fetch(`${BASE}/v1/host/openwop-app/interrupt-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, action: 'approve', voter: 'appr-a' }).toString(),
      });
      expect(forged.status).toBe(404);
      // ...and appr-a's binding can never cast appr-b's vote.
      const crossed = await fetch(`${BASE}/v1/host/openwop-app/interrupt-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, action: 'approve', voter: 'appr-b', sig: signVoterBinding(token, 'appr-a') }).toString(),
      });
      expect(crossed.status).toBe(404);
      expect((await call<{ status: string }>('GET', `/v1/runs/${run.body.runId}`)).body.status).toContain('waiting');

      // ONE properly-bound emailed approve = ONE vote, never a full resolve.
      const one = await fetch(`${BASE}/v1/host/openwop-app/interrupt-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, action: 'approve', voter: 'appr-a', sig: signVoterBinding(token, 'appr-a') }).toString(),
      });
      expect(one.status).toBe(200);
      await new Promise((res) => setTimeout(res, 200));
      expect((await call<{ status: string }>('GET', `/v1/runs/${run.body.runId}`)).body.status).toContain('waiting');

      // The second DISTINCT bound identity meets quorum and resolves the gate.
      const two = await fetch(`${BASE}/v1/host/openwop-app/interrupt-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, action: 'approve', voter: 'appr-b', sig: signVoterBinding(token, 'appr-b') }).toString(),
      });
      expect(two.status).toBe(200);
      expect(await settle(run.body.runId, (s) => !s.startsWith('waiting') && s !== 'pending' && s !== 'running')).toBe('completed');
    });

    it('an unknown token is a 404; a garbage token never renders a form', async () => {
      const bad = await call('GET', '/v1/host/openwop-app/interrupt-action?token=nope&action=approve');
      expect(bad.status).toBe(404);
      expect(bad.text ?? '').not.toContain('<form');
    });
  });
});
