# ADR 0858 — The v2 discovery document projects every family this host serves

Status: Accepted (P2 + P3 slices 1–3 implemented; P4 a2a/mcp host work implemented, both families still ledgered as behaviour gaps)

> **Renumbered 0854 → 0858 (2026-10-07).** This ADR was first committed as 0854,
> nine minutes after a peer session's
> `0854-approval-handoffs-and-handoff-cards.md`, which had not been pushed when
> `check-adr-refs --next` ran. The first-created number is canonical, so this one
> moved. Commit messages and the early cross-session notes still say 0854.

Date: 2026-10-07

## Context

The v1 discovery document (`buildAdvertisement`) and the v2 one
(`buildV2Advertisement`) are built separately, in `src/routes/discovery.ts`. v2
families were added one at a time as each was needed: for a conformance leg, or
for a certification row. Nothing ever checked that every family v1 advertised also
reached v2.

Through the overlap that gap was invisible. A client that wanted a capability v2
did not advertise could read the v1 document. Production retired v1 on
2026-10-03, so the v2 document is now the **only** statement this host makes
about itself.

**Found by the ADR 0812 P3c-0 test port** (batches 0, 2 and 3 each hit part of
it). **MEASURED 2026-10-07** by booting one app, building both documents from the
same config with A2A and MCP serving enabled, and comparing them with the v2
schema:

- v2 emits **22** families.
- **18** families are advertised by v1, have a declared seat in
  `schemas/v2/capabilities.schema.json`, and are **absent from v2**: `a2a`,
  `mcp`, `httpClient`, `multiPartyConversation`,
  `conversationTurnModelProvenance`, `providerUsage`, `conformance`,
  `schemaVersions`, `observability`, `kvStorage`, `tableStorage`, `deadLetter`,
  `queueBus`, `sql`, `vectorStore`, `blobStorage`, `artifactTypes`, `cache`.
- Two more join them when their flags are on: `multiAgent` (the verifier) and
  `workspace` (a file-backed store).
- On production, `api.openwop.dev`'s v2 document carries none of `a2a`, `mcp`,
  `multiAgent` or `workspace`.

The measurement is a probe, not a verdict. Some entries may be deliberate or may
live elsewhere: `schemaVersions` is projected **inside** the v2 `envelopes`
family. Each entry needs a disposition.

### Why the existing guard missed it

`test/whd7-v2-projection-parity.test.ts` compares facets **within families v2
already emits** (`v2Families(v2)`). A family absent from v2 has no record to
compare, so it is outside the test's universe. The test checks the instances in
front of it and never enumerates the class.

### Why under-advertising is not the safe direction

- **Clients:** a v2 client cannot discover A2A, MCP, the verifier, the workspace,
  or the storage families, although the host serves them.
- **Verification:** every major-2 conformance scenario gated on an unadvertised
  family records `inapplicable`. The certified major-2 bundles (368/0/0) are
  honest about what they executed, but they never measured these surfaces. The
  host declined to be measured on them, and on the wire that looks the same as a
  surface it does not have. This is the `replay`-family lesson (2026-09-05) again: an honest omission and a broken surface look identical.

## Decision

1. **Disposition every candidate family.** For each of the 20:
   - **project** it: build the v2 record from the same source of truth the v1
     record reads (RFC 0152 / RFC 0153 version SSoT for `a2a` / `mcp`), route
     it through `stripSupported`, give it the `status` / `since` / `until` /
     `witness` envelope, and fill every facet the v2 schema REQUIRES only with a
     value the host honours; or
   - **ledger** it, with a reason and an owner: the v2 shape needs a corpus
     decision, a required facet cannot be truthfully filled (the `replay`
     precedent), or the family is projected somewhere else.
2. **Close the class, not the instances.** Extend WHD-7 with a **whole-family**
   leg. Every family the v1 document advertises that has a v2 schema seat MUST
   appear in the v2 document or in a shrink-only `KNOWN_UNPROJECTED_FAMILIES`
   ledger. The leg boots with the flag-gated surfaces ON (A2A, MCP, verifier,
   file workspace), so gated families are inside its universe. It is
   sabotage-witnessed: deleting one projected family turns it red.
3. **The v1 document is the oracle only until P3c.** ADR 0812 P3c deletes
   `buildAdvertisement`. Before that, this ADR moves the class check onto the
   **v2 schema's seat list plus a host-served-surface inventory**, so the check
   survives the oracle's deletion. The fold PR must not merge while this ADR's
   P2 is open.
4. **Expect the conformance lane to move.** Advertising a family makes its
   major-2 scenarios applicable. A red that results is a real finding: it is
   fixed or recorded in `scripts/conformance-v2-known-red.txt` with its reason,
   and never hidden by un-advertising.

## Alternatives weighed

- **Leave it until someone asks.** Rejected. Production is v2-only, and every day
  without the adverts is a day those surfaces go unverified.
- **Copy the v1 records into v2 verbatim.** Rejected. The v2 records are closed
  (`additionalProperties: false`), retire `supported` (RFC 0192), and add
  required facets. A copied facet is the `deferredParameters` class that WHD-7's
  leak leg already refuses.
- **Advertise everything, fix the reds later.** Rejected. A record whose required
  facet the host cannot honour is a false wire claim, so each family is checked
  against its schema before it is advertised.

## P1 — per-family disposition (measured 2026-10-07)

