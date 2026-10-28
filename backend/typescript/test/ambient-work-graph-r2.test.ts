/**
 * Feature loop round 2, row 52 — the Ambient Work Graph's authority probes.
 *
 * "You've done this N times" is said to ONE person, about runs THEY started.
 * Before this, the suggestion store was one tenant-wide list: in a shared
 * workspace a Viewer read another member's tool sequences, run ids and goal
 * text (the payload issue #4543 withholds on every run read), an Editor's
 * Scan mined everyone's runs, and anyone with write could dismiss or accept a
 * pattern mined from somebody else's work.
 *
 * Driven over HTTP. Each run is seeded with the owner stamp the REAL run-create
 * path writes for that session (copied from a `POST /runs`), so ownership is
 * decided against the production shape, not a hand-rolled one.
 *
 * TST-BNW-1. Red when: the owner filter on the suggestion list is dropped (a
 * Viewer/Admin reads another member's pattern), a decision looks a suggestion up
 * without its owner (another member's dismiss/accept lands), or a Scan mines any
 * owned run instead of the caller's own (w65 probes).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { opaquePrincipal } from '../src/host/runOwner.js';
import { decideSuggestion, forgetOwner, listSuggestions, upsertSuggestion } from '../src/features/ambient-work-graph/suggestionStore.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { setSuppression } from '../src/features/ambient-work-graph/pauseStore.js';
import { processDueSweeps, sweepTenant } from '../src/features/ambient-work-graph/workGraphSweep.js';
import { suggestionIdFor } from '../src/features/ambient-work-graph/runSignature.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let server: http.Server;
let BASE = '';
let storage: Storage;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'awg-r2', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  storage = __hostExtStorage()!;
  for (const id of ['users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The response fields these cases read (a narrow local view of the work-graph,
 *  login, workspace and run routes). */
interface Suggestion {
  suggestionId: string;
  status: string;
  toolSequence: string[];
  count: number;
  sampleGoal?: string;
  exampleRunIds: string[];
}
interface AwgBody {
  suggestions: Suggestion[];
  suggestion: { status: string };
  draftSeed: { sampleGoal?: string };
  user: { userId: string; tenantId: string };
  workspaceId: string;
  runId: string;
  orgId: string;
  orgs?: Array<{ orgId: string }>;
  scanned: number;
  truncated: boolean;
}
interface Res { status: number; body: AwgBody }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const parsed: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    // The ONE narrowing in this file: every case asserts the status before it
    // reads a field, so a refusal body is never read as a success shape.
    return { status: res.status, body: parsed as AwgBody };
  };
  return { get: (p: string, h?: Record<string, string>) => call('GET', p, undefined, h), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}
type Client = ReturnType<typeof client>;
const raw = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
const sug = (ws: string, suffix = ''): string => `/host/openwop-app/work-graph/orgs/${encodeURIComponent(ws)}/suggestions${suffix}`;

