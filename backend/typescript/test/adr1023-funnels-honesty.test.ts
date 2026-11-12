/**
 * ADR 1023 — Funnels: blueprints the model can read, and step stats that count
 * honestly. The row-72 grade (`docs/steward/workflows-assessment/2026-11-01-funnels-row72.md`)
 * found these legs green-by-omission; each case here is the witness its fix lacked.
 *
 *  1. D2 (the loader's sub-chain child lane) is witnessed by its own PR's
 *     `subchain-children-expand-params.test.ts`; this file covers the funnel half.
 *  2. D5 (FN72WF-11/-12): views are distinct visitors on the day of their FIRST
 *     view; a completion counts only for a viewer, on the view's day; the rest is
 *     `unattributed` and never part of a rate. So completions ≤ views on every day.
 *  3. D9 (FN72WF-22): a model-facing `revenue` is null across currencies.
 *  4. FN72WF-2/-5: `funnels.optimize-step` (a gallery copy, the real loader and
 *     executor; only `callAI` stubbed) hands the model BOTH the funnel definition —
 *     as a closed projection, never the row (FN72CD-2) — and the stats; an unknown funnel fails the run `not_found` before any model call
 *     (each read node's own typed failure is witnessed in `funnels-packs.test.ts`).
 *  5. D8 (FN72WF-20): a PATCH carrying a stale `expectedUpdatedAt` is refused 409
 *     `funnel_changed` and changes nothing; the current one is accepted.
 *
 * Sabotage-witnessed (each alone turns its leg red): counting a completion with no view (2); summing
 * `revenue` across currencies (3); the bare `funnel→propose` edge, and the `get`
 * node ignoring `view: 'model'` (4); dropping
 * the `expectedUpdatedAt` comparison in `updateFunnel` (5).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiCallRequest, AiCallResult } from '../src/executor/types.js';

const ai = vi.hoisted(() => ({ calls: [] as AiCallRequest[] }));
vi.mock('../src/aiProviders/aiProvidersHost.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/aiProviders/aiProvidersHost.js')>();
  return {
    ...actual,
    createAiProvidersAdapter: ((...args: Parameters<typeof actual.createAiProvidersAdapter>) => {
      const real = actual.createAiProvidersAdapter(...args);
      return {
        ...real,
        callAI: async (req: AiCallRequest): Promise<AiCallResult> => {
          ai.calls.push(req);
          return { content: 'Weakest step: Opt-in. Not enough traffic to be sure.' } as AiCallResult;
        },
      };
    }) as typeof actual.createAiProvidersAdapter,
  };
});

import { bootPlanningApp, makeClient, enableToggle, uniqEmail } from './planningHarness.js';
import { createPage } from '../src/features/cms/cmsService.js';
import { createFunnel } from '../src/features/funnels/funnelsService.js';
import { rebuildFunnelStats, getFunnelStats, projectStepTotals, type FunnelDayStat } from '../src/features/funnels/funnelStats.js';
import { persistCollectedEvent } from '../src/features/cdp/visitorEventIndex.js';

let BASE = '';
let close: () => Promise<void>;
let n = 0;
const H = '/host/openwop-app';

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; close = h.close;
  for (const id of ['users', 'funnels', 'cms', 'cdp']) await enableToggle(id, 'on');
});
afterAll(async () => { await close(); });

async function team() {
  const tenantId = `org:fn1023-${Date.now()}-${n++}`;
  const owner = makeClient(() => BASE);
  const ownerId = (await owner.post(`${H}/test/login`, { email: uniqEmail('fn1023'), tenantId })).body.user.userId as string;
  const orgId = (await owner.post(`${H}/orgs`, { name: 'Client' })).body.orgId as string;
  const page = await createPage({ tenantId, orgId, title: 'Opt-in', createdBy: ownerId });
  const funnel = await createFunnel({ tenantId, orgId, createdBy: ownerId, name: `Launch ${n}`, steps: [{ stepId: 'optin', kind: 'optin', name: 'Opt-in', pageId: page.pageId }] });
  return { tenantId, owner, ownerId, orgId, funnel };
}

describe('ADR 1023 D5 — visitor-cohort step stats', () => {
  it('views are distinct first views; completions only for viewers, on the view day; the rest is unattributed', async () => {
    const t = await team();
    const at = (d: string) => `${d}T12:00:00.000Z`;
    let e = 0;
    const evt = async (type: 'view' | 'complete', day: string, visitor: string, extra: Record<string, unknown> = {}) => {
      await persistCollectedEvent({
        eventId: `evt:fn1023-${n}-${e++}`, tenantId: t.tenantId,
        eventType: type === 'view' ? 'funnel.step_viewed' : 'funnel.step_completed',
        payload: { orgId: t.orgId, funnelId: t.funnel.funnelId, stepId: 'optin', visitor, ...extra },
        piiFields: [], at: at(day),
      });
    };
    await evt('view', '2026-10-01', 'vA');
    await evt('complete', '2026-10-02', 'vA');
    await evt('view', '2026-10-03', 'vA'); // a return visit is not a second viewer
    await evt('complete', '2026-10-03', 'vA'); // nor a second completion
    await evt('view', '2026-10-02', 'vC'); // views, never completes
    await evt('complete', '2026-10-02', 'vB'); // completes with no view → unattributed
    await evt('complete', '2026-10-02', '', { submissionId: 'sub:x', source: 'form-submit' }); // unconsented → unattributed
    await evt('complete', '2026-10-02', '', { submissionId: 'sub:x', source: 'form-submit' }); // the same submission again

    await rebuildFunnelStats(t.tenantId, t.orgId);
    const days = await getFunnelStats(t.tenantId, t.orgId, t.funnel.funnelId);
    const cell = (d: string) => days.find((r) => r.day === d)?.steps.optin;
    expect(cell('2026-10-01')).toMatchObject({ views: 1, completions: 1 }); // vA's cohort day
    expect(cell('2026-10-02')).toMatchObject({ views: 1, completions: 0, unattributed: 2 }); // vC; vB + one submission
    expect(cell('2026-10-03')).toBeUndefined();
    for (const r of days) for (const c of Object.values(r.steps)) expect(c.completions).toBeLessThanOrEqual(c.views);

    const stats = await t.owner.get(`${H}/funnels/orgs/${encodeURIComponent(t.orgId)}/funnels/${t.funnel.funnelId}/stats`);
    expect(stats.status, JSON.stringify(stats.body)).toBe(200);
    const step = (stats.body.steps as Array<{ stepId: string; views: number; completions: number; unattributed: number; conversion: number | null }>).find((s) => s.stepId === 'optin')!;
    expect(step).toMatchObject({ views: 2, completions: 1, unattributed: 2, conversion: 0.5 });
  });
});

describe('ADR 1023 D9 — model-facing revenue keeps its currency', () => {
  it('revenue is null when a step took more than one currency; the split stays', () => {
    const row = (day: string, steps: FunnelDayStat['steps']): FunnelDayStat => ({ statId: day, tenantId: 't', orgId: 'o', funnelId: 'f', day, steps, rebuiltAt: '' });
    const out = projectStepTotals([
      row('2026-10-01', { a: { views: 2, completions: 1, revenue: 10, orders: 1, revenueByCurrency: { USD: 10 } }, b: { views: 1, completions: 0, revenue: 5, orders: 1, revenueByCurrency: { USD: 5 } } }),
      row('2026-10-02', { a: { views: 1, completions: 1, unattributed: 1, revenue: 7, orders: 1, revenueByCurrency: { EUR: 7 } } }),
    ]);
    expect(out.steps.a).toEqual({ views: 3, completions: 2, unattributed: 1, orders: 2, revenue: null, revenueByCurrency: { USD: 10, EUR: 7 } });
    expect(out.steps.b!.revenue).toBe(5);
  });
});

describe('ADR 1023 FN72WF-2/-5 — the optimize-step chain', () => {
  const runCopy = async (t: Awaited<ReturnType<typeof team>>, funnelId: string) => {
    const inst = await t.owner.post(`${H}/workflows/from-chain`, { chainId: 'funnels.optimize-step', params: { orgId: t.orgId, funnelId } });
    expect(inst.status, JSON.stringify(inst.body)).toBe(201);
    const run = await t.owner.post('/runs', { workflowId: inst.body.workflowId, inputs: {} });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    return vi.waitFor(async () => {
      const st = (await t.owner.get(`/runs/${run.body.runId as string}`)).body as { status: string; error?: unknown };
      expect(['completed', 'failed', 'cancelled']).toContain(st.status);
      return st;
    }, { timeout: 20_000, interval: 100 });
  };

  it('hands the model the funnel definition AND its stats', async () => {
    const t = await team();
    const before = ai.calls.length;
    const fin = await runCopy(t, t.funnel.funnelId);
    expect(fin.status, JSON.stringify(fin.error)).toBe('completed');
    const calls = ai.calls.slice(before);
    expect(calls).toHaveLength(1);
    const user = calls[0]!.messages.find((m) => m.role === 'user');
    const turn = JSON.parse(String(user?.content)) as { funnel?: { name?: string; steps?: unknown[] }; stats?: { steps?: unknown; days?: unknown } };
    expect(turn.funnel?.name).toBe(t.funnel.name); // the definition (it used to be overwritten)
    expect(turn.funnel?.steps).toHaveLength(1);
    // FN72CD-2 — a closed projection, never the row (no ids, timestamps, salts, receipts).
    expect(Object.keys(turn.funnel ?? {}).sort()).toEqual(['name', 'status', 'steps']);
    for (const leak of ['tenantId', 'createdBy', 'updatedAt', 'createdAt', 'funnelId', 'pageId', 'salt', t.tenantId]) expect(user?.content, leak).not.toContain(leak);
    expect(turn.stats).toMatchObject({ steps: {}, days: 0 });
  });

  it('an unknown funnel fails the run not_found before any model call', async () => {
    const t = await team();
    const before = ai.calls.length;
    const fin = await runCopy(t, 'funnel:does-not-exist');
    expect(fin.status).toBe('failed');
    expect(JSON.stringify(fin.error)).toContain('not_found');
    expect(ai.calls.length - before).toBe(0);
  });
});

describe('ADR 1023 D8 — a stale editor cannot overwrite newer steps', () => {
  it('refuses a PATCH with a stale expectedUpdatedAt and accepts the current one', async () => {
    const t = await team();
    const url = `${H}/funnels/orgs/${encodeURIComponent(t.orgId)}/funnels/${t.funnel.funnelId}`;
    const loaded = t.funnel.updatedAt;
    const first = await t.owner.patch(url, { name: 'Edited elsewhere', expectedUpdatedAt: loaded });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const stale = await t.owner.patch(url, { name: 'Stale tab', expectedUpdatedAt: loaded });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain('funnel_changed');
    const now = await t.owner.get(url);
    expect(now.body.funnel.name).toBe('Edited elsewhere');
  });
});
