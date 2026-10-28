/**
 * ADR 0949 P3b — journey splits on the engine, and contact assignment outside a
 * run (the ADR 0955 P3b agreement with build-0905-email).
 *
 *   1. `assignContactArm` is pure: the same contact gets the same arm on every
 *      pass, under the epoch the caller froze, whatever happened since (a new
 *      epoch, a stop); it writes nothing; a draft or an unknown epoch is null.
 *   2. `bucketHoldout` keeps the string-salted holdout byte-identical for any
 *      non-engine id (and for an `exp:` id with Experiments OFF); an engine
 *      experiment assigns through `assignAt` at the run's frozen instant, needs
 *      `orgId` bound to the run (`wrong_client` for another client's run), and refuses an experiment that is not a journey split; an
 *      unstamped run is not in the test (control, `assigned: false`).
 *   3. The `journey.split` adapter: contact units, exactly two content-free
 *      arms, one running split per journey, and `observe` re-derives each
 *      enrolled contact's arm (the SAME arm the split routed) with a click as
 *      the conversion and unsubscribe / complaint / hard_bounce as guardrails.
 *      `observe` counts only the experiment's own client's enrollments.
 *   1b. A ramp epoch (ADR 0950) assigns outside a run exactly as inside one:
 *      `contactArmAt` reads the band layout, as `runFreeze.assignAt` does.
 *   4. The journey `split` node passes `orgId` through.
 *
 * Sabotage (re-run 2026-10-26 on main, each red, then restored): reading the
 * CURRENT epoch instead of the frozen one in `contactArmAt` reds 1; dropping the
 * `exp:` toggle check (engine on with Experiments OFF) reds 2's string case;
 * dropping `bindJourneyOrg` from the engine split reds 2's client case;
 * counting opens as conversions reds 3; ignoring a ramp epoch's band layout in
 * `contactArmAt` reds 1b; dropping the client filter in `observe` reds 3's
 * client case.
 * (The 2026-10-20 build's cases 3 and 4 were red on their own base: launch needs
 * a locked plan, and the node's host check needs `enroll`/`checkEligibility`.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getExperimentRow, putExperimentRow } from '../src/host/experiments/store.js';
import { assignAt, readExperimentsRunStamp } from '../src/host/experiments/runFreeze.js';
import { assignContactArm, contactArmAt } from '../src/host/experiments/contactAssign.js';
import { experimentSurface } from '../src/host/experiments/adapters.js';
import type { Experiment } from '../src/host/experiments/types.js';
import { createDraft, launch, lockPlan } from '../src/features/experiments/experimentsService.js';
import { buildCampaignJourneysSurface, holdoutArm } from '../src/features/campaign-journeys/surface.js';
import { JOURNEY_SPLIT_SURFACE } from '../src/features/campaign-journeys/experimentSurface.js';
import { enroll } from '../src/features/campaign-journeys/journeyService.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { addSuppression } from '../src/features/crm/suppressionService.js';
import { mintToken, recordClick, recordOpen } from '../src/features/email/engagementService.js';
import { bareRunId } from './support/bareRunId.js';

let server: http.Server;
let storage: Storage;
let BASE = '';
let workflowId = '';
let n = 0;

const setToggle = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('experiments');
  if (d) await saveConfig({ ...d, status }, 'test');
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const disco = await api<{ fixtures?: string[] }>('/.well-known/openwop');
  workflowId = disco.body.fixtures?.[0] ?? 'openwop-app.uppercase';
  await setToggle('on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', ...((init.headers as Record<string, string>) ?? {}) } });
  return { status: res.status, body: (res.status === 204 ? undefined : await res.json()) as T };
}
/** A real run (stamped when Experiments is ON); returns its bare id and tenant. */
async function stampedRun(): Promise<{ runId: string; tenantId: string; asOf: string | null }> {
  const r = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: {} }) });
  expect(r.status).toBe(201);
  const run = (await storage.getRun(bareRunId(r.body.runId)))!;
  return { runId: run.runId, tenantId: run.tenantId, asOf: readExperimentsRunStamp(run.metadata)?.asOf ?? null };
}

function experiment(tenantId: string, over: Partial<Experiment> = {}): Experiment {
  return {
    experimentId: `exp:p3b-${n++}`, tenantId, orgId: 'org-p3b', name: 'Journey split', hypothesis: '',
    surface: { kind: JOURNEY_SPLIT_SURFACE, ref: `journey-${n}` }, unit: 'contact', design: { type: 'ab' },
    arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'treatment', ref: null, weight: 50 }],
    mode: 'decide', status: 'running', salt: `salt-p3b-${n}`,
    epochs: [{ epoch: 0, weights: { control: 50, treatment: 50 }, at: '2026-01-01T00:00:00.000Z', reason: 'launch' }],
    createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}
