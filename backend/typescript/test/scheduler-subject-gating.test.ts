/**
 * ADR 0608 Tier 1 (`CPC-1`) — the GENERIC scheduler door must honour the same
 * subject gate the project door does.
 *
 * A project schedule is an ordinary `ScheduledJob` stamped
 * `ownerSubject = {kind:'project', id}` (`features/projects/projectScheduleService.ts:92-99`).
 * Before this fix `routes/scheduler.ts` never mentioned `ownerSubject` at all:
 * the list handler filtered by `tenantOf(req)` only, and `jobAccessible`
 * short-circuited `if (job.tenantId === tenantOf(req)) return true`. So a
 * co-tenant with ZERO org scopes could list a `private` project's job, PATCH it
 * (re-pointing `workflowId` at their own workflow), `POST …/trigger` it, and
 * DELETE it — a private-read leak AND a `requireProject('workspace:write')`
 * bypass, on four separate verbs.
 *
 * This file witnesses EACH VERB independently (list / patch / trigger / delete),
 * in three caller shapes, and carries the positive controls that stop a dead
 * cure from reading green:
 *   - an UNSCOPED co-tenant is refused everywhere (the leak),
 *   - a project MEMBER with read-only authority can LIST but not mutate (the
 *     write bypass — read and write are separate arms),
 *   - the org WRITER can still do all four (the cure did not brick the feature),
 *   - a job with NO `ownerSubject` is still reachable by any tenant member (the
 *     legacy ADR 0025 rule is untouched — the cure is not a blanket deny).
 *
 * Every refusal is asserted by its exact body (`not_found` + "Scheduled job <id>
 * not found." / `forbidden_scope` + "Missing required scope: workspace:write"),
 * never by status alone, so an earlier 404/403 from another layer cannot stand
 * in for `authorizeJob`. Sabotage witnesses (grade-tests 8f w2): sg-list-gate,
 * sg-subject-fallthrough, sg-write-arm, sg-tenant-scope.
 *
 * @see docs/adr/0608-collaborative-projects-visibility-and-browser-cadence.md
 * @see docs/steward/CODEBASE-ASSESSMENT.md `CPC-1`
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { registerJob, resetScheduling } from '../src/host/schedulingService.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** A response body is typed at each call site (no `any` default). */
interface Res<T> { status: number; body: T }
/** The error envelope every refusal on these doors returns. */
interface ErrBody { error: string; message: string }
interface JobRow { jobId: string; workflowId?: string; cronExpr: string }
interface JobList { jobs: JobRow[] }
interface Client {
  get: <T>(p: string) => Promise<Res<T>>;
  post: <T>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T>(p: string, b?: unknown) => Promise<Res<T>>;
  del: <T>(p: string) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = res.status === 204 ? '' : await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T>(p: string, b?: unknown) => call<T>('PATCH', p, b),
    del: <T>(p: string) => call<T>('DELETE', p),
  };
}

/** The uniform no-oracle 404 an unreachable job answers (routes/scheduler.ts authorizeJob). */
function expectNotFound(r: Res<ErrBody>, jobId: string): void {
  expect(r.status).toBe(404);
  expect(r.body.error).toBe('not_found');
  expect(r.body.message).toBe(`Scheduled job ${jobId} not found.`);
}
/** The readable-but-not-writable 403 (routes/scheduler.ts authorizeJob write arm). */
function expectWriteRefused(r: Res<ErrBody>): void {
  expect(r.status).toBe(403);
  expect(r.body.error).toBe('forbidden_scope');
  expect(r.body.message).toBe('Missing required scope: workspace:write');
}

const P = '/host/openwop-app/projects';
const S = '/host/openwop-app/scheduler/jobs';
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
const jobIds = (r: Res<JobList>): string[] => r.body.jobs.map((j) => j.jobId);

