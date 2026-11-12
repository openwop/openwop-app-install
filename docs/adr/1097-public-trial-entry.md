# ADR 1097 — A public "Start your trial" entry into the existing Stripe trial checkout

Status: Accepted — implemented (`feat/public-trial-entry`).

Numbering: drafted as 1096, renumbered to 1097 before the PR opened, because open PR #5715
(`docs/adr/1096-site-style-tokens.md`) holds 1096.

Related: ADR 0176 (billing), ADR 0419 (paid feature bundles), ADR 0786 (billing money truth),
ADR 0820 §7 (trials), ADR 0890 (no-card trials), ADR 0630 (feature-declared public pages),
ADR 0015 (workspace = tenant), ADR 0711/0779 (`requireTenantScope`).

## 1. Context

A trial starts only from inside the app today: the billing page, the feature store, or a plan
card on `/pricing` that sends a signed-in visitor to the store. An adopter's marketing site wants
a button such as "Start your 7-day trial" that takes a visitor who may have no account straight
to the trial checkout for one named plan or bundle.

Everything a trial needs already exists. `OPENWOP_BILLING_TRIAL_DAYS` (ADR 0820 §7) sets the
days per `plan:<tier>` / `bundle:<id>`. `trialFor` grants one trial per plan or bundle per
workspace. `OPENWOP_BILLING_TRIAL_CARD` (ADR 0890) makes the card optional. Every checkout goes
through the ONE Stripe client via `createCheckoutSession`, and fulfilment is the ADR 0786
webhook. What is missing is a public URL, and a way for that page to know, before it says
anything, whether a checkout would actually include a trial for this visitor's workspace.

## 2. Decision

**D1 — One public URL, keyed like the knobs.**
`/start-trial?plan=<tier>` or `/start-trial?bundle=<id>`, optionally `&cadence=month|year`
(default `month`). `plan` and `bundle` are the halves of the existing `plan:<tier>` /
`bundle:<id>` keys, so the operator writes the same name in `OPENWOP_BILLING_TRIAL_DAYS` and in
the button's link. Parsing is strict (`features/billing/startTrialRoute.ts`): exactly one of
`plan` or `bundle`, a paid tier (`pro`, `team`, `enterprise`), a bundle id in slug shape, and
one cadence. Anything else is the "this link does not name a plan" state, never a guess.

The page is declared through the ADR 0630 `publicRoutes` seam on the billing frontend feature,
so it renders in the bare `PublicShell` for anyone, and a distribution without billing has no
trial page. It is `noindex` (`applyUnlistedHead`).

**D2 — Signed out: the existing sign-in, the existing return.** The page opens the header's own
sign-in / sign-up dialog (`openHeaderSignIn`) and remembers this exact URL with the shared
`auth/signInReturn` helper, the same one `/pricing` and the store use. No second return
mechanism. The helper's guard is now an allowlist of exact paths (the store and
`/start-trial`), resolved against `window.location.origin`: the value must start with a single
`/`, contain no backslash or whitespace, resolve same-origin, and have a pathname on the list.
The query is kept. The old guard was a `startsWith('/marketplace/bundles')` prefix test, which
also admitted look-alikes such as `/marketplace/bundles-x`. Firebase redirects and password
sign-in both land back on `/start-trial`, which consumes the remembered return on first render.

**D3 — Signed in, no workspace: the existing provisioning read.** In this app a signed-in user
always has an intrinsic personal workspace. `GET /me/workspaces` creates its record on first
read (`ensurePersonalWorkspace`), and billing is keyed by the session's tenant. So the "first
workspace" step is that read, not a create-workspace form. The page calls `listMyWorkspaces()`
before anything else and shows which workspace the trial will belong to. A failed workspace read
costs only the name, and the page says "this workspace" instead. This differs from the brief's
"first-workspace flow": the flow it describes does not exist because it is not needed.

**D4 — A read that says what the checkout would give: `GET …/billing/trial-offer`.** None of the
existing endpoints can answer "would a checkout of plan X include a trial for this workspace?".
`/public/pricing` reports the configured days, not this workspace's eligibility. `/billing/bundles`
covers bundles only. Recomputing `trialFor` in the browser would be a second copy that drifts.
So `trialOffer()` (`billingService.ts`) answers it, using the same functions the checkout uses:
`priceForPlan` / `priceForBundle` for the price, `trialFor` for the days and the once-per-workspace
rule, and `checkoutOptionsFor` for `cardRequired`. It reports one of six states:

