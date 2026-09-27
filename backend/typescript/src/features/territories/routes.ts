/**
 * Sales Territory Management — REST routes (ADR 0272 Phase 1).
 *
 * Host-extension surface under `/v1/host/openwop-app/territories/orgs/:orgId/*`
 * (non-normative — no OpenWOP RFC; rides Accepted RFC 0049 scopes). Every route
 * is gated by the shared `authorizeOrgScope` (toggle `territories` ON + the
 * caller's RFC 0049 scope in the PATH org, IDOR-guarded, fail-closed). Reads
 * need `workspace:read`; writes `workspace:write`; model activation/archival the
 * management scope `host:territories:manage` (built-in admin/owner only).
 *
 * @see docs/adr/0272-sales-territory-management.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import type { Scope } from '../../host/accessControlService.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { createTerritoryTransitionApproval, findPendingTerritoryTransitionApproval } from '../../host/approvalService.js';
import {
  createType,
  listTypes,
  createModel,
  listModels,
  getModel,
  getActiveModelId,
  listTerritories,
  getTerritory,
  createTerritory,
  updateTerritory,
  assertModelPurgeable,
  deleteArchivedModel,
} from './entities/territories.js';
import { listRules, createRule, deleteRule, previewModel, reassignActiveModel, deleteModelAssignmentData } from './entities/assignment.js';
import { listQuotas, setQuota, deleteQuota, computeAttainment, deleteModelQuotas } from './entities/quota.js';
import { invalidateTerritoryIndex } from './visibility.js';
import { territoryMutated } from './emit.js';

const TOGGLE_ID = 'territories';
const LABEL = 'Territories';

/** Toggle + org-scoped RBAC gate (the shared `authorizeOrgScope`). */
const authorize = (req: Request, scope: Scope) => authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, scope);

