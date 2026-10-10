# ADR 0765 — claim the v2 extension families this backend executes

Status: implemented

## Context

`spec/v2/core/capabilities.md` §3.2 advertises an extension family as
`extensions["<org>.<extensionName>"]`. RFC 0220 graduates the discovery-only
families on evidence; its witness is the suite's `v2-ext-family-claims`
(claims-check, suite ≥ 2.42.7) plus `v2-ext-rest-transport` (behavioural). The
corpus steward asked this host for a second witness (openwop #1673 / #1690),
with one rule: **only claim what the backend executes**, name what serves each
claim, and fail a test if the named thing disappears (the pattern of
myndhyve #513).

This host vendors a `vendor.myndhyve.<family>` node pack for most families. The
honest test of "executes" is therefore: the executor wires the node-context
surface the pack calls, and that surface implements every method the pack calls.

## Decision

Claim seven families, each as a record registered through the existing
`registerV2Extension` seam (`host/extFamilyRecords.ts`):

| Record | Served by | Notes |
| --- | --- | --- |
| `openwop-app.canvas` | `ctx.canvas` (`vendor.myndhyve.canvas`) | |
| `openwop-app.chat` | `ctx.chat` (`vendor.myndhyve.chat`) | |
| `openwop-app.kanban` | `ctx.kanban` (`vendor.myndhyve.kanban`) | `task.decompose` unavailable (needs `ctx.aiEnvelope`) |
| `openwop-app.knowledge` | `ctx.knowledge` (`vendor.myndhyve.knowledge-tools`) | |
| `openwop-app.launch-studio` | `ctx.launchStudio` (`vendor.myndhyve.launch-studio`) | `demoData: true` (seeded studio) |
| `openwop-app.web-research` | `ctx.webResearch` (`vendor.myndhyve.web-research`) | synthesis unavailable (needs `ctx.aiEnvelope`) |
| `openwop-app.rest-transport` | `host/restTransport.ts` | `conditionalRunGet: true`, `contentEncodings` = `SUPPORTED_RUN_ENCODINGS` |

Each discovery-family record is a **function** that builds the executor's own
surface bundle (`buildHostSurfaceBundle`, memoised per process) and **throws**
when a method the pack calls is missing — which omits the record
(`v2Extensions()`), so a claim cannot outlive its wiring. The records carry
`servedBy`, `operations`, and where true `unavailable` / `demoData`.

`rest-transport`'s facets read the same constant that applies the encodings,
and were measured live on 2026-09-27: strong ETag, `If-None-Match` → 304,
`br` and `gzip` applied on `GET /v1/runs/{id}`.

### Withheld

- `brand`, `entities`, `data-integration`, `coordination` — this host **vendors**
  their packs, but the executor wires no `ctx.brand` / `ctx.entities` /
  `ctx.dataIntegration` / `ctx.agentRuntime`, so every node fails
  `host_capability_missing`. A claim would advertise a pack that cannot run.
  The route to claiming `brand` / `entities` is wiring those contexts to the
  existing feature services (brand kits, entity CRUD) — a follow-up.

  > **CORRECTED 2026-10-08 (ADR 0783 D9): `data-integration` is now claimed.**
  > The executor wires `ctx.dataIntegration` (`host/dataIntegrationAdapter.ts`),
  > serving six of the pack's eight methods. The record names the other two
  > nodes in `unavailable` (`data.source.a2a` → `fetchA2A`, `data.binding.apply`
  > → `applyBinding`), so the contract test still accounts for every call the
  > pack makes.
- `messaging` — the relay gateway is an HTTP service with no node-context
  surface; `host.messaging` is the RFC 0017 queue bus, not chat egress.

  > **CORRECTED 2026-09-28 (ADR 0769):** both halves of this were wrong.
  > `ctx.messaging` WAS a node-context surface, the SMS adapter the executor wires,
  > and `host.messaging` naming the queue bus is a separate surface-registry label.
  > The real gap was that `ctx.messaging` lacked `dispatchEgressEnvelope`. ADR 0769
  > adds it over the relay gateway and claims `messaging`.
- `a2ui-surface` — seam-gated envelope family, not a discovery claim this host
  makes.

No RFC: records under the host's own registered org, defined by RFC 0220.

## Alternatives weighed

| option | why not |
| --- | --- |
| claim brand / entities / messaging from their HTTP services | the vendored packs of the same name cannot run here; the claim would be read as "this family's pack works" |
| a hand-kept list of claimed families | drifts; the rule is "executes", so the record must re-check execution |
| check the host-surface registry's `supported` flag | the flag is an advisory self-declaration; the executor's bundle and the pack's calls are what run |

## Implementation record

| change | witness (`test/adr0765-ext-family-records.test.ts`) |
| --- | --- |
| contract | each record's `methods` equals every `ctx.<surface>.<method>` its pack source calls |
| execution | the executor's bundle provides all of them; a bundle missing one omits the record |
| hand-off | `executor.ts` passes each claimed surface into the node context (sabotage: removing `webResearch: surfaces.webResearch` reds it) |
| wire | v2 discovery carries all seven, well-formed under the suite's four rules; withheld families absent; v1 carries none |
| rest-transport | advert = constant; 304 on `If-None-Match`; gzip and br applied and decodable |

## Correction 2026-09-28: `contentEncodings` was true of the process, false through the door

The `rest-transport` row above ("gzip and br applied and decodable") tested the
origin. The first post-deploy certification (c4aad98c2, rev 00780) ran through
the production door and red `v2-ext-rest-transport`. The zstd-only request
returned identity.

MEASURED against the same run GET:
- at the origin (`*.run.app`), `zstd` → `Content-Encoding: zstd`;
- through `app.openwop.dev/api`, zstd came back as identity, while br and gzip
  passed through.

Firebase Hosting's CDN re-encodes and does not speak zstd. The advert read the
runtime (`zlib.zstdCompressSync` exists on the prod Node) and could not see the
path.

**Fix:** `resolveRunEncodings` intersects the runtime set with an
operator-declared `OPENWOP_REST_TRANSPORT_ENCODINGS`. Prod sets `br,gzip`.
`SUPPORTED_RUN_ENCODINGS` stays the one list the advert and the encoder both
read. This is the same class as the door rewriting `Accept-Language`: a
property of the process is not a property of what a client receives, and only
an end-to-end probe through the door sees the difference.
