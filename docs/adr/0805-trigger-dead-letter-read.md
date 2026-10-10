# ADR 0805 — a trigger subscription's dead-lettered deliveries are readable (RFC 0232)

Status: Accepted (2026-10-03; implemented in the PR that adds this file — see § Implementation record)

- **Wire:** RFC 0232 (`Active`, openwop #1869 → `8817d7c0`): the optional read
  `GET /v1/trigger-subscriptions/{subscriptionId}/dead-letters`
  (`listTriggerDeadLetters`) behind the facet `triggerBridge.deadLetter`. This
  host implements the RFC; it adds no wire of its own.
- **Why now:** RFC 0230 cannot be accepted on a production host without it. Its
  last floor row reads run-less trigger events through the event-log seam, and
  production serves no seams on purpose. RFC 0232 makes that row witnessable
  through a normative read instead.
- **Decided with the user** (2026-10-03): move RFC 0232 to `Active` and close what
  it needs. The corpus half is openwop-7b's #1869. This ADR is the host half.

## Context — what this host had (measured on `633114a44`)

- Every delivery attempt is a row in ONE collection, `triggerbridge:delivery`,
  keyed `<deliveryId>:<attempt>`. Rows are content-free (ids, opaque dedup key,
  counter, outcome, instant).
- **No dead-lettered delivery produced an event in production.**
  `trigger.delivery.attempted` was appended only on the delivered path (onto the
  new run's log). A dead-lettered delivery has no run, so only the conformance
  seam appended it, under a carrier id. RFC 0232 resolves this by saying run-less
  transitions are *recorded*, not emitted, and the read is where they are visible.
- **No history of the state change.** Retry exhaustion only overwrote the
  subscription's `state`.
- **Reading by subscription was a full scan** (`listDeliveries` =
  `list().filter(subscriptionId)`). A public read must not be.
- **No retention** on the delivery collection.
- **Two refusals were recorded wrongly or not at all:**
  - The signed ingest (ADR 0793) recorded a refused post with the **raw
    `webhook-id` header as its dedup key**. RFC 0232 §C.1 forbids a record
    carrying an inbound header.
  - The credentialed ingest path's `required` verification failure (§F.2)
    recorded **nothing**. RFC 0232 §C.3 says a refused delivery appears in the read.
- Two code comments claimed dead letters go to "the RFC 0053 sink". Nothing ever
  routed them there (#4346 corrected the comments; RFC 0232 §D corrected the spec).

## Decision

1. **A dedicated sink, `triggerbridge:deadletter`**, keyed
   `<subscriptionId>:<inverted epoch ms>:<deliveryId>`.
   - One subscription's records are a bounded prefix scan, already newest first.
   - The existing `triggerbridge:delivery` rows are unchanged. The operator
     webhook-health panel still reads them.
   - **Why not re-key `triggerbridge:delivery`:** it holds every attempt,
     including delivered ones, and has readers. A second, narrow collection
     carries no migration and no risk to them.
2. **The record is the RFC 0232 §C shape, built only from content-free values:**
   - `attempt` is exactly `{subscriptionId, dedupKey, attempt, outcome: "dead-lettered"}`,
     the fields this host would put in the event.
   - `stateChange` is present only for retry exhaustion:
     `{subscriptionId, source, fromState, toState: "dead-lettered", reason: "retry-exhausted"}`.
   - `attemptEventId` is a minted UUID (this host's event-id form).
   - No caller can pass inbound content in, because the writer takes none.
3. **Three writers:**
   - Retry exhaustion in `deliver()` writes `retries_exhausted`, with the state change.
   - `recordRefusedDelivery` writes `verification_failed`, with no state change.
     It serves both the signed route and the credentialed route's §F.2 refusal,
     which is new here.
   - **The refused dedup key is `makeDedupKey(subscriptionId, webhook-id)`**: the
     same opaque hash a delivered event carries, never the header value.
4. **§C.2 agreement with the seam.** The conformance `exhaust` seam still appends
   the event to a carrier log. It now binds the record's `attemptEventId` to that
   event's id (`bindDeadLetterAttemptEvent`), so the read and the seam agree.
   - The seam's `state.changed` payload also gains its schema-required `source`.
5. **Paging.**
   - `limit`: a positive integer, else `400 validation_error`; values over the
     maximum are clamped to `maxPageSize` = 100.
   - `cursor`: opaque base64url of `{s: subscriptionId, a: lastKey}`. A cursor
     naming another subscription, or one that does not decode, is
     `400 validation_error` (§B.3).
   - A page that stops short carries `nextCursor`; the last page does not.
6. **Retention: 7 days, exact on the read.**
   - `expiresAt = deadLetteredAt + 7 d`.
   - The read withholds expired rows itself; the kv age-out lane
     (`registerKvAgeOut`, `timestampField: deadLetteredAt`) deletes them later.
   - Each row carries `tenantId`, so a tenant's legal hold resolves.
7. **Tenant-bound, same as `GET /trigger-subscriptions/{id}`.**
   - Scope: `webhooks:manage`.
   - Another tenant's id and an unknown id are the same `404 not_found`.
8. **Advertised unconditionally** as `triggerBridge.deadLetter: {retentionDays: 7, maxPageSize: 100}`.
   - The route is unconditional too, so the claim and the behaviour cannot diverge.
   - Every source can dead-letter, so the read is not tied to the ingestion or
     inbound-signing flags.
   - Major 2: this host's v2 discovery carries no `triggerBridge` family (ADR 0793
     records why). The v2 path reaches the same handler through the v2 mount.

## Alternatives weighed

- **Emit the run-less events onto a host log, and read that.** That is RFC 0232's
  Alternative 3, rejected there. It would also make the seam's carrier id
  normative, a run id that names no run.
- **Serve the read from `triggerbridge:delivery` with an index.** It needs a
  re-key or a secondary index on a collection with live readers, for a read
  that wants only the dead-lettered slice. Rejected for blast radius.
- **Gate the read behind a flag, as `inboundSigning` is.** That flag exists
  because the signed route is credential-less. This read is credentialed and
  tenant-bound, and it exposes nothing the authenticated
  `GET /trigger-subscriptions/{id}` did not already show. A flag would only add
  a way for the advert to lie.

## Not done (recorded, not hidden)

- **`workflow-not-found` deliveries** return `outcome: "dead-lettered"` from
  `ingestExternalEvent` without a delivery row. They write no record, because
  RFC 0232's `reason` is closed at two values and UQ5 was closed with "no new
  reasons". A sender sees `422 workflow_not_found`.
- **The `stateChange` content-free row** stays seam-only on this host, as RFC
  0232 G2 says: no wire surface causes a state change.

## Implementation record

| Phase | What | Where |
|---|---|---|
| 1 | Sink, writer, read, seam bind | `host/triggerBridgeService.ts` (`putDeadLetter`, `listDeadLetters`, `bindDeadLetterAttemptEvent`) |
| 1 | Credentialed §F.2 refusal recorded | `host/triggerIngestionService.ts` |
| 1 | Route, cursor, limit; refused key hashed; seam binds + carries `source` | `routes/triggerBridge.ts` |
| 1 | Facet | `routes/discovery.ts` |
| 1 | Tests | `test/adr0805-trigger-dead-letter-read.test.ts` (HTTP, 7), `test/trigger-ingestion.test.ts` (+2) |
| 2 | Suite pin to the release carrying RFC 0232's scenario | `backend/typescript/package.json` |

## Follow-up (2026-10-04) — a trigger subscription can be deleted

**What was found.** Every certification cut's trigger-bridge legs register
subscriptions, and nothing could remove them: the corpus defines only
`createTriggerSubscription` and `listTriggerDeadLetters`, and this host served
GET / POST / PATCH but no DELETE. `publish-evidence.sh` swept only webhook
subscriptions. MEASURED 2026-10-04: about 278 accumulated in the conformance
tenant. Their `whsec_` secrets were returned once and discarded, so no one could
post a valid event to them; the cost was rows in `triggerbridge:sub`, which
`listSubscriptions` scans in full.

**Decision.**
1. **A host-extension `DELETE /host/openwop-app/trigger-subscriptions/{id}`.**
   It is not a protocol operation, so no RFC. It lives on the vendor home,
   registered via `vendorTwin`, because after the v1 retirement (RFC 0234) a
   `/v1` write answers 410.
   - Scope and tenancy match the PATCH: `webhooks:manage`, and a foreign
     tenant's bound id is `403 id_tenant_mismatch`.
   - It accepts the `~` projection, a decoded `tenant/id` and a bare id, since
     vendor paths are outside the v2 identity middleware.
   - It removes the subscription row, its delivery rows, its dead-letter records
     and its sealed signing secret. The opaque dedup rows age out on their own
     24 h window.
2. **`publish-evidence.sh` sweeps trigger subscriptions after every cut.** It
   takes all of them, not only that run's, so the backlog clears on the first
   cut.
   - It keeps anything `paused` (state a person set) and anything listed in
     `OPENWOP_EVIDENCE_KEEP_TRIGGER_SUBS`.
   - The sweep is non-fatal, like the webhook one.

**Tests.** `test/adr0805-trigger-subscription-delete.test.ts` runs with 1.x
live and with `OPENWOP_V1_RETIRED=true`:
- delete removes the row, the dead letters and the secret (the ingest URL then
  404s);
- a second delete is 404;
- a foreign bound id is 403 and deletes nothing;
- a never-minted own id is 404;
- a malformed escape is 400;
- the `/v1` twin is 410 when retired.

Sabotage: a route that ignores the tenant segment reds 4 of 7.
`whd18-scripts.test.ts` pins the sweep's keep rules.
