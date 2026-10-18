/**
 * UX_UPGRADE-production ROUND 2 — PROD2-B1 / PROD2-B2.
 *
 * R1 for this feature graded ONE file (the page) and declared plan generation
 * "the correct pattern [that] stays untouched". The workflow surface it excused
 * had no org authorization at all.
 *
 * `surface.ts`'s own docblock said tenant comes from the run scope and "the
 * SERVICE enforces the tenant+org key (CTI-1) — a cross-tenant id is not found".
 * That is cross-TENANT protection, and it was silently doing duty as
 * authorization. It is not the same thing: a same-tenant member of org A
 * resolves to ZERO scopes in org B, so every REST route and both chat tools
 * already refused them there — while `POST /v1/runs {orgId: "<org B>"}` reached
 * this surface with no org check, read org B's vendors into a model prompt, and
 * WROTE a plan row into org B. Run-create gates on tenant + `runs:create` and
 * nothing else, and the chain-backed workflow resolves for any tenant, so no
 * workflow authoring was needed.
 *
 * These drive the SURFACE directly — the seam the run lane actually reaches.
 * The REST routes were already correct and their tests already passed, which is
 * exactly why this went unseen.
 *
 * w32 (grade-tests):
 *  - The non-member READ refusals are DOUBLE-guarded: the ADR 0832 seam org floor
 *    (`featureSurfaces.ts` `orgFloor`, `workspace:read`) refuses a non-member before
 *    `requireScope` runs, so disabling `requireScope` alone leaves them red-proof.
 *    `requireScope` is the ONLY guard on the WRITE scope — a read-only member passes
 *    the floor — so a viewer-of-org-B savePlan case now witnesses it.
 *  - The PROD2-R4 control stubbed `callAI` → `{ content }`, but the node reads
 *    `ai.data`, so it returned `failed / generation_empty` and the control passed
 *    with nothing generated. It now returns `{ data }` and reads the plan back.
 *  - The PROD2-R1 case (never touched the route guard it named) is cut: covered by
 *    `production-route.test.ts` "an editor’s PATCH carrying priceRanges leaves the
 *    stored rates alone" + "an ADMIN can still change them" (probes
 *    w32g1-sa-updatevendor-pr / w32g1-rt-updatevendor-pr both red). The PROD2-R2
 *    currency case is cut: both legs live in `production-plan-reject-invalid.test.ts` T6.
 *  - PIC-8 (BLOCKED-ON-PRODUCT, `it.fails`): the node builds the `production.plan`
 *    ARTIFACT from the RAW model output, so the PIC-1 vendor drop and the PROD2-R2
 *    currency normalisation reach the durable row but not the artifact the chat
 *    renders. Flip to `it` when the payload is built from the saved plan.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { createVendor, getPlan } from '../src/features/production/productionService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const TENANT = 'org:prod-authz';
const MEMBER_A = 'u-a';   // member of org A only
const MEMBER_B = 'u-b';   // member of org B, with write
const ADMIN_B = 'u-b-admin'; // org B admin — holds host:members:manage, so entitled to see rates
const VIEWER_B = 'u-b-viewer'; // org B read-only member: passes the read floor, lacks workspace:write

let server: http.Server;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  const d = getToggleDefault('production');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');

  orgA = (await createOrg({ tenantId: TENANT, name: 'Alpha', createdBy: MEMBER_A })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, name: 'Beta', createdBy: MEMBER_B })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: MEMBER_A, displayName: 'A', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgB, subject: MEMBER_B, displayName: 'B', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgB, subject: ADMIN_B, displayName: 'BA', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: orgB, subject: VIEWER_B, displayName: 'BV', roles: ['viewer'] });

  // Org B holds a vendor whose NAME and rates are org-B business data.
  await createVendor({
    tenantId: TENANT, orgId: orgB, name: 'Beta Secret Studio', type: 'agency',
    contractStatus: 'preferred', createdBy: MEMBER_B,
    capabilities: [{ name: 'Landing page design', category: 'design', qualityRating: 5 }],
    priceRanges: [{ capability: 'Landing page design', min: 4000, max: 9000, unit: 'per-project' }],
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The surface as a run owned by `actingUserId` would see it. */
const surfaceFor = (actingUserId?: string) =>
  buildHostSurfaceBundle({ tenantId: TENANT, ...(actingUserId ? { actingUserId } : {}), runId: 'run-1' })
    .features.production as Record<string, (a: Record<string, unknown>) => Promise<Record<string, unknown>>>;

