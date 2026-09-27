# ADR 0269 — CDP-G: Event schema registry, collection SDKs, ingest-time PII tagging & source-health

**Status:** in-progress (schema registry + collect + ingest PII + collection SDK + batch import shipped; streaming-ingest UNBLOCKED — upstream RFC **0127** (Streaming & CDC trigger sources) authored as Draft with both open questions resolved, host consumer work gated on it reaching Accepted. *Correction note: originally cited as RFC 0123; renumbered to 0127 when 0123 was reserved for connection-pack vendor-grouping and 0124–0126 landed upstream.*)
**Date:** 2026-07-05
**Depends on:** ADR 0262 (CDP program + rulings), ADR 0018 (analytics), ADR 0034 (trigger ingestion) + `host/triggerIngestionService.ts`/`triggerBridgeService.ts`, ADR 0055 (host artifact-type registry), ADR 0077 (PII classification), ADR 0168 (headless + `@openwop/cli` — extend, never fork), ADR 0010 (notifications), RFC 0099 (`TriggerEvent.source` — streaming gate)
**Part of:** CDP program (ADR 0262). CDP-G, Phases 0/2/4.

## Why this exists

The ingestion **spine** is A-grade — the durable trigger bridge (verify → dedup → DLQ → retry →
run causation → replay-safe) plus HMAC/DMARC/origin-verified webhook/email/form ingress
(`host/triggerIngestionService.ts`) and consent-gated analytics beacon. The CDP-specific *collection*
layer around it is thin:

- **No first-party collection SDK** — only the analytics beacon + a chat-widget embed snippet.
- **No versioned event schema registry** — validation is Ajv against a per-workflow `inputSchema`
  (`host/runInputValidation.ts`), **fail-open**, not an enforce-at-ingest event contract.
- **PII tagging is log-only** — `dataClassification` is not applied to ingested event payloads.
- **Source-health is scattered** — per-source `status`/`lastError` + bridge `listDeliveries`, no
  unified view or alerting.

## Decision

Extend analytics + ingestion with a collection SDK, an event schema registry, ingest-time PII
tagging, and a source-health surface — all riding the existing bridge (ADR 0262: reuse
`triggerBridgeService`/`triggerIngestionService` verbatim, never beside them).

### 1. Collection SDKs + generic event-ingest endpoint (Phase 0/2)

Thin first-party JS/mobile/server SDKs POSTing to the analytics beacon + a new generic
`POST /v1/host/openwop-app/cdp/collect` (versioned contract, consent-gated, idempotency-keyed, landing
into the bridge via `ingestExternalEvent`). Published **alongside `@openwop/cli`** — do **not** fork
the CLI (ADR 0168). Host-ext (a host-issued endpoint), no RFC.

### 2. Event schema registry (Phase 2)

Promote `runInputValidation` to a first-class **versioned event schema registry** — schemas stored as
artifact-types (`host/artifactTypes.ts`, ADR 0055) — enforcing **at ingest** in `ingestExternalEvent`
(quarantine/transform/block per policy, replacing the fail-open per-workflow check for CDP events).
Host-ext unless the rejection semantics become an *advertised wire contract* (then RFC).

### 3. Ingest-time PII tagging (Phase 2)

Run `dataClassification` over ingested `TriggerEvent`/analytics payloads, persisting per-field labels
that feed the CDP-F masker + the consent `subjectErasure` seam (ADR 0077). No new taxonomy.

### 4. Source-health + alerting (Phase 2)

Compose bridge `listDeliveries` + subscription state + knowledge-sync `status`/`lastError` into an
admin health surface with threshold alerting via the existing **notifications** feature (ADR 0010).

### 5. Streaming / warehouse-CDC ingest sources (Phase 4 — RFC-gated)

A `core.openwop.streams` connection+node pack (Kafka/Kinesis/PubSub consumer) landing each message
into the bridge via `ingestExternalEvent`. `TriggerEvent.source` is wire-visible (`webhook|email|form`);
adding `stream`/`change` **extends RFC 0099 §F.1** and needs an Accepted OpenWOP RFC before the claim
ships. The consumer plumbing is host-ext.

## Scope / non-goals

- No new bridge, dedup, DLQ, or retry — all reused from `triggerBridgeService`.
- Batch/CSV import (compose `csv-parse` + `run-input-forms` mapping staged through the bridge) is a
  small host-ext follow-on, noted here, buildable alongside part 1.
  - **Implemented (Track-1 follow-on):** `collectEventBatch` + `POST /cdp/collect/batch` + SDK
    `collectBatch(events)` land the batch half over the SAME schema-enforced `collectEvent` path —
    best-effort per row (a bad row is reported, not fatal), processed sequentially, hard-capped at
    `MAX_COLLECT_BATCH=100` (oversize rejected, never truncated — the connection-budget guard). CSV→rows
    parsing stays client-side (keeps the SDK zero-dep); no second ingest mechanism was added. The
    concurrency-hardening of the sibling event-schema version mint (insert-if-absent CAS) shipped in the
    same follow-on.

## Phased plan

1. **Phase 0:** collection SDK + generic `cdp/collect` endpoint.
2. **Phase 2:** event schema registry (enforce-at-ingest) + ingest PII tagging + source-health surface + batch import.
3. **Phase 4:** streaming/CDC ingest sources behind the RFC 0099 extension.
4. Verify: SDK→bridge idempotency test; schema-reject-at-ingest test; ingest PII-tag→erasure cascade test.

## Open questions

- [ ] Schema-registry rejection default (block vs quarantine) per source — tenant policy. Default: quarantine + alert.
- [ ] SDK language priority — JS first, then server (Node/Python), then mobile.

## Consequences

Collection becomes first-class (SDKs + a validated, PII-aware ingest contract + health/alerting)
without touching the proven spine. The only wire item (streaming/CDC sources) is cleanly isolated
behind the RFC gate, so everything else ships host-ext immediately.
