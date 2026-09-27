# OPENWOP-WHATSAPP — the official BSP channel (operator guide)

ADR 0394. WhatsApp business messaging through the **official** channel only —
Twilio BSP or the Meta Cloud API direct. Unofficial bridges (web automation,
reverse-engineered relays, iMessage-style device tricks) are permanent
non-goals: they violate Meta's terms and get numbers banned. (The demo
`messaging` relay gateway is a separate self-hosted device lane and gains no
WhatsApp coupling.)

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
     `…/connections-inbound/<connectionId>`.
   - **Meta Cloud API direct** (margin path): the `whatsapp-cloud` connection
     (a WABA system-user token). Configure inbound with provider
     `whatsapp-cloud`; the signing secret is your Meta **app secret** (it is
     also the `hub.verify_token` for the GET subscription handshake).
3. Bind the sender: pair the connection with your WhatsApp sender — the E.164
   number (Twilio) or the phone-number id (Cloud).
4. **Record the no-training attestation** (admin):
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
  revokes the WhatsApp consent fail-closed; START/UNSTOP/YES re-opts-in.
- **The 24-hour window.** A free-form (session) message may only be sent
  within 24h of the recipient's last inbound message. Outside the window only
  a **pre-approved template** may be sent (Twilio ContentSid, or the Meta
  template name + language).
- **Sends are idempotent across retries and run forks** — an identical send
  (same tenant/connection/recipient/content) returns the recorded result and
  is never paid twice.
- **No SMS bypass:** the SMS adapter rejects `whatsapp:` recipients.

## Costs

WhatsApp bills per conversation (Meta) plus a per-message markup on Twilio
BSP; the Cloud API direct removes the markup at the cost of doing WABA
onboarding, template submission, and number provisioning yourself.
