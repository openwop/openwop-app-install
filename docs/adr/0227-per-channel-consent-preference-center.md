# ADR 0227 — Per-channel consent + public preference center

| Field | Value |
|---|---|
| **Status** | implemented (2026-07-03) |
| **Date** | 2026-07-03 |
| **Feature(s)** | `consent` (`marketing.email|sms|push` specifics + resolution in `isAllowed`), `email` (`sendCampaign` → `marketing.email`; `preferences` tokens; the public `/public-email/p/:token` page), `campaign-journeys` (`checkEligibility` channel param), `campaign-connectors` (audience upload stays umbrella — documented) |
| **Plan** | `docs/research/campaign-gap-analysis.md` §5D **D2** (E2 enterprise floor: per-channel consent + a preference center; C4's unsubscribe writes flow here) |
| **Depends on** | ADR 0020 (the ONE consent store + `isAllowed`), ADR 0218 (engagement tokens + the public-email prefix), ADR 0217 (`crm:suppression` overlay), ADR 0222 (journey eligibility composite) |
| **RFC gate** | **None** — host-ext vocabulary + one public host-ext page. |

> **Numbering note:** authored as 0225; renumbered to **0227** — the commerce
> Phase C session claimed 0224/0225 on `main` (PR #1212) while this branch was
> in flight (the README first-created-is-canonical rule).

## Context

Consent was a single `marketing` boolean: opting out of email meant opting out of every
future channel, and the only self-service surface was the C4 unsubscribe (all-or-nothing).
The E2 enterprise floor expects channel-granular consent and a recipient-facing
preference page.

## Decision

### 1. Vocabulary: specifics layered over the umbrella

`ConsentCategory` gains `marketing.email`, `marketing.sms`, `marketing.push` as
**optional specifics over the `marketing` umbrella**. The stored `ConsentCategories`
shape stays backward-compatible: the three base keys remain mandatory; the specifics are
optional and stored by `recordConsent` **only when the caller sent an explicit boolean**
— an absent specific *means* "the umbrella governs", so absence is never defaulted in.

`isAllowed(tenantId, subject, 'marketing.<channel>')` resolves on the record as:

1. the **specific key**, when the record carries one (it governs, both directions);
2. else the **`marketing` umbrella**;
3. else (no record) the existing policy-default path (opt-out allows; opt-in/unset
   fail-closed) — unchanged.

**MIGRATION NOTE:** stored records are untouched. A pre-0227 record has no specifics, so
the umbrella keeps governing it — byte-identical behavior until a subject (or the
preference center) records a specific. No backfill, no re-write, no version stamp.

### 2. Consumers

- `emailService.sendCampaign` consent-gates on **`marketing.email`** (a campaign send IS
  an email-channel send).
- `campaign-journeys/journeyService.checkEligibility(tenantId, contactId, channel = 'email')`
  checks `marketing.<channel>`; the surface verb passes an optional `channel` arg through
  (unrecognized values fall back to `email`). The no-email and suppression gates stay
  channel-independent for now (email is the contact handle every shipped send step
  targets; suppression is address-keyed).
- `campaign-connectors/audienceService.buildAudienceUpload` **deliberately keeps the
  `marketing` umbrella**: an ad-audience upload is not a channel send — the contact's
  identity (hashed) is shared for targeting across ad surfaces, so the broadest marketing
  grant must hold; a narrower per-channel opt-in (say, email-only) must NOT leak the
  address hash to ad platforms. Recorded in a code comment at the check.

### 3. Public preference center (server-rendered, not the SPA)

The C4 token generalizes: `engagementService.mintToken` gains kind `'preferences'`, and
`instrumentBody`'s footer becomes two lines — `Unsubscribe: …/u/<token>` and
`Preferences: …/p/<token>` (separate mint try-blocks: a preferences mint failure never
costs the unsubscribe line). New public routes under the EXISTING allowlisted
`/public-email` prefix (same posture as `/c` + `/u`: opaque token, no PII in URL or page,
toggle-independent — a recipient must always be able to narrow consent):

- `GET /public-email/p/:token` — a minimal **self-contained HTML** form (inline styles,
  zero external assets — it opens from any mail client): three checkboxes (email/sms/push)
  prefilled **specific ?? umbrella** (exactly the `isAllowed` record rule). Unknown token
  → plain-text 404. All interpolated values HTML-escaped.
- `POST /public-email/p/:token` (urlencoded, route-level parser) — writes through
  `consentService.recordConsent` (never a store write): the three specifics + the derived
  umbrella (`true` when any channel is on, `false` when all are off). All-off ALSO adds a
  `crm:suppression` row (`unsubscribed`) for the token's email, mirroring
  `recordUnsubscribe` — and, like there, suppression removal stays an operator act (a
  later re-opt-in via consent alone does not un-suppress; the ADR 0217 honesty rule).
  The subject's `analytics` choice is preserved, not reset (this page governs marketing
  only). Idempotent (latest-wins record; suppression upsert).

## Alternatives rejected

- **A parallel per-channel consent store** — the Sharing-registry lesson; one store, one
  `isAllowed`, the specifics ride the existing record.
- **Channel categories as first-class independent categories** (`email-marketing`, …)
  with no umbrella — breaks every existing record and caller; the layered fallback keeps
  old records valid forever.
- **A SPA preference page** — the recipient is not a user of the app; a server-rendered
  self-contained page has no auth, no bundle, and works in captive mail-client webviews.
- **Umbrella auto-derived as OR-of-specifics on read** — hidden write coupling; deriving
  it once at the preference-center write keeps `recordConsent` a dumb sanitizer.

## Verification

`consent-channels.test.ts`: the resolution matrix (no record / umbrella-only / specific
off + umbrella on / specific on + umbrella off / opt-out policy); `recordConsent`
sanitize (non-boolean specifics dropped, absence preserved); `sendCampaign` skips on
`marketing.email:false` while umbrella true (and still sends umbrella-only); journeys
channel param; preference center GET prefill (both bases) + POST write-through + all-off
suppression + idempotency + unknown/wrong-kind token 404.
`email-engagement.test.ts`: the Preferences footer line rides beside Unsubscribe.
