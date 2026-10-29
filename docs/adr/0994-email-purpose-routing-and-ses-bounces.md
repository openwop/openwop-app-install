# ADR 0994 — Transactional email on Postmark, campaigns on Amazon SES

Status: Accepted (David, 2026-10-27: "Go with Postmark plus SES for campaigns"; "Each workspace connects its own")

## Context

SendGrid stopped being usable for MyndHyve (the account is stuck and support
would not help). After a provider comparison, David chose **Postmark for
transactional email and Amazon SES for campaigns**, with each workspace keeping
its own accounts (the existing Connection model), not a platform-wide account.

Measured on `origin/main` 2026-10-27:

- **Nothing chooses a provider by kind of email.** Every sender takes the first
  provider in `emailSendProviders()` (host default, then `sendgrid`, `postmark`,
  `smtp`) for which the caller has a Connection
  (`features/email/brokeredProvider.ts:54-64`, `:131-139`). `purpose`
  (`marketing` | `transactional`) only feeds the recipient egress guard
  (`host/recipientEgressGuard.ts`), never the provider choice.
- **Approval notifications are hard-wired to `smtp`**
  (`host/emailApprovalDelivery.ts:190`), so a workspace whose only email account
  is Postmark gets no approval email.
- **Every Postmark send rides the transactional stream**: `postmarkBody` sets
  `MessageStream: 'outbound'` unconditionally (`host/emailAdapter.ts:170`).
  Postmark requires bulk and promotional mail on a Broadcast stream and pauses
  servers that send it on the transactional one.
