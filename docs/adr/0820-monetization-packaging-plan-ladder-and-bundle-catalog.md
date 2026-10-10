# ADR 0820 — Monetization packaging: a plan ladder on the existing tier rail, a sale-readiness rule, and an 11-bundle catalog

Status: Accepted — partially implemented. §1 implemented in the strategy PR. P3 (plan ladder) and P5's
trials, past-due grace and annual cadence implemented 2026-10-05 (`feat/monetization-plan-ladder`; see the
§5 and §7 correction notes). Open: P2, P4, P6, P7 and P5's schedule auto-pause.

> **CORRECTED 2026-10-05 — this line read "Proposed (§1 implemented in the strategy PR; the rest awaits the
> owner's approval of `docs/steward/MONETIZATION-STRATEGY-2026-10.md`)".** The owner approved the plan the
> implementation workstreams run against, and code citing this ADR is merging, so "Proposed" was false
> (`test/steward/adr-status-not-stale.test.ts` flags exactly that).

Related:
- ADR 0176 — subscriptions, the plan-tier rail, entitlements;
- ADR 0366 — the bundle catalog and distributions;
- ADR 0385 — commerce-connect fees;
- ADR 0419 — paid feature bundles, `priced ⟹ gated`, DATA-419-2;
- ADR 0786 — the entitled-status predicate;
- ADR 0819 — `resolveOne` as the access resolver;
- ADR 0821 — AI credits and metering.

Evidence: `docs/steward/monetization-2026-10/{inventory,value-cost,benchmark,gating-audit}.md`.

## Context

The owner wants a much broader paid offering, built mainly by **bundling existing features into sellable
paid bundles**. These facts were measured on 2026-10-05, read-only:

1. **Prod billing is in Stripe TEST mode.** The vault's `billing:stripe-key` is `sk_test_…`, and every configured
   price is `livemode:false`.
2. **4 priced bundles:**

   | Bundle | Price per workspace |
   |---|---|
   | agents | $19/mo |
   | crm | $29/mo |
   | marketing | $79/mo |
   | job-search | $19/mo, priced 2026-10-05 at the owner's direction (rev `00857-6hq`) |

   The `free` plan lists 33 ids. Plan prices, plan limits and token packs are unset.
3. **One entitlement row exists**, and it is the operator's own (test subscriptions). Four signed-in workspaces
   ran anything in 30 days.
4. **The paywall surface:**
   - 142 registered features: 61 core, 51 in 13 bundles, 30 standalone. Only bundled, non-core features can ever
     be paywalled (`isSellableBundleFeature`).
   - CMS, publishing, KB, media and developer keys are always-on core with no toggle.
5. **Two composition defects reached prod:**
   - (a) The priced Agents bundle listed `twin`, but the toggle id is `twin-recall`. The twin was never gated on
     any lane. `gen-distribution --check` validates ids derived from import variable names, not toggle ids, so it
     stayed green.
   - (b) `job-search` was gated, unpriced and absent from `free`, a permanent 403 with no purchase path for every
     non-operator tenant. This is exactly the DATA-419-2 hazard, which ADR 0419 left to "the deploy checklist".
6. **Gaps survive ADR 0819.** Even with `resolveOne` paywalling every exit that calls it, lanes that call no
   resolver reach paid features: `ctx.canvas`, `ctx.ads`, video gen, the `commissions` surface, share-link mint,
   custom-domain serving and the public storefront (gating-audit G2–G14).
7. **Variable cost is concentrated in managed chat/agent turns** (platform MiniMax key; prod per-tenant cap 20M
   tokens/day). Feature generators are BYOK-only, and sends run on tenant vendor accounts.

## Decision

### §1 — Bundle ids ARE toggle ids, enforced by a test (implemented)
- **The invariant.** Every id in `distributions/bundles.json` `bundles.*.features` must be a registered toggle
  id: a `toggleDefault`, an `extraToggleDefaults` entry, or an imperative `registerToggleDefault({ id })`.
- **Enforcement.** `backend/typescript/test/bundle-ids-are-toggle-ids.test.ts` enforces it. It was red on `twin`
  before the fix.
- **The fix.** `twin` → `twin-recall` in `bundles.json`, and the export `twinFeature` → `twinRecallFeature`, so
  gen-distribution's variable-name-derived id agrees with the toggle id.

Alternatives:
- (a) Map package ids to toggle ids inside `featureBundles.ts`. That gives billing a second id namespace to
  translate on the hot path. Rejected.
- (b) Make gen-distribution read toggle ids. Correct long-term, but it changes how distributions strip
  registries, which is out of scope. Recorded as a follow-up.

### §2 — Packaging principles
1. **Flat per workspace, unlimited seats.** ADR 0419 grants per tenant. Scale is captured by **meters** (ADR 0821
   credits; per-unit domains and deploys), not seats. Per-seat pricing is rejected for now: no enforced seat
   meter exists (`setSeats` is unenforced), and the benchmark's closest analogues (Coda makers, Retool builders,
   Make and n8n workspace pricing) show flat-plus-meter is defensible.
2. **Money only in env.** Composition lives in `bundles.json`; prices, display copy and plan lists live in
   `OPENWOP_BILLING_*`. Unchanged from ADR 0419.
3. **`priced ⟹ gated` stays structural** (`isSellableBundleFeature` + `resolveOne`/`requireFeatureEnabled`).
4. **Bundles are jobs-to-be-done.** A bundle with a hard `dependsOn` on another is sold as "requires X". This is
   verified per bundle, never assumed: `job-search` declares `dependsOn: ['crm']` yet works without the CRM
   entitlement, because it uses CRM services directly.

### §3 — The sale-readiness rule (new, normative for operators and for us)
A bundle may be priced (added to `OPENWOP_BILLING_BUNDLE_PRICES`) only when:
- (a) every feature in it is READY on every lane in the gating audit (HTTP, tools, MCP, `ctx.features`, collab,
  schedules/triggers, recall, executor host capabilities, public-lane lapse policy); and
- (b) `scripts/check-billing-config.mjs` passes against the target env, before and after the change.

A bundle that cannot be enforced is not priced. That would be the dishonest paywall ADR 0419 forbids, one level
down. **Grandfathered exception:** crm, marketing and agents are already priced with known gaps (gating-audit
rows). They stay priced, since no external customer has bought, and their gaps are first in the queue.

### §4 — Bundle catalog (the proposed `bundles.json` diff)
Composition changes (not yet applied; see §6 for the deploy order):

