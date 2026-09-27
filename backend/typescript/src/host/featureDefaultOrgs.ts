/**
 * ADR 0684 phase 1 — provision feature-declared default orgs at boot.
 *
 * A fresh deployment of a participant-facing distribution renders blank surfaces
 * because the catalog is caller-tenant and every visitor gets a private tenant.
 * A feature can now declare the org + shared workspace its participants belong
 * in (`BackendFeature.defaultOrg`), and this provisions it idempotently at boot —
 * the same seam `systemSite.ts:166` uses for `host-site`, deliberately NOT a
 * second reserved-org system.
 *
 * NOT the same SHAPE, though, and that distinction is the ADR 0684 correction.
 * `host-site` pairs org `host-site` with tenant `host:site` — ids that DIFFER —
 * and that is safe there only because the system site is auth-unreachable by
 * design: nobody joins it, so its mismatch never meets a membership check. A
 * declared default org is the first one participants are meant to ENTER, so it
 * must be a workspace root (`orgId === tenantId`). Copying the system-site pair
 * shipped an org that could be provisioned and joined but never entered.
 *
 * WHAT THIS DOES NOT DO, and why it is not an oversight:
 *
 *   - It does not resolve the declaring feature's TOGGLE. Toggles resolve
 *     per-tenant at request time; there is no tenant at boot, so "provision iff
 *     the toggle is on" is not a question this code can ask. The declaration
 *     itself is the gate — a feature that does not want a default org does not
 *     declare one — plus the operator opt-out below. ADR 0684's §gate is
 *     narrowed to that, here rather than in the ADR's prose, because this is
 *     where a reader will look for it.
 *
 *   - It does not add members. Membership arrives via auto-join on first
 *     sign-in (phase 2). A default org with no members is the correct state
 *     between phases: an empty participant org serves an empty catalog, which is
 *     honest, where a half-provisioned one would not be.
 *
 * OPERATOR OPT-OUT: `OPENWOP_DISABLE_FEATURE_DEFAULT_ORGS=true` suppresses every
 * declared default. An operator who wants their own org must be able to refuse
 * one they did not ask for.
 */
import { ensureWorkspaceRootOrg } from './accessControlService.js';
import { SYSTEM_SITE_ORG } from './systemSite.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.featureDefaultOrgs');

const SYSTEM_ACTOR = 'system';

/** Org ids no feature may claim. `host-site` is the host's own site (ADR 0027). */
const RESERVED_ORG_IDS: ReadonlySet<string> = new Set([SYSTEM_SITE_ORG]);

export interface FeatureDefaultOrg { featureId: string; orgId: string; tenantId: string; name: string }

/**
 * Reject a declaration that cannot be provisioned safely. Throws at BOOT, not at
 * first use — a bad id must stop the deployment, not surface as a 404 to the
 * first stranger who visits.
 *
 * WHAT IS DELIBERATELY NOT CHECKED: collision with a v2 path-manifest first
 * segment. That check cannot fail. An org id never appears as a first segment —
 * it sits four deep at `/v1/host/openwop-app/public/:orgId/…` — so a guard
 * against it would be unfireable, which is the species this repo has spent real
 * effort removing. The collisions that CAN happen are with a reserved org id and
 * with another feature's declaration, and those are what this asserts.
 */
export function assertDeclarationLegal(d: FeatureDefaultOrg, seen: Map<string, string>): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(d.orgId)) {
    throw new Error(`featureDefaultOrgs: feature "${d.featureId}" declares orgId "${d.orgId}" — must be lowercase hyphen form (it ends up in a URL path segment at /public/:orgId/…).`);
  }
  // THE INVARIANT THIS SEAM EXISTS TO HOLD, and the one it used to invert.
  //
  // Until the ADR 0684 correction the two checks here were: orgId must be hyphen
  // form, tenantId must contain a colon. Both passed, and together they made a
  // legal declaration IMPOSSIBLE to use: this host defines a workspace as an org
  // whose id equals its tenant — `isWorkspaceOrg`, and the five call sites now
  // routed through it — so every declared default org was, by construction, not
  // a workspace. MEASURED in production 2026-09-15 on kicktodo.com: a fresh
  // stranger's auto-join wrote a member row, claimed the ledger and set the
  // active-workspace preference, then `/me/workspaces` omitted it, `switch`
  // answered 403, and `resolveActiveWorkspace` fail-closed dropped the
  // preference and returned them to their personal tenant. Every layer correct;
  // the layers disagreed about what a workspace IS.
  //
  // The declaration now carries ONE id (`BackendFeature.defaultOrg.id`) and the
  // caller derives both fields from it, so this cannot fail from a feature
  // author's mistake. It is kept as a real assertion anyway because it guards
  // the DERIVATION — a future caller that reintroduces two sources would be
  // caught here rather than in production six hours later.
  if (d.orgId !== d.tenantId) {
    throw new Error(`featureDefaultOrgs: feature "${d.featureId}" declares orgId "${d.orgId}" and tenantId "${d.tenantId}" — a workspace root requires them EQUAL (accessControlService.isWorkspaceOrg). A declaration whose ids differ provisions an org nobody can enter (ADR 0684 correction).`);
  }
  if (RESERVED_ORG_IDS.has(d.orgId)) {
    throw new Error(`featureDefaultOrgs: feature "${d.featureId}" declares the reserved org "${d.orgId}".`);
  }
  const prior = seen.get(d.orgId);
  if (prior && prior !== d.featureId) {
    throw new Error(`featureDefaultOrgs: features "${prior}" and "${d.featureId}" both declare org "${d.orgId}" — two owners for one org is the drift this seam exists to avoid.`);
  }
  seen.set(d.orgId, d.featureId);
}

/**
 * Provision every declared default org, idempotently. Mirrors
 * `ensureSystemSiteOrg` — deterministic id, get-then-create, logged on create
 * only, so a redeploy is silent rather than noisy.
 */
export async function ensureFeatureDefaultOrgs(declared: readonly FeatureDefaultOrg[]): Promise<void> {
  if (String(process.env['OPENWOP_DISABLE_FEATURE_DEFAULT_ORGS'] ?? '').toLowerCase() === 'true') {
    if (declared.length > 0) {
      log.info('feature_default_orgs_disabled', { suppressed: declared.length });
    }
    return;
  }
  const seen = new Map<string, string>();
  for (const d of declared) assertDeclarationLegal(d, seen);

  for (const d of declared) {
    // Not `if (await getOrg(d.orgId)) continue` — that skipped on org id alone,
    // which the ADR 0684 correction did NOT change, so a host that had already
    // booted the old code kept its non-workspace-root row forever. The seam now
    // asks the question it actually means: is this org a WORKSPACE ROOT?
    const r = await ensureWorkspaceRootOrg({
      orgId: d.orgId, tenantId: d.tenantId, name: d.name, createdBy: SYSTEM_ACTOR,
    });
    if (r.action === 'created') {
      log.info('feature_default_org_created', { featureId: d.featureId, orgId: d.orgId, tenantId: d.tenantId });
    } else if (r.action === 'repaired') {
      // WARN, not info: this is a one-time migration of a row that was serving
      // an unenterable workspace, and an operator should see it happen exactly
      // once per host. A second occurrence means something is re-creating the
      // stale shape.
      log.warn('feature_default_org_repaired', {
        featureId: d.featureId, orgId: d.orgId, tenantId: d.tenantId,
        priorTenantId: r.priorTenantId,
        note: 'org rebound to workspace-root form (ADR 0684 correction); member/join rows under the prior tenant are inert and were left in place',
      });
    }
  }
}
