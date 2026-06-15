# ADR 0034 — External-event trigger ingestion (webhook / email / form sources)

**Status:** Accepted — implemented
**Date:** 2026-06-13
**Depends on:** RFC 0099 (`Active` — External-Event Trigger Ingestion, the
normative wire this implements), RFC 0083 (`Accepted` — the durable trigger
bridge this extends: §B four-state machine + §C dedup/retry/dead-letter +
trigger→run causation), RFC 0076 §B / RFC 0093 (`Accepted` — the `safeFetch` /
denied-range SSRF guard reused), RFC 0040 (causation), RFC 0006 §C (replay
cache). **Sibling:** ADR 0033 (Work-twin connector reachability — the motivating
host; it explicitly **deferred** external-event triggers "to an upstream OpenWOP
RFC," which is RFC 0099). ADR 0035 (async/durable A2A — the other deferral).
**Surface:** host runtime — `src/host/triggerIngestionService.ts` (new) +
`src/routes/triggerBridge.ts` (extended) + the `/.well-known/openwop`
`triggerBridge.ingestion` advertisement.
**RFC gate:** This is **host work that rides RFC 0099**, which has reached
`Active`. The wiring was gated on that RFC reaching at least `Active` (RFC 0099
§Implementation notes — "the host wiring is gated on this RFC reaching at least
`Active`; that gate is the whole point of authoring it"). No new wire surface is
invented here.

## Why this exists

ADR 0033 activated the ten work-twins "day 1" honestly against what the host can
actually reach, and **deferred external-event triggers** — a twin could fire on a
cron tick (RFC 0052) or a Kanban card move (the `queue`-source bridge), but not on
a real-world event: a Jira webhook, an inbound support email, a public intake
form. RFC 0083 already *lists* `webhook`/`email`/`form` in
`capabilities.triggerBridge.sources[]`, but only the schedule + queue + in-app
sources were actually wired; the three external sources were dead enum members.
Advertising them as ingesting external events would have been a dishonest wire
claim (`OPENWOP_REQUIRE_BEHAVIOR=true` would fail it), so ADR 0033 held the line
and waited for the spec.

RFC 0099 closed the gap additively: a normative `TriggerEvent` envelope (the
normalized external event handed to the run as `ctx.triggerData`), a
`TriggerSubscriptionRegistration` create contract (`POST
/v1/trigger-subscriptions`), a `triggerBridge.ingestion` capability sub-block,
and two SECURITY invariants (SSRF on any ingestion-path fetch + redaction of the
inbound content off the durable event log). This ADR is the reference-host
implementation of that leg.

## Decision

**Extend the existing RFC 0083 bridge — do not build a second trigger engine.**
The new `triggerIngestionService.ts` normalizes an inbound webhook/email/form
event into a `TriggerEvent`, then calls the **same** `deliver()` the Kanban
`queue` source uses (RFC 0083 §C dedup → causation → retry/dead-letter). The run
is created carrying the envelope as `metadata.triggerData`, which the executor
already surfaces as `ctx.triggerData` (the trigger pack reads it). There is no
parallel store, no shadow state machine — the subscription rows, delivery
attempts, and dedup index are the existing `triggerBridgeService` durable
collections.

### What is wired

1. **`TriggerEvent` envelope (RFC 0099 §F.1).** A content-free-on-the-wire
   in-run payload (`ctx.triggerData`), per source (`webhook`/`email`/`form`), with
   `contentTrust: "untrusted"` always set, a per-source one-of body, a curated
   header allowlist (credential headers stripped), and host-internal
   `AttachmentRef.ref` handles (never a raw external URL the run fetches).
2. **`POST /v1/trigger-subscriptions` (RFC 0099 §F.2).** The portable create
   surface RFC 0083 UQ1 left open: `{ source, workflowId, dedupEnabled,
   verification, retryPolicy }` → `201 { subscription, binding }`. The binding is
   source-specific (`webhook` → `{ ingestUrl, signingSecret, secretFingerprint }`;
   `email` → `{ ingestAddress, ingestUrl }`; `form` → `{ ingestUrl }`). The
   webhook signing secret is returned **once**; re-reads return only the
   fingerprint (`sha256(secret).slice(0,8)`). A registration is RFC 0049-gated: it
   404s if the caller cannot resolve the bound workflow.
3. **`POST /v1/trigger-subscriptions/{id}/ingest`** — the inbound-delivery seam a
   real host fronts with its webhook gateway / inbound-email parser / form POST.
   It coerces the per-source body to the typed ingress input and runs the §F leg.
4. **`triggerBridge.ingestion` capability sub-block** (RFC 0099 §F.3),
   advertised in `/.well-known/openwop` **only when wired** — gated on
   `triggerIngestionEnabled()` (default on; fail-closed via
   `OPENWOP_TRIGGER_INGESTION_ENABLED=false`). `sources[]` widens to include
   `webhook`/`email`/`form` only when ingestion is on, and the registration +
   ingest endpoints 501 when it is off.

### Security / redaction / replay notes

- **SSRF (`trigger-ingestion-ssrf`).** Every ingestion-path fetch (email
  attachment / form file resolution) goes through `resolveAttachment`, which
  reuses the audited RFC 0093 guard: `isDeniedWebhookHost` rejects
  loopback/RFC-1918/link-local/metadata up front, the pinned
  `webhookEgressDispatcher` validates the *connected* address (no DNS-rebind
  TOCTOU), and `redirect: 'error'` forbids redirects. A denied/failed fetch
  **drops the attachment** (the `AttachmentRef` is omitted) and the run still
  starts — the run is never handed a URL. The body cap (`maxBodyBytes`, default 1
  MiB) reuses the RFC 0076 §B response-cap discipline.
- **Redaction (`trigger-ingestion-content-redaction`).** The inbound body /
  headers / email content / form fields live ONLY in `metadata.triggerData` (the
  in-run envelope) — never on a `run.*` / `trigger.*` event payload. The
  `trigger.delivery.attempted` event stays content-free (subscriptionId + opaque
  dedupKey + attempt + outcome + runId only; asserted by a test that scans the
  payload for the inbound material). Credential headers (`Authorization`,
  `Cookie`, `Proxy-Authorization`) are stripped at normalization (SR-1). The
  `dedupKey` is a one-way `sha256` hash (`makeDedupKey`), never inbound content.
- **Replay determinism.** The `TriggerEvent` is cached in the run's start
  snapshot (`metadata.triggerData`, RFC 0006 §C); at replay the host replays the
  cached envelope and never re-accepts/re-fetches the event. A re-delivery of the
  same `dedupKey` within retention is a no-op returning the prior `runId` (RFC
  0083 §C-1 at-least-once → effectively-once).
- **Verification (RFC 0099 §F.2).** `verification.mode` defaults `required`.
  Webhook = HMAC-SHA256 signature check (constant-time, the `webhooks.md`
  recipe); email = DMARC-pass verdict; form = origin/CSRF verdict. A `required`
  event that fails verification starts **no run** (returns `rejected` /
  `signature-invalid`), which the route maps to a 422 — the dead-letter path of
  RFC 0099's negative example. `untrusted` content + the no-HITL-auto-advance rule
  generalize from `threat-model-prompt-injection.md` (an external sender cannot
  vote on the host's approvals): the run's `trustBoundary` is set `untrusted`.

## Boundaries audit

- **No second engine / no parallel store.** `ingestExternalEvent` calls the
  existing `deliver()` and reuses the subscription/delivery/dedup collections.
  The MEMORY "no parallel architecture" rule is honored: the external sources
  *instantiate* the RFC 0083 bridge (same `registerSubscription` + `deliver`),
  they do not shadow it.
- **No wire invention.** The envelope, the registration contract, the capability
  sub-block, and the two invariants are all RFC 0099 §F. The `/ingest` route is a
  non-normative host-extension delivery seam (the spec leaves per-source
  management host-private; only the registration create + the `TriggerEvent`
  shape are normative).
- **Run-start recipe reuse.** The `fire` thunk mirrors the Kanban path
  (`insertRun` → `executeRun` via `setImmediate`, `causationId = deliveryId`), so
  replay/fork/observability are inherited rather than re-implemented.
- **Honest advertisement.** The capability is gated on the code path being live;
  off ⇒ not advertised + endpoints 501 (the ADR 0002 C1 / ADR 0033 honesty
  posture).

## Alternatives considered

These mirror RFC 0099 §Alternatives (the host inherits the spec's rejections):

1. **Carry the inbound body on `trigger.delivery.attempted`.** Rejected — breaks
   §C content-freeness (SR-1 leak + prompt-injection surface on the durable log).
   The envelope is an in-run payload, cached for replay, never event-logged.
2. **Reuse `POST /v1/webhooks` for all three sources.** Rejected — it is
   webhook-specific and has no workflow-binding / dedup / verification policy;
   email + form have no analog. The unified registration is the portable surface.
3. **A new top-level capability.** Rejected — external ingestion *is* a
   trigger-bridge source; a parallel capability would fork the state machine.
4. **Let the run fetch attachments itself.** Rejected — hands SSRF to every
   workflow author and breaks replay. Host-mediated resolution to an internal
   `AttachmentRef.ref` keeps the guard in one place.

## Tests

`backend/typescript/test/trigger-ingestion.test.ts` (17 cases):

- **Service (sqlite memory):** a webhook / email / form event → a run carrying
  the normalized `TriggerEvent` as `metadata.triggerData`; the per-source one-of
  holds; the webhook header allowlist strips `Authorization`/`Cookie`; the
  delivery id is the envelope's `deliveryId` + the delivery-attempt id bound to
  the runId (the §C-3 causation edge).
- **Redaction:** the `trigger.delivery.attempted` payload contains none of the
  inbound material and only the content-free keys; `dedupKey` is an opaque hash.
- **Dedup:** a re-delivery of the same external delivery id returns the prior
  runId (effectively-once).
- **Verification:** a `required` webhook with a bad signature, and a `required`
  email with DMARC fail, each start **no** run (`rejected` /
  `signature-invalid`); a paused subscription skips.
- **SSRF:** an attachment URL on `169.254.169.254` is dropped and the run still
  starts; `resolveAttachment` refuses loopback/metadata/malformed URLs.
- **Helpers:** `verifyWebhookSignature` accepts a valid HMAC and rejects a
  forgery; `bodyWithinCap` rejects oversize; `triggerIngestionEnabled` defaults on
  and fails closed.
- **HTTP surface:** `/.well-known/openwop` advertises `triggerBridge.ingestion`
  only when wired; `POST /v1/trigger-subscriptions` returns the signing secret
  once and never on re-read; rejects a non-resolvable workflow (404, RFC 0049);
  an inbound form delivery starts a run end-to-end.

Verified: `tsc --noEmit` clean; the new file + `trigger-bridge.test.ts` +
`register-all-routes.test.ts` green. (The pre-existing `triggers-surface.test.ts`
failures are the documented pack-env gap — they execute the `core.openwop.triggers`
pack, which needs a populated `~/.openwop-packs`; unrelated to this change and
present on `origin/main`.)

## Correction note (P2-APP, 2026-06-14) — conformance-seam adapter

The original implementation served the §F ingestion leg at the
**registered-subscription** path `POST /v1/trigger-subscriptions/{id}/ingest`
(a real host fronts it with the webhook gateway / inbound-email parser). The
`@openwop/openwop-conformance` **1.25.0** behavioral leg, however, drives a
distinct host-sample seam — `POST /v1/host/openwop-app/trigger-bridge/ingest` — that
takes the source + payload inline (no pre-registered subscription) and reads the
normalized `TriggerEvent` + the content-free `trigger.delivery.attempted` back
out of the *response*. Because that seam was unserved, the behavioral leg was
**soft-skipping on 404** (a vacuous pass), so the SSRF-drop (§F.4) and
Authorization-strip (§F.1) invariants were never exercised against the wire.

Fix (no spec/wire change — a non-normative `/v1/host/openwop-app/*` seam): added the
seam as a **thin adapter over the real `ingestExternalEvent`** — it registers an
ephemeral subscription bound to the deterministic `openwop-app.uppercase` demo
workflow, runs the genuine §F delivery path, then surfaces
`run.metadata.triggerData` (the in-run envelope) + the persisted
`trigger.delivery.attempted` payload. **No parallel demonstrator** (the
MEMORY.md §"No parallel architecture" rule): the redaction/SSRF guards are
asserted on the actual ingestion code, not a reimplementation. The seam 404s
when `OPENWOP_TRIGGER_INGESTION_ENABLED=false` (advertise/enforce parity).
Verified non-vacuously: `trigger-ingestion` 9/9 under
`OPENWOP_REQUIRE_BEHAVIOR=true` with a real `openwop-app.uppercase` run started,
plus `test/host-sample-conformance-seams.test.ts` (7).

## Open questions

These track RFC 0099's Unresolved questions (resolved per the host as the spec
matures):

1. **Email/form authenticity floor.** The host treats DMARC-pass (email) and
   origin-valid (form) as the verification verdict; the verdict is supplied by the
   inbound gateway in the ingress body. RFC 0099 UQ1 keeps the `verification[]`
   enum extensible — the host advertises only the checks it performs.
2. **`inputMapping`.** Left non-normative (RFC 0099 UQ2). Absent ⇒ the run
   receives the whole `TriggerEvent` as `ctx.triggerData` (this host's behavior).
3. **Per-subscription inbound rate limiting.** Deferred to the existing
   `OPENWOP_RATELIMIT_*` operational controls (RFC 0099 UQ3).
4. **Binding-secret rotation.** Not yet wired (RFC 0099 UQ4 proposes reusing the
   `webhooks.md` rotation path). A re-register mints a fresh subscription today.
