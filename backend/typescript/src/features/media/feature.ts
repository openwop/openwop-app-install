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

export const mediaFeature: BackendFeature = {
  id: 'media',
  registerRoutes: (deps) => registerMediaRoutes(deps),
};
