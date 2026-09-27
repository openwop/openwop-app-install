# ADR 0196 — Enterprise posture: showcase-mode & developer-tools gating

Status: implemented (Phases 1–4, 2026-07-02; Phase 5 resolved as docs-only — see the OQ-2 correction)

> **Renumbered 0194 → 0196** (2026-07-02): a parallel session merged its own ADR 0194/0195 first; per `docs/adr/README.md` first-created is canonical, so this ADR took the verified next-free slot. Branch commit messages retain the historical numbers.

## Phase → commit table

| Phase | What shipped | Commit |
|---|---|---|
| 1 — toggle + client read | route-less `features/developer-tools/feature.ts` (demo-aware default), `BACKEND_FEATURES` wiring, `test/developer-tools-toggle.test.ts` (4), FEATURES.md row | `feat(developer-tools): register the developer-tools toggle` |
| 2 — Gate B (inspectors) | lazy `NetworkInspectorMount` (recorder install + panel behind the toggle; entry −1.4 kB), Sidebar button gate, `EnvelopeInspector` mount gate, manual-tests `nav.featureId` + not-enabled StateCard (4 locales), manifest pin test | `feat(developer-tools): gate the inspector surfaces` |
| 3 — Gate A (showcase) | `useDemoMode()` extraction + seven gates (bundled prompts, Try-it-free, PublicShell chips, sign-in copy fork, banner copy fork + regex fix, Runs About card, Load-example + Workforces create CTA), 6 keys × 4 locales | `feat(chrome): gate showcase content behind demo mode` |
| 4 — identity posture | Privacy demo/enterprise fork (stale "coming soon" → signed-in rules; 9 enterprise keys × 4 locales), `useEffectiveAccess` + Sidebar admin-nav role filter (ADM-8), `appGate` posture note | `feat(chrome): enterprise identity posture` |

## Corrections (implementation vs the proposal — the reasoning trail)

- **Phase 1 / client read:** no `developerToolsEnabled()` cache-module sibling of `demoMode.ts` was built — every consumer is a React component, so `useFeatureAccess('developer-tools')` is the single client read (a second cached-flag module would have been helper duplication). The demo seed is likewise not a boot write: the feature's `toggleDefault.status` is **demo-aware** (`demoMode() ? 'on' : 'off'`), and a stored admin override always wins — write-if-absent semantics with zero writes (resolves OQ-4).
- **DEMO-9 / the banner:** the ADR said "replace the `in-memory|brute-force` regex with `demoModeCached()`". Implementation showed that would REGRESS a real host running in-memory storage (the non-durability disclosure is legitimate outside demo). The probe **survives** (minus the `brute-force` arm, a rate-limiter false positive); the **copy** forks on demo mode — demo framing vs a neutral non-durable-host disclosure.
- **OQ-1:** resolved as proposed — the envelope inspector's *presence* is gated (component not mounted), not merely collapsed.
- **OQ-2 / discovery advertisement: DROPPED.** `demoMode` in the discovery doc is a *global env* read; `developer-tools` is *tenant-scoped* (per-tenant overrides), so advertising it as an install-global host field would be dishonest for any overridden tenant — and no client consumes it (the FE reads toggle resolution; the CLI has no reference). Clients that ever need it use the toggle-resolution surface. No wire-adjacent artifact ships.
- **OQ-3:** resolved as proposed — `bucketUnit: 'tenant'`.
- **Phase 4 / ADM-8:** `isAdminCaller` also admits any `host:*:manage` scope so a custom-role admin keeps the nav entry; presentation-only (backend remains the authority). **SHELL-4** (first-run onboarding empty-state) split out to the UX backlog — ADR 0188's implemented `VendorSetupPrompt` covers the first-run setup moment; the welcome-state composition is separate product work.
  - **SHELL-4 completion note (2026-07-05):** delivered by making the existing chat empty-state **first-run-aware INSIDE `chat/WelcomeCard`** — NOT a new component or onboarding surface (an architect review rejected a separate `renderEmptyState` override as a parallel surface; WelcomeCard stays the single owner of the chat empty state). A signed-in first-timer sees a dismissible "getting started" strip teaching the three input grammars (`type` · `/` · `apps`); a returning user opening a new empty thread keeps the steady WelcomeCard. The first-run signal reuses the **ADR 0188 per-uid localStorage pattern**, now extracted to a shared `onboarding/firstRunFlag` helper that BOTH `WelcomeCard` (feature `getStarted`) and `VendorSetupPrompt` (feature `vendorSetup`, key byte-identical) route through — one key scheme, no drift. The "connect your apps" step is a quiet inline link to `/access?tab=connections` (delegates, never re-implements the connect flow), deliberately lighter than the `VendorSetupPrompt` banner so the two first-run surfaces don't both dominate first paint. Pure SPA (no wire/RFC/backend); dismissal also fires when the user engages any card/pill. Strings ×4 locales.

