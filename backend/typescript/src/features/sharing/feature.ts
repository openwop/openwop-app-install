/**
 * Sharing (ADR 0013). Mints unguessable public share links to a specific
 * resource (CMS page, KB collection) and resolves them on a public,
 * unauthenticated surface — composing the resource features' read projections
 * via a resolver registry. A `sharing` toggle, off by default.
 */

import type { BackendFeature } from '../types.js';
import { registerSharingRoutes } from './routes.js';

export const sharingFeature: BackendFeature = {
  id: 'sharing',
  registerRoutes: (deps) => registerSharingRoutes(deps),
  toggleDefault: {
    id: 'sharing',
    label: 'Sharing',
    description: 'Mint unguessable public share links to a specific resource (CMS page — including a draft preview — or a KB collection) and resolve them read-only on a public surface, with social-card metadata. Composes CMS + KB via a pluggable resolver registry; the public surface is served only while this toggle is on.',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'sharing',
  },
};
