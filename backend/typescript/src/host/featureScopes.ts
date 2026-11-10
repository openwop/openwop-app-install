/**
 * ADR 1031 P2 (security) — FEATURE-registered management scopes and
 * activation-only roles. A leaf store: `accessControlService` reads it, and only
 * `featureSecurity.ts` (the composer's seal) writes it.
 *
 * What a feature may add here, and what it may not:
 *
 *  - an ADMIN-TIER management scope (`host:<ns>:<verb>`). It is granted to the
 *    built-in admin and owner roles, at a fixed position in their scope lists
 *    (after the host's admin management scopes, before the compensation rung),
 *    is mintable on a developer key, and is NEVER carryable by a custom role
 *    (`isCustomRoleScope` admits only protocol + delegable host scopes);
 *  - an ACTIVATION-ONLY role (ADR 0910) over the feature's OWN declared default
 *    workspace: its scopes join a member's union only while a live operator
 *    activation exists. It is never admitted to a member or group row.
 *
 * Writes are possible only until the seal. After it every write throws, so no
 * module evaluated later (a lazy import, a request handler) can widen RBAC.
 */

export interface FeatureActivationRole {
  /** Owning feature (the declarer). */
  featureId: string;
  id: string;
  name: string;
  description: string;
  /** The feature's own declared default workspace (its `defaultOrg.id`). */
  workspaceId: string;
  scopes: readonly string[];
}

const adminTierScopes: Array<{ featureId: string; scope: string }> = [];
const activationRoles = new Map<string, FeatureActivationRole>();
let sealed = false;

function assertOpen(what: string): void {
  if (sealed) throw new Error(`feature security registration is closed (ADR 1031 P2): ${what} was registered after the feature composer sealed it`);
}

/** Called by the seal only. Order of calls = registry order = position order. */
export function recordFeatureAdminScope(featureId: string, scope: string): void {
  assertOpen(`scope '${scope}' (feature '${featureId}')`);
  if (adminTierScopes.some((s) => s.scope === scope)) throw new Error(`feature scope '${scope}' is registered twice (ADR 1031 P2)`);
  adminTierScopes.push({ featureId, scope });
  crossCheck();
}

/** Called by the seal only. One role per workspace. */
export function recordFeatureActivationRole(role: FeatureActivationRole): void {
  assertOpen(`activation role '${role.id}' (feature '${role.featureId}')`);
  if (activationRoles.has(role.workspaceId)) throw new Error(`workspace '${role.workspaceId}' already has an activation role (ADR 1031 P2)`);
  activationRoles.set(role.workspaceId, { ...role, scopes: [...role.scopes] });
  crossCheck();
}

export function sealFeatureScopes(): void { sealed = true; }

/**
 * Cross-checks against the HOST vocabulary, run as soon as both sides are known
 * (this leaf cannot import `accessControlService`: the seal may run while it is
 * still loading). A feature may not re-register a host scope, an activation role
 * may not reuse a built-in role id, and a role may carry management scopes only.
 */
let host: { all: ReadonlySet<string>; management: ReadonlySet<string>; builtInRoleIds: ReadonlySet<string> } | null = null;
function crossCheck(): void {
  if (!host) return;
  for (const { featureId, scope } of adminTierScopes) {
    if (host.all.has(scope)) throw new Error(`feature '${featureId}': scope '${scope}' is a host scope and cannot be registered (ADR 1031 P2)`);
  }
  const management = new Set([...host.management, ...adminTierScopes.map((s) => s.scope)]);
  for (const r of activationRoles.values()) {
    if (host.builtInRoleIds.has(r.id)) throw new Error(`feature '${r.featureId}': activation role id '${r.id}' is a built-in role (ADR 1031 P2)`);
    const bad = r.scopes.filter((x) => !management.has(x));
    if (bad.length) throw new Error(`feature '${r.featureId}': activation role '${r.id}' may carry management scopes only, not ${bad.join(', ')} (ADR 1031 P2)`);
  }
}

/** `accessControlService` hands over its vocabulary when it finishes loading. */
export function setHostScopeVocabulary(v: { all: Iterable<string>; management: Iterable<string>; builtInRoleIds: Iterable<string> }): void {
  host = { all: new Set(v.all), management: new Set(v.management), builtInRoleIds: new Set(v.builtInRoleIds) };
  crossCheck();
}

/** Feature-registered admin-tier scopes, in registration order. */
export function featureAdminScopes(): string[] { return adminTierScopes.map((s) => s.scope); }

/** Owner of each registered scope (census). */
export function featureAdminScopeOwners(): ReadonlyArray<{ featureId: string; scope: string }> { return adminTierScopes; }

/** The activation-only role over `workspaceId`, if a feature registered one. */
export function featureActivationRoleFor(workspaceId: string): FeatureActivationRole | undefined { return activationRoles.get(workspaceId); }

/** Every registered activation role (census). */
export function featureActivationRoles(): FeatureActivationRole[] { return [...activationRoles.values()]; }
