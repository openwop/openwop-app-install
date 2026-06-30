# ADR 0143 — Localized error envelopes (`Accept-Language` → translated `message` + `Content-Language`)

**Status:** **implemented** (2026-06-25) — architect-reviewed (Track A + B; 0 blocking issues,
classified Additive). See §"Implementation record".
**Date:** 2026-06-25
**Scope:** the host error-envelope path (`backend/typescript/src/middleware/errorEnvelope.ts`) and a
new core-shared error-message catalog under `host/i18n/`. Adds locale-awareness to the *one* surface
that still ships English-only regardless of `Accept-Language`.
**Composes:** ADR 0064 (CMS content localization — the `host/i18n/` locale infra this rides on),
ADR 0065 (frontend i18n). Host-internal: rides the **already-accepted** `spec/v1/i18n.md` annex +
RFC 0103; **no new wire field, no new RFC** (`Content-Language` and the `ErrorEnvelope` shape are
both already normative).

## Context

The closed-unmerged PR #409 (`host/rfc-0103-localized-content`, an early flat-layout prototype of
RFC 0103) was superseded by the feature-package CMS implementation that actually landed (ADR 0064 /
PR #428). When that branch was reviewed before deletion, **one capability in it was never ported**
to the shipped implementation:

- **Localized error envelopes** — a code→locale→message catalog wired into the error formatter,
  setting `Content-Language` only when a translation was actually applied.
- The **global locale-negotiation** that fed it (`req.negotiatedLocale` on every protected route).

Today on `main`:

- `host/i18n/locale.ts` already has the negotiation core — `negotiateLocale(acceptLanguage,
  supported, default)` (3-arg), `hostDefaultLocale()`, `hostSupportedLocales()`, `hostI18nEnabled()`,
  `LOCALE_RE`. It parses `Accept-Language` per the annex (q-values, exact-tag → language-family →
  default, never throws on a malformed header).
- But that core is consumed **only inside `features/cms/cmsService.ts`** for content delivery.
- **`middleware/errorEnvelope.ts` does no localization at all.** Every error `message` ships in
  English regardless of `Accept-Language`, and no `Content-Language` header / `details.locale` is set.
- `routes/discovery.ts` **already advertises `i18n.supported: true`** (discovery.ts:548, gated on
  `hostI18nEnabled()`). The annex (`i18n.md` §"Capability advertisement", line 148) defines that flag
  as *"when `true`, host honors `Accept-Language` on **every protected route**."* Error envelopes are
  on every protected route, yet today only the CMS read is localized — so **the existing
  advertisement already slightly over-claims** under the annex's literal wording. This feature does
  not add a new capability; it brings the already-advertised one into honest compliance.

This is a real, narrow gap, and it aligns with the project's pt-BR locale focus (the prototype's
catalog was pt-BR). The error path is the most user-visible English-only surface left.

## Why not just revive the branch

The branch is **886 commits stale** and predates the feature-package layout (it carried a parallel
flat `src/cms` + `src/i18n` tree and a now-obsolete `CMS-I18N-PLAN.md`). ~90% of its diff is the
superseded CMS prototype. It cannot be cherry-picked cleanly. This ADR captures the one salvageable
idea as fresh host work against the **current** `host/i18n/` infra.

## Decision

Add localized error envelopes as a thin layer over the existing `host/i18n/` negotiation core. Two
small, additive pieces:

### 1. `host/i18n/errorMessages.ts` — the catalog (new)

A `code → locale → message` map plus `localizeErrorEnvelope(envelope, locale)`:

```ts
// Typed to the closed OpenwopErrorCode union so a typo'd/renamed code is a
// COMPILE error (key-safety), while coverage stays intentionally partial:
const ERROR_MESSAGES: Partial<Record<OpenwopErrorCode, Record<string, string>>> = { ... };

// returns { envelope, localized }: localized=false when locale is the default
// OR the code has no catalog entry (so the caller omits Content-Language).
// When localized, the returned envelope also carries details.locale (the annex
// marker), consistent with the Content-Language the caller sets.
export function localizeErrorEnvelope(
  envelope: ErrorEnvelope,
  locale: string,
): { envelope: ErrorEnvelope; localized: boolean };
```

