/**
 * Media library (ADR 0007). Org-scoped collections + assets, RBAC-gated
 * (workspace:read/write via accessControl). Owns metadata only — bytes ride the
 * RFC 0055 media-asset surface behind a one-file storage adapter.
 *
 * ALWAYS-ON (ADR 0027): no `toggleDefault` — Media is core content tooling (CMS
 * sections + the front page reference its assets), retired from the toggle
 * catalog like Notifications (ADR 0010 § Correction). Routes keep their
 * org-scoped RBAC gate (`requireOrgScope`); only the toggle gate is gone.
 */

import type { BackendFeature } from '../types.js';
import { registerMediaRoutes } from './routes.js';
import { registerImageGenRoutes } from './imageGenRoutes.js';
import { registerMediaAgentTools } from './agentTools.js';
import { registerMediaErasure } from './erasure.js';
import { buildMediaSurface } from './surface.js';

export const mediaFeature: BackendFeature = {
  id: 'media',
  // ADR 0229 — `ctx.features.media`: the narrow write surface a workflow node
  // uses to register a host-stored byte asset (serve URL) as a durable library
  // asset with lineage. Always-on ⇒ ungated at the surface seam (ADR 0027).
  surface: { id: 'media', build: buildMediaSurface },
  registerRoutes: (deps) => {
    // MED2-M3 (R3) — DSAR erasure + PII declaration; registered with the routes
    // (the documents feature.ts precedent) so a tenant that used media is erasable.
    registerMediaErasure();
    registerMediaRoutes(deps);
    registerImageGenRoutes(deps); // ADR 0401 — editor-facing image-gen reach
    registerMediaAgentTools(); // XCH-HOLE-7 (round 3) — openwop:media.list (ADR 0308 seam)
  },
  requiredPacks: [
    { name: 'feature.media.nodes', version: '1.0.0' },
  ],
};
