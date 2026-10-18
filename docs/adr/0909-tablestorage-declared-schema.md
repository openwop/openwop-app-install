# ADR 0909 — tableStorage rows conform to the DECLARED schema (RFC 0228 G4)

Status: implemented (P1 #4947 `1228e17b4`, train 136; P2 cut 141c CERTIFIED)

## Context

`spec/v2/core/storage.md` §`tableStorage` lists `createTable(name, schema) → ok`
as an operation, and says rows MUST conform to the table's declared schema: an
insert or update whose column types diverge from it MUST be refused.

This host had no `createTable`. Both table backends
(`host/inMemorySurfaces.ts` and `host/durable/durableTable.ts`) took a table's
schema from its **first insert** (the RFC 0016 §B point 2 behaviour). That
leaves two holes against the v2 rule:

1. **The first row is unchecked.** Whatever types the first insert carried
   became the schema, so a first row with a wrong type was accepted and then
   defined the table.
2. **`update` and `upsert` checked nothing.** A patch could change a declared
   column to any type.

`tableStorage` has no protocol path, so the suite cannot see either hole on its
own. RFC 0228 G4 added the `conformance-table-schema-probe` fixture and its
reserved node `core.conformance.table-schema-probe` (openwop
`conformance/fixtures.md` §"The tableStorage schema probe fixture"). The
scenario `v2-table-schema-enforcement` reads `inapplicable` on this host until
the fixture is advertised. The request came from the corpus steward (ec) through
the release coordinator (67), with the user's approval.

## Decision

### D1 — `createTable(table, columns)` on both backends

`TableSurface` gains `createTable({ table, columns })`, where `columns` maps a
column to `string | number | boolean | object` (the types `inferColType`
already distinguishes). It validates the declaration (an unknown type is
refused), stores it in the existing per-(tenant, table) schema registry, and
returns `{ ok: true, created }`.

- **Idempotent by value.** Re-declaring the same columns, in any key order,
  returns `created: false`. A different declaration is refused
  (`table_schema_violation`).
- **Durable: one compare-and-swap.** The registry write is
  `kvCompareAndSwap(schemaKey, null, declared)`, so two instances declaring the
  same table cannot both win; the loser compares by value.
- **Per tenant.** The registry was already keyed by tenant; another tenant may
  declare the same table name differently.

### D2 — insert, update and upsert are checked against the declared schema

One helper, `assertRowConforms(schema, row)`, refuses a row or patch whose
declared columns carry another type, with `table_schema_violation`. insert,
update and upsert all call it on both backends. Two things are unchanged on
purpose:

- **Undeclared columns stay additive**, as they always were on insert. The spec
  rule is about diverging types, not extra columns.
- **Without `createTable`, the first insert still declares the schema**
  (RFC 0016 §B point 2), so existing callers and the ADR 0858 storage probe,
  which inserts into `conformance_probe` without declaring it, behave as before.

`insert` also mints a row id (`randomUUID`) when the row carries none. The spec
says `insert(table, row) → rowId`, and before this a row without an id was
stored under the literal key `undefined`.

The v2 boundary already re-spells `table_schema_violation` as
`validation_error` with `details.service: tableStorage`
(`middleware/protocolVersion.ts`, RFC 0228 §Decisions). Nothing changes there.

### D3 — the probe node, gated like the storage probe

`bootstrap/conformanceTableSchemaProbe.ts` registers
`core.conformance.table-schema-probe`. Per the fixture contract, every action
first calls `createTable(table, { k: string, n: number })`, then:

- `control` inserts `{ k: 'control', n: 1 }` and outputs `{ inserted: true, rowId }`;
- `insert-mistyped` inserts `{ k: 'mistyped', n: 'not-a-number' }`;
- `update-mistyped` inserts `{ k: 'to-update', n: 2 }`, then updates `n` to a string.

The node calls only the run tenant's own `ctx.storage.table` and does **no type
checking of its own**: if the host accepts a mistyped write, the node completes
and says so, so the scenario reads executed-fail. A rejection fails the node
with the rejection's code and details, unchanged.

Gating follows the ADR 0858 storage-probe precedent:

- **Its own switch,** `OPENWOP_CONFORMANCE_TABLE_SCHEMA_PROBE` (on unless
  `false`), not `conformanceNodesEnabled()`, which is off in production. The node
  touches only the caller's own storage, like any storage pack node.
- **Exempt in the fixture filter** (`fixtureNeedsConformanceNodes`, host/index.ts),
  beside the storage probe's typeId.
- **Advertised only beside `tableStorage`.** The fixture contract says a host
  that does not advertise `tableStorage` MUST NOT advertise this fixture, so
  `listLoadedConformanceFixtures` withholds it unless
  `v2AdvertisedStorageFamilies()` includes `tableStorage`. Resolvability decides
  the rest, as for every fixture.

## Alternatives weighed

- **Refuse undeclared columns too.** Stricter than the spec, and it would break
  callers that add columns over time. Rejected.
- **Require `createTable` before any insert.** It would turn every existing
  caller of the first-insert path into a failure. Rejected; first-insert stays
  the fallback when nothing was declared.
- **Gate the probe behind `conformanceNodesEnabled()`.** Production runs with it
  off, so the fixture would never be advertised where it matters. ADR 0858 made
  the same call for the storage probe.

## Trade-offs

- Updates and upserts that used to change a declared column's type now fail.
  That is the point of the rule; nothing in this repo relied on it. The pack
  nodes `core.storage.table-*` pass through the same surface and inherit the
  check.
- The in-memory registry stays process-local, as it was. The durable registry is
  shared across instances.

## Phases

| Phase | Scope | Status |
|---|---|---|
| P1 | D1 + D2 on both backends; D3 node + gate; tests and sabotage | implemented (#4947 `1228e17b4`, LIVE `1a29f96b5`) |
| P2 | Verify at major 2: the four rows the 115d cut read `inapplicable` read `executed-pass`, and nothing else moves | MATCHED locally and in cut 141c (+4 executed-pass, −4 inapplicable, no other diff) |

## Implementation record

| Phase | Commit | Witness |
|---|---|---|
| P1 | #4947 `1228e17b4` (train 136) | `test/rfc0228-g4-table-schema.test.ts` |
| P2 | cut 141c on `ddcf7f944`, bundle `7f1ef71c532b` | 457/0/11/371; diff vs 115d = exactly the four predicted rows |

Measured 2026-10-18 on `41ff932ee` + this branch: `tsc --noEmit` clean; the new
file plus the 11 existing table, storage-probe, durable-surface and
fixture-advert tests: 12 files, 207 tests, all passing.

Sabotage, both backends at once, restored from git after each:

- **insert check removed** (the declared-schema branch of `insert`): 6 red. The
  first-insert-cannot-redefine leg and the first-insert-declares leg on each
  backend, and the probe's `insert-mistyped` leg on each backend.
- **update check removed:** 4 red. The update-refused leg on each backend, and
  the probe's `update-mistyped` leg on each backend.

`conformance-fixture-advert-gating.test.ts` keeps its own restatement of the
exempt typeIds; the table-schema probe joins the storage probe there.

Prediction against the 115d cut: four rows go `inapplicable` → `executed-pass`
(`v2-table-schema-enforcement` and the three
`storage.table-schema-*` requirement rows), and nothing else changes.

## Open questions

- [x] P2, local: `scripts/check-conformance-major2.sh` on this branch
  (2026-10-18 ~04:00Z): 203/203 v2 files, red set == known-red (0).
  `v2-table-schema-enforcement`: 3 tests executed (control `completed`, both
  mistyped runs `failed`). Disposition summary against a same-evening lane on
  main (03:32Z): executed-pass 698 → 702, inapplicable 4159 → 4155, skipped 24
  → 24, so four rows moved and nothing else did. The host's withheld-fixture
  set differs by exactly `conformance-table-schema-probe` (14 → 13).
- [x] P2, cut: cut 141c on `ddcf7f944` is CERTIFIED (bundle `7f1ef71c532b`,
  served == bucket): 457 pass / 0 fail / 11 / 371. Against 115d it shows exactly
  the four predicted rows `inapplicable` → `executed-pass` and no other diff,
  so the prediction above held. The G4 close and RFC 0228 → Accepted are the
  corpus side's to record.
