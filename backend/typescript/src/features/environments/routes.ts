/**
 * Environments routes (ADR 0387) — host-extension REST under
 * `/v1/host/openwop-app/environments/*` (non-normative).
 *
 * RBAC (tenant-level, fail-closed): reads = `workspace:read` (any member);
 * every config-changing op (create/protect/snapshot/promote/rollback/apply) =
 * `host:members:manage` (admin/owner). Promote-to-protected is therefore
 * admin-only by construction. Deny-on-throw: a resolver error 403s, never
 * falls through (/architect HIGH). The acting-member header is the app's
 * tenant-level RBAC convention (orgs/cdp precedent).
 */
import type { Request, Response } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, resolveTenantLevelScopes, type Scope, ACT_AS_HEADER } from '../../host/accessControlService.js';
import { requireFeatureEnabled, requireString, optionalString, tenantOf } from '../featureRoute.js';
import { APP_VERSION } from '../../version.js';
import {
  applyToLive,
  createEnvironment,
  ensureDefaultChain,
  getEnvironmentSettings,
  isPendingApproval,
  listEnvironments,
  listEnvironmentsWithDrift,
  listPromotions,
  listSnapshots,
  previewPromotion,
  promote,
  rollback,
  setEnvironmentSettings,
  setProtection,
  snapshotLiveConfig,
  type EnvironmentProtection,
  type PromotionOutcome,
} from './environmentsService.js';
import { listConfigDomains } from '../../host/configDomains.js';
import { registerEnvironmentPromotionGate } from './promotionApproval.js';

const TOGGLE = { toggleId: 'environments', label: 'Environments' };
const BASE = '/v1/host/openwop-app/environments';

const callerSubjectOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

async function requireEnvScope(req: Request, scope: Scope): Promise<{ subject: string; tenantId: string }> {
  await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
  const subject = callerSubjectOf(req);
  if (!subject) throw new OpenwopError('unauthenticated', 'Environments requires an authenticated principal.', 401, {});
  const tenantId = tenantOf(req);
  const actingMember = req.header(ACT_AS_HEADER);
  // ADR 0731 — resolve the SESSION caller, and resolve them with the TENANT-LEVEL
  // resolver. This used to pass `{}` when there was no X-Act-As header, and with
  // neither `memberId` nor `subject` `resolveEffectiveAccess` returns
  // `basis:'tenant-owner'` with OWNER_SCOPES — so the scope check below passed
  // unconditionally and the 403 this file's header advertises could never fire
  // (MEASURED: a `viewer` member created an entity type and wrote a row, both 201).
  // `resolveSubjectScopesUnion` rather than `resolveEffectiveAccess({ subject })`:
  // these surfaces are workspace-scoped, and the org-scoped first-match resolver is
  // non-deterministic for a subject with memberships in several orgs (its own
  // docblock says so). `resolveTenantLevelScopes` = that union PLUS the ADR 0372
  // exit: a single-principal tenant (anon sandbox / personal) is its own owner;
  // a SHARED `ws:` workspace fails closed, which is the escalation being fixed.
  const access = actingMember
    ? await resolveEffectiveAccess(tenantId, { memberId: actingMember.trim() })
    : await resolveTenantLevelScopes(tenantId, subject);
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  }
  return { subject, tenantId };
}

/** Send a promote/rollback outcome: 201 for an applied pointer move (the pre-H2
 *  shape), or a typed 202 pending-approval when the tenant's gate intercepted it
 *  (nothing moved). The 202 body carries the shared-inbox approval; the FE UX
 *  pass will render its own confirmation from it (CLAUDE.md deferral). */
function sendPromotionOutcome(res: Response, outcome: PromotionOutcome): void {
  if (isPendingApproval(outcome)) {
    res.status(202).json({ status: 'pending_approval', approval: outcome.pendingApproval });
    return;
  }
  res.status(201).json(outcome);
}

