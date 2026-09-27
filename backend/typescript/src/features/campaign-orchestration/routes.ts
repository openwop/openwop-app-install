/**
 * Campaign Studio routes (ADR 0158) — host-extension under
 * /v1/host/openwop-app/campaign-orchestration/*. The MarketingCampaign container + a
 * REST finalize (reads a confirmed brief, upserts the campaign).
 *
 * Gating, fail-closed (ADR 0006): toggle `campaign-studio` ON → RBAC in the
 * entity's org (read = workspace:read, miss → uniform 404; write = workspace:write).
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { getBrief } from '../campaign-brief/briefService.js';
import {
  listCampaigns, getCampaign, finalizeFromBrief, updateCampaignStatus, renameCampaign, deleteCampaign,
  listCampaignVersions, setCampaignParent,
} from './campaignService.js';
import { listDispatchRecords } from '../../host/adsAdapter.js';
import { cleanString } from '../../host/boundedStrings.js';
import type { CampaignStatus, MarketingCampaign } from './types.js';

const TOGGLE_ID = 'campaign-orchestration';
const LABEL = 'Campaign Studio';
const STATUSES: ReadonlyArray<CampaignStatus> = ['draft', 'active', 'paused', 'completed', 'archived'];

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

async function hasOrgScope(req: Request, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  return access.scopes.includes(scope);
}
async function requireOrgScopeFor(req: Request, orgId: string, scope: Scope): Promise<void> {
  if (!(await hasOrgScope(req, orgId, scope))) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}
async function loadCampaignScoped(req: Request, scope: Scope): Promise<MarketingCampaign> {
  const campaign = await getCampaign(tenantOf(req), req.params.campaignId);
  if (!campaign || !(await hasOrgScope(req, campaign.orgId, 'workspace:read'))) {
    throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: req.params.campaignId });
  }
  if (scope !== 'workspace:read') await requireOrgScopeFor(req, campaign.orgId, scope);
  return campaign;
}

export function registerCampaignStudioRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/campaign-orchestration';

  app.get(`${BASE}/campaigns`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = typeof req.query.orgId === 'string' && req.query.orgId.length > 0 ? req.query.orgId : undefined;
      const all = await listCampaigns(tenantOf(req), orgId);
      const out: MarketingCampaign[] = [];
      const readable = new Map<string, boolean>();
      for (const c of all) {
        let ok = readable.get(c.orgId);
        if (ok === undefined) { ok = await hasOrgScope(req, c.orgId, 'workspace:read'); readable.set(c.orgId, ok); }
        if (ok) out.push(c);
      }
      res.json({ campaigns: out });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/campaigns/:campaignId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      res.json({ campaign: await loadCampaignScoped(req, 'workspace:read') });
    } catch (err) { next(err); }
  });

  // Finalize: read a brief, upsert its campaign (one per brief).
  app.post(`${BASE}/finalize`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const briefId = requireString((req.body ?? {})?.briefId, 'briefId');
      const brief = await getBrief(tenantOf(req), briefId);
      if (!brief || !(await hasOrgScope(req, brief.orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Brief not found.', 404, { briefId });
      }
      await requireOrgScopeFor(req, brief.orgId, 'workspace:write');
      // ORCH-1: reject a kernel-less finalize — a campaign without the messaging
      // kernel is useless (the kernel is what every channel echoes). The
      // orchestration chain path already gates this downstream; this tightens the
      // REST path so a draft brief can't produce an empty campaign.
      if (!brief.kernel) {
        throw new OpenwopError('conflict', 'This brief has no messaging kernel yet — generate and approve the kernel before finalizing.', 409, { briefId });
      }
      const campaign = await finalizeFromBrief(tenantOf(req), brief, actingUserOf(req) ?? 'unknown');
      res.status(201).json({ campaign });
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/campaigns/:campaignId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const campaign = await loadCampaignScoped(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      // R2 CO-SP-5 — a present-but-invalid field is a TYPED 400 naming the value
      // and the allowlist, never a 200 with the unchanged campaign. The old
      // `typeof === 'string' && includes(...)` guards silently DROPPED an
      // invalid status/name, telling agents and API callers the write landed.
      // ALL fields validate BEFORE any write (review fold-in): a combined body
      // like {parentCampaignId, status:"bogus"} must not reparent and THEN 400 —
      // the 400 promises nothing changed.
      let parentId: string | undefined;
      if (body.parentCampaignId !== undefined && typeof body.parentCampaignId === 'string' && body.parentCampaignId.length > 0) {
        // C8 — campaign hierarchy: a plain same-org parent reference (null clears).
        const parent = await getCampaign(tenantOf(req), body.parentCampaignId);
        if (!parent || parent.orgId !== campaign.orgId || parent.id === campaign.id) {
          throw new OpenwopError('validation_error', 'parentCampaignId must reference another campaign in the same org.', 400, {});
        }
        // Reject CYCLES (grade-code AUDIT-13): direct self-reference was blocked,
        // but A→B then B→A (or any deeper A→B→C→A) built a loop that a future
        // rollup/breadcrumb traversal would infinite-loop on. Walk the proposed
        // parent's ancestor chain; if it reaches this campaign, it's a cycle.
        const seen = new Set<string>([campaign.id]);
        let cursor: MarketingCampaign | null = parent;
        while (cursor) {
          if (seen.has(cursor.id)) {
            throw new OpenwopError('validation_error', 'parentCampaignId would create a cycle in the campaign hierarchy.', 400, {});
          }
          seen.add(cursor.id);
          cursor = cursor.parentCampaignId ? await getCampaign(tenantOf(req), cursor.parentCampaignId) : null;
        }
        parentId = parent.id;
      }
      if (body.name !== undefined) {
        // Same cleaner the service applies (trim + secret-scrub + bound), so a
        // name that would clean to empty — and silently keep the old name — is
        // refused here instead.
        if (typeof body.name !== 'string' || cleanString(body.name, 160).length === 0) {
          throw new OpenwopError('validation_error', 'name must be a non-empty string.', 400, {});
        }
      }
      if (body.status !== undefined) {
        if (typeof body.status !== 'string' || !STATUSES.includes(body.status as CampaignStatus)) {
          throw new OpenwopError('validation_error', `status "${String(body.status)}" is not valid — use one of: ${STATUSES.join(', ')}.`, 400, {});
        }
      }

      let updated: MarketingCampaign | null = campaign;
      if (body.parentCampaignId !== undefined) {
        updated = await setCampaignParent(tenantOf(req), campaign.id, parentId, actingUserOf(req) ?? 'unknown');
      }
      if (body.name !== undefined) {
        updated = await renameCampaign(tenantOf(req), campaign.id, body.name as string, actingUserOf(req) ?? 'unknown');
      }
      if (body.status !== undefined) {
        updated = await updateCampaignStatus(tenantOf(req), campaign.id, body.status as CampaignStatus, actingUserOf(req) ?? 'unknown');
      }
      if (!updated) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: campaign.id });
      res.json({ campaign: updated });
    } catch (err) { next(err); }
  });

  // Revision history (campaign gap plan §5B B4 — the CMS versions precedent).
  // ADR 0356 P2 — the campaign WORKSPACE: one aggregating read (campaign +
  // brief + linked production plan). A PROJECTION over existing stores — no
  // second store (the artifact-workbench precedent). Drafts stay run artifacts
  // reachable via the run inspector; this read collects the durable heads.
  app.get(`${BASE}/campaigns/:campaignId/workspace`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const campaign = await loadCampaignScoped(req, 'workspace:read');
      // ORCH-CODE-3: no blanket catch here — a store failure is a REAL error
      // (propagate → 500), not "feature off". briefService is already a static
      // dependency of this router (the finalize route); a missing brief is an
      // honest null. The production plan is gated on its feature TOGGLE
      // explicitly (a plan from a disabled feature stays hidden).
      const brief = (await getBrief(campaign.tenantId, campaign.briefId)) ?? null;
      let productionPlan: unknown = null;
      if (campaign.productionPlanId) {
        const { resolveOne } = await import('../../host/featureToggles/service.js');
        const production = await resolveOne('production', { tenantId: tenantOf(req) });
        if (production?.enabled) {
          const { getPlan } = await import('../production/productionService.js');
          productionPlan = await getPlan(campaign.tenantId, campaign.orgId, campaign.productionPlanId);
        }
      }
      res.json({ campaign, brief, productionPlan });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/campaigns/:campaignId/versions`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const campaign = await loadCampaignScoped(req, 'workspace:read');
      res.json({ versions: await listCampaignVersions(tenantOf(req), campaign.id) });
    } catch (err) { next(err); }
  });

  // Ad dispatch state (campaign gap plan §5B B5) — the adapter's fork-stable
  // idempotency ledger, scoped by the campaign's brief. Read-only; ids +
  // platform state only (never a token or creative bytes).
  app.get(`${BASE}/campaigns/:campaignId/dispatches`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const campaign = await loadCampaignScoped(req, 'workspace:read');
      res.json({ dispatches: await listDispatchRecords(tenantOf(req), campaign.briefId) });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/campaigns/:campaignId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const campaign = await loadCampaignScoped(req, 'workspace:write');
      await deleteCampaign(tenantOf(req), campaign.id, actingUserOf(req) ?? 'unknown');
      res.json({ deleted: true, campaignId: campaign.id });
    } catch (err) { next(err); }
  });
}