/** A Decide plan on the split's primary metric (a click); launch needs it locked. */
const PLAN = { primaryMetric: { kind: 'conversion', name: 'click' }, baselineRate: 0.1, mde: 0.02, alpha: 0.05, power: 0.8, fdrQ: 0.05, minDays: 7, maxDays: 30 };
const contacts = (k: number): string[] => Array.from({ length: k }, (_, i) => `contact-${i}`);

describe('ADR 0949 P3b — 1. assignContactArm outside a run (pure, epoch frozen by the caller)', () => {
  it('the same arm on every pass under the frozen epoch, whatever changed since; no write; draft or unknown epoch is null', async () => {
    const e = experiment('t-p3b-1');
    await putExperimentRow(e);
    const pass1 = await Promise.all(contacts(300).map((c) => assignContactArm('t-p3b-1', { orgId: e.orgId, experimentId: e.experimentId, contactId: c, epoch: 0 })));
    // Re-weighted to all-treatment, then stopped, between passes.
    await putExperimentRow({ ...e, status: 'stopped', stoppedAt: '2026-02-01T00:00:00.000Z', epochs: [...e.epochs, { epoch: 1, weights: { treatment: 100 }, at: '2026-01-15T00:00:00.000Z', reason: 'optimize' }] });
    const before = (await getExperimentRow('t-p3b-1', e.orgId, e.experimentId))!.updatedAt;
    const pass2 = await Promise.all(contacts(300).map((c) => assignContactArm('t-p3b-1', { orgId: e.orgId, experimentId: e.experimentId, contactId: c, epoch: 0 })));
    expect(pass2.map((a) => a?.arm)).toEqual(pass1.map((a) => a?.arm));
    expect(pass2[0]).toMatchObject({ epoch: 0, status: 'stopped' });
    expect(new Set(pass1.map((a) => a?.arm))).toEqual(new Set(['control', 'treatment']));
    // Without an epoch: the launch epoch. Epoch 1 (all treatment) when asked for.
    expect((await assignContactArm('t-p3b-1', { orgId: e.orgId, experimentId: e.experimentId, contactId: 'contact-0' }))?.arm).toBe(pass1[0]?.arm);
    expect((await assignContactArm('t-p3b-1', { orgId: e.orgId, experimentId: e.experimentId, contactId: 'contact-0', epoch: 1 }))?.arm).toBe('treatment');
    expect((await getExperimentRow('t-p3b-1', e.orgId, e.experimentId))!.updatedAt).toBe(before);
    expect(await assignContactArm('t-p3b-1', { orgId: e.orgId, experimentId: e.experimentId, contactId: 'contact-0', epoch: 7 })).toBeNull();
    expect(contactArmAt(experiment('t', { status: 'draft', epochs: [] }), 'contact-0')).toBeNull();
    // Another org: the row is not found.
    expect(await assignContactArm('t-p3b-1', { orgId: 'org-other', experimentId: e.experimentId, contactId: 'contact-0' })).toBeNull();
  });
});

describe('ADR 0949 P3b — 1b. a ramp epoch assigns outside a run exactly as inside one', () => {
  it('contactArmAt reads the epoch\'s band layout, as runFreeze.assignAt does', () => {
    const layout = [{ key: 'control', weight: 25 }, { key: 'treatment', weight: 50 }, { key: 'control', weight: 25 }];
    const e = experiment('t-p3b-ramp', {
      epochs: [
        { epoch: 0, weights: { control: 50, treatment: 50 }, at: '2026-01-01T00:00:00.000Z', reason: 'launch' },
        { epoch: 1, weights: { control: 50, treatment: 50 }, at: '2026-01-02T00:00:00.000Z', reason: 'ramp', layout },
      ],
    });
    const asOf = '2026-01-03T00:00:00.000Z';
    let differsFromTotals = 0;
    for (const c of contacts(400)) {
      const outside = contactArmAt(e, c, 1);
      expect(outside?.arm).toBe(assignAt(e, c, asOf)!.arm.key);
      if (outside?.arm !== contactArmAt({ ...e, epochs: [e.epochs[0]!, { ...e.epochs[1]!, layout: undefined }] }, c, 1)?.arm) differsFromTotals += 1;
    }
    // The layout really moves contacts, so the equality above is not vacuous.
    expect(differsFromTotals).toBeGreaterThan(0);
  });
});

