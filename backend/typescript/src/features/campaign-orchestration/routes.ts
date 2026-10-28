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
  listCampaignVersions, setCampaignParent, setCampaignGoal,
} from './campaignService.js';
import { MAX_PRODUCT_REFS, readCampaignLinks, setCampaignLinks, type CampaignLinksPatch } from './campaignLinks.js';
import { getProduct } from '../commerce/commerceService.js';
import { listCampaignDispatchRecords } from '../../host/adsAdapter.js';
import { cleanString } from '../../host/boundedStrings.js';
import type { CampaignGoal, CampaignProductRef, CampaignStatus, MarketingCampaign } from './types.js';
import { ensureCampaignProject, getCampaignProjectId } from './campaignProject.js';
import { readableCampaign, readableCampaignAutonomy } from './autonomyAccess.js';
import { requestCreativeReview } from './creativeReview.js';
import { getAssetByIdForTenant } from '../media/mediaService.js';
import { castVeto, getVeto, listOpenVetoes, type VetoRecord } from '../../host/autonomyPolicy/index.js';
import { canonicalReviewerUserId, resolveEligibleApprovers } from '../../host/approverResolution.js';
import { appendAudit } from '../../host/auditChainService.js';
import {
  AUTONOMY_TOGGLE, AUTONOMY_TOGGLE_LABEL, applyPolicyChange, clearCampaignOverride, describePolicy, parsePolicyBody,
} from '../../host/autonomyPolicy/index.js';
import { buildCommandSnapshot, campaignRunOf } from './commandService.js';
import { resolveRunDefinition } from '../../host/resolveRunDefinition.js';

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
/** The campaign of `req.params.campaignId`, authorized for `scope` (read miss →
 *  uniform 404). Variant sets (ADR 0946) reuse the same scoped check.
 *  Exported so a dependent feature (ADR 0961 autopilot) keys on
 *  the same predicate instead of a copy. */
export async function loadCampaignScoped(req: Request, scope: Scope): Promise<MarketingCampaign> {
  const campaign = await getCampaign(tenantOf(req), req.params.campaignId);
  if (!campaign || !(await hasOrgScope(req, campaign.orgId, 'workspace:read'))) {
    throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: req.params.campaignId });
  }
  if (scope !== 'workspace:read') await requireOrgScopeFor(req, campaign.orgId, scope);
  return campaign;
}

const GOAL_METRICS: ReadonlyArray<CampaignGoal['outcome']['metric']> = ['conversions', 'purchases', 'revenue', 'leads', 'qualified_leads', 'roas', 'cpa', 'cpl'];
const MAX_GUARDRAILS = 10;

const bad = (message: string, field: string): OpenwopError => new OpenwopError('validation_error', message, 400, { field });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Only these keys are accepted in an object; anything else is a typed 400. */
function closed(o: Record<string, unknown>, keys: readonly string[], field: string): void {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length > 0) throw bad(`${field} has unknown field(s): ${extra.join(', ')}.`, field);
}

/** ADR 0941 D1 — closed-world parse of a goal body. `null` clears the goal. The
 *  version is the service's to assign, so a caller-supplied one is refused. */
