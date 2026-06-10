/**
 * Media library (ADR 0007). Org-scoped collections + assets, RBAC-gated
 * (workspace:read/write via accessControl). Owns metadata only — bytes ride the
 * RFC 0055 media-asset surface behind a one-file storage adapter. A `media`
 * toggle, off by default.
 */

import type { BackendFeature } from '../types.js';
import { registerMediaRoutes } from './routes.js';

export const mediaFeature: BackendFeature = {
  id: 'media',
  registerRoutes: (deps) => registerMediaRoutes(deps),
  toggleDefault: {
    id: 'media',
    label: 'Media library',
    description: 'Org-scoped media collections + assets (upload, organize, search, usage). RBAC-gated via accessControl (workspace:read/write); bytes ride the RFC 0055 media-asset surface (ADR 0007).',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'media',
  },
};
