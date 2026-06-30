/**
 * Strategy health rollup (ADR 0080 Phase A). Pure-function unit coverage of the
 * verdict bands + signals, plus a route test that the `GET /strategy/health`
 * endpoint rolls up a linked project's charter health (RBAC-filtered, live).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeStrategyHealth } from '../src/features/strategy/strategyHealth.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

describe('computeStrategyHealth (pure)', () => {
  const entry = (over: Partial<Parameters<typeof computeStrategyHealth>[0]>) =>
    ({ objectives: [], linkedProjects: [], linkedPriorities: [], ...over });

  it('off-track when any linked project is off-track', () => {
    const r = computeStrategyHealth(entry({ linkedProjects: [{ id: 'p', name: 'P', health: 'off-track' }] }));
    expect(r.health).toBe('off-track');
    expect(r.signals.projectsOffTrack).toBe(1);
  });

  it('off-track when objectives are declared but nothing executable is linked', () => {
    const r = computeStrategyHealth(entry({ objectives: [{ title: 'Grow', keyResults: [] }] }));
    expect(r.health).toBe('off-track');
    expect(r.signals.hasExecution).toBe(false);
  });

  it('at-risk when a linked project is at-risk', () => {
    expect(computeStrategyHealth(entry({ linkedProjects: [{ id: 'p', name: 'P', health: 'at-risk' }] })).health).toBe('at-risk');
  });

  it('at-risk when tracked milestones are < 40% complete', () => {
    const r = computeStrategyHealth(entry({ linkedProjects: [{ id: 'p', name: 'P', health: 'on-track', milestonesDone: 1, milestonesTotal: 5 }] }));
    expect(r.health).toBe('at-risk');
    expect(r.signals.milestonesDone).toBe(1);
    expect(r.signals.milestonesTotal).toBe(5);
  });

  it('on-track with healthy linked execution and ≥40% milestones', () => {
    const r = computeStrategyHealth(entry({
      objectives: [{ title: 'O', keyResults: [] }],
      linkedProjects: [{ id: 'p', name: 'P', health: 'on-track', milestonesDone: 3, milestonesTotal: 5 }],
      linkedPriorities: [{ listId: 'l', title: 'idea', rank: 1 }],
    }));
    expect(r.health).toBe('on-track');
    expect(r.signals.hasExecution).toBe(true);
  });

  it('on-track when execution is linked but no milestones are tracked', () => {
    expect(computeStrategyHealth(entry({ linkedPriorities: [{ listId: 'l', title: 'x' }] })).health).toBe('on-track');
  });

  // ADR 0080 §Follow-on guard: a linked PRIORITY (not just a project) counts as
  // execution and flips the verdict. This is why `/strategy/health` MUST go
  // through the full context resolve (resolveStrategyHealth) and can NOT skip
  // priority resolution as a "health-only" shortcut — the same objectives are
  // off-track with no links but on-track with a priority link.
  it('priorities feed the verdict: objectives + a priority link is NOT off-track', () => {
    const objectives = [{ title: 'Grow', keyResults: [] }];
    expect(computeStrategyHealth(entry({ objectives })).health).toBe('off-track');
    const withPriority = computeStrategyHealth(entry({ objectives, linkedPriorities: [{ listId: 'l', title: 'bet' }] }));
    expect(withPriority.health).not.toBe('off-track');
    expect(withPriority.signals.hasExecution).toBe(true);
    expect(withPriority.signals.linkedPriorityCount).toBe(1);
  });
});

// ── route ──
let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['strategy']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b) };
}

describe('GET /strategy/health (route)', () => {
  const S = '/v1/host/openwop-app/strategy';
  it('rolls up a linked off-track project into the strategy health (RBAC-filtered)', async () => {
    const c = client();
    const u = await c.post('/v1/host/openwop-app/test/login', { email: `h-${Date.now()}-${n++}@x.test`, tenantId: `org:h-${Date.now()}-${n++}` });
    expect(u.status).toBe(201);
    const orgId = (await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    const proj = (await c.post('/v1/host/openwop-app/projects', { orgId, name: 'Apollo' })).body;
    await c.patch(`/v1/host/openwop-app/projects/${proj.id}`, { charter: { health: 'off-track', milestones: [{ id: 'm1', title: 'ship', done: false }] } });
    const s = (await c.post(S, { orgId, title: 'Win', scope: 'org', objectives: [{ title: 'Grow', keyResults: [] }] })).body;
    await c.put(`${S}/${s.id}/links`, { links: [{ kind: 'project', projectId: proj.id }] });

    const health = await c.get(`${S}/health`);
    expect(health.status, JSON.stringify(health.body)).toBe(200);
    const row = health.body.strategies.find((x: any) => x.id === s.id);
    expect(row).toBeTruthy();
    expect(row.health).toBe('off-track');
    expect(row.signals.projectsOffTrack).toBe(1);
    expect(row.signals.milestonesTotal).toBe(1);
  });

  it('a manual healthOverride wins over the computed verdict; clearing it (null) reverts to Auto', async () => {
    const c = client();
    await c.post('/v1/host/openwop-app/test/login', { email: `ho-${Date.now()}-${n++}@x.test`, tenantId: `org:ho-${Date.now()}-${n++}` });
    const orgId = (await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    // Objectives declared but nothing executable linked ⇒ computes off-track.
    const s = (await c.post(S, { orgId, title: 'Override me', scope: 'org', objectives: [{ title: 'Grow', keyResults: [] }] })).body;
    const computed = (await c.get(`${S}/health`)).body.strategies.find((x: any) => x.id === s.id);
    expect(computed.health).toBe('off-track');

    // Manual override wins; the signals remain the computed truth.
    expect((await c.patch(`${S}/${s.id}`, { healthOverride: 'on-track' })).status).toBe(200);
    const overridden = (await c.get(`${S}/health`)).body.strategies.find((x: any) => x.id === s.id);
    expect(overridden.health).toBe('on-track');
    expect(overridden.signals.hasExecution).toBe(false);

    // Clearing reverts to the derived verdict.
    expect((await c.patch(`${S}/${s.id}`, { healthOverride: null })).status).toBe(200);
    const reverted = (await c.get(`${S}/health`)).body.strategies.find((x: any) => x.id === s.id);
    expect(reverted.health).toBe('off-track');
  });

  it('404s when the strategy toggle is off', async () => {
    const d = getToggleDefault('strategy'); if (d) await saveConfig({ ...d, status: 'off' }, 'test');
    const c = client();
    await c.post('/v1/host/openwop-app/test/login', { email: `h2-${Date.now()}-${n++}@x.test` });
    expect((await c.get(`${S}/health`)).status).toBe(404);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  });
});