export function parseCampaignGoal(raw: unknown): Omit<CampaignGoal, 'version'> | null {
  if (raw === null) return null;
  if (!isObj(raw)) throw bad('goal must be an object or null.', 'goal');
  closed(raw, ['outcome', 'mediaBudget', 'guardrails'], 'goal');
  const o = raw.outcome;
  if (!isObj(o)) throw bad('goal.outcome is required.', 'goal.outcome');
  closed(o, ['metric', 'target', 'by'], 'goal.outcome');
  if (!GOAL_METRICS.includes(o.metric as CampaignGoal['outcome']['metric'])) throw bad(`goal.outcome.metric must be one of: ${GOAL_METRICS.join(', ')}.`, 'goal.outcome.metric');
  if (!finite(o.target) || o.target <= 0) throw bad('goal.outcome.target must be a positive number.', 'goal.outcome.target');
  if (o.by !== undefined && (typeof o.by !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(o.by) || Number.isNaN(Date.parse(o.by)))) throw bad('goal.outcome.by must be an ISO date.', 'goal.outcome.by');
  const goal: Omit<CampaignGoal, 'version'> = { outcome: { metric: o.metric as CampaignGoal['outcome']['metric'], target: o.target, ...(typeof o.by === 'string' ? { by: o.by } : {}) } };
  if (raw.mediaBudget !== undefined) {
    const b = raw.mediaBudget;
    if (!isObj(b)) throw bad('goal.mediaBudget must be an object.', 'goal.mediaBudget');
    closed(b, ['totalMinor', 'currency', 'dailyCapMinor'], 'goal.mediaBudget');
    if (!nonNegInt(b.totalMinor)) throw bad('goal.mediaBudget.totalMinor must be a non-negative integer (minor units).', 'goal.mediaBudget.totalMinor');
    if (typeof b.currency !== 'string' || !/^[A-Z]{3}$/.test(b.currency)) throw bad('goal.mediaBudget.currency must be an ISO 4217 code.', 'goal.mediaBudget.currency');
    if (b.dailyCapMinor !== undefined && (!nonNegInt(b.dailyCapMinor) || b.dailyCapMinor > b.totalMinor)) throw bad('goal.mediaBudget.dailyCapMinor must be a non-negative integer no larger than totalMinor.', 'goal.mediaBudget.dailyCapMinor');
    goal.mediaBudget = { totalMinor: b.totalMinor, currency: b.currency, ...(b.dailyCapMinor !== undefined ? { dailyCapMinor: b.dailyCapMinor } : {}) };
  }
  if (raw.guardrails !== undefined) {
    if (!Array.isArray(raw.guardrails) || raw.guardrails.length > MAX_GUARDRAILS) throw bad(`goal.guardrails must be an array of at most ${MAX_GUARDRAILS}.`, 'goal.guardrails');
    goal.guardrails = raw.guardrails.map((g, i) => {
      if (!isObj(g)) throw bad(`goal.guardrails[${i}] must be an object.`, 'goal.guardrails');
      closed(g, ['metric', 'op', 'value'], `goal.guardrails[${i}]`);
      if (typeof g.metric !== 'string' || !/^[a-z][a-z0-9_.]{0,63}$/.test(g.metric)) throw bad(`goal.guardrails[${i}].metric must be a lowercase metric id.`, 'goal.guardrails');
      if (g.op !== '<=' && g.op !== '>=') throw bad(`goal.guardrails[${i}].op must be "<=" or ">=".`, 'goal.guardrails');
      if (!finite(g.value)) throw bad(`goal.guardrails[${i}].value must be a number.`, 'goal.guardrails');
      return { metric: g.metric, op: g.op, value: g.value };
    });
  }
  return goal;
}

/** ADR 0941 D3 — shape of a productRefs body (existence is checked separately). */
function parseProductRefs(raw: unknown): CampaignProductRef[] {
  if (!Array.isArray(raw) || raw.length > MAX_PRODUCT_REFS) throw bad(`productRefs must be an array of at most ${MAX_PRODUCT_REFS}.`, 'productRefs');
  const seen = new Set<string>();
  let primaries = 0;
  return raw.map((r, i) => {
    if (!isObj(r)) throw bad(`productRefs[${i}] must be an object.`, 'productRefs');
    closed(r, ['productId', 'role'], `productRefs[${i}]`);
    if (typeof r.productId !== 'string' || r.productId.length === 0 || r.productId.length > 200) throw bad(`productRefs[${i}].productId is required.`, 'productRefs');
    if (r.role !== 'primary' && r.role !== 'secondary') throw bad(`productRefs[${i}].role must be "primary" or "secondary".`, 'productRefs');
    if (seen.has(r.productId)) throw bad(`productRefs lists ${r.productId} twice.`, 'productRefs');
    seen.add(r.productId);
    if (r.role === 'primary' && ++primaries > 1) throw bad('productRefs may have at most one primary product.', 'productRefs');
    return { productId: r.productId, role: r.role };
  });
}