**CORRECTION to the Decision's P3 as first written.** It planned to project `a2a`,
`mcp`, `multiAgent` and `workspace` first, because ported tests were waiting on
them. Measuring each record against the v2 spec showed that **three of those four
would be false claims today**. The order below is set by honour-ability, not by
which tests are waiting.

Method: a probe built both documents with every v1 env flag on. With everything
on, v2 emits 34 families and 24 seated families are missing. That is the 20 above
plus `sandbox`, `portability`, `runtimeCapabilities` and `supportedEnvelopes`.

**PROJECT. Every required facet can be filled from the same source, and the host
honours it:**

- `httpClient`: SAFE_FETCH constants.
- `multiPartyConversation`: `{maxParticipants}`.
- `conversationTurnModelProvenance`: a bare record.
- `providerUsage`: `{costEstimates, currency:'USD'}`.
- `deadLetter`: `retentionDays` only when it is greater than 0.
- `artifactTypes`: the same `types` map.
  `v2-artifact-type-schema-url` stays inapplicable, because the registry has no
  `schemaVersion`.
- `observability`: `{otel}`. `testSeams` is projected only once the v2 seam
  reachability is confirmed.
- `runtimeCapabilities`.

**PROJECT WITH DROPS. v1 copied literals the host never enforces.**

- `kvStorage`, `tableStorage`, `blobStorage` and `cache`: v1 states limits
  (`maxKeyBytes`, `maxRowsPerTable`, `maxObjectBytes`, `maxTtlSeconds`) that no
  adapter checks. Those facets are dropped, not copied.
- `sql`, `vectorStore` and `queueBus`: v1's backend literals (`['sqlite']`,
  `['in-memory']`) are FALSE on production, which runs `durable`. The value is
  derived from `resolveBackendId()`, and the facet is omitted where no enum value
  fits.

**ALREADY PROJECTED. Not a gap.**

- `schemaVersions` and `supportedEnvelopes`: projected inside the envelopes
  family, seam-gated (ADR 0749 D7).
- `conformance`: v2 root metadata, present when the seams are mounted or a
  verified bundle exists. This closes the first open question.

**LEDGER. Blocked by host work, which a later phase does:**

- `a2a`, `mcp`: the version facets are honour-able from the RFC 0152 / RFC 0153
  version SSoT. Three things are not:
  - nothing holds a `refreshedAt` (`interop.md` requires re-evaluation every 90
    days);
  - no `negotiation.decided` event is emitted (a MUST);
  - the legacy profile ids (`a2a-0.3-legacy`, `mcp-2025-06-18-legacy`) fail the
    v2 patterns.

  `a2a` has one more: a header-less card GET serves 0.3 (`a2aProfile.ts:180`),
  where `interop.md:33` requires the `preferredVersion` (1.0) card. **That is a
  steward / host decision.**
- `workspace`: no `workspace.updated` is emitted on write or delete
  (`host-services.md:190`). Everything else is honoured.
- `multiAgent`: two points are unclear.
  - v1 claims `executionModel.version: 6` without `crossHostCausation`, because
    `isPhase3Enabled` ignores PHASE_5.
  - It is unconfirmed whether `x-host-openwop-app-clarification` is a legal v2
    interrupt kind.
- `portability`: the host emits and accepts only `bundleVersion:'1'` (v2 requires
  `"2"`), and it never emits `import.applied`.
- `sandbox`: `isolationModel` is ADR 0555 P4 work.

**RFC 0228 makes the ledger urgent rather than comfortable.** Under major 2, an
operation whose family is not advertised MUST answer 404. The workspace, A2A and
MCP routes are served on v2 WITHOUT their families. So for those three, "ledger"
means "fix the blocker". It does not mean "leave it out", because leaving it out
is itself a MUST violation.

## P3 as built (2026-10-07)

- **Projected:** `httpClient`, `conversationTurnModelProvenance`, `deadLetter`
  and `artifactTypes`. `artifactTypesAdvert()` is now the one builder for both
  majors' records. The major-2 lane passes 194/194 with all four advertised,
  and their scenarios (`v2-safefetch-ssrf-refused`,
  `v2-conversation-turn-model-provenance*`, `v2-dead-letter-advertisement`,
  `v2-artifact-types-advertisement`) execute for the first time.
- **Projected, then WITHDRAWN as behaviour gaps.** Advertising them made their
  scenarios applicable, and the scenarios fail. Before this, v1 had been
  claiming both.
  - `multiPartyConversation` fails `v2-multi-party-council`:
    - an off-roster speaker is not refused with
      `conversation_speaker_not_participant` (the host answers
      `validation_error`, and a legitimate turn then fails too);
    - a 64-member roster over `maxParticipants` 8 is admitted 201 instead of
      `conversation_roster_exceeded`.
  - `providerUsage` fails `v2-provider-usage-emission`: no `provider.usage` is
    emitted on a live-model run.

  Both were ledgered, each naming its scenario, to be projected once fixed
  (`providerUsage` is now fixed — see below).
  This is decision 4 working as designed: the omission had hidden real defects,
  not only missing adverts.