describe('PROD2-B1 — the run lane enforces the run owner’s org RBAC', () => {
  it('refuses a same-tenant NON-MEMBER of the target org on every read', async () => {
    const s = surfaceFor(MEMBER_A);
    for (const [verb, args] of [
      ['buildContext', { orgId: orgB, channels: ['landing_page'] }],
      ['listVendors', { orgId: orgB }],
      ['getVendor', { orgId: orgB, vendorId: 'v-1' }],
      ['listPlans', { orgId: orgB }],
      ['getPlan', { orgId: orgB, planId: 'p-1' }],
    ] as const) {
      await expect(s[verb]!(args as Record<string, unknown>), `${verb} must refuse a non-member`)
        .rejects.toMatchObject({ code: 'forbidden_scope' });
    }
  });

  it('refuses the WRITE — a plan can no longer be planted in another org', async () => {
    // The sharpest half: `savePlan` wrote a row into org B that every org-B
    // member then saw at /production?tab=plans, with attacker-influenced
    // summary and rationale text.
    const s = surfaceFor(MEMBER_A);
    await expect(s.savePlan!({
      orgId: orgB, strategySummary: 'planted', recommendations: [], totalBudget: {}, timeline: {},
    })).rejects.toMatchObject({ code: 'forbidden_scope' });
  });

  it('refuses a READ-ONLY member of the target org the WRITE (savePlan needs workspace:write)', async () => {
    // The seam's org floor asks only `workspace:read`, so a viewer passes it —
    // `requireScope(…, 'workspace:write')` is the one guard on this leg.
    const s = surfaceFor(VIEWER_B);
    const vendors = await s.listVendors!({ orgId: orgB });
    expect((vendors.vendors as Array<{ name: string }>).map((v) => v.name), 'the viewer may read').toContain('Beta Secret Studio');
    await expect(s.savePlan!({ orgId: orgB, strategySummary: 'viewer plan', recommendations: [] }))
      .rejects.toMatchObject({ code: 'forbidden_scope', message: expect.stringContaining('workspace:write') });
  });

  it('refuses a SYSTEM run with no acting user (fail-closed)', async () => {
    const s = surfaceFor(undefined);
    await expect(s.listVendors!({ orgId: orgB }))
      .rejects.toMatchObject({ code: 'forbidden_scope', message: expect.stringMatching(/acting user/) });
  });

  it('ALLOWS a real member of that org (the negative control)', async () => {
    // Without this, "refuses everything" would pass while breaking the feature.
    const s = surfaceFor(MEMBER_B);
    const out = await s.listVendors!({ orgId: orgB });
    expect((out.vendors as Array<{ name: string }>).map((v) => v.name)).toContain('Beta Secret Studio');
    const saved = await s.savePlan!({ orgId: orgB, strategySummary: 'member plan', recommendations: [] });
    const planId = (saved.plan as { planId: string }).planId;
    const plans = await s.listPlans!({ orgId: orgB });
    expect((plans.plans as Array<{ planId: string }>).map((p) => p.planId), 'the member\'s write is readable back').toContain(planId);
  });
});

describe('PROD2-B2 — the budget the model is asked to ground has rates to ground on', () => {
  it('puts entitled price ranges into the prompt context', async () => {
    // The node's prompt says "recommend … with a budget estimate" and "Ground
    // every recommendation in the provided context" — and the context carried
    // no pricing at all, because `rankVendor` never read `priceRanges`. Every
    // min/max the model emitted was invented, then sanitised, AJV-validated,
    // persisted and rendered as a plain number range.
    const s = surfaceFor(ADMIN_B);
    const ctx = await s.buildContext!({ orgId: orgB, channels: ['landing_page'] });
    expect(String(ctx.vendorSectionPriced)).toContain('Beta Secret Studio');
    expect(String(ctx.vendorSectionPriced), 'the rates must reach the prompt').toContain('4000-9000');
    // PROD2-R3 — and NOT the recordable projection, which a node echoes into
    // the tenant-scoped run event log where any viewer could read it back.
    expect(String(ctx.vendorSection), 'the recordable section stays priceless').not.toContain('4000-9000');
  });

  it('withholds them from a caller who may not see pricing (the control)', async () => {
    // Entitlement is the SAME predicate the REST face and the chat tool use
    // (`canSeeVendorPricing` → `host:members:manage`). An `editor` sees the
    // vendor and NOT the rate — and the line says nothing at all rather than
    // "no pricing on file", because claiming a vendor has no rates when it has
    // rates you may not see would be a different lie.
    const s = surfaceFor(MEMBER_B);
    const ctx = await s.buildContext!({ orgId: orgB, channels: ['landing_page'] });
    for (const section of [String(ctx.vendorSection), String(ctx.vendorSectionPriced)]) {
      expect(section, 'the vendor is still ranked').toContain('Beta Secret Studio');
      expect(section, 'the rate is withheld').not.toContain('4000-9000');
      expect(section).not.toContain('no pricing on file');
    }
  });
});

