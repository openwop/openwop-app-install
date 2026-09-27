# ADR 0658 — RFC 0182 `listRuns`: `GET /runs` under major 2 is the protocol run list, advertised as `runList`

Status: Accepted (implemented in this PR)

## Context

Suite 2.1.0/2.1.1 (RFC 0182, `Active`) added the first 2.x minor operation:
`GET /runs` (`listRuns`) — the caller's runs newest first, tenant-scoped by
construction with every `runId` bound, `limit` clamped to the advertised
`runList.maxPageSize`, an opaque host-minted `cursor` (a cursor the host did
not mint is `400 validation_error`), and `workflowId` / `status` exact filters
when `runList.filters` names them. It is OPTIONAL and gated on the new core
family `runList` (`404 not_found` when unadvertised).

Two host facts made it the next unit rather than a later one. First, `GET
/runs` became a **manifest-named operation** in 2.1.0, and this host's v1
host-extension list (ADR 0654's vendor twin) was still answering it under
major 2 through the rewrite — a claim contradiction the moment 2.1.1 was
pinned (#3736). Second, the SPA needs a run list; the steward's `cc6c` ruling
placed the host-extension list under `/host/openwop-app/runs` for the overlap
and named the protocol list as the interop gap RFC 0182 closes.

## Decision

1. **Storage: a keyset cursor, not an offset.** `Storage.listRuns` gains
   `before?: { createdAt, runId }`; both adapters order `created_at DESC,
   run_id DESC` (the tie-break makes the order total) and filter
   `created_at < before OR (created_at = before AND run_id < before.runId)` —
   the Postgres predicate casts `$5::timestamptz` (a text compare is the
   sqlite-masks-Postgres class). Every existing caller is unchanged.
2. **One owner for the facets.** `host/runList.ts` holds `RUN_LIST`
   (`maxPageSize: 100`, `defaultPageSize: 50`, `filters: ['workflowId',
   'status']`); `routes/discovery.ts` advertises it and `routes/runs.ts`
   enforces it, so the wire claim and the behaviour cannot drift (ADR
   0435/0440). The record is `status: experimental, since: '2.1', until:
   '2.2', witness: witnessable-gated`.
3. **The cursor is signed.** `mintRunListCursor` / `parseRunListCursor` sign
   the last item's `(createdAt, runId)` with the session secret
   (`readSessionSecret`, the `runStreamToken` precedent); malformed, foreign
   or tampered cursors parse to `null` and the route answers `400
   validation_error { field: 'cursor' }`. That is the whole point of "a cursor
   the host did not mint": an unsigned keyset would let a caller compose one.
4. **The handler branches on the contract, not on a new route.** Inside the
   existing `GET /runs` registration, `negotiatedMajor(req) === 2` takes the
   RFC 0182 path: tenant = `req.tenantId` (scoped by construction; no
   `tenantId` query, no wildcard), closed snapshots via `closeV2Snapshot`, ids
   bound by the v2 response projector, `limit` validated (positive integer)
   and clamped, `nextCursor` minted only when the page is full. The v1 path
   and the vendor twin keep the host-extension list exactly as before.

## Consequences

- `v2-run-list` runs in the major-2 lane (3 legs) instead of recording
  `inapplicable`; the bundle's `runList` row becomes executed.
- The SPA's `listMyRuns` can move from the vendor list to SDK 2.1.0
  `runs.list` in a later unit; the vendor twin retires with `/v1`.
- **CORRECTED 2026-09-11 (steward ruling, crosstalk `5d9b`) — this bullet was
  wrong, and it shipped wrong.** It claimed `since: '2.1'` was "the corpus's
  own convention for a family introduced in a later minor". There is no such
  convention: `spec/v2/declaration.json` publishes `witness` and `maturity`
  per family and **no `since`**, so there is nowhere to copy a corpus value
  from — a field with no source is a host claim, like its neighbours `status`
  and `until` (which absorb v1's `tier`/`experimentalUntil`, the host's own
  stability claim). And `since` carries the axis-1 grammar, the same grammar
  as `protocolVersions[]` members, so `2.1` on a host advertising
  `["1.1","2.0"]` put two adjacent fields on two different timelines. The
  record now uses the host's own `SINCE` / `EXPERIMENTAL_UNTIL` constants
  (`2.0` / `2.1`) like every other experimental family here. `status` stays
  `experimental` despite RFC 0182 being Accepted: v1's "drop the marker on
  acceptance" rule did not carry into v2 (82 of 85 declared families are
  experimental). The route test now asserts `protocolVersions` contains
  `runList.since`, so the corpus-timeline value is unshippable rather than
  merely noticed — I wrote "the one line to move" and then needed an outside
  ruling to move it, which is the argument for pinning it in a test.

## Implementation record

| what | where |
|---|---|
| `before` keyset in the interface + both adapters (`timestamptz` cast on Postgres) | `src/storage/{storage,sqlite/index,postgres/index}.ts` |
| facets + signed cursor | `src/host/runList.ts` |
| major-2 branch of `GET /runs` | `src/routes/runs.ts` |
| `runList` family record | `src/routes/discovery.ts` |
| keyset paging test (disjoint, complete, tie-break, tenant-scoped, honest end) | `test/storage-list-runs-keyset.test.ts` |
| route test (advert = handler, closed envelope + bound ids + paging, foreign/tampered cursor 400, limit clamp/refusal, filters, v1 twin untouched) | `test/adr0655-run-list.test.ts` |

Sabotage-verified: removing the cursor signature check reddens exactly the
foreign-cursor leg (4 others pass).
