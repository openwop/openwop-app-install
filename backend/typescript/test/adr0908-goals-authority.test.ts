/**
 * ADR 0908 — standing goals: who may act on a goal, and what the judge may read
 * (feature loop round 2, row 51).
 *
 * Every probe drives the real routes. Each was written RED against `origin/main`
 * before the fix; each refusal is paired with the accept that proves the door is
 * not simply shut.
 *
 *   D1  write floor — every goal mutation needs `workspace:write` in the tenant.
 *       A viewer could create, abandon, bind runs to, and judge any principal-less
 *       goal.
 *   D2  the arm door — `/goals/:id/arm` is a door into the scheduler. It now asks
 *       what the scheduler route asks (ADR 0787 D3), names the arming person on the
 *       job (ADR 0815 cascade), refuses a workflow the tenant cannot run (ADR 0823),
 *       and refuses to retarget a job a feature armed.
 *   D3  the judge reads only the goal's own evidence — the KickTodo verifier parsed
 *       the tenant out of a caller-supplied ref, so another enrollment's (or another
 *       tenant's) completed snapshot satisfied a goal.
 *   D4  no fixture in real workspaces — `GET /goals` seeded a demo goal into every
 *       tenant that looked, and the chat agent read it as the user's own.
 *   D5  a contributing run is a run — `POST /goals/:id/runs` took any string, and the
 *       cost bound was enforced on a cost the caller chose.
 *   D2b the scheduler's own doors cannot replace, squat, re-enable or re-mark a goal's
 *       continuation job (architect A1/A2).
 *   D6  the run surface acts for the run's person, behind the route's scopes.
 *   D7  a person's goals are erased with them.
 *   D8  bounds stop the continuation at fire time, not only the judge.
 *   D9  closed-world create — unadvertised judges/modes, malformed bounds and a
 *       client-written `armRef` were stored.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { getJob } from '../src/host/schedulingService.js';
import { fireJob } from '../src/host/scheduleDaemon.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { eraseGoalsForSubject, ensureDemoGoal, FIXTURE_GOAL_ID, __test as goalsStore } from '../src/features/goals/goalsService.js';
import { buildRunRecord } from '../src/host/runDispatch.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { continuationJobId, createGoal, getGoal } from '../src/features/goals/goalsService.js';
import { GOALS_LIST_TOOL_ID } from '../src/features/goals/agentTools.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { registerScheduledJobFireGate, scheduledJobFireRefusal } from '../src/host/scheduledJobFireGates.js';
import type { ScheduledJob } from '../src/host/schedulingService.js';
import { freezeProgressEvidence } from '../src/features/kicktodo-core/progressService.js';
import type { Storage } from '../src/storage/storage.js';

let BASE: string; let server: http.Server; let storage: Storage; let deps: StartRunDeps;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_GOALS_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  deps = { storage, hostSuite: app.locals.hostSuite } as unknown as StartRunDeps;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  registerGoalVerifier('g908:v', async () => ({ satisfied: true, confidence: 1, runId: 'run-g908' }));
  for (const id of ['users', 'kicktodo-core']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client(bearer?: string) {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
}
type Client = ReturnType<typeof client>;
let n = 0;
let T = '';
/** Founds a fresh tenant: the first login owns it. */
async function owner(): Promise<{ c: Client; userId: string; tenant: string }> {
  const c = client();
  T = `org:g908-${Date.now()}-${n++}`;
  const r = await c('POST', '/host/openwop-app/test/login', { email: `owner-${n++}@g908.test`, tenantId: T });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId as string, tenant: T };
}
/** A second person in the CURRENT tenant, as a real member with `role`. */
async function member(own: Client, role: 'editor' | 'viewer'): Promise<{ c: Client; userId: string }> {
  const c = client();
  const r = await c('POST', '/host/openwop-app/test/login', { email: `${role}-${n++}@g908.test`, tenantId: T });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const userId = r.body.user.userId as string;
  const add = await own('POST', `/host/openwop-app/orgs/${encodeURIComponent(T)}/members`, { displayName: role, subject: userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { c, userId };
}
const G = (id = '', suffix = ''): string => `/host/openwop-app/goals${id ? `/${encodeURIComponent(id)}` : ''}${suffix}`;
const BOUNDED = { objective: 'Keep the backlog under 20', completion: { check: 'verifier', verifierRef: 'g908:v' }, continuation: { mode: 'schedule' }, bounds: { maxLoopIterations: 5 } };
/** A goal with no principal — what the run surface (`ctx.features.goals.create`) writes. */
async function tenantGoal(tenant: string): Promise<string> {
  return (await createGoal({ objective: 'Tenant goal', completion: { check: 'verifier', verifierRef: 'g908:v' }, continuation: { mode: 'schedule' }, bounds: { maxLoopIterations: 5 }, owner: { tenant } })).id;
}

describe('D1 — every goal mutation needs workspace:write', () => {
  it('a viewer cannot create a goal (403); an editor can (200)', async () => {
    const o = await owner();
    const viewer = await member(o.c, 'viewer');
    const editor = await member(o.c, 'editor');
    expect((await viewer.c('POST', G(), BOUNDED)).status).toBe(403);
    const ok = await editor.c('POST', G(), BOUNDED);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.owner.principal).toBe(editor.userId);
  });

  it('a viewer cannot abandon, edit, bind to or judge a principal-less goal; an editor can abandon it', async () => {
    const o = await owner();
    const viewer = await member(o.c, 'viewer');
    const editor = await member(o.c, 'editor');
    const id = await tenantGoal(o.tenant);
    expect((await viewer.c('POST', G(id, '/abandon'))).status).toBe(403);
    expect((await viewer.c('PATCH', G(id), { objective: 'hijacked' })).status).toBe(403);
    expect((await viewer.c('POST', G(id, '/runs'), { runId: 'run-x' })).status).toBe(403);
    expect((await viewer.c('POST', G(id, '/evaluate'), { snapshotRef: 'r', snapshotHash: 'h' })).status).toBe(403);
    expect((await getGoal(o.tenant, id))?.state).toBe('active');
    expect((await getGoal(o.tenant, id))?.objective).toBe('Tenant goal');
    const ok = await editor.c('POST', G(id, '/abandon'));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.state).toBe('abandoned');
  });

  it('a viewer can still READ the workspace goals (200)', async () => {
    const o = await owner();
    const viewer = await member(o.c, 'viewer');
    const id = await tenantGoal(o.tenant);
    const list = await viewer.c('GET', G());
    expect(list.status).toBe(200);
    expect((list.body.goals as Array<{ id: string }>).map((g) => g.id)).toContain(id);
    expect((await viewer.c('GET', G(id))).status).toBe(200);
  });
});

