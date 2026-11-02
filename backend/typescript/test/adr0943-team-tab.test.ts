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
 * DOUBLE GUARD (client isolation of bindings, `agentBindingService.ts`
 * `listAgentBindings`): guard 1 is the per-client prefix read
 * `listByPrefix(\`${tenantId}::${orgId}::\`)`, guard 2 the in-memory
 * `.filter((b) => b.tenantId === tenantId && b.orgId === orgId)`. Dropping guard 2
 * alone stays green (w73 probe `team-bindings-filteronly`, measured vacuous): the
 * prefix already scopes the read. The one-edit probe that breaks BOTH (a
 * tenant-wide prefix and a tenant-only filter, `team-bindings-tenantwide`) reds
 * "shows a client's own binding" (measured witnessed, w73).
 *
 * Sabotages measured red (w73, `/grade-tests`): both binding guards in one edit;
 * `canEdit` from the read predicate; the reader gate replaced by a bare user id;
 * evals read without the access predicate (scores with evals off); the non-team
 * pin row dropped; the suite filter dropped from the team list; and (round 2,
 * asymmetric fixture) the `status !== 'completed'` filter in `latestEval` (a NEWER
 * failed run then wins) and newest-first order (the OLDER completed run wins).
 *
 * Order-independent: case 1 reads a client of its own; the evals toggle is
 * restored in `finally`.
 */