/** Owner + private project + one project schedule + a co-tenant with no scopes. */
async function scenario(visibility: 'org' | 'private' = 'private') {
  await resetScheduling();
  const tenantId = `org:sched-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: uniqEmail('sched-owner'), tenantId });
  const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'PrivCo' })).body.orgId;
  const projectId = (await owner.post<{ id: string }>(P, { orgId, name: 'Secret' })).body.id;
  const created = await owner.post<{ jobId: string }>(`${P}/${projectId}/schedules`, { cronExpr: '0 9 * * *', workflowId: 'wf.demo' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const jobId = created.body.jobId;
  expect(jobId).toBeTruthy();
  if (visibility === 'private') {
    expect((await owner.patch<{ visibility: string }>(`${P}/${projectId}/visibility`, { visibility: 'private' })).body.visibility).toBe('private');
  }
  // A signed-in CO-TENANT with zero org scopes (never `createMember`'d).
  const stranger = client();
  await stranger.post('/host/openwop-app/test/login', { email: uniqEmail('sched-stranger'), tenantId });
  return { tenantId, orgId, projectId, jobId, owner, stranger };
}

describe('scheduler door — a project-owned job is gated by the project, not by the tenant (CPC-1)', () => {
  it('an unscoped co-tenant cannot LIST a private project\'s job', async () => {
    const { jobId, projectId, stranger } = await scenario();
    // Control: the project door already refuses this caller.
    expect((await stranger.get(`${P}/${projectId}`)).status).toBe(404);
    expect((await stranger.get(`${P}/${projectId}/schedules`)).status).toBe(404);
    // The generic door must agree.
    const list = await stranger.get<JobList>(S);
    expect(list.status).toBe(200);
    expect(jobIds(list)).not.toContain(jobId);
  });

  it('an unscoped co-tenant cannot PATCH a private project\'s job (no re-pointing workflowId)', async () => {
    const { jobId, stranger, owner } = await scenario();
    expectNotFound(await stranger.patch<ErrBody>(`${S}/${jobId}`, { cronExpr: '0 3 * * *', workflowId: 'wf.attacker' }), jobId);
    // Positive control — the row is UNCHANGED, read back through the owner's door.
    const owned = await owner.get<JobList>(S);
    const job = owned.body.jobs.find((j) => j.jobId === jobId);
    expect(job?.workflowId).toBe('wf.demo');
    expect(job?.cronExpr).toBe('0 9 * * *');
  });

  it('an unscoped co-tenant cannot TRIGGER a private project\'s job (no run fires)', async () => {
    const { jobId, stranger } = await scenario();
    const r = await stranger.post<ErrBody & { runsFired?: number }>(`${S}/${jobId}/trigger`);
    expectNotFound(r, jobId);
    expect(r.body.runsFired).toBeUndefined();
  });

  it('an unscoped co-tenant cannot DELETE a private project\'s job (the owner still has it)', async () => {
    const { jobId, projectId, stranger, owner } = await scenario();
    expectNotFound(await stranger.del<ErrBody>(`${S}/${jobId}`), jobId);
    // Positive control against a dead cure: the owner's project door still lists it.
    const still = await owner.get<{ schedules: Array<{ jobId: string }> }>(`${P}/${projectId}/schedules`);
    expect(still.status).toBe(200);
    expect(still.body.schedules.map((s) => s.jobId)).toContain(jobId);
  });

  it('an ORG-VISIBLE project\'s job is still hidden from a caller with no org scopes', async () => {
    // The leak is not only about `private`: the project door needs `workspace:read`
    // IN THE OWNING ORG, which a bare co-tenant does not hold either.
    const { jobId, projectId, stranger } = await scenario('org');
    expect((await stranger.get(`${P}/${projectId}`)).status).toBe(404);
    expect(jobIds(await stranger.get<JobList>(S))).not.toContain(jobId);
  });

  it('a project MEMBER with read-only authority may LIST but never mutate (the write-bypass arm)', async () => {
    const { tenantId, orgId, projectId, jobId, owner } = await scenario();
    const viewer = client();
    const viewerId = (await viewer.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: uniqEmail('sched-viewer'), tenantId })).body.user.userId;
    await createMember({ tenantId, orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
    expect((await owner.post(`${P}/${projectId}/members`, { ref: `user:${viewerId}`, role: 'observer' })).status).toBe(201);

    // READ arm — membership grants read on a private project, so the job lists.
    expect((await viewer.get(`${P}/${projectId}`)).status).toBe(200);
    expect(jobIds(await viewer.get<JobList>(S))).toContain(jobId);

    // WRITE arm — membership NEVER grants write (ADR 0054 D5). All three refuse.
    // ADR 0787 D3 — with 403, not 404: the job is READABLE to this caller (it is
    // in their list two lines up), so a 404 was no oracle protection at all — it
    // only made the two doors disagree. The project door answers 403 too.
    expectWriteRefused(await viewer.patch<ErrBody>(`${S}/${jobId}`, { enabled: false }));
    expectWriteRefused(await viewer.post<ErrBody>(`${S}/${jobId}/trigger`));
    expectWriteRefused(await viewer.del<ErrBody>(`${S}/${jobId}`));
    // And the project's own write door agrees (the two doors must not disagree).
    expect((await viewer.patch(`${P}/${projectId}/schedules/${jobId}`, { enabled: false })).status).toBe(403);
  });

  it('the org WRITER still lists, patches, triggers and deletes it (the cure is not a brick)', async () => {
    const { jobId, owner } = await scenario();
    expect(jobIds(await owner.get<JobList>(S))).toContain(jobId);
    expect((await owner.patch(`${S}/${jobId}`, { enabled: false })).status).toBe(200);
    expect((await owner.post(`${S}/${jobId}/trigger`)).status).toBe(200);
    expect((await owner.del(`${S}/${jobId}`)).status).toBe(200);
  });

  it('a job with NO ownerSubject: any co-tenant READS it, only a workspace writer changes it (ADR 0787 D3)', async () => {
    const { tenantId, stranger, owner } = await scenario();
    const res = await registerJob({ jobId: `job-plain-${n++}`, tenantId, cronExpr: '0 9 * * *' });
    expect(res.ok).toBe(true);
    const plainId = res.ok ? res.job.jobId : '';
    // No `ownerSubject` ⇒ the seam returns null ⇒ the tenant arm applies. It
    // used to answer "any tenant member may do anything", which is `SCTWF-5`:
    // an unscoped co-tenant could retarget, fire and delete the automation.
    expect(jobIds(await stranger.get<JobList>(S))).toContain(plainId);
    expectWriteRefused(await stranger.patch<ErrBody>(`${S}/${plainId}`, { enabled: false }));
    expectWriteRefused(await stranger.post<ErrBody>(`${S}/${plainId}/trigger`));
    expectWriteRefused(await stranger.del<ErrBody>(`${S}/${plainId}`));
    // …and the cure is not a brick: the workspace's writer still can.
    expect((await owner.patch(`${S}/${plainId}`, { enabled: false })).status).toBe(200);
  });
});