describe('D2 — arming a continuation is a scheduler write', () => {
  it('a viewer cannot arm (403) and no job is registered', async () => {
    const o = await owner();
    const viewer = await member(o.c, 'viewer');
    const id = await tenantGoal(o.tenant);
    const r = await viewer.c('POST', G(id, '/arm'), { workflowId: 'openwop-app.kicktodo.daily-loop', cronExpr: '0 9 * * *' });
    expect(r.status).toBe(403);
    expect(await getJob(continuationJobId(o.tenant, id))).toBeNull();
  });

  it('an editor cannot arm a workflow the tenant cannot run (422 workflow_not_found)', async () => {
    const o = await owner();
    const editor = await member(o.c, 'editor');
    const id = (await editor.c('POST', G(), BOUNDED)).body.id as string;
    const r = await editor.c('POST', G(id, '/arm'), { workflowId: 'no-such-workflow', cronExpr: '0 9 * * *' });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(await getJob(continuationJobId(o.tenant, id))).toBeNull();
  });

  it('an editor arms a real workflow, and the job names the person it acts for', async () => {
    const o = await owner();
    const editor = await member(o.c, 'editor');
    const id = (await editor.c('POST', G(), BOUNDED)).body.id as string;
    const r = await editor.c('POST', G(id, '/arm'), { workflowId: 'openwop-app.kicktodo.daily-loop', cronExpr: '0 9 * * *' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const job = await getJob(continuationJobId(o.tenant, id));
    expect(job?.workflowId).toBe('openwop-app.kicktodo.daily-loop');
    expect(job?.metadata?.actingUserId).toBe(editor.userId);
  });
});

/** One-day, two-action challenge — judgeable inside the test. */
const ONE_DAY = {
  title: 'One-Day Reset', summary: 'Two actions, one day', outcome: 'A finished reset', durationDays: 1,
  activities: [
    { stableActivityId: 'a1', day: 1, title: 'First', instructions: '', evidencePolicy: 'attestation' },
    { stableActivityId: 'a2', day: 1, title: 'Second', instructions: '', evidencePolicy: 'attestation' },
  ],
};
const KT = '/host/openwop-app/kicktodo';
async function enrollment(c: Client): Promise<{ id: string; goalId: string; cards: string[] }> {
  const draft = (await c('POST', `${KT}/challenges`, { ...ONE_DAY, title: `Reset ${n++}` })).body as { id: string };
  expect((await c('POST', `${KT}/challenges/${draft.id}/versions/1/publish`)).status).toBeLessThan(300);
  const e = await c('POST', `${KT}/enrollments`, { challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  expect(e.status, JSON.stringify(e.body)).toBeLessThan(300);
  const today = (await c('GET', `${KT}/today`)).body as { enrollments: Array<{ enrollmentId: string; actions: Array<{ occurrence: { cardId: string } }> }> };
  const cards = today.enrollments.find((x) => x.enrollmentId === e.body.id)!.actions.map((a) => a.occurrence.cardId);
  return { id: e.body.id as string, goalId: e.body.goalId as string, cards };
}
async function completed(c: Client, tenant: string): Promise<{ ref: string; hash: string; goalId: string }> {
  const e = await enrollment(c);
  for (const cardId of e.cards) expect((await c('POST', `${KT}/check-ins`, { cardId })).status).toBeLessThan(300);
  const s = await freezeProgressEvidence(tenant, e.id);
  expect(s?.completedActivities).toBe(2);
  return { ref: `${tenant}|${e.id}|${s!.id}`, hash: s!.snapshotHash, goalId: e.goalId };
}

describe('D3 — the judge reads only the goal\'s own evidence', () => {
  it('another enrollment\'s completed snapshot does not satisfy a goal (refused, goal stays active); its own goal is satisfied', async () => {
    const o = await owner();
    const done = await completed(o.c, o.tenant);
    const fresh = await enrollment(o.c);
    const borrowed = await o.c('POST', G(fresh.goalId, '/evaluate'), { snapshotRef: done.ref, snapshotHash: done.hash });
    expect(borrowed.status, JSON.stringify(borrowed.body)).toBeGreaterThanOrEqual(400);
    expect((await getGoal(o.tenant, fresh.goalId))?.state).toBe('active');
    const own = await o.c('POST', G(done.goalId, '/evaluate'), { snapshotRef: done.ref, snapshotHash: done.hash });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.goal.state).toBe('satisfied');
  });

  it('another tenant\'s snapshot is never read for a verdict', async () => {
    const a = await owner();
    const done = await completed(a.c, a.tenant);
    const b = await owner();
    const fresh = await enrollment(b.c);
    const r = await b.c('POST', G(fresh.goalId, '/evaluate'), { snapshotRef: done.ref, snapshotHash: done.hash });
    expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
    expect((await getGoal(b.tenant, fresh.goalId))?.state).toBe('active');
  });
});

describe('D4 — no conformance fixture in a person\'s workspace', () => {
  it('a person\'s GET /goals seeds nothing and the chat tool sees no demo goal', async () => {
    const o = await owner();
    const list = await o.c('GET', G());
    expect(list.status).toBe(200);
    expect(list.body.goals).toEqual([]);
    expect(await goalsStore.collection.get(`${o.tenant}::${FIXTURE_GOAL_ID}`)).toBeNull(); // nothing was seeded
    const tool = await createAgentToolProvider({ tenantId: o.tenant, runId: `run-908-${n++}`, actingUserId: o.userId }).executeTool({ name: GOALS_LIST_TOOL_ID, input: {} });
    expect(JSON.parse(tool.content as string).goals).toEqual([]);
  });

  it('a fixture already seeded into a real workspace is hidden from its people and the chat tool', async () => {
    const o = await owner();
    await ensureDemoGoal(o.tenant);
    const list = await o.c('GET', G());
    expect((list.body.goals as Array<{ id: string }>).map((g) => g.id)).not.toContain(FIXTURE_GOAL_ID);
    expect((await o.c('GET', G(FIXTURE_GOAL_ID))).status).toBe(404);
    const tool = await createAgentToolProvider({ tenantId: o.tenant, runId: `run-908-${n++}`, actingUserId: o.userId }).executeTool({ name: GOALS_LIST_TOOL_ID, input: {} });
    expect(JSON.parse(tool.content as string).goals).toEqual([]);
  });

  it('the chat tool refuses a non-member (typed error, not an empty list); a member reads', async () => {
    const o = await owner();
    const id = await tenantGoal(o.tenant);
    const stranger = await owner(); // a person with no membership in o's tenant
    const refused = await createAgentToolProvider({ tenantId: o.tenant, runId: `run-908-${n++}`, actingUserId: stranger.userId }).executeTool({ name: GOALS_LIST_TOOL_ID, input: {} });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content as string).goals).toBeUndefined();
    const ok = await createAgentToolProvider({ tenantId: o.tenant, runId: `run-908-${n++}`, actingUserId: o.userId }).executeTool({ name: GOALS_LIST_TOOL_ID, input: {} });
    expect((JSON.parse(ok.content as string).goals as Array<{ id: string }>).map((g) => g.id)).toEqual([id]);
  });

  it('the conformance credential still sees a goal to run the judge-only leg against, and that leg refuses', async () => {
    const op = client('dev-token');
    const list = await op('GET', `${G()}?state=active`);
    expect(list.status).toBe(200);
    const goals = list.body.goals as Array<{ id: string }>;
    expect(goals.length).toBeGreaterThan(0);
    const r = await op('POST', G(goals[0]!.id), { state: 'satisfied' });
    expect(r.status).toBe(422);
  });
});

describe('D5 — a contributing run is a real run of this tenant, and its cost is the host\'s', () => {
  it('an unknown run id is refused (404); a run of another tenant is refused (404)', async () => {
    const o = await owner();
    const id = (await o.c('POST', G(), BOUNDED)).body.id as string;
    expect((await o.c('POST', G(id, '/runs'), { runId: 'no-such-run' })).status).toBe(404);
    const foreign = buildRunRecord({ workflowId: 'wf', tenantId: 'org:someone-else' });
    await storage.insertRun(foreign);
    expect((await o.c('POST', G(id, '/runs'), { runId: foreign.runId })).status).toBe(404);
    expect((await getGoal(o.tenant, id))?.progress?.contributingRunIds).toEqual([]);
  });

  it('a run\'s host-stamped cost counts even when the caller reports less, and crosses the bound', async () => {
    const o = await owner();
    const id = (await o.c('POST', G(), { ...BOUNDED, bounds: { maxCostUsd: 1 } })).body.id as string;
    const run = buildRunRecord({ workflowId: 'wf', tenantId: o.tenant });
    await storage.insertRun({ ...run, metadata: { ...(run.metadata ?? {}), costUsd: 3 } });
    const r = await o.c('POST', G(id, '/runs'), { runId: run.runId, costUsd: 0 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.progress.contributingRunIds).toEqual([run.runId]);
    expect(r.body.state).toBe('bound-exceeded');
  });
});

describe('D9 — create is closed-world', () => {
  it('refuses an unadvertised judge or mode, malformed bounds, and a client armRef; accepts the advertised shape', async () => {
    const o = await owner();
    const host = await o.c('POST', G(), { ...BOUNDED, completion: { check: 'host' } });
    expect(host.status).toBe(422);
    // The refusal names the field and the supported value (the old CLI prints `message`).
    expect(host.body.message).toMatch(/completion\.check.*host.*not supported.*use `"verifier"`/);
    expect((await o.c('POST', G(), { ...BOUNDED, completion: { check: 'verifier' } })).status).toBe(400);
    expect((await o.c('POST', G(), { ...BOUNDED, continuation: { mode: 'heartbeat' } })).status).toBe(422);
    expect((await o.c('POST', G(), { ...BOUNDED, bounds: { maxLoopIterations: -1 } })).status).toBe(400);
    expect((await o.c('POST', G(), { ...BOUNDED, bounds: { maxLoopIterations: 5, extra: true } })).status).toBe(400);
    expect((await o.c('POST', G(), { ...BOUNDED, continuation: { mode: 'schedule', armRef: 'job-forged' } })).status).toBe(400);
    expect((await o.c('POST', G(), { ...BOUNDED, objective: 'x'.repeat(5000) })).status).toBe(400);
    const ok = await o.c('POST', G(), BOUNDED);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.bounds).toEqual({ maxLoopIterations: 5 });
  });

  it('refuses a verifier nobody registered (422); accepts a registered one', async () => {
    const o = await owner();
    const r = await o.c('POST', G(), { ...BOUNDED, completion: { check: 'verifier', verifierRef: 'nobody:registered' } });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect((await o.c('POST', G(), BOUNDED)).status).toBe(200);
  });

  it('without bounds the create is still 422 (the conformance leg), whatever judge it names', async () => {
    const o = await owner();
    const r = await o.c('POST', G(), { objective: 'unbounded work', completion: { check: 'host' }, continuation: { mode: 'manual' } });
    expect(r.status).toBe(422);
  });
});

const WF = 'openwop-app.kicktodo.daily-loop';
async function armedGoal(): Promise<{ o: Awaited<ReturnType<typeof owner>>; editor: Awaited<ReturnType<typeof member>>; id: string; jobId: string }> {
  const o = await owner();
  const editor = await member(o.c, 'editor');
  const id = (await editor.c('POST', G(), BOUNDED)).body.id as string;
  expect((await editor.c('POST', G(id, '/arm'), { workflowId: WF, cronExpr: '0 9 * * *' })).status).toBe(200);
  return { o, editor, id, jobId: continuationJobId(o.tenant, id) };
}
const J = (jobId: string): string => `/host/openwop-app/scheduler/jobs/${encodeURIComponent(jobId)}`;

describe('D2b — the scheduler route cannot write a goal\'s continuation job', () => {
  it('refuses to replace an armed goal job, or squat an unarmed one, by explicit id (409)', async () => {
    const { o, editor, jobId } = await armedGoal();
    const replace = await editor.c('POST', '/host/openwop-app/scheduler/jobs', { jobId, cronExpr: '* * * * *', workflowId: 'other-wf' });
    expect(replace.status, JSON.stringify(replace.body)).toBe(409);
    expect((await getJob(jobId))?.workflowId).toBe(WF);
    const unarmed = (await editor.c('POST', G(), BOUNDED)).body.id as string;
    const squat = await editor.c('POST', '/host/openwop-app/scheduler/jobs', { jobId: continuationJobId(o.tenant, unarmed), cronExpr: '* * * * *', workflowId: WF });
    expect(squat.status).toBe(409);
    expect(await getJob(continuationJobId(o.tenant, unarmed))).toBeNull();
    // Accept: the same writer still creates an ordinary schedule.
    const plain = await editor.c('POST', '/host/openwop-app/scheduler/jobs', { jobId: `plain-${n++}`, cronExpr: '0 9 * * *', workflowId: WF });
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
  });

  it('refuses re-enable, retarget and metadata edits (409); allows disable (200)', async () => {
    const { editor, id, jobId } = await armedGoal();
    expect((await editor.c('PATCH', J(jobId), { enabled: false })).status).toBe(200);
    expect((await getJob(jobId))?.enabled).toBe(false);
    expect((await editor.c('PATCH', J(jobId), { enabled: true })).status).toBe(409);
    expect((await editor.c('PATCH', J(jobId), { metadata: { purpose: 'x', goalId: 'other' } })).status).toBe(409);
    expect((await editor.c('PATCH', J(jobId), { cronExpr: '* * * * *' })).status).toBe(409);
    const job = await getJob(jobId);
    expect(job?.enabled).toBe(false);
    expect(job?.metadata?.goalId).toBe(id);
    // Accept: the goal's own resume re-enables it.
    expect((await editor.c('POST', G(id, '/resume'))).status).toBe(200);
    expect((await getJob(jobId))?.enabled).toBe(true);
  });

  it('a key arms as the PERSON who minted it, and its goal is theirs (A7); a key reads goals (A3)', async () => {
    const o = await owner();
    const editor = await member(o.c, 'editor');
    const token = (await issueApiKey({ tenantId: o.tenant, name: `k-${n++}`, createdBy: editor.userId })).token;
    const key = client(token);
    expect((await key('GET', G())).status).toBe(200);
    // A key that declared itself narrower than workspace:read is refused the read.
    // (Layered: the vendor-route key gate refuses it before the goals read floor,
    // which is defense in depth — no caller reaches the floor without the scope.)
    const narrow = client((await issueApiKey({ tenantId: o.tenant, name: `k-${n++}`, createdBy: editor.userId, scopes: ['runs:read'] })).token);
    const nr = await narrow('GET', G());
    expect(nr.status, JSON.stringify(nr.body)).toBe(403);
    const created = await key('POST', G(), BOUNDED);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.owner.principal).toBe(editor.userId);
    const id = created.body.id as string;
    expect((await key('POST', G(id, '/arm'), { workflowId: WF, cronExpr: '0 9 * * *' })).status).toBe(200);
    // The job acts as the KEY, as the scheduler POST stamps it (GL2CD-2): never as
    // the person, whose own credentials would then outlive the key's scopes. The
    // person rides as the narrowing-only orgScopeSubject.
    const job = await getJob(continuationJobId(o.tenant, id));
    expect(job?.metadata?.actingUserId).toMatch(/^apikey:/);
    expect(job?.metadata?.orgScopeSubject).toBe(editor.userId);
    // The person themself can still act on the goal the key created.
    expect((await editor.c('POST', G(id, '/pause'))).status).toBe(200);
  });

  it('a continuation a feature armed (KickTodo) is not replaced through the goal route (409)', async () => {
    const o = await owner();
    const e = await enrollment(o.c);
    const jobId = continuationJobId(o.tenant, e.goalId);
    const before = await getJob(jobId);
    expect(before?.inputs).toBeDefined();
    const r = await o.c('POST', G(e.goalId, '/arm'), { workflowId: WF, cronExpr: '* * * * *' });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect((await getJob(jobId))?.inputs).toEqual(before?.inputs);
  });
});

