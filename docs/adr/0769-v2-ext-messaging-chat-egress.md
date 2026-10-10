# ADR 0769 — v2 ext `messaging`: relay chat egress on `ctx.messaging`

Status: implemented

Builds on ADR 0765 (the v2 extension-family records) and ADR 0619 (the egress
send-ledger). No RFC: `spec/v2/ext/messaging/` is a discovery-only reservation
(`claims-check` witness, RFC 0144/0220). The record is organization-defined and
this ADR changes no wire contract.

## Context

The steward asked for a second witness on the ext families this host can
honestly execute. `messaging` names "outbound chat-egress dispatch through
host-owned connectors". This host has that service: the relay gateway
(`routes/messaging.ts`, `enqueueOutbound`), where a registered relay device pulls
queued egress and acks it. What it lacked was the node-context half.
`vendor.myndhyve.entities` `messaging.chatSend` / `messaging.chatReply` and
`core.openwop.integration.chat-message-generic` all call
`ctx.messaging.dispatchEgressEnvelope`. The executor's `ctx.messaging` was the
SMS adapter alone, so every one of those nodes failed `HOST_CAPABILITY_MISSING`.

## Decision

1. **One owner of `ctx.messaging`.** `host/chatEgressAdapter.ts`
   `makeMessagingAdapter` composes the SMS adapter with a new
   `dispatchEgressEnvelope`. The executor wires that one object, so there is no
   second messaging surface and `sendSms` is unchanged.
2. **Relay binding is tenant-checked.** `connectorInstanceId` (or
   `envelope.accountId`) names a relay device. The device must belong to the
   run's tenant. A foreign relay and a missing one both return
   `connector_not_found`, so a pack cannot probe other tenants' relay ids. A
   revoked device returns `connector_revoked`. The device's channel is
   authoritative: an envelope naming another channel returns `channel_mismatch`.
3. **The host derives the dedup key.** The packs build `idempotencyKey` with
   `Date.now()`, so it changes on every attempt and cannot dedup anything. The
   host ignores it and hashes `(runId, nodeId, relayId, conversationId,
   inReplyTo, text, media urls)`. It then reserves, enqueues and records in the
   ADR 0619 `egress:sent` ledger under the new channel `chat`. A failed enqueue
   releases the reservation, so a retry re-sends. A replay `:fork` never reaches
   the adapter: `messaging.chatSend`, `messaging.chatReply` and
   `chat-message-generic` are all in the ADR 0341 served set.
4. **Failures are results.** Every refusal returns
   `{ success:false, error:<stable code> }`, never a throw. Success returns
   `{ success:true, messageId:<egr_…>, relayId, deduplicated? }`.
5. **Claim the family.** `EXT_FAMILY_CLAIMS` gains `messaging` with
   `wiring: 'adapter'`. Its record probes `makeMessagingAdapter`, not the
   surface bundle. `unavailable` names the pack's two `ctx.entities` nodes, which
   still cannot run here.

### Still withheld: `entities`

`ctx.entities.createProject({ canvasTypeId, type, status, settings })` /
`getAsset({ assetType, assetId })` / `listAssets({ assetType, filterConfig })`
assume a MyndHyve canvas-project model with an open-ended asset registry. This
app has org-scoped projects with no canvas type, and no generic asset store keyed
by `assetType`. Any mapping would invent semantics the pack's authors did not
define. `brand` (dynamic `ctx.brand[op]` plus `ctx.aiEnvelope` generators),
`data-integration`, `coordination` and `a2ui-surface` stay as ADR 0765 left them.

## Alternatives weighed

| Option | Why not |
|---|---|
| A separate `ctx.chatEgress` surface | The packs call `ctx.messaging`, and a second messaging owner is the parallel-system smell |
| Honour the pack's `idempotencyKey` | It embeds `Date.now()`: every retry double-sends |
| Different errors for foreign vs missing relays | Leaks another tenant's relay ids |
| Map `entities` onto `projectsService` | No `canvasTypeId` or asset registry here; a claim would say the pack works when it does not |

## Tests

- `test/adr0769-chat-egress-adapter.test.ts` drives the real pack functions. It
  covers enqueue plus mapping (media, `inReplyTo`); retry dedup despite the
  pack's `Date.now` key; distinct runs and distinct content; foreign equals
  missing; revoked; channel mismatch; and that the SMS half is kept.
  Sabotage-checked: dropping the tenant check reds the IDOR test, and honouring
  the pack key reds both dedup tests.
- `test/adr0765-ext-family-records.test.ts`:
  - The contract pin now also matches `ctx.<surface>?.<m>`.
  - It refuses a claimed pack that dispatches `ctx.<surface>[op]` dynamically,
    because a computed call names no method the pin can see.
  - Adapter-wired claims pin the executor's `messaging: makeMessagingAdapter(` hand-off.
  - `messaging` has moved from the withheld list to the claimed list.
