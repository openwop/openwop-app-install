/**
 * Collaboration / Comments feature (ADR 0021). Threaded comments on commentable
 * resources (CMS pages, KB collections), authed + org-scoped + RBAC. Reuses the
 * Sharing (0013) resolver-registry pattern (a new commentable type is one map
 * entry) and the Notifications (0010) emit seam (no new realtime channel). Adds a
 * `ctx.features.comments` read/post surface (ADR 0014) + `feature.comments.{nodes,
 * agents}`, all behind the same `comments` toggle. Authed-only (no public surface).
 * Off by default.
 */

import type { BackendFeature } from '../types.js';
import { registerCommentsRoutes } from './routes.js';
import { buildCommentsSurface } from './surface.js';

export const commentsFeature: BackendFeature = {
  id: 'comments',
  registerRoutes: registerCommentsRoutes,
  // Face 2 (ADR 0014): `ctx.features.comments` — list/post/resolve for the
  // feature.comments.nodes pack + the reviewer agent.
  surface: { id: 'comments', build: buildCommentsSurface },
  toggleDefault: {
    id: 'comments',
    label: 'Collaboration / Comments',
    description: 'Threaded comments on CMS pages + KB collections, notified over the existing inbox — product feature.',
    category: 'Business Tools',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'comments',
  },
  requiredPacks: [
    { name: 'feature.comments.nodes', version: '1.0.0' },
    { name: 'feature.comments.agents', version: '1.0.0' },
  ],
};
