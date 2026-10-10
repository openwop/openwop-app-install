/**
 * ADR 0773 — builder-pair routes, host-extension under
 * /v1/host/openwop-app/builder-pair/* (non-normative; no RFC).
 *
 *   PUT   /builder-pair/context                       — record what the builder shows (written in beforeSend)
 *   GET   /builder-pair/suggestions/:conversationId    — this conversation's active suggestion (point get)
 *   GET   /builder-pair/suggestions?workflowId=        — suggestions shared with the room for a workflow
 *   PATCH /builder-pair/suggestions/:conversationId    — keep/drop per op, share with room
 *
 * Every route: toggle (uniform 404 when off) → the ADR 0770 D1 workflow gate
 * (read or write) → the SAME service function the chat tools call.
 */

import type { Request, Response } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireWorkflowRead, requireWorkflowWrite } from '../../host/workflowWriteAuthority.js';
import { personalTenantOf } from '../../host/requestSubject.js';
import { requireFeatureEnabled, requireString, tenantOf } from '../featureRoute.js';
import { vendorPath } from '../../middleware/protocolVersion.js';
import { BUILDER_PAIR_TOGGLE_ID, writePairContext, readSuggestionFor, patchSuggestion, suggestFromChain, type PairRefusal, type PairWho, type WorkflowScope } from './pairService.js';
import { resolveCallerDisplayName } from '../../host/chatContext.js';
import { listRoomSuggestions } from './pairStores.js';

const LABEL = 'Builder pairing';
// Registered at the canonical, version-agnostic `/host/openwop-app/builder-pair/…`
// root (ADR 0652).
const BASE = '/builder-pair';

const STATUS: Record<PairRefusal['code'], number> = {
  feature_disabled: 404, not_found: 404, acting_user_required: 401, no_pairing_context: 404, replay_refused: 409,
  forbidden: 403, workflow_head_moved: 409, invalid_ops: 400, validation_error: 400,
};
const ERROR_CODE: Record<PairRefusal['code'], ConstructorParameters<typeof OpenwopError>[0]> = {
  feature_disabled: 'not_found', not_found: 'not_found', acting_user_required: 'unauthenticated', no_pairing_context: 'not_found',
  replay_refused: 'conflict', forbidden: 'forbidden_scope', workflow_head_moved: 'conflict', invalid_ops: 'validation_error', validation_error: 'validation_error',
};

function fail(r: PairRefusal): never {
  throw new OpenwopError(ERROR_CODE[r.code], r.message, STATUS[r.code], { reason: r.code, ...(r.details ?? {}) });
}

/** `granted` = the scopes this route's ADR 0770 D1 gate already enforced. */
function whoOf(req: Request, granted: readonly WorkflowScope[]): PairWho {
  const actingUserId = req.userId ?? req.principal?.principalId;
  const personalTenant = personalTenantOf(req);
  return {
    tenantId: tenantOf(req), granted: new Set(granted),
    ...(actingUserId ? { actingUserId } : {}), ...(personalTenant ? { personalTenant } : {}),
  };
}

const idParam = (req: Request): string => {
  const v = req.params.conversationId;
  if (typeof v !== 'string' || !v || v.length > 200) throw new OpenwopError('validation_error', 'conversationId is required.', 400);
  return v;
};

export function registerBuilderPairRoutes(deps: RouteDeps): void {
  const { app, storage } = deps;

  app.put(vendorPath(`${BASE}/context`), async (req: Request, res: Response, next) => {
    try {
      await requireFeatureEnabled(req, BUILDER_PAIR_TOGGLE_ID, LABEL);
      await requireWorkflowRead(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const out = await writePairContext(storage, whoOf(req, ['workspace:read']), {
        conversationId: requireString(body.conversationId, 'conversationId'),
        workflowId: requireString(body.workflowId, 'workflowId'),
        selection: body.selection,
        lastRunId: body.lastRunId,
        conversationRunId: body.conversationRunId,
      });
      if ('refused' in out) fail(out);
      res.json({ workflowId: out.workflowId, selection: out.selection, droppedIds: out.droppedIds, lastRunId: out.lastRunId ?? null });
    } catch (err) {
      next(err);
    }
  });

  app.get(vendorPath(`${BASE}/suggestions/:conversationId`), async (req: Request, res: Response, next) => {
    try {
      await requireFeatureEnabled(req, BUILDER_PAIR_TOGGLE_ID, LABEL);
      await requireWorkflowRead(req);
      const s = await readSuggestionFor(whoOf(req, ['workspace:read']), idParam(req));
      if (!s) throw new OpenwopError('not_found', 'Suggestion not found.', 404);
      res.json(s);
    } catch (err) {
      next(err);
    }
  });

  app.get(vendorPath(`${BASE}/suggestions`), async (req: Request, res: Response, next) => {
    try {
      await requireFeatureEnabled(req, BUILDER_PAIR_TOGGLE_ID, LABEL);
      await requireWorkflowRead(req);
      const workflowId = requireString(req.query.workflowId, 'workflowId');
      const tenantId = tenantOf(req);
      res.json({
        suggestions: await listRoomSuggestions(tenantId, workflowId, whoOf(req, ['workspace:read']).actingUserId,
          (userId) => resolveCallerDisplayName(tenantId, userId)),
      });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0773 G-05d — draw a chain template as a ghost suggestion on an empty draft.
  app.post(vendorPath(`${BASE}/suggestions/from-chain`), async (req: Request, res: Response, next) => {
    try {
      await requireFeatureEnabled(req, BUILDER_PAIR_TOGGLE_ID, LABEL);
      await requireWorkflowWrite(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const out = await suggestFromChain(whoOf(req, ['workspace:read', 'workspace:write']), {
        conversationId: requireString(body.conversationId, 'conversationId'),
        workflowId: requireString(body.workflowId, 'workflowId'),
        chainId: requireString(body.chainId, 'chainId'),
        params: body.params,
      });
      if ('refused' in out) fail(out);
      res.status(201).json(out);
    } catch (err) {
      next(err);
    }
  });

  app.patch(vendorPath(`${BASE}/suggestions/:conversationId`), async (req: Request, res: Response, next) => {
    try {
      await requireFeatureEnabled(req, BUILDER_PAIR_TOGGLE_ID, LABEL);
      await requireWorkflowWrite(req);
      const out = await patchSuggestion(whoOf(req, ['workspace:read', 'workspace:write']), idParam(req), (req.body ?? {}) as Record<string, unknown>);
      if ('refused' in out) fail(out);
      res.json(out);
    } catch (err) {
      next(err);
    }
  });
}
