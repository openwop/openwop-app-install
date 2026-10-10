/**
 * AI Workflow Author routes (ADR 0072) — host-extension under
 * /v1/host/openwop-app/workflow-author/*. **Always-on** (no toggle gate; the
 * builder is a core surface and AI authoring rides alongside it).
 *
 *   POST /v1/host/openwop-app/workflow-author/draft   — author a workflow from a
 *        natural-language intent: dispatches the meta-workflow run (resolved from
 *        the chain pack, ADR 0472 P4) and returns its runId. The caller subscribes;
 *        the `persist` node's output carries the authored workflowId.
 *   GET  /v1/host/openwop-app/workflow-author/catalog — the authoring menu.
 *
 * The run is dispatched through the SAME core seam as `POST /v1/runs`
 * (`host/runDispatch.ts`); the authored definition is persisted through the
 * SHARED validator (ADR 0072 "one validation path"). The meta-workflow itself is
 * **chain-backed** (ADR 0472 P4 / ADR 0596 doc-rot fix): `metaWorkflow.ts` calls
 * `registerChainBackedWorkflow(WORKFLOW_AUTHOR_META_ID)`, and the definition is
 * EXPANDED from the RFC 0013 pack `core.openwop.workflows.workflow-author` under
 * the original id, so the ignition + replay resolve unchanged. It is NOT a
 * `builtinWorkflows` pin — that field no longer exists on `BackendFeature`.
 *
 * @see docs/adr/0072-ai-workflow-authoring.md
 */

import type { NextFunction, Request, Response } from 'express';
import { OpenwopError } from '../../types.js';
import { ownerStampFromRequest } from '../../host/runOwner.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { seedRunVariables } from '../../host/variablesRuntime.js';
import { buildRunRecord, dispatchRunInBackground } from '../../host/runDispatch.js';
import { insertRunWithStartContext } from '../../host/runInsert.js';
import { withRunLimit } from '../../host/runLimitSeam.js';
import { runQuotaMiddleware, reserveConcurrentSlot } from '../../middleware/rateLimit.js';
import { requireString, optionalString, tenantOf } from '../featureRoute.js';
import { resolveDisabledPacks } from '../../host/packVisibility.js';
import { buildAuthoringCatalog } from './workflowAuthorService.js';
import { WORKFLOW_AUTHOR_META_ID } from './metaWorkflow.js';
import { runLinks } from '../../middleware/protocolVersion.js';
import { requireWorkflowWrite } from '../../host/workflowWriteAuthority.js';
import { requireProtocolScope } from '../../host/protocolAuthorization.js';
import { personalTenantOf } from '../../host/requestSubject.js';

export function registerWorkflowAuthorRoutes(deps: RouteDeps): void {
  const { app, storage, hostSuite } = deps;

  app.get('/host/openwop-app/workflow-author/catalog', async (req, res, next) => {
    try {
      // ADR 0194 P3 — the author plans against the same tenant-curated menu the
      // palette shows (host/packVisibility seam; never a marketplace import).
      res.json(buildAuthoringCatalog({ disabledPacks: await resolveDisabledPacks(tenantOf(req)) }));
    } catch (err) {
      next(err);
    }
  });

  // The draft dispatch spawns a real LLM-backed run, so it carries the same
  // per-IP run-creation quota as POST /v1/runs (cost-abuse guard).
  // ADR 0822 D2 — the run this starts calls the LLM on the workspace's keys and
  // then WRITES a workflow, so it carries the builder's write gate
  // (provenance-classified: `owk_` and tenant-owner env keys pass exactly as on
  // the builder routes) before any run row exists — and BEFORE the run quota, so
  // a refused caller spends none of it (grade-code WFAC-21). `runs:create` is
  // parity with `POST /v1/runs`; it narrows `owk_` keys in the default posture
  // and is not what refuses a Viewer — `workspace:write` is.
  const draftAuthority = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      await requireWorkflowWrite(req);
      await requireProtocolScope(req, 'runs:create');
      next();
    } catch (err) {
      next(err);
    }
  };
  app.post('/host/openwop-app/workflow-author/draft', draftAuthority, runQuotaMiddleware(), async (req, res, next) => {
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
      const personalTenant = personalTenantOf(req);
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
        // ADR 0822 D1 — the request's own personal tenant, stamped like
        // `POST /v1/runs` does, so the in-run `persistDraft` gate can grant a
        // solo user's own workspace from the same value (never re-derived).
        ...(personalTenant ? { personalTenant } : {}),
        owner: ownerStampFromRequest(req),
      });
      // ADR 0099 — single run-insert seam stamps the compaction decision.
      // ADR 0551 P1 — `enqueueDispatch`: this route promises a start and then
      // kicks the wakeup hint, so the intent is made durable with the run.
      // ADR 0821 P5 follow-up — the plan's monthly run limit (a no-op until wired).
      await withRunLimit(tenantId, () => insertRunWithStartContext(storage, run, { definition: wf.definition, enqueueDispatch: true }));
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
        // ADR 0669: links follow the cut (`runLinks`), never a `/v1` literal.
        ...runLinks(`${req.protocol}://${req.get('host')}`, run.runId, run.tenantId),
      });

      dispatchRunInBackground({ storage, run, definition: wf.definition, hostSuite });
    } catch (err) {
      next(err);
    }
  });
}
