/**
 * Operations — the operator admin suite (ADR 0395): read-panels over EXISTING
 * backend primitives (webhook delivery queue, trigger-bridge deliveries, DLQ
 * surface, readiness/SSE/pool signals), composed into the `/operations` hub.
 * NO new collectors, NO new authoritative stores — every endpoint is a batched
 * server-side fan-in over data that already flows (the D2 rate-limit rule: ONE
 * summary request per panel load, never a client N+1).
 *
 * Gating is two-tier and fail-closed (D3): cross-tenant/infra reads + the two
 * write actions (webhook retry, DLQ replay) are SUPERADMIN-only
 * (`OPENWOP_SUPERADMIN_TENANTS`); a tenant's own webhook panel rides
 * `authorizeOrgScope` with the admin-tier `webhooks:manage` scope. The
 * `operations` toggle gates whether the SURFACE renders — it is never the auth
 * boundary.
 */
import type { BackendFeature } from '../types.js';
import { registerOperationsRoutes } from './routes.js';

export const operationsFeature: BackendFeature = {
  id: 'operations',
  registerRoutes: registerOperationsRoutes,
  toggleDefault: {
    id: 'operations',
    label: 'Operations Console',
    description:
      'The operator admin suite: webhook-delivery health (attempts, backoff, dead-letters, manual retry), '
      + 'trigger-subscription state, DLQ depths with gated replay, and a point-in-time system-health panel — '
      + 'batched reads over the existing backend primitives, composed as an /operations hub. Cross-tenant and '
      + 'infra panels are superadmin-only regardless of this toggle. OFF by default.',
    category: 'Admin',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'operations',
  },
};
