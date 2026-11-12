# OPENWOP-WHATSAPP — the official BSP channel (operator guide)

ADR 0394. WhatsApp business messaging through the **official** channel only —
Twilio BSP or the Meta Cloud API direct. Unofficial bridges (web automation,
reverse-engineered relays, iMessage-style device tricks) are permanent
non-goals: they violate Meta's terms and get numbers banned. (The demo
`messaging` relay gateway is a separate self-hosted device lane and gains no
WhatsApp coupling.)

> **CORRECTED 2026-11-03 (ADR 1041 D2):** this guide still covers business WhatsApp,
> and that stays official-only. "Permanent non-goal" no longer holds for a user's
> own personal account: the user approved an opt-in device lane that links the
> user's own WhatsApp through Baileys in openwop-cli, on the user's machine, with
> the ban risk shown at setup (ADR 1043). It never runs on an operator's number or
> on the business channel this guide configures.

## Compliance model (read this first)

Meta does **not** pre-approve your business or use case. Compliance is
contractual, enforced **after the fact** through a graduated ladder:

> quality rating drops → messaging-limit tier throttled → warning →
> temporary block → **permanent removal**.

The health endpoint (`GET …/whatsapp/orgs/:orgId/health?connectionId=…`)
surfaces your sender's quality rating and tier and raises a
`openwop-app.whatsapp.health-degraded` event when they slip.

Meta's Business Solution Terms (effective 2026-01-15) additionally:
1. bar general-purpose AI assistants as WhatsApp's **primary functionality** —
   the shipped `feature.whatsapp.agents` persona is deliberately scoped to
   defined customer-service functions (knowledge lookup + human handoff) and
   nothing else;
2. prohibit LLM providers from **training on WhatsApp message data** — see the
   attestation below;
3. allow purpose-specific customer-service bots.

## Setup

1. Turn ON the `whatsapp` toggle (OFF by default — enabling means accepting
   Meta's Business Solution Terms).
2. Connect a transport under Connections:
   - **Twilio BSP** (recommended first): the `twilio` connection
     (`AccountSid:AuthToken`). Configure inbound with provider
     `whatsapp-twilio`; the signing secret is your Twilio auth token. Point
     the Twilio WhatsApp webhook at
     `…/connections-inbound/<connectionId>#rp=5xx,ct&rc=3`. The fragment is a
     Twilio connection override meant to make Twilio retry a 5xx (by default
     it retries connect timeouts only, so a STOP this app could not record,
     answered 5xx, would not be redelivered). **Unverified: check it against
     Twilio's connection-override docs or a test webhook before relying on it**,
     in particular that the fragment does not break signature verification
     (live check `WA85LIVE-1`).
   - **Meta Cloud API direct** (margin path): the `whatsapp-cloud` connection
     (a WABA system-user token). Configure inbound with provider
     `whatsapp-cloud`; the signing secret is your Meta **app secret** (it is
     also the `hub.verify_token` for the GET subscription handshake).
3. Bind the sender: pair the connection with your WhatsApp sender — the E.164
   number (Twilio) or the phone-number id (Cloud). Use a **workspace** or
   **org** connection for a shared number (ADR 1053): a send uses exactly the
   bound connection's credential, and a personal connection sends only for its
   owner. Automated replies from inbound-triggered workflows (no person on the
   run) can use only a workspace connection.
4. **Delivery status (Twilio).** With inbound configured on the connection and
   `OPENWOP_OAUTH_CALLBACK_BASE_URL` or `OPENWOP_PUBLIC_BASE_URL` set, each send
   asks Twilio to post status callbacks to the same ingest URL. Without them a
   send stays `accepted` (the truth: nothing more is known). Meta Cloud posts
   statuses to the app webhook on its own.
5. **Record the no-training attestation** (admin):
   `PUT …/whatsapp/orgs/:orgId/attestation {"confirmNoTraining": true}`.
   Until it is recorded, verified inbound messages are acked but **never fire
   AI workflows** (fail-closed). Managed keys: the platform configures
   no-train/zero-retention on its managed provider accounts (Anthropic
   zero-retention; OpenAI ZDR; Google no-train-by-default). BYOK: confirm your
   own provider account has training disabled before attesting.

## Sending rules (enforced in the service, not on trust)

- **Explicit opt-in per number.** `marketing.whatsapp` consent must be an
  explicit `true` for the recipient — the broad `marketing` grant, an
  `opt-out` default policy, and the consent-toggle-off escape are all
  insufficient. Capture opt-in at collection time; the source is recorded for
  Meta's audit trail.
- **STOP is immediate.** Inbound STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT
  revokes the WhatsApp consent fail-closed, from any connection; a STOP whose
  write fails is answered 5xx so the provider redelivers it. START/UNSTOP/YES
  re-opts-in only through a **workspace or org** connection, whose inbound only
  an admin can configure (ADR 1053 D4a). Each inbound message id is processed
  once: a replayed or redelivered message does nothing.
- **The 24-hour window.** A free-form (session) message may only be sent
  within 24h of the recipient's last inbound message. Outside the window only
  a **pre-approved template** may be sent (Twilio ContentSid, or the Meta
  template name + language).
- **Sends are idempotent across retries and run forks** — an identical send
  (same tenant/connection/recipient/content, same UTC day) returns the recorded
  result and is never paid twice. The key is claimed before the provider call:
  a concurrent duplicate fails `send_in_flight`, and an attempt whose outcome is
  unknown (a timeout, a 5xx) is not re-sent that day (`send_outcome_unknown`).
- **"Sent" means accepted.** A send reports `accepted`; delivery (`sent`,
  `delivered`, `read`, `failed`, `undelivered`) arrives later from the provider
  and is read with the `delivery-status` node. A failure raises
  `host.whatsapp.delivery.failed`.
- **No SMS bypass:** the SMS adapter rejects `whatsapp:` recipients.

## Costs

WhatsApp bills per conversation (Meta) plus a per-message markup on Twilio
BSP; the Cloud API direct removes the markup at the cost of doing WABA
onboarding, template submission, and number provisioning yourself.
