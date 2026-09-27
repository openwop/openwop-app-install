# ADR 0723 — Every tenant-bound id KIND rides the major-2 wire bound

Status: Accepted — implemented (Phase B of the v2 gap-closure plan)
Date: 2026-09-17
Relates to: ADR 0629 (run ids tenant-bound on major 2), ADR 0647 (SPA v2 seam), ADR 0702 (envelope-id projection), ADR 0722 (Phase A wire hygiene), RFC 0184 (`~`-escape bound-id path projection), `spec/v2/core/identity.md` §5.

## Context

`identity.md` §5 names **five** tenant-bound id kinds — `runId`, `interruptId`,
`subscriptionId`, `deliveryId`, `effectId` — each `<tenantId>/<opaque>` on the
major-2 wire and `x-openwop-minted: host`. This host projected **one**.

Measured at corpus tip `bad44bb2` with a parsed walk over `schemas/v2` (a grep
with `\$defs` inside double quotes returned zero for every kind including
`runId`, which is how the plan briefly scheduled an RFC gate for a host defect):

| kind | `$ref`'d under keys | where |
|---|---|---|
| `runId` | `runId`, `parentRunId`, `sourceRunId`, `sourceRunIds`, `contributingRunIds`, `childRunId`, `baselineRunId`, `enqueuedRunId`, `evalRunId` | everywhere |
| `interruptId` | `interruptId` | `interruptResolved`, `nodeSuspended`, `nodeResumed` |
| `subscriptionId` | `subscriptionId`, `triggerSubscriptionId` | `triggerDeliveryAttempted`, `triggerSubscriptionStateChanged`, trigger-event / trigger-subscription |
| `deliveryId` | `deliveryId` | trigger-event |
| `effectId` | `effectId` | 5 `compensation*` defs, effect-ledger-projection |

Fourteen bound keys; **no key is bound to two kinds.** `host/v2Ids.ts
deriveRunIdKeys()` walked exactly these `$ref`s but matched only the suffix
`#/$defs/runId`, so the other four kinds went out **bare** on every major-2
channel — `res.json` (`protocolVersion.ts:593`), the REST transport, SSE
(`streams.ts:83,195`) and the webhook fan-out (`webhooks.ts`). On the accept
side `middleware/v2Identity.ts` unbound only `/v1/runs/<seg>`; `/webhooks/:id`
and `/trigger-subscriptions/:id` read `req.params` raw, so the moment the host
emits a bound `subscriptionId` a conformant client echoing it back gets a 404
— RFC 0184 leg 1 on a second kind.

Suite 2.2.1 has **zero** v2 scenarios naming `interruptId`; a green suite proved
nothing here. Every mint is already opaque-grammar-safe (`randomUUID()`,
`randomBytes(16).hex`, `dlv-<uuid>`, sha256-hex slices), so no id needs re-minting.

**No RFC.** The wire shape is the spec's; this is the host honouring it.

## Decision

1. **ONE key set, all five kinds** (`host/v2Ids.ts`): the walker matches
   `ids.schema.json#/$defs/(runId|interruptId|subscriptionId|deliveryId|effectId)`;
   the floor grows to the seven keys everyone has; the set is exported as
   `V2_BOUND_ID_KEYS` (`V2_RUN_ID_KEYS` kept as the same reference). Because no
   key maps to two kinds, one set is correct and five would only add a way to
   drift; the SPA parity test asserts the no-collision property so the day the
   corpus binds a key twice the test names it before a projection is wrong.
   `toWireBoundId` / `fromWireBoundId` are exported as kind-agnostic names of
   the existing functions — the projection never depended on the kind.
2. **Accept path on three prefixes** (`middleware/v2Identity.ts`): `RUN_PATH`
   becomes `/v1/(runs|webhooks|trigger-subscriptions)/<seg>`. The `~`-escape
   decode, the `%2F` form, the colon-op split, the 403 `id_tenant_mismatch`
   refusal and apply-once (RFC 0184 §A.5) all come for free — they were never
   run-specific. `/interrupts/:token` is deliberately **excluded**: a resume
   token (`identity.md` §4), not a bound id. Handlers keep reading
   `req.params.subscriptionId` and see the bare id they always saw.
