/**
 * Where a signed-in visitor lands in the app (`VITE_BRAND_APP_HOME_PATH`).
 *
 * The brand key (`brand.appHomePath`, validated in `brand/defaults.ts`) names a
 * route. Two places use it: "Open app" on the public site and the app shell's
 * `/` (`RootRedirect`). Neither may strand a visitor, so the configured path is
 * used only when it is a registered signed-in route (a workspace route, or a
 * `site` route whose auth is `required`) whose feature is on and unlocked for the
 * caller. A typo, a feature switched off, a paid feature the
 * tenant has not bought, or a toggle read that failed all land on `/dashboard`.
 *
 * Unset (the stock build and every adopter that does not set it), nothing
 * changes: both places go straight to `/dashboard`, with no extra hop and no
 * dependency on the toggle read.
 *
 * Side-effect-free, and it does not import the route manifest
 * (`chrome/features.tsx` imports every feature's routes, the dashboard's
 * included), so the dashboard routes can import it without a cycle. The
 * manifest lookup is passed in by `AppHomeRedirect`.
 */
import { brand } from '../brand/brand.js';
import { DEFAULT_APP_HOME_PATH } from '../brand/defaults.js';
import type { FeatureRoute } from './featureTypes.js';

export { DEFAULT_APP_HOME_PATH };

/** The app-shell entry "Open app" links to when a home path is configured. It
 *  resolves the configured path where the toggle state is known (inside
 *  `FeatureAccessProvider`, which the public shell does not mount).
 *
 *  RESERVED: no feature may register it and the brand key may not name it
 *  (`resolveAppHome` refuses it). It is deliberately not `/app`, which an adopter
 *  may use for its own product route (DeckTalk does): a hop at `/app` would clash
 *  with that route, and a key of `/app` would redirect to itself forever. */
export const APP_HOME_ENTRY = '/open-app';

/** The configured home path (already validated; `/dashboard` when unset). */
export const CONFIGURED_APP_HOME: string = brand.appHomePath;

/** Where an "into the app" link points ("Open app", the canvas editor's exit
 *  after a delete). The stock path is linked directly; any other path goes
 *  through `APP_HOME_ENTRY` so it is checked before the visitor arrives. */
export function appHomeHref(configured: string = CONFIGURED_APP_HOME): string {
  if (configured === DEFAULT_APP_HOME_PATH || configured === APP_HOME_ENTRY) return DEFAULT_APP_HOME_PATH;
  return APP_HOME_ENTRY;
}

export interface AppHomeAccess {
  /** The caller's toggle answer for a feature id, or undefined when the feature
   *  has no toggle (core surfaces). */
  enabled: (featureId: string) => boolean | undefined;
  /** The toggle is on but the plan does not entitle it (ADR 0419). */
  locked: (featureId: string) => boolean;
  /** The last toggle read failed: every answer is unknown, not "off". */
  resolutionFailed: boolean;
}

/** The path a signed-in visitor should land on, given the configured path, the
 *  manifest route it matches (null when none) and the caller's feature access. */
export function resolveAppHome(configured: string, route: FeatureRoute | null, access: AppHomeAccess): string {
  // The stock path, or the hop itself (a key naming the hop would loop).
  if (configured === DEFAULT_APP_HOME_PATH || configured === APP_HOME_ENTRY) return DEFAULT_APP_HOME_PATH;
  // A signed-in page: a workspace route, or a `site` route behind the sign-in wall
  // (`auth` defaults to 'required', ADR 0641 decision 2). A white-label's own desk
  // can be the latter (DeckTalk's `/app/*`); refusing it sent "Open app" to
  // `/dashboard` with no error. The admin tier stays out (role-gated), as do
  // `optional`-auth site pages, `/` and the entry itself (they would loop).
  const signedInPage = route?.tier === 'workspace' || (route?.tier === 'site' && (route.auth ?? 'required') === 'required');
  if (!route || !signedInPage || route.path === '/' || route.path === APP_HOME_ENTRY) return DEFAULT_APP_HOME_PATH;
  const featureId = route.ownerFeatureId ?? route.nav?.featureId;
  if (featureId) {
    if (access.resolutionFailed) return DEFAULT_APP_HOME_PATH;
    if (access.enabled(featureId) === false) return DEFAULT_APP_HOME_PATH;
    if (access.locked(featureId)) return DEFAULT_APP_HOME_PATH;
  }
  return configured;
}
