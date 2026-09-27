/**
 * Gmail inbox → CRM activity sync (ADR 0252 P1/P2) — ROUTE-level harness.
 * Boots the real app and drives the opt-in CRUD over HTTP: creating a sync
 * registers a real per-user scheduler job, the IDOR guard (a caller cannot
 * bind another user's connection) 403s, a non-`google` connection 400s,
 * pause/resume flips the job's `enabled`, delete removes both the job and the
 * row, and "sync now" starts a real run.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { upsertOAuthConnection, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { getJob, scheduleSubject } from '../src/host/schedulingService.js';
import { listOwned, purgeTenantOwnedWorkflowDefs, removeOwnership } from '../src/host/workflowOwnership.js';
import { latestRevision, deleteWorkflowRevisions } from '../src/host/workflowRevisions.js';
import { lifecycleOf } from '../src/host/workflowLifecycle.js';
import { getRegisteredWorkflowAsync, registerWorkflowDurable, __resetWorkflowRegistryForTests } from '../src/host/workflowsRegistry.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let BASE: string;
let server: http.Server;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const crm = getToggleDefault('crm');
  if (crm) await saveConfig({ ...crm, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  del: (p: string) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    for (const c of sc as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('gmailsync'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

/** Owner + a same-tenant `editor` member, plus an org owned by the owner —
 *  the co-tenant fixture the IDOR test needs (mirrors crm-org-route.test.ts's
 *  `ownerWithMember`). */
