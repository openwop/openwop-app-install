/**
 * Root-route gate (ADR 0487). A SIDE-EFFECT-FREE module so the two halves of the
 * `/` contract share ONE definition and the gate is unit-testable without mounting
 * the whole app:
 *   - `App.tsx` decides whether `/` renders the PUBLIC marketing home;
 *   - the dashboard feature's `RootRedirect` forwards the app-shell `/`.
 *
 * The legacy chat deep links (`/?conversation=` / `/?agent=` / `/?new=`) are the
 * live ADR 0058 "open chat scoped to an agent" entry points (every "Ask <agent>"
 * button). They MUST fall through to the app shell so `RootRedirect` forwards them
 * to `/chat` — EVEN for an anonymous visitor (the entire white-label/demo
 * population). So they are excluded from the marketing gate below; without this,
 * `showFrontPage` short-circuits to the marketing page before `RootRedirect` ever
 * mounts, dropping the `?agent=` on the floor (the bug the old `app-entered`
 * marker used to mask).
 */
export const LEGACY_CHAT_PARAMS = ['conversation', 'agent', 'new'] as const;

/** True when a `/` URL carries a legacy chat deep-link param. */
export function hasLegacyChatParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return LEGACY_CHAT_PARAMS.some((p) => params.has(p));
}

/**
 * ── CORRECTION 2026-09-11: the operator toggle now means what it says ──────────
 *
 * This gate used to AND in `!hasUser`, so the CMS front-page switch turned the
 * page on for ANONYMOUS visitors only. Nothing the operator could see said so.
 * The switch's own label is unqualified:
 *
 *     "Show the front page at / (off ⇒ / is the app for everyone)"
 *
 * The parenthetical defines the OFF case as "everyone"; by symmetry ON means the
 * front page for everyone. The confirmation toast agrees — "Front page is now
 * shown at /" — and names no visitor class. A signed-in visitor was redirected to
 * /dashboard with the toggle ON, and no amount of toggling could change it.
 *
 * It was enforced TWICE, which is why this read as immovable rather than as a
 * bug: `App.tsx` also passed `!user` into `useFrontPage`, so the pointer was never
 * even FETCHED for a signed-in visitor and `frontPageEnabled` fell back to false.
 * Removing one without the other changes nothing; both are fixed together.
 *
 * This REVERSES ADR 0487's "a signed-in visitor who reaches `/` is redirected to
 * `/dashboard`" — recorded as a reversal in that ADR's correction note. 0487's
 * own stated reason does not block it: it reversed the earlier "dashboard
 * graduated to `/`" because a dual-purpose root "could strand LOGGED-OUT visitors
 * on the dashboard". Always-front-page-at-`/` is the opposite failure direction
 * and cannot strand a logged-out visitor anywhere.
 *
 * `RootRedirect` still owns the app-shell `/`: with the toggle OFF this gate
 * declines, the app shell mounts, and a signed-in visitor lands on /dashboard —
 * which is exactly what the label's OFF case promises.
 */
/** Whether `/` should render the PUBLIC marketing home. False (→ the app shell,
 *  whose `RootRedirect` handles it) for a signed-in visitor OR any legacy chat
 *  deep link. While auth or the front-page pointer is still resolving, an
 *  anonymous visitor stays on the public path (App.tsx shows a neutral splash),
 *  so the page never flashes app chrome before settling. */
export function shouldShowFrontPage(o: {
  onRoot: boolean;
  /** Retained for call-site clarity and the legacy tests; deliberately NOT read.
   *  See the CORRECTION note above — auth state does not decide what `/` shows. */
  hasUser: boolean;
  search: string;
  authLoading: boolean;
  frontPageLoading: boolean;
  frontPageEnabled: boolean;
}): boolean {
  return o.onRoot
    && !hasLegacyChatParams(o.search)
    && (o.authLoading || o.frontPageLoading || o.frontPageEnabled);
}
