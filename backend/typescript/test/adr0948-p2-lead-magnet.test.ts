/**
 * ADR 0948 P2 — the first real funnel blueprint, `funnels.blueprint.lead-magnet`
 * (opt-in → thank you), run end to end through the generate route: the shipped
 * chain pack, the real loader, the real scheduler, both `funnels.step.*` sub-chains
 * as child runs, and the real CMS, forms and funnels surfaces. The only stand-in is
 * the model (`callAI`), which answers per output schema.
 *
 * Legs:
 *  1. Exit "shows in /builder and the / picker": the blueprint is listed by the
 *     generate lane with its own parameters (its sub-chains are not), and the
 *     gallery's from-chain instantiates it into a tenant-owned workflow.
 *  2. Exit "run reaches the gate with a draft funnel": generate drafts one opt-in
 *     page (hero, bullets, the CALLER's form) and one thank-you page, submits both
 *     for review (nothing published), and creates ONE draft funnel linked to the
 *     campaign whose steps are [optin, thankyou] on those pages.
 *  3. The opt-in form is checked against the org's own forms: another org's form
 *     fails the run `form_not_found`, and no funnel is created.
 *  4. Model output that stays invalid after the one repair fails the run
 *     (`structured_output_invalid`): no page, no funnel.
 *  5. Nested replay (the ADR's P2 leg): a replay fork of a completed run drafts no
 *     second page and mints no second funnel.
 *
 * Sabotage-witnessed (each alone turns a leg red): compose-step-page taking the
 * opt-in form unchecked (3); step-result not writing the variable bag (2 and 5,
 * `step_missing`); the chains' `retryOnInvalidJson` raised from 1 to 2 (4, by the
 * call count). Not witnessed here: collect-steps' own `step_missing` guard (a failed
 * child fails the parent before collect-steps runs), and the replay leg's dependence
 * on create-draft-page being `side-effect` (that role is the P1 test's witness).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiCallRequest, AiCallResult } from '../src/executor/types.js';

const ai = vi.hoisted(() => ({ mode: 'good' as 'good' | 'bad', calls: [] as AiCallRequest[] }));
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
          const props = Object.keys(((req as { responseSchema?: { properties?: object } }).responseSchema?.properties) ?? {});
          if (ai.mode === 'bad') return { content: '', data: { headline: 42 } } as AiCallResult;
          if (props.includes('formHeading')) {
            return { content: '', data: { headline: 'Get the free watercolor starter guide', subheadline: 'For beginners who want their first painting this week.', bullets: ['Which 5 paints to buy', 'Three warm-up exercises'], formHeading: 'Send me the guide' } } as AiCallResult;
          }
          return { content: '', data: { headline: 'You are in', message: 'The guide is on its way to your inbox.', nextSteps: ['Open the email', 'Try the first exercise'] } } as AiCallResult;
        },
      };
    }) as typeof actual.createAiProvidersAdapter,
  };
});

import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { createBrief, updateBrief } from '../src/features/campaign-brief/briefService.js';
import { createForm } from '../src/features/forms/formsService.js';
import { listFunnels } from '../src/features/funnels/funnelsService.js';
import { listPages, getPage } from '../src/features/cms/cmsService.js';
import { toWireRunId } from '../src/host/v2Ids.js';

let BASE = '';
let close: () => Promise<void>;
let n = 0;
const H = '/host/openwop-app';
const BLUEPRINT = 'funnels.blueprint.lead-magnet';

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; close = h.close;
  delete process.env.OPENWOP_DEMO_MODE;
  for (const id of ['users', 'funnels', 'cms', 'campaign-brief', 'forms']) await enableToggle(id, 'on');
});
afterAll(async () => { await close(); });

async function team() {
  const tenantId = `org:p2-${Date.now()}-${n++}`;
  const owner = makeClient(() => BASE);
  const ownerId = (await owner.post(`${H}/test/login`, { email: uniqEmail('p2-o'), tenantId })).body.user.userId as string;
  const orgA = (await owner.post(`${H}/orgs`, { name: 'Client A' })).body.orgId as string;
  const orgB = (await owner.post(`${H}/orgs`, { name: 'Client B' })).body.orgId as string;
  const brief = await createBrief(tenantId, orgA, ownerId, { name: 'Watercolor guide', productName: 'Starter guide' } as never);
  await updateBrief(tenantId, brief.id, { status: 'confirmed' } as never);
  const fields = [{ key: 'email', label: 'Email', type: 'email', required: true }];
  const formA = await createForm({ tenantId, orgId: orgA, title: 'Guide sign-up', fields, createdBy: ownerId });
  const formB = await createForm({ tenantId, orgId: orgB, title: 'Other client form', fields, createdBy: ownerId });
  return { tenantId, owner, ownerId, orgA, orgB, briefId: brief.id, formA: formA.formId, formB: formB.formId };
}
const gen = (c: Client, orgId: string, body: Record<string, unknown>) => c.post(`${H}/funnels/orgs/${encodeURIComponent(orgId)}/generate`, body);

/** A step sub-chain's failure reaches the parent as `subworkflow_child_failed`; the
 *  typed refusal is on the child run, which the parent's error names. */
