/**
 * ADR 0948 (Q3: second) — the tripwire blueprint, `funnels.blueprint.tripwire`:
 * sales → checkout (+ bump) → upsell → downsell → thank you, through five step
 * sub-chains, generated end to end over the generate route (only `callAI` stubbed).
 *
 * Legs:
 *  1. Listed beside lead-magnet (its sub-chains are not); from-chain instantiates it.
 *  2. Generate drafts five pages, submits each for review, and creates ONE draft funnel
 *     whose steps are [sales, checkout, upsell, downsell, thankyou] with fixed stepIds,
 *     the offers built from the caller's product ids (checkout: product + bump; upsell
 *     and downsell: one-click), and the blueprint's routing (upsell accepted → thank
 *     you) — so the P2c viewer sells it and routes on the buyer's decision.
 *  3. Another client's product is refused when the funnel is written: the run fails
 *     and no funnel exists (offers are org-checked by the funnels write, not trusted).
 *
 * Sabotage-witnessed: collect-steps dropping `offer` or `routing`, step-result
 * dropping `stepId`, and the bump wired to the upsell each turn leg 2 red.
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
          if (props.includes('nextSteps')) {
            return { content: '', data: { headline: 'You are in', message: 'The guide is on its way to your inbox.', nextSteps: ['Open the email', 'Try the first exercise'] } } as AiCallResult;
          }
          return { content: '', data: { headline: 'Paint your first landscape', subheadline: 'A short course for beginners.', bullets: ['Five lessons', 'A printable palette'] } } as AiCallResult;
        },
      };
    }) as typeof actual.createAiProvidersAdapter,
  };
});

import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { createBrief, updateBrief } from '../src/features/campaign-brief/briefService.js';
import { listFunnels } from '../src/features/funnels/funnelsService.js';
import { getPage } from '../src/features/cms/cmsService.js';
import { toWireRunId } from '../src/host/v2Ids.js';

let BASE = '';
let close: () => Promise<void>;
let n = 0;
const H = '/host/openwop-app';
const BLUEPRINT = 'funnels.blueprint.tripwire';

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; close = h.close;
  delete process.env.OPENWOP_DEMO_MODE;
  for (const id of ['users', 'funnels', 'cms', 'campaign-brief', 'commerce']) await enableToggle(id, 'on');
});
afterAll(async () => { await close(); });

async function team() {
  const tenantId = `org:tw-${Date.now()}-${n++}`;
  const owner = makeClient(() => BASE);
  const ownerId = (await owner.post(`${H}/test/login`, { email: uniqEmail('tw-o'), tenantId })).body.user.userId as string;
  const orgA = (await owner.post(`${H}/orgs`, { name: 'Client A' })).body.orgId as string;
  const orgB = (await owner.post(`${H}/orgs`, { name: 'Client B' })).body.orgId as string;
  const brief = await createBrief(tenantId, orgA, ownerId, { name: 'Landscape course', productName: 'Course' } as never);
  await updateBrief(tenantId, brief.id, { status: 'confirmed' } as never);
  const product = async (orgId: string, name: string, price: number): Promise<string> => {
    const r = await owner.post(`${H}/commerce/orgs/${encodeURIComponent(orgId)}/products`, { type: 'digital', name, price, currency: 'USD' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.productId as string;
  };
  const p = { entry: await product(orgA, 'Starter course', 7), bump: await product(orgA, 'Palette', 3), up: await product(orgA, 'Full course', 97), down: await product(orgA, 'Mini course', 27), foreign: await product(orgB, 'Other client', 9) };
  return { tenantId, owner, orgA, briefId: brief.id, p };
}
const gen = (c: Client, orgId: string, body: Record<string, unknown>) => c.post(`${H}/funnels/orgs/${encodeURIComponent(orgId)}/generate`, body);
async function settle(c: Client, tenantId: string, runId: string): Promise<{ status: string; error?: unknown }> {
  const wire = toWireRunId(runId, tenantId);
  await vi.waitFor(async () => { expect(['completed', 'failed', 'cancelled']).toContain((await c.get(`/runs/${wire}`)).body?.status); }, { timeout: 30_000, interval: 100 });
  return (await c.get(`/runs/${wire}`)).body as { status: string; error?: unknown };
}

describe('ADR 0948 — the tripwire blueprint', () => {
  it('is listed (its sub-chains are not) and instantiates through from-chain', async () => {
    const t = await team();
    const list = await t.owner.get(`${H}/funnels/orgs/${encodeURIComponent(t.orgA)}/blueprints`);
    const ids = (list.body.blueprints as Array<{ chainId: string }>).map((b) => b.chainId);
    expect(ids).toEqual(expect.arrayContaining([BLUEPRINT, 'funnels.blueprint.lead-magnet']));
    expect(ids.filter((id) => id.startsWith('funnels.step.'))).toEqual([]);
    const inst = await t.owner.post(`${H}/workflows/from-chain`, { chainId: BLUEPRINT, params: { orgId: t.orgA, briefId: t.briefId, name: 'Gallery copy', productId: t.p.entry, upsellProductId: t.p.up, downsellProductId: t.p.down } });
    expect(inst.status, JSON.stringify(inst.body)).toBe(201);
    expect(inst.body.warnings ?? []).toEqual([]);
  });

  it('drafts five pages in review and ONE draft funnel with stepIds, offers and the upsell routing', async () => {
    const t = await team();
    const r = await gen(t.owner, t.orgA, { blueprintId: BLUEPRINT, briefId: t.briefId, params: { name: 'Landscape tripwire', productId: t.p.entry, bumpProductId: t.p.bump, upsellProductId: t.p.up, downsellProductId: t.p.down } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const final = await settle(t.owner, t.tenantId, r.body.runId as string);
    expect(final.status, JSON.stringify(final.error)).toBe('completed');
    const funnels = await listFunnels(t.tenantId, t.orgA);
    expect(funnels.map((f) => [f.name, f.status])).toEqual([['Landscape tripwire', 'draft']]);
    const steps = funnels[0]!.steps;
    expect(steps.map((s) => [s.stepId, s.kind])).toEqual([['sales', 'sales'], ['checkout', 'checkout'], ['upsell', 'upsell'], ['downsell', 'downsell'], ['thankyou', 'thankyou']]);
    expect(steps[0]!.offer).toBeUndefined();
    expect(steps[1]!.offer).toEqual({ productIds: [t.p.entry], bumpProductIds: [t.p.bump] });
    expect(steps[2]!.offer).toEqual({ productIds: [t.p.up], oneClickProductId: t.p.up });
    expect(steps[3]!.offer).toEqual({ productIds: [t.p.down], oneClickProductId: t.p.down });
    expect(steps[2]!.routing).toEqual([{ when: { outcome: 'accepted' }, goto: 'thankyou' }]);
    for (const s of steps) {
      const pg = await getPage(t.tenantId, t.orgA, s.pageId);
      expect(pg?.status, s.stepId).toBe('in_review');
      // Copy only: no price or product id reaches a page (the viewer sells from the offer).
      expect(JSON.stringify(pg?.sections)).not.toMatch(/\$|productId|prod[_:]/);
    }
  });

  it('another client\'s product is refused when the funnel is written: the run fails, no funnel', async () => {
    const t = await team();
    const r = await gen(t.owner, t.orgA, { blueprintId: BLUEPRINT, briefId: t.briefId, params: { name: 'Wrong product', productId: t.p.entry, upsellProductId: t.p.foreign, downsellProductId: t.p.down } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const fin = await settle(t.owner, t.tenantId, r.body.runId as string); expect(fin.status).toBe('failed'); // The funnels write refuses it (coerceOffer: an offered product must be this org's).
    expect(JSON.stringify(fin.error)).toMatch(/not_found.*Offer/);
    expect(await listFunnels(t.tenantId, t.orgA)).toEqual([]);
  });
});
