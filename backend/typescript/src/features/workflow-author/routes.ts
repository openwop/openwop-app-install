/**
 * AI Workflow Author routes (ADR 0072) — host-extension under
 * /v1/host/openwop-app/workflow-author/*. **Always-on** (no toggle gate; the
 * builder is a core surface and AI authoring rides alongside it).
 *
 *   POST /v1/host/openwop-app/workflow-author/draft   — author a workflow from a
 *        natural-language intent: dispatches the pinned meta-workflow run (a
 *        built-in catalog workflow) and returns its runId. The caller subscribes;
 *        the `persist` node's output carries the authored workflowId.
 *   GET  /v1/host/openwop-app/workflow-author/catalog — the authoring menu.
 *
 * The run is dispatched through the SAME core seam as `POST /v1/runs`
 * (`host/runDispatch.ts`); the authored definition is persisted through the
 * SHARED validator (ADR 0072 "one validation path"). The meta-workflow itself is
 * a feature **built-in** (`feature.ts` → `builtinWorkflows`), resolved by the
 * catalog — not registered into the in-memory builder registry.
 *
 * @see docs/adr/0072-ai-workflow-authoring.md
 */

import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { seedRunVariables } from '../../host/variablesRuntime.js';
import { buildRunRecord, dispatchRunInBackground } from '../../host/runDispatch.js';
import { insertRunWithStartContext } from '../../host/runInsert.js';
import { runQuotaMiddleware, reserveConcurrentSlot } from '../../middleware/rateLimit.js';
import { requireString, optionalString, tenantOf } from '../featureRoute.js';
import { buildAuthoringCatalog } from './workflowAuthorService.js';
import { WORKFLOW_AUTHOR_META_ID } from './metaWorkflow.js';

export function registerWorkflowAuthorRoutes(deps: RouteDeps): void {
  const { app, storage, hostSuite } = deps;

  app.get('/v1/host/openwop-app/workflow-author/catalog', (_req, res, next) => {
    try {
      res.json(buildAuthoringCatalog());
    } catch (err) {
      next(err);
    }
  });

  // The draft dispatch spawns a real LLM-backed run, so it carries the same
  // per-IP run-creation quota as POST /v1/runs (cost-abuse guard).
  app.post('/v1/host/openwop-app/workflow-author/draft', runQuotaMiddleware(), async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const intent = requireString(body.intent, 'intent');
      const provider = optionalString(body.provider);
      const model = optionalString(body.model);
      const maxAttempts = typeof body.maxAttempts === 'number' && body.maxAttempts > 0 ? Math.floor(body.maxAttempts) : undefined;

      const wf = await hostSuite.workflowCatalog.getWorkflow(WORKFLOW_AUTHOR_META_ID);
      if (!wf) {
        throw new OpenwopError('internal_error', 'workflow-author meta-workflow is not registered.', 500);
      }

      const tenantId = tenantOf(req);
      const actingUserId = req.userId ?? req.principal?.principalId;
      const inputs: Record<string, unknown> = {
        intent,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(maxAttempts ? { maxAttempts } : {}),
      };
      const run = buildRunRecord({
        workflowId: WORKFLOW_AUTHOR_META_ID,
        tenantId,
        inputs,
        metadata: { source: 'workflow-author' },
        ...(actingUserId ? { actingUserId } : {}),
      });
      // ADR 0099 — single run-insert seam stamps the compaction decision.
      await insertRunWithStartContext(storage, run);
      seedRunVariables(run.runId, wf.definition.variables, inputs);
      // Tie the rate-limiter's reserved concurrency slot to this runId so the
      // runLifecycle bus auto-releases it on terminal status (mirrors POST /v1/runs).
      reserveConcurrentSlot(req, run.runId);
      hostSuite.auditSink.record({
        principalId: actingUserId ?? 'anonymous',
        action: 'workflow-author.draft',
        resource: `run:${run.runId}`,
        outcome: 'success',
        payload: { workflowId: WORKFLOW_AUTHOR_META_ID, tenantId },
      });

      res.status(201).json({
        runId: run.runId,
        workflowId: WORKFLOW_AUTHOR_META_ID,
        status: 'pending',
        eventsUrl: `${req.protocol}://${req.get('host')}/v1/runs/${run.runId}/events`,
        statusUrl: `${req.protocol}://${req.get('host')}/v1/runs/${run.runId}`,
      });

      dispatchRunInBackground({ storage, run, definition: wf.definition, hostSuite });
    } catch (err) {
      next(err);
    }
  });
}