- **SES can already send**: ADR 0193's follow-up routes SES through the `smtp`
  provider at `email-smtp.<region>.amazonaws.com:587` with STARTTLS, and the
  ADR 0201 firewall admits port 587. What is missing is **bounce and complaint
  ingestion**: ADR 0241 shipped SendGrid and Postmark and excluded SES ("not a
  supported send provider"). Without it, campaigns sent through SES never
  suppress bounced or complaining addresses and never feed the ADR 0955 sender
  breaker, which is how an SES account ends up under review.
- The app sends **no sign-in email**: Firebase Auth sends verification and
  password-reset mail from the browser (`frontend/react/src/auth/firebase.ts`).

## Decision

### D1. Provider preference follows the email's purpose

`emailSendProviders(purpose?)` orders providers by a per-purpose host preference:

- `transactional`: `OPENWOP_EMAIL_TRANSACTIONAL_PROVIDER`;
- `marketing`: `OPENWOP_EMAIL_MARKETING_PROVIDER`;
- either unset, or no purpose: `OPENWOP_EMAIL_DEFAULT_PROVIDER`, then `sendgrid`
  (today's order, unchanged).

It is a **preference, not a pin**: callers still take the first provider in that
order for which a Connection resolves, so a workspace that connected only one
account keeps sending exactly as before. An unknown value is ignored.

Every sender passes its purpose:

| Sender | Purpose |
|---|---|
| Campaign send and test send (`features/email/routes.ts`) | marketing |
| Org invites, commerce confirmations (`brokeredProvider.ts`) | transactional |
| Approval notifications (`emailApprovalDelivery.ts`) | transactional; **no longer hard-wired to `smtp`**, it resolves the first workspace-scoped Connection in transactional order |
| Workflow `email-send` node with no `config.provider` (chain lane) | the node's declared purpose; the adapter now resolves the first **connected** provider in that order instead of blindly using the host default |

A node or caller that names `provider` explicitly keeps it.

### D2. Postmark campaign mail goes on the Broadcast stream

`postmarkBody` sets `MessageStream` from the send's purpose: `transactional` →
`outbound`; `marketing` → `OPENWOP_POSTMARK_BROADCAST_STREAM` (default
`broadcast`, the stream Postmark creates on every new server). The purpose used
is the one the adapter enforced (after the ADR 0895 chain demotion), so a
demoted chain send can never ride the transactional stream.

This changes existing deployments: an unlabelled send was always enforced as
marketing, so it now names the Broadcast stream too. A Postmark server without
that stream refuses it (ErrorCode 1235); the adapter reports
`email_stream_missing`, naming the stream and the env var, instead of passing
Postmark's text through. Transactional mail on the same server is unaffected.
DEPLOY.md carries the upgrade step.

### D3. SES sends through the existing `smtp` provider

No SigV4 adapter. A workspace adds an **SMTP** Connection with its SES SMTP
credentials (`host: email-smtp.<region>.amazonaws.com`, `port: 587`,
`secure: false` for STARTTLS). With `OPENWOP_EMAIL_MARKETING_PROVIDER=smtp`,
campaigns prefer it. Campaign sends already count toward the sender breaker
(`recordSends` in `sendCampaign`), whatever the provider.

### D4. SES bounces and complaints arrive as signed SNS notifications

`ses` joins `BounceProvider` on the ADR 0241 endpoint
(`POST /host/openwop-app/public-email/events/:webhookId`). The operator
subscribes the endpoint (HTTPS) to the SNS topic their SES identity or
configuration set publishes to, and stores the **topic ARN** as the webhook's
verification secret.

Verification, before any processing (the SNS signature is the credential):

1. The body is an SNS message (`Type`, `MessageId`, `TopicArn`, `Timestamp`,
   `Signature`, `SignatureVersion`, `SigningCertURL`). `TopicArn` must equal
   the stored ARN exactly.
2. `SigningCertURL` must be `https://sns.<region>.amazonaws.com/…pem` (the host
   pattern AWS documents). The certificate is fetched through
   `guardedEgressFetch` (SSRF-pinned, no redirects) and cached per URL.
3. The signature is checked over SNS's canonical string (`Message`,
   `MessageId`, `Subject` if present, `Timestamp`, `TopicArn`, `Type` for a
   notification; `SubscribeURL` and `Token` in place of `Subject` for a
   subscription message) with RSA-SHA1 (`SignatureVersion` 1) or RSA-SHA256
   (`2`).
4. `Timestamp` must be within one hour of now, generous against SNS's HTTP
   retry schedule and tight enough to bound a replay; older messages are refused
   as stale. A replay inside the window is harmless for hard signals (suppression
   is an idempotent upsert) and only over-counts a soft streak, the posture
   ADR 0249 already accepts for SendGrid and Postmark.

After verification:

- `SubscriptionConfirmation`: the host confirms by GETting `SubscribeURL`
  (host must match the same SNS pattern; fetched through `guardedEgressFetch`).
  This is the only state change a subscription message can cause, and only for
  the pinned topic.
- `UnsubscribeConfirmation`: acknowledged, no action.
- `Notification`: `Message` is parsed as the SES event (both the SES
  notification shape, `notificationType`, and the event-publishing shape,
  `eventType`):
  - `Bounce` with `bounceType: Permanent` → hard bounce, suppress each
    `bouncedRecipients[].emailAddress`;
  - `Bounce` with `Transient` or `Undetermined` → soft signal (ADR 0249 streak);
  - `Complaint` → complaint, suppress each `complainedRecipients[].emailAddress`;
  - `Delivery` → success signal (resets the soft streak).

  Each signal then follows the same path as SendGrid and Postmark: suppression,
  `recordBounceSignal` for the org's breaker, streak bookkeeping.

SNS posts with `Content-Type: text/plain`, so the endpoint's scoped body parser
accepts `text/plain` as JSON as well as `application/json`, still capturing the
raw body.

### D5. Docs

`FEATURES.md` (the email row named SES as a send provider), ADR 0241's scope line,
and `DEPLOY.md` get the operator steps: the env vars above, the two Connections,
and the two bounce webhooks.

> **CORRECTION 2026-10-28 (setup walk-through):** D1 assumed an operator could
> create a workspace-scope Connection from Access → Connections. The page offered
> only **Just me** and **Organization**, and `selectAuthorizedConnection` matches an
> org row only when the send names an org or has an acting user. Approval notices
> and unattended campaigns have neither, so they would have found no account. The
> page now offers **Whole workspace (automated sends)** to admins
> (`host:connections:manage`), which creates the `scope:'workspace'` row the
> server already accepted.

## Alternatives

- **A platform-wide account that sends for every workspace.** Rejected by David
  (2026-10-27): one agency's bad list would put the shared SES account under
  review for everyone.
- **A per-campaign provider pin.** More control, but a new field on the campaign
  model and UI for a choice that, for every workspace today, is the same per
  purpose. A host preference with first-connected fallback covers it; a
  per-workspace override is an open question below.
- **An SES HTTPS (SigV4) adapter.** Unneeded: SES's SMTP endpoint carries the
  same mail, and the adapter and firewall already handle SMTP.
- **Verifying SNS with a shared secret in the URL (Basic auth).** SNS supports
  Basic auth on HTTPS endpoints, but that is a static secret on a URL. The SNS
  signature plus a pinned topic is stronger and is what AWS recommends.

## Implementation plan

| Phase | What | Gate |
|---|---|---|
| P1 | D1 purpose-ordered `emailSendProviders`, every sender passes purpose, approval delivery and chain lane resolve by purpose; D2 Postmark stream by purpose | backend vitest |
| P2 | D4 SNS verification, subscription confirmation and SES event classification on the ADR 0241 endpoint; `text/plain` body parsing | backend vitest |
| P3 | D5 docs; operator setup for MyndHyve (Connections, env, SNS topic subscription) | David connects the accounts |

## Open questions

- [ ] A per-workspace override of the purpose preference (in the email
      settings), for a workspace that wants campaigns on Postmark Broadcast
      rather than SES. Not needed for MyndHyve.
- [ ] Booking and e-signature emails call a stub `activeProvider()` that never
      sends (`features/email/emailService.ts:364`). Separate from this ADR.
- [ ] Routing Firebase Auth's verification and reset emails through Postmark
      (Firebase custom SMTP). Separate; Firebase sends them today.