**Date:** 2026-07-02
**Toggle:** `developer-tools` · default **OFF** · `bucketUnit: tenant` (an install-wide operator decision, not per-user) · plain on/off (no variants)
**Surface:** no new HTTP routes — this is a **gating seam** over surfaces that already exist. Host-extension posture only; nothing touches the OpenWOP wire.
**Composes (all implemented):** `client/demoMode.ts` + backend `host/demoMode.ts` (the existing showcase flag, advertised at `routes/discovery.ts:433`); the feature-toggle system (ADR 0001 / FEATURES.md) via `featureToggles/FeatureAccessContext.tsx` (`useFeatureAccess(id)`) and the manifest `nav.featureId` gate; `brand/defaults.ts` (the install config SSoT); ADR 0170 (brand/appGate); ADR 0188 (first-run onboarding).
**RFC verdict:** **No RFC.** `demoMode` is a **host-specific** discovery field (`routes/discovery.ts:433`; absent from `../openwop/spec` and `../openwop/schemas` — grep-confirmed 2026-07-02), and the new `developer-tools` toggle is an ADR-0001 host feature. Nothing here is normative wire.

---

## Context

This app began life as a throwaway **demo** and later grew a proper **demo-mode toggle**
(`OPENWOP_DEMO_MODE` → `host/demoMode.ts` → advertised as `demoMode` in the discovery doc →
`client/demoMode.ts`). The contract is explicit and correct: *when `demoMode` is false a
clean / white-label install boots empty and production-grade* (`host/seed-data/SEEDING.md:77`).

The `/grade-ux` pass of 2026-07-02 (see `docs/steward/UX-ASSESSMENT.md`, collection **Demo-DNA Leaks**,
grade **D**) found the app is **structurally enterprise-grade** — best-in-class design system,
backend-driven data, real designed empty states, and seeding correctly gated in ~4 places
(`chrome/AutoSeedExampleData.tsx:23`, `agents/AgentDashboardPage.tsx:165`,
`chat/lib/workflowMentions.ts:117`, `runs/RunsIndexPage.tsx:66`). **But the `demoMode` gate
is incompletely applied**: eleven demo/developer surfaces never consult it and therefore render
to production and white-label tenants, undercutting the enterprise read. They fall into two
distinct classes, which is the whole reason this ADR exists:

1. **Showcase CONTENT** — seed rosters, marketing chips, sample prompts, "about this app"
   dev cards, "load example" escape hatches. This is *demonstration material*; it should hide
   exactly when `demoMode` is false. (These simply need the existing flag applied.)
2. **DEVELOPER/INSPECTOR surfaces** — the Chrome-DevTools-style network inspector, the per-turn
   wire-shape envelope inspector, the manual-test QA runner. These are *engineering tools*. An
   enterprise legitimately may want them **on** for its own developers on a non-demo install —
   so coupling them to `demoMode` is wrong in both directions (they leak on the public demo's
   behalf into production, yet can never be enabled deliberately by an operator).

Conflating the two under one flag is the design error. This ADR introduces the **second gate**.

## Boundaries audit (Step 3)

- **Namespace / collision:** `git grep -niE 'developer.?tools|devTools|showcaseMode|developer-tools'`
  over `frontend/react/src` + `backend/typescript/src` (2026-07-02) matches only the existing
  `devtools/` *directory* (`App.tsx:4,12`, `devtools/NetworkPanel.tsx`) — **no `developer-tools`
  toggle exists**; the id is free.
- **Single owner of "is this a demo":** `host/demoMode.ts` (`demoMode()`), surfaced to the
  client once via `client/demoMode.ts` (`demoModeCached()` / `loadDemoMode()`). We **compose**
  it; we do not add a second showcase signal.
- **Single owner of "is a feature on for this caller":** the feature-toggle system — server-
  authoritative resolution + `useFeatureAccess(id)` on the client, and the manifest `nav.featureId`
  field that hides a nav entry when the toggle is off (reference: `features/usage-analytics/routes.tsx`).
  The `developer-tools` gate **reuses this**; it invents no new gating mechanism.