| `status` | Meaning | What checkout would do |
| --- | --- | --- |
| `available` (+ `trialDays`, `cardRequired`) | priced, configured, not used | send `trial_period_days` |
| `not_for_sale` | no price at that cadence, or no such bundle | 404 |
| `already_subscribed` | an open plan row, or an entitled bundle grant | 409 (D7) |
| `included_in_plan` | the plan grants every feature of the bundle | 409 |
| `no_trial` | no `TRIAL_DAYS` entry, or a one-time bundle | a paid checkout |
| `trial_used` | configured, but this workspace had the subscription before | a paid checkout |

It also reports `checkout: 'live' | 'demo'` (whether a Stripe key resolves), so the page never
sends anyone to the demo sentinel. The read uses local state only and never calls Stripe. The
D7 reconcile and the 409s in `createCheckoutSession` stay the authority, and the page shows their
message if they refuse.

**D5 — The same gates as checkout.** The route calls `requireFeatureEnabled(req, 'billing')` (404
when billing is off) and then `requireBillingManage` (the ADR 0786 D5 authority:
`host:billing:manage`, with the anon refusal first). A member who could not start the checkout
learns that from this read, before any session exists. In a shared workspace the page offers
"Use my personal workspace" (`switchWorkspace(personal)`, where the personal short-circuit
admits the user) and reads the offer again.

**D6 — The checkout is the existing one, and the page redirects only to a trial.** "Continue to
checkout" calls `buyPlan(tier, cadence)` or `buyBundle(id, cadence)`. These are the routes the
store uses, so the call goes through `createCheckoutSession` and the ONE Stripe client, with
the routes' own success and cancel URLs (`/billing?checkout=…` for a plan,
`/marketplace/bundles?checkout=…` for a bundle). The page follows the returned URL only when it
is a `live` session, its URL is `https://`, and it carries `trialDays`. A session without
`trialDays` (for example a race where another tab used the trial) is NOT followed: the page says
the checkout would not include a trial and links to the normal page. No session is created on
page load. The visitor confirms with one click after seeing the days, the workspace, and whether
a card is needed. Why: a GET link never creates a billing object, and the workspace that will
hold the trial is shown before it is chosen.

**D7 — Every other outcome is a named state with a way out.** An invalid link, sign-in not
available on the host, billing off, not allowed in this workspace, a failed read (retryable,
never "no trial"), checkout not connected, and each non-`available` status have their own copy
and a link to `/pricing`, `/billing` or `/marketplace/bundles?bundle=<id>`. No dead ends, and no
"trial started" screen: Stripe's page is the next thing the visitor sees, and the webhook decides
the grant.

**Money truth is unchanged.** No new Stripe client, webhook, store, entitlement path or env
var. The only server addition is a read.

## 3. Alternatives considered

- **Create the checkout session on page load and redirect immediately.** Fewer clicks, but a
  GET link would then mint a Stripe session and a `checkout-started` ledger row for every crawler
  or link preview that follows it. The visitor would also not see which workspace the trial lands
  in. Rejected for the one-click confirm in D6.
- **Compute eligibility in the browser from `/subscription` + `/bundles`.** It would duplicate
  `trialFor` (the plan half reads `endedSubscriptionIds`, which the SPA does not model) and drift
  the first time the rule changes. Rejected for D4.
- **A query-string `returnTo` on the sign-in dialog.** It would be a second return mechanism beside
  `signInReturn`, and a query parameter is exactly what an open redirect is built from. Rejected for
  D2.
- **An app-managed or Stripe-less trial.** Out of scope by the owner's decision. It would be a
  second entitlement path beside the ADR 0786 webhook.
- **A `site`-tier route (ADR 0641) instead of `publicRoutes`.** A site route renders with product
  nav and is meant for participant surfaces. A campaign landing page belongs in the bare
  marketing shell, like `/pricing`.

## 4. Trade-offs