```diff
   "core": [ …,
-    "environments",
+    "consent",
     … ],
   "bundles": {
     "customer-data-platform": { "features": ["cdp", "campaign-journeys",
-        "consent",
         "destination-sync"] },
     "canvases": { "label": "App Builder", "features": ["app-builder", "canvas-packs", "creative-video",
+        "code-export", "code-publish", "code-sync"] },
+    "support":    { "label": "Support",    "features": ["service-desk", "service-desk.widget"] },
+    "developer":  { "label": "Developer",  "features": ["claude-code", "computer-use"] },
+    "governance": { "label": "Governance", "features": ["environments"] }
   }
```

- **Consent moves to core.** Turning it off makes consent permissive (`consentService.ts:781`), so an unpaid
  tenant would lose enforcement. A protection must not be a paid feature.
- **The `code-*` sub-toggles join App Builder.** Today they ungate export/publish/sync independently of the
  bundle (gating-audit G5).
- **Environments leaves core.** The audit found it READY, with nothing depending on it.
- **Check needed before applying:** gen-distribution's registry lists the three sub-toggles and
  `service-desk.widget` as toggles, not as registered *features*. Applying the diff therefore requires
  gen-distribution to accept sub-toggle ids in a bundle, or the §1 alternative (b) follow-up. **This is the
  first thing to verify before applying §4.**

Price bands (env, per workspace per month; proposals):

| Bundle | Band |
|---|---|
| crm | $49 |
| marketing | $79 |
| agents | $29 |
| job-search | $19 (live) |
| sales | $29 (requires crm) |
| commerce | $49 (requires crm) |
| customer-data-platform | $99 |
| leadership | $19 |
| studio | $19 |
| canvases (App Builder) | $39 |
| support | $49 |
| developer | $29 |
| governance | $99 |

Editors, content and integrations stay unpriced and in `free`.

**Not bundled:**
- cms, media, publishing, kb — no toggle; read by core.
- proposals, webhooks, the MCP server — protocol/host surfaces.
- SSO/SCIM — host env; an Enterprise deployment SKU.
- voice — metered by ADR 0821.
- the KickTodo line — owner question.

### §5 — Plan ladder on the existing `PlanTier` rail
No new tier type. `free`/`pro`/`team`/`enterprise` already exist, with `OPENWOP_BILLING_PLAN_PRICES`,
`_PLAN_FEATURES`, `_PLAN_LIMITS`, `_PLAN_DISPLAY` and `/public/pricing`.

| Plan | Price / mo | Includes |
|---|---|---|
| `free` | $0 | core + unpriced bundles |
| `pro` | $39–59 | free + agents, leadership, studio, canvases |
| `team` ("Business") | $179–249 | pro + crm, sales, marketing, commerce, support, customer-data-platform |
| `enterprise` | custom | team + governance + deployment SKU |

Bundles stay purchasable à la carte. **`job-search` is excluded from every plan tier** (owner decision, 2026-10-05). It is sold only as its own bundle, and no `PLAN_FEATURES` list may contain it except through a purchased grant. The checker should hold this as a rule (P3). Code needed (P3):
- `bundleStore` marks a bundle `owned` when the plan's `allowedFeatures` already cover it, so we never sell
  what the plan grants;
- `refuseIfAlreadyLive` refuses a bundle checkout whose features the plan covers.

> **CORRECTED 2026-10-05 (P3 implemented, branch `feat/monetization-plan-ladder`).** Three details differ
> from the text above; the full record is the 2026-10-05 extension note in ADR 0419.
> - The store does NOT mark a plan-covered bundle `owned`. It carries a separate `includedInPlan` flag,
>   computed from the PLAN alone (never the operator bypass, never bundle grants), so "you paid for it" and
>   "your plan has it" stay distinguishable. `owned` stays purchase truth. The refusal is a 409
>   `bundle_included_in_plan` on both checkout routes.
> - The job-search exclusion is an operator knob, not a hard-coded id: `OPENWOP_BILLING_STANDALONE_BUNDLES`
>   (`["job-search"]` is the owner's prod value). Plan expansion strips a standalone bundle's features
>   however the plan names them. A plan left unrestricted (`'*'`/absent) while plans ARE configured becomes
>   "every bundle feature except the standalone ones", or `"enterprise": "*"` would quietly include
>   job-search. The checker ERRORs on a plan listing one.
> - Architect #3's `"bundle:<id>"` plan entries landed in the same change (an unknown bundle is ignored with
>   a warn; the checker ERRORs on it).

### §6 — Deploy order for any composition change (normative)
Moving a feature INTO a bundle locks it for free tenants the moment the build ships, unless `free` already lists
it. So:
1. Add the features to `PLAN_FEATURES.free`. This is a no-op while they are non-sellable, because
   `resolveEntitlements` unions every non-sellable id anyway.
2. Ship `bundles.json`.
3. In ONE env update, price the bundle and remove its features from `free`.
4. Run `check-billing-config.mjs --cloud-run …` green before and after each step.

Removing a feature from a bundle is the reverse, and is always safe.

### §7 — Revenue mechanics (decisions; code is phased)
- **Downgrade never deletes data.** Lapsed features refuse on every lane. A read-only export goes through
  `portability`.
- **Schedules and triggers of a lapsed feature auto-pause** (resume on re-entitlement) instead of failing every
  tick.
