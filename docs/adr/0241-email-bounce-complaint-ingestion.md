# ADR 0241 — Email bounce/complaint webhook ingestion

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| **Status** | implemented (2026-07-04) — the ADR 0218 §Deferred bounce/complaint follow-on |
| **Deciders** | openwop-app maintainers |
| **Relates** | ADR 0218 (email engagement, §Deferred), ADR 0217 (suppression list), ADR 0024 §6 (connections inbound-webhook seam — security posture only), ADR 0143 (error envelopes) |

## Context

ADR 0218 shipped plain-text campaign email with click + unsubscribe tracking and
**deferred** bounce/complaint ingestion, noting it "requires per-provider
event-webhook signature verification (SendGrid/Postmark/SES all differ) …
extends the connections inbound-webhook seam; suppression reasons `bounced`/
`complaint` are already modeled (ADR 0217) so ingestion is purely additive."

Today a hard bounce or spam complaint is invisible to the host — the address
stays on the list and keeps getting mailed, eroding sender reputation. The
suppression reasons `bounced`/`complaint` already exist (ADR 0217); what's
missing is a signature-verified path from the provider's event webhook to
`addSuppression`.

## Decision

A **dedicated, signature-gated public receive endpoint** in the email feature —
NOT a re-use of the workflow-firing inbound-webhook seam.

- **Endpoint:** `POST /v1/host/openwop-app/public-email/events/:webhookId` —
  unauthenticated + toggle-independent (a provider keeps POSTing regardless),
  allowlisted like the existing `/c`,`/u`,`/p` public-email routes. `:webhookId`
  is an **opaque minted id** that resolves to the stored config → tenant +
  provider + verification secret. No tenant/provider in the URL (no enumeration).
- **Config:** a new `email:webhook-config` `DurableCollection` keyed by
  `webhookId` storing `{webhookId, tenantId, orgId, provider, enabled}`; the
  provider's verification key/secret is stored **KMS-enveloped via
  `byok/secretResolver`** under `email-webhook:<webhookId>` (NOT on the send
  Connection — the webhook verification key is a different credential with a
  different lifecycle than the send API key). Config set/remove routes are
  org-scoped (`workspace:write`, the email feature's existing gate).
- **Verification (the credential IS the signature):** per-provider dispatch.
  **SendGrid** — ECDSA (secp256r1) over `timestamp + rawBody`, the operator's
  base64 public key, `X-Twilio-Email-Event-Webhook-Signature` /
  `-Timestamp` headers, replay-window rejection. **Postmark** — HTTP Basic
  against the stored `user:pass` secret (constant-time). Signature is verified
  **before any parsing** (bad/absent → 401, no work).
- **Outcome:** parse the event batch; **only hard bounces + complaints** suppress
  (SendGrid `bounce`(hard) / `spamreport`; Postmark `HardBounce` / `SpamComplaint`)
  → `addSuppression(tenantId, email, 'bounced'|'complaint', 'webhook:<provider>',
  note)`. Soft/deferred/transient events are ignored (suppressing a transient
  failure would wrongly kill deliverability). Suppression is an idempotent upsert,
  so a replayed signed batch re-suppresses harmlessly — **no dedup store needed**.
- **Abuse posture:** signature-gate before work; **cap the batch** (reject > 1000
  events); the existing per-IP rate limit applies. Only the provider holding the
  tenant's verification key can suppress that tenant's addresses.

## Alternatives considered

- **(B) Extend the connections inbound-webhook seam** — REJECTED. That seam fires
  a *workflow run* per event and is hard-gated to Slack/Discord/Telegram
  (`inboundSupported`). A bounce is a *suppression* sink, not a run; overloading a
  workflow-firing, provider-gated seam with a non-workflow outcome is a boundary
  violation. We reuse its *security posture* (public endpoint, signature-is-the-
  credential, host-side KMS secret, tenant-from-config) — which lives in core
  `byok/secretResolver` — not its dispatch path.
- **(C) Fire a workflow per bounce that suppresses** — REJECTED. Indirect and
  heavy: a run per bounce email at provider batch scale, for a one-line side
  effect.

## Scope

- Providers: **sendgrid + postmark** end-to-end (both are supported send
  providers; shipping only one leaves the other's users with a silently
  non-functional feature). **SES excluded** (not a supported send provider).
- No wire/RFC: host-ext receive endpoint under `/v1/host/openwop-app/*`,
  non-normative, no capability advertisement (a receive sink, not advertised
  behavior).

## Open items (deferred)

- **Soft-bounce escalation** (suppress after N consecutive soft bounces) —
  requires per-address soft-bounce counting; deferred (hard bounces + complaints
  are the high-value, unambiguous signals). **DONE — ADR 0249** (CAS-counted
  consecutive streak, reset by any success signal, threshold
  `OPENWOP_EMAIL_SOFT_BOUNCE_THRESHOLD` default 5).
- **Bounce/complaint analytics** (a dashboard of suppression causes) — **DONE —
  ADR 0251** (a `suppressionSummary` read projection grouped by reason + source,
  surfaced via `GET /crm/suppressions/summary` + a chat-drivable CRM node — no
  bespoke dashboard, per the anti-parallel-surface rule). Original note: the
  suppression list already records the reason + note; a read projection is a
  future UX follow-on.
