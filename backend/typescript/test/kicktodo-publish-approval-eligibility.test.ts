/**
 * KTFULL-B2 (approvals-side half) — decider ELIGIBILITY on the generic decision
 * lane. The Factory ROUTES were privileged in 2026-07-19's fix, but the generic
 * approvals lane (claim/reject routes → the same core the review cards and
 * decide-by-email ride) still let any identified second identity resolve a
 * `challenge-publish` approval. The owner-registered eligibility check now
 * enforces at the ONE decision choke:
 *  - an EDITOR (workspace:write, NO manage) can neither claim NOR reject (403
 *    forbidden_scope — an ineligible identity must not approve OR block);
 *  - the SUBMITTER, even with manage authority, cannot claim (403 — separation
 *    of duties, mirroring completePublication);
 *  - a DIFFERENT manage-holder decides normally (the happy path stays open).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createChallengePublishApproval, getApproval } from '../src/host/approvalService.js';
import { kindHasRejectSideEffects } from '../src/host/approvalDecision.js';

let BASE: string;
let server: http.Server;
let wsTenant: string;
let editorCookie: string;
let adminCookie: string;
let submitterCookie: string;
let submitterUserId = '';

const CLAIM = (id: string) => `/v1/host/openwop-app/approvals/${encodeURIComponent(id)}/claim`;
const REJECT = (id: string) => `/v1/host/openwop-app/approvals/${encodeURIComponent(id)}/reject`;

const craftCookie = (userId: string, activeTenant: string, personalTenant: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: activeTenant, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const seatMember = async (principalId: string, roles: string[], personalTenant: string): Promise<{ cookie: string; userId: string }> => {
  const user = await upsertFromPrincipal({ tenantId: wsTenant, principalId, source: 'oidc' });
  await createMember({ tenantId: wsTenant, orgId: wsTenant, subject: user.userId, displayName: principalId, roles });
  return { cookie: craftCookie(user.userId, wsTenant, personalTenant), userId: user.userId };
};
const mintApproval = async () =>
  createChallengePublishApproval({
    tenantId: wsTenant, proposal: 'Publish "Watercolor basics" v1', candidateId: `cand-${randomBytes(4).toString('hex')}`,
    challengeId: 'chal-1', challengeVersion: 1, submittedBy: submitterUserId,
  });
const post = async (cookie: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'kicktodo-core', 'kicktodo-creator']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const ws = await createWorkspace({ name: 'KT Eligibility', ownerSubject: 'oidc:elig-owner' });
  wsTenant = ws.tenantId;
  editorCookie = (await seatMember('oidc:elig-editor', ['editor'], 'ws:home-elig-editor')).cookie;
  adminCookie = (await seatMember('oidc:elig-admin', ['admin'], 'ws:home-elig-admin')).cookie;
  const submitter = await seatMember('oidc:elig-submitter', ['admin'], 'ws:home-elig-submitter');
  submitterCookie = submitter.cookie;
  submitterUserId = submitter.userId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0458 §2.2 correction — challenge-publish is a registered-handler kind', () => {
  it('the SLA expire rung may not auto-reject it (a system actor gets the overdue notification instead)', () => {
    // The registered handler makes the kind's reject a feature decision, so
    // ADR 0478 HIGH-3 applies: `approvalSla.ts` notifies instead of raw-rejecting.
    // A publication decision is a content-safety act and must stay human.
    expect(kindHasRejectSideEffects('challenge-publish')).toBe(true);
  });
});

describe('KTFULL-B2 — challenge-publish decider eligibility (generic lane)', () => {
  it('an editor (no manage) can neither claim nor reject — 403, approval stays pending', async () => {
    const a = await mintApproval();
    const claim = await post(editorCookie, CLAIM(a.approvalId));
    expect(claim.status).toBe(403);
    expect(String(claim.body.error ?? claim.body.code ?? '')).toContain('forbidden_scope');
    const reject = await post(editorCookie, REJECT(a.approvalId));
    expect(reject.status).toBe(403);
    expect((await getApproval(a.approvalId))?.status).toBe('pending');
  });

  it('the submitter cannot claim their own publication even with manage authority (SoD)', async () => {
    const a = await mintApproval();
    const claim = await post(submitterCookie, CLAIM(a.approvalId));
    expect(claim.status).toBe(403);
    expect((await getApproval(a.approvalId))?.status).toBe('pending');
  });

  it('a DIFFERENT manage-holder decides normally (the happy path is not over-tightened)', async () => {
    // ADR 0458 §2.2 (correction, 2026-09-15): the CLAIM lane now runs the
    // registered challenge-publish handler → `completePublication`. This minted
    // approval has no submitted publication record behind it, so the act refuses
    // TYPED (409 on the `publication` gate) — never the old runless 404
    // ("Proposing agent no longer exists"). The end-to-end approve-publishes case
    // lives in kicktodo-creator-publish.test.ts. REJECT resolves as before.
    const a = await mintApproval();
    const claim = await post(adminCookie, CLAIM(a.approvalId));
    expect(claim.status).toBe(409);
    expect(String(claim.body.error ?? claim.body.code ?? '')).toContain('conflict');
    expect((await getApproval(a.approvalId))?.status).toBe('pending');
    const reject = await post(adminCookie, REJECT(a.approvalId));
    expect(reject.status).toBe(200);
    expect((await getApproval(a.approvalId))?.status).toBe('rejected');
  });
});