describe('D4b — the fixture stays usable for the harness', () => {
  it('a fixture flipped terminal is re-seeded active for the operator, and nobody can mutate it', async () => {
    const op = client('dev-token');
    const first = await op('GET', `${G()}?state=active`);
    const tenant = (first.body.goals as Array<{ id: string; owner: { tenant: string } }>).find((g) => g.id === FIXTURE_GOAL_ID)!.owner.tenant;
    const row = await goalsStore.collection.get(`${tenant}::${FIXTURE_GOAL_ID}`);
    await goalsStore.collection.put({ ...row!, state: 'bound-exceeded' });
    const again = await op('GET', `${G()}?state=active`);
    expect((again.body.goals as Array<{ id: string }>).map((g) => g.id)).toContain(FIXTURE_GOAL_ID);
    expect((await op('POST', G(FIXTURE_GOAL_ID, '/abandon'))).status).toBe(404);
    expect((await op('POST', G(FIXTURE_GOAL_ID, '/arm'), { workflowId: WF, cronExpr: '0 9 * * *' })).status).toBe(404);
    expect((await goalsStore.collection.get(`${tenant}::${FIXTURE_GOAL_ID}`))?.state).toBe('active');
  });
});

describe('D6 — the run surface acts for the run\'s person, behind the route\'s scopes', () => {
  it('a run acting for another member cannot touch a principal-owned goal; the owner\'s run can', async () => {
    const o = await owner();
    const editor = await member(o.c, 'editor');
    const id = (await o.c('POST', G(), BOUNDED)).body.id as string;
    const theirs = buildFeatureSurfaces({ tenantId: o.tenant, runId: `run-908-${n++}`, actingUserId: editor.userId }).goals!;
    expect((await theirs.transition!({ goalId: id, action: 'abandon' })).goal).toBeNull();
    expect((await getGoal(o.tenant, id))?.state).toBe('active');
    const mine = buildFeatureSurfaces({ tenantId: o.tenant, runId: `run-908-${n++}`, actingUserId: o.userId }).goals!;
    expect(((await mine.transition!({ goalId: id, action: 'abandon' })).goal as { state: string }).state).toBe('abandoned');
  });

  it('a viewer\'s run cannot create or arm (the seam refuses workspace:write); it can list', async () => {
    const o = await owner();
    const viewer = await member(o.c, 'viewer');
    const surface = buildFeatureSurfaces({ tenantId: o.tenant, runId: `run-908-${n++}`, actingUserId: viewer.userId }).goals!;
    await expect(surface.create!({ objective: 'x', verifierRef: 'v', mode: 'manual', bounds: { maxLoopIterations: 2 } })).rejects.toThrow(/workspace:write/);
    expect(Array.isArray((await surface.list!({})).goals)).toBe(true);
  });

  it('a run creates a goal owned by its actor, closed-world like the route', async () => {
    const o = await owner();
    const surface = buildFeatureSurfaces({ tenantId: o.tenant, runId: `run-908-${n++}`, actingUserId: o.userId }).goals!;
    expect(((await surface.create!({ objective: 'x', check: 'host', mode: 'manual', bounds: { maxLoopIterations: 2 } })) as { error?: { code: string } }).error?.code).toBe('validation_error');
    const ok = (await surface.create!({ objective: 'x', verifierRef: 'v', mode: 'manual', bounds: { maxLoopIterations: 2 } })) as { goal: { owner: { principal?: string } } };
    expect(ok.goal.owner.principal).toBe(o.userId);
  });
});