- Keyed by the **stable `error` code** drawn from the real `OpenwopErrorCode` union
  (`types.ts:444`) — `unauthenticated`, `forbidden`, `forbidden_tenant`, `forbidden_scope`,
  `not_found`, `run_not_found`, `workflow_not_found`, `validation_error`, `invalid_request`,
  `rate_limited`, `conflict`, `internal_error`, … — never by free-text message. (There is **no**
  `unauthorized` or `timeout` code; do not invent them.)
- Seed with **pt-BR** only (the validated locale). A code with no entry for the negotiated locale →
  no translation → English message retained → **no `Content-Language`, no `details.locale`**.
  Capability honesty: both markers MUST reflect what was *used*, never what was merely *requested*.
- Localizes the human `message` only, and stamps **`details.locale`** — the annex's normative marker
  for a localized error message (`i18n.md` §"`locale` field on `ErrorEnvelope.details`"), kept
  consistent with `Content-Language`. The machine-readable `error` code and HTTP status are
  **unchanged** — clients keying on `error` are unaffected (the annex requires the code stay
  English/lowercase/underscored regardless of locale).
- **Security invariant:** catalog entries are **static, parameter-free constants** — they never
  interpolate `message`/`details`. Localization happens **after** the credential-scrub
  (`sanitizeForErrorMessage`/`sanitizeDetails`) in `errorEnvelopeMiddleware`, so it cannot re-open
  the leak channel. If a future localized string ever needs interpolation, it MUST interpolate only
  the already-scrubbed values.

### 2. Locale negotiation reaching the error path

The prototype attached `req.negotiatedLocale` via a global middleware. Two options — **B preferred**:

- **(A) Global middleware** `localeNegotiationMiddleware()` sets `req.negotiatedLocale` for every
  route (mirrors the prototype; makes locale available to *any* future surface).
- **(B, preferred) Negotiate inside the error formatter.** `errorEnvelopeMiddleware` already has
  `req`; call `negotiateLocale(req.header('accept-language'), hostSupportedLocales(),
  hostDefaultLocale())` at format time. No new request-augmentation, no app-wide middleware, no
  `declare module 'express-serve-static-core'`. Scope stays exactly at the surface that needs it.

  Choose (A) only if a second non-CMS surface needs `req.negotiatedLocale` concurrently; otherwise
  (B) is less surface area. **Gate on `hostI18nEnabled()`** either way — a host with no configured
  locales does nothing and advertises nothing. Note (A) cannot be lifted verbatim from PR #409: the
  prototype's middleware called a **1-arg** `negotiateLocale(header)`, but main's helper is **3-arg**
  `negotiateLocale(acceptLanguage, hostSupportedLocales(), hostDefaultLocale())` — reviving it needs
  a rewrite regardless, which further favors (B).

### 3. Discovery advertisement — nothing new to advertise (it closes an existing gap)

There is **no granular error-localization flag** in the annex; the only knob is `i18n.supported`,
which main **already advertises** and which already means "honors `Accept-Language` on every
protected route." So this feature adds **no** new advertisement — it brings the *existing*
`i18n.supported: true` claim into honest compliance (today, error routes don't honor it). The
honesty risk runs the **opposite** direction the prototype assumed: it is the *current* state, not
the post-feature state, that slightly over-claims. No `routes/discovery.ts` change is required;
record in this ADR that the feature exists to make the standing claim true.

## Wire / spec position

No new RFC. Rides the **Stable** `i18n.md` annex (v1.1, 2026-05-12) + RFC 0103 — both accepted. The
change is **additive** per the annex's own §"Migration" (fully additive; clients that don't send
`Accept-Language` see no change): it adds an optional `Content-Language` response header and an
optional `details.locale` field to error envelopes. No required→optional change, no type/event/
endpoint-contract change, no relaxed MUST, no error-code-meaning change. This is a **conformant
host** localizing an existing response — host work riding an already-accepted annex, exactly like
ADR 0064's content delivery.

### Replay / fork — clean, by construction

`Content-Language` and `details.locale` are **request-scoped response projections**, negotiated at
format time from the inbound `Accept-Language`. Nothing is stamped on the run or written to the event
log (annex §"Replay & determinism": `Content-Language` is request-scoped, not part of the event
log; a fork localizes per the fork-request header). Option (B) — negotiate inside the formatter —
keeps this trivially true: replay re-projects, fork localizes independently, no new non-determinism
enters the payload. Track-B replay/fork: **no risk**.

