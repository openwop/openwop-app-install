# ADR 0218 — Email Marketing: engagement tracking (clicks + unsubscribe)

| Field | Value |
|---|---|
| **Status** | implemented (2026-07-03) — opens + bounce/complaint ingestion recorded as explicit deferrals (§Deferred) |
| **Date** | 2026-07-03 |
| **Feature(s)** | `email` (`engagementService`, send-path instrumentation, public + authed routes), `middleware/auth.ts` (public prefix), composes `consent` (ADR 0020) + `crm:suppression` (ADR 0217) |
| **Plan** | `docs/research/campaign-gap-analysis.md` §5C **C4** (E3/E7: email stats are delivery-only; no behavioral signal for journeys or attribution) |
| **RFC gate** | **None** — host-ext public routes. |

## Context

Email campaign stats were `{sent, failed, skipped}` — no engagement signal for journey branching (C6) or owned-channel measurement (C5/E7). Campaign emails are **plain text** (`EmailTemplate.body`), which bounds what can honestly be tracked.

## Decision

1. **Click tracking:** at send time every URL in the rendered body is rewritten to `GET /v1/host/openwop-app/public-email/c/:token` — an opaque, single-purpose server-side token row (`email:engagement-token`); **no contact id or address ever rides a link**. The public route records a `clicked` engagement row and 302s to the original URL. Instrumentation requires an absolute browser-reachable base (`OPENWOP_EMAIL_LINK_BASE_URL` → `OPENWOP_OAUTH_CALLBACK_BASE_URL` → `OPENWOP_PUBLIC_BASE_URL`); absent ⇒ the send goes untracked — delivery beats tracking.
2. **Unsubscribe:** every instrumented send appends an unsubscribe line (`/public-email/u/:token`). Following it (idempotently) records `unsubscribed`, **revokes marketing consent** through `consentService.recordConsent` (the subject's choice), and adds a `crm:suppression` row (`unsubscribed` — the ADR 0217 overlay). Unsubscribe works even if the email toggle is later turned off (the public prefix is allowlisted unconditionally — CAN-SPAM/GDPR posture).
3. **Reads:** `GET /email/orgs/:orgId/campaigns/:id/engagement` → `{stats: {clicks, uniqueClicks, unsubscribes}, events}`. Engagement rows are the single store the C5 attribution join reads — no mirror copies.

## Deferred (explicit, with reasons)

- **Opens:** requires an HTML pixel surface; campaign emails are plain text. Deferred until an HTML template system exists — tracking a fake "open" via a text link would be dishonest. **RESOLVED by ADR 0242 (2026-07-04):** the plain-text body is auto-rendered to an HTML part (multipart/alternative) at send, carrying a 1×1 open pixel (`/public-email/o/:token`); opens are recorded but LABELED approximate (image-load dependent). No fake text-link open.
- **Bounce/complaint ingestion:** requires per-provider event-webhook signature verification (SendGrid/Postmark/SES all differ). Deferred to a follow-on that extends the connections inbound-webhook seam; suppression reasons `bounced`/`complaint` are already modeled (ADR 0217) so ingestion is purely additive. **RESOLVED by ADR 0241 (2026-07-04):** shipped as a dedicated signature-gated public endpoint (`/public-email/events/:webhookId`) for SendGrid (ECDSA) + Postmark (Basic) → hard bounces + complaints suppress. Correction note: it reuses the inbound seam's *security posture* (via core `byok`) but NOT its workflow-firing path — a suppression sink, not a run.

## Verification

`email-engagement.test.ts`: body instrumentation (URLs rewritten, unsubscribe appended, no PII in links), click redirect + row, unsubscribe cascade (consent revoked + suppression added + idempotent), stats rollup, unknown-token 404s.
