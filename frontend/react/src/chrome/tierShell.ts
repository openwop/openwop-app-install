/**
 * ADR 0641 — the exhaustive tier→shell mapper.
 *
 * `FeatureTier` gained a fourth member and the codebase had no single place that
 * had to account for one. Tiers were consumed by scattered equality checks
 * (`FEATURES.filter(f => f.tier === 'workspace')`) and, in one case, by a BINARY
 * TERNARY over what is now a four-valued type
 * (`MenuSettingsPage.tsx`: `tier === 'workspace' ? mainMenu : adminMenu`). A
 * filter silently renders nothing for an unhandled tier; a ternary silently
 * mislabels one. Neither is a type error, so `tsc` reports a clean build either
 * way and the surface simply does not appear.
 *
 * That is the failure mode this repo keeps rediscovering in other guises: a
 * green check that could not have gone red. So the mapper below is not a
 * convenience — it is the tripwire. `assertNever` makes a fifth tier a COMPILE
 * ERROR at every site that routes on shell, which is the only way an addition
 * announces itself.
 *
 * This file deliberately owns SHELL SELECTION ONLY. Auth posture
 * (`FeatureAuthPosture`) is a separate per-route field precisely because the two
 * are independent: `site` routes share one shell and differ in whether they wrap
 * <AppGate>. Conflating them here would rebuild the `showPublic` conflation the
 * ADR exists to split.
 */

import type { FeatureAuthPosture, FeatureTier } from './featureTypes.js';

/** Which shell renders a tier's routes. */
export type TierShell =
  /** Inside <AppGate> → `div.app-shell` with the <Sidebar> rail. */
  | 'app'
  /** Inside <AppGate> → <AdminLayout>'s embedded two-column rail. */
  | 'admin'
  /** Bare <PublicShell>, ABOVE <AppGate>, no nav (ADR 0027). */
  | 'public'
  /** Bare product shell WITH nav (ADR 0641). Above or below <AppGate>
   *  depending on the ROUTE's auth posture — see `siteWrapsAppGate`. */
  | 'site';

/** Compile-time exhaustiveness. A new `FeatureTier` member that reaches here
 *  fails `tsc` rather than falling through to a default. */
function assertNever(x: never, context: string): never {
  throw new Error(`${context}: unhandled tier ${JSON.stringify(x)}`);
}

export function shellForTier(tier: FeatureTier): TierShell {
  switch (tier) {
    case 'workspace':
      return 'app';
    case 'admin':
      return 'admin';
    case 'public':
      return 'public';
    case 'site':
      return 'site';
    default:
      return assertNever(tier, 'shellForTier');
  }
}

/**
 * Does a `site` route render INSIDE <AppGate>?
 *
 * ADR 0641 decision 3. `required` wraps the gate (anonymous → sign-in wall);
 * `optional` MUST NOT (anonymous → renders, signed-in → renders richer).
 *
 * Omission selects `required`, the safe branch: a `site` route that forgets to
 * declare a posture gets the sign-in wall rather than silently exposing a
 * surface. Fail-closed by omission, matching `siteRouteContract`.
 */
export function siteWrapsAppGate(auth: FeatureAuthPosture | undefined): boolean {
  return (auth ?? 'required') === 'required';
}

/**
 * Is a route SESSION-BEARING — i.e. should notifications/SSE bootstrap for it?
 *
 * This is the predicate that replaces `showPublic` at App.tsx's bootstrap
 * guards. The old boolean answered "is this the bare marketing shell", and was
 * then reused to answer "should we open a session" — one value owning two
 * questions, which is exactly why a bare-shell-but-authenticated surface was
 * inexpressible.
 *
 * A `site` route is session-bearing under BOTH postures: `optional` still
 * renders richer for a signed-in visitor, so it wants the session when one
 * exists. Only the `public` tier is genuinely sessionless.
 */
export function tierIsSessionBearing(tier: FeatureTier): boolean {
  switch (tier) {
    case 'workspace':
    case 'admin':
    case 'site':
      return true;
    case 'public':
      return false;
    default:
      return assertNever(tier, 'tierIsSessionBearing');
  }
}

/**
 * Does this tier render the CONSOLE chrome — sidebar rail, vendor-setup prompt,
 * auto-seed, in-memory host banner?
 *
 * ADR 0641 decision 3 states the requirement negatively and concretely: *"a
 * participant at `/today` must not receive a vendor-setup prompt."* Stated as a
 * predicate so the App.tsx branch reads as one question rather than four
 * hand-maintained omissions.
 */
export function tierRendersConsoleChrome(tier: FeatureTier): boolean {
  switch (tier) {
    case 'workspace':
    case 'admin':
      return true;
    case 'public':
    case 'site':
      return false;
    default:
      return assertNever(tier, 'tierRendersConsoleChrome');
  }
}
