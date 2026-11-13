# ADR 1106 — Adopter navigation and an optional core

Status: Accepted (2026-11-12). The user accepted the recommended answer to all
five open questions (recorded at the end). Nothing is built yet.

Requested in openwop/openwop-app#5786 (CasaVoga's review of the signed-in app as a
white-label adopter), tracks 2 and 3. Track 1 (nav defects) shipped as #5791.
Track 4 (an operator tier separate from the firm's admin) is an authorization
change and gets its own ADR. Builds on ADR 0139 (configurable navigation), ADR
0366 (distribution manifests), ADR 0820 §8.2 (re-adding a retired toggle) and ADR
1031 (the adopter feature seam). Host-internal: no run-event field, capability,
event type or endpoint contract changes, so no RFC is needed.

## Context

An adopter ships its own product on this app. Today it cannot shape the menu its
customers see, and cannot leave out features it does not sell.

**The menu.** `resolveNav` (`frontend/react/src/chrome/navConfig/resolveNav.ts`)
overlays two `MenuConfig` layers, `tenant ← user`, on the declared
`FEATURES[].nav`. Two gaps:

1. **Entries without a `featureId` cannot be hidden.** Step 2 of `resolveNav`
   skips `hidden` for them ("moved but never hidden", `types.ts` `ItemOverride`).
   That covers Work patterns, Brand, Projects, Workflows and about 30 admin
   entries.
2. **There is no adopter layer.** The `tenant` layer is stored per workspace, so
   every new customer workspace starts from the stock order and groups.

CasaVoga works around both locally (`adopter/navDefaults.ts`, its ADR CV-0186):
`adoptNav` rewrites the declared features before `NavConfigProvider` resolves
them. It has three lists: PLACE (group and order), HIDDEN (drop the menu entry, keep
the route) and OPERATOR (superadmin only). It needs one edit to a shared file.

**The core was already reclassified once.** ADR 0820 §8 (owner request,
2026-10-05) took core from 61 to 50:
- it moved evals, model-router, environments, code-exec, scheduled-agent-chats,
  chat-widget and chat-deployment into bundles;
- it decided to fold ambient-work-graph into workflow-author (§8.4, not yet done);
- it decided to **keep goals, proposals and task-deck in core** (§8.5);
- it deferred splitting assistant, cms, media and entities into sub-toggles to a
  later phase (§8.5).

This ADR extends that method, and does not overturn those decisions without
the user's say (Q5).

**The core today.** `distributions/bundles.json` has 55 features in `core`.
`scripts/gen-distribution.mjs` (`alwaysOnFeatureIds`) treats a backend feature
with no `toggleDefault:` as always-on, and always-on features must be in core.
A per-feature audit of the 29 features the issue names (all 29 are in core)
found:

- **7 already have a toggle:** developer-tools, usage-analytics, consent,
  marketplace, entities, walkthroughs, billing. The always-on rule does not hold
  them in core.
- **12 had a toggle that was retired.** `RETIRED_TOGGLE_IDS`
  (`backend/typescript/src/features/index.ts`) erases each one's stored overrides
  on every boot: ambient-work-graph, intent-ledger, task-deck,
  memory-auto-extract, profile-memory, cms, publishing, chat-export,
  interactive-artifacts, channels, brand, developer-keys. Re-adding a toggle
  under the same id would wipe every tenant's "off" at the next boot. ADR 0820
  §8.2 is the precedent for taking an id off the list. cms used new ids
  instead.
- **The distribution gate checks `dependsOn` only, never imports.** Excluding a
  feature removes its registry entry, but code that core imports still ships with
  its routes unregistered. Examples:
  - core `middleware/auth.ts` verifies developer keys on every request;
  - `host/exchange/persistExchange.ts` calls memory-auto-extract;
  - `host/exchange/dispatchTurn.ts` records usage with no toggle check;
  - the entities kernel holds every CMS page.
- **Several nav entries live in core `CORE_FEATURES`**, so a distribution cannot
  remove them: Heartbeat, Free tier, Runtime posture, Walkthroughs, Appearance,
  API keys. Others have no frontend package at all, because their UI is core chat
  code (intent-ledger, task-deck, chat-export, interactive-artifacts).

## Decision

### D1 — Every menu entry can be hidden from the menu

`hidden` applies to every entry. Hiding is presentation only:
- the route still resolves;
- its toggle, tier, scope and server checks are unchanged;
- the feature-toggle hard gate still runs first, so `hidden: false` never reveals
  a disabled feature.

A small **lock set** stays visible so a menu can always be repaired:
`nav.lockVisible: true` on Settings and Menu settings (Q1). A locked entry can
still be moved.

The rename: the `ItemOverride.hidden` doc and the resolver comment change from
"never hidden" to "hidden unless locked". The menu editor shows the hide switch
on every unlocked entry.

**Migration.** A stored `hidden: true` on an always-on entry is ignored today and
would start applying. The editor never offers that switch on such a row: it shows
an "Always on" chip instead (`MenuSettingsPage.tsx` `ItemRow`). But one path does
leave such rows behind. An entry hidden while it still had a toggle, whose toggle
was later retired (`RETIRED_TOGGLE_IDS`: cms, publishing, brand and others), still
carries `hidden: true` in the stored layer, and D1 would hide it again. So P1
first counts, read-only, the `menu-config` rows with `hidden` on a
no-`featureId` path. If any exist, P1 clears them in an app migration instead of
reviving a choice made under a different rule.

### D2 — An adopter base layer below the workspace

`resolveNav` gains a third layer. The merge order is **`adopter ← tenant ← user`**.

It is the same `MenuConfig` model, so there is no new data shape. An adopter can:
- re-home entries, including into Pinned;
- reorder them;
- hide them;
- rename, reorder and add headers.

A workspace's own edits and a person's personalization still layer on top.
"Reset menu" in Menu settings resets to the adopter layer, not to the stock menu.

**Where it is declared:** the ADR 1031 adopter seam. Add one row to the 1031 D1
table:

| What | Path | Owner |
|---|---|---|
| Adopter default menu | `frontend/react/src/adopter/menu.ts` exporting `ADOPTER_MENU: MenuConfig` | adopter |

How it is loaded, and what it holds:
- An eager glob loads it, the way `features/adopterFeatures.ts` loads adopter
  routes. When the file is absent, the layer is `EMPTY_MENU_CONFIG`, and the stock
  build is byte-identical.
- It is data, not a function. CasaVoga's PLACE and HIDDEN map onto it directly.
- Its OPERATOR list does not: that is authorization, which track 4 decides.

**Entries can be renamed, in the adopter layer only.** *(Added 2026-11-11, before
decision, from #5793 part 4.)* The adopter layer's `ItemOverride` may carry
`label`, `labelKey`, `hint` and `hintKey`, with keys in the adopter's
`adopter-menu` namespace. Today the host's `labelKey` wins over any literal, so
a rename needs its own key. The workspace and personal layers stay unable to
rename entries, as today. A rename should ship together with the page's own
wording (ADR 1107 D3). A menu entry called "Needs you" over a page titled
"Inbox" is worse than no rename, which is why CasaVoga has held back exactly
that rename.

**Header labels translate.** `HeaderDef` gains an optional `labelKey`, resolved in
the adopter's i18n namespace (`adopter-menu`, loaded by the 1031 i18n glob). A
literal `label` still wins, as today.

**Rejected:** a `menu` block in `distributions/*.json`. Those files are
upstream-owned and overwritten by the white-label sync, and a menu is the
adopter's product decision. A first-party distribution such as KickTodo uses the
same adopter path as everyone else.

### D3 — A feature leaves core only when it is safe to switch off

A feature moves from `core` to a bundle (or standalone) only when all four hold:

1. **It has a toggle** that is not in `RETIRED_TOGGLE_IDS`. The two ways in:
   - remove the id from the list under ADR 0820 §8.2, recording why;
   - or use a new id.
2. **Everything that reaches it degrades when it is off.** That covers `dependsOn`
   and import edges alike: core and other features check the toggle, or tolerate
   an empty result. The gate enforces it (D4).
3. **Its UI in core code is gated on the toggle:** chat-header buttons, dashboard
   tiles and any `CORE_FEATURES` nav entry get its `featureId`.
4. **The stock distribution keeps it on** (toggle default on, Q4), so no existing
   workspace changes. An adopter leaves it out with `exclude` in its distribution,
   or turns its toggle off.
5. **ADR 0820's mover rules apply:**
   - its `requireOrgScope`-only routes move to `authorizeOrgScope`;
   - its tools, surfaces and daemons resolve through `resolveOne` (§8.2);
   - the §6 deploy order holds: prod `PLAN_FEATURES.free` lists the id BEFORE
     the build that moves it ships, or the feature locks with no price.

### D4 — The distribution gate checks import edges

`gen-distribution.mjs` adds an import-closure check: no module that stays in the
build may statically import an excluded feature's package, unless the import
site is listed as toggle-guarded. The list is shrink-only, and each entry names
the guard and its test. Without this, D3.2 is a promise. With it, an excluded
build that still calls a dead package fails at generation, not in production.

### D5 — What moves, in three groups

From the audit (verdicts re-checked at implementation time):

| Group | Features | Work |
|---|---|---|
| **A — easy** | structured-handoffs, manual-tests, developer-tools, heartbeat-admin, runtime-posture, managed-tier-admin, tutorials | Toggle (new id, or off `RETIRED_TOGGLE_IDS` per 0820 §8.2), gate the daemon or `App.tsx` mount where there is one, `featureId` on its nav |
| **B — dependents first** | team-intent-ledger, profile-memory, usage-analytics, consent, channels, marketplace, portability, interactive-artifacts, walkthroughs | Each dependent degrades first. Examples: publishing's consent read; `dispatchTurn`'s usage write; the paywall's lazy marketplace import; the walkthrough player in core shell |
| **Already decided by ADR 0820 §8** | ambient-work-graph (§8.4: fold into workflow-author); goals, proposals, task-deck (§8.5: keep in core) | ambient-work-graph follows the fold, which removes its separate entry. The other three stay in core unless the user overturns §8.5 (Q5); their entries become hideable under D1 either way |
| **C — substrate, stays in core** | intent-ledger, memory-auto-extract, developer-keys, cms, publishing, brand, chat-export, entities, billing | Not removable without splitting service from surface. Their menu entries become hideable (D1) and, for operator surfaces, superadmin-only (track 4), which is what an adopter needs from them |

> **DECIDED 2026-11-12 (Q5):** the user moved **goals** and **task-deck** into
> group B, overturning ADR 0820 §8.5 for those two. **proposals** stays in core
> (a protocol and host surface, ADR 0820 §8; ambient-work-graph imports it). The
> row above is kept as written; this note is the change.

Group C, case by case:
- **cms and publishing:** they serve the public site and `/` (ADR 0027).
- **brand:** it is the white-label identity (ADR 0170).
- **entities:** its kernel stores CMS pages.
- **developer-keys:** auth verifies them on every request.
- **chat-export:** it owns `authorizeConversationRead`.
- **billing:** it is already toggle-gated and off by default, but it owns the
  Stripe webhooks and entitlements, so it stays in core as a package while its
  surface stays behind its toggle.

The issue's suggested true core is right in spirit. The difference is that
"Website product" is substrate here, so an adopter hides those entries rather than
removing them.

## Alternatives

- **An explicit `hideable` flag per entry** (issue option b) instead of D1's
  default plus lock set. Rejected: about 100 entries would need it, and the rule
  would invert again with each new feature. A short lock set is the smaller list.
- **Keep CasaVoga's `adoptNav` function as the seam.** Rejected: code that
  rewrites `FEATURES` can change tier or authority by accident, and it bypasses the
  resolver's tests. A data layer through `resolveNav` cannot.
- **Move every listed feature out of core at once, default off.** Rejected: group
  C would break the public site or auth, and default-off changes every existing
  workspace.

## Phases

| Phase | What | Tests / witnesses |
|---|---|---|
| P0 | This ADR, Proposed | — |
| P1 | D1: hideable entries, lock set, editor switch, read-only migration count (and a clearing migration if non-zero) | `resolveNav.test.ts`: a no-`featureId` entry hides; a locked entry ignores `hidden`; a disabled feature stays hidden under `hidden:false`. Menu editor test: the switch appears on unlocked entries. Sabotage: restore the old skip and the first case reds |
| P2 | D2: the `adopter` layer, the glob loader, `labelKey`, reset-to-adopter | Resolver: three-layer precedence (user beats tenant beats adopter); an absent file equals today's output byte for byte (the existing parity test). A fixture adopter menu in a build proves the glob, the way ADR 1031 P1 did. Then CasaVoga drops PLACE and HIDDEN for `ADOPTER_MENU` |
| P3 | D4: the import-closure check in `gen-distribution.mjs` | Script test: a fixture core module importing an excluded package fails generation; a listed guarded site passes. Run on today's tree, it must list the known edges (developer-keys in auth, memory-auto-extract in persistExchange, and so on) |
| P4 | Group A, one PR per two or three features | Per feature: toggle resolves on and off; off removes its nav and returns its routes 404 through `requireFeatureEnabled`; its daemon does not start. `RETIRED_TOGGLE_IDS` edits carry the 0820 §8.2 note. A distribution excluding the group builds and passes `check-whitelabel-build.sh` |
| P5 | Group B, one dependent seam at a time, then the move | Per seam: a route-level test with the feature off showing the dependent's degraded behaviour (empty, not 500). P3's check list shrinks with each |

Release notes: P1 changes what a workspace can hide (upgrade note). P4 and P5 add
toggles (MINOR under ADR 0052). No app migration unless P1's count is non-zero.

## Open questions (the user's decisions)

1. **The lock set:** Settings and Menu settings, or also Dashboard and Chat?
2. **Group C stays in core,** with hide plus operator-only as the adopter's tool.
   Agree, or should a phase split service from surface for any of them, cms first?
3. **The adopter menu lives at `src/adopter/menu.ts`** (adopter-owned), not in the
   distribution manifest. Agree?
4. **Moved features stay on by default** in the stock distribution, so no
   existing workspace changes. Or should groups A and B ship default-off in new
   workspaces only?
5. **ADR 0820 §8.5 kept goals, proposals and task-deck in core** (your decision,
   2026-10-05). #5786 asks to make them optional. Keep §8.5, with their entries
   hideable under D1, or move them into group B?

## Decisions (2026-11-12)

The user accepted the recommended answer to each question:

1. **Lock set:** Settings and Menu settings only. Dashboard stays reachable from
   `/` and the logo, and Chat from its deep links, when their entries are hidden.
2. **Group C stays in core.** No service/surface split now; hide plus
   operator-only (track 4) is the adopter's tool. cms has 23 importers outside
   its package (the public site, SEO, docs, migrations).
3. **The adopter menu lives at `src/adopter/menu.ts`**, the ADR 1031 seam, not in
   the generated distribution manifest.
4. **Moved features stay on by default.** No default-off for new workspaces.
5. **goals and task-deck move into group B; proposals stays in core.** Outside
   their packages, task-deck has no importers and goals only event-type and
   discovery registration. ADR 0820 §8.5 carries a correction note.
