# ADR 0998 — run surface namespace

Status: implemented (#5351, merged as `e2249ad38`)

Residue item CS2WF-4 from ADR 0997 (the conversation-search feature-loop pass,
row 63): the chat-search engine kept members' private message text in the
tenant-wide `db.search` surface, which any member's workflow could read. ADR 0997
moved that feature off the surface and purges its legacy index; this ADR closes
the same class for every named run surface at once, so the next host feature
that writes one cannot re-open it.

## Context

A run receives the tenant's generic host surfaces (`executor.ts`, the
`buildHostSurfaceBundle` call that builds `ctx.storage` / `ctx.db`). Four of them
are keyed by a caller-chosen NAME and scoped per tenant only:

| surface | name argument | backends |
|---|---|---|
| `host.db.vector` | `namespace` | memory, durable, pgvector |
| `host.db.search` | `index` | memory, durable, OpenSearch |
| `host.db.nosql` | `datasource` | memory, durable |
| `host.blobStorage` | `key` / `prefix` | memory, GCS, S3 |

Host features write into the same surfaces, for the same tenant, under names they
choose, and apply their own member or org predicate on their own reads:

| name | writer | data | who may read |
|---|---|---|---|
| `user:<id>` (vector) | subject memory: per-user agents (ADR 0442), personal notes (ADR 0041), memory auto-extract | personal memory text in `metadata.content` | that member only |
| `org:<id>` (vector) | client memory (ADR 0944) | client facts | members with org scope |
| `project:<id>` (vector) | projects / notebooks notes | project notes | project members |
| `<orgId>/<collectionId>[#sig]` (vector) | KB (ADR 0830) | chunk text in `metadata.text` | org scope + private-project visibility |
| `agent:<id>` (vector) | agent memory | shared agent recall | tenant, by design |
| `commerce:product:…` (vector) | discovery | public catalog | anyone |
| `chat-search` (search) | conversation search, before ADR 0997 (legacy rows purged) | message text | conversation participants |
| `retention-export/<runId>.ndjson` (blob) | run retention export (opt-in) | full run event logs | operators |

The `core.openwop.db` and `core.openwop.storage` nodes spread
`{...ctx.config, ...ctx.inputs}` into the surface, node config is not validated
against the pack schema at run time, and any member can register a workflow. So
any member could read another member's private memory, another org's KB, or
another member's chat text by naming it, and could overwrite or delete those
rows the same way.

Measured in prod (read-only, 2026-10-28): no member-private row was exposed in
a multi-member tenant. 0 subject-memory `user:*` vector rows, 0 search rows,
0 blob objects; the one KB namespace in a multi-member tenant belongs to the
tenant-root org every member is in. The class was latent, not live.

## Decision

Make the run keyspace and the host keyspace disjoint by construction, at one
choke point, with a closed-world prefix rather than a blocklist of host names
(`host/runSurfaceNamespace.ts`):

1. **Run lane.** `runNamespacedBundle(bundle)` wraps the executor's bundle. On
   every verb of vector, search, nosql and blob it rewrites the name to
   `wf:<name>` (`wf:default` when omitted, mirroring each backend's own default)
   and strips the prefix from keys it hands back, so a run sees its own names.
   Every function on the surface is wrapped, so a verb added later is covered.
   A presigned URL is minted only for the prefixed key, and `list` is pinned
   under the prefix.
2. **Fail closed on return.** Any name the backend hands back (a result's
   `namespace` / `index` / `datasource` / blob `key`, top-level or per row) must
   be in the run keyspace. A foreign row in a result array is dropped and logged
   by count only; a foreign top-level value is a `RUN_KEYSPACE_VIOLATION` error.
   Neither the error nor the log line names the key. Nothing is passed through
   unprefixed.
3. **Host lane.** `buildHostSurfaceBundle` returns those four surfaces guarded:
   a name or blob key/prefix starting `wf:` is refused with `RESERVED_NAMESPACE`.
   A host feature therefore cannot land in, or read, the run keyspace either.
4. The run lane reaches the unguarded surfaces through a module-private WeakMap
   keyed by the bundle, and refuses a bundle that did not come from
   `buildHostSurfaceBundle`.

### Alternatives

- **Per-feature moves** (each host feature leaves the generic surfaces): fixes
  only the features found, and the next one re-opens the class.
- **A blocklist of host prefixes** (`user:`, `org:`, `<org>/…`, `chat-search`):
  the KB shape `<orgId>/<collectionId>` cannot be matched without a false
  positive, and every new host feature must remember to register.
- **Prefix inside each backend's key builder**: at least six builders (durable
  vector/search/nosql, pgvector, in-memory vector/search, OpenSearch, three blob
  backends); the run/host distinction does not exist there.

### Compatibility

No pack legitimately reads a host namespace through a run surface.
`core.openwop.rag` passes `collection`, never `namespace`, so it only ever used
`default`; the agent-pack retriever tool ids are bound to the knowledge surface,
not `db.vector`. Prod measurement: 0 of 283 registered workflow definitions use
any affected node, 0 `node.started` events for them in all history (floor 22954
core node starts), the blob bucket is empty, and no run-written vector, search or
nosql data exists — so nothing is stranded by the prefix.

