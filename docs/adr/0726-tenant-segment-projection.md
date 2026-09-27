# ADR 0726 — The tenant segment of a bound id is projected onto the corpus grammar; the SPA projects bound path parameters

Status: Accepted — implemented (Phase E of the v2 gap-closure plan)
Date: 2026-09-17
Relates to: ADR 0629 (tenant-bound run ids), ADR 0647 (SPA v2 seam), ADR 0704 (anon tenants stay unbound), ADR 0723 (five bound kinds), ADR 0725, RFC 0184, `spec/v2/core/identity.md` §5.

## Context — two production defects, one measurement

The Phase E payload audit (full suite, corpus 2.3.3) left 128 wire violations,
and **120 of them were one fact**: this host's personal-workspace tenant ids are
`user:<sha256[:32]>` (`middleware/auth.ts` `tenantIdFromOidc` /
`personalTenantForSubject`), and `identity.md` §5 row 106 types `tenantId` as
`^[A-Za-z0-9._~-]{1,128}$` — no `:`. Every signed-in user lands in such a
workspace. Org workspaces mint `org-<uuid8>`; the conformance suite runs under
`default`; so no scenario had ever exercised a tenant outside the grammar.

- **Emit (silent fail-open):** `host/v2Ids.ts` `toWireRunId` returned the id
  BARE whenever the tenant failed the grammar, so every bound kind (runId,
  interruptId, subscriptionId, effectId, childRunId, …) left unbound on
  `res.json`, SSE and the webhook fan-out for every personal workspace, and
  `run.started.owner.tenant` / `owner.subject.tenant` carried the raw `user:…`.
- **Accept (403):** `fromWireRunId` grammar-checked the tenant SEGMENT and
  refused `user:x/<opaque>` as `id_tenant_mismatch`.
- **Path (404, measured in production):** the SPA pins SDK 2.0.0, which
  percent-encodes the bound id; the Firebase `/api` rewrite normalises `%2F`
  back to `/` before Cloud Run sees the request, so `/api/runs/user:x/<id>`
  routed as `runs/:runId = user:x` and answered **404** — 40 such reads in
  three days, every one a personal workspace. This is the intermediary rewrite
  RFC 0184's `~`-projection exists for, and the SDK does not project.

## Decision

1. **The wire form of a tenant segment is the RFC 0184 byte-escape of the
   storage form** (`user:x` → `user~3Ax`), applied by `toWireTenant` inside
   `toWireRunId` and to every schema-typed plain tenant field
   (`V2_TENANT_FIELD_KEYS`, derived from `$ref …#/$defs/tenantId`: `tenant`,
   `tenantId`). `~` is inside the grammar, the escape is injective and
   reversible, and `identity.md` §5 says a `tenantId` is host-minted and
   opaque — the wire spelling being a projection of the storage spelling is
   within the host's remit and claims nothing on the wire. **No RFC.** If the
   corpus later admits `:` the projection becomes the identity for that byte.
2. **The accept path compares tenants after decoding and grammar-checks only
   the opaque half.** `fromWireRunId` accepts `user~3Ax/<opaque>`, the
   `~`-projected whole segment, AND the raw `user:x/<opaque>` an SDK sends when
   it binds with the host-ext `.active` value — a tolerance with the same
   expiry as the bare-form affordance (`identity.md` §5, overlap only).
3. **The middleware's op split is trailing-only.** `/runs/{id}:fork` was split
   at the FIRST colon, which sliced `user:x/<id>` at `user`; it now recognises
   only a trailing `:<op>`.
4. **The SPA projects bound PATH parameters** (`client/v2Wire.ts`
   `projectBoundId`, byte-for-byte the host codec) at its one seam:
   `bindRunId` returns the `~`-form for the SDK's path parameter;
   `bindRunIdValue` returns the unprojected value for a body field. Every
   `%2F` assertion in the client tests flipped to `~2F`.
5. **`anon:` tenants stay unbound** — ADR 0704's decision is untouched;
   `toWireTenant` passes them through unprojected so the grammar gate refuses
   them exactly as before.

## Alternatives weighed

- **Wait for the corpus to admit `:`** (raised on the bus, `0652`): the honest
  wire is broken in production today, the fix is host-internal, and it is
  reversible — so it ships now; the steward decides 2.4.0 independently.
- **Re-mint personal tenants inside the grammar:** a tenant id is a storage
  key across every collection; a rename is a migration of everything.

## Consequences

- Two spellings of one tenant exist across dialects: `user:x` on host-ext (v1)
  surfaces, `user~3Ax` on the major-2 wire. Bounded: bijective, and the v1
  dialect retires on the clock.
- A consumer that pattern-matches tenant ids must accept `~`; the corpus
  grammar already does.
- Production personal workspaces regain `GET /runs/{id}` (and annotations,
  fork, cancel, poll) through `/api`, and their bound ids validate.

## Implementation record

| Change | File | Witness |
|---|---|---|
| tenant codec, tolerant accept, tenant-field projection | `host/v2Ids.ts` | `test/adr0726-tenant-segment-codec.test.ts` |
| trailing-only op split | `middleware/v2Identity.ts` | `test/adr0726-personal-tenant-http.test.ts` (create binds projected; `~` and raw segments resolve; foreign 403; `owner.tenant` grammar-valid on the events read) |
| SPA path projection | `client/v2Wire.ts`, `v2Clients.test.ts`, `v2Wire.test.ts` | path form `~2F`, never `%2F`; personal tenant projects; wire-returned projected ids unbind |
| host-derived trigger subscription ids inside the opaque grammar — `host-kanban-<boardId>` / `host-connections-<connectionId>` (were `host:kanban:…` / `host:connections:…`, unbindable on the wire); a legacy-spelled row is moved on first use (`rekeySubscription`, the migration-21 pattern) | `host/triggerBridgeService.ts` `hostDerivedSubscriptionId` / `registerHostDerivedSubscription`, `routes/kanban.ts`, `features/connections/inboundWebhooks.ts` | `test/adr0726-host-derived-subscription-ids.test.ts` |
| the payload audit records each sample's run tenant and classifies two error classes as informational: a bound-kind value whose opaque half a FIXTURE minted outside the grammar, and an `anon:` run (bare by ADR 0704's decision) — everything else on a bound key still gates | `storage/eventPayloadAudit.ts`, `storage/eventEraAdapter.ts`, `scripts/audit-event-payloads.mjs` | measured 2026-09-17: 797 → 128 → 30 → (gated) 14 wire errors across the three Phase E runs |

## Open items

- Ask the steward for a `v2-personal-tenant` scenario leg (a run created under
  a tenant that is not `default`, read back bound) — every bound-id scenario
  runs under the one tenant whose id happens to fit.
- Retire the raw-spelling tolerance (2) with the v1 overlap.
