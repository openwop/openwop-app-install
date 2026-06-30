/**
 * Vendor-prefixed node-catalog endpoint used by the builder palette.
 *
 *   GET /v1/host/openwop-app/node-catalog
 *
 * Returns every resolvable node typeId on this host (locally-registered sample
 * modules + pack-declared nodes). The catalog-building logic lives in
 * `host/nodeCatalogBuilder.ts` — the SINGLE source shared with the AI
 * workflow-author feature (ADR 0072) so the authoring brain plans against the
 * exact catalog the palette renders.
 *
 * The endpoint returns metadata only — no executable code is sent.
 */

import type { Express } from 'express';
import { OpenwopError } from '../types.js';
import { buildNodeCatalog } from '../host/nodeCatalogBuilder.js';

export function registerNodeCatalogRoute(app: Express): void {
  app.get('/v1/host/openwop-app/node-catalog', (_req, res, next) => {
    try {
      res.json({ nodes: buildNodeCatalog() });
    } catch (err) {
      next(err instanceof OpenwopError ? err : new OpenwopError('internal_error', String(err), 500));
    }
  });
}