- **Backend RBAC already enforces in non-demo:** `host/accessControlService.ts:998` returns
  `{roles:['owner'], scopes:[...OWNER_SCOPES]}` **only** `if (demoMode())`. So a clean install
  already resolves real per-caller roles/scopes; the "admin surfaces are ungated" UX finding
  (ADM-8) is a **frontend nav-visibility** gap (nav shows items a non-admin will 403 on), not a
  missing authorization layer. Corrected here; the frontend fix is folded into Phase 4.
- **Onboarding is owned by ADR 0188** (`chrome/VendorSetupPrompt.tsx`, implemented) — the
  sign-in-first empty-state (SHELL-4) **extends** it, it does not fork a new onboarding surface.
- **Capability honesty:** we advertise `demoMode` (already true) and MAY advertise
  `developerTools` in the host block of the discovery doc so the CLI/clients can reflect it; both
  are host-specific fields, honored by real gating. No provider/capability is claimed that isn't wired.

## Decision

**Adopt a two-gate model and apply it exhaustively to the leak inventory.**

**Gate A — `demoMode` (existing):** hides all *showcase content*. Extend its reach to every
content leak below. No new mechanism.

**Gate B — `developer-tools` (new ADR-0001 toggle, default OFF, `bucketUnit: tenant`):** gates
every *engineering/inspector* surface. Default OFF means a clean install is inspector-free; an
operator can turn it ON in `FeatureTogglePanel` to give their own engineers the wire tools. On
the **public demo, `developer-tools` ships ON** (seeded alongside `demoMode`) so the reference
deployment keeps teaching the wire — the demo's actual purpose.

**Gate C — install-config default (one-line posture change):** flip `brand/defaults.ts`
`appGate: { mode: 'none' }` guidance so a white-label build is **sign-in-first**, not anonymous-
cookie. The `none` mode remains available (it is what the public demo uses), but the *documented
default posture* + the Privacy page copy assume persistent, signed-in tenancy. (The Privacy
rewrite and the sign-in-first onboarding empty-state compose ADR 0002/0015 + ADR 0188.)

### The leak inventory → gate mapping (normative for this ADR)

| # (UX id) | Surface | `file:line` | Gate |
|---|---|---|---|
| DEMO-1 | Network inspector button + panel + recorder boot | `chrome/Sidebar.tsx:181`, `App.tsx:125,253`, `devtools/NetworkPanel.tsx` | **B** `developer-tools` |
| DEMO-2 | Per-turn envelope/wire inspector | `chat/MessageBubble.tsx:277` | **B** `developer-tools` |
| DEMO-3 | Manual-test QA runner nav + route | `features/manual-tests/routes.tsx:11`, `features/registry.ts:75` | **B** (`nav.featureId:'developer-tools'`) |
| DEMO-4 | Bundled sample prompts merged into user library | `prompts/promptsClient.ts:91,125` | **A** `demoMode` (or explicit "Starter templates" group) |
| DEMO-5 | "Try it free / no API key needed" BYOK on-ramp | `byok/ProviderGrid.tsx:12`, `byok/i18n/en.ts:90` | **A** `demoMode` |
| DEMO-6 | "Sign in to save your work / wiped every 24h" | `auth/i18n/en.ts:70` | **A** `demoMode` + **C** copy |
| DEMO-7 | "Explore the demo →" public-header chip | `chrome/PublicShell.tsx:30` | **A** `demoMode` |
| DEMO-8 | Privacy page (anon tenancy + "signup coming soon") | `PrivacyPage.tsx:47`, `chrome.ts:151,186` | **C** rewrite (compose 0002/0015) |
| DEMO-9 | "Anonymous demo session" banner (impl-string sniff) | `builder/InMemoryHostBanner.tsx:61` | **A** `demoMode` (replace the `in-memory\|brute-force` regex) |
| DEMO-10 | "About this app / seeded workflows / `src/host/index.ts`" card | `runs/RunsIndexPage.tsx:349` | **A** `demoMode` |
| DEMO-11 | "Load example agents" + Workforces "Load example data"-only empty state | `agents/AgentDashboardPage.tsx:264`, `workforces/WorkforcesGalleryPage.tsx:116` | **A** `demoMode` + real create-path CTA |

Copy leaks that survive gating (DEMO-13 env-vars/paths, DEMO-14 "edit RenderInterrupt.tsx",
DEMO-15 "cancelled from sample UI", DEMO-16/17 toy identities) are **content-neutral polish** —
tracked in `docs/steward/UX-ASSESSMENT.md` and handed to `/plan` + implementation, not gated by a toggle.

## Data model

