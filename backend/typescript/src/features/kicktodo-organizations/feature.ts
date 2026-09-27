/**
 * kicktodo-organizations (ADR 0428) — org libraries, cohorts, branding,
 * k-anonymous reports. Composes accessControl (the one org owner) + the
 * ADR 0419 cohort primitive.
 */

import type { BackendFeature } from '../types.js';
import { registerKicktodoOrgRoutes } from './routes.js';
import { buildKicktodoOrganizationsSurface } from './surface.js';

export const kicktodoOrganizationsFeature: BackendFeature = {
  id: 'kicktodo-organizations',
  registerRoutes: registerKicktodoOrgRoutes,
  toggleDefault: {
    id: 'kicktodo-organizations',
    label: 'KickTodo Organizations',
    description:
      'Org challenge libraries, org cohorts, branding, and k-anonymous (≥5) outcome reports (ADR 0428). Consent never inherited from org membership.',
    category: 'KickTodo',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'kicktodo-organizations',
  },
  dependsOn: ['kicktodo-core', 'kicktodo-accountability'],
  requiredPacks: [{ name: 'feature.kicktodo.nodes', version: '1.30.0' }],
  surface: { id: 'kicktodo-organizations', build: buildKicktodoOrganizationsSurface }, // ADR 0428 P5
};