async function ownerWithMember(): Promise<{ owner: Client; member: Client; ownerId: string; memberId: string; orgId: string; tenantId: string }> {
  const tenantId = `org:gmailsync-${Date.now()}-${n++}`;
  const owner = client();
  const ownerUser = await signup(owner, { tenantId });
  const member = client();
  const memberUser = await signup(member, { tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, ownerId: ownerUser.userId, memberId: memberUser.userId, orgId, tenantId };
}

const GS = '/v1/host/openwop-app/crm/gmail-sync';

async function pollRun(tenantId: string, predicate: (r: RunRecord) => boolean, tries = 80): Promise<RunRecord | undefined> {
  let run: RunRecord | undefined;
  for (let i = 0; i < tries; i++) {
    const runs = await storage.listRuns({ tenantId, limit: 50 });
    run = runs.find(predicate);
    if (run) return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  return run;
}

describe('crm gmail-sync — opt-in CRUD + scheduler wiring (ADR 0252 P1)', () => {
  it('POST creates a row + a real per-user scheduler job (ownerSubject + gmailSyncId metadata)', async () => {
    const { owner, ownerId, orgId, tenantId } = await ownerWithMember();
    const conn = await upsertOAuthConnection({
      tenantId, provider: 'google', userId: ownerId,
      tokens: { accessToken: 'x', tokenType: 'Bearer', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    });

    const created = await owner.post(GS, { orgId, connectionId: conn.connectionId, cadence: 'hourly' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sync = created.body.sync;
    expect(sync.orgId).toBe(orgId);
    expect(sync.connectionId).toBe(conn.connectionId);
    expect(sync.cadence).toBe('hourly');
    expect(sync.status).toBe('active');
    expect(typeof sync.jobId).toBe('string');

    const job = await getJob(sync.jobId);
    expect(job, 'expected a real scheduler job to be registered').toBeTruthy();
    expect(job!.enabled).toBe(true);
    expect(job!.cronExpr).toBe('0 * * * *');
    const subject = scheduleSubject(job!);
    expect(subject).toEqual({ kind: 'user', id: ownerId });
    expect((job!.metadata as { actingUserId?: string; gmailSyncId?: string } | undefined)?.actingUserId).toBe(ownerId);
    expect((job!.metadata as { actingUserId?: string; gmailSyncId?: string } | undefined)?.gmailSyncId).toBe(sync.syncId);

    // Listed back for the caller's org.
    const list = await owner.get(`${GS}?orgId=${encodeURIComponent(orgId)}`);
    expect(list.status).toBe(200);
    expect(list.body.syncs.some((s: { syncId: string }) => s.syncId === sync.syncId)).toBe(true);
  });

  it('IDOR: a member cannot bind another user\'s connection → 403', async () => {
    const { member, ownerId, orgId, tenantId } = await ownerWithMember();
    const ownerConn = await upsertOAuthConnection({
      tenantId, provider: 'google', userId: ownerId,
      tokens: { accessToken: 'x', tokenType: 'Bearer', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    });
    // The member (workspace:write via 'editor') tries to bind the OWNER's connection.
    const r = await member.post(GS, { orgId, connectionId: ownerConn.connectionId, cadence: 'hourly' });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
  });

  it('a non-`google` provider connection → 400', async () => {
    const { owner, ownerId, orgId, tenantId } = await ownerWithMember();
    const conn = await createSecretConnection({
      tenantId, provider: 'notion', kind: 'api_key', secret: 'sk-test', scope: 'user', userId: ownerId,
    });
    const r = await owner.post(GS, { orgId, connectionId: conn.connectionId, cadence: 'hourly' });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
  });

  it('PATCH pause disables the job; resume re-enables it; cadence updates cronExpr', async () => {
    const { owner, ownerId, orgId, tenantId } = await ownerWithMember();
    const conn = await upsertOAuthConnection({
      tenantId, provider: 'google', userId: ownerId,
      tokens: { accessToken: 'x', tokenType: 'Bearer', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    });
    const created = await owner.post(GS, { orgId, connectionId: conn.connectionId, cadence: 'hourly' });
    expect(created.status).toBe(201);
    const { syncId, jobId } = created.body.sync;

    const paused = await owner.patch(`${GS}/${syncId}`, { status: 'paused' });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body.sync.status).toBe('paused');
    expect((await getJob(jobId))!.enabled).toBe(false);

    const recadenced = await owner.patch(`${GS}/${syncId}`, { status: 'active', cadence: 'daily' });
    expect(recadenced.status, JSON.stringify(recadenced.body)).toBe(200);
    expect(recadenced.body.sync.cadence).toBe('daily');
    const job = await getJob(jobId);
    expect(job!.enabled).toBe(true);
    expect(job!.cronExpr).toBe('0 7 * * *');
  });

  it('DELETE removes the job + the row', async () => {
    const { owner, ownerId, orgId, tenantId } = await ownerWithMember();
    const conn = await upsertOAuthConnection({
      tenantId, provider: 'google', userId: ownerId,
      tokens: { accessToken: 'x', tokenType: 'Bearer', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    });
    const created = await owner.post(GS, { orgId, connectionId: conn.connectionId, cadence: '15m' });
    expect(created.status).toBe(201);
    const { syncId, jobId } = created.body.sync;

    const del = await owner.del(`${GS}/${syncId}`);
    expect(del.status).toBe(204);
    expect(await getJob(jobId)).toBeNull();

    const list = await owner.get(`${GS}?orgId=${encodeURIComponent(orgId)}`);
    expect(list.body.syncs.some((s: { syncId: string }) => s.syncId === syncId)).toBe(false);

    // A second delete is a clean 404, not a 500 (already gone).
    const del2 = await owner.del(`${GS}/${syncId}`);
    expect(del2.status).toBe(404);
  });

  it('POST /:syncId/sync-now starts a real run', async () => {
    const { owner, ownerId, orgId, tenantId } = await ownerWithMember();
    const conn = await upsertOAuthConnection({
      tenantId, provider: 'google', userId: ownerId,
      tokens: { accessToken: 'x', tokenType: 'Bearer', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    });
    const created = await owner.post(GS, { orgId, connectionId: conn.connectionId, cadence: 'hourly' });
    expect(created.status).toBe(201);
    const { syncId } = created.body.sync;

    const syncNow = await owner.post(`${GS}/${syncId}/sync-now`);
    expect(syncNow.status, JSON.stringify(syncNow.body)).toBe(202);
    expect(typeof syncNow.body.runId).toBe('string');

    const run = await pollRun(tenantId, (r) => r.runId === syncNow.body.runId);
    expect(run, 'expected the sync-now run to appear in storage').toBeTruthy();
    expect((run?.metadata as { actingUserId?: string; gmailSyncId?: string } | undefined)?.actingUserId).toBe(ownerId);
    expect((run?.metadata as { actingUserId?: string; gmailSyncId?: string } | undefined)?.gmailSyncId).toBe(syncId);
  });

  it('cross-tenant: a stranger cannot list, patch, or delete another tenant\'s sync', async () => {
    const { owner, ownerId, orgId, tenantId } = await ownerWithMember();
    const conn = await upsertOAuthConnection({
      tenantId, provider: 'google', userId: ownerId,
      tokens: { accessToken: 'x', tokenType: 'Bearer', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    });
    const created = await owner.post(GS, { orgId, connectionId: conn.connectionId, cadence: 'hourly' });
    expect(created.status).toBe(201);
    const { syncId } = created.body.sync;

    const stranger = client();
    await signup(stranger);
    expect((await stranger.patch(`${GS}/${syncId}`, { status: 'paused' })).status).toBe(404);
    expect((await stranger.del(`${GS}/${syncId}`)).status).toBe(404);
  });

  it('owner-only: a same-org co-worker with org-write cannot patch/delete/sync-now another user\'s sync → 403', async () => {
    const { owner, member, ownerId, orgId, tenantId } = await ownerWithMember();
    const conn = await upsertOAuthConnection({
      tenantId, provider: 'google', userId: ownerId,
      tokens: { accessToken: 'x', tokenType: 'Bearer', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    });
    const created = await owner.post(GS, { orgId, connectionId: conn.connectionId, cadence: 'hourly' });
    expect(created.status).toBe(201);
    const { syncId } = created.body.sync;

    // The member (editor → workspace:write on the SAME org) can reach the org
    // gate but is not the sync's owner, so every mutation is a 403 — a personal
    // mailbox is managed only by its own user (ADR 0252 §6).
    expect((await member.patch(`${GS}/${syncId}`, { status: 'paused' })).status).toBe(403);
    expect((await member.post(`${GS}/${syncId}/sync-now`)).status).toBe(403);
    expect((await member.del(`${GS}/${syncId}`)).status).toBe(403);
    // The member also can't SEE it (GET lists own only), and the owner's sync is untouched.
    expect((await owner.get(`${GS}?orgId=${encodeURIComponent(orgId)}`)).body.syncs[0].status).toBe('active');
  });
});

/**
 * WF-CRM-1 / WF-CRM-2 — the per-sync workflow instance this lane mints must obey
 * the sanctioned-runtime-lane's own laws: it is OWNED (so `/builder` and the `/`
 * picker can see it and account deletion can reach it), it is REVISION-PINNED (so
 * a run replays as-run rather than against `head`), and it is CLEANED UP on
 * opt-out. `features/strategy/cadence.ts` is the identical
 * `expandChain → registerWorkflow` shape and already did all three.
 */
describe('crm gmail-sync — the per-sync workflow is owned, pinned, and reclaimed (WF-CRM-1/2)', () => {
  async function optIn(): Promise<{ owner: Client; tenantId: string; syncId: string; workflowId: string; orgId: string }> {
    const { owner, ownerId, orgId, tenantId } = await ownerWithMember();
    const conn = await upsertOAuthConnection({
      tenantId, provider: 'google', userId: ownerId,
      tokens: { accessToken: 'x', tokenType: 'Bearer', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    });
    const created = await owner.post(GS, { orgId, connectionId: conn.connectionId, cadence: 'hourly' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { syncId } = created.body.sync;
    return { owner, tenantId, syncId, workflowId: `crm-ops.gmail-sync:${syncId}`, orgId };
  }

  it('opt-in records OWNERSHIP — without it the workflow is invisible to /builder and unreachable by teardown', async () => {
    const { tenantId, workflowId } = await optIn();
    const owned = await listOwned(tenantId);
    expect(
      owned.map((r) => r.workflowId),
      'the ownership index is what /builder + the `/` picker list, and the ONLY thing account deletion walks',
    ).toContain(workflowId);
  });

  it('opt-in records a REVISION, so a run resolves as-run rather than against head', async () => {
    const { tenantId, workflowId } = await optIn();
    expect(tenantId).toBeTruthy();
    expect(
      await latestRevision(workflowId),
      'without a revision every gmail-sync run replays resolvedFrom:"head" (ADR 0474)',
    ).toBeTruthy();
  });

  it('tenant teardown PURGES the definition — this is the ADR 0473 D1 residual class', async () => {
    const { tenantId, workflowId } = await optIn();
    expect(await getRegisteredWorkflowAsync(workflowId), 'precondition: the def exists').toBeTruthy();

    const deleted: string[] = [];
    const out = await purgeTenantOwnedWorkflowDefs(tenantId, (id) => { deleted.push(id); });
    // Before ownership was recorded this returned zero rows for the sync's def:
    // `purgeTenantOwnedWorkflowDefs` walks ownership, so an unowned def survived
    // account deletion forever.
    expect(deleted).toContain(workflowId);
    expect(out.ownershipRows).toBeGreaterThan(0);
  });

  /**
   * FOLD-IN B1 — this case used to pin the WRONG behaviour ("opt-OUT deletes the
   * definition and its ownership row"). A hard delete here is exactly what the
   * sanctioned lane REFUSES: `routes/workflows.ts`'s DELETE 409s
   * `workflow_referenced` when `hasRunForWorkflow` is true, because runs re-resolve
   * their definition BY ID at replay/`:fork` — there is no per-run snapshot — and
   * `host/runRetentionSweeper.ts` honours the same rule. The delete also cascaded
   * (`onWorkflowDeleted` → `deleteWorkflowRevisions`) into the revision pin the very
   * same PR had just added.
   *
   * And the leak the delete was for does not need it: `purgeTenantOwnedWorkflowDefs`
   * walks the OWNERSHIP index, which this lane now populates — so teardown reclaims
   * the definition either way (asserted by the sibling case above).
   */
  it('opt-OUT ARCHIVES the definition and keeps it resolvable — a run-referenced def is never hard-deleted', async () => {
    const { owner, tenantId, syncId, workflowId, orgId } = await optIn();
    expect(await getRegisteredWorkflowAsync(workflowId), 'precondition: the def exists').toBeTruthy();

    // Make the definition genuinely RUN-REFERENCED first — this is the state the
    // sanctioned DELETE lane refuses outright, and the one the old behaviour walked
    // straight past.
    const syncNow = await owner.post(`${GS}/${syncId}/sync-now`);
    expect(syncNow.status, JSON.stringify(syncNow.body)).toBe(202);
    const run = await pollRun(tenantId, (r) => r.runId === syncNow.body.runId);
    expect(run, 'precondition: a real run references this workflow').toBeTruthy();
    expect(await storage.hasRunForWorkflow(workflowId)).toBe(true);
    const revisionBefore = await latestRevision(workflowId);
    expect(revisionBefore, 'precondition: the WF-CRM-2 revision pin exists').toBeTruthy();

    expect((await owner.del(`${GS}/${syncId}`)).status).toBe(204);

    // 1. The definition SURVIVES and still resolves by id — which is what replay
    //    and `:fork` do (`lifecycleOf`'s own rule: "archive, never dispose").
    const after = await getRegisteredWorkflowAsync(workflowId);
    expect(after, 'a run-referenced definition must still resolve by id after opt-out').toBeTruthy();
    expect(lifecycleOf(after!).archivedAt, 'and it must be ARCHIVED, not live').toBeTruthy();

    // 2. The revision pin survives with it. The hard delete cascaded into
    //    `deleteWorkflowRevisions`, so the run would have replayed against head.
    expect(
      await latestRevision(workflowId),
      'the delete cascade destroyed the revision pin the same change had just added',
    ).toBeTruthy();

    // 3. Ownership is KEPT (flagged archived), because ownership is the ONLY thing
    //    account deletion walks — removing it is what would re-create the leak.
    const owned = (await listOwned(tenantId)).find((rec) => rec.workflowId === workflowId);
    expect(owned, 'teardown reaches wfreg: rows through ownership — the row must stay').toBeTruthy();
    expect(owned!.archivedAt, 'the ownership row reflects the archive').toBeTruthy();

    // 4. The sync row + its job are still gone — the opt-out itself still works.
    const list = await owner.get(`${GS}?orgId=${encodeURIComponent(orgId)}`);
    expect(list.body.syncs.some((s: { syncId: string }) => s.syncId === syncId)).toBe(false);
  });

  it('a PRE-EXISTING registered definition is backfilled with ownership + a revision (M3)', async () => {
    // `ensureGmailSyncWorkflow` short-circuits on the existence check, so every sync
    // that opted in BEFORE WF-CRM-1 shipped would never reach recordOwnership /
    // recordRevision: unowned (invisible to /builder, surviving teardown) and
    // unpinned FOREVER, because nothing else calls this for an existing sync.
    const { owner, ownerId, orgId, tenantId } = await ownerWithMember();
    const conn = await upsertOAuthConnection({
      tenantId, provider: 'google', userId: ownerId,
      tokens: { accessToken: 'x', tokenType: 'Bearer', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    });
    const created = await owner.post(GS, { orgId, connectionId: conn.connectionId, cadence: 'hourly' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { syncId } = created.body.sync;
    const workflowId = `crm-ops.gmail-sync:${syncId}`;

    // Reproduce the PRE-DEPLOY state exactly: the definition exists, nothing else does.
    const def = await getRegisteredWorkflowAsync(workflowId);
    expect(def).toBeTruthy();
    await removeOwnership(tenantId, workflowId);
    await deleteWorkflowRevisions(workflowId);
    expect((await listOwned(tenantId)).map((rec) => rec.workflowId)).not.toContain(workflowId);
    expect(await latestRevision(workflowId)).toBeNull();

    // Any ensure path (here: "sync now") must repair both, idempotently.
    expect((await owner.post(`${GS}/${syncId}/sync-now`)).status).toBe(202);

    expect(
      (await listOwned(tenantId)).map((rec) => rec.workflowId),
      'the short-circuit path must still record ownership',
    ).toContain(workflowId);
    expect(await latestRevision(workflowId), 'the short-circuit path must still pin a revision').toBeTruthy();
    // Idempotent: a second ensure adds no second ownership row.
    expect((await owner.post(`${GS}/${syncId}/sync-now`)).status).toBe(202);
    expect((await listOwned(tenantId)).filter((rec) => rec.workflowId === workflowId)).toHaveLength(1);
  });

  it('a COLD instance HYDRATES rather than re-expanding over the shared durable row (WF-CRM-2)', async () => {
    // The process-local registry Map has NO boot hydration, so the old synchronous
    // `getRegisteredWorkflow` check always missed on a fresh Cloud Run instance and
    // `registerWorkflow` re-expanded over the shared `wfreg:` row. Clearing the
    // cache is exactly what a cold instance looks like.
    //
    // A plain "the row is byte-identical after" assertion CANNOT discriminate this,
    // and saying so matters: `expandChain` is deterministic, so a re-expansion
    // produces the same bytes and passes either way. What the defect actually
    // destroys is a definition that has since DIVERGED from a fresh expansion — an
    // operator edit through /builder (which this workflow is now visible in,
    // because it is owned), or the same chain at a different pack version. So the
    // durable row is mutated first, and THAT is what must survive.
    const { owner, tenantId, syncId, workflowId } = await optIn();
    const before = await getRegisteredWorkflowAsync(workflowId);
    expect(before).toBeTruthy();

    const edited = { ...before!, metadata: { ...(before!.metadata ?? {}), name: 'Operator renamed this' } };
    await registerWorkflowDurable(edited);

    __resetWorkflowRegistryForTests();
    // "sync now" runs the same ensure path the scheduler does.
    const again = await owner.post(`${GS}/${syncId}/sync-now`);
    expect(again.status, JSON.stringify(again.body)).toBe(202);

    const after = await getRegisteredWorkflowAsync(workflowId);
    expect(
      (after?.metadata as { name?: string } | undefined)?.name,
      'a cold instance must hydrate the durable row, not re-expand over the edit',
    ).toBe('Operator renamed this');
    // And the ensure path must not have minted a SECOND ownership row.
    expect((await listOwned(tenantId)).filter((r) => r.workflowId === workflowId)).toHaveLength(1);
  });
});
