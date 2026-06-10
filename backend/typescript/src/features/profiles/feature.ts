/**
 * User profiles (ADR 0005). A self-service descriptive profile per user +
 * a tenant directory. Owns DESCRIPTIVE data only — identity stays in `users`
 * (ADR 0002/0003), authority is RBAC (ADR 0006), avatar/portfolio bytes live in
 * the media-asset surface (RFC 0055). A `profiles` toggle, off by default.
 */

import type { BackendFeature } from '../types.js';
import { registerProfilesRoutes } from './routes.js';

export const profilesFeature: BackendFeature = {
  id: 'profiles',
  registerRoutes: (deps) => registerProfilesRoutes(deps),
  toggleDefault: {
    id: 'profiles',
    label: 'User profiles',
    description: 'Self-service per-user profiles (job/department/bio, skills + endorsements, equipment, availability, interests, avatar + portfolio) plus a tenant directory. Descriptive only — confers no authority (ADR 0005).',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'profiles',
  },
};