export function registerEnvironmentsRoutes({ app }: RouteDeps): void {
  // Register the environment-promotion decision handler on the core approvals
  // hook (feature → core; core dispatches claim/reject for this kind here).
  registerEnvironmentPromotionGate();

  app.get(`${BASE}`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEnvScope(req, 'workspace:read');
      // Drift is computed on demand only (?drift=1) — never on every list
      // (the O(config) fan-out /architect flagged).
      const withDrift = req.query.drift === '1' || req.query.drift === 'true';
      const environments = withDrift ? await listEnvironmentsWithDrift(tenantId) : await listEnvironments(tenantId);
      // ADR 0479 — the domain registry (id/label/restore register) rides the
      // list read so the UI labels apply-only "removed" counts honestly
      // without hardcoding domain ids.
      const domains = listConfigDomains().map((d) => ({ id: d.id, label: d.label, restore: d.restore }));
      res.json({ environments, domains, appVersion: APP_VERSION });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEnvScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as { name?: unknown; order?: unknown; protection?: unknown };
      const rec = await createEnvironment({
        tenantId,
        name: requireString(body.name, 'name'),
        ...(typeof body.order === 'number' ? { order: body.order } : {}),
        ...(optionalString(body.protection) !== undefined ? { protection: body.protection as EnvironmentProtection } : {}),
      });
      res.status(201).json(rec);
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/ensure-chain`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEnvScope(req, 'host:members:manage');
      res.json({ environments: await ensureDefaultChain(tenantId) });
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/:name/protection`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEnvScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as { protection?: unknown };
      const rec = await setProtection({
        tenantId,
        name: req.params.name,
        protection: requireString(body.protection, 'protection') as EnvironmentProtection,
      });
      if (!rec) throw new OpenwopError('not_found', 'Environment not found.', 404, { name: req.params.name });
      res.json(rec);
    } catch (err) { next(err); }
  });

  // ── Settings (H2 promotion-approval gate) ──
  app.get(`${BASE}/settings`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEnvScope(req, 'workspace:read');
      res.json(await getEnvironmentSettings(tenantId));
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/settings`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEnvScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as { requireApprovalForPromotion?: unknown };
      if (body.requireApprovalForPromotion !== undefined && typeof body.requireApprovalForPromotion !== 'boolean') {
        throw new OpenwopError('validation_error', 'requireApprovalForPromotion must be a boolean.', 400, { field: 'requireApprovalForPromotion' });
      }
      const updated = await setEnvironmentSettings(tenantId, {
        ...(typeof body.requireApprovalForPromotion === 'boolean' ? { requireApprovalForPromotion: body.requireApprovalForPromotion } : {}),
      });
      res.json(updated);
    } catch (err) { next(err); }
  });

  // ── Snapshots ──
  app.get(`${BASE}/snapshots`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEnvScope(req, 'workspace:read');
      res.json({ snapshots: await listSnapshots(tenantId) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/snapshots`, async (req, res, next) => {
    try {
      const { subject, tenantId } = await requireEnvScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as { sourceEnv?: unknown };
      const rec = await snapshotLiveConfig({
        tenantId,
        sourceEnv: optionalString(body.sourceEnv) ?? null,
        createdBy: subject,
      });
      res.status(201).json(rec);
    } catch (err) { next(err); }
  });

  // ── Promote / rollback / apply ──
  app.post(`${BASE}/preview`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEnvScope(req, 'workspace:read');
      const body = (req.body ?? {}) as { toEnv?: unknown; snapshotHash?: unknown };
      const preview = await previewPromotion({
        tenantId,
        toEnvName: requireString(body.toEnv, 'toEnv'),
        snapshotHash: requireString(body.snapshotHash, 'snapshotHash'),
      });
      res.json(preview);
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/promote`, async (req, res, next) => {
    try {
      const { subject, tenantId } = await requireEnvScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as { fromEnv?: unknown; toEnv?: unknown };
      const result = await promote({
        tenantId,
        fromEnvName: requireString(body.fromEnv, 'fromEnv'),
        ...(optionalString(body.toEnv) !== undefined ? { toEnvName: optionalString(body.toEnv) } : {}),
        actor: subject,
      });
      sendPromotionOutcome(res, result);
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/rollback`, async (req, res, next) => {
    try {
      const { subject, tenantId } = await requireEnvScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as { env?: unknown; snapshotHash?: unknown };
      const result = await rollback({
        tenantId,
        envName: requireString(body.env, 'env'),
        snapshotHash: requireString(body.snapshotHash, 'snapshotHash'),
        actor: subject,
      });
      sendPromotionOutcome(res, result);
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/apply`, async (req, res, next) => {
    try {
      const { subject, tenantId } = await requireEnvScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as { snapshotHash?: unknown };
      const result = await applyToLive({
        tenantId,
        snapshotHash: requireString(body.snapshotHash, 'snapshotHash'),
        actor: subject,
      });
      if (result.pendingApproval) {
        res.status(202).json({ status: 'pending_approval', approval: result.pendingApproval });
        return;
      }
      res.json(result);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/promotions`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEnvScope(req, 'workspace:read');
      res.json({ promotions: await listPromotions(tenantId) });
    } catch (err) { next(err); }
  });
}
