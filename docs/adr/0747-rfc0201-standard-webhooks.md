# ADR 0747 — RFC 0201 Standard Webhooks: opt-in companion signature, endpoint verification, rotation

Status: implemented (RFC witness program WS2)

Implements OpenWOP **RFC 0201** (`../openwop/RFCS/0201-standard-webhooks-signature-scheme.md`,
`Active`, wire shape locked, no advertisement gate beyond honouring the behaviour).
This is host work on an already-shaped wire: the vendored schemas already carry
`standard-webhooks-1`, `webhooks.secretRotation`, `webhook-verification.schema.json`
and `webhook_endpoint_unverified` (suite 2.36.x). No new RFC.

## Context — measured at `bfd8b8545`

- Only scheme `v1` existed: hex HMAC-SHA256 over `{ts}.{body}` (`host/webhookSignature.ts`).
- `POST /v1/webhooks` ignored `signatureAlgorithms`, accepted any secret, verified nothing.
- One sealed secret per subscription, **copied onto every delivery row at enqueue**,
  and the worker signed with that copy.
- `deliveryId: randomUUID()` is minted once per (subscription, event) and persisted,
  so it is already stable across retries and restarts.
- Advert: `signatureAlgorithms: ['v1']` in both v1 and v2 discovery.
- `POST /webhooks` does not participate in the ADR 0549 idempotency lane, so
  RFC 0201 §D.16 ("idempotency is unchanged") imposes nothing new here.
- The frontend has no webhook *registration* UI (`OperationsWebhooksPage` is a
  delivery-health panel), so this ADR has no UI surface.

## Decision

| # | Decision | RFC |
|---|---|---|
| D1 | Contiguous migration **pg 45 / sqlite 47**: `webhooks` += `signature_algorithms` (JSONB/TEXT), `previous_secret` (same sealed at-rest form as `secret`), `previous_secret_expires_at`, `rotated_at` (epoch ms). Nullable, **no backfill** — NULL `signature_algorithms` reads as `["v1"]`. | §B.4, §B.8 |
| D2 | Registration validates an optional `signatureAlgorithms` (non-empty string array, contains `v1`, no repeats, only ids from `SUPPORTED_SIGNATURE_ALGORITHMS`) → else `400 validation_error`. Opting into `standard-webhooks-1` requires a caller-supplied `whsec_<base64 24–64 bytes>` secret; the host never mints one on that path and never returns it. The `201` echoes the list only when the request carried the field. | §B.5–§B.7 |
| D3 | Endpoint verification before persistence (`host/webhookEndpointVerification.ts`): one POST `{type, challenge}` (24 random bytes, base64url), signed with the three `webhook-*` headers and **no** `OpenWOP-*` headers, through `assertEgressSchemeAllowed` + `webhookEgressDispatcher()` + `redirect:'error'`, 10 s timeout, response read capped at 16 KiB. Anything but a 2xx JSON body echoing the challenge → `400 webhook_endpoint_unverified`, nothing stored, no retry. | §D.13–§D.15 |
| D4 | Per-tenant verification budget (`OPENWOP_WEBHOOK_VERIFY_PER_TENANT_PER_MIN`, default 10/min, per instance), taken **before** the request leaves, so refused registrations spend it too → `429 rate_limited`. | §D.17 (SHOULD) |
| D5 | Signing: `signStandardWebhooks` beside `signWebhookV1` in `host/webhookSignature.ts`, pinned to the upstream library's `sign` test vector. `webhook-id` = the delivery row's `deliveryId`; `webhook-timestamp` = the same variable as `OpenWOP-Timestamp`. | §C.9–§C.11 |
| D6 | **The worker signs from the SUBSCRIPTION at send time, for every row** (`signingHeaders` in `host/webhookDeliveryWorker.ts`). The delivery-row `secret` column is still written but no longer read. | §E.20 |
| D7 | `POST /v1/webhooks/{id}/rotate-secret` (v2 `/webhooks/{id}/rotate-secret` via the protocol rewrite): membership gate as unregister; `404` unknown/foreign; `400 validation_error` for a non-opted subscription or a malformed secret; ONE `UPDATE … SET previous_secret = secret, secret = $new, …`; `200 {rotatedAt, previousSecretExpiresAt}`; no re-verification. `overlapSeconds` from `OPENWOP_WEBHOOK_SECRET_ROTATION_OVERLAP_S` (default 86400; out-of-range falls back to the default rather than clamping). | §E.18–§E.21 |
| D8 | Advertise `signatureAlgorithms: ['v1','standard-webhooks-1']` + `secretRotation: {overlapSeconds}` in v1 **and** v2 discovery from the one module the routes validate against (`host/webhookStandardWebhooks.ts`), in the same PR as the behaviour. | §A.3, §E.18 |

### Why the send-time read covers every row (D6)

