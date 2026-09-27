/**
 * Production Intelligence routes (ADR 0172) — the Vendor Directory CRUD + the
 * generated-plan read/lifecycle surface, under
 * `/v1/host/openwop-app/production/orgs/:orgId`.
 *
 * Every route is gated by the shared `authorizeOrgScope` (toggle `production` +
 * the caller's RFC 0049 scope in the path org): read → workspace:read, write →
 * workspace:write; a non-member fails closed (403); an org outside the caller's
 * tenant 404s. Plan GENERATION is a workflow run (the `plan-generate` node) — not
 * a REST route; these routes only READ plans + transition their advisory status.
 *
 * ADR 0643 D6 — THE FIRE-AND-FORGET RULE, stated once for this file: a derived-index
 * write on a mutation path is `await`ed, never `void`ed. This host is documented three
 * times over to SUSPEND detached continuations under Cloud Run `cpu-throttling=true`
 * (`CLAUDE.md:503` — the `spa_shell_fetch_failed` incident where a fire-and-forget
 * refresh never resumed and wedged `/` for 16+ minutes; ADR 0556 `:577`; ADR 0585
 * `:88`), so `void f()` immediately before `res.json(...)` is a coin-flip on whether
 * `f` ever runs — while the 2xx says it did. Awaiting is free of failure risk here:
 * `indexVendor`/`removeVendor` each try/catch + `log.warn` internally
 * (`productionKnowledgeService.ts`), so a KB failure still cannot break vendor CRUD
 * — including the `assertNoLiveReindex` 409, which is raised inside their own try.
 * And in provider embed mode `ingestDocument` defers vectorization to the next
 * hydrate (`kbService.ts` — `rows = []`, `hydrated.delete(...)`), so the awaited cost
 * is a durable put, not a provider round-trip.
 *
 * @see docs/adr/0172-production-intelligence-vendor-directory.md
 * @see docs/adr/0643-kb-reindex-orchestration-write-surface-lifecycle-events.md (D6)
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString, optionalString } from '../featureRoute.js';
import type { Scope } from '../../host/accessControlService.js';
import type { User } from '../users/usersService.js';
import { getCompany } from '../crm/crmEntitiesService.js';
import {
  createVendor,
  deleteVendor,
  getVendor,
  listVendors,
  setVendorPortfolio,
  updateVendor,
  getPlan,
  listPlans,
  transitionPlan,
  PLAN_STATUSES,
  VENDOR_TYPES,
  CONTRACT_STATUSES,
  type PlanStatus,
  type VendorType,
  type ContractStatus,
} from './productionService.js';
import { backfillProductionKb, indexVendor, removeVendor } from './productionKnowledgeService.js';
import { canSeeVendorPricing, redactVendorPricing } from './vendorRedaction.js';

const TOGGLE_ID = 'production';

interface Ctx {
  user: User;
  orgId: string;
  tenantId: string;
}

const authorize = (req: Request, scope: Scope): Promise<Ctx> => authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: 'Production Intelligence' }, scope);

/** Validate an optional CRM company reference IDOR-safely (same tenant+org). */
async function resolveCompanyRef(ctx: Ctx, raw: unknown): Promise<string | undefined> {
  const companyId = optionalString(raw);
  if (!companyId) return undefined;
  const company = await getCompany(ctx.tenantId, ctx.orgId, companyId);
  if (!company) {
    throw new OpenwopError('validation_error', 'companyId does not reference a company in this org.', 400, { field: 'companyId' });
  }
  return companyId;
}

/** ADR 0356 P6 — vendor pricing is sensitive (the spec's editors+ rule):
 *  callers WITHOUT `host:members:manage` see vendors with priceRanges
 *  redacted. Field-level, fail-closed — the shared `vendorRedaction` helper
 *  (also applied by the workflow surface + KB indexer). */
function canSeePricing(req: import('express').Request, orgId: string): Promise<boolean> {
  const userId = req.userId ?? req.principal?.principalId ?? undefined;
  return canSeeVendorPricing(req.tenantId ?? 'default', orgId, userId);
}

