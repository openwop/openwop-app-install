/**
 * Per-user UI-state routes (ADR 0071) — host-extension, non-normative.
 *
 *   GET    /v1/host/openwop-app/ui-state?resourceType=&resourceId=
 *   PUT    /v1/host/openwop-app/ui-state          { resourceType, resourceId, key, value }
 *   DELETE /v1/host/openwop-app/ui-state/:resourceType/:resourceId/:key
 *
 * Small, durable, NON-authoritative display preferences (selected artifact
 * revision, compare mode, expanded panels, dismissed notices). Authorization is
 * structural: every row is keyed by the AUTHENTICATED caller's subjectRef
 * derived from the session — the client never supplies it — so a caller can only
 * ever read/write/delete their OWN rows. No cross-subject or cross-tenant read.
 *
 * @see src/host/uiStateStore.ts
 */

import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import { putUiState, listUiState, deleteUiState } from '../host/uiStateStore.js';

interface Deps { storage: unknown }

function tenantOf(req: Request): string {
  return (req as { tenantId?: string }).tenantId ?? '_anon';
}
/** The caller's own subject — ALWAYS from the session, never the request body. */
function subjectOf(req: Request): string {
  return `user:${req.userId ?? req.principal?.principalId ?? '_anon'}`;
}

export function registerUiStateRoutes(app: Express, _deps: Deps): void {
  app.get('/v1/host/openwop-app/ui-state', async (req, res, next) => {
    try {
      const resourceType = typeof req.query.resourceType === 'string' ? req.query.resourceType : undefined;
      const resourceId = typeof req.query.resourceId === 'string' ? req.query.resourceId : undefined;
      const items = await listUiState(tenantOf(req), subjectOf(req), resourceType, resourceId);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  app.put('/v1/host/openwop-app/ui-state', async (req, res, next) => {
    try {
      const b = (req.body ?? {}) as { resourceType?: unknown; resourceId?: unknown; key?: unknown; value?: unknown };
      if (typeof b.resourceType !== 'string' || typeof b.resourceId !== 'string' || typeof b.key !== 'string') {
        throw new OpenwopError('validation_error', 'resourceType, resourceId, and key are required strings.', 400, {});
      }
      const entry = await putUiState(tenantOf(req), subjectOf(req), b.resourceType, b.resourceId, b.key, b.value);
      res.status(200).json(entry);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/ui-state/:resourceType/:resourceId/:key', async (req, res, next) => {
    try {
      const { resourceType, resourceId, key } = req.params;
      const removed = await deleteUiState(tenantOf(req), subjectOf(req), resourceType, resourceId, key);
      res.status(removed ? 204 : 404).end();
    } catch (err) {
      next(err);
    }
  });
}
