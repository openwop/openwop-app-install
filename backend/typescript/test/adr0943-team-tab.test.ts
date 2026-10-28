/**
 * ADR 0943 P4 — the Team tab's one read, `GET …/campaign-ops/clients/:orgId/team`.
 *
 *   - the team is DATA: every suite-carrying agent of the team packs is a row,
 *     read from the real packs (no role id in this file's assertions beyond the
 *     pack data itself);
 *   - a client sees ITS binding on the role it overrides, never another client's;
 *   - a pinned agent the client bound that is not a team role still gets a row;
 *   - `canEdit` is decided by the write predicate: an agency admin true, a
 *     client-org reader false (the PUT it would make is a 403/404);
 *   - eval scores ride the ONE evals access predicate: with evals off the view
 *     says `available:false` and every score is null, never a fake empty; with
 *     evals on, the latest COMPLETED run of the role's suite is its score;
 *   - a reader of another client gets the uniform 404.
 *
 * Sabotage notes (2026-10-20): read bindings tenant-wide instead of the
 * per-client prefix in `listAgentBindings` → red (B's binding shows on A).
 * Dropping only the in-memory org filter stays green, correctly: the prefix read
 * already scopes to the client, so the filter is a second guard; compute `canEdit` from the read predicate → red;
 * read evals without the access predicate → red (scores with evals off).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { packSuiteFor } from '../src/host/evals/packSuites.js';
import { evalWorkflowId, suiteRef } from '../src/host/evals/suiteStore.js';
import { TEAM_PACKS, type TeamView } from '../src/features/campaign-ops/teamService.js';

const PACKS = join(dirname(fileURLToPath(import.meta.url)), '../../../packs');
let BASE: string;
let server: http.Server;
let storage: Storage;
let TENANT: string;
let adminCookie: string;
let readerCookie: string;
let orgA: string;
let orgB: string;

const CUSTOM_PIN = 'test.cs.custom-pin';

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}
async function call<T = Record<string, unknown>>(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; raw: string }> {
  const res = await fetch(`${BASE}/host/openwop-app/campaign-ops${path}`, {
    method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}
async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

/** The team per the packs: suite-carrying agents of the team packs. */
function teamFromPacks(): string[] {
  return getAgentRegistry().list().filter((a) => TEAM_PACKS.includes(a.packName) && packSuiteFor(a)).map((a) => a.agentId).sort();
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'campaign-ops']) await setToggle(id, true);
  for (const pack of TEAM_PACKS) loadAgentsFromManifest(join(PACKS, pack));
  const base = { modelClass: 'general', systemPrompt: 'x', packName: 'test', packVersion: '0' } as const;
  getAgentRegistry().register({ ...base, agentId: CUSTOM_PIN, persona: 'Custom pin', toolAllowlist: [] });
  const ws = await createWorkspace({ name: 'Team Agency', ownerSubject: 'oidc:team-owner' });
  TENANT = ws.tenantId;
  const admin = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:team-admin', source: 'oidc' });
  const reader = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:team-reader', source: 'oidc' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin.userId, displayName: 'Admin', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: reader.userId, displayName: 'Reader', roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: reader.userId, displayName: 'Reader', roles: ['viewer'] });
  adminCookie = cookieFor(admin.userId, 'ws:home-team-admin');
  readerCookie = cookieFor(reader.userId, 'ws:home-team-reader');
  for (const [orgId, name] of [[orgA, 'Client A'], [orgB, 'Client B']] as const) {
    expect((await call(adminCookie, 'POST', '/clients', { name, orgId })).status).toBe(201);
  }
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0943 P4 — the Team read', () => {
  it('lists every suite-carrying agent of the team packs, with no binding yet', async () => {
    const r = await call<TeamView & { canEdit: boolean }>(adminCookie, 'GET', `/clients/${orgA}/team`);
    expect(r.status, r.raw).toBe(200);
    const team = teamFromPacks();
    expect(team.length).toBe(10);
    expect(r.body.members.filter((m) => m.role.teamRole).map((m) => m.role.agentId).sort()).toEqual(team);
    expect(r.body.members.every((m) => m.binding === null)).toBe(true);
    expect(r.body.canEdit).toBe(true);
  });

  it("shows a client's own binding on the role it overrides, never another client's", async () => {
    const pin = teamFromPacks()[0];
    if (!pin) throw new Error('no team role loaded');
    // Bind B's role to a custom agent that holds the pin's tools; A stays on the default.
    const pinTools = getAgentRegistry().get(pin)?.toolAllowlist ?? [];
    getAgentRegistry().register({ modelClass: 'general', systemPrompt: 'x', packName: 'test', packVersion: '0', agentId: 'test.cs.b-writer', persona: 'B writer', toolAllowlist: [...pinTools] });
    const put = await call(adminCookie, 'PUT', `/clients/${orgB}/agent-bindings`, { pinnedAgentId: pin, agentId: 'test.cs.b-writer' });
    expect(put.status, put.raw).toBe(200);
    const a = await call<TeamView>(adminCookie, 'GET', `/clients/${orgA}/team`);
    expect(a.body.members.find((m) => m.role.agentId === pin)?.binding).toBeNull();
    const b = await call<TeamView>(adminCookie, 'GET', `/clients/${orgB}/team`);
    expect(b.body.members.find((m) => m.role.agentId === pin)?.binding).toMatchObject({ agent: { agentId: 'test.cs.b-writer', label: 'B writer' } });
  });

  it('a bound pin that is not a team role still gets a row', async () => {
    getAgentRegistry().register({ modelClass: 'general', systemPrompt: 'x', packName: 'test', packVersion: '0', agentId: 'test.cs.custom-replacement', persona: 'Custom replacement', toolAllowlist: [] });
    expect((await call(adminCookie, 'PUT', `/clients/${orgA}/agent-bindings`, { pinnedAgentId: CUSTOM_PIN, agentId: 'test.cs.custom-replacement' })).status).toBe(200);
    const a = await call<TeamView>(adminCookie, 'GET', `/clients/${orgA}/team`);
    const row = a.body.members.find((m) => m.role.agentId === CUSTOM_PIN);
    expect(row).toMatchObject({ role: { teamRole: false, label: 'Custom pin' }, binding: { agent: { agentId: 'test.cs.custom-replacement' } } });
  });

  it('canEdit follows the write predicate: a client-org reader sees the team but cannot edit', async () => {
    const r = await call<TeamView & { canEdit: boolean }>(readerCookie, 'GET', `/clients/${orgA}/team`);
    expect(r.status, r.raw).toBe(200);
    expect(r.body.canEdit).toBe(false);
    const put = await call(readerCookie, 'PUT', `/clients/${orgA}/agent-bindings`, { pinnedAgentId: CUSTOM_PIN, agentId: CUSTOM_PIN });
    expect([403, 404]).toContain(put.status);
    expect((await call(readerCookie, 'GET', `/clients/${orgB}/team`)).status).toBe(404);
  });

  it('eval scores ride the evals access predicate: off ⇒ unavailable and null, on ⇒ the latest completed run', async () => {
    const role = teamFromPacks()[0];
    const manifest = role ? getAgentRegistry().get(role) : null;
    const suite = manifest ? packSuiteFor(manifest) : null;
    if (!role || !suite) throw new Error('no team role with a suite loaded');
    const ref = suiteRef(suite);
    const now = new Date().toISOString();
    await storage.insertRun({
      runId: `run-team-eval-${randomBytes(6).toString('hex')}`, workflowId: evalWorkflowId(ref), tenantId: TENANT, status: 'completed',
      inputs: {}, configurable: {}, createdAt: now, updatedAt: now, completedAt: now,
      metadata: { eval: { kind: 'agent-suite', suiteRef: ref, agentId: role }, evalSummary: { aggregateScore: 0.9, passed: true, passedCount: 9, taskCount: 10 } },
    } as RunRecord);

    await setToggle('evals', false);
    const off = await call<TeamView>(adminCookie, 'GET', `/clients/${orgA}/team`);
    expect(off.body.evals).toMatchObject({ available: false });
    expect(off.body.members.every((m) => m.role.eval === null)).toBe(true);

    await setToggle('evals', true);
    const on = await call<TeamView>(adminCookie, 'GET', `/clients/${orgA}/team`);
    expect(on.body.evals).toEqual({ available: true });
    expect(on.body.members.find((m) => m.role.agentId === role)?.role.eval).toMatchObject({ suiteRef: ref, aggregateScore: 0.9, passed: true, passedCount: 9, taskCount: 10 });
  });
});