import http from 'node:http';
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
async function call(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; raw: string }> {
  const res = await fetch(`${BASE}/host/openwop-app/campaign-ops${path}`, {
    method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed, raw };
}
type TeamRead = TeamView & { canEdit?: boolean };
/** Narrows a parsed body to the Team view (a type guard, not a cast). */
function isTeam(v: unknown): v is TeamRead {
  return typeof v === 'object' && v !== null && 'members' in v && Array.isArray(v.members)
    && 'evals' in v && typeof v.evals === 'object';
}
function team(r: { body: unknown; raw: string }): TeamRead {
  if (!isTeam(r.body)) throw new Error(`not a Team view: ${r.raw}`);
  return r.body;
}
function isErr(v: unknown): v is { error: string; message: string } {
  return typeof v === 'object' && v !== null && 'error' in v && typeof v.error === 'string' && 'message' in v && typeof v.message === 'string';
}
function errOf(r: { body: unknown; raw: string }): { error: string; message: string } {
  if (!isErr(r.body)) throw new Error(`not an error envelope: ${r.raw}`);
  return { error: r.body.error, message: r.body.message };
}
async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}
async function restoreToggle(id: string): Promise<void> {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d }, 'test');
}
/** A client of the case's own (so no other case's binding can reach it). */
async function freshClient(name: string): Promise<string> {
  const orgId = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name })).orgId;
  const r = await call(adminCookie, 'POST', '/clients', { name, orgId });
  if (r.status !== 201) throw new Error(`client create failed: ${r.status} ${r.raw}`);
  return orgId;
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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('server has no TCP address');
  BASE = `http://127.0.0.1:${addr.port}`;
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
    const orgC = await freshClient(`Client C ${randomBytes(3).toString('hex')}`);
    const r = await call(adminCookie, 'GET', `/clients/${orgC}/team`);
    expect(r.status, r.raw).toBe(200);
    const view = team(r);
    const roles = teamFromPacks();
    expect(roles.length).toBe(10);
    expect(view.members.filter((m) => m.role.teamRole).map((m) => m.role.agentId).sort()).toEqual(roles);
    expect(view.members.every((m) => m.binding === null)).toBe(true);
    expect(view.canEdit).toBe(true);
  });

  it("shows a client's own binding on the role it overrides, never another client's", async () => {
    const pin = teamFromPacks()[0];
    if (!pin) throw new Error('no team role loaded');
    // Bind B's role to a custom agent that holds the pin's tools; A stays on the default.
    const pinTools = getAgentRegistry().get(pin)?.toolAllowlist ?? [];
    getAgentRegistry().register({ modelClass: 'general', systemPrompt: 'x', packName: 'test', packVersion: '0', agentId: 'test.cs.b-writer', persona: 'B writer', toolAllowlist: [...pinTools] });
    const put = await call(adminCookie, 'PUT', `/clients/${orgB}/agent-bindings`, { pinnedAgentId: pin, agentId: 'test.cs.b-writer' });
    expect(put.status, put.raw).toBe(200);
    const a = team(await call(adminCookie, 'GET', `/clients/${orgA}/team`));
    expect(a.members.find((m) => m.role.agentId === pin)?.binding).toBeNull();
    const b = team(await call(adminCookie, 'GET', `/clients/${orgB}/team`));
    expect(b.members.find((m) => m.role.agentId === pin)?.binding).toMatchObject({ agent: { agentId: 'test.cs.b-writer', label: 'B writer' } });
  });

  it('a bound pin that is not a team role still gets a row', async () => {
    getAgentRegistry().register({ modelClass: 'general', systemPrompt: 'x', packName: 'test', packVersion: '0', agentId: 'test.cs.custom-replacement', persona: 'Custom replacement', toolAllowlist: [] });
    expect((await call(adminCookie, 'PUT', `/clients/${orgA}/agent-bindings`, { pinnedAgentId: CUSTOM_PIN, agentId: 'test.cs.custom-replacement' })).status).toBe(200);
    const a = team(await call(adminCookie, 'GET', `/clients/${orgA}/team`));
    const row = a.members.find((m) => m.role.agentId === CUSTOM_PIN);
    expect(row).toMatchObject({ role: { teamRole: false, label: 'Custom pin' }, binding: { agent: { agentId: 'test.cs.custom-replacement' } } });
  });

  it('canEdit follows the write predicate: a client-org reader sees the team but cannot edit', async () => {
    const r = await call(readerCookie, 'GET', `/clients/${orgA}/team`);
    expect(r.status, r.raw).toBe(200);
    expect(team(r).canEdit).toBe(false);
    // A reader of the client is told it lacks the write scope (it can read the client).
    const put = await call(readerCookie, 'PUT', `/clients/${orgA}/agent-bindings`, { pinnedAgentId: CUSTOM_PIN, agentId: CUSTOM_PIN });
    expect(put.status, put.raw).toBe(403);
    expect(errOf(put).error).toBe('forbidden_scope');
    // Another client is the uniform 404: the same refusal as a client that does not exist.
    const other = await call(readerCookie, 'GET', `/clients/${orgB}/team`);
    const missing = await call(readerCookie, 'GET', `/clients/org-${randomBytes(4).toString('hex')}/team`);
    expect(other.status, other.raw).toBe(404);
    expect(missing.status, missing.raw).toBe(404);
    expect(errOf(other)).toEqual({ error: 'not_found', message: 'Client not found.' });
    expect(errOf(other)).toEqual(errOf(missing));
  });

  it('eval scores ride the evals access predicate: off ⇒ unavailable and null, on ⇒ the latest completed run', async () => {
    const role = teamFromPacks()[0];
    const manifest = role ? getAgentRegistry().get(role) : null;
    const suite = manifest ? packSuiteFor(manifest) : null;
    if (!role || !suite) throw new Error('no team role with a suite loaded');
    const ref = suiteRef(suite);
    // Asymmetric on purpose: an OLDER completed run (0.4), the LATEST completed run
    // (0.9), and a NEWER failed run (0.1). `listRuns` reads newest-first
    // (created_at DESC), so only "the latest COMPLETED" answers 0.9.
    const base = Date.now();
    const evalRun = (offsetMs: number, status: RunRecord['status'], score: number, passedCount: number): RunRecord => {
      const at = new Date(base + offsetMs).toISOString();
      return {
        runId: `run-team-eval-${randomBytes(6).toString('hex')}`, workflowId: evalWorkflowId(ref), tenantId: TENANT, status,
        inputs: {}, configurable: {}, createdAt: at, updatedAt: at, ...(status === 'completed' ? { completedAt: at } : {}),
        metadata: { eval: { kind: 'agent-suite', suiteRef: ref, agentId: role }, evalSummary: { aggregateScore: score, passed: score >= 0.5, passedCount, taskCount: 10 } },
      };
    };
    await storage.insertRun(evalRun(-2000, 'completed', 0.4, 4));
    const latest = evalRun(-1000, 'completed', 0.9, 9);
    await storage.insertRun(latest);
    await storage.insertRun(evalRun(0, 'failed', 0.1, 1));

    try {
      await setToggle('evals', false);
      const off = team(await call(adminCookie, 'GET', `/clients/${orgA}/team`));
      expect(off.evals).toMatchObject({ available: false });
      expect(off.members.every((m) => m.role.eval === null)).toBe(true);

      await setToggle('evals', true);
      const on = team(await call(adminCookie, 'GET', `/clients/${orgA}/team`));
      expect(on.evals).toEqual({ available: true });
      expect(on.members.find((m) => m.role.agentId === role)?.role.eval).toMatchObject({ suiteRef: ref, runId: latest.runId, aggregateScore: 0.9, passed: true, passedCount: 9, taskCount: 10 });
    } finally {
      await restoreToggle('evals');
    }
  });
});
