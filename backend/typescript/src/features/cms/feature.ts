/**
 * CMS + Page Builder (ADR 0009). Org-scoped pages with typed sections, an
 * RBAC editorial workflow, versions, and slug redirects. Section assets are
 * Media-Library tokens (ADR 0007). A `cms` toggle, off by default.
 */

import type { BackendFeature } from '../types.js';
import { registerCmsRoutes } from './routes.js';

export const cmsFeature: BackendFeature = {
  id: 'cms',
  registerRoutes: (deps) => registerCmsRoutes(deps),
  toggleDefault: {
    id: 'cms',
    label: 'CMS + Page Builder',
    description: 'Org-scoped pages with typed sections, an RBAC editorial workflow (draft → review → publish), versions, and slug redirects. Section assets are Media-Library tokens (ADR 0009).',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'cms',
  },
};
