/**
 * ADR 0482 §3 — the per-workflow budget HTTP surface (host-extension):
 *
 *   GET …/workflows/:workflowId/budget — the budget (null when unset) +
 *                                        today's folded spend
 *   PUT …/workflows/:workflowId/budget — set `{ dailyUsd, hardCap }`;
 *                                        `{ dailyUsd: null }` clears it
 *
 * Owner-gated with the lifecycle-verb 404 posture (`loadOwnedHead` — a
 * foreign/unknown workflow is an indistinguishable 404, no existence oracle).
 * Validation: `dailyUsd` finite and > 0; `hardCap` boolean (default false).
 * Anon tenants may set budgets on workflows they own (ADR 0482 ruling —
 * harmless; the owner gate suffices).
 */

import type { Express, Request } from 'express';
import type { WorkflowDefinition } from '../executor/types.js';
import { OpenwopError } from '../types.js';
import { tenantOf } from '../host/requestSubject.js';
import { getOwned } from '../host/workflowOwnership.js';
import { getRegisteredWorkflowAsync } from '../host/workflowsRegistry.js';
import {
  clearWorkflowBudget, getTodaySpendUsd, getWorkflowBudget, putWorkflowBudget,
} from '../host/workflowBudgets.js';

async function loadOwnedHead(req: Request, workflowId: string): Promise<WorkflowDefinition> {
  const owned = workflowId ? await getOwned(tenantOf(req), workflowId) : null;
  const def = owned ? await getRegisteredWorkflowAsync(workflowId) : null;
  if (!owned || !def) throw new OpenwopError('workflow_not_found', 'Workflow not found in this catalog.', 404, { workflowId });
  return def;
}

const pub = (b: { dailyUsd: number; hardCap: boolean; updatedAt: string }): { dailyUsd: number; hardCap: boolean; updatedAt: string } =>
  ({ dailyUsd: b.dailyUsd, hardCap: b.hardCap, updatedAt: b.updatedAt });

export function registerWorkflowBudgetRoutes(app: Express): void {
  const PATH = '/v1/host/openwop-app/workflows/:workflowId/budget';

  app.get(PATH, async (req, res, next) => {
    try {
      const workflowId = req.params.workflowId ?? '';
      await loadOwnedHead(req, workflowId);
      const tenantId = tenantOf(req);
      const [budget, spentTodayUsd] = await Promise.all([
        getWorkflowBudget(tenantId, workflowId),
        getTodaySpendUsd(tenantId, workflowId),
      ]);
      res.json({ budget: budget ? pub(budget) : null, spentTodayUsd });
    } catch (err) { next(err); }
  });

  app.put(PATH, async (req, res, next) => {
    try {
      const workflowId = req.params.workflowId ?? '';
      await loadOwnedHead(req, workflowId);
      const tenantId = tenantOf(req);
      const body = (req.body ?? {}) as { dailyUsd?: unknown; hardCap?: unknown };
      // `dailyUsd: null` is the explicit CLEAR (the dialog's "Remove budget").
      if (body.dailyUsd === null) {
        const removed = await clearWorkflowBudget(tenantId, workflowId);
        res.json({ budget: null, removed });
        return;
      }
      if (typeof body.dailyUsd !== 'number' || !Number.isFinite(body.dailyUsd) || body.dailyUsd <= 0) {
        throw new OpenwopError('validation_error', 'dailyUsd must be a finite number > 0 (or null to clear the budget).', 400, {});
      }
      if (body.hardCap !== undefined && typeof body.hardCap !== 'boolean') {
        throw new OpenwopError('validation_error', 'hardCap must be a boolean.', 400, {});
      }
      const row = await putWorkflowBudget(tenantId, workflowId, {
        dailyUsd: body.dailyUsd,
        hardCap: body.hardCap === true,
        ...(req.userId ? { updatedBy: req.userId } : {}),
      });
      res.json({ budget: pub(row) });
    } catch (err) { next(err); }
  });
}