## P2 — argument canonicalization (before the prefix)

Three contracts name the vector/search arguments differently:

| | vector name | items | query vector | top-k | search query | search docs |
|---|---|---|---|---|---|---|
| spec (`host-capabilities.md` §host.vectorStore / §host.searchIndex; v2 `storage.md`) | `collection` | `vectors[].embedding` | `embedding` | `k` | `q`, `k` | `docs[]` |
| `core.openwop.db@1.0.1` (installed in prod from the registry) | `collection` | `records[].vector` | `vector` | `topK` | `query`, `limit` | `id` + `document` |
| this host's backends (memory, durable, pgvector, OpenSearch) | `namespace` | `items[].vector` | `vector` | `topK` | `q`, `k` | `docs[]` |

So a schema-conforming `core.db` vector node always hit the `default` namespace,
`search-query` sent an empty `q`, and `search-index` indexed nothing. The pack's
vector-query output schema also names the result `hits`, while the backends
return `matches`.

**Decision.** One canonicalizer (`canonicalArgs` in `host/runSurfaceNamespace.ts`)
runs at the START of both lanes. It folds the spec and pack aliases into the
backend names, the canonical name winning when both are given, and DELETES every
alias, so a backend only ever sees canonical arguments. Vector results carry
`hits` as the same array as `matches`.

**The ordering is ADR 0998's invariant.** The fold runs BEFORE the run lane's
prefix, because an alias can carry a store name: folded after a prefix that
only rewrites a present `namespace`, `collection: "user:<id>"` from a run reads
the host's row (witnessed). Every host-feature caller already passes canonical
names (subject memory, KB, product discovery; the conversation-search legacy
purge reads raw kv), so the fold is a no-op on the host lane today.

**Witness:** `test/adr0998-p2-surface-arg-canonicalize.test.ts`. The real
`core.db.vector-upsert/-query` and `core.db.search-index/-query` nodes with
SCHEMA-conforming config round-trip (red on old code). A run's
`collection: "user:<id>"` cannot read the host row (red when folded after the
prefix). It also covers canonical-wins precedence (red when the alias wins), `hits` is `matches` (red as
a copy), and the seam keeping the host shape and adding the spec shape.

**Closes** the residue item on the pack's `index`/`query`/`limit`/`collection`
names on the host side. **Not chosen now (residue):** a spec-aligned
`core.openwop.db@1.0.2` (and `core.openwop.rag`, which sends
`collection`/`records` and needs `ctx.callAI.embeddings`) would need a signed
registry publish and an `OPENWOP_INSTALL_PACKS` bump. It is not needed while P2
accepts both shapes; do it if the pack is ever revised.

Existing OpenSearch deployments must re-index when #5355 lands (index names change).

## Implementation

| phase | change | witness |
|---|---|---|
| P1 (#5351, `e2249ad38`) | `host/runSurfaceNamespace.ts`; host lane in `buildHostSurfaceBundle`; run lane at the executor | `test/adr0998-run-surface-namespace.test.ts`: the real `core.db.vector-query/-upsert/-delete`, `core.db.search-query/-index` and `core.storage.blob-get/-put/-presign` nodes, each with a positive control. It shows a run cannot read `user:<id>`, a KB namespace or `chat-search`, cannot poison or delete a host row, and cannot get, presign or list `retention-export/`. Sabotage: red with the executor wrap removed, with the host guard removed, and with the fail-closed strip turned into a pass-through (stubbed backends returning foreign rows). Ratchet: every `buildHostSurfaceBundle(` under `src/executor` is wrapped, and NodeContext `db`/`storage` are assigned in one place |

Post-deploy: Live on rev 01072-kz5 (e2249ad38) 2026-10-28 09:34Z; read-only check: 0 ERROR, 0 foreign-row drops, 0 keyspace violations, 0 reserved-namespace refusals; no prod run used the wrapped nodes (0 historical), so no data was stranded.

## Residue

- **Who may register a workflow.** registration requires workspace:write (ADR 0770 D1); the cross-member data path is closed by ADR 0998; a workspace that wants raw storage nodes off can disable core.openwop.db per tenant (ADR 0194 assertNoDisabledPacks). No change recommended.

  > **CORRECTED 2026-10-28.** This item first said the route had "no role gate;
  > any member may register and run any workflow" and asked the user whether it
  > should need one. That was false, read from a keyword grep that missed the
  > guard's name. The route's first statement is
  > `await requireWorkflowWrite(req); // ADR 0770 D1` (`routes/workflows.ts:375`),
  > which is `return requireWorkflowScope(req, 'workspace:write');`
  > (`host/workflowWriteAuthority.ts:33`), so viewers are refused.
- The `core.openwop.db` pack's schemas name `index`/`query`/`limit` and
  `collection`, while the surfaces read `q`/`k` and `namespace`; a
  schema-conforming node hits `default` or an empty query. Separate PR.
- `kv`, `table`, `cache`, `queue`, `fs` and `queueBus` have no host-feature
  writer today and are not prefixed. A host feature that starts writing to one of
  them must extend this ADR first.
