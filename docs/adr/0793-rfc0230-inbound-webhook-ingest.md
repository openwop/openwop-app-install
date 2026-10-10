# ADR 0793 — RFC 0230 signed inbound-webhook ingest (credential-less, Standard Webhooks)

Status: implemented (flag default OFF)

Implements openwop RFC 0230 (Active, merged as openwop#1824, `f94fbdb1`) for this
host. It is the host half of the work that lets `openwop.floor.trigger-bridge-delivery`
be witnessed on production without test seams.

## Context

- **The floor has no production witness.** On production certification cuts
  (b29427fef, 2273db9c6), major 1's `openwop.floor.trigger-bridge-delivery` records
  `executed-fail`, "event-log seam is absent". The host implements the trigger bridge,
  but the suite could only drive a delivery through test seams, which production
  withholds. RFC 0230 pins a public, sender-facing ingest contract. This ADR serves it.
- **The existing ingest was not a sender contract.**
  `POST /v1/trigger-subscriptions/{id}/ingest` requires an OpenWOP credential
  (`runs:create`) and a wrapped body, verifies a legacy `sha256=<hex>` body HMAC, and
  answers `200`/`422`. A real sender (GitHub, Stripe, a form service) holds only the
  secret.
- **A latent production bug.** Ingest signing secrets lived in an in-memory `Map`,
  so they were lost on restart and differed between instances. A correctly signed
  delivery could fail verification on any instance that had not minted its secret.

## Decision

1. **A new public route, `POST /host/openwop-app/trigger-ingest/{subscriptionId}`.**
   It is a version-agnostic vendor path, so it adds no v1 reliance and is not a
   protocol operation that ADR 0750 refuses. No OpenWOP credential is needed: the
   Standard Webhooks signature over the raw body is the credential.
   - **Public prefix.** Listed in `PUBLIC_PATH_PREFIXES`, following the
     `app-builder-sync/webhook` precedent (ADR 0393).
   - **Raw bytes.** Captured by a scoped `express.raw` parser (1 MB, the ingestion
     cap), any content type.
   - **Tenant.** Taken from the stored subscription, never the request.
   - **Response contract (RFC 0230 §D):**
     - delivered → `202 {outcome: "delivered", runId}`, with `runId` tenant-bound;
     - `webhook-id` repeat → `200 {outcome: "duplicate", runId}`, the same run;
     - `required` + bad signature or >300 s skew → `401 signature_invalid`;
     - not `active` → `409 subscription_not_active`.
   - **No oracle.** Unknown, non-webhook and not-opted-in subscriptions get one
     indistinguishable `404`.
2. **§C.1: a sender cannot change a subscription's state.** A refused post records a
   dead-lettered delivery attempt (`recordRefusedDelivery`) and never touches the
   subscription's state. RFC 0230 gained §C.1 at implementation time, before it
   merged: the earlier leg-2 reading (the subscription goes `dead-lettered` on
   `signature-invalid`) would let anyone who learns the URL disable an integration
   with one garbage-signed post.
3. **Durable sealed secrets.** A new `triggerbridge:ingest-secret` DurableCollection
   stores `sealWebhookSecret(secret)` (a KMS envelope when configured) plus the scheme
   (`legacy-hex` | `standard-webhooks-1`). It is kept apart from the subscription
   record, which is returned verbatim on create/get/list/patch, so no read can
   project it. This also fixes the in-memory-`Map` bug for the legacy route.
4. **Registration.** With the flag on, a `webhook` subscription gets a
   `whsec_<base64 32 bytes>` secret, returned once as `binding.signingSecret`, and
   `binding.ingestUrl` = the signed route. With the flag off, nothing changes.
5. **Verification.** Every `v1,<b64>` entry of `webhook-signature` is compared in
   constant time against `signStandardWebhooks(secret, webhook-id, webhook-timestamp,
   rawBody)`, reusing the RFC 0201 outbound signer. The timestamp must be within
   300 s, and `webhook-id` must match `^[A-Za-z0-9_-]{16,128}$`. `webhook-id` is the
   dedup identity (`externalDeliveryId`).
6. **Flag `OPENWOP_TRIGGER_INBOUND_SIGNING`, default OFF.** The flag gates both the
   route (404 when off) and the v1 discovery facet
   `triggerBridge.ingestion.inboundSigning: ["standard-webhooks-1"]`, so the claim
   and the behaviour are one switch. It opens an unauthenticated route that starts
   runs, so enabling it in production is a deliberate operator step, not a side
   effect of a deploy.

## Alternatives weighed

| Option | Why not |
|---|---|
| Change the existing credentialed `/ingest` route in place | It serves the conformance seams and existing clients; RFC 0230 is opt-in, and the old contract keeps working |
| Put the sealed secret on the subscription record | That record is returned verbatim by four routes; one missed projection leaks it |
| Default the flag ON | A new unauthenticated run-starting surface should not appear in production as a deploy side effect |
| Register the route under `/v1/…` | It adds v1 reliance (the ADR 0642 ratchet) and falls under ADR 0750's no-credential 401 |

## Tests

`test/adr0793-signed-trigger-ingest.test.ts` (6, through the real app):
- facet on/off with the flag, and the route 404ing when off;
- `whsec_` returned once and never on a re-read;
- a credential-less signed post → 202 with a tenant-bound `runId`, and the same
  `webhook-id` → 200 duplicate, same run;
- `run.started.causationId` set;
- a bad signature and a stale timestamp → 401, the subscription still `active`, the
  refused post recorded, and a signed post afterwards → 202;
- an unknown subscription → 404, and the management surface still requiring a
  credential.

**Sabotage-checked:** verification always true, a random dedup identity, and a
dropped skew check each fail a test. `subject-erasure-coverage` classifies the new
store `no-subject`; the existing `trigger-ingestion` suite (17) still passes.

## Follow-ups

- **Turn it on in production** (`--update-env-vars OPENWOP_TRIGGER_INBOUND_SIGNING=true`).
  That is the operator's call. Then the public-path scenario (openwop, next suite
  cycle) can witness the floor.
- **v2 discovery.** It carries no `triggerBridge` family on this host, which predates
  this work. Advertising the family on v2 is separate.