describe('D7 — a person\'s goals are erased with them', () => {
  it('deletes the subject\'s goals and disarms their continuation; leaves a colleague\'s', async () => {
    const { o, editor, id, jobId } = await armedGoal();
    const keep = (await o.c('POST', G(), BOUNDED)).body.id as string;
    const report = await eraseGoalsForSubject(o.tenant, editor.userId);
    expect(report.rowsTouched).toBe(1);
    expect(await getGoal(o.tenant, id)).toBeNull();
    expect((await getJob(jobId))?.enabled).toBe(false);
    expect(await getGoal(o.tenant, keep)).not.toBeNull();
  });
});

describe('D8 — bounds stop the continuation at fire time', () => {
  it('a goal past its wall-clock bound is closed at its next fire, and no run starts', async () => {
    const o = await owner();
    const editor = await member(o.c, 'editor');
    const id = (await editor.c('POST', G(), { ...BOUNDED, bounds: { runTimeoutMs: 60_000 } })).body.id as string;
    expect((await editor.c('POST', G(id, '/arm'), { workflowId: WF, cronExpr: '0 9 * * *' })).status).toBe(200);
    const jobId = continuationJobId(o.tenant, id);
    const outcome = await fireJob(deps, (await getJob(jobId))!, { trigger: 'manual', applyBudget: false, now: Date.now() + 3_600_000 });
    expect(outcome).toEqual({ skipped: 'goal-closed' });
    expect((await getGoal(o.tenant, id))?.state).toBe('bound-exceeded');
    expect((await getJob(jobId))?.enabled).toBe(false);
  });

  it('a closed goal\'s job does not fire even if something re-enabled it', async () => {
    const { o, editor, id, jobId } = await armedGoal();
    expect((await editor.c('POST', G(id, '/abandon'))).status).toBe(200);
    const outcome = await fireJob(deps, { ...(await getJob(jobId))!, enabled: true }, { trigger: 'manual', applyBudget: false });
    expect(outcome).toEqual({ skipped: 'goal-closed' });
    expect((await getGoal(o.tenant, id))?.state).toBe('abandoned');
  });

  it('an active goal inside its bounds is not refused by the gate', async () => {
    const { jobId } = await armedGoal();
    const outcome = await fireJob(deps, (await getJob(jobId))!, { trigger: 'manual', applyBudget: false });
    expect(outcome).not.toEqual({ skipped: 'goal-closed' });
  });
});

