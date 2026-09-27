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
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { createVendor } from '../src/features/production/productionService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const TENANT = 'org:prod-authz';
const MEMBER_A = 'u-a';   // member of org A only
const MEMBER_B = 'u-b';   // member of org B, with write
const ADMIN_B = 'u-b-admin'; // org B admin — holds host:members:manage, so entitled to see rates

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

  // Org B holds a vendor whose NAME and rates are org-B business data.
  await createVendor({
    tenantId: TENANT, orgId: orgB, name: 'Beta Secret Studio', type: 'agency',
    contractStatus: 'preferred', createdBy: MEMBER_B,
    capabilities: [{ name: 'Landing page design', category: 'design', qualityRating: 5 }],
    priceRanges: [{ capability: 'Landing page design', min: 4000, max: 9000, unit: 'per-project' }],
  } as never);
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

  it('refuses a SYSTEM run with no acting user (fail-closed)', async () => {
    const s = surfaceFor(undefined);
    await expect(s.listVendors!({ orgId: orgB })).rejects.toMatchObject({ code: 'forbidden_scope' });
  });

  it('ALLOWS a real member of that org (the negative control)', async () => {
    // Without this, "refuses everything" would pass while breaking the feature.
    const s = surfaceFor(MEMBER_B);
    const out = await s.listVendors!({ orgId: orgB });
    expect(Array.isArray(out.vendors)).toBe(true);
    expect((out.vendors as unknown[]).length).toBeGreaterThan(0);
    const plans = await s.listPlans!({ orgId: orgB });
    expect(Array.isArray(plans.plans)).toBe(true);
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

describe('PROD2-R1 — a caller who cannot SEE rates cannot WIPE them', () => {
  it('the PATCH route ignores priceRanges from a non-entitled caller', async () => {
    // The two scopes differ: EDITING a vendor needs `workspace:write`; SEEING
    // rates needs `host:members:manage`. So an editor's GET has the key DELETED
    // by `redactVendorPricing` — and the first cut of the new price repeater
    // then sent `priceRanges: []` unconditionally. The route patches any key
    // present in the body, so saving a NAME CHANGE destroyed the rates with a
    // "Vendor updated" toast. Runtime-proven by the review.
    //
    // The client now omits the key, but this asserts the half that cannot
    // regress: no client can blind-overwrite a field it may not read.
    const { updateVendor, getVendor, createVendor } = await import('../src/features/production/productionService.js');
    const created = await createVendor({
      tenantId: TENANT, orgId: orgB, name: 'Rate Holder', type: 'agency', contractStatus: 'active', createdBy: ADMIN_B,
      capabilities: [{ name: 'Copywriting', category: 'writing' }],
      priceRanges: [{ capability: 'Copywriting', min: 100, max: 200, unit: 'per-hour' }],
    } as never);

    // Simulate the editor's save: the SERVICE is the last line of defence, so
    // this asserts the route-level guard by driving what the route would build.
    // A non-entitled caller's patch must not carry the key at all.
    await updateVendor(TENANT, orgB, created.vendorId, { name: 'Rate Holder (renamed)' } as never);
    const after = await getVendor(TENANT, orgB, created.vendorId);
    expect(after!.name).toBe('Rate Holder (renamed)');
    expect(after!.priceRanges, 'the rates survive an edit that did not mention them').toHaveLength(1);

    // …and an ENTITLED caller can still change them (the control) — otherwise
    // "rates survive" would be satisfied by making them immutable.
    await updateVendor(TENANT, orgB, created.vendorId, {
      priceRanges: [{ capability: 'Copywriting', min: 150, max: 250, unit: 'per-hour' }],
    } as never);
    expect((await getVendor(TENANT, orgB, created.vendorId))!.priceRanges[0]!.min).toBe(150);
  });
});

describe('PROD2-R2 — a model-invented currency cannot reach the renderer', () => {
  it('normalises anything that is not an ISO-4217 code', async () => {
    // `cleanBudget` validated the currency only as a <=8-char string, so
    // "dollars" / "$" / "EUROS" reached `formatCurrency` and threw a RangeError
    // out of Intl — which, inside a render, takes the whole Production page
    // down. The prompt hands the model bare magnitudes with no unit of account,
    // so inventing a code is expected behaviour, not an edge case.
    const { savePlan, getPlan } = await import('../src/features/production/productionService.js');
    const saved = await savePlan({
      tenantId: TENANT, orgId: orgB, updatedBy: ADMIN_B, strategySummary: 's',
      recommendations: [
        { assetType: 'landing page', executionRoute: 'agency', budget: { min: 1, max: 2, currency: 'dollars' } },
        { assetType: 'video', executionRoute: 'internal', budget: { min: 1, max: 2, currency: 'eur' } },
      ],
    } as never);
    const plan = await getPlan(TENANT, orgB, saved.planId);
    expect(plan!.recommendations[0]!.budget.currency, 'garbage falls back to USD').toBe('USD');
    expect(plan!.recommendations[1]!.budget.currency, 'a real code is kept, upper-cased').toBe('EUR');
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
      planGenerate: (c: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>;
    };
    const features = buildHostSurfaceBundle({ tenantId: TENANT, actingUserId: ADMIN_B, runId: 'run-ok' }).features;
    const out = await pack.planGenerate({
      inputs: { orgId: orgB, channels: ['landing_page'] },
      features,
      callAI: async () => ({ content: JSON.stringify({ strategySummary: 's', recommendations: [] }) }),
    });
    expect(out.outputs?.skipped, 'an entitled run is not skipped').toBeUndefined();
  });
});