describe('ADR 0949 P3b — 2. bucketHoldout on the engine', () => {
  it('a non-engine id keeps the string-salted holdout byte-identical; an exp: id with Experiments OFF does too', async () => {
    const run = await stampedRun();
    const s = buildCampaignJourneysSurface({ tenantId: run.tenantId, runId: run.runId });
    for (const c of contacts(50)) {
      const legacy = holdoutArm(c, 'spring-promo', 20);
      expect(await s.bucketHoldout!({ contactId: c, experimentId: 'spring-promo', holdoutPct: 20 })).toEqual({ arm: legacy.arm, bucket: legacy.bucket, control: legacy.arm === 'control', treatment: legacy.arm === 'treatment' });
    }
    await setToggle('off');
    try {
      const off = holdoutArm('contact-1', 'exp:not-an-engine-row', 10);
      expect(await s.bucketHoldout!({ contactId: 'contact-1', experimentId: 'exp:not-an-engine-row', holdoutPct: 10, orgId: 'org-p3b' })).toMatchObject({ arm: off.arm, bucket: off.bucket });
    } finally {
      await setToggle('on');
    }
  });

  it('an engine experiment assigns at the run\'s frozen instant, needs orgId, and must be a journey split', async () => {
    const run = await stampedRun();
    expect(run.asOf).toBeTruthy();
    const e = experiment(run.tenantId);
    await putExperimentRow(e);
    const s = buildCampaignJourneysSurface({ tenantId: run.tenantId, runId: run.runId });
    for (const c of contacts(100)) {
      const out = await s.bucketHoldout!({ contactId: c, experimentId: e.experimentId, orgId: e.orgId });
      const expected = assignAt(e, c, run.asOf!)!.arm.key;
      expect(out).toMatchObject({ arm: expected, control: expected === 'control', treatment: expected !== 'control', assigned: true, epoch: 0, experimentId: e.experimentId });
    }
    await expect(s.bucketHoldout!({ contactId: 'c', experimentId: e.experimentId })).rejects.toMatchObject({ details: { reason: 'org_required' } });
    const cms = experiment(run.tenantId, { surface: { kind: 'cms.page', ref: 'p' } });
    await putExperimentRow(cms);
    await expect(s.bucketHoldout!({ contactId: 'c', experimentId: cms.experimentId, orgId: cms.orgId })).rejects.toMatchObject({ details: { reason: 'experiment_not_found' } });
    // The org is bound to the run like every journey verb: a run stamped for
    // another client cannot read this client's split.
    const foreign = `run-p3b-foreign-${n++}`;
    const source = (await storage.getRun(run.runId))!;
    await storage.insertRun({ ...source, runId: foreign, metadata: { ...(source.metadata as Record<string, unknown>), campaignOrchestration: { campaignId: 'cmp_p3b', orgId: 'org-other', goalVersion: 0 } } });
    await expect(buildCampaignJourneysSurface({ tenantId: run.tenantId, runId: foreign }).bucketHoldout!({ contactId: 'c', experimentId: e.experimentId, orgId: e.orgId }))
      .rejects.toMatchObject({ details: { reason: 'wrong_client' } });
    // No run (or an unstamped one): not in the test.
    const loose = buildCampaignJourneysSurface({ tenantId: run.tenantId });
    expect(await loose.bucketHoldout!({ contactId: 'c', experimentId: e.experimentId, orgId: e.orgId })).toMatchObject({ arm: 'control', control: true, assigned: false });
  });
});