describe('closing grades — GL2CD-1/5, GL2UX-2/6, GL2CD-4', () => {
  it('a client transition never overwrites a verdict: pause/resume of a satisfied goal is 409, abandon is a no-op', async () => {
    const o = await owner();
    const id = (await o.c('POST', G(), BOUNDED)).body.id as string;
    const done = await o.c('POST', G(id, '/evaluate'), { snapshotRef: 'r', snapshotHash: 'h' });
    expect(done.body.goal.state).toBe('satisfied');
    expect((await o.c('POST', G(id, '/resume'))).status).toBe(409);
    expect((await o.c('POST', G(id, '/pause'))).status).toBe(409);
    const ab = await o.c('POST', G(id, '/abandon'));
    expect(ab.status).toBe(200);
    expect(ab.body.state).toBe('satisfied');
    // Accept: an active goal still pauses and resumes.
    const live = (await o.c('POST', G(), BOUNDED)).body.id as string;
    expect((await o.c('POST', G(live, '/pause'))).status).toBe(200);
    expect((await o.c('POST', G(live, '/resume'))).status).toBe(200);
  });

  it('Run now refuses a paused goal continuation (409); it runs an enabled one', async () => {
    const { editor, id, jobId } = await armedGoal();
    expect((await editor.c('POST', G(id, '/pause'))).status).toBe(200);
    expect((await editor.c('POST', `${J(jobId)}/trigger`)).status).toBe(409);
    expect((await editor.c('POST', G(id, '/resume'))).status).toBe(200);
    expect((await editor.c('POST', `${J(jobId)}/trigger`)).status).toBeLessThan(300);
  });

  it('the chat tool marks the user\'s own goals, hides person ids, and refuses an unknown filter', async () => {
    const o = await owner();
    const editor = await member(o.c, 'editor');
    const mineId = (await o.c('POST', G(), BOUNDED)).body.id as string;
    const theirsId = (await editor.c('POST', G(), BOUNDED)).body.id as string;
    const tool = (input: Record<string, unknown>) => createAgentToolProvider({ tenantId: o.tenant, runId: `run-908-${n++}`, actingUserId: o.userId }).executeTool({ name: GOALS_LIST_TOOL_ID, input });
    const out = JSON.parse((await tool({})).content as string).goals as Array<{ id: string; mine: boolean; personal: boolean; owner?: unknown }>;
    expect(out.find((g) => g.id === mineId)).toMatchObject({ mine: true, personal: true });
    expect(out.find((g) => g.id === theirsId)).toMatchObject({ mine: false, personal: true });
    expect(out.every((g) => g.owner === undefined)).toBe(true);
    const bad = await tool({ state: 'paused' });
    expect(bad.isError).toBe(true);
  });

  it('a gate that throws refuses the slot under its error reason, not a verdict', async () => {
    registerScheduledJobFireGate('g908-throws', { owns: (j) => j.jobId.startsWith('g908throw:'), gate: async () => { throw new Error('storage down'); }, refusal: 'dispatch-error' });
    const job: ScheduledJob = { jobId: 'g908throw:1', tenantId: 't', cronExpr: '* * * * *', lastFiredTick: null, enabled: true } as ScheduledJob;
    expect(await scheduledJobFireRefusal(job, Date.now())).toBe('dispatch-error');
  });
});