- **No new persisted entity.** `developer-tools` is a feature-toggle row in the existing toggle
  store (id, status, `bucketUnit:'tenant'`, salt) — identical shape to every other ADR-0001 toggle.
- Discovery doc gains an optional host field `developerTools: boolean` beside `demoMode`
  (`routes/discovery.ts`), resolved from the toggle for the requesting tenant. Client caches it
  the same way `demoMode` is cached (a sibling of `client/demoMode.ts`, or a `useFeatureAccess('developer-tools')`
  read where a hook context is available).

## Phased plan

- **Phase 1 — the `developer-tools` toggle + client read.** Register the toggle (backend
  `toggleDefault` status `off`, `bucketUnit:'tenant'`, salt; FEATURES.md row). Add the client
  resolver (`developerToolsEnabled()` sibling to `demoModeCached()`, or `useFeatureAccess`).
  Seed it ON in the public-demo seed alongside `demoMode`. (S)
- **Phase 2 — gate the inspector surfaces (Gate B).** DEMO-1 (network button + panel + the
  `installNetworkRecorder()` boot call itself), DEMO-2 (envelope inspector), DEMO-3 (manual-tests
  `nav.featureId:'developer-tools'`). Each becomes a `useFeatureAccess('developer-tools')` /
  `nav.featureId` gate. (M)
- **Phase 3 — gate the showcase content (Gate A).** DEMO-4..7, 9, 10, 11 — apply
  `demoModeCached()`; convert "Load example" affordances to explicitly-labelled, demo-only
  actions; give Workforces a real "create your first workforce" CTA (composes AGENT-1). (M)
- **Phase 4 — enterprise identity posture (Gate C) + nav role-filter.** Document sign-in-first
  as the default posture; rewrite the Privacy page for persistent tenancy (compose 0002/0015);
  add the sign-in-first onboarding empty-state (extend ADR 0188); **filter admin-tier nav by the
  caller's resolved role** (ADM-8 — the backend already enforces; this stops showing a non-admin
  a nav item they'll 403 on). (M)
- **Phase 5 — Core-app extension surface.** No node pack, no agent pack, no `ctx.*` surface, no
  envelope types — **this feature has none by design** (it is a gating seam, not a product
  surface). The only wire-adjacent artifact is the optional `developerTools` **read** field on
  the host block of `/.well-known/openwop` (Phase 1). Advertised honestly (reflects the toggle).

## Alternatives weighed

- **One gate (`demoMode` for everything).** Rejected: couples "developer tooling" to "this is a
  demo", so an enterprise can never enable the wire inspectors for its own team, and every
  inspector stays demo-coupled forever. The two classes have genuinely different lifecycles.
- **A build-time env flag for the inspectors** (`OPENWOP_DEVELOPER_TOOLS=true`). Rejected: not
  per-tenant, not runtime-manageable, invisible in `FeatureTogglePanel` — inconsistent with the
  ADR-0001 governance model every other operator control uses.
- **Delete the inspectors outright.** Rejected: the network + envelope inspectors are genuinely
  useful engineering tools and the reference deployment needs them; the problem is *ungoverned
  exposure*, not existence.

## PRD-vs-architecture corrections

The `/grade-ux` gap list framed the fix as "gate 11 surfaces on `demoMode`." The architecture
correction is that **they are not one class** — three of them (network/envelope/manual-tests) are
developer tooling an operator may want ON in production, so they get a *separate, default-OFF*
toggle rather than the demo flag. The gap list also asserted "no RBAC on the admin tier"; the
backend audit (`accessControlService.ts:998`) shows RBAC **is** enforced when not in demo mode,
so that item is reclassified from "missing authorization" to "frontend nav-visibility" and
folded into Phase 4.

## Open questions

- **OQ-1:** Should `developer-tools` also gate the `EnvelopeInspector`'s *presence* or just its
  default-collapsed affordance? (Proposed: gate presence — a non-dev install shouldn't ship the
  component at all.)
- **OQ-2:** Do we advertise `developerTools` in the discovery doc, or keep it client-only? (Proposed:
  advertise — the CLI (`@openwop/cli`) and A2UI clients benefit from reflecting it; it's a cheap
  honest host field.)
- **OQ-3:** `bucketUnit` — `tenant` (proposed, install-wide operator decision) vs `user` (let an
  individual dev flip their own tools). Proposed `tenant`; a per-user dev-tools preference can be a
  later refinement.
- **OQ-4:** Should the public-demo seed set `developer-tools` ON via the seed registry, or should
  `demoMode()` imply `developer-tools` as a fallback default? (Proposed: explicit seed — keep the
  two flags independent so the implication never leaks.)
