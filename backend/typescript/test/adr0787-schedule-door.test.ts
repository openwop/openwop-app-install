/**
 * ADR 0787 D3/D4/D5 — the scheduler door: one write gate, a server-stamped actor,
 * one identity, and a "Run now" that fires what the schedule fires.
 *
 * Each refusal is paired with its positive control, so a cure that bricked the
 * door cannot read green:
 *   - a Viewer cannot create, retarget, fire or delete; the writer still can
 *     (`SCTWF-5`)
 *   - PATCH cannot set `actingUserId`; a label edit keeps the actor and the keys
 *     it did not name; a retarget re-stamps the actor to the patcher (`SCTWF-4`)
 *   - a feature-configured job cannot be retargeted here (409)
 *   - an erased job cannot be re-enabled (409)
 *   - a user-owned job in a SHARED tenant is judged by the tenant arm, never by
 *     ownership — its Viewer-owner cannot retarget it (/architect H4)
 *   - a legacy-spelled (`oidc:`) personal job is still its owner's: listed by
 *     `?owner=me` and editable (`SCTWF-7`)
 *   - a DSAR of `user:X` disables X's `oidc:`-spelled HOME-tenant job, and the
 *     same principal string in ANOTHER tenant is untouched (`SCTWF-6`, the
 *     refuse-side witness for the widening)
 *   - Run now carries the job's inputs / actor and never moves `nextFireAt`
 *     (`SCTWF-10`)
 *
 * Tracker: TST-BSC-2 (docs/steward/TEST-ASSESSMENT.md). Red when: the
 * active-tenant arm answers `write` to every member; POST skips
 * `requireTenantWrite`; the gate stops comparing the job's tenant with the
 * caller's; client metadata keeps reserved keys or REPLACES instead of merging;
 * a retarget keeps the old actor; either feature-configured guard (PATCH
 * retarget, explicit-id POST) is removed; an erased job can be re-enabled; the
 * ownership arm is not confined to the personal tenant, or trusts a
 * non-personal (SAML) tenant; `?owner=me` lists one spelling; the DSAR alias is
 * dropped, works in any tenant, or aliases an ambiguous principal; Run now
 * advances `nextFireAt`; the budget exemption ignores `configurable` or the
 * clicker; a PATCH horizon refusal loses its code; one ticking revision is
 * enough for the fleet blocker.
 *
 * DOUBLE GUARD (recorded): the D4 legacy job's PATCH is admitted by the
 * ownership arm AND by the active-tenant arm (the personal tenant is active),
 * so its listing (`?owner=me`) leg is the witness, not the PATCH.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createMember, createWorkspace } from '../src/host/accessControlService.js';
import { registerJob, getJob, eraseSubjectSchedules, ONE_SHOT_CRON, type ScheduledJob } from '../src/host/schedulingService.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { upsertFromPrincipal, userIdFor, legacyPrincipalOf, type User } from '../src/features/users/usersService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { buildKicktodoReadiness } from '../src/features/kicktodo-core/readinessService.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // The RFC 0052 tick seam is what makes discovery advertise `scheduling` at all.
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** Every body this door answers with, narrowed to the fields the cases read. */
interface DoorBody {
  jobId?: string;
  tenantId?: string;
  jobs?: ScheduledJob[];
  user?: { userId: string };
  runsFired?: number;
  lastFiredTick?: number;
  runId?: string;
  skipped?: string;
  error?: string;
  message?: string;
  details?: { field?: string; maxFutureHorizon?: string; requiredScope?: string };
}
interface Res { status: number; body: DoorBody }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }

/** The created job's id, or a failure that names the response. */
function idOf(r: Res): string {
  const id = r.body.jobId;
  if (typeof id !== 'string') throw new Error(`no jobId in ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}
const idsOf = (r: Res): string[] => (r.body.jobs ?? []).map((j) => j.jobId);

/** The write gate's refusal, by its exact code and message (never a status alone). */
function expectForbidden(r: Res): void {
  expect(r.status, JSON.stringify(r.body)).toBe(403);
  expect(r.body.error).toBe('forbidden_scope');
  expect(r.body.message).toBe('Missing required scope: workspace:write');
}
const FEATURE_MANAGED = 'This schedule is managed by its feature; change it there.';
const ERASED_JOB = 'This schedule belonged to an erased account and cannot be re-enabled. Create a new one instead.';
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as DoorBody);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

const S = '/host/openwop-app/scheduler/jobs';
const uniq = (who: string): string => `${who}-${Date.now()}-${n++}`;

/**
 * A shared workspace with an admin WRITER, an editor WRITER2 and a VIEWER — the
 * ADR 0554 §P3 recipe (`adr0711-byok-operator-gate.test.ts`): members in the
 * workspace-ROOT org, created BEFORE login, and every login `sharedWorkspace:
 * true` so the seam does not collapse the personal tenant onto the shared one
 * (which would short-circuit the gate before membership is consulted — a green
 * that proves nothing).
 */
async function workspace() {
  const ws = await createWorkspace({ name: 'ADR 0787 workspace', ownerSubject: `oidc:${uniq('founder')}` });
  const tenantId = ws.orgId ?? ws.tenantId;
  const member = async (role: string) => {
    const subject = `oidc:${uniq(role)}`;
    const id = userIdFor(tenantId, subject);
    await createMember({ orgId: tenantId, tenantId, displayName: role, subject: id, roles: [role] });
    const c = client();
    const login = await c.post('/host/openwop-app/test/login', { subject, tenantId, displayName: role, sharedWorkspace: true });
    expect(login.body.user?.userId).toBe(id);
    return { c, id };
  };
  const w = await member('admin');
  const w2 = await member('editor');
  const v = await member('viewer');
  // The fixture is honest: every member reaches the READ door of THIS tenant.
  for (const m of [w, w2, v]) expect((await m.c.get(S)).status).toBe(200);
  return { tenantId, writer: w.c, writerId: w.id, writer2: w2.c, writer2Id: w2.id, viewer: v.c, viewerId: v.id, member };
}

describe('ADR 0787 D3 — one write gate', () => {
  it('a Viewer cannot create, retarget, fire or delete; the writer can', async () => {
    const { writer, viewer } = await workspace();
    expectForbidden(await viewer.post(S, { cronExpr: '0 9 * * *', workflowId: 'wf.a' }));
    const created = await writer.post(S, { cronExpr: '0 9 * * *', workflowId: 'wf.a' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = idOf(created);
    // READ is still open to the Viewer…
    expect(idsOf(await viewer.get(S))).toContain(id);
    // …WRITE is not.
    expectForbidden(await viewer.patch(`${S}/${id}`, { workflowId: 'wf.evil' }));
    expectForbidden(await viewer.post(`${S}/${id}/trigger`));
    expectForbidden(await viewer.del(`${S}/${id}`));
    expect((await getJob(id))?.workflowId).toBe('wf.a');
    // Positive control.
    expect((await writer.patch(`${S}/${id}`, { enabled: false })).status).toBe(200);
    expect((await writer.del(`${S}/${id}`)).status).toBe(200);
  });

  it('a caller from another tenant gets a uniform 404', async () => {
    const a = await workspace();
    const b = await workspace();
    const id = idOf(await a.writer.post(S, { cronExpr: '0 9 * * *', workflowId: 'wf.a' }));
    for (const r of [await b.writer.patch(`${S}/${id}`, { enabled: false }), await b.writer.del(`${S}/${id}`)]) {
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('not_found');
    }
    // The refusals changed nothing: the row exists and is still armed.
    expect((await getJob(id))?.enabled).toBe(true);
  });

  it('PATCH metadata cannot set the actor; a label edit keeps the actor and unnamed keys', async () => {
    const { writer, writerId, writer2 } = await workspace();
    const id = idOf(await writer.post(S, { cronExpr: '0 9 * * *', workflowId: 'wf.a', metadata: { note: 'kept', label: 'old' } }));
    expect((await getJob(id))?.metadata?.actingUserId).toBe(writerId);
    const patched = await writer2.patch(`${S}/${id}`, { metadata: { actingUserId: 'user:victim', assistantLoop: 'x', label: 'new' } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const job = await getJob(id);
    expect(job?.metadata?.actingUserId, 'a client body never sets the actor').toBe(writerId);
    expect(job?.metadata?.assistantLoop).toBeUndefined();
    expect(job?.metadata?.label).toBe('new');
    // `note`, not `tool`: since ADR 0985 `tool` is a server-owned key (the chat tools' caps count it).
    expect(job?.metadata?.note, 'a key the edit did not name survives').toBe('kept');
  });

  it('a retarget makes the job act as the patcher, never as the colleague who defined it', async () => {
    const { writer, writerId, writer2, writer2Id } = await workspace();
    const id = idOf(await writer.post(S, { cronExpr: '0 9 * * *', workflowId: 'wf.a' }));
    // A WHEN/WHETHER edit keeps the actor…
    expect((await writer2.patch(`${S}/${id}`, { cronExpr: '0 10 * * *', enabled: false })).status).toBe(200);
    expect((await getJob(id))?.metadata?.actingUserId).toBe(writerId);
    // …a WHAT edit re-stamps it.
    expect((await writer2.patch(`${S}/${id}`, { workflowId: 'wf.b' })).status).toBe(200);
    const job = await getJob(id);
    expect(job?.workflowId).toBe('wf.b');
    expect(job?.metadata?.actingUserId).toBe(writer2Id);
  });

  it('a feature-configured job cannot be retargeted through the generic door', async () => {
    const { tenantId, writer } = await workspace();
    const r = await registerJob({ jobId: uniq('feat'), tenantId, cronExpr: '0 9 * * *', workflowId: 'wf.feature', configurable: { credentialRef: 'platform:managed' } });
    expect(r.ok).toBe(true);
    const id = r.ok ? r.job.jobId : '';
    const refused = await writer.patch(`${S}/${id}`, { workflowId: 'wf.mine' });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe(FEATURE_MANAGED);
    expect((await getJob(id))?.workflowId).toBe('wf.feature');
    // Its schedule is still editable.
    expect((await writer.patch(`${S}/${id}`, { enabled: false })).status).toBe(200);
  });

  it('an erased job cannot be re-enabled', async () => {
    const { tenantId, writer } = await workspace();
    const r = await registerJob({ jobId: uniq('erased'), tenantId, cronExpr: '0 9 * * *', workflowId: 'wf.a', metadata: { actingUserId: 'user:gone' } });
    const id = r.ok ? r.job.jobId : '';
    await eraseSubjectSchedules(tenantId, 'user:gone');
    expect((await getJob(id))?.enabled).toBe(false);
    const refused = await writer.patch(`${S}/${id}`, { enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe(ERASED_JOB);
    expect((await getJob(id))?.enabled).toBe(false);
  });

  it('a user-owned job in a SHARED tenant is judged by the tenant arm — its Viewer-owner cannot retarget it', async () => {
    const { tenantId, viewer, viewerId } = await workspace();
    const r = await registerJob({ jobId: uniq('kickbot'), tenantId, cronExpr: ONE_SHOT_CRON, firstFireAtMs: Date.now() + 3_600_000, workflowId: 'wf.convene', ownerSubject: { kind: 'user', id: viewerId } });
    const id = r.ok ? r.job.jobId : '';
    expectForbidden(await viewer.patch(`${S}/${id}`, { workflowId: 'wf.anything' }));
    expect((await getJob(id))?.workflowId).toBe('wf.convene');
  });
});

describe('ADR 0787 D4 — one identity', () => {
  it('a legacy oidc:-spelled personal job is still its owner\'s: listed and editable', async () => {
    const me = client();
    const subject = `oidc:legacy-${uniq('s')}`;
    await me.post('/host/openwop-app/test/login', { subject, email: `${uniq('me')}@acme.test` });
    // A personal job created now tells us the personal tenant.
    const mine = await me.post(S, { owner: 'me', cronExpr: '0 9 * * *', workflowId: 'wf.a' });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    const personal = mine.body.tenantId;
    if (typeof personal !== 'string') throw new Error(`no tenantId in ${JSON.stringify(mine.body)}`);
    // The row a pre-ADR-0003 session wrote: owned by the PRINCIPAL spelling.
    const legacy = await registerJob({ jobId: uniq('legacy'), tenantId: personal, cronExpr: '0 8 * * *', workflowId: 'wf.old', ownerUserId: subject });
    const legacyId = legacy.ok ? legacy.job.jobId : '';
    const listed = idsOf(await me.get(`${S}?owner=me`));
    expect(listed).toContain(legacyId);
    expect(listed).toContain(idOf(mine));
    expect((await me.patch(`${S}/${legacyId}`, { enabled: false })).status).toBe(200);
    // Refuse-side: another person's principal in the same shape is NOT mine.
    const other = await registerJob({ jobId: uniq('other'), tenantId: personal, cronExpr: '0 8 * * *', workflowId: 'wf.old', ownerUserId: 'oidc:someone-else' });
    const otherId = other.ok ? other.job.jobId : '';
    expect(otherId).not.toBe('');
    expect(idsOf(await me.get(`${S}?owner=me`))).not.toContain(otherId);
  });

  it('a DSAR of user:X disables X\'s oidc:-spelled HOME-tenant job, and never the same string in another tenant', async () => {
    const home = `user:dsar-home-${uniq('h')}`;
    const elsewhere = `org:dsar-else-${uniq('e')}`;
    const principal = `oidc:dsar-${uniq('p')}`;
    const user = await upsertFromPrincipal({ tenantId: home, principalId: principal, source: 'oidc' });
    const mk = async (tenantId: string) => {
      const r = await registerJob({ jobId: uniq('dsar'), tenantId, cronExpr: '0 9 * * *', workflowId: 'wf.loop', rosterId: 'assistant', metadata: { actingUserId: principal } });
      return r.ok ? r.job.jobId : '';
    };
    const homeJob = await mk(home);
    const otherJob = await mk(elsewhere);
    // Refuse-side FIRST: a DSAR run against ANOTHER tenant must not reach the
    // principal there — outside the home tenant it may be a different person.
    await eraseSubject(elsewhere, user.userId);
    expect((await getJob(otherJob))?.enabled, 'the principal alias must never apply outside its home tenant').toBe(true);
    await eraseSubject(home, user.userId);
    const erased = await getJob(homeJob);
    expect(erased?.enabled, 'the legacy-spelled loop must stop firing as the erased person').toBe(false);
    expect(erased?.metadata?.actingUserId, 'the erasure sentinel (ERASED), as a literal').toBe('[erased]');
    // Refuse-side: principals are not issuer-qualified — in another tenant this
    // string may be somebody else, and erasure must never reach them.
    const untouched = await getJob(otherJob);
    expect(untouched?.enabled).toBe(true);
    expect(untouched?.metadata?.actingUserId).toBe(principal);
  });
});

describe('ADR 0787 D5 — Run now fires what the schedule fires', () => {
  it('carries the job\'s actor and never moves nextFireAt — a pending one-shot is not spent by a click', async () => {
    const { writer, writerId } = await workspace();
    // A ONE-SHOT: the old `markJobFired` recomputed from now, which for a
    // recurring cadence usually lands on the same slot (so a recurring job hides
    // the defect) but for `'once'` DELETES `nextFireAt` — the click spent the
    // scheduled fire.
    const id = idOf(await writer.post(S, { cronExpr: 'once', firstFireAtMs: Date.now() + 3_600_000, workflowId: 'wf.unresolvable' }));
    const before = (await getJob(id))?.nextFireAt;
    const fired = await writer.post(`${S}/${id}/trigger`);
    expect(fired.status).toBe(200);
    // The catalog has no such workflow: the button says why instead of "no workflow".
    expect(fired.body.skipped).toBe('workflow-unresolved');
    const job = await getJob(id);
    expect(job?.nextFireAt, 'a manual fire must not eat the next scheduled slot').toBe(before);
    expect(job?.lastFiredTick).toBe(fired.body.lastFiredTick);
    expect(job?.metadata?.actingUserId).toBe(writerId);
  });
});

describe('ADR 0787 D6 — the door refuses a cadence that cannot fire (400, never 500 or a silent 201)', () => {
  it('POST: an unknown zone, an unparseable cron, a never-firing cron', async () => {
    const { writer } = await workspace();
    const tz = await writer.post(S, { cronExpr: '0 9 * * *', timezone: 'Mars/Olympus_Mons', workflowId: 'wf.a' });
    expect(tz.status).toBe(400);
    expect(tz.body.details?.field).toBe('timezone');
    const cron = await writer.post(S, { cronExpr: 'every tuesday', workflowId: 'wf.a' });
    expect(cron.status).toBe(400);
    expect(cron.body.details?.field).toBe('cronExpr');
    const never = await writer.post(S, { cronExpr: '0 0 30 2 *', workflowId: 'wf.a' });
    expect(never.status).toBe(400);
    expect(never.body.error).toBe('schedule_horizon_exceeded');
    expect(never.body.details?.maxFutureHorizon).toBe('P366D');
    // Positive control: a yearly cadence (dead under the old 30-day cap) is fine.
    expect((await writer.post(S, { cronExpr: '0 9 1 1 *', workflowId: 'wf.a' })).status).toBe(201);
  });

  it('PATCH: a bad zone is a 400, and the row is unchanged', async () => {
    const { writer } = await workspace();
    const id = idOf(await writer.post(S, { cronExpr: '0 9 * * *', workflowId: 'wf.a' }));
    const res = await writer.patch(`${S}/${id}`, { timezone: 'Nowhere/Land' });
    expect(res.status).toBe(400);
    expect((await getJob(id))?.timezone).toBeUndefined();
    const never = await writer.patch(`${S}/${id}`, { cronExpr: '0 0 31 2 *' });
    expect(never.status).toBe(400);
    expect(never.body.error).toBe('schedule_horizon_exceeded');
  });

  it('the horizon refusal names the horizon the host honours', async () => {
    // ADR 0812 P4 — this read `scheduling.maxFutureHorizon` from the v1 builder,
    // which is deleted; the v2 root has no `scheduling` record (ADR 0858 ledger).
    // The refusal is the surface that still states the horizon, so it is
    // asserted there, against a schedule that can never fire inside it.
    const { writer } = await workspace();
    const res = await writer.post(S, { cronExpr: '0 0 31 2 *', workflowId: 'wf.a' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('schedule_horizon_exceeded');
    expect(res.body.details?.maxFutureHorizon).toBe('P366D');
  });
});

describe('ADR 0787 grade-code fixes (SCTCD-2/3/5/8/10)', () => {
  it('SCTCD-2: an explicit-id POST cannot REPLACE a feature-configured job by the other door', async () => {
    const { tenantId, writer } = await workspace();
    const r = await registerJob({ jobId: uniq('feat2'), tenantId, cronExpr: '0 9 * * *', workflowId: 'wf.feature', configurable: { credentialRef: 'platform:managed' }, inputs: { k: 1 } });
    const id = r.ok ? r.job.jobId : '';
    const res = await writer.post(S, { jobId: id, cronExpr: '0 9 * * *', workflowId: 'wf.mine' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(FEATURE_MANAGED);
    const job = await getJob(id);
    expect(job?.workflowId).toBe('wf.feature');
    expect(job?.configurable).toEqual({ credentialRef: 'platform:managed' });
    // Positive control: an explicit-id upsert of a PLAIN job by a writer still works.
    const plain = idOf(await writer.post(S, { cronExpr: '0 9 * * *', workflowId: 'wf.a' }));
    expect((await writer.post(S, { jobId: plain, cronExpr: '0 10 * * *', workflowId: 'wf.a' })).status).toBe(201);
  });

  it('SCTCD-3: a "personal" tenant that is not personal-shaped (SAML) grants nothing by ownership', async () => {
    const { tenantId } = await workspace();
    // Membership first, then a login WITHOUT `sharedWorkspace`: the seam sets
    // personalTenant = the shared tenant — the exact shape a SAML session has
    // (one host-global tenant for every SAML user, USERS-19).
    const subject = `oidc:${uniq('saml')}`;
    const id = userIdFor(tenantId, subject);
    await createMember({ orgId: tenantId, tenantId, displayName: 'S', subject: id, roles: ['viewer'] });
    const saml = client();
    await saml.post('/host/openwop-app/test/login', { subject, tenantId, displayName: 'S' });
    const r = await registerJob({ jobId: uniq('mine'), tenantId, cronExpr: '0 9 * * *', workflowId: 'wf.a', ownerUserId: id });
    const jobId = r.ok ? r.job.jobId : '';
    expect((await saml.get(S)).status).toBe(200);
    expectForbidden(await saml.patch(`${S}/${jobId}`, { enabled: false }));
    expectForbidden(await saml.del(`${S}/${jobId}`));
    expectForbidden(await saml.post(S, { owner: 'me', cronExpr: '0 9 * * *', workflowId: 'wf.a' }));
  });

  it('SCTCD-5 / D5: Run now spends the autonomous budget unless a human fires their OWN job with their OWN credentials', async () => {
    const { tenantId, writer, writerId, writer2 } = await workspace();
    const prev = process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT;
    // One autonomous run per window (0 means unlimited).
    process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT = '1';
    try {
      const own = idOf(await writer.post(S, { cronExpr: '0 9 * * *', workflowId: 'wf.unresolvable' }));
      // The actor, own credentials: not the budget (the workflow simply does not resolve).
      expect((await writer.post(`${S}/${own}/trigger`)).body.skipped).toBe('workflow-unresolved');
      // The actor, again: still never the budget, however often.
      expect((await writer.post(`${S}/${own}/trigger`)).body.skipped).toBe('workflow-unresolved');
      // A colleague firing it spends the budget: the first passes, the second is refused.
      expect((await writer2.post(`${S}/${own}/trigger`)).body.skipped).toBe('workflow-unresolved');
      expect((await writer2.post(`${S}/${own}/trigger`)).body.skipped).toBe('budget');
      // The actor firing a job that carries a platform credential: the budget.
      const r = await registerJob({ jobId: uniq('cfg'), tenantId, cronExpr: '0 9 * * *', workflowId: 'wf.unresolvable', configurable: { credentialRef: 'platform:managed' }, metadata: { actingUserId: writerId } });
      expect((await writer.post(`${S}/${r.ok ? r.job.jobId : ''}/trigger`)).body.skipped).toBe('budget');
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT;
      else process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT = prev;
    }
  });

  it('SCTCD-8: the legacy alias is the user\'s OWN principal, at home only, and never for a principal key', async () => {
    const home = `user:pin-${uniq('h')}`;
    const principal = `oidc:pin-${uniq('p')}`;
    const user = await upsertFromPrincipal({ tenantId: home, principalId: principal, source: 'oidc' });
    expect(await legacyPrincipalOf(home, user.userId)).toEqual({ principalId: principal });
    expect(await legacyPrincipalOf(`org:other-${uniq('o')}`, user.userId)).toBeNull();
    expect(await legacyPrincipalOf(home, principal), 'a principal key is never searched BY string').toBeNull();
  });

  it('refuse-side (ce): a principal claimed by TWO User rows in the tenant is not aliased; the rows are left alone', async () => {
    const home = `user:dup-${uniq('h')}`;
    const principal = `scim:dup-${uniq('p')}`;
    const erased = await upsertFromPrincipal({ tenantId: home, principalId: principal, source: 'oidc' });
    // A legacy randomUUID-era row (keyed by an unrelated id) claiming the SAME
    // principal — possibly another person. Written raw: no current API mints one.
    await new DurableCollection<User>('users:user', (u) => u.userId).put({ ...erased, userId: `user:legacy-${uniq('uuid')}`, displayName: 'Other' });
    expect(await legacyPrincipalOf(home, erased.userId)).toEqual({ ambiguous: true, principalId: principal });
    const r = await registerJob({ jobId: uniq('dup'), tenantId: home, cronExpr: '0 9 * * *', workflowId: 'wf.loop', rosterId: 'assistant', metadata: { actingUserId: principal } });
    const id = r.ok ? r.job.jobId : '';
    await eraseSubject(home, erased.userId);
    const job = await getJob(id);
    expect(job?.enabled, 'an ambiguous principal must not be erased as this user').toBe(true);
    expect(job?.metadata?.actingUserId).toBe(principal);
  });

  it('SCTCD-10: two revisions ticking is a readiness blocker, not a detail to spot by eye', async () => {
    const fleet = new DurableCollection<{ instanceId: string; revision: string | null; commit: string | null; startedAt: string; lastTickAt: string }>('scheduler:daemon', (r) => r.instanceId);
    const now = new Date().toISOString();
    await fleet.put({ instanceId: 'i-new', revision: 'rev-00800', commit: 'abc', startedAt: now, lastTickAt: now });
    await fleet.put({ instanceId: 'i-old', revision: 'rev-00796', commit: 'def', startedAt: now, lastTickAt: now });
    try {
      const report = await buildKicktodoReadiness({ tenantId: 'default' });
      // The BLOCKER itself, by name — the report is degraded for other reasons in
      // this harness and lists the fleet anyway, so neither proves the check.
      const blocker = report.blockers.find((b) => b.includes('revisions ticked within the hour'));
      expect(blocker, JSON.stringify(report.blockers)).toBeDefined();
      expect(blocker).toContain('rev-00796');
    } finally {
      await fleet.delete('i-new');
      await fleet.delete('i-old');
    }
  });
});