- **P3 behaviour gap: `multiPartyConversation` — fixed (2026-10-07).** It is
  projected again (`maxParticipants` 8), and it is out of the ledger. All three
  `v2-multi-party-council` legs pass. The major-2 lane still passes 194/194.
  - *speaker-refused.* The refusal did not consume the interrupt. RFC 0239
    §B.1 resumes with a bare turn, `{ role, speakerId, content }`. This host
    only parsed the chat `ConversationResolve` shape,
    `{ operation, turn: { content } }`. So EVERY council turn fell into the chat
    path, which found no `turn.content` and answered `422 validation_error`.
    The intruder got that answer, and so did the member's control turn. The
    roster on `conversation.opened` was never enforced. The fix is
    `host/exchange/councilTurn.ts`. A bare turn against a gate that opened
    with a roster is checked against that roster, read from the durable
    `conversation.opened` event. The check runs BEFORE anything is appended.
    An off-roster turn gets `422 conversation_speaker_not_participant` with
    `details.speakerId`. A member's turn is appended as one attributed
    `conversation.exchanged`, and the host dispatches no reply. Every other
    shape, and any gate without a roster (the chat transport), is unchanged.
  - *roster-exceeded.* `capabilityGatedTypeIdRefusal` is the one choke for
    every lane that admits a definition (create, fork, debug, evals, compose).
    It now refuses a `core.conversationGate` roster over the cap with
    `422 conversation_roster_exceeded` and `details.maxParticipants`. The
    roster is never truncated, and no run row is written.
  - Both codes are registered in the vendored v2 registry, so they cross the
    v2 wire unprefixed. Witness: `test/adr0858-council-roster-refusals.test.ts`,
    with each fix sabotage-checked red. The v1 seam
    (`routes/multiPartyConversationSeam.ts`) and the chat-path
    `ConversationMeta` roster check keep `validation_error`. Both are major-1 or
    product surfaces that RFC 0239 does not re-code.
- **P3 behaviour gap: providerUsage — fixed (2026-10-07).** The emission
  scenario's fixture (`conformance-context-budget-live`) needs a live-model
  supervisor, which this host lacks. The fixture is no longer advertised: it
  was a false `fixtures[]` claim, because the catalog says "a host whose
  supervisor has no live model MUST NOT advertise this fixture". `providerUsage`
  is projected, since usage IS emitted on real model calls
  (`test/provider-usage-emit.test.ts`).
  - Mechanism: one fact, `SUPERVISOR_CALLS_LIVE_MODEL` (`false`), next to the
    supervisor in `bootstrap/nodes.ts`. `listLoadedConformanceFixtures`
    withholds `FIXTURES_REQUIRING_LIVE_MODEL_SUPERVISOR` while it is false.
    `test/rfc0111-context-budget-non-advert.test.ts` leg 2 ties the fact to
    whether the supervisor reaches `callAI`.
  - The withdrawal changes `fixtures[]` on BOTH majors. v1 is retired on prod
    (ADR 0812), so the v1 change only affects a host that still serves it.
  - Witness: `test/adr0858-live-model-fixture-advert.test.ts`. Its set is
    derived from the vendored fixtures tagged `live-model`; both sabotages
    (flipping the fact, dropping the filter) go red.
  - Lane: `v2-provider-usage-emission` is now `inapplicable` (fixture not
    advertised), `v2-provider-usage-advertisement` passes, and the major-2 lane
    is 194/194 with 0 reds.