describe('PROD2-R4 — a system run SKIPS honestly instead of failing the spine', () => {
  it('plan-generate returns skipped:true when the surface refuses for want of an acting user', async () => {
    // PROD2-B1 made the surface fail-closed for runs with no acting user, and
    // `planGenerate`'s buildContext call sits OUTSIDE its try/catch — so an
    // inbound webhook (a genuine system run) would have thrown and failed the
    // node, taking the campaign spine down with it. That is exactly the failure
    // the node's own "ADR 0356 P1 — spine-slottable: SKIP honestly instead of
    // failing the whole campaign run" note exists to prevent; the new gate
    // recreated it, with no reason surfaced to the operator.
    const pack = await import('../../../packs/feature.production.nodes/index.mjs') as {
      planGenerate: (c: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: unknown }>;
    };
    const features = buildHostSurfaceBundle({ tenantId: TENANT, runId: 'run-sys' }).features;
    const out = await pack.planGenerate({
      inputs: { orgId: orgB, channels: ['landing_page'] },
      features,
      callAI: async () => ({ content: '{}' }),
    });
    expect(out.status, 'the run must not fail').toBe('success');
    expect(out.outputs?.skipped).toBe(true);
    expect(String(out.outputs?.reason), 'the reason names the real cause').toMatch(/acting user/i);
  });

  it('…and a run WITH an entitled acting user still generates (the control)', async () => {
    // Without this, "skips" is satisfied by a node that never does anything.
    const pack = await import('../../../packs/feature.production.nodes/index.mjs') as {
      planGenerate: (c: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: unknown }>;
    };
    const features = buildHostSurfaceBundle({ tenantId: TENANT, actingUserId: ADMIN_B, runId: 'run-ok' }).features;
    const out = await pack.planGenerate({
      inputs: { orgId: orgB, channels: ['landing_page'] },
      features,
      // The node reads `ai.data` (the schema-constrained object), not `content`.
      callAI: async () => ({ data: { strategySummary: 'entitled plan', recommendations: [] } }),
    });
    expect(out.status, JSON.stringify(out.error ?? null)).toBe('success');
    expect(out.outputs?.skipped, 'an entitled run is not skipped').toBeUndefined();
    const planId = (out.outputs?.plan as { planId?: string } | undefined)?.planId;
    expect(planId, 'the node generated a plan').toBeTruthy();
    expect((await getPlan(TENANT, orgB, planId!))?.strategySummary, 'and it was persisted').toBe('entitled plan');
  });

  it.fails('PIC-8: the production.plan ARTIFACT carries the CLEANED plan, not the raw model output', async () => {
    const pack = await import('../../../packs/feature.production.nodes/index.mjs') as {
      planGenerate: (c: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>;
    };
    const features = buildHostSurfaceBundle({ tenantId: TENANT, actingUserId: ADMIN_B, runId: 'run-art' }).features;
    const out = await pack.planGenerate({
      inputs: { orgId: orgB, channels: ['landing_page'] },
      features,
      callAI: async () => ({
        data: {
          strategySummary: 'artifact plan',
          recommendations: [{
            assetType: 'video', executionRoute: 'agency', rationale: 'r',
            budget: { min: 1, max: 2, currency: 'dollars' },
            matchingVendors: [{ vendorId: 'vnd:ghost-artifact', name: 'Ghost Co', type: 'agency', matchReason: 'hallucinated' }],
          }],
        },
      }),
    });
    expect(out.status).toBe('success');
    const artifact = out.outputs?.artifact as { payload: { recommendations: Array<{ budget?: { currency?: string }; matchingVendors?: unknown[] }> } };
    const rec = artifact.payload.recommendations[0]!;
    expect(rec.budget?.currency, 'PROD2-R2 — the renderer gets an ISO code').toBe('USD');
    expect(rec.matchingVendors ?? [], 'PIC-1 — the ghost vendor never reaches the artifact').toEqual([]);
  });
});