## Open questions

- **(B) vs (A)** for negotiation placement — default to (B) unless a concurrent consumer appears.
- **Locale scope** — pt-BR only at first (matches the validated catalog + the project's NS-1
  reviewer). Adding a locale = adding a column to the catalog; no structural change.
- **Coverage** — translate only the stable, user-facing codes above. Internal/never-surfaced codes
  stay English; the no-entry → no-`Content-Language`/`details.locale` rule keeps that honest.
- **Conformance round-trip** — `conformance/src/scenarios/i18n-negotiation.test.ts` is capability-
  gated on `i18n.supported` (which main already advertises). **Verify before implementing:** which
  endpoint the scenario exercises, and whether main passes it *today* with CMS-only localization. If
  the scenario targets a generic/error route, this feature may be needed to *pass* it (a stronger
  motivation than "nice to have"); either way error localization MUST NOT regress it.
- **Tests** — `test/i18n-error-envelope.test.ts`: (1) pt-BR `Accept-Language` → translated `message`
  + `Content-Language: pt-BR` + `details.locale: pt-BR`; (2) default/unknown locale → English +
  **no** `Content-Language`/`details.locale`; (3) code with no catalog entry → English + no markers;
  (4) credential-scrub still runs before localization (a credential-shaped substring in `message`
  stays scrubbed in the localized output); (5) malformed `Accept-Language` → default, never 400.

## Provenance

Distilled from PR #409 (`host/rfc-0103-localized-content`, closed unmerged, branch deleted
2026-06-25). The CMS-content portion of that branch is fully superseded by ADR 0064; this note
preserves only the un-ported error-localization idea, re-expressed against the current `host/i18n/`
infra.

## Implementation record

| Phase | What landed | Files | Tests | Commit |
|---|---|---|---|---|
| 1 — catalog + projector | `localizeErrorEnvelope` + pt-BR `code→locale→message` catalog (typed to the `OpenwopErrorCode` union; static parameter-free constants; stamps `details.locale`), barrel-exported | `host/i18n/errorMessages.ts`, `host/i18n/index.ts` | `test/i18n-error-messages.test.ts` (6) | `03b5e0bc` |
| 2 — middleware wiring | Option **(B)** — negotiate inside `errorEnvelopeMiddleware` at format time (no app-wide middleware); localize after the credential-scrub; set `Content-Language` + `details.locale` only when actually localized; gated on `hostI18nEnabled()` | `middleware/errorEnvelope.ts` | `test/i18n-error-envelope.test.ts` (6: exact / family / default / unsupported / malformed / q-weighted) | `699d71fa` |

**Decisions as built:**
- Chose **(B)** over the global `req.negotiatedLocale` middleware — only the error path needs it
  today; less surface area; avoids re-augmenting `Request`. (A) was also non-portable from PR #409
  anyway: the prototype called a 1-arg `negotiateLocale`, but main's is 3-arg.
- `localizeErrorEnvelope` is **pure** (reads no env): the host default locale simply has no catalog
  entries, so it's never "localized" — no special-casing needed.
- **No `routes/discovery.ts` change** (HIGH-2 as designed): the feature closes a gap in the
  *already-advertised* `i18n.supported` claim; there is no new flag to advertise.

**Verification:** `tsc --noEmit` clean; the 12 new tests pass; full backend `vitest` shows only the
2 **pre-existing** `example-data-seeder-registry` failures (confirmed identical on pristine
`origin/main` — they need `~/.openwop-packs`, unrelated to this change). No banned suppression
patterns. Backend-only — no frontend surface, so the canonical FE build gate and `/ux-review` screens
are N/A; the pt-BR copy was reviewed as pt-BR-native.

**Follow-up (non-blocking):** confirm the host still passes the capability-gated conformance scenario
`conformance/src/scenarios/i18n-negotiation.test.ts` on the next conformance round-trip — the new
route tests mirror its assertions (negotiated → localized + `Content-Language`; unsupported/malformed
→ default), so no regression is expected.
