# 0188 — First-run vendor setup prompt

Status: implemented

## Context

The day-1 UX audit (2026-07-02, `~/tmp/openwop-day1-defects-and-improvements.md`
item A2) found the app has **no onboarding surface at all**: after sign-in a
Google-shop or Microsoft-shop user is never asked to connect their org's apps,
even though the backend has full PKCE OAuth flows (ADR 0024), capability-typed
binding (Phase 2 / ADR 0186), and a vendor-grouped catalog (ADR 0185). The
connections console sits behind Admin → Access, three levels deep. The single
biggest conversion lever named in the audit is one question after signup:
*"What does your org run on?"* → one-click consents.

## Decision

A **self-gating chrome surface** (`chrome/VendorSetupPrompt.tsx`, mounted once
in `App` beside `AutoSeedExampleData` — the established chrome-mount precedent),
NOT a feature package with a toggle:

- **Why no feature toggle:** `useFeatureVisible` requires a backend toggle row
  (`byId[id]?.enabled === true`); a UI-only prompt would drag a backend feature
  registration along for a dismissible modal. Instead the prompt is gated by
  hard conditions that make it useful by construction:
  1. signed-in user only (anonymous demo sessions never see it),
  2. not previously dismissed for this user,
  3. **the host can actually connect something** — ≥1 OAuth-configured
     provider (ADR 0024 `oauthConfigured` honesty flag) in a recognized
     vendor group (ADR 0185 `vendor` field). A host with dark Connect
     buttons never shows the wizard — no dead-button onboarding.
  If it ever needs central kill-switching, promoting it to a toggle is a
  ~5-line change (add featureId + backend row).
- **Vendor seeding from the SSO identity:** `AuthUser` gains `providerIds`
  (Firebase `providerData`); microsoft.com → Microsoft 365, google.com →
  Google. Microsoft preferred when both exist (the rarer, more intentional
  signal).
- **One connect path:** consents launch through the SAME
  `connectionsClient.beginOAuth` the Access hub uses (returnTo =
  `/access?tab=connections`, where the new row lands). No second OAuth
  surface. A single successful consent-launch dismisses the prompt — one
  win, no nagging.
- **Dismissal persistence:** localStorage keyed by user uid (per-browser).
  Trade-off accepted for v1: a user sees the prompt once per browser, not
  once per account. Upgrade path if it annoys: move the flag to the per-user
  layer of an existing durable store (the menu-config user layer pattern,
  ADR 0139) — deliberately NOT a new store.

## Alternatives weighed

- **Full feature package + toggle + backend registration** — right shape for a
  bigger onboarding program (checklist, tour); overkill for one modal, and the
  audit's other onboarding items (template pre-flight P3, start-here row P6)
  already landed as surface-local changes.
- **Durable server-side dismissal now** — better cross-device behavior, but
  requires picking/adding a user-pref store; deferred with a named upgrade
  path rather than inventing a parallel store (the no-parallel-architecture
  rule).
- **Prompt regardless of provider configuration** — rejected: a wall of
  disabled Connect buttons as a user's first post-signup experience is worse
  than nothing (the audit's D6 promise-without-capability pattern).

## Phases

| Phase | Scope | Landed |
|---|---|---|
| 1 | `VendorSetupPrompt` + `pickVendorGroups`/`seedVendor` (unit-tested) + `AuthUser.providerIds` + chrome i18n ×4 | feat/day1-ux-program (this commit) |
| 2 (open) | Durable per-user dismissal via an existing user-layer store | — |
| 3 (open) | Post-consent follow-through: land back in the wizard to offer the vendor's next surface (drive after email-calendar) | — |

## RFC gate

None — host-internal presentation over already-accepted surfaces (RFC 0095
connection packs, ADR 0024 OAuth broker, ADR 0185 vendor grouping). No wire
change, no capability advert.