3. **SPA predicate widened at the one seam** (`client/v2Wire.ts`): `isRunIdKey`
   → `isBoundIdKey` (alias kept) covers the five kinds; `unbindRunIds` uses it.
   The derivation-parity test now walks every kind with a per-kind non-vacuity
   floor. `interruptsClient.inspectByToken` — the one SDK read outside
   `runsClient` — is routed through `unbindRunIds` (the type carries no bound
   id today; the seam is so a field the corpus adds is unbound the day it
   appears). `listOpenInterrupts` and the operations client fetch
   `/host/openwop-app/*` **without** a version header (v1 dialect, RFC 0181), so
   the `interruptId` equality at `workflowRunSubscription.ts:341` and
   `NotificationsPage.tsx:525` compares bare-to-bare on both sides.

## Alternatives weighed

- **Five sets / five projectors** — rejected: nothing distinguishes the kinds
  at the projection (same grammar, same tenant, same escape); five sets is five
  places to forget one.
- **Per-route `fromWireBoundId` in the handlers** — rejected: the middleware is
  the single owner of the decode + 403 rule; a handler-level copy is the
  "shared-helper drift" shape (ADR 0629 put it in the middleware for that reason).
- **Re-mint bound ids at birth** — rejected: ADR 0629's decision stands (project
  at the boundary; storage keeps bare ids; major 1 untouched).

## Consequences

- Major-2 clients now see `interruptId`, `subscriptionId`, `triggerSubscriptionId`,
  `deliveryId`, `effectId` as `<tenant>/<opaque>` on every channel, and may echo
  a bound `subscriptionId` back on `/webhooks/…` and `/trigger-subscriptions/…`.
- `webhookId` (the webhooks.md Register-response field) is **not** `$ref`'d to a
  kind and stays bare — pinned by test so the SDK never sees two spellings.
- Major 1 is byte-identical to before.
- Host-extension surfaces (`/host/openwop-app/*`) are unaffected: they run in
  the v1 dialect and the SPA reads them without a version header.

## Implementation record

| Phase | Change | Witness |
|---|---|---|
| B.1 | `host/v2Ids.ts` — five-kind `BOUND_KIND_REF`, floor, `V2_BOUND_ID_KEYS`, kind-agnostic aliases | `test/adr0723-bound-id-kinds.test.ts` (set ⊇ 5 non-run keys, `webhookId` excluded, effectId doc projection) |
| B.2 | `middleware/v2Identity.ts` — three-prefix accept path | same file: webhooks `~`/`%2F`/foreign-tenant-403/test-route legs; trigger-subscriptions register→read→ingest→deliveries leg |
| B.3 | `client/v2Wire.ts` `isBoundIdKey`; `interruptsClient.inspectByToken` seam | `client/__tests__/v2Wire.test.ts` five-kind parity + per-kind floor + no-collision |
| B.4 | interruptId on the events read | `adr0723-bound-id-kinds.test.ts` node.suspended leg (bound on `/runs/{id}/events/poll` under major 2, bare on `/v1`) |

## Open items

- `effectId` has no in-repo HTTP producer to drive end-to-end (compensation
  ledger reads are host-ext); covered at the projection unit only.
- The webhook fan-out's `webhook.test` event carries `runId: 'webhook-test'`
  (not a run) and is projected like any other — pre-existing, unchanged here.

> **UPDATE 2026-09-18 — the `webhookId` decision FLIPS at corpus 2.4.0.** The
> steward filed **RFC 0187 §A** (bus `4f4b`): `webhookId` IS the
> `subscriptionId` kind. The mint surface had inherited v1's bare
> `type: string`, so "the kind had no HTTP surface and the HTTP surface had no
> kind" — which is the reading recorded below, correct for 2.3.3 and wrong from
> 2.4.0 on. At that pin: `api/v2/openapi.yaml` `$ref`s the kind on the path
> parameter and the register response, `trigger-subscription.schema.json` binds
> it, `id-field-bindings.json` moves it out of `notAKind`, and the bare form
> rides the overlap on a `v1-end-of-support` deprecation row. The test
> expectation in `adr0723-bound-id-kinds.test.ts` inverts with it.
>
> Also from that thread, and now witnessed here: a foreign tenant's id must be
> `403 id_tenant_mismatch` **even when it does not exist**. The reference host
> looked the id up first and answered `404` for a nonexistent foreign id, which
> leaks "no such row" across a tenant boundary. This host checks the tenant in
> `middleware/v2Identity.ts` before any handler runs, so the ordering is right by
> construction — the new leg pins it, with a same-tenant 404 control so the 403
> is the tenant rule firing rather than a blanket refusal.
