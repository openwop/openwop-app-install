/**
 * ADR 0608 R2 (`CPC-13`) — the portability export bundle is a SECOND READ door on
 * the same `ScheduledJob` rows as `GET /scheduler/jobs`, and it must apply the
 * SAME subject gate.
 *
 * Before this fix `GET /host/openwop-app/export?kinds=schedule` called
 * `buildExportBundle(tenantOf(req))` with no scope check at all, and its `schedule`
 * slice was `listJobs(tenantId)` verbatim (`portabilityService.ts`). So a co-tenant
 * with ZERO org scopes — the exact caller the D1 scheduler-door fix (`CPC-1`) turns
 * away from `GET /scheduler/jobs` — got `200` from the export carrying a `private`
 * project's full schedule row (`jobId`, `cronExpr`, `workflowId`, `enabled`),
 * byte-identical to the owner's own export. This re-exposed the rows D1 hides.
 *
 * The fix gates ONLY the `schedule` slice, through the same `scheduleSubject` →
 * `resolveSubjectAccess` → drop-unreadable path the list door uses. The BROADER
 * `/export` authz gap (roster / prompts / connection refs / org-chart still leaking
 * on tenant co-residency alone) is tracked as `CPC-16`, NOT closed here.
 *
 * This witness carries the positive controls that stop a dead cure reading green:
 *   - the OWNER still exports the row (the slice is not bricked),
 *   - a read-only project MEMBER still exports it (READ suffices — same as the list
 *     door; the gate did not over-narrow to write),
 *   - a job with NO `ownerSubject` is still exported to any tenant member (the ADR
 *     0025 legacy rule is untouched — the gate is not a blanket deny).
 *   - the two refusal cases carry an ownerless job IN THE SAME EXPORT, so "the row
 *     is absent" cannot pass on an export that is empty for another reason.
 *
 * Sabotages each case is red against (probed, /grade-tests 8f w1): the unreadable
 * row kept, the gate requiring write, the caller dropped from the call, the
 * no-subject rule turned into a deny.
 *
 * @see docs/adr/0608-collaborative-projects-visibility-and-browser-cadence.md D2 (R2)
 * @see docs/steward/CODEBASE-ASSESSMENT.md `CPC-13` / `CPC-16`
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { registerJob, resetScheduling } from '../src/host/schedulingService.js';
import type { ExportBundle } from '../src/features/portability/types.js';

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

interface Res<T> { status: number; body: T }
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
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

const P = '/host/openwop-app/projects';
const EXPORT = '/host/openwop-app/export?kinds=schedule';
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
/** The jobIds carried by an export bundle's `schedule` items. */
const exportedJobIds = (r: Res<ExportBundle>): string[] => {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.items.filter((i) => i.kind === 'schedule').map((i) => String(i.payload.jobId ?? ''));
};
const exportOf = (c: Client): Promise<Res<ExportBundle>> => c.get<ExportBundle>(EXPORT);
/** An ownerless job in the tenant: every member exports it (the in-export positive control). */
async function plainJob(tenantId: string): Promise<string> {
  const res = await registerJob({ jobId: `job-plain-export-${n++}`, tenantId, cronExpr: '0 9 * * *' });
  expect(res.ok).toBe(true);
  return res.ok ? res.job.jobId : '';
}

/** Owner + private project + one project schedule + a co-tenant with no scopes. */
async function scenario(visibility: 'org' | 'private' = 'private') {
  await resetScheduling();
  const tenantId = `org:export-${Date.now()}-${n++}`;
  const owner = client();
  expect((await owner.post('/host/openwop-app/test/login', { email: uniqEmail('exp-owner'), tenantId })).status).toBe(201);
  const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'PrivCo' })).body.orgId;
  const projectId = (await owner.post<{ id: string }>(P, { orgId, name: 'Secret' })).body.id;
  const created = await owner.post<{ jobId: string }>(`${P}/${projectId}/schedules`, { cronExpr: '0 9 * * *', workflowId: 'wf.demo' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const jobId: string = created.body.jobId;
  expect(jobId).toBeTruthy();
  if (visibility === 'private') {
    expect((await owner.patch<{ visibility: string }>(`${P}/${projectId}/visibility`, { visibility: 'private' })).body.visibility).toBe('private');
  }
  const stranger = client();
  expect((await stranger.post('/host/openwop-app/test/login', { email: uniqEmail('exp-stranger'), tenantId })).status).toBe(201);
  return { tenantId, orgId, projectId, jobId, owner, stranger };
}

describe('portability export — the schedule slice is subject-gated, matching the scheduler door (CPC-13)', () => {
  it('an unscoped co-tenant\'s export does NOT carry a private project\'s schedule row', async () => {
    const { tenantId, jobId, projectId, stranger } = await scenario();
    const plain = await plainJob(tenantId);
    // Control: the project door already refuses this caller (the D1 shape).
    expect((await stranger.get(`${P}/${projectId}`)).status).toBe(404);
    // The export door must agree — the row is dropped, not dumped; the ownerless
    // row in the SAME export proves the slice was built for this caller.
    const ids = exportedJobIds(await exportOf(stranger));
    expect(ids).not.toContain(jobId);
    expect(ids).toEqual([plain]);
  });

  it('an ORG-VISIBLE project\'s schedule is still absent from a caller with no org scopes', async () => {
    // Not only about `private`: the export gate resolves the project subject, and a
    // bare co-tenant holds no `workspace:read` in the owning org either.
    const { tenantId, jobId, stranger } = await scenario('org');
    const plain = await plainJob(tenantId);
    const ids = exportedJobIds(await exportOf(stranger));
    expect(ids).not.toContain(jobId);
    expect(ids).toEqual([plain]);
  });

  it('the OWNER still exports the row (the slice is not bricked)', async () => {
    const { jobId, owner } = await scenario();
    expect(exportedJobIds(await exportOf(owner))).toEqual([jobId]);
  });

  it('a read-only project MEMBER still exports it — READ suffices, same as the list door', async () => {
    const { tenantId, orgId, projectId, jobId, owner } = await scenario();
    const viewer = client();
    const viewerId = (await viewer.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: uniqEmail('exp-viewer'), tenantId })).body.user.userId;
    await createMember({ tenantId, orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
    expect((await owner.post(`${P}/${projectId}/members`, { ref: `user:${viewerId}`, role: 'observer' })).status).toBe(201);
    // Membership grants READ on a private project; READ is all export needs.
    expect((await viewer.get(`${P}/${projectId}`)).status).toBe(200);
    expect(exportedJobIds(await exportOf(viewer))).toEqual([jobId]);
  });

  it('a job with NO ownerSubject is still exported to any tenant member (not a blanket deny)', async () => {
    const { tenantId, stranger } = await scenario();
    const plainId = await plainJob(tenantId);
    // `scheduleSubject` → null ⇒ the legacy tenant rule ⇒ any tenant member exports it.
    expect(exportedJobIds(await exportOf(stranger))).toContain(plainId);
  });
});