export function registerProductionRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/production/orgs/:orgId';

  // ── Vendors ──
  app.get(`${BASE}/vendors`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      const filter: { q?: string; type?: VendorType; contractStatus?: ContractStatus } = {};
      if (optionalString(req.query.q)) filter.q = String(req.query.q);
      const type = optionalString(req.query.type);
      if (type && (VENDOR_TYPES as readonly string[]).includes(type)) filter.type = type as VendorType;
      const cs = optionalString(req.query.contractStatus);
      if (cs && (CONTRACT_STATUSES as readonly string[]).includes(cs)) filter.contractStatus = cs as ContractStatus;
      const showPricing = await canSeePricing(req, ctx.orgId);
      res.json({ vendors: (await listVendors(ctx.tenantId, ctx.orgId, filter)).map((v) => redactVendorPricing(v, showPricing)) });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/vendors`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const companyId = await resolveCompanyRef(ctx, body.companyId);
      const vendor = await createVendor({
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        type: body.type,
        name: requireString(body.name, 'name'),
        ...(companyId ? { companyId } : {}),
        contactEmail: body.contactEmail,
        website: body.website,
        region: body.region,
        capabilities: body.capabilities,
        priceRanges: body.priceRanges,
        pastProjects: body.pastProjects,
        portfolioAssetTokens: body.portfolioAssetTokens,
        contractStatus: body.contractStatus,
        notes: body.notes,
        lastVerifiedAt: body.lastVerifiedAt,
        createdBy: ctx.user.userId,
      });
      await indexVendor(ctx.tenantId, ctx.orgId, ctx.user.userId, vendor); // KB sync — fail-open INSIDE, awaited (D6)
      res.status(201).json(vendor);
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/vendors/:vendorId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      const v = await getVendor(ctx.tenantId, ctx.orgId, req.params.vendorId);
      if (!v) throw new OpenwopError('not_found', 'Vendor not found.', 404, { vendorId: req.params.vendorId });
      res.json(redactVendorPricing(v, await canSeePricing(req, ctx.orgId)));
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${BASE}/vendors/:vendorId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Parameters<typeof updateVendor>[3] = {};
      if (typeof body.type === 'string' && (VENDOR_TYPES as readonly string[]).includes(body.type)) patch.type = body.type as VendorType;
      if (typeof body.name === 'string') patch.name = body.name;
      if ('companyId' in body) patch.companyId = body.companyId === null ? null : (await resolveCompanyRef(ctx, body.companyId)) ?? null;
      for (const k of ['contactEmail', 'website', 'region', 'notes', 'lastVerifiedAt'] as const) {
        if (k in body) patch[k] = body[k] === null ? null : optionalString(body[k]) ?? null;
      }
      if ('capabilities' in body) patch.capabilities = body.capabilities;
      // PROD2-R1 — a caller who cannot READ this field must not be able to
      // blind-overwrite it. Reading needs `host:members:manage`; editing a
      // vendor needs only `workspace:write`, so an editor's form legitimately
      // has no rates to send — and a body that omits them must leave the stored
      // ones alone. The client omits the key now; this makes it impossible to
      // wipe them from any client, which is the half that cannot regress.
      if ('priceRanges' in body && (await canSeePricing(req, ctx.orgId))) patch.priceRanges = body.priceRanges;
      if ('pastProjects' in body) patch.pastProjects = body.pastProjects;
      if (typeof body.contractStatus === 'string' && (CONTRACT_STATUSES as readonly string[]).includes(body.contractStatus)) {
        patch.contractStatus = body.contractStatus as ContractStatus;
      }
      const updated = await updateVendor(ctx.tenantId, ctx.orgId, req.params.vendorId, patch);
      if (!updated) throw new OpenwopError('not_found', 'Vendor not found.', 404, { vendorId: req.params.vendorId });
      await indexVendor(ctx.tenantId, ctx.orgId, ctx.user.userId, updated); // KB re-sync — fail-open INSIDE, awaited (D6)
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/vendors/:vendorId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const ok = await deleteVendor(ctx.tenantId, ctx.orgId, req.params.vendorId);
      if (!ok) throw new OpenwopError('not_found', 'Vendor not found.', 404, { vendorId: req.params.vendorId });
      // `KBC-5`(iii) — the lane the rule above exists for. A dropped continuation
      // here strands a DELETED vendor's capability/region/notes text in a
      // collection agents retrieve from, and the 204 claims otherwise. Awaited,
      // and ungated (see `removeVendor`). Never throws; `false` means the doc may
      // still be there — the vendor row is already gone, so the request stays a
      // 204 and the repair path is `POST …/reindex-kb`, whose orphan sweep
      // removes exactly this residue.
      await removeVendor(ctx.tenantId, ctx.orgId, req.params.vendorId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Replace the vendor's portfolio media-asset token set (references only).
  app.put(`${BASE}/vendors/:vendorId/portfolio`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as { tokens?: unknown };
      if (!Array.isArray(body.tokens)) throw new OpenwopError('validation_error', '`tokens` must be an array of media-asset tokens.', 400, { field: 'tokens' });
      const updated = await setVendorPortfolio(ctx.tenantId, ctx.orgId, req.params.vendorId, body.tokens);
      if (!updated) throw new OpenwopError('not_found', 'Vendor not found.', 404, { vendorId: req.params.vendorId });
      await indexVendor(ctx.tenantId, ctx.orgId, ctx.user.userId, updated); // KB re-sync — fail-open INSIDE, awaited (D6)
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // ── reindex into the managed Vendor Directory KB (`KBC-5`(ii) / ADR 0643 D6) ──
  // `backfillProductionKb` had NO caller — the repair path for a drifted mirror was
  // reachable only by editing code. Same shape + gate as the `strategy` and
  // `priority-matrix` siblings' `reindex-kb` (toggle + `workspace:write` in the path
  // org, via this file's shared `authorize`). Reconciles BOTH directions: vendors that
  // predate the toggle flip get indexed, and `vendor:` docs whose vendor is confirmed
  // gone by a point read get removed (see the service docblock for what actually
  // produces an orphan).
  //
  // The result is returned VERBATIM, `complete` included: a sweep can be cut short by
  // the per-pass cap or by a mid-walk throw (`assertNoLiveReindex`'s 409 while a
  // reindex is running is the expected one), and a partial pass reporting
  // `removedOrphans: 0` means "did not finish looking", not "nothing to fix". Passing
  // that off as a clean drift signal would be a false all-clear on a retention
  // surface, so the caller sees the flag rather than the route deciding for them.
  app.post(`${BASE}/reindex-kb`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      res.json(await backfillProductionKb(ctx.tenantId, ctx.orgId, ctx.user.userId));
    } catch (err) {
      next(err);
    }
  });

  // ── Production plans (READ + advisory lifecycle; GENERATION is a workflow run) ──
  app.get(`${BASE}/plans`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      res.json({ plans: await listPlans(ctx.tenantId, ctx.orgId) });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/plans/:planId`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:read');
      const p = await getPlan(ctx.tenantId, ctx.orgId, req.params.planId);
      if (!p) throw new OpenwopError('not_found', 'Production plan not found.', 404, { planId: req.params.planId });
      res.json(p);
    } catch (err) {
      next(err);
    }
  });

  // Advisory status transition (draft → approved → in_production → completed).
  app.post(`${BASE}/plans/:planId/status`, async (req, res, next) => {
    try {
      const ctx = await authorize(req, 'workspace:write');
      const status = requireString((req.body ?? {}).status, 'status');
      if (!(PLAN_STATUSES as readonly string[]).includes(status)) {
        throw new OpenwopError('validation_error', `status must be one of: ${PLAN_STATUSES.join(', ')}`, 400, { field: 'status' });
      }
      const updated = await transitionPlan(ctx.tenantId, ctx.orgId, req.params.planId, status as PlanStatus, ctx.user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Production plan not found.', 404, { planId: req.params.planId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });
}