describe('ADR 0949 P3b — 3. the journey.split adapter', () => {
  it('contact units, two content-free arms, one running split per journey', async () => {
    const tenantId = `t-p3b-a-${n++}`;
    const adapter = experimentSurface(JOURNEY_SPLIT_SURFACE)!;
    expect(adapter.unit).toBe('contact');
    expect(adapter.supportedMetrics).toEqual(['unsubscribe', 'complaint', 'hard_bounce']);
    const arms = [{ key: 'control', ref: null, weight: 50 }, { key: 'treatment', ref: null, weight: 50 }];
    const d = await createDraft(tenantId, 'org-a', 'u', { name: 'Welcome split', surface: { kind: JOURNEY_SPLIT_SURFACE, ref: 'welcome' }, arms });
    expect(d.unit).toBe('contact');
    await expect(createDraft(tenantId, 'org-a', 'u', { name: 'x', surface: { kind: JOURNEY_SPLIT_SURFACE, ref: 'welcome' }, arms: [...arms, { key: 'c', ref: null, weight: 0 }] })).rejects.toMatchObject({ details: { field: 'arms' } });
    await expect(createDraft(tenantId, 'org-a', 'u', { name: 'x', surface: { kind: JOURNEY_SPLIT_SURFACE, ref: 'welcome' }, arms: [arms[0], { key: 'treatment', ref: 'page-1', weight: 50 }] })).rejects.toMatchObject({ details: { field: 'arms' } });
    await lockPlan(tenantId, 'org-a', d.experimentId, PLAN);
    await launch(tenantId, 'org-a', d.experimentId, 'u');
    const d2 = await createDraft(tenantId, 'org-a', 'u', { name: 'Second', surface: { kind: JOURNEY_SPLIT_SURFACE, ref: 'welcome' }, arms });
    await lockPlan(tenantId, 'org-a', d2.experimentId, PLAN);
    await expect(launch(tenantId, 'org-a', d2.experimentId, 'u')).rejects.toMatchObject({ details: { reason: 'surface_busy' } });
  });

  it('observe re-derives the arm the split routed; a click converts, an open never does; guardrails count after exposure', async () => {
    const run = await stampedRun();
    const tenantId = run.tenantId;
    const e = experiment(tenantId, { surface: { kind: JOURNEY_SPLIT_SURFACE, ref: `welcome-${n++}` } });
    await putExperimentRow(e);
    const s = buildCampaignJourneysSurface({ tenantId, runId: run.runId });
    const routed = new Map<string, string>();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await createContact({ tenantId, name: `C${i}`, email: `p3b-${n}-${i}@acme.test` } as never);
      ids.push(c.contactId);
      await enroll(tenantId, e.surface.ref, c.contactId, run.runId);
      routed.set(c.contactId, String((await s.bucketHoldout!({ contactId: c.contactId, experimentId: e.experimentId, orgId: e.orgId })).arm));
    }
    // contact 0 clicks; contact 1 only opens; contact 2 unsubscribes and complains.
    await recordClick(await mintToken({ tenantId, campaignId: 'cmp', contactId: ids[0]!, kind: 'click', url: 'https://acme.test/x' }));
    await recordOpen(await mintToken({ tenantId, campaignId: 'cmp', contactId: ids[1]!, kind: 'open' }));
    await addSuppression(tenantId, `p3b-${n}-2@acme.test`, 'complaint', 'test');
    const obs = await experimentSurface(JOURNEY_SPLIT_SURFACE)!.observe(e);
    expect(obs.units).toHaveLength(4);
    // Units carry no contact id, so match them by arm and outcome.
    expect(obs.units.map((u) => u.arm).sort()).toEqual(ids.map((id) => routed.get(id)!).sort());
    const converted = obs.units.filter((u) => u.converted);
    expect(converted).toHaveLength(1); // the click; the open does not count
    expect(converted[0]!.arm).toBe(routed.get(ids[0]!));
    const complained = obs.units.filter((u) => u.metrics?.complaint === 1);
    expect(complained).toHaveLength(1);
    expect(complained[0]!.arm).toBe(routed.get(ids[2]!));
    expect(obs.units.every((u) => u.metrics?.hard_bounce === 0 && u.metrics?.unsubscribe === 0)).toBe(true);
  });

  it('observe counts only its own client: another client\'s enrollments in a journey with the same id are not units', async () => {
    const run = await stampedRun();
    const tenantId = run.tenantId;
    const orgA = (await createOrg({ tenantId, createdBy: 'seed', name: 'Client A (synthetic)' })).orgId;
    const orgB = (await createOrg({ tenantId, createdBy: 'seed', name: 'Client B (synthetic)' })).orgId;
    await createClient({ tenantId, orgId: orgA, name: 'Client A (synthetic)', createdBy: 'seed' });
    await createClient({ tenantId, orgId: orgB, name: 'Client B (synthetic)', createdBy: 'seed' });
    const journeyId = `welcome-shared-${n++}`;
    const e = experiment(tenantId, { orgId: orgA, surface: { kind: JOURNEY_SPLIT_SURFACE, ref: journeyId } });
    await putExperimentRow(e);
    const a = await createContact({ tenantId, name: 'In A', email: `p3b-a-${n}@acme.test` } as never);
    const b = await createContact({ tenantId, name: 'In B', email: `p3b-b-${n}@acme.test` } as never);
    await enroll(tenantId, journeyId, a.contactId, run.runId, { orgId: orgA });
    await enroll(tenantId, journeyId, b.contactId, run.runId, { orgId: orgB });
    expect((await experimentSurface(JOURNEY_SPLIT_SURFACE)!.observe(e)).units).toHaveLength(1);
  });
});

describe('ADR 0949 P3b — 4. the journey split node', () => {
  it('passes orgId through to bucketHoldout', async () => {
    const pack = (await import(new URL('../../../packs/feature.campaign-journeys.nodes/index.mjs', import.meta.url).href)) as { split: (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }> };
    const seen: Array<Record<string, unknown>> = [];
    const ctx = { inputs: { contactId: 'c1', experimentId: 'exp:x', orgId: 'org-1' }, features: { 'campaign-journeys': { enroll: async () => ({}), checkEligibility: async () => ({}), bucketHoldout: async (a: Record<string, unknown>) => { seen.push(a); return { arm: 'control', control: true, treatment: false }; } } } };
    expect((await pack.split(ctx)).status).toBe('success');
    expect(seen[0]).toMatchObject({ contactId: 'c1', experimentId: 'exp:x', orgId: 'org-1' });
  });
});
