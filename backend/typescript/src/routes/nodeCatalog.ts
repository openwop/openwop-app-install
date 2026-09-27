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
import { resolveDisabledPacks } from '../host/packVisibility.js';
import { tenantOf } from '../host/requestSubject.js';

export function registerNodeCatalogRoute(app: Express): void {
  app.get('/v1/host/openwop-app/node-catalog', async (req, res, next) => {
    try {
      // ADR 0194 Phase 3 — per-tenant pack enablement: hide nodes from packs the
      // caller's workspace disabled (availability curation on the AUTHORING
      // surface only — runs/replay never consult this seam).
      const disabled = await resolveDisabledPacks(tenantOf(req));
      const nodes = disabled.size === 0
        ? buildNodeCatalog()
        : buildNodeCatalog().filter((n) => !(n.packName && disabled.has(n.packName)));
      res.json({ nodes });
    } catch (err) {
      next(err instanceof OpenwopError ? err : new OpenwopError('internal_error', String(err), 500));
    }
  });
}
