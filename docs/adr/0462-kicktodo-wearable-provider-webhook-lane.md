# ADR 0462 — KickTodo wearable provider webhook ingest lane

> **Renumbered from 0461 → 0462 (2026-07-21):** a parallel session claimed 0461
> concurrently (`0461-kicktodo-studio-embedded-author-chat.md`, #2328). This ADR
> (#2327, Proposed) moved to the next free number to keep one-decision-per-number;
> the peer's implemented 0461 was left untouched. References updated in lockstep.

Status: implemented (P1–P3, honesty-gated + mock-tested; LIVE lane externally-blocked) — 2026-07-21

> **Implementation record (2026-07-21):** all three phases shipped gated-off + mock-tested
> per §6 (a live provider needs external OAuth/webhook creds this env lacks).
> P1 — `wearableLinkService.ts` (the `(provider,providerUserId)→ownerSubject` link store,
> fail-closed on `wearable-evidence` consent, first-write-wins, on the erasure seam) +
> the link/unlink/list routes. P2 — `wearableProviderAdapter.ts` (the honesty-gated
> adapter registry) + `wearableWebhookService.ts` (token→tenant resolution mirroring the
> feed token; verify-signature-FIRST via the Connection-resolved secret; link-resolve →
> live-consent → the EXISTING `ingestWearableMetric` kernel) + the public
> `/public/kicktodo/wearable-webhook/:token` route (PUBLIC_PATH_PREFIXES; uniform
> 401/404/silent-204). P3 — `wearableLivenessService.ts` (the durable `lastReadingAt`
> clock, stamped inside `ingestWearableMetric`) + `exceptionSources.ts` — **the fifth
> ADR 0460 exception source, now honest** (fires only on stale-AND-live-consent-AND-active-
> enrollment, the join that avoids the false positives 0460 deferred over). 15 tests +
> 33 regression green; no wire, no RFC; no new FE (rides the Connections UI + the ADR 0460
> Exception Ledger). /architect + /code-review clear per phase; /ux-review N/A (backend).
Relates: ADR 0421 (kicktodo-integrations — the INERT wearable lane this activates), ADR 0024 (Connections/BYOK), RFC 0095 (connection packs), RFC 0047 (provider auth), RFC 0079 (connection-use provenance), ADR 0426 (opaque subjects), ADR 0405 (SSRF-guarded egress)
TODO refs: `docs/steward/TODO.md §6` KT-PORT-6 (the wearable half, re-scoped from "pack authoring, no host code")

## 1. Context

KT-PORT-6 proposed filling KickTodo's two "dead" integration ports with RFC 0095
connection packs, "pack authoring, no host code." A scoping investigation
falsified that framing for BOTH ports: **a connection pack is purely declarative**
— it registers provider metadata and resolves the RFC 0047 `provider` string
(RFC 0095 §B.2), but implements no transport and no ingest. The ports are empty
because they lack **adapters**, not packs.

- **Calendar-write** (the sibling, KT-PORT-6a) needs only a host `CalendarTransport`
  adapter that fits ADR 0421's existing registered-port seam — **no new ADR**, it
  ships separately, honesty-gated.
- **Wearable ingest** (this ADR) is heavier: today the ONLY lane is a manual
  reading pushed through the OWNER's own session — `ingestWearableMetric`
  (`integrationService.ts:206`), consent-gated, route `POST …/wearable-ingest`
  (`routes.ts:130`). The route comment is explicit that a provider push lane was
  deferred: *"the connected device/provider posts on the OWNER's behalf via their
  session; provider-webhook lanes ride Connections later."* There is **no webhook
  route, no provider adapter, no signature verification, and no provider→owner
  subject mapping** anywhere, and **no wearable provider** in the built-in registry
  or the example connection packs.

A provider webhook lane is a **new inbound trust boundary** (an unsolicited push
from an external system, authenticated by a provider signature, that must be
mapped to one of our opaque subjects and gated by that subject's live consent).
That is net-new ingress + auth + identity-mapping surface — it needs an ADR, not a
pack. This ADR scopes it; **it does not claim a shipped integration** — the live
lane is externally-blocked (see §6).

## 2. Boundaries audit (what exists / what's new)

- **Reuse, do not fork:** the existing `ingestWearableMetric(tenantId,
  ownerSubject, metric, value)` is the ONE ingest kernel — consent gate +
  enrollment/rule walk + occurrence→check-in conversion + provenance-only storage
  (raw provider payloads never kept, `integrationService.ts:204`). The webhook lane
  MUST terminate in this same kernel, never a second ingest path.
- **Connections (ADR 0024) owns credentials.** The provider's webhook-signing
  secret + the outbound token (for the initial subscription handshake) resolve via
  `resolveConnectionCredential({tenantId, provider})` — KMS-enveloped, per-tenant,
  fail-closed. No secret on a row, in a log, or on any result boundary.
- **RFC 0095 connection pack** supplies the provider DEFINITION (id, auth, host
  allowlist) so `provider: '<wearable>'` resolves — declarative only.
- **Subject mapping is the new store.** A provider push identifies the user by the
  provider's OWN id (e.g. a Fitbit user id), not our opaque subject. A new
  `kicktodo-wearable-link` collection maps `(tenantId, provider, providerUserId) →
  ownerSubject`, written at connect time (when the subject links their device
  under their session) — the ONLY moment we can bind the two identities with the
  subject present. Keyed `${tenantId}::${provider}::${providerUserId}`; carries the
  opaque subject, never provider PII beyond the id. On the ADR 0381 subject-erasure
  seam (a subject's links are erased with them).
- **No new wire.** Webhook ingress is a host-extension route
  (`/v1/host/openwop-app/kicktodo/integrations/wearable-webhook/:provider`);
  it never touches the OpenWOP wire.

## 3. Decision

A **provider webhook ingest lane** that terminates in the existing kernel:

1. **Link (subject present):** the participant links a wearable provider under
   their session (a Connection + a `kicktodo-wearable-link` row binding the
   provider's user id to their opaque subject). Consent (`wearable-evidence`) is
   the existing gate.
2. **Webhook ingress (subject absent):** `POST …/wearable-webhook/:provider` — a
   public host-extension route (added to `PUBLIC_PATH_PREFIXES`) that:
   - **verifies the provider signature FIRST** (HMAC/JWS per the provider,
     constant-time) using the Connection-resolved signing secret — an unverified
     body is a uniform 401, never processed;
   - resolves `(provider, providerUserId) → (tenantId, ownerSubject)` via the link
     store — an unknown mapping is a uniform 204/404 (no existence leak, no work);
   - re-checks the subject's **live `wearable-evidence` consent** (a revoked
     consent drops the push — fail-closed);
   - normalizes the provider payload → `(metric, value)` and calls the EXISTING
     `ingestWearableMetric` kernel. Raw payloads are never persisted.
   - is **replay/duplicate-safe** (a provider redelivery is idempotent — the
     kernel's occurrence→check-in conversion already is; the route dedupes on the
     provider event id where available).
3. **Adapter, honesty-gated:** a `wearableProviderAdapter` (the
   `imageProviderAdapter` pattern) does the provider-specific signature scheme +
   payload mapping, present ONLY when the operator opts in
   (`OPENWOP_WEARABLE_PROVIDER_ENABLED` + a configured provider) — otherwise the
   lane is honest-off and the admin console renders "port awaiting adapter."
4. **Staleness (unblocks ADR 0460 source 5):** with a real push lane, a durable
   `lastReadingAt` (written by the kernel on ingest) + the enrollment-active +
   live-consent join finally makes the deferred ADR 0460 wearable-staleness
   exception source HONEST (a stream that WAS reporting and went quiet, for an
   active enrollment with live consent). Sequenced AFTER this lane exists.

## 4. Evaluation matrix (deltas only)

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | EXTENDS `kicktodo-integrations`; one new store (`kicktodo-wearable-link`); one new adapter file; no new toggle |
| 2 | Toggle / gate | operator env `OPENWOP_WEARABLE_PROVIDER_ENABLED` (honesty gate, default off); consent `wearable-evidence` unchanged |
| 3 | Workflow surface | none (ingress lane) |
| 4 | Node/agent packs | none (the RFC 0095 connection pack is a declarative provider def, not a node pack) |
| 5 | Public surface | `POST …/wearable-webhook/:provider` → `PUBLIC_PATH_PREFIXES`; tenant/subject derived from the verified push + link store, NEVER the request; uniform 401/204; rate-limited + payload-capped (abuse) |
| 6 | RBAC / isolation | link store tenant-keyed; ingest reuses the kernel's consent gate; a push for an unknown/other-tenant mapping does nothing |
| 7 | Secrets | signing secret + tokens via the Connections broker (KMS); never on a row/log/boundary; signature verify constant-time |
| 8 | Replay/fork | n/a (no run); webhook idempotent on the provider event id |
| 9 | Privacy | opaque subject only in the link row (ADR 0426); raw provider payload never kept; link on the subject-erasure seam |
| 10 | Frontend | the participant "link a device" flow rides the existing Connections UI; the admin console's honest "awaiting adapter → connected" render already exists (ADR 0438 A6) |

## 5. RFC verdict

**Host-extension only — no new RFC.** Rides Accepted RFC 0095 (connection packs),
RFC 0047 (provider auth), ADR 0024 (Connections). The webhook route is
non-normative (`/v1/host/openwop-app/*`).

## 6. Externally-blocked — the honesty posture

A **live** wearable lane requires a real provider account (Fitbit/Oura/Garmin/…),
its OAuth client + webhook subscription registration, and its signing secret —
none available in this environment (the same external block as the ADR 0413 native
client). Therefore this ADR ships, at most:

- the ingress route + adapter + link store, **honesty-gated OFF**
  (`OPENWOP_WEARABLE_PROVIDER_ENABLED` unset ⇒ the route 404s / the adapter is
  unregistered), with **mock-tested** unit coverage (a fake provider signature +
  payload, the `imageProviderAdapter` test precedent);
- the admin console continues to render "port awaiting adapter" honestly until an
  operator configures a real provider.

It MUST NOT advertise a working wearable integration it cannot honor
(`OPENWOP_REQUIRE_BEHAVIOR=true` would fail a dishonest advert). Shipping
gated-off-but-tested is the honest maximum here — exactly the
`imageProviderAdapter` / ADR 0421-inert-lane posture.

## 7. Phases

| Phase | Contents | Gate |
|---|---|---|
| 1 | The `kicktodo-wearable-link` store + the link-at-connect flow (subject present) + subject-erasure wiring | — |
| 2 | The webhook ingress route (signature-verify → link-resolve → consent → kernel) + `wearableProviderAdapter`, honesty-gated, mock-tested | Phase 1 review clear |
| 3 | The ADR 0460 wearable-staleness exception source (durable `lastReadingAt` + enrollment/consent join) — the deferred fifth source, now honest | Phase 2 (a real push lane exists) |

## 8. Open questions

- OQ1: one adapter per provider vs a generic signature/normalizer driven by the
  connection pack's declared scheme (proposal: start with one provider adapter —
  the `imageProviderAdapter` shape — generalize only at the second provider, the
  first-consumer rule).
- OQ2: webhook dedupe key when a provider sends no stable event id (proposal: a
  short-TTL `(provider, providerUserId, metric, bucketedTimestamp)` idempotency
  marker; the kernel's check-in conversion is already idempotent per occurrence).
- OQ3: does linking need its own consent kind distinct from `wearable-evidence`
  (proposal: no — `wearable-evidence` already governs wearable data use; linking is
  the mechanism, not a new purpose).
