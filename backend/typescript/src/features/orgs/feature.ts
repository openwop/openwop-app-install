/**
 * Org invitations (ADR 0004, reconciled). Organizations / members / roles are
 * owned by the `accessControl` surface (RFC 0049); this feature adds ONLY the
 * email-token invitation flow that delegates to it (see invitationsService /
 * the amended ADR). An `orgs` toggle, off by default.
 */

import type { BackendFeature } from '../types.js';
import { registerOrgsRoutes } from './routes.js';

export const orgsFeature: BackendFeature = {
  id: 'orgs',
  registerRoutes: (deps) => registerOrgsRoutes(deps),
  toggleDefault: {
    id: 'orgs',
    label: 'Org invitations',
    description: 'Email-token invitations to join an organization as a member. Orgs/members/roles are owned by the accessControl surface (RFC 0049); this delegates to it.',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'orgs',
  },
};
