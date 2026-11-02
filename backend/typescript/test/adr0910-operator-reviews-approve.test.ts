/**
 * ADR 0910 D11 correction — a live `kicktodo-operator` decides their OWN
 * challenge publication on the unified `/reviews` lane, with RFC 0049
 * enforcement ON (production's posture since kicktodo-backend-00062).
 *
 * The defect (MEASURED on kicktodo-prod 2026-10-29 23:34Z): the operator
 * activated (201), then `POST /reviews/approval:…/actions/approve` answered 403.
 * The approval arm demanded `approvals:respond`, which neither the viewer floor
 * nor the activation role carries, so the request never reached the kind's
 * owner check (manage authority + the D5 self-approval waiver). The owner now
 * declares its check the whole decide authority (`decidesAuthority`), and the
 * arm keeps only the key-lane half of its floor for such a kind.
 *
 * Witnessed (sabotage, each turns a leg red):
 *  - the reviews arm back to an unconditional `requireProtocolScope` → leg 1 403s;
 *  - `decidesAuthority` dropped from the challenge-publish registration → leg 1 403s;
 *  - the opt-in read as "has any eligibility check" → leg 5 (campaign-spend,
 *    compensation-action, … register checks and did not opt in);
 *  - the operator role widened with `approvals:respond` → leg 3 passes the floor.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, isDeclaredDefaultWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { APPROVAL_KINDS, approvalKindOwnsDecideAuthority, createApproval, createChallengePublishApproval, getApproval } from '../src/host/approvalService.js';
import { operatorActivations } from '../src/host/operatorActivationLedger.js';

const WS = 'host-kicktodo';
const OPERATOR_HOME = `user:${'a1'.repeat(16)}`;
const VIEWER_HOME = `user:${'b2'.repeat(16)}`;
const TOGGLES = ['users', 'kicktodo-core', 'kicktodo-creator'];

let BASE = '';
let server: http.Server;
let operator = { cookie: '', userId: '' };
let viewer = { cookie: '', userId: '' };
const saved: Record<string, string | undefined> = {};

const cookieFor = (userId: string, personalTenant: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: WS, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const seatViewer = async (principalId: string, personalTenant: string): Promise<{ cookie: string; userId: string }> => {
  const user = await upsertFromPrincipal({ tenantId: WS, principalId, source: 'oidc' });
  await createMember({ tenantId: WS, orgId: WS, subject: user.userId, displayName: principalId, roles: ['viewer'] });
  return { cookie: cookieFor(user.userId, personalTenant), userId: user.userId };
};
const activate = async (subject: string, expiresInMs: number): Promise<void> => {
  const now = Date.now();
  await operatorActivations.put({
    activationId: `opa_${randomBytes(6).toString('hex')}`, workspaceId: WS, subject, eligibilityTenant: OPERATOR_HOME,
    justification: 'P9 Factory publication (test)', activatedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + expiresInMs).toISOString(),
  });
};
const publication = () => createChallengePublishApproval({
  tenantId: WS, proposal: 'Publish "Watercolor basics" v1', candidateId: `cand-${randomBytes(4).toString('hex')}`,
  challengeId: 'chal-1', challengeVersion: 1, submittedBy: operator.userId,
});
interface Body { error?: string; message?: string; status?: string; details?: { requiredScope?: string } }
const decide = async (cookie: string, approvalId: string, action: 'approve' | 'reject'): Promise<{ status: number; body: Body }> => {
  const res = await fetch(`${BASE}/host/openwop-app/reviews/${encodeURIComponent(`approval:${approvalId}`)}/actions/${action}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
};

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTHORIZATION_ENFORCEMENT', 'OPENWOP_SUPERADMIN_TENANTS', 'OPENWOP_TEST_AUTH_ENABLED']) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT = 'true';
  process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR_HOME;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of TOGGLES) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  operator = await seatViewer('oidc:p9-operator', OPERATOR_HOME);
  viewer = await seatViewer('oidc:p9-viewer', VIEWER_HOME);
  await activate(operator.userId, 3_600_000);
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const id of TOGGLES) {
    const d = getToggleDefault(id);
    if (d) await saveConfig(d, 'test');
  }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('ADR 0910 D11 — the live operator decides their own publication on /reviews (enforcement ON)', () => {
  it('precondition: the workspace is a declared default, so the activation can apply at all', () => {
    expect(isDeclaredDefaultWorkspace(WS)).toBe(true);
  });

  it('1. approve reaches the publication act (409 on the missing submission, never the 403 floor) and reject resolves', async () => {
    const a = await publication();
    const approve = await decide(operator.cookie, a.approvalId, 'approve');
    // This minted approval has no submitted publication behind it, so the act
    // refuses TYPED (as kicktodo-publish-approval-eligibility pins for an admin):
    // the request passed the floor, the owner check and the SoD waiver.
    expect(approve.status).toBe(409);
    expect(approve.body.error).toBe('conflict');
    const b = await publication();
    const reject = await decide(operator.cookie, b.approvalId, 'reject');
    expect(reject.status).toBe(200);
    expect((await getApproval(b.approvalId))?.status).toBe('rejected');
  });

  it('2. a viewer with no activation is refused by the owner check, and the approval stays pending', async () => {
    const a = await publication();
    const r = await decide(viewer.cookie, a.approvalId, 'approve');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden_scope');
    expect(r.body.message).toBe('Deciding a challenge publication requires KickTodo manage authority.');
    expect((await getApproval(a.approvalId))?.status).toBe('pending');
  });

  it('3. the live operator still cannot decide an approval of any OTHER kind: the floor holds', async () => {
    const other = await createApproval({ tenantId: WS, rosterId: 'roster-1', persona: 'Planner', workflowId: 'wf-1', proposal: 'Start a run' });
    const r = await decide(operator.cookie, other.approvalId, 'approve');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
    expect(r.body.message).toBe('Missing required scope: approvals:respond');
    expect((await getApproval(other.approvalId))?.status).toBe('pending');
  });

  it('4. an expired activation grants nothing, even before any sweep', async () => {
    await activate(operator.userId, -1_000);
    try {
      const a = await publication();
      const r = await decide(operator.cookie, a.approvalId, 'approve');
      expect(r.status).toBe(403);
      expect(r.body.message).toBe('Deciding a challenge publication requires KickTodo manage authority.');
      expect((await getApproval(a.approvalId))?.status).toBe('pending');
    } finally {
      await activate(operator.userId, 3_600_000);
    }
  });

  it('5. challenge-publish is the ONLY kind whose owner check stands in for the floor', () => {
    // Several kinds register an eligibility check (campaign-spend, compensation-action,
    // the KickTodo sign-offs, …) that was never written to be the only gate. Having a
    // check is not opting in; a new opt-in is a reviewed change to this list.
    expect(APPROVAL_KINDS.filter((k) => approvalKindOwnsDecideAuthority(k))).toEqual(['challenge-publish']);
    expect(approvalKindOwnsDecideAuthority(undefined)).toBe(false);
  });
});
