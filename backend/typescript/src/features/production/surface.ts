/**
 * Production Intelligence workflow surface (ADR 0172 / ADR 0014) —
 * `ctx.features.production`. A thin adapter over `productionService` +
 * `productionContext`, the source of truth shared with the REST face. Tenant comes
 * from the run scope; `orgId` is node-supplied.
 *
 * UX_UPGRADE-production R2 (PROD2-B1) — every verb below now enforces the RUN
 * OWNER's org RBAC, mirroring the REST face. It previously enforced only the
 * tenant+org KEY (CTI-1), which this docblock correctly described as
 * cross-TENANT protection and which was silently doing duty as authorization.
 * It is not: a same-tenant member of org A resolves to zero scopes in org B, so
 * every route and both chat tools already refused them there — while
 * `POST /v1/runs` with `{orgId: "<org B>"}` reached this surface with no org
 * check at all, read org B's vendors into a model prompt, and WROTE a plan row
 * into org B that every org-B member then sees. Run-create gates on tenant +
 * `runs:create` and nothing else, and the chain-backed workflow resolves for
 * any tenant, so no workflow authoring was needed to reach it.
 *
 * `territories/surface.ts` is the in-repo precedent this now matches ("a
 * territory WRITE from a run enforces `scope` against the RUN OWNER … Mirrors
 * the HTTP RBAC exactly"); `dealers` and `sales-commissions` do the same.
 * Production was the outlier.
 *
 * Reads:
 *  - `buildContext({ orgId, channels })` — ranks the team (Profiles, ADR 0005) +
 *    vendors into a token-capped prompt block (the ProductionContextBuilder port).
 *  - `listVendors` / `getVendor` / `getPlan` / `listPlans` — projected reads.
 * Write (role:action node only, recorded → replay-safe):
 *  - `savePlan(...)` — persist a generated ProductionPlan (idempotent per planId;
 *    ADR 0728 — REFUSED with `plan_not_draft` when the named plan has been moved
 *    out of `draft` and the new content differs from what was approved).
 *
 * NOTE: team data is READ from `profilesService.listProfiles` (a sibling feature
 * service) — Profiles has no `ctx.features.profiles` surface today (ADR 0172 gap).
 *
 * @see docs/adr/0172-production-intelligence-vendor-directory.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listProfiles } from '../profiles/profilesService.js';
import { buildProductionContext } from './productionContext.js';
import { listVendors, getVendor, getPlan, listPlans, savePlan } from './productionService.js';
import { canSeeVendorPricing, redactVendorPricing } from './vendorRedaction.js';

/** Internal columns stripped from surface outputs (recorded in the event log). */
const INTERNAL = new Set(['tenantId', 'createdBy', 'updatedBy']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}
const projectOne = (o: object | null): Record<string, unknown> | null => (o ? project(o) : null);

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function buildProductionSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const viewer = scope.actingUserId;

  /** PROD2-B1 — the run owner's org RBAC, mirroring the REST face exactly.
   *  Fail-closed for system runs: a run with no acting user has no org identity
   *  to check, and this surface reads a vendor directory and writes plans. */
  const requireScope = async (orgId: string, needed: Scope): Promise<void> => {
    if (!viewer) {
      throw new OpenwopError('forbidden_scope', 'A production read/write requires an acting user (system runs are denied).', 403, { requiredScope: needed });
    }
    const access = await resolveEffectiveAccess(tenantId, { subject: viewer, orgId });
    if (!access.scopes.includes(needed)) {
      throw new OpenwopError('forbidden_scope', `Missing required scope: ${needed}`, 403, { requiredScope: needed });
    }
  };

  return {
    // Rank team + vendors for a brief's channels → token-capped prompt context.
    buildContext: async (args) => {
      const orgId = str(args.orgId);
      await requireScope(orgId, 'workspace:read');
      const channels = strArr(args.channels);
      const [profiles, vendors] = await Promise.all([listProfiles(tenantId), listVendors(tenantId, orgId)]);
      // PROD2-B2 — the prompt asks the model to ground a BUDGET, so the context
      // must carry the rates it is entitled to see. Same predicate as the REST
      // face and the chat tool; a system run (no principal) fails closed to a
      // priceless context, exactly as `listVendors` below falls closed to the
      // redacted projection.
      const includePricing = await canSeeVendorPricing(tenantId, orgId, scope.actingUserId);
      const ctx = buildProductionContext({ channels, profiles, vendors, includePricing });
      return {
        relevantCategories: ctx.relevantCategories,
        teamCapabilitySection: ctx.teamCapabilitySection,
        // PROD2-R3 — the RECORDABLE section (never priced) and the priced one,
        // as separate keys. A node echoes the former into its outputs, which
        // land in the tenant-scoped run log; only prompt assembly reads the
        // latter, in-process.
        vendorSection: ctx.vendorSection,
        vendorSectionPriced: ctx.vendorSectionPriced,
        rankedMembers: ctx.rankedMembers,
        rankedVendors: ctx.rankedVendors,
        gaps: ctx.gaps,
      };
    },
    // Vendor reads apply the shared priceRanges redaction (ADR 0356 P6): the
    // run owner's principal (`scope.actingUserId`) must hold
    // `host:members:manage` in the org — same rule as the REST face; a system
    // run (no principal) fails closed to the redacted projection.
    listVendors: async (args) => {
      const orgId = str(args.orgId);
      await requireScope(orgId, 'workspace:read');
      const vendors = await listVendors(tenantId, orgId);
      const showPricing = await canSeeVendorPricing(tenantId, orgId, scope.actingUserId);
      return { vendors: vendors.map((v) => project(redactVendorPricing(v, showPricing))) };
    },
    getVendor: async (args) => {
      const orgId = str(args.orgId);
      await requireScope(orgId, 'workspace:read');
      const vendor = await getVendor(tenantId, orgId, str(args.vendorId));
      const showPricing = vendor ? await canSeeVendorPricing(tenantId, orgId, scope.actingUserId) : false;
      return { vendor: projectOne(vendor ? redactVendorPricing(vendor, showPricing) : null) };
    },
    listPlans: async (args) => {
      await requireScope(str(args.orgId), 'workspace:read');
      const plans = await listPlans(tenantId, str(args.orgId));
      return { plans: plans.map(project) };
    },
    getPlan: async (args) => {
      await requireScope(str(args.orgId), 'workspace:read');
      const plan = await getPlan(tenantId, str(args.orgId), str(args.planId));
      return { plan: projectOne(plan) };
    },
    // WRITE — persist a generated plan (called from the plan-generate role:action
    // node; the node output is recorded so replay/fork reads it verbatim).
    savePlan: async (args) => {
      await requireScope(str(args.orgId), 'workspace:write');
      const plan = await savePlan({
        tenantId,
        orgId: str(args.orgId),
        ...(optStr(args.planId) ? { planId: str(args.planId) } : {}),
        ...(optStr(args.briefId) ? { briefId: str(args.briefId) } : {}),
        ...(optStr(args.workflowRunId) ? { workflowRunId: str(args.workflowRunId) } : {}),
        strategySummary: args.strategySummary,
        recommendations: args.recommendations,
        totalBudget: args.totalBudget,
        timeline: args.timeline,
        capabilityAssessment: args.capabilityAssessment,
      });
      return { plan: project(plan) };
    },
  };
}