The enqueue-time copy is wrong in both directions once rotation exists: a row
enqueued before a rotation and retried after the overlap would sign with a secret
§E.20 says "MUST NOT sign anything", and a row enqueued inside the overlap cannot
know it should dual-sign. Restricting the read to opted-in rows would need the
opt-in flag on the delivery row too, i.e. a second copy of subscription state —
the exact defect being removed. A non-opted subscription cannot rotate, so its
subscription secret **is** the row copy byte for byte; reading it is not a
behaviour change (pinned by the `§B.8` worker test). Cost: one primary-key read
per delivery. **Against WHD-34's pool budget** (`deliveryConcurrency()`, #4100,
landed while this was in review): the bound is on concurrent row TASKS, and each
task still holds at most one connection at a time — the read completes before the
HTTP send, the write after it — so the peak connection demand is unchanged. A
skipped (subscription-gone) row makes no attempt and so is not fed to the WHOPS-2
first-attempt delay metric (#4104).

> **CORRECTION (rebase onto RFC 0215 / ADR 0752, #4122).** #4122 replaced the
> batch loop with a non-blocking per-subscription dispatcher that runs up to
> `OPENWOP_WEBHOOK_MAX_IN_FLIGHT` (32) attempts at once and keeps only DB work
> behind a `pool − 1` gate. The paragraph above assumed a pool-bounded batch; with
> 32 in flight an ungated read per attempt WOULD raise peak pool demand. So the
> send-time read now lives in `attemptDelivery` **inside that same gate**, as does
> the `subscription_deleted` dead-letter. The lane/floor semantics are untouched
> (`rfc0215-webhook-delivery-isolation.test.ts` 7/7), and RFC 0215 §B's
> conditional enqueue is the complement: it stops a row being created for a
> gone subscription, and this stops an already-claimed one being sent.

The column keeps being **written** for rollback safety: a revision that predates
this ADR reads it, and would otherwise sign with an empty secret.

> **CORRECTION 2026-09-26 (`/grade-data`, WHROT-1/WHROT-2).** Two at-rest copies
> of key material outlived their use, and neither is a rollback concern:
>
> - **The delivery-row copy** is now blanked (`secret = ''`) when a row is marked
>   `delivered`. The rollback argument above holds only for rows that can still be
>   SIGNED — pending ones, and `dead` ones an operator can re-arm — and
>   `retryWebhookDelivery` refuses `delivered`. Before, every delivered row kept a
>   copy of a possibly-retired secret until delivery retention reaped it, and that
>   retention (`OPENWOP_WEBHOOK_DELIVERY_RETENTION_DAYS`) is opt-in, so by
>   default: forever. `dead` rows keep their copy (a pre-ADR revision re-arming one
>   would sign with it) and leave at delivery retention.
>   **Superseded the same day (WHROT-3, `/architect`):** `dead` rows are now
>   blanked too, at the dead transition (`rescheduleWebhookDelivery`), and a
>   bounded backfill in the same hygiene lane blanks terminal rows written before
>   either transition did. The retry need does not require the copy: on this
>   revision an operator retry re-arms the row and the worker signs it from the
>   SUBSCRIPTION's current secret, which is the whole point of the send-time read.
>   The only reader left was a pre-0747 revision re-arming a dead row after a
>   rollback, and for a rotated subscription what it would sign with is exactly
>   the retired secret §E.20 forbids. Blanked, that case signs with an empty key
>   and the receiver rejects it. That is fail-safe: nothing is disclosed and
>   nothing is sent under a wrong-but-valid key. Only `pending` rows keep the copy.
> - **`previous_secret`** was never cleared: §E.20 made it inert at
>   `previous_secret_expires_at`, but the ciphertext stayed in the row until the
>   next rotation or the subscription's delete. `Storage.retireExpiredWebhookSecrets`
>   now NULLs it from the retention loop's default-on hygiene lane (not the
>   opt-in governance gate — it deletes no row). `rotated_at` and the expiry stay.
>
> Tenant teardown and fold were already complete for all four new columns: they
> ride the `webhooks` row (`tenant_id` → introspection teardown), and webhook
> secrets are tenant configuration, not subject data, so no eraser applies.

**A missing subscription** means it was unregistered. WHD-16 already deletes its
pending rows, so this is only the in-flight race or an operator's manual retry of
a dead row. Either way the owner withdrew the URL: nothing is sent and the row is
dead-lettered `subscription_deleted`. (Before this ADR the manual-retry path
re-sent to the withdrawn URL with the row's secret.)

## Alternatives weighed

- **Host-minted `whsec_` secret, returned once** — the RFC forbids it (§B.6): the
  subscriber needs the secret *before* the `201` to authenticate §D.
- **Read secrets from the subscription only for opted-in rows** — needs a flag on
  every delivery row; rejected above.
- **Clamp an out-of-range overlap knob** — a typo would silently advertise a
  window nobody chose; falling back to the documented default is legible.
- **Shared (DB-backed) rate limit** — §D.17 is a SHOULD the suite cannot
  attribute, and the per-IP write budget (`middleware/rateLimit.ts`) already sits
  in front. Per-instance is proportionate; the ceiling is budget × instances.
- **Carry `OpenWOP-*` headers on the verification request** — there is no
  subscription for `OpenWOP-Webhook-Id` to name yet, and `OpenWOP-Event-Type` is
  forbidden (§D.13). Sending only the three `webhook-*` headers keeps it
  unmistakable for a delivery.

## /architect review (before code) — verdict: approve with required changes

Tracks A + B. Findings and how each was resolved:

1. **Boundaries** — no parallel system: the verification request reuses the
   delivery egress seam (scheme check + pinned dispatcher + no redirects); signing
   lives beside `signWebhookV1`; advert and validation read one list. PASS.
2. **Data integrity** — rotation must not read-modify-write (a racing second
   rotation would keep the wrong "previous"). Resolved by the single-statement
   UPDATE, pinned on sqlite + pg-mem (`storage-adapter-parity`) and the
   testcontainer lane.
3. **Security** — the secret never reaches a response, error detail or log line
   (only `secretFingerprint`); the new secret is sealed before write and the old
   ciphertext is moved, never opened; the verification body read is capped.
4. **Rate limit** — MUST be taken before the request is sent (resolved: D4).
5. **Replay/fork** — no new effect path: replay forks are suppressed at fan-out
   (H72) before a row exists; a branch fork's events mint new rows → new ids
   (§C.10). ADR 0740's run-execution claim is orthogonal (it fences duplicate run
   execution; each emitted event still gets exactly one delivery row per
   subscription).
6. **Request budget** — the 10 s verification sits inside the 30 s default
   request timeout.
7. **Error code** — `webhook_endpoint_unverified` joins the closed
   `OpenwopErrorCode` union; the i18n map is `Partial`, so no exhaustive map needs
   a row.

## Implementation record

| Phase | What | Tests |
|---|---|---|
| P1 | Migration pg 45 / sqlite 47, types, `Storage.rotateWebhookSecret` | `storage-adapter-parity` (sqlite + pg-mem), testcontainer twin |
| P2 | Signer + vector, registration opt-in + verification + budget | `rfc0201-standard-webhooks.test.ts` |
| P3 | Worker send-time read + dual signing | same file (worker block); existing queue/durability/egress fixtures now insert the subscription their rows belong to |
| P4 | Rotation route (v1 + v2) | same file |
| P5 | Advert (v1 + v2), lane env (`overlap=60`, budget `1000`) | same file; major-2 conformance lane |

Corpus rows witnessed locally (major-2 lane, loopback receiver admitted by
`OPENWOP_WEBHOOK_ALLOW_ORIGINS`): see the PR body for the executed results and
the sabotage run for each.

## Open questions / leftovers

- [ ] **Production witness needs a public receiver.** On the deployed host the
  egress guard refuses the suite's loopback receiver, so the four 0201 rows record
  `blocked` unless the certify run sets `OPENWOP_WEBHOOK_RECEIVER_URL`.
- [ ] RFC 0201 UQ4 (`webhook-id` on the dead-letter record) and UQ5 (`410 Gone`)
  are unresolved upstream; nothing done here.
- [ ] §C.10's restart leg needs the RFC 0158 kill hook; the id is persisted on the
  row, so it holds by construction, but no scenario witnesses it.

## Follow-up (2026-09-26, ADR 0755 — END `/grade-code` pass)

- **WIT-WH-2** — a failure to open a sealed secret or to sign is now an ordinary failed
  attempt (`detail: signing_failed:<ErrorClass>`, the message only in the log), so it
  backs off and dead-letters. Before, the throw escaped `attemptDelivery`: the row kept
  its lease and was re-claimed every lease period with `attempts` never incremented — a
  poison row retried forever. A `getWebhook` DB error still keeps the lease on purpose
  (transient; no attempt happened). `rfc0201-standard-webhooks` "WIT-WH-2" (sabotage-proven).
- **WIT-WH-5** — the caller sees one reason, `not_confirmed`. The seven-code set still
  told "nothing listening" from "an HTTP server answered", a port/liveness oracle at the
  verification budget; §D.14 mandates only the error code. The fine code leads the
  logged `detail`.
- **WIT-WH-4** — a behavioural test for the 16 KiB response cap (with its control).
- **WIT-WH-6/7** — doc placement and a stale test filename fixed.
- **WIT-WH-9** — `GET /webhooks` echoes `signatureAlgorithms`, `rotatedAt` and
  `previousSecretExpiresAt` (never a secret).
- **WIT-WH-1** — the routes now require `webhooks:manage` (ADR 0755 D1).
- **Open:** an expired `previous_secret` and the per-delivery secret copy stay at rest
  until the next rotation / queue retention (WIT-WH-3); the verification budget is keyed
  on the tenant, so bearer callers resolving to `default` share one (WIT-WH-8); the KMS
  AAD is not bound to the subscription (WIT-WH-10, inherited).
