/**
 * Digital twin (ADR 0044). The toggle-gated surface for the twin LINK + the
 * user-issued consent GRANT — the authorization layer for an agent recalling its
 * owner's memory. Phase 1 ships link + grant management ONLY; the fenced recall
 * composition (Phase 2) reads the host-owned `twinService.getActiveGrant`.
 *
 * The whole surface is OFF by default, tenant-bucketed — cross-principal recall is
 * a new access path, so a tenant must opt in. Adds no new store beyond the
 * `twin-grant` DurableCollection + the `agentProfile.twin` link field.
 *
 * @see docs/adr/0044-twin-cross-subject-recall.md
 */

import type { BackendFeature } from '../types.js';
import { registerTwinRoutes } from './routes.js';
import { setBorrowedRecallResolver } from '../../host/twinRecallSurface.js';
import { resolveBorrowedRecall } from './borrowedRecall.js';

export const twinFeature: BackendFeature = {
  id: 'twin-recall',
  registerRoutes: (deps) => {
    registerTwinRoutes(deps);
    // Phase 2 — fill the host borrowed-recall seam so core dispatch can compose
    // a granted twin's owner-corpus without importing this feature (ADR 0001).
    // The resolver re-checks the toggle live, so registration ≠ enablement.
    setBorrowedRecallResolver(resolveBorrowedRecall);
  },
  toggleDefault: {
    id: 'twin-recall',
    label: 'Digital twin recall',
    description:
      'Digital-twin cross-subject recall (ADR 0044). Lets a tenant link an agent to a person as their twin, and lets that PERSON grant (and revoke) the agent permission to recall their own memory + knowledge. Phase 1 manages links + consent grants only; fenced recall is Phase 2. Cross-principal access is opt-in per tenant — OFF by default. Only the linked user can grant/revoke; the admin link is tenant-IDOR-guarded; all owner-derived recall is untrusted-fenced.',
    category: 'Agents',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'twin-recall',
  },
};