- **`past_due` grace:** `OPENWOP_BILLING_PAST_DUE_GRACE_DAYS` (default 0 = today's behaviour; proposed 7).
  `unpaid`/`canceled` revoke.
- **Trials:** `OPENWOP_BILLING_BUNDLE_TRIAL_DAYS` / a plan trial via Checkout `subscription_data.trial_period_days`.
- **Public-runtime lapse policy:** owner question Q5. The proposal is a 14-day grace window, then a neutral
  "unavailable" page. The per-visitor exemption is unchanged.

> **CORRECTED 2026-10-05 (P5 trials, grace and annual cadence implemented; auto-pause is NOT in this
> change — it touches `scheduleDaemon`, wave 2).** Differences from the text above:
> - **Trials:** one knob, `OPENWOP_BILLING_TRIAL_DAYS`, keyed `plan:<tier>` / `bundle:<id>`
>   (`{"plan:pro":14,"bundle:crm":7}`), not `OPENWOP_BILLING_BUNDLE_TRIAL_DAYS` plus a separate plan knob.
>   There is no default (the strategy's "default 14 for plans" would have changed behaviour on deploy).
>   A trial is offered only to a workspace that never had that subscription, so cancel-and-resubscribe
>   cannot mint endless trials.
> - **Past-due grace:** as written, plus two details. The clock is `pastDueSince`, recorded by the webhook
>   at the transition and kept across repeat `past_due` events. A row that went `past_due` before the
>   field existed has no recorded transition and gets no grace until its next event (fail-closed).
>   `isEntitledStatus` remains the ONE predicate. Supersession checks call it without `pastDueSince`, so a
>   `past_due` subscription never displaces another.
> - **Annual cadence:** `cadence:'month'|'year'` on bundle checkout, resolved from
>   `OPENWOP_BILLING_BUNDLE_PRICE_CADENCE`. It was cheap for plans too: `POST …/checkout {plan, cadence}`
>   via `OPENWOP_BILLING_PLAN_PRICE_CADENCE` (the `priceId` body still works). The store offers a yearly
>   Buy only when `BUNDLE_DISPLAY` publishes `priceAnnual`.

> **IMPLEMENTATION NOTE 2026-10-05 (public-lapse grace source registered).** #4434 shipped the owner-lapse
> policy (`host/publicLapse.ts`, knob `OPENWOP_BILLING_PUBLIC_LAPSE_GRACE_DAYS`, unset = today) with an
> UNREGISTERED grace-start seam, so the clock always started at the first refusal the host observed. Billing
> now registers `entitlementEndedAt` (`features/billing/billingService.ts`, from `features/billing/routes.ts`):
> - a `past_due` plan or grant past its past-due grace ended at `pastDueSince + OPENWOP_BILLING_PAST_DUE_GRACE_DAYS`
>   (inside that grace it is still entitled and never asked);
> - a canceled / unpaid / paused plan or recurring grant, or a revoked one-time grant, ended at that row's own
>   `updatedAt`. There is no dedicated transition stamp, and `updatedAt` is at or after the true end, so the
>   clock can start late, never early;
> - `incomplete` / `incomplete_expired` never paid and are skipped; the LATEST covering end wins;
> - anything billing cannot date honestly (a legacy `past_due` row with no `pastDueSince`, an operator narrowing
>   `PLAN_FEATURES`, an `active` downgrade) answers `null`, and the observed clock still applies.
> Witness: `test/adr0820-lapse-grace-source.test.ts` (boots `createApp`; RED before the registration — a grant
> canceled 20 days ago read `grace` with the clock at now).

> **IMPLEMENTATION NOTE 2026-10-06 (§5/§7 UI — the feature store redesign, branch
> `feat/bundle-store-redesign`, built on #4478's cadence labels).** `/marketplace/bundles` is now the store
> only; the ADR 0366 white-label composer moved to `/marketplace/distribution` with the same gate (the route
> table's `admin` tier + the `marketplace` toggle).
> - **One cadence.** A page-level Monthly/Yearly radiogroup (remembered per viewer in `localStorage`) drives
>   every plan and bundle price; the other cadence is always shown underneath. The saving is computed from the
>   operator's display strings (`features/marketplace/bundleStoreModel.ts`) and hidden when a string does not
>   parse unambiguously or nothing is saved. Every Buy/Subscribe button names the cadence it charges.
> - **Plans** come from `/public/pricing`; the store subscribes through the existing `POST …/checkout {plan,
>   cadence}` (new client call `buyPlan`). "Includes bundles worth $X/mo" appears only for a narrowed plan whose
>   every covered for-sale bundle has a parseable monthly price.
> - **Grouping is data.** `distributions/bundles.json` gained an ordered `groups` list and a per-bundle `group`;
>   `gen-distribution --check` rejects an undeclared or malformed group; the catalog projection serves both.
> - **Two store facts on `GET …/billing/bundles`:** `freeForNow` (priced, not owned, not plan-included, and no
>   plan allowlist narrows it — computed from the plan alone, so the operator bypass never reads as "free") and
>   `trialDays` (the trial THIS workspace's checkout would open with, `trialFor`'s eligibility). The store's FAQ
>   mentions a trial only when one is present.
> - **Not built:** the AI credit-pack strip. No client or public read lists the configured token packs
>   (`OPENWOP_BILLING_TOKEN_PACK_PRICES` maps price ids to tokens, with no display copy), so there is nothing
>   honest to render. Dates such as "free until Nov 5" are not shown: no read carries one.
> - **CORRECTED 2026-10-06 (PR #4481 review) — the two bullets above had the prod semantics wrong.** Prod SETS
>   `OPENWOP_BILLING_PLAN_FEATURES` and lists newly priced bundles on `free` as a complimentary notice period, so
>   the first cut said "Included in your plan" to every free tenant and never "Free for now". Now:
>   `includedInPlan` = an ENTITLED PAID plan covers the bundle; `freeForNow` = priced, not owned, not
>   paid-included, and the free list covers it OR no allowlist exists; a new `purchasable` = for sale, not
>   owned and not covered by the plan list the 409 `bundle_included_in_plan` reads. The store offers Buy only
>   when `purchasable`; a complimentary bundle shows "Free for now" and an introductory-period note instead of
>   a button that would 409. The server's refusal rule is unchanged. The Free plan card and the comparison no
>   longer count complimentary bundles as "included" in Free.
> Witnesses: `test/bundle-store-free-for-now.test.ts`, `test/gen-distribution.test.ts` (store groups),
> `test/marketplace-feature-bundles.test.ts`, and the frontend
> `features/marketplace/__tests__/{BundleShopPage,DistributionComposerPage,bundleStoreModel,storeGroupsI18n}`.

> **IMPLEMENTATION NOTE 2026-10-06 (§7 UI — the Marketplace hub, branch `feat/marketplace-hub-nav`).** The
> store, the pack registry and the composer had no shared wayfinding (two inline text links under the packs
> header, a "back" link on each of the other two). They are now ONE console on the existing ADR 0144/0145 hub
> primitive: each route declares `hubTab: { hub: 'marketplace', order, featureId: 'marketplace' }`, and
> `features/marketplace/MarketplaceHub.tsx` projects them through `visibleHubRoutes` with the shared
> `<Tabs>`/`<TabPanel>`, `HubProvider` (each page drops its own `<PageHeader>`) and a tab-keyed panel
> Suspense + ErrorBoundary (ADR 0715 D1). Tab order: **Feature store** (`/marketplace/bundles`) → **Packs**
> (`/marketplace`) → **Distribution** (`/marketplace/distribution`). The inline links are gone.
> - **One deviation from the other four consoles, and why: the tabs are PATH-routed, not `?tab=`.** Those
>   consoles front surfaces at unrelated URLs, so a query param is their only shared address. These three
>   already share `/marketplace/*` and are deep-linked as PATHS: lock links (`?feature=`), upgrade prompts
>   (`?bundle=`, `?view=compare`), Stripe return URLs (`/marketplace/bundles?checkout=…`,
>   `/marketplace?purchase=…`). So all three routes' element is the hub, which renders the matched route's page
>   (`PAGES`, keyed by tab id, held in the hub's lazy chunk so the manifest carries one lazy import, not four);
>   the active tab is the matched route and a tab click navigates — every existing URL keeps its meaning and
>   no backend URL moved. `HubId` gained `'marketplace'`; the projection, the gating and the tier filter are
>   unchanged code.
> - **Gate unchanged.** All three routes stay `admin` tier + the `marketplace` toggle, so a non-admin sees no
>   tab (the `<AdminLayout>` gate denies the page anyway) and Distribution is never shown to someone who could
>   not open it.
> - **Nav placement (decision).** The single "Marketplace" entry moved from **Developer** to **Billing &
>   commerce** (order 81, between Billing and "Sell on the marketplace") and now lands on the store, the hub's
>   primary tab; `activeFor: ['/marketplace']` lights it on every tab. Reason: the store is where a workspace
>   owner buys plans, bundles and credits, which is a billing act, while Packs is the secondary tab. One hub
>   entry, not two: the tabs carry the sub-wayfinding. The Billing page also gained a "Feature store" link in
>   its header (shown while the `marketplace` toggle is on). Cost: a saved menu override keyed on the old
>   `/marketplace` nav path no longer applies (overrides key on the route path); the item then shows at its
>   declared place.
> - **Header.** One H1 per tab, the hub's "Marketplace" (the console convention), eyebrow "Billing &
>   commerce", lede = the ACTIVE tab's own one-line description (the store no longer says "browse signed
>   packs").
> Witnesses: `frontend/react/src/features/marketplace/__tests__/marketplaceHub.test.tsx` (RED before),
> the updated `{BundleShopPage,DistributionComposerPage,buyScopeGate}` tests,
> `features/billing/__tests__/BillingPage.storeLink.test.tsx`, and the `hubPanelErrorBoundary` population list.

> **CORRECTED 2026-10-07 (§7 lapse auto-pause + read-only export implemented, PR #4533).** Two §7 bullets,
> graded against the code first:
> - **"Schedules and triggers of a lapsed feature auto-pause."** #4436 had shipped this as a PERSISTED pause:
>   the daemon set `enabled:false` + `planPause` on the job and a 10-minute sweep re-enabled it. That is tenant
>   state that must be undone exactly, and every lane that touches `enabled` (a person's toggle, member removal,
>   DSAR erasure, the sweep's own cadence and failures) had to agree with it. The schedules UI never showed it
>   either (a plan-paused job read as a plain "Paused"). **It is now a COMPUTED skip at tick time**
>   (`host/scheduleDaemon.ts` `planLapsedSkip`): a fire refused by the plan (`resolveOne` → `blockedBy:'plan'`,
>   from the job's `featureId` or its workflow's owning feature) records `lastSkipReason:'plan-lapsed'` +
>   `lastSkipFeatureId` and nothing else. The row stays enabled, its cadence/workflow/inputs/metadata are
>   untouched, no run (failed or otherwise) is created, and the first tick after re-entitlement fires — no
>   sweep, no manual step. A toggle switched off stays the distinct `feature-disabled` skip. Rows #4436 already
>   paused are still drained by `resumePlanPausedJobs` (no new ones are written; `pauseJobForPlanLapse` is
>   deleted). The "Paused — plan lapsed" chip is computed per READ (`host/schedulePlanLapse.ts`, re-asking
>   `resolveOne`), so it clears the moment access returns rather than at the next fire. No notification is
>   pushed (zero per lapse, within "at most one"). **Triggers** were already a computed skip
>   (`triggerIngestionService.ts` returns `skipped/feature-disabled`, the subscription stays armed) and are
>   unchanged.
> - **"A read-only export goes through `portability`."** It did not exist: `EXPORT_KINDS` carries no feature
>   data, and CRM's own CSV export sits behind `requireEnabled`, so a lapsed workspace could take nothing out.
>   Now `GET /host/openwop-app/export/features[/:featureId]` (portability, core) serves a feature's data through
>   a registered read-only exporter (`host/featureDataExport.ts`; CRM registers contacts, companies, deals,
>   tasks and activities). It serves when the feature is enabled OR refused only by the plan; a toggle switched
>   off stays refused (a kill switch is not a lapse) and an unresolvable answer fails closed. Authority is
>   `host:billing:manage` (built-in admin/owner, never mintable; anon refused first) — the people who can
>   resubscribe are the people who can take the data out. Every CRM write and read route still refuses.
> Witnesses: `test/adr0820-g6-run-start-gate.test.ts` (computed skip, exact config restored on re-grant,
> legacy drain; RED before), `test/adr0820-lapsed-feature-export.test.ts` (RED before),
> `frontend/react/src/schedules/__tests__/SubjectSchedulesPanel.states.test.tsx` (RED before).

## §8 — Core reclassification (amendment, 2026-10-05, owner request)

Evidence: `docs/steward/monetization-2026-10/core-audit.md`. Decisions, extending §4:

1. **Planning & Strategy.**
   - The `leadership` bundle is relabelled "Planning & Strategy" (the key is unchanged, so no stored grant
     moves).
   - Priced at $19 and included in `pro`. `strategy` and `priority-matrix` leave `PLAN_FEATURES.free` in the
     same env update that prices it.
   - Pre-pricing items:
     - a reader-side KB gate on the `mgd-strategy-*` / `mgd-priority-matrix-*` collections (G8);
     - the advisory-board strategy injection checks `resolveOne('strategy')`;
     - `comments` degrades when `priority-matrix` is refused.
2. **Core → bundle moves:**

   | Feature(s) | Target bundle |
   |---|---|
   | `evals`, `model-router`, `environments` | `governance` |
   | `code-exec` | `developer` |
   | `scheduled-agent-chats` | `agents` |
   | `chat-widget`, `chat-deployment` | `support` |

   Each always-on mover gains a `toggleDefault` (status `on`) and comes OFF `RETIRED_TOGGLE_IDS`. Its
   `requireOrgScope`-only routes move to `authorizeOrgScope`. Its tools, surfaces and daemons resolve through
   `resolveOne`. Feature-specific requirements:
   - `model-router` falls back to the default model when refused, never errors;
   - `scheduled-agent-chats` stamps `featureId` on its scheduler jobs, and the frontend `scheduled-chats` id
     collapses into it;
   - `chat-widget`'s public gateway follows the §7 lapse policy, using `resolveToggle` for the visitor lane plus
     a tenant-scoped plan check.
3. **Retire** the empty registry entries `context-economy`, `run-input-forms` and `models` (backend), and remove
   the `widgets` example from core.
4. **Fold** `ambient-work-graph` into `workflow-author`. **Merge** `assistant:project` into `projects:project`
   (a migration, measured first).

   > **IMPLEMENTATION NOTE 2026-10-05 (`assistant:project` RETIRED, not migrated).** Measured first, as the
   > item asks: prod held **0 `assistant:project` rows**, and **0 of 288** assistant commitments carried a
   > `projectId` (read-only, 2026-10-05). With nothing to move, "merge" became "retire": the assistant `Project`
   > type and store, the five `…/assistant/projects` routes, the `listProjects`/`getProject` surface methods and
   > the `feature.assistant.nodes` `list-projects`/`get-project` nodes (pack 2.0.0) are removed, along with the
   > store's erasure cascade and PII declaration. Redirecting the nodes to the projects service was rejected:
   > core projects carry member ACLs (`resolveProjectAccess`) that a tenant-scoped feature surface cannot honour.
   > A commitment's or decision's optional `projectId` is now documented as a CORE project id; the CoS already
   > reads the portfolio through `openwop:projects.list`, and its prompt needed no change.

5. **Keep core and relabel** `goals`, `proposals` and `task-deck`. Split `assistant`, `cms`, `media` and
   `entities` into sub-toggles in phase 2, which depends on gen-distribution accepting sub-toggle ids.
6. **Hygiene:**
   - fix the stale `scheduled-chats` nav `featureId`;
   - add an alias test: a toggled core feature's toggle id = its package id, or a listed alias (`settings` →
     `settings-shell`);
   - correct the stale toggle claims in feature headers and FEATURES.md rows 671–691;
   - make gen-distribution's always-on check see frontend-only and file-based features.

Core goes from 61 to 50. **Deploy order:** the §6 order applies to every move. Prod `PLAN_FEATURES.free` must
list each moved id BEFORE the build that moves it ships, or the feature locks with no price.

> **IMPLEMENTATION NOTE 2026-10-07 (§7 UI — the PUBLIC /pricing page, branch `feat/public-pricing-page`).**
> `/pricing` is the only pricing surface an anonymous visitor sees. It stays the CMS `pricing` section of the
> ONE `SectionRenderer` (prod has no authored `pricing` page on `host-site`, so the bare fallback serves),
> now split into its own lazy chunk `cms/PricingSection.tsx`:
> - **Feature names** come from a new `featureLabels` map on `GET …/public/pricing` — the toggle-registry
>   `label` the store's `/feature-bundles` read already uses — instead of a client-side humanizer (`csm` read
>   "Csm"). Each plan card lists only what it adds ("Everything in Free, plus:").
> - **One Monthly / Yearly switch** (radiogroup, the store's labels, the operator's `annualNote` inside the
>   Yearly option) drives plans AND bundles; it now opens on **monthly**, like the store. CORRECTION of R2-G7's
>   "annual is the default": a visitor who clicks "Choose Pro" lands in a store that shows monthly.
> - **Comparison** leads with one row per bundle (✓ / "Add-on · $29/mo" / "Sold separately") plus usage
>   limits, and expands to every feature grouped by bundle. `GET …/public/bundle-pricing` gained each
>   bundle's `features` and `standalone: true` for `OPENWOP_BILLING_STANDALONE_BUNDLES` members.
> - **CTAs:** Start free → `/chat`; Choose <plan> and each add-on → the store (`/marketplace/bundles[?bundle=]`);
>   an unpriced plan → "Contact us" at the section's new optional `contactUrl` (validated like `ctaUrl`; the
>   fallback uses `/p/support`). There is no signup route; sign-up is the header dialog.
> - The plan name stays the server's `Team`; the strategy doc's "Business" is not on the wire.
> Witnesses: `backend/typescript/test/public-pricing-page-payload.test.ts`,
> `frontend/react/src/features/cms/__tests__/SectionRenderer.pricingPublicPage.test.tsx` (both RED before),
> and the corrected `SectionRenderer.pricingCompare.test.tsx` cadence case.

## Architect pass (adversarial, decision text) — 2026-10-05

Run with `/architect`, Track A. There is no wire change: no conformance scenario exercises a bundled feature,
and discovery advertises none. Findings on THIS ADR, each corrected below while the original text above is kept:

- **#3 (High, SSOT): plan lists are a second owner of bundle composition.** `PLAN_FEATURES.pro/.team` are flat
  feature lists in env, so every `bundles.json` change drifts them silently, and the checker validated only
  `free`. **Corrected:**
  - `check-billing-config.mjs` now checks EVERY narrowed plan for locked-and-unbuyable ids (ERROR);
  - it also flags a plan holding part of a bundle (WARN), and a plan id in no bundle, i.e. a typo (WARN);
  - P3 gains `"bundle:<id>"` entries in `PLAN_FEATURES`, expanded via `featureBundles`, so plans reference
    bundles, not their features.
- **#4 (High, coupling): `computer-use` must NOT go to Developer yet.** The job-search `career-search` chain uses
  it and degrades to manual entry without it (`job-search/feature.ts:22-24`). Job-search was priced at $19 today.
  A feature cannot sit in two bundles. **Corrected:** §4's Developer bundle is `["claude-code"]` only. Where
  computer-use belongs (stay standalone, join job-search, or Developer with job-search copy changed) is an open
  question.
- **#5 (High, fail-closed): Support cannot be priced as drafted.** The public widget lane calls the paywalled
  `resolveOne('service-desk' | 'service-desk.widget', { tenantId })` with a resource subject
  (`service-desk/widgetRoutes.ts:92,94`, ADR 0819 as merged). Once the feature is sellable, an unpaid owner's
  widget 404s, and an entitlement-read fault 404s EVERY tenant's widget (the ADR 0819 A2 class). **Corrected:**
  a P2 pre-pricing item for Support: the widget lane moves to `resolveToggle` (a reviewed ratchet opt-out) plus
  the §7 lapse policy.
- **#7 (Medium, testability): §1 was proven only statically.** **Corrected:** `test/twin-recall-paywall.test.ts`
  is an HTTP route test. A free-plan tenant gets the plan 403 on a twin route, and the same tenant is served after
  an Agents subscription event (the positive control). Sabotage-witnessed: with `bundles.json` reverted to `twin`,
  both cases fail.
- **#10 (Low):** §3's grandfathering of crm/marketing/agents stands. Their audit gaps open the P2 queue.

Corrected §4 diff line: `"developer": { "label": "Developer", "features": ["claude-code"] }`.

> **IMPLEMENTATION NOTE 2026-10-07 (strategy §8 instrumentation — the paywall funnel, PR #4537).** Prod
> Stripe is live and nothing recorded the funnel. It is now measured by reusing existing surfaces, with no new
> pipeline and one new counts-only store:
> - **Refusals (backend).** Counted at the ONE plan verdict, `assertEntitled` in
>   `features/billing/entitlementGuard.ts`: an HTTP route's plan 403 is surface `route`, any `resolveOne`
>   `blockedBy:'plan'` is `lane`. `notePaywallEvent` (`host/paywallFunnel.ts`) is a synchronous Map
>   increment that never awaits and never throws; the buffer is flushed off the request (5 s timer, unref'd,
>   or at 200 keys) with a CAS increment. A lost buffer or race undercounts, as nav telemetry does. Refusals
>   are NOT gated on the telemetry toggle: they are server-side, tenant-level counts with no member in them.
>   The superadmin's own refusals are never counted, since they are plan-exempt before the verdict.
> - **Impressions and clicks (frontend).** `LockedState`, the Sidebar (desktop + mobile), ⌘K, the admin
>   rail, the admin overview and the chat `@@` picker report the locks they show and the upgrade links that
>   are followed, through ONE lazy module (`featureToggles/paywallBeacon.ts`) that posts
>   `POST …/analytics/paywall`. The entry chunk holds a single dynamic import of it, in `NavTelemetry`'s
>   existing effect, which runs only while `workspace-nav-telemetry` is on. That module now also posts the
>   ADR 0512 nav count (moved out of the entry), activates the funnel (until then events are held, never
>   sent), reads the Sidebar's locked links from the DOM and counts their clicks by delegation, so
>   `Sidebar.tsx` carries no funnel code (`chrome/__tests__/Sidebar.paywallFunnel` pins that contract
>   against the real markup). Entry cost: about 30 B gzip. The server re-checks both toggles. **Deviation 1:** impressions are
>   deduped once per feature **per surface** per page view, not once per feature. The Sidebar shows the same
>   lock on every page and renders first, so a feature-only key would almost never record the locked-page
>   impression, which is the one that matters most. **Deviation 2:** the beacon route reads its two toggles
>   with `resolveToggle` (a ratcheted ADR 0819 opt-out). `analytics` is sold in the CRM bundle, so
>   `resolveOne` would 404 the beacon for exactly the tenants who meet a lock, and the funnel would count
>   only workspaces that already paid. The lane serves no paid capability. The member disclosure banner now
>   names lock views and clicks too.
> - **Checkouts.** NOT copied into the new store. `billing:checkout` already records every session
>   (`createdAt` = started, `fulfilledAt` = the webhook saw it paid). The `billing:webhook-event` ledger
>   named in the strategy holds only event ids, with no tenant or product, so it cannot answer the question.
>   That ledger ages out at 30 days, so the read offers 7 or 30 days only. Demo-mode sessions are reported
>   apart and never counted as started.
> - **The read.** `GET /v1/host/openwop-app/billing/admin/funnel?days=7|30`, behind `requireSuperadmin`,
>   cross-tenant and not gated on the `billing` toggle (like `usage-by-feature`). Per feature (with
>   per-surface splits) and per bundle it gives impressions, clicks, click rate, refusals, refused
>   workspaces (distinct, so a daemon's per-tick re-checks do not inflate the reach figure), checkouts
>   started and completed, completion rate, and active grants. It also gives paid plans per tier. A rate
>   with no denominator is `null`. Active grants are a snapshot of now; churn over time is still open.
>   The UI is `features/billing/PaywallFunnelPanel.tsx`, lazy-loaded on `/billing` for a superadmin only.
> - **Lifecycle.** `paywall:funnel-counts` rows are `(UTC day, tenant, metric, featureId, bundleId,
>   surface) → count`, with no user, session or URL. They age out after 90 days (kvAgeOut) and are covered by
>   an `internal` retention purger. They are classified no-subject in `test/subject-erasure-coverage.test.ts`
>   and reclaimed on tenant teardown via the `tenantId` field. A (day, tenant) slice is capped at 400 rows.
> - **Operator consequence.** `workspace-nav-telemetry` defaults OFF, so lock views and clicks read 0 until
>   an operator turns it on for a workspace (or globally). Refusals and checkouts need no toggle.
> Witnesses: `test/paywall-funnel-routes.test.ts` (RED 6/9 against the pre-change guard and routes),
> `test/paywall-funnel-report.test.ts` (the arithmetic), and in the frontend
> `featureToggles/__tests__/{paywallBeacon,lockedNavPaywall}`, `chrome/__tests__/Sidebar.paywallFunnel` and
> `features/billing/__tests__/BillingPage.funnel` (RED 5/7 against main's wiring).

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | No new package. Billing and marketplace are extended. `bundles.json` is catalog data. |
| 2 | Toggle / admin UI | No new toggle. The store's "included in plan" state (P3). |
| 3 | Workflow surface | Unchanged; G3/G6 gate executor capabilities and run start by the owning feature (code phases). |
| 4 | Node pack | `feature.sales-commissions.nodes` surface rename (G2). |
| 5 | AI chat / envelopes | None. |
| 6 | Agent pack | None. |
| 7 | Public surface | Lapse policy (§7). The visitor exemption is kept. |
| 8 | RBAC | Unchanged (`host:billing:manage` buys, ADR 0786). |
| 9 | Replay | Entitlement stays a live read, never run-stamped (ADR 0419). |
| 10 | Frontend | Store "included" state; locked-state copy. |

**RFC verdict: none.** Host-extension billing under `/v1/host/openwop-app/billing/*`. No wire, capability or
normative change.

> **IMPLEMENTATION NOTE 2026-10-07 (§7 — the public `/pricing` FAQ, branch `feat/pricing-faq`).** Placed here,
> not inside §7, so sibling PRs editing §7 do not collide. Prod has no authored `pricing` CMS page, so
> `features/site/PricingPage.tsx` renders a CODE fallback; it now appends two ordinary sections after the tier
> grid: a `faq` section (the existing R2-G10 type: native `<details>`/`<summary>`, plain-text answers, and the
> prerender's FAQPage JSON-LD when an operator authors it) and a `cta` section to `/p/support` (FAQ answers
> carry no links by design). An authored `pricing` page still replaces the whole fallback, FAQ included.
> - **Numbers come from the read, not the copy.** `/public/pricing` gained per-tier `trialDays` (from
>   `trialDaysFor`, absent when unset) and `billingPolicy: { pastDueGraceDays, publicLapseGraceDays }` (from
>   `pastDueGraceDays()` / `publicLapseGraceDays()`, the parsers that enforce them; `null` = lapse policy off).
>   No Stripe id. The client (`features/site/pricingFaq.ts`) leaves out any sentence whose fact is
>   unconfigured, and renders no FAQ on a deployment with no paid offer.
> - **Claims, by source.** Credits: `host/managedCredits.ts` (free daily → plan monthly per UTC month → packs;
>   D3 unit rates). BYOK: chat turns on a bound key never reach the managed meter, and background text stays
>   managed unless `preferForText` (`host/headlessAi.ts`). Packs never expire: `billing:token-balance` has no
>   expiry field. Monthly credits do not roll over: a fresh `managed:plan-allowance-month` row each UTC month.
>   Trials: first subscription only (§7 correction above), card collected by Checkout. Cancel: the portal
>   session uses the account's default portal configuration (no `configuration` param in `stripeApi.ts`); the
>   "access until the period ends" sentence assumes that configuration cancels at period end, which Billing
>   then shows (`cancelAtPeriodEnd` → "Access until"). Data on lapse + export: PR #4533, plus #4587
>   (exporters for every paid bundle, "Your data" on Billing), which ships in the same merge train; the FAQ
>   says "export its data from Billing" and is only true with #4587 merged. Refunds: none promised; the answer points to support.
> - **Not done:** client-side FAQPage JSON-LD. The SPA emits no JSON-LD anywhere (only the server prerender
>   does, for authored pages), so the code fallback adds none; an operator who authors the page gets it.
> Witnesses: `backend/typescript/test/public-pricing-page-payload.test.ts` (RED before: 2 failed),
> `frontend/react/src/features/site/__tests__/pricingFaq.test.tsx` (RED before: 3 failed).

## Phases

| Phase | Content | Gate / witness |
|---|---|---|
| P1 | §1 bundle-id test + twin fix; `scripts/check-billing-config.mjs` (§3b) | **Done in the strategy PR.** Test red on `twin`. The checker reproduces the job-search ERROR on the pre-2026-10-05 env. |
| P2 | Gating gaps G2–G14 per bundle (strategy §5), after ADR 0819 merges and the audit is re-run | each bundle's audit row READY |
| P3 | Plan ladder code: store "included", refuse plan-covered bundle checkout | billing route tests — **implemented 2026-10-05** (`test/billing-plan-ladder.test.ts`, red 14/19 before) |
| P4 | Apply the §4 composition (after gen-distribution accepts sub-toggle ids) in the §6 order | `gen-distribution --check`, the bundle-id test, the checker |
| P5 | Trials, past-due grace, schedule auto-pause, annual cadence at checkout | billing tests — **trials, grace and cadence implemented 2026-10-05**; schedule auto-pause open (wave 2) |
| P6 | Price changes and new prices (env + Stripe) | **owner approval per bundle** |
| P7 | Stripe live mode | **owner approval** (strategy §7) |

> **IMPLEMENTATION NOTE 2026-10-07 (§7 — the export for every paid bundle, its UI, and two lapse loose ends;
> branch `feat/monetization-export-ui`).** Placed here, not under §7, so sibling PRs appending to §7 do not
> collide. It extends the PR #4533 correction above:
> - **Exporters for every paid bundle's data-bearing features**, on the same seam (`registerFeatureDataExporter`)
>   and through each feature's own tenant-scoped reads: campaign-brief (briefs, versions, angles, VoC,
>   targeting, personas, hooks), creative-briefs, funnels, webinars, commerce (products, orders, coupons,
>   quotes), promotions, territories (types, models, territories, rules, assignments, quotas),
>   sales-commissions (plans, statements), dealers (dealers, outlets, registrations), strategy (strategies with
>   key results, check-ins), priority-matrix (lists, ideas, sessions), app-builder (the `canvas.app-builder`
>   documents), campaign-orchestration (campaigns, versions), advisory-board, twin-recall (grants) and job-search (applications, listings, attestations).
>   Three read-only helpers were added where the existing read WROTE or CAPPED: `listAllHooks` (the UI list
>   caps at 200), `listApplicationsReadOnly` (`listApplications` provisions a pipeline and self-heals a
>   binding), `listGrantsForTenant` (only a per-user list existed). **Capabilities are never exported:** a
>   product's `downloadAssetTokens` become a count, app-builder sync bindings (a sealed webhook secret) and
>   dealer partner tokens are left out, attestations come without `tokenHash`. **Advisory board exports SHARED
>   boards only**: a private board is readable by its creator alone and an admin-class export must not widen
>   that (a follow-up if owners want their private boards: a creator-scoped export).
> - **Skipped — no meaningful tenant data (checked for a feature-owned store):** `campaigns` (a frontend
>   console, no service), `campaign-channels` and `custom-domains` (no feature store), `insights-suite` (one
>   config row; results are runs and artifacts, ADR 0082), `scheduled-agent-chats` (a config row; its schedules
>   are already handled by the computed skip), `sales-maps` (a geocode cache), the `code-*` sub-toggles.
> - **NOT done — data-bearing, a follow-up:** `campaign-connectors` (pixels, conversions), `campaign-intel`
>   (pacing), `recommendations` (placements, affinities), `discovery` (collections, merch rules),
>   `commerce-ucp*` (protocol surfaces over commerce rows). Bundles outside the brief (CDP, Support, Studio,
>   Developer, Governance) have no exporter yet either.
> - **Bounded:** the door pages every section (`?offset=`, `?limit=` ≤ 2000; `page.totals`, `page.nextOffset`).
>   The exporter still materialises the tenant's rows in memory per request (the feature reads are not
>   paginated); the RESPONSE is bounded.
> - **Discovery for the UI:** `GET …/export/features` keeps `features` and adds `exportable: [{featureId, label,
>   access}]` — what THIS workspace can export now (entitled or plan-lapsed), same `host:billing:manage` authz.
> - **UI.** The plan-lock page (`LockedState` renders only for a plan lock: toggle on, not entitled) shows
>   "Export your data" to a billing manager when the door lists the feature as plan-lapsed; it rides the
>   `LockedUpgradePrompt` module the panel already loads, so the entry chunk gains nothing. Billing gains a
>   lazy "Your data" panel (admin/owner). Downloads walk the pages and save one JSON via `downloadBlob`.
> - **Triggers:** a plan refusal now skips as `plan-lapsed` (both the subscription's `featureId` gate and the
>   workflow-owning-feature gate), the twin of the schedule daemon's `planLapsedSkip`; a toggle switched off
>   stays `feature-disabled`. No UI shows a trigger skip reason (the result is not persisted; only the webhook
>   response carries it), so there is no chip to add.
> - **Anonymous store:** a signed-out visitor on `/marketplace/bundles` got the catalog's 401
>   `sign_in_required` folded into "Bundles could not be loaded". The page now branches on that explicit 401
>   and shows a sign-in card that opens the header sign-in and returns to the same store URL; the helper moved
>   from `PricingSection` to `auth/signInReturn.ts` and is shared.
> Witnesses: `test/adr0820-lapsed-export-all-bundles.test.ts` (RED before: 48 of 77), the trigger legs in
> `test/adr0820-g6-run-start-gate.test.ts` (RED before: 2), `frontend/react/src/features/marketplace/__tests__/anonymousStore.test.tsx`
> (RED before: 3), `frontend/react/src/features/billing/__tests__/{dataExport,dataExportClient}.test.ts(x)`.

## Open questions
- [ ] Go-live date and account (strategy Q1).
- [ ] Price bands, the plan ladder and the bundle composition (Q3, Q4, Q6).
- [ ] The public lapse policy (Q5).
- [ ] KickTodo packaging (Q8).
- [ ] Should gen-distribution move to toggle ids (the §1 alternative (b))? It is needed for §4's sub-toggle
      bundling.
- [ ] Where does `computer-use` belong (architect #4)?

> **IMPLEMENTATION NOTE 2026-10-07 (strategy §8 — the funnel digest, branch `feat/monetization-funnel-digest`).**
> Follows the PR #4537 note in the architect pass above. Three changes:
> - **Checkouts and grants are daily counts now.** They live in the same `paywall:funnel-counts` store as
>   server-only "ledger" metrics (`checkout-started`, `checkout-completed`, `checkout-demo`, `grant-started`,
>   `grant-ended`). Each row is keyed by `(UTC day, tenant, metric, product, 'billing')`, where product is
>   `plan:<tier>`, `bundle:<id>` or `pack:<key>`. The client beacon cannot write these metrics.
>   - **Started** is counted where the `billing:checkout` row is put.
>   - **Completed** is counted only by the delivery that WINS the row's existing `fulfilledAt`
>     compare-and-swap. A redelivered event, or `async_payment_succeeded` after `completed`, adds nothing.
>   - **Grants** are counted on the grant compare-and-swap in `mutateBundleGrant`, from the state that write
>     replaced. A redelivery rewrites the same state, so it is no transition.
>   - **Cutover, exact per row:** new ledger rows carry `startedCounted` / `completedCounted`. The read still
>     counts unmarked (older) rows from the ledger and never counts a row twice. **Correction to the #4537
>     note:** the counts store's TTL goes from 90 to 92 days, so day −89 stays whole.
> - **`days=7|30|90`.** Past 30 days, checkouts come from the counts alone, so a 90-day view counts nothing
>   from before this shipped. The panel says so for the 90-day view.
> - **Churn: counted going forward.** History cannot be derived. A grant row keeps only its current
>   `status`/`stripeStatus` and `updatedAt`, and the webhook-event ledger holds bare event ids.
>   - A **new grant** is a grant becoming entitled, trials included. A recovery of the same subscription
>     from `past_due`/`unpaid`/`paused` does not count.
>   - A **cancellation** is a grant reaching a terminal Stripe status (`canceled`, `incomplete_expired`) from
>     a paying or recoverable state. A never-paid `incomplete` that expires does not count.
>   - One subscription superseding another is neither. Plan (tier) churn is not counted yet.
> - **Weekly summary.** `GET …/billing/admin/funnel/weekly` (`requireSuperadmin`) compares the last 7 UTC days
>   with the 7 before. Each change is `(now − before) ÷ before`, and `null` when before is 0. The panel
>   renders it as a "This week vs last week" header.
>   - **Delivery:** for the ISO week that just ended, `features/billing/funnelWeeklySummary.ts` sends ONE
>     in-app notification per `OPENWOP_SUPERADMIN_TENANTS` workspace (type `billing.funnel-weekly-summary`,
>     links to `/billing`). A shared workspace's notice goes to its `admin` role (the `runNoticeAudience`
>     rule). It reuses the notification center. **There is no email leg:** the host has no operator email
>     channel, and notification email is only the per-recipient approval opt-in.
>   - **Cadence:** the weekly sweep-daemon idiom of the CRM snapshots (an hourly unref'd poll), not a new
>     scheduler and not a scheduler job.
>   - **Once per week, fleet-wide:** `storage.claimOnce('paywall-weekly-summary:sent:<isoWeek>')`, taken after
>     the read and before the emit. At-most-once: a crash between claim and emit loses that week's notice.
>     With no operator listed, nothing is claimed.
>   - **OFF by default:** it runs only with `OPENWOP_BILLING_FUNNEL_WEEKLY_SUMMARY=true`. The start in
>     `index.ts` checks it, and so does every pass.
> - **Lifecycle is unchanged in kind:** counts only, no user, session or customer identifier, and the store is
>   still classified no-subject. No new store was added. The weekly notice carries totals only.
> Witnesses:
> - `test/paywall-funnel-digest.test.ts` (11 tests). Sabotage-witnessed: counting without the CAS win gives
>   3 completions instead of 1; counting every grant write fails both churn tests; dropping the week claim
>   double-sends.
> - `test/paywall-funnel-routes.test.ts`: 90 accepted and 60/0/91 refused, the day −89 vs −90 boundary, and
>   the weekly route 403 for customers and 200 for the operator (RED 3/11 before).
> - `features/billing/__tests__/BillingPage.funnel` (RED 3/7 before).
