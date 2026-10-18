# ADR 0892 — CRM is an opt-in bundle

Status: implemented (Phase A #4813, Phase B #4815, planning extension #4816)

## Context

The CRM sidebar group (CRM, Analytics) shows in every install, white-label
included. Measured on `origin/main` (`c0101e34e`), 2026-10-14:

- A sidebar item is hidden only when its toggle is off
  (`chrome/navConfig/resolveNav.ts:118`). The `crm` and `analytics` toggles
  defaulted **on** since ADR 0191 Phase 1, which flipped them so the bundled
  lighthouse templates would stop throwing `host_capability_disabled` mid-run.
- CRM is already a bundle: `distributions/bundles.json` has
  `"crm": ["crm","csm","analytics","email"]`, and it is a paid bundle (ADR
  0419/0820). But a bundle never changes visibility. The plan paywall bites only
  once `OPENWOP_BILLING_PLAN_FEATURES` is narrowed, and even then a plan-locked
  item is shown with a lock (an upsell), not hidden. Buying a bundle grants an
  entitlement and never turns its toggle on.
- No install-time or white-label default layer exists. Adopters get the compiled
  defaults; app.openwop.dev's posture is its stored toggle rows (a stored row
  always shadows the compiled default).
- Book AI (a forked repo with a feature package and a bundle row) and KickTodo (a
  frontend distribution plus operator toggle flips) both still run with CRM on.
- Every feature that hard-depends on CRM (`csm`, `email`, `commerce`,
  `territories`, `job-search`, and through `commerce`: `discovery`,
  `promotions`, `recommendations`, `kicktodo-commerce`) already defaults off.
- ADR 0191 Phase 2 already gives a lighthouse template a preflight that names a
  disabled feature before a run, so the crash Phase 1 prevented no longer needs
  the default-on.

## Decision

### Phase A (implemented, this ADR's PR)

1. **`crm` defaults off** (`features/crm/feature.ts`). Supersedes ADR 0191
   Phase 1 for `crm` (correction note added there). Variants, bucketing and salt
   are unchanged, so enabling CRM restores the A/B triage split.
2. **`analytics` stays on**, and its nav item moves from the CRM group to the
   always-present Marketing group. Analytics measures the public site, CMS pages
   and the ADR 0820 paywall funnel; turning it off with CRM would blind
   white-label installs. With CRM off, the CRM group then disappears entirely.
   `analytics` stays in the `crm` bundle (no composition change, so ADR 0820 §6
   deploy ordering does not apply).
3. **App migration 23, `grandfather-crm-on-for-existing-users`.** When no `crm`
   toggle row exists AND the database holds a CRM contact or a stored row
   enables a CRM dependent (globally or for one tenant), it writes the CRM
   default with status `on` (`updatedBy: app-migration:23`,
   `overriddenDefaultStatus: off`). Insert-if-absent and re-checked right before
   the write, so an admin's row and a concurrent boot always win. A fresh install
   has neither and stays off. The dependents list is pinned by a test against the
   live `dependsOn` closure.
4. **Enabling stays a super-admin action** (Admin → Feature toggles, globally or
   per workspace) until Phase B.
   > **Superseded by Phase B (2026-10-14):** a workspace owner/admin may now turn an
   > entitled bundle on for their own workspace. Global state stays super-admin only.

### Phase B (implemented): installing a bundle turns it on

Make a bundle a runtime-installable unit, reusing the existing seams:

- `POST /v1/host/openwop-app/marketplace/feature-bundles/:bundleId/enable` and
  `…/disable`, for a workspace owner/admin, allowed only when the workspace is
  entitled to the bundle (owned, plan-covered, unpriced, or billing off). Enable
  calls `enableTenantOverride` for each bundle feature plus its `dependsOn`
  closure (enabling `commerce` enables `crm`), writes one `recordToggleChange`
  audit row per id (the `host/demoProvision.ts` loop is the template), and
  refuses a killed toggle. Disable goes through the ADR 0194 disable-lock per
  tenant.
- A verified bundle purchase (the billing `grant-started` branch) calls the same
  helper. A lapse leaves the override; the ADR 0819 plan gate then shows the
  feature locked, and no data is deleted (ADR 0820 §7).
- The bundle store shows Enabled / Enable / Buy from the toggle map plus the
  entitlement, and never sells a bundle killed on the host.

#### Phase B decision record (D1–D11, as built)

- **D1 Authority.** `host:members:manage` in the ACTIVE tenant, through
  `callerHoldsTenantScope` (both identity spellings; a personal workspace's owner
  passes), or the host operator (`isSuperadmin`). Anonymous sessions and `anon:`
  tenants are refused. The tenant is never read from the body. The superadmin
  clause is an ADDITION to the brief, which named only the admin screen: an
  operator acting in a customer workspace would otherwise get a 403 for something
  the admin screen lets them do anyway.
