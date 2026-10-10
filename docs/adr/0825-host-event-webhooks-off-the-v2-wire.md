# ADR 0825 — host-event webhooks leave the major-2 wire

Status: **Accepted** (2026-10-05). The decision was CORRECTED the same day: implement RFC 0236 (see the correction note under Decision).

Found during ADR 0812 P2b (porting `crm-events`, `cms-host-event-binding` and `commerce-governance` off `/v1`). The
corpus steward ruled on it (openwop-5e, 2026-10-05).

## Context

`routes/webhooks.ts` `deliverHostExtEvent` fans **runless host events** (ADR 0208: `host.crm.contact.created`,
`host.cms.page.published`, `host.commerce.order.paid`, …) out to webhook subscriptions. No run backs them, so the event
carries a synthetic `runId: "hostext:<type>"` and `sequence: 0`. A major-2 subscriber receives the v2 type spelling
(`openwop-app.crm.contact-created`) and the envelope `{ runId: "hostext:openwop-app.crm.contact-created", event }`.

That body is not valid v2 (corpus ruling, each point against the v2 text):

1. **v2 webhooks carry run events only.** `webhooks.md` §Delivery: the body is `{ runId, workspaceId?, event }`, "where
   `event` is the verbatim run event", and it MUST validate against `webhook-delivery.schema.json`, whose `runId` is the
   tenant-bound grammar. §Subscriptions: "A subscription MUST receive only events from runs within its tenant scope."
2. **A minted pseudo-run id is not a fix.** The envelope `runId` must match "the nested event and every response
   representation". A `<tenant>/hev.<id>` names no run, `GET /runs/{runId}` cannot answer for it, and the run-event
   schema's `sequence` and the `(OpenWOP-Webhook-Id, runId, sequence)` dedup key have no honest values.
3. **v2 has no legal home for a runless vendor event today.** `events.md` §Host events: `hostEvents` (`/host/events`)
   "carries the heartbeat messages", and `api/v2/asyncapi.yaml` lists only `heartbeatEvaluated` and
   `heartbeatStateChanged`. The corpus records an RFC as owed (TODO §8): admit registered-org vendor messages on
   `hostEvents`, or a host-event webhook variant. It is the same family as the `channel.presence` ephemeral-delivery RFC.
4. **The type names are not legal v2 names.** `declaration.json` `extensionsKeyPattern` is two segments (`^org.name$`), so
   `openwop-app.crm.contact-created` must become `openwop-app.crm-contact-created`.

**Why it matters more than a conformance nit:** v1 is retired on `app.openwop.dev` (2026-10-03), so every subscription is
major-2. Conforming by simply dropping host events from major-2 subscriptions would end host-event webhooks for every
user until something replaces them.

The `v2Ids.ts` comment that `hostext:` pseudo-ids "are not reachable on the v2 path space" is true of paths and false of
webhook bodies. That is why no projection test caught this.

## Decision (proposed)

