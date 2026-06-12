/**
 * CMS + Page Builder (ADR 0009). Org-scoped pages with typed sections, an
 * RBAC editorial workflow, versions, and slug redirects. Section assets are
 * Media-Library tokens (ADR 0007).
 *
 * ALWAYS-ON (ADR 0027): no `toggleDefault` — CMS is core content tooling (the
 * front page composes it), so it is retired from the toggle catalog like
 * Notifications (ADR 0010 § Correction). Routes keep their org-scoped RBAC gate
 * (`requireOrgScope`); only the toggle gate is gone.
 */

import type { BackendFeature } from '../types.js';
import { registerCmsRoutes } from './routes.js';

export const cmsFeature: BackendFeature = {
  id: 'cms',
  registerRoutes: (deps) => registerCmsRoutes(deps),
};