export function registerTerritoryRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/territories/orgs/:orgId';

  // ── Territory types ──
  app.get(`${BASE}/types`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json({ types: await listTypes(tenantId, orgId) });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/types`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const type = await createType(tenantId, orgId, (req.body ?? {}) as Record<string, unknown>, user.userId);
      res.status(201).json(type);
    } catch (err) {
      next(err);
    }
  });

  // ── Models ──
  app.get(`${BASE}/models`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json({ models: await listModels(tenantId, orgId), activeModelId: await getActiveModelId(tenantId, orgId) });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/models`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const model = await createModel(tenantId, orgId, (req.body ?? {}) as Record<string, unknown>, user.userId);
      territoryMutated({ entity: 'model', verb: 'created', tenantId, orgId, actor: user.userId, entityId: model.modelId });
      res.status(201).json(model);
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/models/:modelId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json(await getModel(tenantId, orgId, req.params.modelId));
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/active`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json({ activeModelId: await getActiveModelId(tenantId, orgId) });
    } catch (err) {
      next(err);
    }
  });

  // CFP-1 (D9) — activating/archiving a territory model has an ORG-WIDE blast
  // radius (it changes CRM record visibility + forecasting for the whole org), so
  // it no longer mutates on a naked button click. These routes now SUBMIT the
  // transition for review: they queue a `territory-model-transition` approval on
  // the shared reviews inbox (idempotent per model) and return `202 { review }`;
  // the model changes state ONLY when a manager claims the review, whose decision
  // core dispatches to this feature's gate handler (`modelTransitionApproval.ts`).
  // No HTTP route activates/archives a model without the gate. (The ctx.features
  // workflow surface can still apply transitions — that is the ADR 0208 governed
  // lane, where the approval gate lives in the CHAIN; author chains with a
  // core.approvalGate before the transition node.)
  for (const transition of ['activate', 'archive'] as const) {
    app.post(`${BASE}/models/:modelId/${transition}`, async (req, res, next) => {
      try {
        const { orgId, tenantId } = await authorize(req, 'host:territories:manage');
        const modelId = req.params.modelId;
        const model = await getModel(tenantId, orgId, modelId); // 404 + IDOR before queueing
        // Fail-fast on an illegal transition (mirrors activateModel/archiveModel)
        // so we never queue a review that can only ever fail on apply.
        if (transition === 'activate' && model.state === 'archived') {
          throw new OpenwopError('validation_error', 'An archived model cannot be re-activated; clone it into a new planning model.', 409, { modelId });
        }
        if (transition === 'archive' && model.state === 'archived') {
          throw new OpenwopError('conflict', 'This model is already archived.', 409, { modelId });
        }
        const existing = await findPendingTerritoryTransitionApproval(tenantId, modelId);
        const review = existing ?? await createTerritoryTransitionApproval({
          tenantId, orgId, modelId, transition,
          proposal: transition === 'activate'
            ? `Activate territory model “${model.name}” (org-wide record visibility change)`
            : `Archive territory model “${model.name}”`,
        });
        res.status(202).json({ review: { approvalId: review.approvalId, status: review.status } });
      } catch (err) {
        next(err);
      }
    });
  }

  // Purge an archived model + ALL its descendants (TERR-DATA-2 — the retention
  // path; without it archived models accumulate forever against `perOrgModels`).
  // Children-first cascade: a mid-purge failure leaves the (inert) archived model
  // retryable rather than stranding unreachable orphan rows. `deleteArchivedModel`
  // is the lifecycle gate (409 unless stored `archived` and not the active model).
  app.delete(`${BASE}/models/:modelId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'host:territories:manage');
      const modelId = req.params.modelId;
      await assertModelPurgeable(tenantId, orgId, modelId); // gate BEFORE the child cascade — never wipe a live model's rows then 409
      const childRows =
        (await deleteModelAssignmentData(tenantId, orgId, modelId)) +
        (await deleteModelQuotas(tenantId, orgId, modelId));
      const modelRows = await deleteArchivedModel(tenantId, orgId, modelId, user.userId);
      territoryMutated({ entity: 'model', verb: 'purged', tenantId, orgId, actor: user.userId, entityId: modelId });
      res.json({ success: true, removed: childRows + modelRows });
    } catch (err) {
      next(err);
    }
  });

  // ── Territories (hierarchy) ──
  app.get(`${BASE}/models/:modelId/territories`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json({ territories: await listTerritories(tenantId, orgId, req.params.modelId) });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/models/:modelId/territories`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const territory = await createTerritory(tenantId, orgId, req.params.modelId, (req.body ?? {}) as Record<string, unknown>, user.userId);
      res.status(201).json(territory);
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${BASE}/models/:modelId/territories/:territoryId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      await getTerritory(tenantId, orgId, req.params.modelId, req.params.territoryId); // 404 before mutate
      const territory = await updateTerritory(tenantId, orgId, req.params.modelId, req.params.territoryId, (req.body ?? {}) as Record<string, unknown>, user.userId);
      res.json(territory);
    } catch (err) {
      next(err);
    }
  });

  // ── Assignment rules (P2) ──
  app.get(`${BASE}/models/:modelId/rules`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json({ rules: await listRules(tenantId, orgId, req.params.modelId) });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/models/:modelId/rules`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const rule = await createRule(tenantId, orgId, req.params.modelId, (req.body ?? {}) as Record<string, unknown>);
      territoryMutated({ entity: 'rule', verb: 'created', tenantId, orgId, actor: user.userId, entityId: rule.ruleId, changed: [req.params.modelId] });
      res.status(201).json(rule);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/models/:modelId/rules/:ruleId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      await deleteRule(tenantId, orgId, req.params.modelId, req.params.ruleId);
      territoryMutated({ entity: 'rule', verb: 'deleted', tenantId, orgId, actor: user.userId, entityId: req.params.ruleId, changed: [req.params.modelId] });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Dry-run: what would this model's rules assign? (no writes)
  app.get(`${BASE}/models/:modelId/preview`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json(await previewModel(tenantId, orgId, req.params.modelId));
    } catch (err) {
      next(err);
    }
  });

  // Re-materialize the active model's assignments (keeps records created after
  // activation in sync — there is no in-process CRM-write subscribe seam).
  app.post(`${BASE}/reassign`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'host:territories:manage');
      const summary = await reassignActiveModel(tenantId, orgId);
      if (!summary) throw new OpenwopError('validation_error', 'No active territory model to reassign.', 409, {});
      invalidateTerritoryIndex(tenantId, orgId); // A1: re-sync on the SAME model ⇒ index is stale, drop it now
      territoryMutated({ entity: 'assignment', verb: 'reassigned', tenantId, orgId, actor: user.userId, entityId: orgId });
      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  // ── Quotas + attainment (P3) ──
  app.get(`${BASE}/models/:modelId/quotas`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      const period = typeof req.query.period === 'string' ? req.query.period : undefined;
      res.json({ quotas: await listQuotas(tenantId, orgId, req.params.modelId, period) });
    } catch (err) {
      next(err);
    }
  });

  // Upsert a territory's quota for a period (idempotent PUT → 200).
  app.put(`${BASE}/models/:modelId/territories/:territoryId/quota`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const quota = await setQuota(tenantId, orgId, req.params.modelId, req.params.territoryId, (req.body ?? {}) as Record<string, unknown>);
      territoryMutated({ entity: 'quota', verb: 'set', tenantId, orgId, actor: user.userId, entityId: quota.quotaId, changed: [req.params.territoryId] });
      res.json(quota);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/models/:modelId/territories/:territoryId/quota`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const period = typeof req.query.period === 'string' ? req.query.period : '';
      if (!/^\d{4}-(Q[1-4]|(0[1-9]|1[0-2]))$/.test(period)) throw new OpenwopError('validation_error', 'A valid `period` (YYYY-Qn or YYYY-MM) query param is required.', 400, {});
      await deleteQuota(tenantId, orgId, req.params.modelId, req.params.territoryId, period);
      territoryMutated({ entity: 'quota', verb: 'deleted', tenantId, orgId, actor: user.userId, entityId: `${req.params.territoryId}:${period}` });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/models/:modelId/attainment`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:read');
      const period = typeof req.query.period === 'string' ? req.query.period : undefined;
      res.json(await computeAttainment(tenantId, orgId, req.params.modelId, period, user.userId)); // A2: viewer-scoped
    } catch (err) {
      next(err);
    }
  });
}
