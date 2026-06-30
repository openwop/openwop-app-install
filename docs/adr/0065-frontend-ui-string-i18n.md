# ADR 0065 — Frontend UI-string internationalization (app chrome i18n)

**Status:** implemented (Phases 1–4; pt-BR native-reviewed + promoted to
`SUPPORTED_LOCALES` 2026-06-18) — only follow-up is exercising a real RTL locale before
advertising RTL (no RTL locale is shipped). Landed via #419 (this ADR) + #421 (all phases)
+ pt-BR promotion. See **Implementation record** below.
**Toggle:** **NONE — always-on core infra** (like the design system `ui/` and the
kanban board surface; see FEATURES.md "Surfaces intentionally NOT in the toggle
catalog"). UI-string rendering changes no backend behavior and has no per-org
semantics, so it is not toggle-worthy. A *second UI locale* becoming user-visible
is gated by the declared-locale contract (`SUPPORTED_LOCALES` + the switcher
self-hiding at one locale), not a feature toggle. Contrast ADR 0064, which
*correctly* toggles **content** localization (it changes CMS reads + advertises a
capability).
**Capability:** rides **Accepted RFC 0103** + its `i18n.md` annex. Adds **no new**
`/.well-known/openwop` advertisement — `capabilities.i18n` (content locales) is
owned by ADR 0064. App UI strings are a pure client concern and are not advertised.
**Depends on / composes:** **ADR 0064** (CMS content localization — owns the backend
`host/i18n/` `Accept-Language` negotiation; **must land first or together** — see
Dependency note), **ADR 0001** (feature-package boundary — and its carve-out:
cross-cutting infra is *core*, not a feature), **ADR 0027** (`PublicShell` front
page), `DESIGN.md` (the `ui/` cohesion layer + `LanguageSwitcher` placement).
**Surface:** a **new core/shared frontend module** `frontend/react/src/i18n/`
(framework + format layer + the `check-i18n` gate + `LanguageSwitcher`), **per-feature
string catalogs co-located in `src/features/<id>/i18n/`**, the cross-cutting `common` /
`nav` / `chrome` namespaces in core, and **one behavior-preserving edit** to
`frontend/react/src/client/config.ts` (route `Accept-Language` through the active-locale
store, defaulting to `navigator.language`). **No backend code, no new routes, no data
model, no storage.**
**RFC gate:** **NO new RFC.** Pure frontend + a behavior-preserving header tweak; the
`Accept-Language` semantics are already normative (RFC 0103 `i18n.md` annex, Accepted)
and the backend negotiation is already owned by ADR 0064.

---

## Why this exists

openwop-app's entire **application chrome** — nav, buttons, labels, placeholders,
empty/error states, toasts, table headers across ~37 frontend feature areas — is
**hardcoded English JSX**. There is **no frontend i18n** (no `react-i18next`, no string
catalogs, no `Intl`-based formatting layer): numbers/dates use locale-unaware
`.toFixed()` / `.toLocaleString()` (~27 / ~29 sites), plurals are English-only string
concatenation (`n === 1 ? '' : 's'`), and there is no RTL support.

ADR 0064 localizes **user-authored CMS content** (pages/sections) via a backend
`Accept-Language` negotiation. It explicitly does **not** touch the app's own UI chrome
and notes "no frontend `react-i18next`." So the app can serve a Brazilian visitor
Portuguese *content* while every button, menu, and form around it stays English. This
ADR closes that gap: it localizes the **app's own UI strings**, and it does so by
**reusing the locale the user is already expressing** — `client/config.ts` already sends
`accept-language: navigator.language` on every request, which ADR 0064's backend already
consumes. One user-chosen locale should drive **both** the UI chrome (this ADR) **and**
the `Accept-Language` that 0064 negotiates content against.

A prior exploration (closed PR #410, branch `feat/rfc-0103-localized-content`) built this
on the *pre-restructure* main. It is **not reusable as code** (built on a 392-commits-stale
base, missing committed modules). Its **conventions** (the `check-i18n` gate, the `Intl`
`format.ts` layer, the declared-locale contract, the pseudo-locale) and its
**native-reviewed pt-BR catalog** are reusable as **reference/seed** only.

## Context (boundaries audit first)

Per ARCHITECTURE.md's "audit before asserting new," and the `/architect` review of this
plan:

- **No namespace/route collision.** `frontend/react/src/i18n/` does not exist on this
  lineage. The backend `backend/typescript/src/host/i18n/` is in a **disjoint package**
  (ARCHITECTURE.md:273 — "no shared local package between them"), so the two literally
  cannot import or collide. The only coupling is the `Accept-Language` wire (already
  RFC 0103).
- **Not a feature-package — this is core/shared infra.** ARCHITECTURE.md's seam table has
  no row for cross-cutting frontend infra; i18n is core (like `src/ui/`, `src/client/`),
  exactly as ADR 0064 classified its backend i18n ("core-shared infra… not a feature;
  core must not import features"). The **framework** is core; the **strings** are owned
  per-feature (see D1).
- **Single source of truth, split correctly.** The FE owns the **UI display locale** (a
  client preference, like `ThemeToggle`) and *requests* content via `Accept-Language`. The
  **backend remains the authority** over content-locale *availability* (`capabilities.i18n`)
  and *negotiation* (`host/i18n/negotiateLocale`, which already does q-value/family/default
  matching). The FE must **not** re-implement `Accept-Language` parsing (it sends one tag)
  and must **not** dictate which content locale is served (the BE negotiates, may serve a
  fallback). ARCHITECTURE.md:33 — "the frontend can render the resolved view, but it cannot
  be the source of truth" for server-side decisions.
- **Reference, not port.** The closed-branch pt-BR catalog is keyed to *that branch's*
  English strings; this codebase's strings differ, so it is a **re-derivation** (seed +
  re-align), not a drop-in — the cross-locale parity gate is the acceptance bar.

## Decision

### D1 — i18n **framework** is core; **strings** are owned per-feature
The framework lives in a new **core** module `frontend/react/src/i18n/`:
- `index.ts` — `i18next` + `react-i18next` init, `fallbackLng: en`, `languageChanged` →
  formatter + `<html lang|dir>` sync, `setLocale()`.
- `format.ts` — the memoized `Intl` layer (number/currency/percent/date/time/relative-time/
  list/bytes/duration), bound to the active locale; `useFormat()` hook.
- `locales.ts` — the declared-locale contract (`SUPPORTED_LOCALES`, `PREVIEW_LOCALES`),
  `detectLocale`/`resolveLocale`/`directionFor`, persistence.
- `LanguageSwitcher.tsx`, `pseudo.ts` (QA), `i18next.d.ts` (type-safe `t()`).
- Cross-cutting namespaces only: `common`, `nav`, `chrome`.

**Each feature owns its catalog**, co-located in `src/features/<id>/i18n/` (e.g.
`en.ts` exporting a namespace const), and **registers its namespace** via the i18n core —
mirroring the `FRONTEND_FEATURES` registration pattern (ARCHITECTURE.md ADR 0001:
"a feature owns its service, routes, UI, tests"). A central catalog dir is **rejected**
(it would force every feature to edit a shared file — a self-containment violation; this
is the `/architect` lead finding). Adding/removing a feature stays self-contained,
catalog included.

### D2 — One active-locale source drives UI chrome **and** `Accept-Language`
The active locale (the `locales.ts` store; user choice in `localStorage` → else
`navigator.language` → else `en`) drives: (a) the UI-chrome translation (react-i18next),
and (b) the `Accept-Language` header set in `client/config.ts`. The `config.ts` change is
**behavior-preserving**: with no user choice it still sends `navigator.language`, so the
app is byte-identical to today until a second locale ships and a user selects it.

### D3 — The FE requests; the backend negotiates (authority boundary)
The FE sends `Accept-Language: <activeLocale>` (a single tag). ADR 0064's
`host/i18n/negotiateLocale` independently negotiates which **content** locale to serve and
**may serve a fallback** (e.g. UI in pt-BR while an org with no pt-BR content serves its
base locale). The mixed state (pt-BR chrome + base-locale content) is **acceptable and
expected**; the switcher offers **UI-supported** locales (`SUPPORTED_LOCALES`), not org
content locales. The FE never re-derives content availability.

### D4 — Declared-locale contract (honesty), not a toggle
`SUPPORTED_LOCALES` lists only locales whose UI catalog is **complete AND
native-reviewed**. Drafts land in `PREVIEW_LOCALES` first (loadable via the switcher in
dev / `?preview=1`, **not** auto-negotiated, **not** advertised), then promote to
`SUPPORTED_LOCALES` once reviewed — a one-line change. The `LanguageSwitcher` renders
nothing at a single declared locale (so English-only ships invisibly). A pseudo-locale
(`en-XA`, dev/QA) exercises coverage + text-expansion. This contract — not a feature
toggle — is the gate.

### D5 — Build-gated completeness (`check-i18n.mjs`)
A `frontend/react/scripts/check-i18n.mjs` gate, wired into `npm run build`, fails on:
(1) any `t()` reference with no catalog key, (2) any raw `toLocale*`/`toFixed`/`'$'+`
formatting outside `format.ts` (strict), and (3) **cross-locale key parity** — every
non-`en` catalog MUST match `en` exactly (a missing key would leak English via fallback).
The gate **scans `src/features/<id>/` catalogs + the core**, per D1.

### D6 — RTL is wired but dormant
`<html dir>` derives from the active locale; CSS uses logical properties
(`*-inline-*`, `text-align: start/end`); inline styles use `marginInlineStart` etc. No RTL
locale ships in this ADR, but the machinery makes adding one a catalog + one-line change.

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | **N/A — core/shared infra**, not a `src/features/<id>/` package. Framework in core `src/i18n/`; strings owned per-feature (D1). Not in `FRONTEND_FEATURES`. |
| 2 | **Toggle + admin UI** | **None — always-on** (D4). No backend behavior change, no per-org semantics; gated by the declared-locale contract, not a toggle. |
| 3 | **Workflow `ctx.<feature>`** | **N/A.** UI strings are not run-influencing. |
| 4 | **Node pack** | **N/A.** |
| 5 | **AI-chat envelopes** | **N/A.** |
| 6 | **Agent pack** | **N/A.** Locale catalogs are human-authored + native-reviewed, not AI-generated. |
| 7 | **Public surface** | **N/A — no new routes.** The public CMS front page already negotiates *content* via ADR 0064; this ADR adds no public surface. |
| 8 | **RBAC + isolation (ADR 0006)** | **N/A.** Client-side strings carry no authority; the one wire touch (`Accept-Language`) carries none. |
| 9 | **Replay / fork safety** | **N/A.** UI strings are client-only and never stamped on a run. `Accept-Language` is request-scoped and not logged (same as ADR 0064 §F / `i18n.md` replay determinism). |
| 10 | **Frontend** | Core `src/i18n/` + per-feature catalogs + `LanguageSwitcher` in the sidebar foot beside `ThemeToggle` (DESIGN.md §5 row added); `ui/` cohesion + a11y + tokens. |

## Phased plan

- **Phase 1 — i18n core framework.** `src/i18n/` (init + `format.ts` + `locales.ts` +
  `LanguageSwitcher` + `i18next.d.ts` + `pseudo.ts`) + `check-i18n.mjs` wired into the
  build; cross-cutting `common`/`nav`/`chrome` namespaces; route `client/config.ts`
  `Accept-Language` through the locale store (behavior-preserving). *Gate: build green;
  switcher live (en-only, self-hidden).*
- **Phase 2 — Per-feature string externalization.** Each `src/features/<id>/` externalizes
  its strings into a co-located catalog + registers its namespace. Parallelizable per
  feature; each wave gated by `check-i18n` parity. *Gate: 0 unresolved `t()` refs; tsc 0.*
- **Phase 3 — Formatting + plural debt.** ~27 `.toFixed` + ~29 `.toLocale*` → `format.ts`;
  naive plurals → CLDR `_one`/`_other`; flip the formatting-ban strict. *Gate: 0 raw
  formatting sites.*
- **Phase 4 — RTL + first non-English locale.** App-wide logical-CSS + `<html dir>`;
  **re-derive pt-BR** (seed from the closed-branch catalog, re-align to the new `en` keys)
  into `PREVIEW_LOCALES` → native review (the maintainer is a native pt-BR speaker) →
  promote to `SUPPORTED_LOCALES`. *Gate: cross-locale parity green; native sign-off.*
- **Phase 5 — Hardening.** DESIGN.md §5 `LanguageSwitcher` row; pseudo-locale + RTL human
  click-through; Playwright e2e locale-switch smoke. *Gate: full `frontend/react` build +
  e2e green.*

## Alternatives considered

1. **A `frontend-i18n` feature toggle (mirroring ADR 0064).** *Rejected.* UI-string
   rendering changes no backend behavior and advertises no capability — toggling "the app
   uses a string catalog" is meaningless, like toggling the design system. ADR 0064
   toggles *content* localization because it changes CMS reads + advertises
   `capabilities.i18n`; the asymmetry is intentional and correct.
2. **Central catalog dir (`src/i18n/locales/<ns>.ts`).** *Rejected* (the `/architect` lead
   finding) — on a feature-packaged frontend it forces every feature to edit a shared file,
   violating self-containment (ADR 0001). Strings co-locate per feature (D1).
3. **Revive the closed PR #410 branch.** *Rejected.* Abandoned, built on a 392-commit-stale
   base, missing committed modules. Reuse conventions + the pt-BR catalog as reference/seed
   only.
4. **Defer UI i18n; rely on ADR 0064 alone.** *Rejected.* 0064 localizes *content*, leaving
   the entire app chrome English-only — the exact gap this ADR exists to close.
5. **FE as content-locale authority.** *Rejected* (`/architect` #2) — the backend stays
   authority; the FE requests via `Accept-Language` and renders the negotiated result (D3).

## Open questions

1. **UI-locale ↔ content-locale mixed state.** Confirm that pt-BR chrome + base-locale
   content (when an org hasn't authored pt-BR) is acceptable UX (recommended: yes; the
   switcher labels itself "interface language"). Should the switcher ever surface a
   "content shown in …" hint when they differ? *Deferred.*
2. **Catalog co-location format.** `src/features/<id>/i18n/en.ts` exporting a namespace
   const, registered via the i18n core — confirm the exact registration shape against the
   `FRONTEND_FEATURES` pattern at implementation.
3. **pt-BR sequencing.** Ship **en first, pt-BR as a reviewed fast-follow** (recommended,
   decouples the large externalization from translation review) vs. en+pt-BR together.
4. **Non-feature-dir surfaces** (`src/chrome/`, `src/ui/`, top-level pages) own their
   strings in the core `chrome`/`common`/`ui` namespaces; developer/QA-only surfaces
   (devtools, the manual-test runner) stay intentionally un-localized — confirm the list at
   implementation.

## Dependency note

ADR 0065 **composes ADR 0064** (it reuses 0064's `host/i18n/` `Accept-Language`
negotiation as the content-side authority). 0064 is **Accepted but not yet on
`origin/main`** (in flight on `feat/cms-localization`). 0065 should land **after or with**
0064. 0065 adds **no** backend dependency of its own beyond the already-sent
`Accept-Language` header, so Phases 1–3 (UI framework + externalization, English-only) can
proceed independently; only the pt-BR content-negotiation *synergy* requires 0064 merged.

## Acceptance criteria

- [x] `src/i18n/` core framework + `check-i18n.mjs` gate wired into `npm run build`.
- [x] Per-feature catalogs co-located in `src/features/<id>/i18n/`; gate scans features + core.
- [x] `client/config.ts` `Accept-Language` routed through the locale store, defaulting to
      `navigator.language` (behavior-preserving — verified byte-identical at en).
- [x] 0 unresolved `t()` refs; 0 raw `toFixed`/`toLocale*`/`'$'+` formatting sites; tsc 0;
      `frontend/react` build green.
- [x] `<html dir>` driven from the active locale (`syncLocale` + `directionFor`); app-wide
      logical-CSS conversion is groundwork — verify under a real RTL locale before claiming RTL.
- [x] pt-BR re-derived, native-reviewed, promoted to `SUPPORTED_LOCALES`; cross-locale
      parity gate green. **(Promoted 2026-06-18 — `SUPPORTED_LOCALES = ['en', 'pt-BR']`;
      `PREVIEW_LOCALES` now empty. Switcher shows 2 locales; pt-BR auto-negotiated.)**
- [x] `LanguageSwitcher` DESIGN.md §5 row; a11y (labeled control, global focus ring).
- [x] Always-on / no-toggle decision recorded; FEATURES.md "not in toggle catalog" note added.

## Implementation record

Landed on `origin/main` 2026-06-18 via **#419** (this ADR + ROADMAP/FEATURES rows) and
**#421** (`feat/frontend-ui-i18n`, all phases). Final pre-merge gate (run locally — org
GitHub Actions billing was suspended, so CI ran no jobs): `tsc --noEmit` clean ·
`check-i18n` **4270 keys / 50 namespaces, all `t()` refs resolve, cross-locale parity green** ·
`npm run build` **EXIT 0** (entry chunk 152.2 kB gzip / 160 budget; all CSS-token, bundle,
built-CSS, CSP-hash gates green) · **273/273** vitest tests pass.

| Phase | Scope | State |
|---|---|---|
| 1 — Core framework | `src/i18n/` (init + `format.ts` + `locales.ts` + `LanguageSwitcher` + `pseudo.ts` + `i18next.d.ts`), `check-i18n.mjs` in the build, `common`/`nav`/`chrome` namespaces, `client/config.ts` `Accept-Language` via the locale store | ✅ Done |
| 2 — Per-feature externalization | Co-located catalogs in `src/features/<id>/i18n/` + core areas; 50 namespaces / 4270 keys; 0 unresolved `t()` | ✅ Done |
| 3 — Formatting + plural debt | `toFixed`/`toLocale*`/`'$'+` → `format.ts`; CLDR plurals; formatting-ban flipped strict | ✅ Done |
| 4 — RTL + first non-English locale | `<html dir>`/`directionFor` wired; **pt-BR native-reviewed + promoted to `SUPPORTED_LOCALES`** 2026-06-18 (parity-green; switcher live, auto-negotiated). Full RTL pass not yet exercised — no RTL locale shipped yet | ✅ Done (pt-BR); RTL deferred until an RTL locale is added |
| 5 — Hardening | `LanguageSwitcher` DESIGN.md §5 row; pseudo-locale (`en-XA`); switcher self-hides at one locale | ✅ Done (Playwright locale-switch e2e: deferred with the org CI billing block) |

**Remaining to fully close ADR 0065:** only (b) — exercise a real RTL locale before
advertising RTL. **(a) is done:** pt-BR (incl. the ~20 keys added during the #421↔main
merge — CMS-localization editor, `voiceModelUnsupportedShort`, `cmdkFootOpenStay`,
`download*Aria`, CRM per-row select labels) was native-reviewed and promoted to
`SUPPORTED_LOCALES` 2026-06-18.

## Correction note (merge-time integration, 2026-06-18)

ADR 0064 (CMS content localization) landed on `main` **before** #421, so the implementation
**integrated 0064's section-localization editor** (LocaleTabs / overlay / translate-from-base)
into the i18n'd `SectionsEditor` and localized its strings, rather than the two landing
independently as the Dependency note anticipated. The "0064 must land first or together"
expectation held — 0064 first — with the host UI reconciled at merge.