async function childError(c: Client, tenantId: string, parentError: unknown): Promise<string> {
  const child = /child run (\S+) terminated/.exec(JSON.stringify(parentError))?.[1];
  expect(child, JSON.stringify(parentError)).toBeTruthy();
  return JSON.stringify((await c.get(`/runs/${toWireRunId(child!, tenantId)}`)).body?.error);
}

async function settle(c: Client, tenantId: string, runId: string): Promise<{ status: string; error?: unknown }> {
  const wire = toWireRunId(runId, tenantId);
  // A run has no settle hook to await: poll its status until terminal.
  await vi.waitFor(async () => { expect(['completed', 'failed', 'cancelled']).toContain((await c.get(`/runs/${wire}`)).body?.status); }, { timeout: 20_000, interval: 100 });
  return (await c.get(`/runs/${wire}`)).body as { status: string; error?: unknown };
}

describe('ADR 0948 P2 — the lead-magnet blueprint', () => {
  it('is listed with its own parameters (sub-chains are not) and instantiates through from-chain', async () => {
    const t = await team();
    const list = await t.owner.get(`${H}/funnels/orgs/${encodeURIComponent(t.orgA)}/blueprints`);
    expect(list.status).toBe(200);
    const ids = (list.body.blueprints as Array<{ chainId: string }>).map((b) => b.chainId);
    expect(ids).toContain(BLUEPRINT);
    expect(ids.filter((id) => id.startsWith('funnels.step.'))).toEqual([]);
    const bp = (list.body.blueprints as Array<{ chainId: string; parameters: { required: string[] } }>).find((b) => b.chainId === BLUEPRINT)!;
    expect(bp.parameters.required).toEqual(expect.arrayContaining(['orgId', 'briefId', 'formId', 'name']));

    const inst = await t.owner.post(`${H}/workflows/from-chain`, { chainId: BLUEPRINT, params: { orgId: t.orgA, briefId: t.briefId, formId: t.formA, name: 'Gallery copy' } });
    expect(inst.status, JSON.stringify(inst.body)).toBe(201);
    expect(inst.body.warnings ?? [], 'every typeId in the blueprint and its sub-chains must resolve on this host').toEqual([]);
    const owned = await t.owner.get(`${H}/workflows`);
    expect(JSON.stringify(owned.body)).toContain(inst.body.workflowId as string);
  });

  it('drafts and submits both pages and creates ONE draft funnel on them; nothing is published', async () => {
    const t = await team();
    ai.mode = 'good';
    const r = await gen(t.owner, t.orgA, { blueprintId: BLUEPRINT, briefId: t.briefId, params: { formId: t.formA, name: 'Spring guide' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const final = await settle(t.owner, t.tenantId, r.body.runId as string);
    expect(final.status, JSON.stringify(final.error)).toBe('completed');

    const funnels = await listFunnels(t.tenantId, t.orgA);
    expect(funnels.map((f) => [f.name, f.status])).toEqual([['Spring guide', 'draft']]);
    const steps = funnels[0]!.steps;
    expect(steps.map((s) => s.kind)).toEqual(['optin', 'thankyou']);

    const optin = await getPage(t.tenantId, t.orgA, steps[0]!.pageId);
    const thanks = await getPage(t.tenantId, t.orgA, steps[1]!.pageId);
    expect(optin?.title).toBe('Get the free watercolor starter guide');
    expect(optin?.sections.map((s) => s.type)).toEqual(['hero', 'richText', 'form']);
    expect(optin?.sections.find((s) => s.type === 'form')?.data).toMatchObject({ formId: t.formA, heading: 'Send me the guide' });
    expect(thanks?.title).toBe('You are in');
    // Both pages were submitted for review; neither is live.
    for (const p of [optin, thanks]) expect(p?.status).toBe('in_review');
    expect((await listPages(t.tenantId, t.orgA)).filter((p) => p.status === 'published')).toEqual([]);
  });

  it('refuses a form that is not one of this client\'s forms: the run fails form_not_found, no funnel', async () => {
    const t = await team();
    ai.mode = 'good';
    const r = await gen(t.owner, t.orgA, { blueprintId: BLUEPRINT, briefId: t.briefId, params: { formId: t.formB, name: 'Wrong form' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const final = await settle(t.owner, t.tenantId, r.body.runId as string);
    expect(final.status).toBe('failed');
    expect(await childError(t.owner, t.tenantId, final.error)).toContain('form_not_found');
    expect(await listFunnels(t.tenantId, t.orgA)).toEqual([]);
    expect(JSON.stringify(await listPages(t.tenantId, t.orgA))).not.toContain(t.formB);
  });

  it('model output still invalid after the one repair fails the run: no page, no funnel', async () => {
    const t = await team();
    ai.mode = 'bad';
    const before = ai.calls.length;
    const r = await gen(t.owner, t.orgA, { blueprintId: BLUEPRINT, briefId: t.briefId, params: { formId: t.formA, name: 'Bad copy' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const final = await settle(t.owner, t.tenantId, r.body.runId as string);
    ai.mode = 'good';
    expect(final.status).toBe('failed');
    expect(await childError(t.owner, t.tenantId, final.error)).toContain('structured_output_invalid');
    // One call plus ONE repair, then a typed failure.
    expect(ai.calls.length - before).toBe(2);
    expect(await listFunnels(t.tenantId, t.orgA)).toEqual([]);
    expect(await listPages(t.tenantId, t.orgA)).toEqual([]);
  });

  it('a replay fork drafts no second page and mints no second funnel (nested create-draft-page)', async () => {
    const t = await team();
    ai.mode = 'good';
    const r = await gen(t.owner, t.orgA, { blueprintId: BLUEPRINT, briefId: t.briefId, params: { formId: t.formA, name: 'Replay me' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await settle(t.owner, t.tenantId, r.body.runId as string)).status).toBe('completed');
    const pages = (await listPages(t.tenantId, t.orgA)).map((p) => p.pageId).sort();
    const funnels = (await listFunnels(t.tenantId, t.orgA)).map((f) => f.funnelId);
    expect(pages).toHaveLength(2);
    expect(funnels).toHaveLength(1);

    const wire = toWireRunId(r.body.runId as string, t.tenantId);
    const fork = await t.owner.post(`/runs/${wire}:fork`, { mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    const forked = (fork.body as { runId: string }).runId;
    const fin = await vi.waitFor(async () => {
      const s = (await t.owner.get(`/runs/${forked}`)).body as { status: string; error?: unknown };
      expect(['completed', 'failed', 'cancelled']).toContain(s.status);
      return s;
    }, { timeout: 20_000, interval: 100 });
    expect(fin.status, JSON.stringify(fin.error)).toBe('completed');
    expect((await listPages(t.tenantId, t.orgA)).map((p) => p.pageId).sort(), 'a replay fork drafted another page').toEqual(pages);
    expect((await listFunnels(t.tenantId, t.orgA)).map((f) => f.funnelId), 'a replay fork minted another funnel').toEqual(funnels);
  });
});
