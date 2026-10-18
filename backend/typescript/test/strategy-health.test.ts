/**
 * Strategy health rollup (ADR 0080 Phase A). Pure-function unit coverage of the
 * verdict bands + signals, plus a route test that the `GET /strategy/health`
 * endpoint rolls up a linked project's charter health (live), honours a manual
 * `healthOverride`, and is gated by the `strategy` toggle.
 *
 * Sabotage witnesses (wave 19, `w19g3-hea-*`): dropping the off-track-project, the
 * objectives-with-no-execution, the at-risk-project or the <40% milestone band reds the
 * case that names it; `<= 0.4` reds the band-edge case (2/5); counting only projects as
 * execution reds the priority case; treating "no milestones tracked" as 0% reds the
 * no-milestones case; dropping the charter health, the override, or the toggle check reds
 * the route case that names it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeStrategyHealth } from '../src/features/strategy/strategyHealth.js';
import type { StrategyHealthRow } from '../src/features/strategy/types.js';
import { bootPlanningApp, makeClient, enableToggle, type Client } from './planningHarness.js';

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

  // 2/5 is EXACTLY the 40% band edge — 3/5 left `< 0.4` → `<= 0.4` green.
  it('on-track with healthy linked execution and ≥40% milestones (2/5 — the band edge)', () => {
    const r = computeStrategyHealth(entry({
      objectives: [{ title: 'O', keyResults: [] }],
      linkedProjects: [{ id: 'p', name: 'P', health: 'on-track', milestonesDone: 2, milestonesTotal: 5 }],
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
let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('strategy', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);

describe('GET /strategy/health (route)', () => {
  const S = '/host/openwop-app/strategy';
  it('rolls up a linked off-track project into the strategy health', async () => {
    const c = client();
    const u = await c.post('/host/openwop-app/test/login', { email: `h-${Date.now()}-${n++}@x.test`, tenantId: `org:h-${Date.now()}-${n++}` });
    expect(u.status).toBe(201);
    const orgId = (await c.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    const proj = (await c.post('/host/openwop-app/projects', { orgId, name: 'Apollo' })).body;
    await c.patch(`/host/openwop-app/projects/${proj.id}`, { charter: { health: 'off-track', milestones: [{ id: 'm1', title: 'ship', done: false }] } });
    const s = (await c.post(S, { orgId, title: 'Win', scope: 'org', objectives: [{ title: 'Grow', keyResults: [] }] })).body;
    await c.put(`${S}/${s.id}/links`, { links: [{ kind: 'project', projectId: proj.id }] });

    const health = await c.get(`${S}/health`);
    expect(health.status, JSON.stringify(health.body)).toBe(200);
    const row = health.body.strategies.find((x: StrategyHealthRow) => x.id === s.id);
    expect(row).toBeTruthy();
    expect(row.health).toBe('off-track');
    expect(row.signals.projectsOffTrack).toBe(1);
    expect(row.signals.milestonesTotal).toBe(1);
    expect(row.signals.linkedProjectCount).toBe(1);
  });

  it('a manual healthOverride wins over the computed verdict; clearing it (null) reverts to Auto', async () => {
    const c = client();
    await c.post('/host/openwop-app/test/login', { email: `ho-${Date.now()}-${n++}@x.test`, tenantId: `org:ho-${Date.now()}-${n++}` });
    const orgId = (await c.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    // Objectives declared but nothing executable linked ⇒ computes off-track.
    const s = (await c.post(S, { orgId, title: 'Override me', scope: 'org', objectives: [{ title: 'Grow', keyResults: [] }] })).body;
    const computed = (await c.get(`${S}/health`)).body.strategies.find((x: StrategyHealthRow) => x.id === s.id);
    expect(computed.health).toBe('off-track');

    // Manual override wins; the signals remain the computed truth.
    expect((await c.patch(`${S}/${s.id}`, { healthOverride: 'on-track' })).status).toBe(200);
    const overridden = (await c.get(`${S}/health`)).body.strategies.find((x: StrategyHealthRow) => x.id === s.id);
    expect(overridden.health).toBe('on-track');
    expect(overridden.signals.hasExecution).toBe(false);

    // Clearing reverts to the derived verdict.
    expect((await c.patch(`${S}/${s.id}`, { healthOverride: null })).status).toBe(200);
    const reverted = (await c.get(`${S}/health`)).body.strategies.find((x: StrategyHealthRow) => x.id === s.id);
    expect(reverted.health).toBe('off-track');
  });

  it('404s when the strategy toggle is off', async () => {
    const c = client();
    await c.post('/host/openwop-app/test/login', { email: `h2-${Date.now()}-${n++}@x.test` });
    // Matched control: the same caller reads the route while the feature is on.
    expect((await c.get(`${S}/health`)).status).toBe(200);
    await enableToggle('strategy', 'off');
    try {
      const r = await c.get(`${S}/health`);
      expect(r.status).toBe(404);
      // The FEATURE gate refused it — not an unrelated miss.
      expect(JSON.stringify(r.body)).toContain('"feature":"strategy"');
    } finally {
      await enableToggle('strategy', 'on');
    }
  });
});