- **D2 Entitlement first.** Every sellable feature of the closure is checked
  through `checkTenantEntitlement`, the seam `resolveOne`'s plan half uses, so
  "entitled" means exactly "the plan gate will not refuse it". A refusal is
  `402 bundle_not_entitled` with `details.{reason, missing, bundles}`.
  > **Refinement of the brief's wording:** the brief said "unpriced bundles …
  > are entitled". On a host with a NARROWED plan they are not, unless the plan
  > lists them, because `resolveEntitlements` gates every bundled feature, priced
  > or not (ADR 0419: the `free` allowlist must include the unpriced bundles). The
  > helper follows the plan gate rather than a second definition, so an unpriced
  > bundle the plan omits reads `locked` with no Buy. That is the operator's
  > `priced ⟹ gated` misconfiguration showing, not a new rule. With billing off, or
  > no plan narrowed, everything is entitled.
- **D3 Kill switch wins.** Any killed id in the closure refuses `409 feature_killed`
  (`details.ids`) before anything is written. If a kill lands mid-loop, the loop
  stops, reports what it already enabled, and returns the refusal.
- **D4 Closure.** Bundle features plus the transitive `getFeatureDependencies`,
  dependencies first (post-order DFS). Ids with no toggle default are `skipped`.
- **D5 Disable.** The bundle's own features only, dependents first.
  `tenantDisableBlockers` (service.ts) simulates a per-tenant `off` on each id and
  runs the existing `computeDisableBlockers`, keeping only this tenant's scope and
  ignoring dependents inside the same bundle (crm's `csm` does not block turning the
  crm bundle off). Refused `409 disable_blocked` (`details.dependents`).
  `disableTenantOverride` is the CAS twin of `enableTenantOverride`. No data is deleted.
- **D6 Audit.** One `recordToggleChange` per changed id, actions
  `feature-toggle.tenant-enabled` / `feature-toggle.tenant-disabled` (new),
  `principalId` = the acting user, plus a new optional `reason: "bundle:<id>"` in
  the payload (a static label; the row is permanent).
- **D7 Purchase.** `mutateBundleGrant` calls the helper on the `grant-started`
  transition, after the grant's CAS and its funnel count, with actor
  `billing:bundle-grant`. That transition includes a trial start, excludes a
  past-due recovery, and does not fire on a redelivered event. The call is awaited
  inside a try/catch; a refusal logs `warn`, a fault logs `error`, and neither
  changes the event's outcome or the webhook routing order. A lapse changes no
  override.
- **D8 Helper.** `host/featureBundleActivation.ts`: `enableBundleForTenant`,
  `disableBundleForTenant`, `bundleActivationState`, `bundleClosure`. It is
  host-level and imports no feature; billing reaches it, and it reaches billing only
  through the entitlement seam. `demoProvision.ts` keeps its own loop.
- **D9 Routes + state.** `POST …/marketplace/feature-bundles/:bundleId/enable|disable`.
  Unknown bundle → 404. `GET …/feature-bundles` adds `activation`
  (`{status: enabled|available|locked, missing?, killed?}` per bundle) and
  `viewer.canManageBundles`. A fault reading the state is `activationDegraded: true`,
  never "available". `locked` takes precedence over `enabled`, so a lapsed bundle
  shows its Buy path. The store therefore offers no Turn off for a lapsed bundle;
  the route still accepts it. The three error codes are new host codes in
  `OpenwopErrorCode` (vendor-prefixed if they ever reach a v2 envelope).
- **D10 Store UI.** The card shows the state, and Enable / Turn off for
  `canManageBundles`. A 402 toast names the missing features and opens the selling
  bundle's panel; a 409 names the killed or still-dependent features. On success
  the client calls `reloadEntitlementsNow()` (client/entitlementRefresh.ts, an
  explicit re-resolve with no cooldown) and re-reads the catalog. Strings ship in
  en/es/fr/pt-BR.
- **D11 Ratchet.** One new `resolveToggle` caller,
  `host/featureBundleActivation.ts` (visibility only; the plan is asked
  explicitly), listed in `test/feature-toggle-access-ratchet.test.ts`. Raw config
  reads stay inside service.ts.

### Extension (2026-10-14): planning surfaces are opt-in too

The owner asked for the same treatment for the three ADR 0229 default-on
planning surfaces. `strategy` and `priority-matrix` (bundle `leadership`) and
`advisory-board` (bundle `agents`) now default **off**; ADR 0229 is superseded.
None has a hard dependent. **App migration 24**
(`grandfather-planning-on-for-existing-users`) applies migration 23's rule per
toggle: no saved row and data for that feature (`strategy:record`,
`priority-matrix:list`, `advisory:board` rows) ⇒ write its default with status
`on`. The Planning nav group stays (Projects is always on). After this only
`analytics` and `chat-autotitle` ship on by default.

## Alternatives weighed

- **Build-time distribution excluding the crm bundle.** Removes the code from
  the SPA, but Cloud Run builds the default backend, the hard dependents go with
  it, and the bundle cannot be enabled later without a rebuild. Solves presence,
  not opt-in.