- The offer read is a preview. It can say `available` when the D7 reconcile then refuses (a local
  row Stripe has since changed). The page then shows the 409's own sentence. It never redirects,
  and it never claims a trial.
- `trial-offer` is admin-class, like `ai-credits`: an editor gets a 403 rather than a preview of
  the workspace's billing history. The cost is that an editor sees "ask an owner" instead of the
  days. That is the honest answer, since they cannot start it.
- Trial farming through fresh accounts is the ADR 0890 §4 exposure, unchanged. A public button
  makes it easier to reach, not larger. Keep `TRIAL_CARD=required` for a target where it matters.
- The tighter return guard drops a remembered `/marketplace/bundles/<anything>` path. Nothing
  writes one: the store's deep links are query strings.

## 5. Operator setup

1. Stripe live: `billing:stripe-key` and `billing:webhook-secret` set, the webhook registered,
   and the `billing` toggle ON (README § "Sell paid feature bundles").
2. A price for the target: `OPENWOP_BILLING_PLAN_PRICES` (plan) or `OPENWOP_BILLING_BUNDLE_PRICES`
   (bundle), plus `_PRICE_CADENCE` for a yearly link.
3. `OPENWOP_BILLING_TRIAL_DAYS={"plan:pro":7}` (or `"bundle:<id>":7`).
4. Optional: `OPENWOP_BILLING_TRIAL_CARD={"plan:pro":"if_required"}` for a no-card trial.
5. Point the button at `https://<app-host>/start-trial?plan=pro`. Run
   `node scripts/check-billing-config.mjs` after any change.

## 6. Implementation record

| What | Where |
| --- | --- |
| `trialOffer()` + `TrialOfferStatus` | `backend/typescript/src/features/billing/billingService.ts` |
| `GET /host/openwop-app/billing/trial-offer` | `backend/typescript/src/features/billing/routes.ts` |
| Same-origin allowlist for the remembered return (`safeReturnPath`, `START_TRIAL_PATH`) | `frontend/react/src/auth/signInReturn.ts` |
| Link grammar, page, `publicRoutes` registration, client (`getTrialOffer`, `CheckoutSession.trialDays`) | `frontend/react/src/features/billing/{startTrialRoute.ts,StartTrialPage.tsx,routes.tsx,billingClient.ts}` |
| Strings (en, es, fr, pt-BR) | `frontend/react/src/features/billing/i18n/*.ts` |
| Tests | `backend/typescript/test/adr1097-trial-offer.test.ts` (11), `frontend/react/src/features/billing/__tests__/StartTrialPage.test.tsx` (20), `…/startTrialRoute.test.ts` (3), `frontend/react/src/auth/__tests__/signInReturn.test.ts` (4) |
| Docs | README § "Sell paid feature bundles", FEATURES.md billing row |

The backend test checks parity: an `available` offer's days equal the `trial_period_days` the
live checkout then sends (mock Stripe), and a `trial_used` offer matches a checkout that sends
none.

Sabotage witnesses, run while authoring (each restored after):

- `trialOffer` using the configured days instead of `trialFor`'s answer turned the `trial_used`
  case red (`expected 'available' to be 'trial_used'`).
- Removing `requireBillingManage` from the `trial-offer` route turned the anon and editor cases red.
- Removing `session.trialDays &&` from the page's redirect condition turned "a session without a
  trial is not followed" red.
- Reverting `safeReturnPath` to a `startsWith` prefix test turned the look-alike path case red.
  Removing only the origin comparison stayed green, because the `//` and absolute-URL refusals run
  first. Both checks are kept as defence in depth, and the test header says so.

## 7. Open questions

1. **Sign-up through the dialog.** The page relies on the header dialog offering account creation.
   Whether a given install allows self sign-up (versus invite-only) is that install's auth config.
   With sign-up closed, a new visitor gets the dialog's own refusal, not this page's.
2. **Cross-domain CTAs.** A button on another domain works as a plain link. The return path is
   same-origin to the app host, so after an OIDC redirect the visitor lands on the app's
   `/start-trial`, not back on the marketing site. The Stripe success URL is the app's billing
   page or store.
3. Not verified against a live Stripe account. The tests use a mock Stripe API (as ADR 0820 §7 and
   0890 do).
