/**
 * ADR 0949 P2b — `ctx.features.experiments` and the `feature.experiments.nodes`
 * pack.
 *
 *   1. The surface holds the same org floor as the routes: a run acting for a
 *      member reads and writes; a run acting for a non-member is refused.
 *   2. A run can draft, pre-register and lock, but there is NO launch: the
 *      surface has no `launch`, and the pack ships no launch node.
 *   3. The surface never hands a run the assignment salt or the tenant.
 *   4. The pack's node map and its manifest agree, every writer is
 *      `role:side-effect`, and the pack is pinned.
 *
 * Sabotage (run 2026-10-20): removing the org floor from `write` reds 1; adding
 * a `launch` method reds 2; projecting `salt` reds 3.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createPage } from '../src/features/cms/cmsService.js';
import { buildExperimentsSurface } from '../src/features/experiments/surface.js';
import { PACK_PINS } from '../src/features/packPins.js';

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
  for (const id of ['experiments', 'analytics']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function owner() {
  const tenantId = `org:p2b-${Date.now()}-${n++}`;
  let cookie = '';
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m?.[1]) cookie = m[1]; }
    return (await res.json()) as Record<string, unknown>;
  };
  const login = await post('/host/openwop-app/test/login', { email: `p2b-${n++}@acme.test`, tenantId });
  const userId = (login.user as { userId: string }).userId;
  const orgId = (await post('/host/openwop-app/orgs', { name: 'Client A' })).orgId as string;
  const page = await createPage({ tenantId, orgId, title: `LP ${n}`, createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
  return { tenantId, orgId, userId, page };
}

const PLAN = { primaryMetric: { kind: 'conversion', name: 'signup' }, guardrails: [], baselineRate: 0.1, mde: 0.02, alpha: 0.05, power: 0.8, fdrQ: 0.05, minDays: 7, maxDays: 30 };
const ARMS = [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: null, weight: 50 }];

describe('ADR 0949 P2b — ctx.features.experiments', () => {
  it('a member drafts, pre-registers and locks; a non-member is refused', async () => {
    const o = await owner();
    const member = buildExperimentsSurface({ tenantId: o.tenantId, actingUserId: o.userId });
    const drafted = await member.createDraft({ orgId: o.orgId, name: 'Hero', surface: { kind: 'cms.page', ref: o.page.pageId }, arms: ARMS, plan: PLAN }) as { experiment: { experimentId: string; createdBy: string; planDraft: unknown }; proposed: boolean };
    expect(drafted.proposed).toBe(true);
    expect(drafted.experiment.createdBy).toBe(o.userId);
    expect(drafted.experiment.planDraft).toMatchObject({ baselineRate: 0.1 });
    const locked = await member.lockPlan({ orgId: o.orgId, experimentId: drafted.experiment.experimentId }) as { experiment: { plan: { minSamplePerArm: number } } };
    expect(locked.experiment.plan.minSamplePerArm).toBe(3841);
    await expect(member.updateDraft({ orgId: o.orgId, experimentId: drafted.experiment.experimentId, name: 'x' })).rejects.toMatchObject({ details: { reason: 'plan_locked' } });

    const stranger = buildExperimentsSurface({ tenantId: o.tenantId, actingUserId: 'user:stranger' });
    await expect(stranger.list({ orgId: o.orgId })).rejects.toBeTruthy();
    await expect(stranger.createDraft({ orgId: o.orgId, name: 'Nope', surface: { kind: 'cms.page', ref: o.page.pageId }, arms: ARMS })).rejects.toBeTruthy();
    expect(((await member.list({ orgId: o.orgId })) as { experiments: unknown[] }).experiments).toHaveLength(1);
  });

  it('a run cannot launch, and never sees the salt or the tenant', async () => {
    const o = await owner();
    const surface = buildExperimentsSurface({ tenantId: o.tenantId, actingUserId: o.userId });
    expect(surface).not.toHaveProperty('launch');
    const { experiment } = await surface.createDraft({ orgId: o.orgId, name: 'Hero', surface: { kind: 'cms.page', ref: o.page.pageId }, arms: ARMS }) as { experiment: Record<string, unknown> };
    expect(experiment).not.toHaveProperty('salt');
    expect(experiment).not.toHaveProperty('tenantId');
    const got = await surface.get({ orgId: o.orgId, experimentId: experiment.experimentId }) as { experiment: Record<string, unknown> };
    expect(got.experiment).not.toHaveProperty('salt');
    expect(await surface.powerCalc({ orgId: o.orgId, baselineRate: 0.1, mde: 0.02, alpha: 0.05, power: 0.8 })).toEqual({ samplePerArm: 3841 });
    await expect(surface.powerCalc({ orgId: o.orgId, baselineRate: 0.1, mde: 0.02, alpha: 2, power: 0.8 })).rejects.toMatchObject({ code: 'validation_error', details: { field: 'alpha' } });
  });
});

describe('ADR 0949 P2b — feature.experiments.nodes', () => {
  const dir = fileURLToPath(new URL('../../../packs/feature.experiments.nodes/', import.meta.url));
  const manifest = JSON.parse(readFileSync(`${dir}pack.json`, 'utf8')) as { name: string; version: string; nodes: Array<{ typeId: string; role: string; capabilities: string[] }> };

  it('the node map matches the manifest, writers are side-effects, there is no launch node, and the pack is pinned', async () => {
    const mod = (await import(`${dir}index.mjs`)) as { nodes: Record<string, unknown> };
    expect(Object.keys(mod.nodes).sort()).toEqual(manifest.nodes.map((nd) => nd.typeId).sort());
    expect(manifest.nodes.some((nd) => /launch/.test(nd.typeId))).toBe(false);
    for (const nd of manifest.nodes.filter((x) => /create-draft|update-draft|lock-plan|stop/.test(x.typeId))) {
      expect([nd.typeId, nd.role, nd.capabilities]).toEqual([nd.typeId, 'side-effect', ['side-effectful']]);
    }
    expect((PACK_PINS as Record<string, string>)[manifest.name]).toBe(manifest.version);
  });

  it('a node calls the surface and refuses a missing input', async () => {
    const mod = (await import(`${dir}index.mjs`)) as { nodes: Record<string, (ctx: unknown) => Promise<{ outputs: unknown }>> };
    const calls: unknown[] = [];
    const ctx = (inputs: Record<string, unknown>) => ({ inputs, features: { experiments: { get: async (a: unknown) => { calls.push(a); return { experiment: null }; } } } });
    expect((await mod.nodes['feature.experiments.nodes.get']!(ctx({ orgId: 'o', experimentId: 'x' }))).outputs).toEqual({ experiment: null });
    expect(calls).toEqual([{ orgId: 'o', experimentId: 'x' }]);
    await expect(mod.nodes['feature.experiments.nodes.get']!(ctx({ orgId: 'o' }))).rejects.toMatchObject({ code: 'validation_error' });
  });
});
