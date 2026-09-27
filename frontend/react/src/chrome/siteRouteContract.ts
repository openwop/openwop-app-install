/**
 * ADR 0641 decisions 2 + 12 — the registration-time contract for `site` routes.
 *
 * Two rules, both enforced when the manifest is composed rather than when a
 * visitor arrives, because both failures are SILENT at request time.
 *
 * **Rule 1 (decision 12): a `site` route with `auth: 'optional'` MUST have a
 * binary toggle — no variants, no percentage rollout, no tenant override.**
 *
 * An anonymous caller is minted `tenantId = "anon:<sid>"`, a throwaway per
 * browser session (`backend/typescript/src/middleware/auth.ts`). Two consequences,
 * both verified in `host/featureToggles/service.ts`:
 *
 *   1. `tenantOverrides[subject.tenantId]` (:449) can never match a public
 *      visitor — the key is a per-session random. An operator switching a public
 *      route "on for this tenant" silently does nothing.
 *   2. `unitIdFor` (:431) buckets the `'tenant'` unit on `subject.tenantId`, and
 *      the `'user'` unit FALLS BACK to it with no principal (:433-435). Either
 *      way a public route buckets on a per-session random: the same visitor is
 *      reassigned next visit, and a prerendered or CDN-cached public document has
 *      no coherent assignment at all.
 *
 * The alternative — define a stable public bucket unit — is rejected upstream:
 * there is nothing honest to hash. IP is not the visitor, and a durable
 * client-side id is a tracking decision ADR 0641 has no mandate to make. So the
 * constraint IS the answer, and it is enforced here so that a feature declaring
 * variants on a public route fails WHEN IT IS DECLARED rather than shipping a
 * coin flip.
 *
 * **Rule 2: a `site` route's path may not be empty or relative.** Clean root
 * URLs are the whole point of the tier; a relative path would mount the surface
 * under whatever happened to precede it.
 *
 * WHY REGISTRATION AND NOT RENDER. A violation of rule 1 produces a working page
 * every time it is loaded. The variant simply resolves to something arbitrary and
 * stable-looking within one session. There is no error, no empty state, and no
 * log line — the only symptom is that an operator's rollout does nothing, which
 * is invisible until someone measures the rollout, which nobody does until it
 * matters. This repo has a standing record of controls that report success and
 * have no effect; this guard exists so this one cannot join it.
 */

import type { FeatureAuthPosture, FeatureTier } from './featureTypes.js';

/** The toggle shape this contract inspects. Structural, not imported from the
 *  toggle package, so the contract has no dependency on toggle internals and
 *  cannot drift into enforcing something other than what it documents. */
export interface SiteRouteToggleShape {
  /** Multivariant arms. Any non-empty set is a violation on a public route. */
  variants?: unknown[] | Record<string, unknown>;
  /** Percentage rollout, 0-100. Anything strictly between 0 and 100 is a
   *  violation; 0 and 100 are binary and therefore fine. */
  rolloutPercentage?: number;
  /** Per-tenant overrides. Any entry is a violation on a public route — the key
   *  can never match `anon:<sid>`. */
  tenantOverrides?: Record<string, unknown>;
}

export interface SiteRouteDeclaration {
  path: string;
  tier: FeatureTier;
  auth?: FeatureAuthPosture;
  /** The toggle this route's `ownerFeatureId` resolves to, when the composer can
   *  supply it. Absent ⇒ rule 1 has nothing to check (a route with no toggle is
   *  binary by construction). */
  toggle?: SiteRouteToggleShape;
}

export class SiteRouteContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteRouteContractError';
  }
}

function variantCount(v: SiteRouteToggleShape['variants']): number {
  if (v === undefined || v === null) return 0;
  return Array.isArray(v) ? v.length : Object.keys(v).length;
}

/**
 * Validate ONE declaration. Throws `SiteRouteContractError` on violation.
 *
 * Returns nothing on success deliberately — a boolean return would invite a
 * caller to ignore it, and an ignored predicate is the shape this whole ADR
 * keeps finding.
 */
export function assertSiteRouteContract(d: SiteRouteDeclaration): void {
  if (d.tier !== 'site') return;

  if (typeof d.path !== 'string' || d.path.length === 0 || !d.path.startsWith('/')) {
    throw new SiteRouteContractError(
      `site route path must be absolute (got ${JSON.stringify(d.path)}). ` +
        'The `site` tier exists to serve clean ROOT URLs; a relative path mounts the ' +
        'surface under whatever precedes it.',
    );
  }

  // Rule 1 applies only to the anonymous-reachable posture. A `site` route with
  // `auth: 'required'` always has a principal, so tenant/user bucketing is
  // meaningful and ordinary rollout mechanics are fine.
  if ((d.auth ?? 'required') !== 'optional') return;
  const t = d.toggle;
  if (t === undefined) return;

  const nVariants = variantCount(t.variants);
  if (nVariants > 0) {
    throw new SiteRouteContractError(
      `site route ${d.path} is auth:'optional' and declares ${nVariants} toggle variant(s). ` +
        'A public route buckets on `anon:<sid>`, a per-session random — the same visitor is ' +
        'reassigned on their next visit and a cached document has no coherent assignment at ' +
        'all. Public route toggles MUST be binary (ADR 0641 decision 12).',
    );
  }

  const pct = t.rolloutPercentage;
  if (typeof pct === 'number' && pct > 0 && pct < 100) {
    throw new SiteRouteContractError(
      `site route ${d.path} is auth:'optional' and declares a ${pct}% rollout. ` +
        'Percentage rollout on a public route is a coin flip re-tossed per browser session ' +
        '(`unitIdFor` falls back to the per-session tenant id when there is no principal). ' +
        'Use 0 or 100 (ADR 0641 decision 12).',
    );
  }

  const overrides = t.tenantOverrides ? Object.keys(t.tenantOverrides) : [];
  if (overrides.length > 0) {
    throw new SiteRouteContractError(
      `site route ${d.path} is auth:'optional' and declares ${overrides.length} tenant ` +
        `override(s) (${overrides.slice(0, 3).join(', ')}). A public visitor's tenant is ` +
        '`anon:<sid>`, freshly minted per browser session, so the override key can never ' +
        'match — the control reports success and has no effect (ADR 0641 decision 12).',
    );
  }
}

/** Validate a whole manifest. Reports EVERY violation rather than the first, so
 *  a composer fixing them does not discover them one build at a time. */
export function assertSiteRouteContracts(routes: readonly SiteRouteDeclaration[]): void {
  const errs: string[] = [];
  for (const r of routes) {
    try {
      assertSiteRouteContract(r);
    } catch (e) {
      errs.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (errs.length > 0) {
    throw new SiteRouteContractError(
      `${errs.length} site-route contract violation(s):\n  - ${errs.join('\n  - ')}`,
    );
  }
}