> **CORRECTED 2026-10-05: RFC 0236 (host events) was Accepted on openwop main (`b0755dbb`, suite 2.45.21) the same
> day, and it supersedes the host-extension lane below.** Point 3 of the Context ("no legal home") is no longer true. The
> corpus seated runless vendor host events on the PROTOCOL surface, so this host implements that rather than inventing a
> parallel lane:
>
> - **Advertise** the `hostEvents` family with `types[]: [{ type, delivery }]`, using two-segment names
>   (`openwop-app.crm-contact-created`). `durable` types are persisted and webhook-eligible; `ephemeral` ones never are.
> - **SSE** on `/host/events`: `event:` is the type, and `data:` is `{ eventId, type, timestamp, delivery, workspaceId?, payload }`
>   with NO `runId` and NO `sequence`. A durable frame's `id:` is the `eventId`. Heartbeats on the same channel carry NO `id:`
>   (one would clobber the host-event resume point), and a host-wide liveness heartbeat is not tenant data.
> - **Webhooks**: a major-2 subscription's `events[]` may name an advertised durable type. The body is `{ hostEvent }`, never
>   `{ runId, event }`, and dedup is on `(OpenWOP-Webhook-Id, eventId)`. Signing, retries and dead-letters are unchanged, and
>   a host dead-letter record has no `runId` (`webhook-delivery` / `webhook-dead-letter-page` `oneOf`s).
> - **Tenancy**: every host event reaches only its own tenant's subscribers.
> - **Model**: openwop-examples #155 `src/host-events.ts` (the v2 reference host).
>
> **Evidence (from the corpus steward):** every `v2-host-event-delivery` leg drives the §G emit seam
> (`POST /conformance/seams/sample/host-events/emit`) with `example.*` types. A seam-free production revision therefore
> records the scenario as *inapplicable*, which is honest but is not evidence. A tier-2 cut needs the tagged seams
> side-revision advertising `example.thing-happened` (durable) and `example.thing-noticed` (ephemeral) beside the vendor
> types, plus `OPENWOP_TEST_TENANT_B_API_KEY` bound to a second tenant for the tenancy leg.
>
> **Revised plan:** P0, the suite pin 2.45.21 (#4448). P1, the advertisement and the `{ hostEvent }` webhook body, with
> two-segment names, a migration of existing subscriptions' `events[]` spellings, and a re-point of `crm-events`,
> `cms-host-event-binding` and `commerce-governance`. P2, the `/host/events` vendor frames. P3, the seams side-revision cut
> for tier-2 evidence. No host-extension lane is built. The text below is kept as the reasoning trail.


**Move host-event delivery to a host-extension lane, then stop sending host events on major-2 protocol subscriptions.**

- **Lane.** Host-event subscriptions live under `/host/openwop-app/host-event-subscriptions` (non-normative, no RFC). The
  delivery body is host-shaped, `{ tenantId, event: { eventId, type, payload, timestamp } }`, with no `runId`. It keeps
  today's signing (`OpenWOP-Signature`, `v1` scheme) and delivery queue (`webhook_deliveries`, retries, dead-letter), so
  receivers keep their verification code.
- **Names.** Host-event types on the new lane use the two-segment vendor spelling (`openwop-app.crm-contact-created`), so
  the names are already legal if the corpus later admits them on `hostEvents`.
- **Migration.** Existing major-2 subscriptions whose `events[]` name host events are copied to host-event subscriptions,
  with the same URL and secret, which keeps signatures valid. Each one is told once through the subscription-state event,
  and the protocol subscription stops receiving them.
- **Cut.** After the migration ships, `deliverHostExtEvent` no longer enqueues to protocol subscriptions at major 2. Major-1
  rows, if any survive P3, are unaffected until P3 deletes them.
- **When the RFC lands.** If the corpus admits vendor messages on `hostEvents`, the host also publishes there and this lane
  becomes the webhook projection of it.

## Alternatives

- **Keep sending `hostext:` envelopes.** That stays non-conformant (point 1), and the certification bundle should fail on
  it.
- **Mint a pseudo-run id.** Ruled non-conformant (point 2).
- **Drop host events from major-2 now, with no replacement.** That is conformant and breaks every host-event integration
  in production.
- **Wait for the corpus RFC.** That leaves the host non-conformant for an unknown time, and the RFC may choose a channel
  (SSE `hostEvents`) that does not replace push webhooks anyway.

## Implementation plan

1. **P1 — the lane.** Routes (CRUD, tenant-scoped, the same scope as webhooks), delivery through the existing queue, the
   host-shaped body, and the two-segment names. Tests port `crm-events`, `cms-host-event-binding` and
   `commerce-governance` onto the lane. Those three currently PIN the non-conformant major-2 delivery (ADR 0812 P2b-4,
   #4408).
2. **P2 — migration.** Copy the affected subscriptions, notify, measure the count on prod first.
3. **P3 — the cut.** No host events on major-2 protocol subscriptions. Add a witness that a major-2 delivery body always
   validates against `webhook-delivery.schema.json`, so the class cannot recur.
4. **P4 — SPA, CLI and docs.** Expose the lane where the webhook UI and `@openwop/cli` list subscriptions.

## Open questions

- [ ] Measure first: how many prod subscriptions name host events?
- [ ] Should `/host/events` (SSE) also carry them before the RFC? It is a protocol address, so probably not.
- [ ] Track the corpus RFC (TODO §8) and fold this lane into it when it lands.

## Implementation record

### P1 (+ the P2 compatibility half) — RFC 0236 on the protocol subscription, behind a flag

Branch `feat/adr0825-rfc0236-host-events`, off `chore/corpus-2.45.21` (which vendors the RFC 0236 schemas).

**The flag.** `OPENWOP_HOST_EVENTS_V2` (`true` / `1` / `on`; default OFF), read through ONE helper,
`hostEventsV2Enabled()` in `backend/typescript/src/host/hostEventTypes.ts`, on every call. With it off, every path
is byte-identical to before; `test/adr0825-host-events-flag-off.test.ts` pins the major-1 and major-2 bodies as
goldens CAPTURED from the pre-change `webhooks.ts`, and the golden reddens if the flag leaks into the off path.

**What the flag turns on.**

| Piece | Where |
| --- | --- |
| SSOT: every emitted host-event type, its two-segment v2 name, delivery class (all `durable`) | `src/host/hostEventTypes.ts` |
| `hostEvents` v2 family (`types[]` from the SSOT) | `src/routes/discovery.ts` `v2HostEventsFamily` |
| Major-2 webhook body `{ hostEvent }`, no runId; only to subscriptions whose `events[]` names the type | `src/routes/webhooks.ts` `deliverHostEventV2` / `fanOutHostEvent` |
| Registration refuses an ephemeral host-event type (`400 validation_error`) | `webhooks.ts` `assertNoEphemeralHostEventTypes` |
| Dispatcher mints `hev-<uuid>` (v2 `eventId` grammar) instead of `hev:<uuid>` | `src/host/hostEventDispatcher.ts` |
| `GET /host/events` SSE (major 2 only; `runs:read`; tenant-scoped; `Last-Event-ID`) | `src/routes/hostEventStream.ts`, `src/host/hostEventStream.ts` |

**Names.** One deterministic rule: drop `host.` (or `openwop-app.`), join the remaining segments with `-`, prefix
`openwop-app.`: `host.crm.contact.created` → `openwop-app.crm-contact-created` (the RFC's own example);
`crm.segment.entered` → `openwop-app.crm-segment-entered`. Injectivity is checked at module load (a clash throws at
boot) and in the test.

**Where the list came from.** The emit sites, not invention: every `emitHostEvent` call in `src/`, including the
`verb: string` template families (territories, sales-commissions, priority-matrix, strategy, dealers), whose verbs
were read off their call sites. 175 types. The test re-scans the emit sites (every literal must be listed, every
template prefix must be covered) and pins CRM/KB against `CRM_EVENT_TYPES` / `KB_EVENT_TYPES` both ways. Because the
template families take `verb: string`, a NEW verb at a call site is not caught by the scan; at runtime it is not
emitted on the v2 lanes (RFC 0236 §B "MUST NOT emit a host-event type it does not advertise") and is logged once per
process as `host_event_unadvertised_not_emitted`. Major-1 delivery of it is unchanged.

**Compatibility for existing subscriptions (the P2 half that needs no migration).** A major-2 subscription
registered before the flag names its types as `host.crm.contact.created` or `openwop-app.crm.contact-created` (ADR
0792). Both resolve to the advertised type, so those subscriptions keep receiving, now with the conformant body. A
subscription naming the type in two spellings gets ONE delivery.

### Decisions where the RFC text does not settle it (closest to the v2 reference host)

1. **`*` does not receive host events at major 2.** RFC 0236 §E and `webhook-delivery.schema.json` say the host
   body is sent "only to a subscription whose `events[]` names the host-event type". Today a major-2 `*`
   subscription receives them (in the non-conformant body). With the flag on it stops. **This is a behaviour change
   for `*` subscribers; measure how many exist on prod before turning the flag on** (the first Open question above covers
   it). Major-1 `*` is unchanged.
2. **Unadvertised names are not refused at registration.** §E says an "unadvertised" host-event type MUST be
   refused. This host cannot tell an unadvertised host-event name from a vendor RUN-event name under the same org,
   and the v2 reference host (`webhooks.ts` `registerWebhook`) also admits any registered-org vendor name. Only an
   advertised EPHEMERAL type is refused; none is advertised today, so the refusal is proven with an injected lookup.
3. **No `workspaceId`.** Host events carry a tenant and no workspace; `identity.md` §1 forbids substituting the
   tenant, so the field is omitted.
4. **`eventId`.** `hev:<uuid>` is not in the `ids.schema.json` `eventId` grammar (`:`). Under the flag the
   dispatcher mints `hev-<uuid>`, so the webhook body, the SSE frame and `run.metadata.hostEvent.eventId` (ADR 0208
   correlation) carry one id. A `hev:` id minted before the flag flipped is projected `:` → `-` in the envelope.
5. **Cross-instance SSE.** The reference host is one process; this host is not. Live frames ride the storage
   pub/sub (Postgres LISTEN/NOTIFY, the Kanban feed's seam) so a client on any instance sees every event. Retention
   for `Last-Event-ID` is an in-memory ring (1000) per process, filled from that subscription: an instance started
   after an event cannot replay it (the RFC's resume rule is a SHOULD "within retention"). An unauthenticated caller
   gets the open comment and heartbeats only, like the reference host.
6. **Heartbeat.** The channel's keep-alive is the shared `: heartbeat` SSE comment, which has no `id:`. This host
   does not advertise `heartbeat`, so it emits no `heartbeat.evaluated` messages.
7. **Dead letters.** The v2 dead-letter page (`GET /webhooks/{webhookId}/dead-letters`) is not served by this host,
   and the operations summary projects no `runId`, so there was nothing to change. When the page is built, a
   host-event row must use the `deadLetteredHostDelivery` branch (no `runId`).

### Not done (follow-ups)

- ~~**Turning the flag on in prod**~~ — done 2026-10-07: the subscription census
  (`scripts/host-event-subscription-census.mjs`) counted 0 webhook subscriptions of any kind on prod, read through the
  same `openwop-storage-dsn@latest` secret the service binds. Flipped with `update-env.sh` (rev 00910-k26, same commit),
  advertising 175 durable types.
- ~~§G conformance seam~~ — done, see § §G emit seam below.
- ~~**Host-event bindings**~~ — done #4561: the dispatcher also matches the advertised two-segment type. #4578 then made
  the binding route accept every catalogued spelling (`crm.segment.entered` had been refused).
- ~~**SPA / CLI**~~ — done #4578: `GET /host/openwop-app/host-events/catalog` serves the SSOT and the bindings page reads
  it; the hand-kept `hostEventCatalog.ts` and its parity baseline are retired. The CLI's `/v1/host/...` literals already
  resolve through the advertised `extensions` root (measured: `openwop host-events list` against prod, exit 0).
- ~~**Production evidence**~~ — see § RFC 0241 below. Without it every RFC 0236 row is `inapplicable` on prod, which
  serves no seams (2.45.25 cut on ff77747c9: all 7 rows inapplicable, none failed).
- **Durable retention across restarts** (a stored ring) if `Last-Event-ID` across deploys matters.

### §G emit seam (2026-10-05)

`POST /conformance/seams/sample/host-events/emit` (`emitHostEvent`) is served by `routes/hostEventEmitSeam.ts` at its
v1 address `/v1/host/sample/host-events/emit`, reached through the existing `sample/` alias in
`routes/conformanceSeams.ts`, and listed in `SEAM_OPERATIONS` (`served: true`, not floor). It sits behind the same gate
as every seam here: `OPENWOP_TEST_SEAM_ENABLED !== 'true'` answers `404 not_found` (a route-miss).

- **The `example.*` pair.** `example.thing-happened` (durable) and `example.thing-noticed` (ephemeral), the reference
  host's names, are advertised in `hostEvents.types[]` only while the seams profile is mounted (`seamsFloorServed()`,
  the predicate behind `conformance.seamsProfile`) AND the flag is on. No production emitter produces them.
- **One path.** The seam builds the envelope with `hostEventEnvelope` and hands it to `fanOutHostEvent`, the fan-out a
  CRM event takes: the stream for both classes, webhooks only for the durable one, scoped to the caller's tenant.
- **`workspaceId`** in the seam body is refused `400`, because this host's host events carry no workspace (decision 3).
- **Measured.** The suite's own `v2-host-event-delivery.test.ts` (suite 2.45.21), run in-process through
  `conformance/run.ts` with `OPENWOP_HOST_EVENTS_V2=true`, `OPENWOP_TARGET_MAJOR=2` and only that file: 6/6 passed,
  RFC 0148 dispositions `executed-pass 7`, nothing inapplicable or blocked (the tenant leg ran against the lane's
  tenant-B key). The runner takes no file argument, so the single-file run used a temporary local edit to `run.ts` that
  was reverted and is not committed.
- **Pin-bump gap fixed beside it.** `snapshotChannelPresence` (in `api/seams-v2.yaml` at 2.45.21) was missing from
  `SEAM_OPERATIONS`, which reddened `test/v2-conformance-seams-mount.test.ts` on the pin branch. It is now listed
  `served: false` (this host does not advertise `channelPresence` at major 2), so the alias answers 404 for it.
- **Not done.** The conformance lane does not set `OPENWOP_HOST_EVENTS_V2`, so a normal `npm run test:conformance`
  records the scenario `inapplicable`. Turning it on in the lane is a separate decision.


### Corpus guidance on `*` (openwop-5e, 2026-10-06)

v2 has NO wildcard. `webhooks.md` §Surfaces says `events[]` MUST be "non-empty v2 event type names", and
`api/v2/openapi.yaml` types it as event-type strings. So a `*` subscription is already this host's extension at major 2,
and RFC 0236 does not govern it. §E's opt-in rule exists so that a subscriber never receives the new `{ hostEvent }`
body unasked.

**Recommended, and the plan for flag-on:** keep `*` meaning RUN events only, so existing `*` subscribers see no new body
shape. CRM, CMS and commerce consumers name their host-event types explicitly, as one migration step (tell the affected
subscribers, or rewrite their `events[]` to the explicit two-segment types with their consent). Expanding `*` to host
events is defensible, but it silently changes what a live subscriber receives, which is exactly what §E avoids. The
suite's legs are unaffected either way, because they register explicit types.

### RFC 0241 — the production test trigger (2026-10-08)

RFC 0241 (`Active`, openwop #1945) gives a seam-free host a normative way to cause a host event:
`POST /host/events/test` (`emitTestHostEvent`, `webhooks:manage`) emits one empty event of a reserved type,
`host-test.durable-triggered` or `host-test.ephemeral-triggered`, to the caller's tenant. Listing a type binds the
operation (§B.1). It passes the CLAUDE.md three-part test: §A–§C are merged (shape locked), nothing gates
advertisement, and this host can honour it through its ordinary path.

| Item | Where |
| --- | --- |
| The contract decides: the reserved types are listed only when the VENDORED `schemas/v2/path-manifest.json` defines the path, so the trigger lights up with the corpus pin bump (2.45.26+) and never ahead of it. Same rule as the v2 reference host (openwop-examples #160). | `host/hostEventTestContract.ts` |
| One reserved-entry list (`activeReservedEntries`: `example.*` under seams, `host-test.*` under the contract) feeds discovery, subscription matching and the ephemeral-registration refusal, so they cannot disagree. | `host/hostEventTypes.ts` |
| The route: `404` unless a `host-test.*` type is listed; `401` without a caller; closed body; same `hostEventEnvelope` → `fanOutHostEvent` as every host event; `202 { eventId, type }`. | `routes/hostEventTestTrigger.ts` |
| Witness: listing, durable to the caller's stream (`id:`) and webhook, ephemeral to the stream only (no `id:`), empty payloads, nothing to a second tenant, the refusals, and `404` with the contract off or `hostEvents` off. The real predicate is pinned to the vendored manifest so the mock cannot drift. Sabotage: a non-empty payload reddens the durable leg; dropping the §B.1 gate reddens both unbound legs. | `test/adr0825-rfc0241-test-trigger.test.ts` |

**Decisions where the RFC leaves room.** (1) `workspaceId`: this host's host events carry no workspace (decision 3
above), so another tenant's is `403 id_tenant_mismatch` and the caller's own is `404 not_found` — §B.4's "unknown" —
never a silent drop. The suite sends `{ delivery }` only. (2) §B.5's rate limit is the existing per-IP WRITE budget
(`middleware/rateLimit.ts`), which already applies to this POST and is tighter than reads. (3) The reserved types are
also bindable to workflows through the binding route, like any listed type; §A.2 constrains emission, not consumption.

**What remains:** the corpus pin bump to 2.45.26+ (which syncs the manifest and turns the trigger on), then a prod cut.
That cut is RFC 0236's tier-2 witness and RFC 0241's `Accepted` criterion.

> **CORRECTED 2026-10-08 — pin bump done; decision (2) was half the story.** RFC 0241 is now `Accepted` (openwop
> #1953). The corpus pin moved to **2.45.28** (`@openwop/openwop-conformance` + `@openwop/spec-artifacts`, the
> vendored schemas/fixtures at `v2.45.28`), so the vendored manifest now defines `/host/events/test` and the trigger
> is ON. §B.5 also says `Idempotency-Key` "is honoured as on other POSTs". The route did not read it, and
> `idempotency.md` Layer 1 is a MUST for every mutating operation. It now goes through the ADR 0549 ledger
> (`IdempotentEndpoint` `'POST:/host/events/test'`, the one owner `POST /runs` uses). The claim is taken after
> validation and the tenant check, because `400 validation_error`, `401` and `403` must not be cached. The `202` and the
> workspace `404` replay with `OpenWOP-Idempotent-Replay: true` and never emit a second event. A different body is
> `409 idempotency_key_mismatch`, and a concurrent duplicate is `409 idempotency_in_flight`. Witnessed in
> `test/adr0825-rfc0241-test-trigger.test.ts` (replay, mismatch, uncached 400, per-tenant keyspace). Sabotage:
> dropping the replay branch reddens the replay leg. **Remaining:** deploy, then a prod major-2 cut with
> `OPENWOP_TEST_TENANT_B_API_KEY`. The bundle goes to openwop-e2 as RFC 0236's tier-2 evidence.
