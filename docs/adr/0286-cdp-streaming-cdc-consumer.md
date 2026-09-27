# ADR 0286 — CDP streaming/CDC consumer (RFC 0127 G4 closure)

Status: Accepted

- **Rides:** RFC 0127 (streaming & CDC trigger sources — Accepted) + RFC 0095
  (connection packs). Host work only — **no new RFC**.
- **Closes:** RFC 0127 carried-forward gap **G4** — "the first host operating a
  REAL streaming/CDC consumer."
- **Builds on:** ADR 0034 (RFC 0099 external-event ingestion), the flag-gated
  RFC 0127 ingest path (PR #1332), ADR 0024 (connections + inbound webhooks).

## Context

RFC 0127 adds two externally-originated trigger sources on top of the RFC
0083/0099 bridge — `stream` (a message consumed from a Kafka/Kinesis/Pub-Sub
broker) and `change` (a warehouse/DB change-data-capture row). The ingest PATH
already exists and is flag-gated (`OPENWOP_TRIGGER_STREAM_CDC_ENABLED`):
`triggerIngestionService.ts` normalizes a `stream`/`change` ingress → a
`TriggerEvent` (op-required for `change`, `(topic,partition,offset)` /
`(table,changelogId)` dedup seeds), and the host-sample seam
`/v1/host/openwop-app/trigger-bridge/ingest` drives it. But the sources were held
**honest-off** — absent from `capabilities.triggerBridge.sources[]` /
`ingestion.externalSources[]` — with the standing guardrail "advertise only what
an Accepted RFC covers." RFC 0127 is now Accepted, and G4 asks for a host
operating a **real consumer**, not just a seam.

## Decision

Ship a **push-ingress** streaming/CDC consumer that rides the single existing
ingest owner, then flip the advert.

### 1. Push-ingress, not a pull daemon (the Cloud-Run-correct shape)

The consumer is a **push receiver**, not a long-lived pull-consumer daemon. This
host runs on Cloud Run, which scales to zero and holds a tight Cloud SQL
connection budget (see MEMORY: DB connection budget). A standing Kafka/Kinesis
pull loop would fight both — it would pin an always-warm instance and hold
connections open. A broker **push subscription** (Google Pub/Sub push, AWS
EventBridge API destination, or a Kafka→HTTP bridge) instead delivers each
message to a **signature-verified, admin-gated webhook**, which maps the payload
→ `ingestExternalEvent({source:'stream'|'change', …})`. Cloud Run wakes on the
push, starts the run, and idles back down. A push receiver that accepts a real
broker push **is** a real consumer.

### 2. Single owner — ride `ingestExternalEvent`, extend `inboundWebhooks`

The receiver is **not** a new webhook framework. It extends the existing inbound
webhook owner `features/connections/inboundWebhooks.ts` (which today verifies
Slack/Discord/Telegram signatures and dispatches to `resolveAndResume`) with a
**streaming/CDC provider kind** (`core.openwop.streams`). Its branch verifies the
broker-push HMAC (`verifyStreamSignature`, host-side, replay-windowed), then
dispatches to **`ingestExternalEvent`** — the single ingest owner in
`triggerIngestionService.ts` — starting a **NEW run**, never `resolveAndResume`
(a broker message is a fresh trigger, not a HITL reply). Dedup, causation, and
the content-free `trigger.delivery.attempted` all come from the reused RFC 0083
§C delivery path inside `ingestExternalEvent`. There is **no parallel ingest and
no forked route**.

### 3. `core.openwop.streams` connection (RFC 0095), ingress-only

The broker is modeled as a built-in RFC 0095 connection provider
`core.openwop.streams` (BYOK creds host-side via the existing connections
framework — no parallel credential model). The per-connection push-verification
signing secret is held host-side under the ADR 0024 BYOK envelope
(`connection-inbound:<connectionId>`), never returned on a read. The provider is
**INGRESS-ONLY**: `readOnly` with no write scope group, `consumerNodes: []`, no
outbound binding. **`streams` MUST NOT gain an outbound-publish path** — that is
`core.openwop.messaging`'s job (ARCHITECTURE.md:438). The boundary is explicit
and enforced by the manifest shape.

### 4. Honest-off advert flip — only after the witness

`stream`/`change` join `capabilities.triggerBridge.sources[]` +
`ingestion.externalSources[]` **only** when `OPENWOP_TRIGGER_STREAM_CDC_ENABLED`
is on (mirroring the ingest-path gate `streamCdcIngestionEnabled()`), and only
now that (a) RFC 0127 is Accepted and (b) a real consumer backs the claim.
Default OFF ⇒ the advert stays `webhook/email/form`, so
`OPENWOP_REQUIRE_BEHAVIOR=true` never reads a hollow claim. This flip is what
formally **closes G4**; the `trigger-stream-cdc-sources` conformance scenario's
behavioral leg becomes required (advertise-only-what-you-honor) and passes
against the seam.

## Security

- **Signature verification** — every push is HMAC-verified host-side against the
  per-connection signing secret, constant-time, with a 5-minute replay window,
  before any work. A bad/absent/stale signature → `401`.
- **Admin-gating** — configuring an inbound stream connection rides the existing
  `authorizeManage` guard (owner/`host:connections:manage`); only the resulting
  public ingest is unauthenticated (the signature is the credential) — the same
  posture as the Slack/Discord/Telegram inbound.
- **Tenant isolation** — the connection + config + signing secret + subscription
  are all tenant-scoped; the started run carries the connection's `tenantId`.
- **SR-1** — the broker message / CDC row body lands only in
  `run.metadata.triggerData` (`ctx.triggerData`), never on the durable
  `trigger.delivery.attempted` event; the seam enforces this and the consumer
  inherits it verbatim.

## Alternatives weighed

- **Pull-consumer daemon** — rejected: fights Cloud Run scale-to-zero + the
  Cloud SQL connection budget; correct for a stateful worker host, wrong here.
- **A bespoke `/streams/ingest` route + its own dedup/verify** — rejected: it
  would shadow `ingestExternalEvent` and fork the webhook framework, exactly the
  "vacuous carrier / parallel primitive" anti-pattern this program guards against.
- **Advertise `stream`/`change` unconditionally** — rejected: dishonest until a
  real consumer + Accepted RFC exist; `OPENWOP_REQUIRE_BEHAVIOR=true` would fail
  a hollow advert.

## Implementation → commit map

| Piece | File |
|---|---|
| Advert flip (gated) | `src/routes/discovery.ts` |
| `core.openwop.streams` provider | `src/features/connections/providerRegistry.ts` |
| Consumer (verify → `ingestExternalEvent`) | `src/features/connections/inboundWebhooks.ts` |
| Route wiring (config gate + push headers) | `src/features/connections/routes.ts` |
| Tests | `test/cdp-stream-cdc-consumer.test.ts` |
| Conformance dep bump → 1.54.0 | `backend/typescript/package.json` |

## Open questions

- A per-connection **dead-letter surface** for repeatedly-rejected pushes is
  deferred (the RFC 0083 retry/dead-letter machinery already covers the delivery
  leg; a broker-push-level DLQ is a broker concern).
- **OIDC-JWT push auth** (Pub/Sub's default) is a future auth mode alongside the
  HMAC scheme; the HMAC front (shared-secret token / EventBridge / Kafka bridge)
  is the day-1 witness.