- **P3 storage slice (2026-10-07).** `host/storageFamilyAdvert.ts`
  `storageFamilyFacets()` is now the one builder for all seven storage
  families on BOTH majors (the `artifactTypesAdvert` precedent). v1 reads it
  too, so v1 stops claiming the dropped limits as well.
  - **Dropped** (grep of `inMemorySurfaces.ts`, `durable/*`, `sql/pgSql.ts`,
    `vector/pgVectorVector.ts`, `blob/s3Blob.ts` and the `core.openwop.storage`
    pack schemas: nothing enforces them, and `storage.md` §Size limits makes
    each a MUST-refuse): `kvStorage.maxKeyBytes` / `maxValueBytes` /
    `maxTtlSeconds`, `tableStorage.maxRowsPerTable` / `maxColumnsPerRow`,
    `blobStorage.maxObjectBytes` (s3's 64 MiB is a READ cap), and
    `cache.maxValueBytes` / `maxTtlSeconds`. `queueBus.stream` is dropped too:
    `streamSubscribe` without `fromBeginning` returns an empty snapshot on both
    backends.
  - **Kept, true on every selectable backend:** `kvStorage.atomicIncrement` /
    `compareAndSwap` (memory has no await inside the read-modify-write; durable
    uses `Storage.kvCompareAndSwap`), `tableStorage.indexable: false` /
    `fullTextSearch: false`, `queueBus.deadLetterSupported` (`<subject>.dlq` on
    both), and `sql.transactions` (better-sqlite3 `db.transaction` and pg
    BEGIN/ROLLBACK both roll the batch back).
  - **Derived per request from `resolveBackendId()`:** `sql.drivers`
    (memory → sqlite, durable → sqlite, because it is a per-tenant SQLite FILE,
    postgres → postgres); `vectorStore.backends` (memory → in-memory,
    pgvector → pgvector, durable → omitted, because brute-force over `Storage`
    has no enum value); `queueBus.backends` (memory → in-memory, durable →
    omitted). `blobStorage.presignSupported` is true on s3, and on memory only
    while `OPENWOP_TEST_SEAM_ENABLED`, because the token resolver route is
    mounted only by `registerTestSeamRoutes`. A new registered adapter for
    these surfaces reds `test/adr0858-storage-family-backends.test.ts` until it
    is mapped.
  - **Projected at v2: `queueBus` only.** The lane passes 194/194. A
    `--certify` run at major 2 changed two of its rows:
    `queueBus.cross-tenant-isolation` stays `inapplicable`, because the queue
    probe fixtures are not advertised.
    `0177.peer-dependency-declared.alias-overlap` moves from `inapplicable` to
    `skipped`: the scenario now picks `host.queueBus`, which this v1-retired
    host does not resolve, and that is the correct outcome.
  - **WITHDRAWN as a behaviour gap: `kvStorage`, `tableStorage`, `sql`,
    `vectorStore`, `blobStorage`, `cache`.** With all seven advertised, the
    lane was still 194/194 green. But `--certify` recorded six NEW `blocked`
    rows (`storage.cross-tenant-{kv-storage,table-storage,blob-storage,cache,sql,vector-store}`),
    each saying "the host advertises X but not the conformance-storage-probe
    fixture". A blocked row stops a bundle certifying. The probe
    (`core.conformance.storage-probe`) is not implemented, and its contract
    needs operations these surfaces lack: `blobStorage.list`, and
    `tableStorage.createTable` / `get`. More broadly, the surfaces' operation
    names drift from `storage.md` §Operations (`kv.set`/`cas`, `cache.evict`,
    no `blob.delete`). They are ledgered with that reason; projecting one later
    is an edit to `V2_ADVERTISED_STORAGE_FAMILIES`.
    > **CORRECTED 2026-10-08 (storage probe).** The probe now exists and five
    > of the six are projected; see §"P3 storage probe as built" below. The
    > blocker was narrower than this paragraph says: the probe's contract needs
    > `blobStorage.list` / `delete` (still missing, so blob stays withheld), but
    > `tableStorage.createTable` and `get` map onto what the surface has (schema
    > inferred on first insert; `get(ref)` is `query({ id: ref })`).
  - `test/dead-letter-rfc0053.test.ts` was the batch-1 v1-bridge caller for
    `deadLetter` / `queueBus`, and it now reads the v2 root.
- **P3 slice 3 (2026-10-07): `subWorkflow`, `dataResidency`,
  `anonymousActor`, `authorization` projected** (`v2HostServiceFamilies`).
  Each record reads the source its behaviour reads; none is built from the v1
  document, and none carries `supported`.
  - **`subWorkflow` closed a live MUST breach.** `execution.md` §subWorkflow:
    a host not advertising `subWorkflow.inputMapping` MUST refuse a non-empty
    `inputMapping` with `validation_error`. The v2 root had no record, while
    the register-time refusal read an overlay flag defaulting `true`, so v2
    ACCEPTED mappings it never advertised. Both now read ONE function,
    `subWorkflowInputMappingHonoured()` (`host/capabilityOverlay.ts`); the
    facet is omitted when the fact is off, and the capability-toggle seam moves
    advert and refusal together. The record is always present (`core.subWorkflow`
    is always served).
  - `dataResidency` under `dataResidencyAdvertised()` (enabled AND >=1 region,
    so the run-create gate that refuses `422 residency_unavailable` is active);
    `regions` = `dataResidencyRegions()`. `anonymousActor` under
    `OPENWOP_ANON_ACTOR_ENABLED`, facets from `anonymousActorCapability()`.
    `authorization` only while `isAuthorizationEnforced()`; the prod root (gate
    off) does not change.
  - Witness: `test/adr0858-slice3-families.test.ts` (advert and refusal
    parameterised over the fact; gated records schema-valid). Three sabotages
    go red: advert hard-coded true, refusal never firing, record removed.
  - The seat probe now enables the three operator gates. The
    `cdp-data-residency-admission`, `anonymous-actor` and
    `authorization-fail-closed` bridge callers read the v2 root.
  - Lane 194/194. `--certify` at major 2 against the parent: nine rows moved
    `inapplicable` → `executed-pass` (`v2-data-residency-advertisement` and
    `-admission`: six, `v2-sub-workflow-advertisement`: three). There are no new
    `blocked` or `executed-fail` rows (the same 7 pre-existing blocked rows on
    both sides). `v2-authorization-advertisement` stays `inapplicable`: the
    conformance boot does not enforce authorization. The `v2-mcp-mount-map`
    anon-boundary leg is unchanged. It was already `inapplicable` because `mcp`
    is not advertised at v2. Once P4 projects `mcp`, advertising
    `anonymousActor` will make that leg `inapplicable` instead of executing it.
- **P2 guard:** `test/adr0858-v2-family-seats.test.ts`. It covers 74 family
  seats, with 37 emitted (slice 3) under the gated-on probe and the rest ledgered. It is
  sabotage-witnessed.

## P3 storage probe as built (2026-10-08)

- **`core.conformance.storage-probe`** (`bootstrap/conformanceStorageProbe.ts`)
  calls the run's own `ctx.storage` / `ctx.db` surfaces and keeps no state of its
  own. A surface rejection fails the node with the rejection's code, unchanged.
  It is registered beside its siblings behind `conformanceNodesEnabled()`.

  > **CORRECTED 2026-10-08 (same day) — that gate made the projection
  > local-only.** MEASURED on prod after the probe deployed (3b41066dc, rev
  > 00916-ggn): v2 discovery still listed storage = `queueBus` only, and the
  > `conformance-storage-probe` fixture was absent. Prod runs with
  > `NODE_ENV=production` and no `OPENWOP_ENABLE_CONFORMANCE_NODES`, so
  > `conformanceNodesEnabled()` is false (LEAK-8 fail-closed) and the probe never
  > registered. The withholding was honest, but P3 had not reached the host it
  > was for. That switch exists to keep test-only nodes such as the mock agent
  > and `conformance.secret.echo` off a real host. The probe is not that kind of
  > surface: it calls only the run tenant's own storage, as any storage pack
  > node does, under the same quotas. **Decision (user, 2026-10-08):** the probe
  > gets its own switch, `storageProbeEnabled()`
  > (`OPENWOP_CONFORMANCE_STORAGE_PROBE=false` turns it off; on by default). It
  > registers outside the conformance-nodes block, and `host/index.ts` exempts
  > its typeId from the conformance-nodes fixture filter. Whether the typeId
  > resolves is still the one fact that both the fixture advert and the family
  > advert read. Pinned by `test/adr0858-storage-probe-gate.test.ts`, which
  > boots the registry in the prod posture (nodes off; the mock agent is
  > asserted unresolvable as a control). Sabotage: making the off switch a no-op
  > fails the withdrawal leg; registering inside the block fails the
  > prod-posture leg (observed before the move).
  `PROBED_STORAGE_FAMILIES` is the single list of families it implements:
  `kvStorage`, `cache`, `tableStorage`, `vectorStore`, `sql`.
- **The advert is tied to the probe.** `V2_ADVERTISED_STORAGE_FAMILIES` became
  `v2AdvertisedStorageFamilies()`: `queueBus`, plus the probed five only while
  the probe node resolves, which is exactly when the
  `conformance-storage-probe` fixture is advertised. A host with conformance
  nodes off advertises what it did before (`queueBus` only) — *superseded by the correction above: the probe now has its own switch.* Two rules are each
  satisfied by construction: an advertised family without the fixture records
  `blocked`, and the fixture must not be advertised unless the probe covers every
  advertised family. `agentPackResolver.v2SatisfiedFamilies` reads the same
  function.
- **blobStorage stays withheld.** Its surface has no `list` or `delete`; the
  seat ledger keeps it, with that reason.

  > **SUPERSEDED 2026-10-09 — see §"P3 blob as built" below.** The surface
  > gained `list` and `delete`, the probe covers blob, and the ledger row is gone.
- **Mapping choices** (fixtures.md §"The storage probe fixtures"):
  - tableStorage: `createTable` is the first insert, and the row id the caller
    supplies (the key) is `ref`.
  - sql: the datasource is the tenant's own database or schema; placeholders
    are `?` on sqlite and `$n` on postgres.
  - vectorStore: `E(key)` is a SHA-256-derived unit vector sized to
    `OPENWOP_VECTOR_PG_DIM` under pgvector.
- **MEASURED (in-process, 2.45.25, major 2):** `v2-storage-cross-tenant-isolation`
  went from 6 `blocked` (when the families were advertised without the probe) to
  6 executed-pass with 0 blocked. blobStorage, searchIndex and nosql record
  `inapplicable`. **Sabotage:** keying the kv store by a constant tenant failed
  the kvStorage and cache legs.
- **Next corpus:** in 2.45.26, `v2-table-schema-enforcement` records
  `inapplicable` without its fixture, so no new blocked row follows. That fixture
  is NOT advertised; the host refuses a schema violation with
  `table_schema_violation`, not v2's `validation_error`, and that has to be fixed
  first.
- **Witnesses:** `test/adr0858-storage-probe-node.test.ts` (both tenants and
  every family at node level; the postgres placeholder; the pgvector dimension;
  refusal pass-through), `test/adr0858-storage-family-backends.test.ts` (the
  advert follows the probe), and `test/adr0858-v2-family-seats.test.ts` (the
  ledger shrank to blob, with conformance nodes registered).

## P3 storage on production (2026-10-08)

- **Deployed** `02c2711d4` (rev `00917-z5b`, #4610 own gate). v2 discovery on
  `api.openwop.dev` lists `queueBus`, `kvStorage`, `cache`, `tableStorage`,
  `vectorStore`, `sql` and the `conformance-storage-probe` fixture.
- **Bundle:** `gs://openwop-dev-certification-bundles/openwop-app-backend/02c2711d4c4d6cae307d6b33c29ead51e293cc57/major-2.json`
  — executed-pass 413 (398 on `c0b8ece9a`), fail 0, blocked 0, skipped 11,
  inapplicable 378. Fifteen rows moved inapplicable → pass and none the other
  way: the six storage rows, six data-residency rows, three sub-workflow rows.

  > **CORRECTION (2026-10-09) to how this was first reported.** The storage rows
  > were reported in-session as passing "on real Postgres/pgvector". MEASURED
  > from prod's own v2 document: `sql.drivers: ["sqlite"]`,
  > `vectorStore.backends: ["in-memory"]`, `queueBus.backends: ["in-memory"]`,
  > and the service sets no `OPENWOP_SURFACE_*` variable. Production's ctx
  > storage surfaces run on the memory tier. The rows passed honestly on what
  > prod runs; they say nothing about the postgres/pgvector adapters, which only
  > the node-level witnesses cover.
  >
  > **CORRECTED AGAIN 2026-10-09 (ADR 0867).** "Passed honestly" held only
  > because one instance served the cut. On `dc929e5d1` (two instances) the kv
  > leg failed: the write and the read landed on different processes. ADR 0867
  > moves production storage to shared backends and withholds any process-local
  > storage family on a scale-out host.

## P3 blob as built (2026-10-09)

- **`blobStorage.list` and `delete`** (`storage.md` §Operations) on both
  backends. memory: keys in code-unit order, the cursor is the last key
  returned (base64url, opaque), a page is at most 1000. s3: ListObjectsV2 with
  the prefix pinned to the tenant's root (a caller cannot widen it) and the root
  stripped from returned keys; DELETE is idempotent, so `deleted: true` means
  absent-now. `s3SigV4` signs a bucket-level request (`key: ''`) with extra
  query parameters. `put` now also returns `sizeBytes`.
- **`delete` is a guarded write** under the existing `blob-write` kind at the
  ADR 0563 seam (`guardBlobWrites`), so every backend inherits it. No pack node
  calls it yet; the storage probe is `sideEffecting`.
- **Probe:** `blobStorage` joined `PROBED_STORAGE_FAMILIES` (fixtures.md mapping:
  `put(key, utf8(value), "text/plain")`, `get` decoded as UTF-8,
  `list(prefix: key)` → its keys), so the advert follows with no other change and
  the seat ledger lost its last storage row.
- **Witness:** `test/adr0858-blob-list-delete.test.ts` — both backends: prefix
  list with sizes, three-page cursor walk with no repeat or skip, cross-tenant
  list/get/delete, delete removes only its object; s3 XML entity decoding; a
  replay reaching `delete` fails closed with the object intact. **Sabotage:**
  removing the delete guard reds the replay leg; listing the s3 bucket without
  the tenant root reds all four s3 legs.
- **Known shape deviations, not fixed here (ledgered for P5):** `get` returns
  `contentBase64`, not bytes, and `put` returns no `url`. `cache` exposes
  `evict` where storage.md names `delete`. These are pack-facing names on the
  host's ctx surface; the probe adapts to them, the suite cannot see them.

## P4 (a2a/mcp) as built (2026-10-07)

The four P1 blockers are fixed. **Neither family is projected**: a `--certify`
run with each projected found behaviour gaps the omission had hidden (decision
4), so both stay ledgered, each naming its scenarios. Both records are BUILT
(`v2A2aRecord` / `v2McpRecord` in `routes/discovery.ts`, from the version SSoT,
never the v1 document) and validate against the v2 schema; projecting one is a
flip of `V2_PROJECT_A2A` / `V2_PROJECT_MCP`.

- **`refreshedAt`.** `A2A_VERSIONS_REFRESHED_AT` (`host/a2aProfile.ts`) and
  `MCP_VERSIONS_REFRESHED_AT` (`host/mcpProfile.ts`), `YYYY-MM-DD` as the facet
  schemas require (`format: date`). Both are `2026-10-07` because the served sets
  WERE reviewed that day, against the corpus's upstream pins
  (`spec/v2/interop-map.json` `pins`, updated 2026-09-23: A2A release 1.0.1,
  negotiated `1.0`; MCP revision `2026-07-28`). They were not checked against the
  live upstream registries; each docblock says so.
  `test/adr0858-interop-refreshed-at.test.ts` is a **deliberate time bomb**: it
  reds 90 days after the date (`interop.md` §"The refresh SLA"). Under the
  clock-shift lane it asserts the bomb is ARMED on the shifted clock and checks
  the real-clock age, so that lane neither reds nor goes vacuous.
- **`negotiation.decided`.** One builder, `host/negotiationDecided.ts`, writes
  the CLOSED payload (`run-event-payloads.schema.json#/$defs/negotiationDecided`):
  `peerDigest` is SHA-256 of the peer origin, and the origin appears in no field.
  "The host's own event log" is the log of the RUN the negotiation happens
  inside. The event is a run-event type, and the corpus witnesses it on
  `GET /runs/{runId}/events/poll`. It is not the host-event dispatcher, which
  carries only host-extension types. Emitted from the ONE place each client
  decides a version: `negotiateA2aPeer` (`host/a2aSurface.ts`) and
  `negotiatedCall` (`host/mcpClient.ts`), on accepted, downgraded and refused.
  The executor hands both clients a recorder bound to the run
  (`BundleScope.recordNegotiation`, `McpClientDeps.onNegotiationDecided`). It
  is a recorded fact like `provider.usage`, outside the replay-observable set.
  The §22/§23 invoke seams plant a seam-owned run
  (`routes/negotiationAuditRun.ts`), hand its recorder to the SAME client, and
  name it as `runId` (`details.runId` on a refusal, written through
  `sendErrorWithMintedIds`: the error scrub redacts any 36-char UUID).
  `invokeA2aPeer` is now `served: true` in the seams-v2 manifest.
  - **Two corpus findings, for the steward.** (1) `interop.md`'s example names
    `peer` / `requested` / `negotiated` and an outcome `downgraded`, but the
    closed payload schema has `peerDigest` / `version` / `floor` and only
    `accepted | refused`. The host follows the schema, so an explicit downgrade
    is recorded as `accepted` with the LOWER version actually used.
    (2) INBOUND negotiations (the A2A JSON-RPC route and card GET, the MCP
    mount's per-request revision selection) have no run when they decide, so a
    run-event type has no log to land on. They are logged content-free as before.
    Where a runless `negotiation.decided` belongs is a corpus question, and this
    host does not invent a log for it.
  - The MCP client now refuses to lower an UNAUTHENTICATED exchange below
    `preferredVersion` (`interop.md` §Authentication; `authenticated: false` is
    the seam's knob, and production calls run under the run's Subject).
- **Legacy profile ids.** `a2aV2Profiles()` / `mcpV2Profiles()` drop every
  `-legacy` id. The v1 records are unchanged.
- **A2A on a major-2-only host (steward ruling).** `servedA2AVersions()` is
  `['1.0']` when `v1Retired()` (INBOUND half since gated on `V2_PROJECT_A2A`:
  see the correction below). It is still `['1.0','0.3']` while v1 is served,
  where RFC 0152's major-1 rules stand. The rule that follows:
  - A header-less card GET and a header-less request get the
    `preferredVersion` (1.0) card and codec. The 1.0 card lists no 0.3
    interface.
  - An explicit `A2A-Version: 0.3` is REFUSED: the card GET answers
    `400 interop_version_unsupported`, and the JSON-RPC route answers
    `VersionNotSupportedError`.
  - The outbound client refuses a 0.3-only peer `below-floor`. A seam-declared
    `peerOffersOnly` that this host does not serve is refused before any egress.

  **Why refuse rather than downgrade:** nothing in-tree needs 0.3. The SPA
  never speaks A2A, and `packs/core.openwop.a2a` has no 0.3 dependency. The only
  0.3 users are the major-1 unit tests, which run with v1 served
  (`test/setup/pinV1Served.ts`) and are unchanged. The corpus's fake peer offers
  both versions. And the closed payload schema could not record a downgrade
  honestly anyway.
- **CORRECTION (same day): the inbound A2A v2 rules are gated on the advert.**
  The coordinator measured production. A2A is ENABLED there
  (`OPENWOP_A2A_SERVER_ENABLED=true`), and real third-party agents use it
  daily after the v1 cut: BrickBlueBot, TaifoonHarvester, AgenstryBot,
  agentprobe, `agent-tools.cloud-*` and Kain-A2A. Together they send about 30
  JSON-RPC requests a day to `/host/openwop-app/a2a` and GET
  `/.well-known/agent-card.json`, presumably header-less, which makes them 0.3
  peers. As first built, the bullet above would have moved their header-less
  card and codec to 1.0 and refused an explicit 0.3 on every major-2-only host.
  That could silently break live integrations, for no gain while `a2a` is not
  advertised.
  - So `V2_PROJECT_A2A` now lives in `host/a2aProfile.ts`.
    `a2aV2RulesActive()` (the switch AND `v1Retired()`) is the ONE predicate
    read by both the v2 advert (`v2A2aRecord`) and the inbound version set
    (`servedA2AVersions`: the card GET, the JSON-RPC route, the 1.0 card's
    interfaces). The claim and the behaviour flip together.
  - While the switch is off (as shipped), inbound A2A behaves exactly as before.
    A header-less request gets the 0.3 card and codec, and an explicit 0.3 is
    served. On a retired host the inbound suites (`a2a-version-refusal`,
    `a2a-server-route`, `a2a-durable-route`, `a2a-1-0-server`,
    `adr-0744-*`, `a2a-profile`) pass 55/55.
  - The OUTBOUND client keeps the v2 floor on a major-2-only host
    (`clientA2AVersions`), and keeps `negotiation.decided`, because it governs
    only this host's own calls.
  - **Flipping `V2_PROJECT_A2A` is a deliberate, announced change.** Besides
    the A2A 1.0 server gaps below, it needs those third-party clients checked
    first: confirm whether they send `A2A-Version`, and tell them that a
    header-less request becomes 1.0 and an explicit 0.3 is refused.
  - Witness: `test/adr0858-negotiation-decided.test.ts` covers both states.
    With the switch off: it ships off, there is no advert, the header-less and
    explicit-0.3 card is the 0.3 card, and 0.3 RPC is not version-refused.
    With it on: the advert names 1.0 only, the header-less card is 1.0,
    explicit 0.3 is refused on the card and on RPC, and nothing changes while
    v1 is served. Four sabotages each went red: the inbound set keyed on
    `v1Retired()` instead of the switch; the advert not tied to the switch; the
    switch-on rules removed; and the outbound client gated on the switch.
    Major-2 lane 194/194.
- **Witnesses.**
  - `test/adr0858-negotiation-decided.test.ts` (11 legs) drives both seams end
    to end and reads the event on the v2 poll. Its legs cover:
    - accepted, downgraded and refused for each protocol, with the event
      schema-valid, the peer digested, and the origin nowhere in it;
    - A2A `below-floor` and unauthenticated refusals, and MCP `unauthenticated`
      and `below-floor` refusals;
    - the header-less card is 1.0;
    - an explicit 0.3 is refused on both the card and the RPC route.
  - `test/adr0670-v2-advert-validates.test.ts` validates both built records
    spliced into the document.
  - Nine sabotages each went red: the accepted emit dropped; the origin put in
    clear, including in the schema-legal `floor` field; the served-set filter
    removed; the card refusal removed; the MCP unauthenticated check removed;
    the MCP refused emit dropped; the legacy-profile filter removed; and two
    `refreshedAt` sabotages (stale, and the wrong shape).
- **Certify, major-2-only host** (`OPENWOP_V1_RETIRED=true`; with v1 retired the
  local bundle has no claimable profile and fails its own schema, so these rows
  are read from the RFC 0148 requirement ledger).
  - **With `a2a` projected, these executed for the first time and PASS:**
    `v2-negotiation-decided-emitted`, `v2-minimum-version-refused`,
    `v2-negotiation-authenticated` (the a2a legs of all three),
    `v2-legacy-profiles-absent`, `v2-refresh-sla`, the
    `v2-interop-trace-context` a2a malformed-value leg, and four
    `v2-a2a-operation-map` legs (list scoping, a refused `requires` row, the
    no-OpenWOP-envelope rule, and the VersionNotSupportedError shape).
  - **They FAIL** (A2A 1.0 server gaps, not negotiation):
    - `v2-a2a-operation-map`, 10 legs: context inference and mismatch,
      terminal-task refusal, state projection, the error codes, the ErrorInfo
      `data` shape, unreadable-equals-not-found (twice), push-config isolation,
      and push secrets;
    - `v2-a2a-push-delivery`, 4 legs plus 1 blocked.
    Both need the lane to route `OPENWOP_A2A_WORKFLOW_ID=conformance-approval`.
    Without it every task leg records `blocked`.
  - **Blocked in the local lane only:** `v2-interop-trace-context` (a2a
    traceparent) and `v2-a2a-client-error-details`. Their ad-hoc peers bind
    ephemeral ports that the WHD-19 exact-origin egress allowlist refuses.
  - **With `mcp` also projected**, `v2-negotiation-decided-emitted` (mcp) passes.
    `v2-minimum-version-refused` (mcp) records `blocked`: the floor is the
    legacy `2025-06-18`, the lowest revision the suite can offer, and raising
    it retires the legacy MCP revision before `MCP_LEGACY_PROFILE_SUNSET` (a
    product decision). The mount also fails `v2-mcp-mount-map` (5 legs) and
    `v2-mcp-tasks` (disconnect cancels the run).
  - **As shipped (both withheld)**, `scripts/check-conformance-major2.sh`
    passes 194/194 with 0 red, the same as before. The certify ledger on a
    major-2-only host is IDENTICAL to the pre-P4 baseline: 444 executed-pass,
    2469 inapplicable, 15 skipped, 0 blocked, 0 executed-fail, and no row
    changed state. That holds because every scenario that the served seam or
    the new rules could reach gates on the `a2a` / `mcp` advert first.
- **Held test.** `test/steward/agrade-wire-blocked-residue.test.ts` stays held.
  Its a2a and mcp legs pin adverts that v2 does not carry while both families
  are withheld. Re-point it at the v2 document when the families are projected.
- **What remains:** fix the A2A 1.0 server rows and the MCP mount rows; settle
  the MCP floor; get a corpus ruling on runless `negotiation.decided` and the
  prose/schema disagreement; then flip `V2_PROJECT_A2A` / `V2_PROJECT_MCP` and
  remove both from the ledger in `test/adr0858-v2-family-seats.test.ts`.

## Implementation plan

| Phase | Scope | Witness |
|---|---|---|
| P0 | This ADR | — |
| P1 | The per-family disposition above | this section |
| P2 | Whole-family WHD-7 leg + `KNOWN_UNPROJECTED_FAMILIES` ledger (gated surfaces ON, sabotage-witnessed); move the oracle to the v2 seat list so it survives ADR 0812 P3c | red on a deleted family |
| P3 | Project the PROJECT and PROJECT-WITH-DROPS families; re-point the batch-1 `test/support/v1Advertisement.ts` callers whose claim now has a v2 record; measure the major-2 conformance lane and fix or list its reds | lane ratchet; bridge caller count falls |
| P4 | Host work behind the ledger: `refreshedAt` constants + a staleness ratchet; the `negotiation.decided` emitter; filtering the legacy profiles; the `workspace.updated` emitter; then project `a2a` / `mcp` / `workspace` and un-hold the 3 held tests. The A2A header-less card rule goes to the steward first. | held tests pass on v2 |
| P5 | Settle RFC 0228 for whatever stays ledgered (404 the operations, or project); re-certify major 2 on production; tell the steward which scenarios became applicable | bundle |

## Open questions

- [x] `conformance`: v2 root metadata, present when the seams are mounted or a
      verified bundle exists. Not a gap (P1).
- [x] `observability`: metadata, nothing required; project `{otel}` (P1).
- [x] Storage families: one record each. The backend is derived from
      `resolveBackendId()`, and the unenforced limits are dropped (P1).
- [x] A2A header-less card. **Steward ruling (openwop-5e, 2026-10-07):**
      header-less → the `preferredVersion` (1.0) card, with no carve-out. RFC
      0152's legacy-card rule was a major-1 rule.
      - An explicit `A2A-Version: 0.3` is a negotiation: either set
        `minimumVersion` ≤ 0.3 and emit `negotiation.decided` with
        `outcome: downgraded`, or refuse it with `interop_version_unsupported`.
        If nothing third-party needs 0.3, refuse it (simpler).
      - `refreshedAt`: the shape is checked against `spec/v2/facets/a2a.schema.json`
        / `mcp.schema.json` before projecting.
      - `negotiation.decided` is a MUST on EVERY outcome (refused included), on
        the host's own event log. `peer` is a DIGEST of the peer origin, never
        the origin in clear. It is the normative witness for the two
        no-silent-downgrade invariants.
- [x] Corpus-side check, steward view: a corpus check cannot see a retired
      host's v1 document, so the host ledger (P2) is the right place. The corpus
      may add a per-bundle coverage report of the families recorded as
      inapplicable.
- [ ] Should the steward (openwop-5e) add a corpus-side check that a
      certification bundle states which advertised-in-v1 families its major-2 cut
      did not cover? (corpus, not this host)

> **Delivery correction 2026-10-09 (P3 blob):** a truncated S3 listing without a continuation token is a failure, not an exhausted page. The parser refuses missing/empty tokens, non-list documents and missing/invalid object sizes; regression tests retain a valid empty-page and decoded-token control. The configured production memory tier and the P5 shape deviations recorded above remain the limits of this claim.