export function registerCampaignStudioRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/host/openwop-app/campaign-orchestration';

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
      const c = await loadCampaignScoped(req, 'workspace:read');
      const projectId = await getCampaignProjectId(tenantOf(req), c.id); // ADR 0852 D1
      res.json({ campaign: { ...c, ...(projectId ? { projectId } : {}) } });
    } catch (err) { next(err); }
  });

  // ADR 0852 D1 — create-or-return the campaign's linked project (an existing
  // campaign gets one lazily, on first open of its Ledger panel).
  app.post(`${BASE}/campaigns/:campaignId/project`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const c = await loadCampaignScoped(req, 'workspace:write');
      res.json({ projectId: await ensureCampaignProject(c, actingUserOf(req) ?? 'unknown') });
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
      // ADR 0941 P1 — links + goal. Shape first, then existence through each
      // owner, all before any write. A product that is missing OR in
      // another org is the same 404 (no cross-org existence leak).
      const links: CampaignLinksPatch = {};
      if (body.productRefs !== undefined) {
        const refs = parseProductRefs(body.productRefs);
        if (refs.length > 0) await requireFeatureEnabled(req, 'commerce', 'Commerce');
        for (const ref of refs) {
          if (!(await getProduct(tenantOf(req), campaign.orgId, ref.productId))) {
            throw new OpenwopError('not_found', 'Product not found.', 404, { reason: 'product_not_found', productId: ref.productId });
          }
        }
        links.productRefs = refs;
      }
      if (body.attention !== undefined) {
        if (!Array.isArray(body.attention) || body.attention.length > 0) throw bad('attention can only be cleared (send an empty array).', 'attention');
        links.clearAttention = true;
      }
      const goal = body.goal !== undefined ? parseCampaignGoal(body.goal) : undefined;

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
      if (links.productRefs || links.clearAttention) {
        updated = await setCampaignLinks(tenantOf(req), campaign.id, links);
      }
      if (goal !== undefined) {
        updated = await setCampaignGoal(tenantOf(req), campaign.id, goal, actingUserOf(req) ?? 'unknown');
      }
      if (!updated) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: campaign.id });
      res.json({ campaign: updated });
    } catch (err) { next(err); }
  });

  // ADR 0960 D1 — the campaign command snapshot: the campaign's runs (from the
  // ADR 0941 run index only), live nodes and open gates. Same org predicate as
  // every campaign read (uniform 404); bounded; never an interrupt token.
  app.get(`${BASE}/campaigns/:campaignId/command`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const campaign = await loadCampaignScoped(req, 'workspace:read');
      res.json({ command: await buildCommandSnapshot(deps.storage, campaign) });
    } catch (err) { next(err); }
  });

  // ADR 0960 D3 — the definition a campaign run EXECUTED (its pinned revision,
  // else the head), for the read-only run graph. Only for a run of this
  // campaign (index + tag), behind the same org read; never the builder's
  // workflow GET, which is ownership-scoped and may differ from the pin.
  app.get(`${BASE}/campaigns/:campaignId/command/runs/:runId/definition`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const campaign = await loadCampaignScoped(req, 'workspace:read');
      const run = await campaignRunOf(deps.storage, campaign, req.params.runId);
      if (!run) throw new OpenwopError('not_found', 'Run not found.', 404, { runId: req.params.runId });
      const resolved = await resolveRunDefinition(run, deps.hostSuite.workflowCatalog);
      if (!resolved) throw new OpenwopError('not_found', 'The definition this run executed is no longer available.', 404, { runId: run.runId, reason: 'definition_missing' });
      res.json({ runId: run.runId, workflowId: run.workflowId, resolvedFrom: resolved.resolvedFrom, definition: resolved.definition });
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

  // ADR 0941 D1 — the campaign's links, read through each owner. A section whose
  // read failed says so; it is never shown as "not linked".
  app.get(`${BASE}/campaigns/:campaignId/links`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const campaign = await loadCampaignScoped(req, 'workspace:read');
      const isEnabled = (featureId: string): Promise<boolean> => requireFeatureEnabled(req, featureId, featureId).then(() => true, () => false);
      res.json({ campaignId: campaign.id, links: await readCampaignLinks(campaign, isEnabled) });
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
      // ADR 0941 P2 — by campaign (and its org); legacy rows by the campaign's brief.
      res.json({ dispatches: await listCampaignDispatchRecords(tenantOf(req), campaign.orgId, campaign.id, campaign.briefId) });
    } catch (err) { next(err); }
  });

  // ADR 0942 P0 — the campaign's autonomy override. AND-gated: the parent toggle,
  // then the `campaign-orchestration.autonomy` sub-toggle (ADR 0941 D5). D9
  // authority: any change that is not provably at least as strict as BOTH the
  // policy in force and the client default needs `host:members:manage` on the
  // campaign's client org; a tighten needs `workspace:write`.
  const loosenNeedsOrgAdmin = (req: Request, orgId: string) => async (loosened: string[]): Promise<void> => {
    if (loosened.length === 0 || (await hasOrgScope(req, orgId, 'host:members:manage'))) return;
    throw new OpenwopError('forbidden_scope', 'Only an admin of this client can loosen its autonomy policy.', 403, {
      requiredScope: 'host:members:manage', orgId, reason: 'loosen_requires_admin', loosened,
    });
  };

  app.get(`${BASE}/campaigns/:campaignId/autonomy`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireFeatureEnabled(req, AUTONOMY_TOGGLE, AUTONOMY_TOGGLE_LABEL);
      // ADR 0942 P6 — the access predicate the Strategist's get-autonomy tool shares.
      const subject = actingUserOf(req);
      const found = await readableCampaignAutonomy(tenantOf(req), subject ? { subject } : { tenantPrincipal: true }, req.params.campaignId);
      if (!found) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: req.params.campaignId });
      res.json(found.view);
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/campaigns/:campaignId/autonomy`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireFeatureEnabled(req, AUTONOMY_TOGGLE, AUTONOMY_TOGGLE_LABEL);
      const campaign = await loadCampaignScoped(req, 'workspace:write');
      const { input, ifMatch } = parsePolicyBody(req.body);
      const result = await applyPolicyChange({
        tenantId: tenantOf(req), orgId: campaign.orgId, campaignId: campaign.id,
        input, ...(ifMatch !== undefined ? { ifMatch } : {}), actor: actingUserOf(req) ?? 'unknown',
        authorize: loosenNeedsOrgAdmin(req, campaign.orgId),
      });
      res.json({ ...(await describePolicy(tenantOf(req), campaign.orgId, campaign.id)), direction: result.direction, loosened: result.loosened });
    } catch (err) { next(err); }
  });

  // Drop the override: the client default applies again (same D9 authority rule).
  // ── ADR 0942 P4b — veto windows. Who may veto is the record's FROZEN notify
  // spec, resolved on the client org (a policy edit mid-window changes nothing);
  // a non-recipient sees nothing. Vetoing is the safe direction, so the requester
  // may veto too. Session lane only: no MCP tool reaches this.
  const mayVeto = async (tenantId: string, record: VetoRecord, subject: string | undefined): Promise<boolean> => {
    if (!subject) return false;
    // The ELIGIBILITY resolver, not the notification one: the latter answers
    // "broadcast" (null) when it cannot map a subject, which must never read as
    // "anyone may veto". A spec naming nobody vetoes nothing (fail closed).
    const eligible = await resolveEligibleApprovers(
      { ...(record.notify.roleRefs ? { approverRoleRefs: record.notify.roleRefs } : {}), ...(record.notify.subjectRefs ? { approverRefs: record.notify.subjectRefs } : {}) },
      { tenantId, ...(record.orgId ? { orgId: record.orgId } : {}) },
    );
    if (eligible.openGate) return false;
    const me = await canonicalReviewerUserId(tenantId, subject);
    for (const s of eligible.subjects) {
      if (s === subject || (await canonicalReviewerUserId(tenantId, s)) === me) return true;
    }
    return false;
  };
  const vetoReader = (req: Request) => { const subject = actingUserOf(req); return subject ? { subject } : { tenantPrincipal: true as const }; };

  app.get(`${BASE}/campaigns/:campaignId/vetoes`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireFeatureEnabled(req, AUTONOMY_TOGGLE, AUTONOMY_TOGGLE_LABEL);
      const campaign = await readableCampaign(tenantOf(req), vetoReader(req), req.params.campaignId);
      if (!campaign) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: req.params.campaignId });
      const subject = actingUserOf(req);
      // A window past its deadline is about to be closed by the timer sweep: not
      // listed, so nobody is offered a veto the route would refuse (409).
      const nowMs = Date.now();
      const open = (await listOpenVetoes(tenantOf(req), campaign.id)).filter((r) => Date.parse(r.deadline) > nowMs);
      const windows = [];
      for (const r of open) {
        windows.push({ vetoId: r.vetoId, actionClass: r.actionClass, ruleId: r.ruleId, deadline: r.deadline, runId: r.runId, canVeto: await mayVeto(tenantOf(req), r, subject) });
      }
      res.json({ windows });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/campaigns/:campaignId/vetoes/:vetoId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireFeatureEnabled(req, AUTONOMY_TOGGLE, AUTONOMY_TOGGLE_LABEL);
      const tenantId = tenantOf(req);
      const campaign = await readableCampaign(tenantId, vetoReader(req), req.params.campaignId);
      const record = campaign ? await getVeto(tenantId, campaign.id, req.params.vetoId) : null;
      const subject = actingUserOf(req);
      if (!campaign || !record || !(await mayVeto(tenantId, record, subject))) {
        throw new OpenwopError('not_found', 'Review window not found.', 404, {});
      }
      const reason = cleanString((req.body as { reason?: unknown } | undefined)?.reason, 500, '').trim();
      const out = await castVeto({ tenantId, campaignId: campaign.id, vetoId: record.vetoId, by: subject!, ...(reason ? { reason } : {}) });
      if (!out.ok) {
        throw new OpenwopError('conflict', out.reason === 'past_deadline' ? 'The review window has ended; the step has run or is running.' : 'This review window is already closed.', 409, { reason: out.reason });
      }
      void appendAudit(tenantId, 'campaign.autonomy.veto', { campaignId: campaign.id, vetoId: record.vetoId, runId: record.runId, actionClass: record.actionClass, ruleId: record.ruleId, actor: subject }).catch(() => undefined);
      res.json({ window: { vetoId: out.record.vetoId, status: out.record.status } });
    } catch (err) { next(err); }
  });

  // ── ADR 0945 × 0942 — ask a person to approve publishing ONE asset at ONE
  // fidelity verdict. The org comes from the asset, never the caller; a foreign,
  // unknown or not-needs-review target is one not-found. Only an org writer asks.
  app.post(`${BASE}/creative-reviews`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireFeatureEnabled(req, AUTONOMY_TOGGLE, AUTONOMY_TOGGLE_LABEL);
      const tenantId = tenantOf(req);
      const subject = actingUserOf(req);
      const body = (req.body ?? {}) as { assetId?: unknown; verdictId?: unknown; campaignId?: unknown };
      const assetId = typeof body.assetId === 'string' ? body.assetId : '';
      const verdictId = typeof body.verdictId === 'string' ? body.verdictId : '';
      const asset = assetId ? await getAssetByIdForTenant(tenantId, assetId).catch(() => null) : null;
      if (!subject || !asset?.orgId || !verdictId || !(await hasOrgScope(req, asset.orgId, 'workspace:write'))) {
        throw new OpenwopError('not_found', 'Review not found.', 404, {});
      }
      const out = await requestCreativeReview({
        tenantId, assetId, verdictId, requestedBy: subject,
        ...(typeof body.campaignId === 'string' && body.campaignId ? { campaignId: body.campaignId } : {}),
      });
      res.status(201).json(out);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/campaigns/:campaignId/autonomy`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireFeatureEnabled(req, AUTONOMY_TOGGLE, AUTONOMY_TOGGLE_LABEL);
      const campaign = await loadCampaignScoped(req, 'workspace:write');
      const ifMatch = typeof req.query.ifMatch === 'string' ? req.query.ifMatch : undefined;
      const result = await clearCampaignOverride({
        tenantId: tenantOf(req), orgId: campaign.orgId, campaignId: campaign.id,
        ...(ifMatch !== undefined ? { ifMatch } : {}), actor: actingUserOf(req) ?? 'unknown',
        authorize: loosenNeedsOrgAdmin(req, campaign.orgId),
      });
      res.json({ ...(await describePolicy(tenantOf(req), campaign.orgId, campaign.id)), removed: result.removed, direction: result.direction, loosened: result.loosened });
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