describe('D4c — the prod harness credential is a SCOPED env key, and both conformance legs stay live for it', () => {
  const saved = process.env.OPENWOP_API_KEYS;
  const KEY = 'g908-conformance-key';
  const TENANT = `conformance-g908-${Date.now()}`;
  beforeAll(() => { process.env.OPENWOP_API_KEYS = `${KEY}:${TENANT},dev-token:*`; });
  afterAll(() => { if (saved === undefined) delete process.env.OPENWOP_API_KEYS; else process.env.OPENWOP_API_KEYS = saved; });

  it('a `<key>:<tenant>` env key is seeded the fixture, and the judge-only and bounds legs answer 422 (not 403, not a soft-skip)', async () => {
    const harness = client(KEY);
    const list = await harness('GET', `${G()}?state=active`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const goals = list.body.goals as Array<{ id: string; owner: { tenant: string } }>;
    expect(goals.map((g) => g.id)).toContain(FIXTURE_GOAL_ID);
    expect(goals.every((g) => g.owner.tenant === TENANT)).toBe(true);
    expect((await harness('POST', G(FIXTURE_GOAL_ID), { state: 'satisfied' })).status).toBe(422);
    expect((await harness('POST', G(), { objective: 'unbounded work', completion: { check: 'host' }, continuation: { mode: 'manual' } })).status).toBe(422);
  });
});
