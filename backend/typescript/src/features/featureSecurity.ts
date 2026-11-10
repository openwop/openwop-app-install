/**
 * ADR 1031 P2 (security) — the ONE writer of the feature-extensible security
 * surface: management scopes and activation roles (`host/featureScopes.ts`),
 * public routes (`middleware/auth.ts`) and log reason codes
 * (`observability/logReasonCodes.ts`).
 *
 * `features/index.ts` calls `sealFeatureSecurity(BACKEND_FEATURES)` right after
 * composition. It records every composed feature's `security` declaration and
 * then seals all three stores, so:
 *
 *  - only a feature COMPOSED into the build can add to the surface (a feature a
 *    distribution excludes adds nothing; a module that is not a feature has no
 *    declaration to add);
 *  - nothing registered after composition is accepted — every later write throws;
 *  - every entry is listed, with its owner, by `featureSecuritySurface()`, which
 *    the census ratchet compares to each package's committed baseline.
 *
 * Shape is validated here; the cross-checks against host vocabularies (host scope,
 * built-in role id, host public prefix) run in each leaf as soon as both sides are
 * known. All of it throws at module load (boot), never at request time.
 */
import type { BackendFeature } from './types.js';
import {
  featureActivationRoles, featureAdminScopeOwners, recordFeatureActivationRole, recordFeatureAdminScope, sealFeatureScopes,
} from '../host/featureScopes.js';
import { featurePublicRoutes, recordFeaturePublicRoute, sealFeaturePublicRoutes } from '../middleware/featurePublicRoutes.js';
import { featureLogReasonCodes, recordFeatureLogReasonCode, sealFeatureLogReasonCodes } from '../observability/logReasonCodes.js';

const SCOPE_SHAPE = /^host:[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;
const ROLE_ID = /^[a-z][a-z0-9-]{2,63}$/;

let sealed = false;

export function sealFeatureSecurity(features: ReadonlyArray<BackendFeature | undefined>): void {
  if (sealed) throw new Error('feature security was sealed twice (ADR 1031 P2)');
  // An undefined entry is an import-cycle hole (a test importing a feature module
  // first, see composeFeatures.ts): it registers nothing, which fails closed.
  const composed = features.filter((f): f is BackendFeature => f !== undefined);
  // Pass 1: scopes (a role may name another composed feature's scope).
  for (const f of composed) {
    for (const { scope } of f.security?.scopes ?? []) {
      if (!SCOPE_SHAPE.test(scope)) throw new Error(`feature '${f.id}': scope ${JSON.stringify(scope)} must be host:<ns>:<verb>`);
      recordFeatureAdminScope(f.id, scope);
    }
  }
  // Pass 2: roles, routes, codes.
  for (const f of composed) {
    const sec = f.security; if (!sec) continue;
    for (const role of sec.activationRoles ?? []) {
      if (!f.defaultOrg) throw new Error(`feature '${f.id}': an activation role needs the feature's own defaultOrg`);
      if (!ROLE_ID.test(role.id)) throw new Error(`feature '${f.id}': activation role id ${JSON.stringify(role.id)} is invalid`);
      recordFeatureActivationRole({ featureId: f.id, id: role.id, name: role.name, description: role.description, workspaceId: f.defaultOrg.id, scopes: role.scopes });
    }
    for (const { route } of sec.publicRoutes ?? []) recordFeaturePublicRoute(f.id, route);
    for (const code of sec.logReasonCodes ?? []) recordFeatureLogReasonCode(f.id, code);
  }
  sealFeatureScopes();
  sealFeaturePublicRoutes();
  sealFeatureLogReasonCodes();
  sealed = true;
}

export type FeatureSecurityEntry = { featureId: string; entry: string };

/**
 * The census: every registered entry with its owner, one stable line each.
 * An activation role lists its scopes, so widening a role's grant changes its line.
 */
export function featureSecuritySurface(): FeatureSecurityEntry[] {
  return [
    ...featureAdminScopeOwners().map((s) => ({ featureId: s.featureId, entry: `scope ${s.scope}` })),
    ...featureActivationRoles().map((r) => ({ featureId: r.featureId, entry: `activation-role ${r.id}@${r.workspaceId} [${r.scopes.join(', ')}]` })),
    ...featurePublicRoutes().map((r) => ({ featureId: r.featureId, entry: `public-route ${r.route}` })),
    ...featureLogReasonCodes().map((c) => ({ featureId: c.featureId, entry: `log-reason-code ${c.code}` })),
  ];
}
