/**
 * ADR 0460 Phase 2 — the admin Exception Ledger READ route + the wired sources.
 *
 *  - the read is manage-gated: an editor (workspace:write, NO manage) gets 403
 *    forbidden_scope (not a leaky 404); an admin (host:kicktodo:manage) gets 200;
 *  - the four KickTodo sources are registered at boot and compose (a fresh tenant
 *    → all four `ok:true`, zero rows — honest empty, never a painted status);
 *  - a real pending challenge-publish approval surfaces as an action-required row
 *    (proving the approvals source + projection + route end-to-end).
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
import { createChallengePublishApproval } from '../src/host/approvalService.js';

let BASE: string;
let server: http.Server;
let wsTenant: string;
let editorCookie: string;
let adminCookie: string;

const EXC = () => `/v1/host/openwop-app/kicktodo/admin/exceptions`;

const craftCookie = (userId: string, activeTenant: string, personalTenant: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: activeTenant, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const seatMember = async (principalId: string, roles: string[], personalTenant: string): Promise<string> => {
  const user = await upsertFromPrincipal({ tenantId: wsTenant, principalId, source: 'oidc' });
  await createMember({ tenantId: wsTenant, orgId: wsTenant, subject: user.userId, displayName: principalId, roles });
  return craftCookie(user.userId, wsTenant, personalTenant);
};
interface LedgerBody {
  error?: string;
  code?: string;
  rows: Array<{ id: string; source: string; severity: string; owner: { ref: string } }>;
  sources: Array<{ key: string; ok: boolean; count: number; truncated: boolean }>;
  // ADR 0301 audit slice (#2401) — the `/audit?approvalId=` projection returns
  // decision-log entries; the local response type must carry them.
  entries?: Array<{ at: string; payload: Record<string, unknown> }>;
}
const call = async (cookie: string, path: string): Promise<{ status: number; body: LedgerBody }> => {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as LedgerBody };
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'kicktodo-core', 'kicktodo-creator', 'kicktodo-commerce', 'kicktodo-community']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const ws = await createWorkspace({ name: 'KT Exceptions', ownerSubject: 'oidc:exc-owner' });
  wsTenant = ws.tenantId;
  editorCookie = await seatMember('oidc:exc-editor', ['editor'], 'ws:home-exc-editor');
  adminCookie = await seatMember('oidc:exc-admin', ['admin'], 'ws:home-exc-admin');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0460 P2 — Exception Ledger read', () => {
  it('an editor (no manage) gets 403 forbidden_scope — not a leaky 404', async () => {
    const r = await call(editorCookie, EXC());
    expect(r.status).toBe(403);
    expect(String(r.body?.error ?? r.body?.code ?? '')).toContain('forbidden_scope');
  });

  it('an admin gets 200; the sources are wired and healthy on a fresh tenant', async () => {
    const r = await call(adminCookie, EXC());
    expect(r.status).toBe(200);
    const keys = (r.body.sources as Array<{ key: string; ok: boolean }>).map((s) => s.key).sort();
    // chat-first-port F3 added the commerce-connect:disputes source alongside the
    // five kicktodo sources (any feature may register one — ADR 0460); MPL-5 then
    // added commerce-connect:order-anomalies, the captured-but-unfulfilled detector
    // that replaced a polling sweep. This list is exhaustive on purpose: a feature
    // that registers a source without landing here is an unannounced surface.
    expect(keys).toEqual(['commerce-connect:disputes', 'commerce-connect:order-anomalies', 'kicktodo:approvals', 'kicktodo:monitor', 'kicktodo:payouts', 'kicktodo:review-flags', 'kicktodo:wearable-stale']);
    expect((r.body.sources as Array<{ ok: boolean }>).every((s) => s.ok)).toBe(true);
    // honest empty — a fresh tenant has no exceptions, NOT a painted status
    expect(r.body.rows).toEqual([]);
  });

  it('a pending challenge-publish approval surfaces as an action-required row', async () => {
    await createChallengePublishApproval({
      tenantId: wsTenant,
      proposal: 'Publish "Gratitude Notes"',
      candidateId: 'cand:x',
      challengeId: 'chal:x',
      challengeVersion: 1,
      submittedBy: 'user:author',
    });
    const r = await call(adminCookie, EXC());
    expect(r.status).toBe(200);
    const rows = r.body.rows as Array<{ id: string; source: string; severity: string; owner: { ref: string } }>;
    const approvalRow = rows.find((x) => x.source === 'kicktodo:approvals');
    expect(approvalRow).toBeDefined();
    expect(approvalRow!.id).toMatch(/^approval:appr:/);
    expect(approvalRow!.severity).toBe('action-required');
    expect(approvalRow!.owner.ref).toBe('user:author'); // server-authoritative owner (submitter)
  });
});

describe('SCREEN_POLISH — the ADR 0301 chain slice behind an approval row', () => {
  it('a resolved approval yields actor→before→after (+note verbatim); missing param 400s; unknown id is an honest empty', async () => {
    const { resolveApproval } = await import('../src/host/approvalService.js');
    const appr = await createChallengePublishApproval({
      tenantId: wsTenant,
      proposal: 'Publish "Deep Reading"',
      candidateId: 'cand:slice',
      challengeId: 'chal:slice',
      challengeVersion: 1,
      submittedBy: 'user:author',
    });
    await resolveApproval(appr.approvalId, { status: 'rejected', decidedBy: 'user:approver', note: 'Needs a citation.' });

    const r = await call(adminCookie, `${EXC()}/audit?approvalId=${encodeURIComponent(appr.approvalId)}`);
    expect(r.status).toBe(200);
    const entries = r.body.entries as Array<{ at: string; payload: Record<string, unknown> }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.payload).toMatchObject({
      approvalId: appr.approvalId,
      approvalKind: 'challenge-publish',
      outcome: 'rejected',
      before: 'pending',
      actor: 'user:approver',
      note: 'Needs a citation.',
    });

    expect((await call(adminCookie, `${EXC()}/audit`)).status).toBe(400);
    const empty = await call(adminCookie, `${EXC()}/audit?approvalId=appr:nope`);
    expect(empty.status).toBe(200);
    expect(empty.body.entries).toEqual([]);
  });
});