- **An env knob overriding compiled defaults** (`OPENWOP_FEATURE_DEFAULTS`). A
  third config layer behind stored-row shadowing; the white-label default would
  still have to be chosen somewhere, and it does nothing for prod. Worth it only
  if many defaults must differ per deployment.
- **A per-distribution `toggleDefaults` field.** Ties runtime defaults to a build
  input that is frontend-only in practice.
- **Turning `analytics` off with CRM.** Blinds the public-site beacon and the
  paywall funnel on white-label installs.

## Trade-offs

- Lighthouse templates on a fresh install show the "needs CRM" preflight until
  an operator enables CRM. That is the intended state.
- Until Phase B, a tenant that buys the CRM bundle on a host where CRM is off
  receives an entitlement it cannot see. This gap existed before (billing never
  flips toggles); Phase B closes it.
  > **Closed by Phase B.** Remaining edge: a purchase whose dependency the plan does
  > not cover (buying `commerce` without `crm` on a narrowed plan) is refused by
  > D2 and only logged. The buyer then sees `commerce` locked, with the `crm` Buy
  > path, until they own both.
- app.openwop.dev is unaffected: its stored `crm` row wins over the compiled
  default, and migration 23 never touches an existing row.
- Book AI and KickTodo lose CRM on fresh environments at their next upstream
  sync; environments with CRM data are kept on by migration 23. KickTodo's runbook
  must enable `crm` before `commerce`.

## Rules that apply

No protocol RFC: compiled defaults and `/v1/host/openwop-app/*` routes are host
extensions. ADR 0419 `priced ⟹ gated` is unchanged (gating is the plan,
visibility is the toggle; `resolveOne` still ANDs both). ADR 0366/0630: a
toggle default does not change distribution membership, and `crm` is not
graduated.

## Implementation record

| Phase | What | Where | Tests |
|---|---|---|---|
| A | `crm` default off | `backend/typescript/src/features/crm/feature.ts` | `test/adr-0892-crm-opt-in-default.test.ts` (replaces the ADR 0191 default-on test) |
| A | Analytics nav → Marketing | `frontend/react/src/features/analytics/routes.tsx` | — |
| A | App migration 23 | `backend/typescript/src/host/appMigrations.ts` | `test/app-migration-crm-grandfather.test.ts` (fresh, contacts, dependent, killed/off dependent, existing row, idempotence, dependents closure) |
| A | Docs | `FEATURES.md`, `frontend/react/WHITE-LABEL.md`, `CHANGELOG.md`, ADR 0191 correction | — |
| B | Helper (closure, entitlement, kill, disable-lock, audit) | `backend/typescript/src/host/featureBundleActivation.ts`, `host/featureToggles/service.ts` (`disableTenantOverride`, `tenantDisableBlockers`), `host/featureToggles/audit.ts` | `test/adr0892-bundle-activation.test.ts` (closure, per-tenant only, idempotence, 402 incl. a dependency-only gap, kill, unknown, disable + per-tenant lock, state) |
| B | Routes + catalog state | `backend/typescript/src/features/marketplace/routes.ts`, `src/types.ts` | `test/adr0892-bundle-activation-routes.test.ts` (viewer/editor 403, admin, personal owner, non-member, anon, body tenantId ignored, 402/409/404 shapes, catalog state) |
| B | Purchase auto-enable | `backend/typescript/src/features/billing/billingService.ts` | `test/adr0892-bundle-purchase-auto-enable.test.ts` (enables + audit actor, redelivery, refusal and a throwing helper both leave the webhook applied, lapse) |
| B | Store card | `frontend/react/src/features/marketplace/BundleShopPage.tsx`, `marketplaceClient.ts`, `i18n/*`, `src/client/entitlementRefresh.ts` | `__tests__/bundleActivation.test.tsx` (states, admin vs member, enable + reload, 402, 409, degraded, i18n parity) |
| B | Docs | `FEATURES.md` § The admin screen, `README.md` § Sell paid feature bundles, `CHANGELOG.md` | — |
| Ext | `strategy` / `priority-matrix` / `advisory-board` default off + app migration 24 | the three `feature.ts` files, `host/appMigrations.ts` | `test/app-migration-planning-grandfather.test.ts` (fresh, per-feature, saved row, idempotence); defaults pinned in `adr-0892-crm-opt-in-default.test.ts`; `strategy-cadence-feature-gate` leg (b) pins the per-tenant gate |

## Open questions

- [x] Phase B: letting a workspace admin write its own tenant override is a
      policy change (toggles are a super-admin plane today). Decided in the
      Phase B brief (D1, D3) and built as recorded above. **No `/architect` pass
      was run on it**, so this box records a decision, not a review.
- [ ] Phase B: per-tenant overrides live in one row per toggle; at thousands of
      tenants every enable is a CAS on a shared row. Consider a per-tenant index.
- [x] Should other default-on product areas (`priority-matrix`, `strategy`,
      `advisory-board`) follow CRM into opt-in? **Yes** (owner, 2026-10-14) — see
      the Extension above.