async function signup(c: Client, tag: string): Promise<{ userId: string; tenantId: string }> {
  const r = await c.post('/host/openwop-app/test/login', { email: `awg-${tag}-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

/** A shared workspace with its owner plus members in the given roles, all switched in. */
async function sharedWorkspace(roles: string[]): Promise<{ ws: string; owner: Client; members: Client[]; ownerUserId: string; memberUserIds: string[] }> {
  const owner = client();
  const ownerUserId = (await signup(owner, 'owner')).userId;
  const ws = (await owner.post('/host/openwop-app/workspaces', { name: `AWG-${n++}` })).body.workspaceId;
  expect((await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  const members: Client[] = [];
  const memberUserIds: string[] = [];
  for (const role of roles) {
    const c = client();
    const u = await signup(c, role);
    memberUserIds.push(u.userId);
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: role, subject: u.userId, roles: [role] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await c.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    members.push(c);
  }
  return { ws, owner, members, ownerUserId, memberUserIds };
}

/** The owner stamp the real `POST /runs` writes for this session. */
async function realStamp(c: Client): Promise<Record<string, unknown>> {
  const r = await c.post('/runs', { workflowId: 'conformance-noop', inputs: {} });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  const run = await storage.getRun(raw(r.body.runId));
  expect(run?.metadata?.owner, 'the real create path stamps an owner').toBeTruthy();
  return { owner: run!.metadata!.owner };
}

let seq = 0;
/** A completed run in `tenantId` that called `tools` in order, owned per `metadata`. */
async function seedRun(tenantId: string, metadata: Record<string, unknown>, tools: string[], extra: Partial<RunRecord> = {}): Promise<string> {
  const runId = `awg-r2-${Date.now()}-${seq++}`;
  const at = new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString();
  await storage.insertRun({ runId, workflowId: 'openwop-app.conversation', tenantId, status: 'completed', inputs: {}, configurable: {}, createdAt: at, updatedAt: at, metadata, ...extra } as RunRecord);
  for (const [i, toolName] of tools.entries()) {
    await storage.appendEvent({ eventId: `${runId}-e${i}`, runId, type: 'agent.toolCalled', payload: { toolName, agentId: 'agent:researcher' }, timestamp: at });
  }
  return runId;
}
async function seedPattern(tenantId: string, metadata: Record<string, unknown>, tools: string[], times = 3): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < times; i++) ids.push(await seedRun(tenantId, metadata, tools));
  return ids;
}

const OWNER_TOOLS = ['crm.search', 'owner-secret.tool', 'email.send'];
const OWNER_GOAL = 'owner-secret-goal: reconcile the payroll export';

describe('row 52 S1 — a member sees patterns mined from their OWN runs only', () => {
  it('a Viewer reads none of another member\'s tool sequence, goal or run ids', async () => {
    const { ws, owner, members: [viewer] } = await sharedWorkspace(['viewer']);
    const stamp = await realStamp(owner);
    const runIds = await seedPattern(ws, { ...stamp, goal: OWNER_GOAL }, OWNER_TOOLS);
    expect((await owner.post(sug(ws, '/refresh'))).status).toBe(200);

    const r = await viewer.get(sug(ws));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('owner-secret.tool');
    expect(text).not.toContain('owner-secret-goal');
    for (const id of runIds) expect(text).not.toContain(id);
    expect(r.body.suggestions).toEqual([]);
  });

  it('CONTROL: the run owner reads their own pattern, goal and evidence', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    const stamp = await realStamp(owner);
    const runIds = await seedPattern(ws, { ...stamp, goal: OWNER_GOAL }, OWNER_TOOLS);
    expect((await owner.post(sug(ws, '/refresh'))).status).toBe(200);
    const r = await owner.get(sug(ws));
    expect(r.status).toBe(200);
    expect(r.body.suggestions).toHaveLength(1);
    expect(r.body.suggestions[0]).toMatchObject({ toolSequence: OWNER_TOOLS, count: 3, sampleGoal: OWNER_GOAL, status: 'suggested' });
    expect([...r.body.suggestions[0].exampleRunIds].sort()).toEqual([...runIds].sort());
  });

  it('an Editor\'s Scan does not mine another member\'s runs', async () => {
    const { ws, owner, members: [editor] } = await sharedWorkspace(['editor']);
    await seedPattern(ws, await realStamp(owner), OWNER_TOOLS);
    const r = await editor.post(sug(ws, '/refresh'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('owner-secret.tool');
    expect(r.body.suggestions).toEqual([]);
  });

  it('CONTROL: an Editor\'s Scan mines the Editor\'s own runs', async () => {
    const { ws, members: [editor] } = await sharedWorkspace(['editor']);
    await seedPattern(ws, await realStamp(editor), ['kb.search', 'doc.write']);
    const r = await editor.post(sug(ws, '/refresh'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.suggestions.map((s: { toolSequence: string[] }) => s.toolSequence)).toEqual([['kb.search', 'doc.write']]);
  });

  it('an Admin sees only their own patterns too ("you have done this" is personal)', async () => {
    const { ws, owner, members: [admin] } = await sharedWorkspace(['admin']);
    await seedPattern(ws, await realStamp(owner), OWNER_TOOLS);
    expect((await owner.post(sug(ws, '/refresh'))).status).toBe(200);
    const r = await admin.get(sug(ws));
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('owner-secret.tool');
  });

  it('host-fired runs with no owner are nobody\'s pattern (already automated)', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    await seedPattern(ws, {}, ['schedule.tick', 'digest.send']);
    const r = await owner.post(sug(ws, '/refresh'));
    expect(r.status).toBe(200);
    expect(r.body.suggestions).toEqual([]);
    await sweepTenant({ storage }, ws); // nor does the daemon store them for anyone
    expect(JSON.stringify(await listSuggestions(ws))).not.toContain('schedule.tick');
  });
});

describe('row 52 S2 — dismiss and accept are the pattern owner\'s decisions', () => {
  async function ownerPattern(): Promise<{ ws: string; owner: Client; other: Client; id: string }> {
    const { ws, owner, members: [other] } = await sharedWorkspace(['editor']);
    await seedPattern(ws, { ...(await realStamp(owner)), goal: OWNER_GOAL }, OWNER_TOOLS);
    const r = await owner.post(sug(ws, '/refresh'));
    expect(r.body.suggestions, JSON.stringify(r.body)).toHaveLength(1);
    return { ws, owner, other, id: r.body.suggestions[0]!.suggestionId };
  }

  it('another member cannot dismiss it (404), and the owner still sees it', async () => {
    const { ws, owner, other, id } = await ownerPattern();
    expect((await other.post(sug(ws, `/${id}/dismiss`))).status).toBe(404);
    const mine = await owner.get(sug(ws));
    expect(mine.body.suggestions.map((s: { suggestionId: string; status: string }) => [s.suggestionId, s.status])).toEqual([[id, 'suggested']]);
  });

  it('another member cannot accept it (404, no draft seed, no proposal)', async () => {
    const { ws, owner, other, id } = await ownerPattern();
    const r = await other.post(sug(ws, `/${id}/accept`));
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body ?? {})).not.toContain('owner-secret');
    // No proposal was minted for the pattern, and it is still the owner's to decide.
    const listed = await owner.get('/host/openwop-app/proposals?kind=workflow-chain-pack');
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(`wg:${id}`);
    const mine = await owner.get(sug(ws));
    expect(mine.body.suggestions.map((s) => [s.suggestionId, s.status])).toEqual([[id, 'suggested']]);
  });

  it('CONTROL: the owner dismisses it, and a re-scan does not bring it back', async () => {
    const { ws, owner, id } = await ownerPattern();
    expect((await owner.post(sug(ws, `/${id}/dismiss`))).status).toBe(200);
    const again = await owner.post(sug(ws, '/refresh'));
    expect(again.status).toBe(200);
    expect(again.body.suggestions).toEqual([]);
  });

  it('CONTROL: the owner accepts it and gets the draft seed', async () => {
    const { ws, owner, id } = await ownerPattern();
    const r = await owner.post(sug(ws, `/${id}/accept`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.suggestion.status).toBe('accepted');
    expect(r.body.draftSeed).toMatchObject({ toolSequence: OWNER_TOOLS, sampleGoal: OWNER_GOAL });
  });
});

describe('row 52 S3 — a fork is not a recurrence', () => {
  it('two runs plus a fork of one of them is not a pattern seen three times', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    const stamp = await realStamp(owner);
    const [first] = await seedPattern(ws, stamp, ['a.tool', 'b.tool'], 2);
    await seedRun(ws, stamp, ['a.tool', 'b.tool'], { parentRunId: first, parentSeq: 1, forkMode: 'replay' });
    const r = await owner.post(sug(ws, '/refresh'));
    expect(r.status).toBe(200);
    expect(r.body.suggestions).toEqual([]);
  });

  it('a redrive is not a recurrence either', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    const stamp = await realStamp(owner);
    const [first] = await seedPattern(ws, stamp, ['a.tool', 'b.tool'], 2);
    await seedRun(ws, { ...stamp, redriveOf: first }, ['a.tool', 'b.tool']);
    const r = await owner.post(sug(ws, '/refresh'));
    expect(r.body.suggestions).toEqual([]);
  });

  it('CONTROL: three runs started by hand are', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    await seedPattern(ws, await realStamp(owner), ['a.tool', 'b.tool'], 3);
    const r = await owner.post(sug(ws, '/refresh'));
    expect(r.body.suggestions).toHaveLength(1);
  });
});


/** The org a personal-workspace caller reaches the page through (the SPA takes the first). */
async function personalOrg(c: Client): Promise<string> {
  const listed = await c.get('/host/openwop-app/orgs');
  const first = listed.body?.orgs?.[0]?.orgId;
  if (first) return first;
  const made = await c.post('/host/openwop-app/orgs', { name: 'Solo' });
  expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
  return made.body.orgId;
}
const settings = (ws: string): string => `/host/openwop-app/work-graph/orgs/${encodeURIComponent(ws)}/settings`;
type Sug = { suggestionId: string; status: string; toolSequence: string[]; ownerPrincipal?: string };

describe('row 52 S5 (ADR 0930 D5/A1) — erasure removes the profile and keeps it removed', () => {
  it('after erasure neither a read nor a re-scan brings the erased person\'s pattern back', async () => {
    const { ws, owner, ownerUserId } = await sharedWorkspace([]);
    await seedPattern(ws, { ...(await realStamp(owner)), goal: OWNER_GOAL }, OWNER_TOOLS);
    expect((await owner.post(sug(ws, '/refresh'))).body.suggestions).toHaveLength(1);
    await eraseSubject(ws, ownerUserId);
    expect(JSON.stringify(await listSuggestions(ws))).not.toContain('owner-secret');
    await sweepTenant({ storage }, ws); // the daemon's pass over the same, erasure-exempt runs
    expect(JSON.stringify(await listSuggestions(ws))).not.toContain('owner-secret');
    expect((await owner.post(sug(ws, '/refresh'))).body.suggestions).toEqual([]);
  });

  it('CONTROL: another member\'s patterns survive that erasure', async () => {
    const { ws, owner, ownerUserId, members: [editor] } = await sharedWorkspace(['editor']);
    await seedPattern(ws, await realStamp(owner), OWNER_TOOLS);
    await seedPattern(ws, await realStamp(editor), ['kb.search', 'doc.write']);
    await sweepTenant({ storage }, ws);
    await eraseSubject(ws, ownerUserId);
    const r = await editor.get(sug(ws));
    expect(r.body.suggestions.map((x: Sug) => x.toolSequence)).toEqual([['kb.search', 'doc.write']]);
  });
});

describe('row 52 S6 (ADR 0930 D7/A8) — a personal pause stops processing', () => {
  it('while paused, Scan reads no events and returns nothing; dismissals survive pause + unpause', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    const stamp = await realStamp(owner);
    await seedPattern(ws, stamp, ['a.tool', 'b.tool']);
    await seedPattern(ws, stamp, ['c.tool', 'd.tool']);
    const first = await owner.post(sug(ws, '/refresh'));
    expect(first.body.suggestions).toHaveLength(2);
    const dismissed = first.body.suggestions.find((x: Sug) => x.toolSequence[0] === 'a.tool')!.suggestionId;
    expect((await owner.post(sug(ws, `/${dismissed}/dismiss`))).status).toBe(200);

    expect((await owner.put(settings(ws), { paused: true })).status).toBe(200);
    expect((await owner.get(settings(ws))).body).toMatchObject({ paused: true });
    const spy = vi.spyOn(storage, 'listEvents');
    const paused = await owner.post(sug(ws, '/refresh'));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(paused.body).toMatchObject({ suggestions: [], paused: true });
    // Stops processing, not just display: no evidence is kept while paused.
    const stored = JSON.stringify(await listSuggestions(ws));
    expect(stored).not.toContain('c.tool');
    expect(stored).not.toContain('exampleRunIds":["');

    expect((await owner.put(settings(ws), { paused: false })).status).toBe(200);
    const back = await owner.post(sug(ws, '/refresh'));
    expect(back.body.suggestions.map((x: Sug) => x.toolSequence)).toEqual([['c.tool', 'd.tool']]);
  });

  it('CONTROL: my pause does not pause another member', async () => {
    const { ws, owner, members: [editor] } = await sharedWorkspace(['editor']);
    await seedPattern(ws, await realStamp(editor), ['kb.search', 'doc.write']);
    expect((await owner.put(settings(ws), { paused: true })).status).toBe(200);
    expect((await editor.post(sug(ws, '/refresh'))).body.suggestions).toHaveLength(1);
    expect((await editor.get(settings(ws))).body).toMatchObject({ paused: false });
  });

  it('the daemon reads no events of a paused person\'s runs', async () => {
    const { ws, owner, members: [editor] } = await sharedWorkspace(['editor']);
    const ownerRuns = await seedPattern(ws, await realStamp(owner), ['own.tool']);
    await seedPattern(ws, await realStamp(editor), ['ed.tool']);
    expect((await owner.put(settings(ws), { paused: true })).status).toBe(200);
    const spy = vi.spyOn(storage, 'listEvents');
    let read: string[] = [];
    try { await sweepTenant({ storage }, ws); read = spy.mock.calls.map((c) => c[0]); } finally { spy.mockRestore(); }
    for (const id of ownerRuns) expect(read).not.toContain(id);
    expect(read.length, 'CONTROL: the other member is still mined').toBeGreaterThan(0);
  });

  it('a row a racing sweep wrote for a paused person is never served (read-side guard)', async () => {
    const { ws, owner, ownerUserId } = await sharedWorkspace([]);
    const ownerKey = opaquePrincipal(ownerUserId);
    const signature = 'none|late.tool';
    await setSuppression(ws, ownerKey, 'paused');
    await upsertSuggestion({
      suggestionId: suggestionIdFor(ws, ownerKey, signature), tenantId: ws, ownerPrincipal: ownerKey, signature,
      toolSequence: ['late.tool'], count: 3, exampleRunIds: ['x'], status: 'suggested',
      firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z',
    });
    expect((await owner.get(sug(ws))).body.suggestions).toEqual([]);
  });
});

describe('row 52 S7 (ADR 0930 A3) — accept shares the step pattern, not the goal text', () => {
  it('the proposal another member can list carries no goal text', async () => {
    const { ws, owner, members: [viewer] } = await sharedWorkspace(['viewer']);
    await seedPattern(ws, { ...(await realStamp(owner)), goal: OWNER_GOAL }, OWNER_TOOLS);
    const id = (await owner.post(sug(ws, '/refresh'))).body.suggestions[0].suggestionId;
    const acc = await owner.post(sug(ws, `/${id}/accept`));
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body.draftSeed.sampleGoal).toBe(OWNER_GOAL); // the owner's own Pair thread keeps it
    const listed = await viewer.get('/host/openwop-app/proposals?kind=workflow-chain-pack');
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain('owner-secret-goal');
    expect(JSON.stringify(listed.body)).toContain(`wg:${id}`);
  });
});

describe('row 52 S8 (ADR 0930 A5/A6) — which runs count as "yours"', () => {
  it('C1 (AWG2CD-1): in a personal workspace with a member, the owner never sees the member\'s patterns', async () => {
    const owner = client();
    const u = await signup(owner, 'solo-owner');
    const orgId = await personalOrg(owner);
    const member = client();
    const m = await signup(member, 'solo-member');
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: m.userId, roles: ['editor'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await member.post(`/host/openwop-app/workspaces/${encodeURIComponent(u.tenantId)}/switch`)).status).toBe(200);
    await seedPattern(u.tenantId, { ...(await realStamp(member)), goal: 'MEMBER-SECRET-GOAL' }, ['member.tool']);
    const ownerScan = await owner.post(sug(orgId, '/refresh'));
    expect(ownerScan.status).toBe(200);
    expect(JSON.stringify(ownerScan.body)).not.toContain('MEMBER-SECRET-GOAL');
    expect(JSON.stringify(ownerScan.body)).not.toContain('member.tool');
    // CONTROL: the member reads their own.
    const memberScan = await member.post(sug(orgId, '/refresh'));
    expect(memberScan.body.suggestions.map((x: Sug) => x.toolSequence)).toEqual([['member.tool']]);
  });

  it('C2 (AWG2CD-2): runs a person never started by hand are not counted, in the shapes the host writes', async () => {
    const { ws, owner, ownerUserId } = await sharedWorkspace([]);
    const stamp = await realStamp(owner);
    // The scheduler daemon: `actingUserId` + the `schedule` block, no owner stamp.
    await seedPattern(ws, { actingUserId: ownerUserId, schedule: { jobId: 'job-1', firedAt: '2026-10-01T00:00:00Z' } }, ['cron.tool']);
    // An assistant loop / any legacy lane: `actingUserId` only.
    await seedPattern(ws, { actingUserId: ownerUserId }, ['legacy.tool']);
    // Stamped, but automation-marked or a part of other work.
    await seedPattern(ws, { ...stamp, heartbeat: { agentId: 'a' } }, ['heartbeat.tool']);
    await seedPattern(ws, { ...stamp, eval: { suiteRef: 's' } }, ['eval.tool']);
    for (let i = 0; i < 3; i++) await seedRun(ws, stamp, ['child.tool'], { parentRunId: 'parent-run' });
    // Stamped AND automation-marked, block by block (a future lane that stamps an owner
    // onto automated work must still not count), plus a stamp whose subject disagrees
    // with its principal (read back as the legacy subject).
    for (const k of ['schedule', 'kanban', 'approval', 'redriveOf', 'parentRunId']) await seedPattern(ws, { ...stamp, [k]: k === 'redriveOf' || k === 'parentRunId' ? 'x' : { id: 'x' } }, [`${k}.tool`]);
    const bad = stamp as { owner: { principal: string; subject: Record<string, unknown> } };
    await seedPattern(ws, { owner: { ...bad.owner, subject: { ...bad.owner.subject, subjectId: 'someone-else' } } }, ['mismatch.tool']);
    const r = await owner.post(sug(ws, '/refresh'));
    expect(r.status).toBe(200);
    expect(r.body.suggestions).toEqual([]);
    await sweepTenant({ storage }, ws);
    expect(await listSuggestions(ws)).toEqual([]);
  });

  it('the daemon writes the rows the route reads (personal and shared workspaces)', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    await seedPattern(ws, await realStamp(owner), ['w.tool', 'x.tool']);
    await sweepTenant({ storage }, ws);
    expect((await owner.get(sug(ws))).body.suggestions.map((x: Sug) => x.toolSequence)).toEqual([['w.tool', 'x.tool']]);

    const c = client();
    const u = await signup(c, 'solo-d');
    await seedPattern(u.tenantId, await realStamp(c), ['y.tool', 'z.tool']);
    await sweepTenant({ storage }, u.tenantId);
    expect((await c.get(sug(await personalOrg(c)))).body.suggestions.map((x: Sug) => x.toolSequence)).toEqual([['y.tool', 'z.tool']]);
  });

  it('key-driven (workload) runs are not manual work, even my own', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    const stamp = (await realStamp(owner)) as { owner: { principal: string; subject: Record<string, unknown> } };
    const workload = { owner: { principal: stamp.owner.principal, subject: { ...stamp.owner.subject, issuer: 'urn:openwop-app:api-key', kind: 'workload' } } };
    await seedPattern(ws, workload, ['api.tool', 'api.write']);
    expect((await owner.post(sug(ws, '/refresh'))).body.suggestions).toEqual([]);
    await sweepTenant({ storage }, ws);
    expect(JSON.stringify(await listSuggestions(ws))).not.toContain('api.tool');
  });

  it('the daemon stores nothing for an anonymous sandbox, and takes no claim for one', async () => {
    const anonTenant = `anon:awg-r2-${n++}`;
    // Owned by a durable USER stamp, so only the TENANT rule excludes it.
    const p = opaquePrincipal('someone');
    await seedPattern(anonTenant, { owner: { principal: p, principalKind: 'user', subject: { issuer: 'urn:openwop-app:session', subjectId: p, lane: 'api-key', kind: 'user' } } }, ['anon.tool']);
    await sweepTenant({ storage }, anonTenant);
    expect(await listSuggestions(anonTenant)).toEqual([]);
    const claim = vi.spyOn(storage, 'claimOnce');
    await processDueSweeps({ storage }, async () => [anonTenant], Date.parse('2026-10-18T10:00:00Z'));
    expect(claim).not.toHaveBeenCalled();
    claim.mockRestore();
  });
});

describe('row 52 S9 (ADR 0930 A7/A8/A9/A12) — ids, transitions, bounds and roles', () => {
  it('the suggestion id is a 96-bit sha256 prefix', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    await seedPattern(ws, await realStamp(owner), ['a.tool']);
    const r = await owner.post(sug(ws, '/refresh'));
    expect(r.body.suggestions[0].suggestionId).toMatch(/^ws-[0-9a-f]{24}$/);
  });

  it('a dismissed pattern cannot be accepted (409); an accepted one can be dismissed', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    const stamp = await realStamp(owner);
    await seedPattern(ws, stamp, ['a.tool']);
    await seedPattern(ws, stamp, ['b.tool']);
    const rows = (await owner.post(sug(ws, '/refresh'))).body.suggestions as Sug[];
    const a = rows.find((x) => x.toolSequence[0] === 'a.tool')!.suggestionId;
    const b = rows.find((x) => x.toolSequence[0] === 'b.tool')!.suggestionId;
    expect((await owner.post(sug(ws, `/${a}/dismiss`))).status).toBe(200);
    expect((await owner.post(sug(ws, `/${a}/accept`))).status).toBe(409);
    expect((await owner.post(sug(ws, `/${b}/accept`))).status).toBe(200);
    expect((await owner.post(sug(ws, `/${b}/accept`))).status).toBe(200); // idempotent
    expect((await owner.post(sug(ws, `/${b}/dismiss`))).status).toBe(200);
  });

  it('Scan says when it stopped before the workspace\'s oldest run', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    for (let i = 0; i < 1001; i++) {
      const at = new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString();
      await storage.insertRun({ runId: `awg-bulk-${ws}-${i}`, workflowId: 'wf', tenantId: ws, status: 'completed', inputs: {}, configurable: {}, metadata: {}, createdAt: at, updatedAt: at } as RunRecord);
    }
    const r = await owner.post(sug(ws, '/refresh'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scanned: 1000, truncated: true });
  });

  it('CONTROL: a small workspace is scanned to the end', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    await seedPattern(ws, await realStamp(owner), ['a.tool']);
    const r = await owner.post(sug(ws, '/refresh'));
    expect(r.body.truncated).toBe(false);
  });

  it('a Viewer scans, dismisses and pauses their own patterns, but accepting needs write', async () => {
    const { ws, members: [viewer] } = await sharedWorkspace(['viewer']);
    await seedPattern(ws, await realStamp(viewer), ['v.tool', 'w.tool']);
    await seedPattern(ws, await realStamp(viewer), ['v2.tool']);
    const r = await viewer.post(sug(ws, '/refresh'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [one, two] = r.body.suggestions as Sug[];
    expect((await viewer.post(sug(ws, `/${one!.suggestionId}/dismiss`))).status).toBe(200);
    expect((await viewer.post(sug(ws, `/${two!.suggestionId}/accept`))).status).toBe(403);
    expect((await viewer.put(settings(ws), { paused: true })).status).toBe(200);
  });
});

describe('row 52 S10 (ADR 0930 D4/D6/A2/A7) — races, collisions and legacy rows', () => {
  const row = (tenantId: string, ownerPrincipal: string, signature: string, extra: Partial<Parameters<typeof upsertSuggestion>[0]> = {}) => ({
    suggestionId: suggestionIdFor(tenantId, ownerPrincipal, signature), tenantId, ownerPrincipal, signature,
    toolSequence: [signature], count: 3, exampleRunIds: ['r1'], status: 'suggested' as const,
    firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z', ...extra,
  });

  it('a dismiss that lands between a sweep\'s read and its write is kept', async () => {
    const t = `awg-race-${n++}`;
    const first = row(t, 'o', 'sig');
    await upsertSuggestion(first);
    const orig = DurableCollection.prototype.get;
    let fired = false;
    const spy = vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, id: string) {
      const v = await orig.call(this, id);
      if (!fired && id === first.suggestionId) {
        fired = true;
        expect((await decideSuggestion(first.suggestionId, t, 'o', 'dismissed')).ok).toBe(true);
      }
      return v;
    });
    try {
      await upsertSuggestion({ ...first, count: 4 }); // the sweep, holding the pre-dismiss row
    } finally { spy.mockRestore(); }
    const stored = (await listSuggestions(t)).find((s) => s.suggestionId === first.suggestionId)!;
    expect(stored.status).toBe('dismissed');
    expect(stored.count).toBe(4); // evidence still refreshed
  });

  it('an id held by a different (tenant, owner, signature) is refused, never merged', async () => {
    const t = `awg-coll-${n++}`;
    const theirs = row(t, 'them', 'sig', { status: 'dismissed' });
    await upsertSuggestion(theirs);
    const mine = { ...row(t, 'me', 'other'), suggestionId: theirs.suggestionId };
    expect(await upsertSuggestion(mine)).toBeNull();
    const stored = (await listSuggestions(t)).find((s) => s.suggestionId === theirs.suggestionId)!;
    expect(stored).toMatchObject({ ownerPrincipal: 'them', signature: 'sig', status: 'dismissed' });
  });

  it('a pause that lands while a Scan is mining leaves nothing behind', async () => {
    const { ws, owner, ownerUserId } = await sharedWorkspace([]);
    await seedPattern(ws, await realStamp(owner), ['mid.tool']);
    const orig = storage.listEvents.bind(storage);
    let fired = false;
    const spy = vi.spyOn(storage, 'listEvents').mockImplementation(async (runId: string) => {
      if (!fired) { fired = true; await setSuppression(ws, opaquePrincipal(ownerUserId), 'paused'); }
      return orig(runId);
    });
    try {
      expect((await owner.post(sug(ws, '/refresh'))).status).toBe(200);
    } finally { spy.mockRestore(); }
    expect(JSON.stringify(await listSuggestions(ws))).not.toContain('mid.tool');
  });

  it('legacy tenant-wide rows are never served and the next Scan deletes them', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    // A pre-ADR 0930 row has NO ownerPrincipal. It reaches the store as JSON (the
    // shape a legacy row is read back in), so it is built through JSON, not a cast.
    const { ownerPrincipal: _owner, ...legacyFields } = { ...row(ws, 'x', 'legacy.sig'), suggestionId: `ws-legacy${n++}` };
    void _owner;
    const legacy: Parameters<typeof upsertSuggestion>[0] = JSON.parse(JSON.stringify(legacyFields));
    expect('ownerPrincipal' in legacy).toBe(false);
    await upsertSuggestion(legacy);
    expect((await owner.get(sug(ws))).body.suggestions).toEqual([]);
    await owner.post(sug(ws, '/refresh'));
    expect((await listSuggestions(ws)).filter((s) => s.ownerPrincipal === undefined)).toEqual([]);
  });
});


describe('row 52 S11 — closing-grade races (AWG2CD-3/4/6)', () => {
  it('AWG2CD-3: a pause that lands during an accept mints no proposal', async () => {
    const { ws, owner, ownerUserId, members: [viewer] } = await sharedWorkspace(['viewer']);
    await seedPattern(ws, await realStamp(owner), ['race.tool']);
    const id = (await owner.post(sug(ws, '/refresh'))).body.suggestions[0].suggestionId;
    const orig = DurableCollection.prototype.compareAndSwap;
    const spy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockImplementation(async function (this: DurableCollection<unknown>, expected: unknown, next: unknown) {
      const ok = await orig.call(this, expected, next);
      if ((next as { status?: string; suggestionId?: string }).suggestionId === id && (next as { status?: string }).status === 'accepted') {
        await setSuppression(ws, opaquePrincipal(ownerUserId), 'paused');
      }
      return ok;
    });
    let acc: Res;
    try { acc = await owner.post(sug(ws, `/${id}/accept`)); } finally { spy.mockRestore(); }
    expect(acc.status).toBe(404);
    const listed = await viewer.get('/host/openwop-app/proposals?kind=workflow-chain-pack');
    expect(JSON.stringify(listed.body)).not.toContain(`wg:${id}`);
  });

  it('AWG2CD-4: erasure also deletes legacy tenant-wide rows', async () => {
    const t = `awg-erase-legacy-${n++}`;
    const legacy = { suggestionId: `ws-legacy-e${n++}`, tenantId: t, signature: 's', toolSequence: ['s'], count: 3, exampleRunIds: ['r'], sampleGoal: 'LEGACY-GOAL', status: 'suggested' as const, firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z' };
    await upsertSuggestion(legacy);
    await eraseSubject(t, 'someone');
    expect(JSON.stringify(await listSuggestions(t))).not.toContain('LEGACY-GOAL');
  });

  it('AWG2CD-6: a dismissal made after a pause listed the rows survives the pause', async () => {
    const t = `awg-pause-race-${n++}`;
    const r = { suggestionId: suggestionIdFor(t, 'o', 'sig'), tenantId: t, ownerPrincipal: 'o', signature: 'sig', toolSequence: ['sig'], count: 3, exampleRunIds: ['r'], status: 'suggested' as const, firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z' };
    await upsertSuggestion(r);
    const orig = DurableCollection.prototype.listForTenantIndexed;
    let fired = false;
    const spy = vi.spyOn(DurableCollection.prototype, 'listForTenantIndexed').mockImplementation(async function (this: DurableCollection<unknown>, tenantId: string) {
      const rows = await orig.call(this, tenantId);
      if (!fired && tenantId === t) { fired = true; expect((await decideSuggestion(r.suggestionId, t, 'o', 'dismissed')).ok).toBe(true); }
      return rows; // the pause now holds the PRE-dismiss list
    });
    try { await forgetOwner(t, 'o', { keepDismissals: true }); } finally { spy.mockRestore(); }
    expect((await listSuggestions(t)).map((x) => x.status)).toEqual(['dismissed']);
  });
});

describe('row 52 S12 — closing-grade witnesses (AWG2CD-7/8/12, AWG2UX-15)', () => {
  it('AWG2CD-8: a pause racing an erasure never downgrades the erasure tombstone', async () => {
    const t = `awg-tomb-${n++}`;
    const orig = DurableCollection.prototype.get;
    let fired = false;
    const spy = vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, id: string) {
      const v = await orig.call(this, id);
      if (!fired && id === `${t}:o`) { fired = true; await setSuppression(t, 'o', 'erased'); }
      return v;
    });
    try { await setSuppression(t, 'o', 'paused'); } finally { spy.mockRestore(); }
    const { getSuppression } = await import('../src/features/ambient-work-graph/pauseStore.js');
    expect((await getSuppression(t, 'o'))?.reason).toBe('erased');
  });

  it('AWG2CD-7: a Scan that stops at the owned-run cap says it was truncated', async () => {
    const { ws, owner } = await sharedWorkspace([]);
    const stamp = await realStamp(owner);
    for (let i = 0; i < 201; i++) await seedRun(ws, stamp, ['cap.tool']);
    const r = await owner.post(sug(ws, '/refresh'));
    expect(r.body).toMatchObject({ truncated: true });
    expect(r.body.scanned).toBeLessThan(1000);
  });

  it('AWG2CD-12: a paused owner cannot dismiss even a row a racing sweep left behind', async () => {
    const { ws, owner, ownerUserId } = await sharedWorkspace([]);
    const ownerKey = opaquePrincipal(ownerUserId);
    await setSuppression(ws, ownerKey, 'paused');
    const late = { suggestionId: suggestionIdFor(ws, ownerKey, 'none|late'), tenantId: ws, ownerPrincipal: ownerKey, signature: 'none|late', toolSequence: ['late'], count: 3, exampleRunIds: ['r1', 'r2', 'r3'], status: 'suggested' as const, firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z' };
    await upsertSuggestion(late);
    expect((await owner.post(sug(ws, `/${late.suggestionId}/dismiss`))).status).toBe(404);
  });

  it('AWG2UX-15: after an erasure the settings say why detection is off', async () => {
    const { ws, owner, ownerUserId } = await sharedWorkspace([]);
    await eraseSubject(ws, ownerUserId);
    expect((await owner.get(settings(ws))).body).toEqual({ paused: true, reason: 'erased' });
  });
});
