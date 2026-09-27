/**
 * ADR 0477 — the workflow-evaluations HTTP surface (host-extension):
 *
 *   GET    …/workflows/:workflowId/eval-sets                — list
 *   PUT    …/workflows/:workflowId/eval-sets/:evalSetId     — create/replace
 *   GET    …/workflows/:workflowId/eval-sets/:evalSetId     — read
 *   DELETE …/workflows/:workflowId/eval-sets/:evalSetId     — delete (+results)
 *   POST   …/workflows/:workflowId/eval-sets/:evalSetId/run — run all cases
 *   GET    …/workflows/:workflowId/eval-results[?evalSetId] — results, newest first
 *
 * All owner-gated (the lifecycle-verb 404 posture). The run route is
 * run-creating: `runs:create` scope + the POST /v1/runs quota charged PER
 * CASE (`res.locals.runQuotaUnits`) + a concurrency slot per minted run.
 */

import type { Express, Request } from 'express';
import { randomUUID } from 'node:crypto';
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from '../host/index.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { OpenwopError } from '../types.js';
import { tenantOf } from '../host/requestSubject.js';
import { getOwned } from '../host/workflowOwnership.js';
import { listOnlineBuckets } from '../host/workflowEvalOnline.js';
import { getRegisteredWorkflowAsync } from '../host/workflowsRegistry.js';
import { requireProtocolScope } from '../host/protocolAuthorization.js';
import { runQuotaMiddleware, reserveConcurrentSlot } from '../middleware/rateLimit.js';
import { capabilityGatedTypeIdRefusal } from './runs.js';
import {
  validateEvalSetBody, putEvalSet, getEvalSet, listEvalSets, deleteEvalSet, listEvalResults,
} from '../host/workflowEvalSets.js';
import { startEvalRun } from '../host/workflowEvalRunner.js';
import { tenantEvalJudge } from '../host/workflowEvalJudge.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

async function loadOwnedHead(req: Request, workflowId: string): Promise<WorkflowDefinition> {
  const owned = workflowId ? await getOwned(tenantOf(req), workflowId) : null;
  const def = owned ? await getRegisteredWorkflowAsync(workflowId) : null;
  if (!owned || !def) throw new OpenwopError('workflow_not_found', 'Workflow not found in this catalog.', 404, { workflowId });
  return def;
}

export function registerWorkflowEvalRoutes(app: Express, deps: { storage: Storage; hostSuite: HostAdapterSuite }): void {
  const BASE = '/v1/host/openwop-app/workflows/:workflowId';

  app.get(`${BASE}/eval-sets`, async (req, res, next) => {
    try {
      const workflowId = req.params.workflowId ?? '';
      await loadOwnedHead(req, workflowId);
      const rows = await listEvalSets(tenantOf(req), workflowId);
      res.json({ items: rows.map(({ key, tenantId, createdBy, ...pub }) => { void key; void tenantId; void createdBy; return pub; }) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/eval-sets/:evalSetId`, async (req, res, next) => {
    try {
      const workflowId = req.params.workflowId ?? '';
      await loadOwnedHead(req, workflowId);
      const row = await getEvalSet(tenantOf(req), workflowId, req.params.evalSetId ?? '');
      if (!row) throw new OpenwopError('not_found', 'Eval set not found.', 404, {});
      const { key, tenantId, createdBy, ...pub } = row;
      void key; void tenantId; void createdBy;
      res.json(pub);
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/eval-sets/:evalSetId`, async (req, res, next) => {
    try {
      const workflowId = req.params.workflowId ?? '';
      await loadOwnedHead(req, workflowId);
      const evalSetId = req.params.evalSetId ?? '';
      if (!ID_RE.test(evalSetId)) throw new OpenwopError('validation_error', `evalSetId must match ${String(ID_RE)}.`, 400, {});
      const existing = await getEvalSet(tenantOf(req), workflowId, evalSetId);
      const row = validateEvalSetBody(req.body, {
        tenantId: tenantOf(req), workflowId, evalSetId,
        ...(req.userId ? { createdBy: req.userId } : {}),
        ...(existing ? { existing } : {}),
      });
      await putEvalSet(row);
      res.status(existing ? 200 : 201).json({ evalSetId, cases: row.cases.length, requiredForPromote: row.requiredForPromote });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/eval-sets/:evalSetId`, async (req, res, next) => {
    try {
      const workflowId = req.params.workflowId ?? '';
      await loadOwnedHead(req, workflowId);
      const removed = await deleteEvalSet(tenantOf(req), workflowId, req.params.evalSetId ?? '');
      res.json({ removed });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/eval-results`, async (req, res, next) => {
    try {
      const workflowId = req.params.workflowId ?? '';
      await loadOwnedHead(req, workflowId);
      const evalSetId = typeof req.query.evalSetId === 'string' ? req.query.evalSetId : undefined;
      const rows = await listEvalResults(tenantOf(req), workflowId, evalSetId);
      res.json({ items: rows.slice(0, 50).map(({ key, tenantId, startedBy, ...pub }) => { void key; void tenantId; void startedBy; return pub; }) });
    } catch (err) { next(err); }
  });

  // ADR 0480 — the online trend read: daily buckets (counts + opaque run
  // refs), owner-gated 404 posture like every sibling.
  app.get(`${BASE}/eval-sets/:evalSetId/online`, async (req, res, next) => {
    try {
      const workflowId = req.params.workflowId ?? '';
      await loadOwnedHead(req, workflowId);
      const evalSetId = req.params.evalSetId ?? '';
      const rows = await listOnlineBuckets(tenantOf(req), workflowId, evalSetId);
      res.json({ items: rows.map(({ key, tenantId, ...pub }) => { void key; void tenantId; return pub; }) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/eval-sets/:evalSetId/run`, runQuotaMiddleware(), async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'runs:create');
      const workflowId = req.params.workflowId ?? '';
      const def = await loadOwnedHead(req, workflowId);
      const set = await getEvalSet(tenantOf(req), workflowId, req.params.evalSetId ?? '');
      if (!set) throw new OpenwopError('not_found', 'Eval set not found.', 404, {});
      const refusal = capabilityGatedTypeIdRefusal(def.nodes);
      if (refusal) throw refusal;

      const resultId = randomUUID();
      const actingUserId = req.userId ?? req.principal?.principalId;
      // Charge the run quota PER CASE (the ADR 0475 batch discipline).
      res.locals.runQuotaUnits = set.cases.length;
      await startEvalRun(
        { storage: deps.storage, hostSuite: deps.hostSuite, judge: tenantEvalJudge(tenantOf(req)) },
        {
          set, definition: def, resultId,
          ...(actingUserId !== undefined ? { actingUserId } : {}),
          onRunMinted: (runId) => {
            reserveConcurrentSlot(req, runId);
            deps.hostSuite.auditSink.record({
              principalId: req.principal?.principalId ?? 'anonymous',
              action: 'run.create',
              resource: `run:${runId}`,
              outcome: 'success',
              payload: { workflowId, tenantId: set.tenantId, evalSetId: set.evalSetId },
            });
          },
        },
      );
      res.status(202).json({ resultId, cases: set.cases.length });
    } catch (err) { next(err); }
  });
}
