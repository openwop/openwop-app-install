# ADR 0343 — `canvas.app-builder` comprehensive application document (additive facets)

Status: Accepted (2026-07-10) — Phases 1a–1c implemented (see as-built notes); the inspector UI half of 1b rides Phase 2

**Program:** ADR 0342 Phase 1. **Depends on / composes:** ADR 0153/0305 (the
`canvas.app-builder` artifact schema lineage), ADR 0310 (chassis), ADR 0323 (the
additive-schema precedent: new facets never break old artifacts), ADR 0325 (the AI
chain that emits the document), ADR 0173 (export consumes it).
**Research:** `docs/research/app-builder-myndhyve-gap-analysis-and-remediation.md`
§5.6 (data/backend), §5.1 CV-07/09, §5.2 PR-08, §5.5 DS-02/04/08.
**Toggle:** `app-builder` (unchanged). **Surface:** host-owned artifact type + editor;
no wire (the normative `canvas.app-builder.export[]` facet is untouched).

---

## Context

Today's `AppDoc` describes screens, closed components, navigation connectors, a theme
enum + `themeColors`, and `dataSources[]` sample rows. That is a *screen prototype*,
not an *application*: there is no governed domain model, no operation/API contract, no
typed binding or action graph beyond `navigateTo`, no auth policy for the generated
app, no environment contract, no reusable component structures, and no record of what
was generated from which document version. Meanwhile the editor already loses two
declared facets on load (`coerceApp()` drops `themeColors`/`dataSources` —
`definition.tsx:29-37`, fixed in ADR 0342 Phase 0). Single owners already exist and
are composed, not duplicated: `validateAppDoc.ts` (validity), `host.canvas`
(persistence/CAS/versions), Media (bytes), Connections (credentials).

## Decision

Extend `canvas.app-builder` with **additive facets** so one document is the complete,
closed, secret-free application-design model. All facets are optional (old documents
validate unchanged), capped, and reference-checked. `additionalProperties: false`
everywhere; unique IDs per facet; bounded counts/depth/string lengths.

### New facets (schema sketch — authoritative shapes land in `artifactTypes.ts`)

| Facet | Shape (bounded) | Gap IDs |
|---|---|---|
| `schemaVersion` | integer; migrations run **only when a working copy opens** — run artifacts stay immutable, `:fork` copies verbatim | — |
| `designSystemRef`, `brandRef` | symbolic refs `{id, mode: 'linked'\|'detached'}` + bounded token overrides; resolved server-side by the design-system/Brand owners — never copied wholesale into the document | DS-02/03/04 |
| `stateVariables[]` | `{id, name, type: string\|number\|boolean\|list, initial}` ≤ 50; names `\w`-safe (the RFC 0124 lesson: they become template vars) | PR-02 |
| `models[]` | `{id, name, fields[]{name, type, required?, default?, validation?}, relationships[]{toModelId, kind, name}}` ≤ 30 models / ≤ 40 fields; referential integrity validator-owned | DA-02/03 |
| `operations[]` | `{id, name, purpose, kind, inputSchema, outputSchema, authRequirement, adapterRef?, mock, errors[]}`; `adapterRef` names an installed adapter — **never a raw credential or arbitrary URL** unless an approved HTTP-connection policy permits | DA-04 |
| bindings (on catalog-approved props) | typed path AST over `state.*`/`model.*`/`operation.*` outputs + fallback + format; one-way default, two-way only where the catalog marks it safe; supersedes-but-keeps `list.bind` (`{{field}}` interpolation stays valid) | DA-05/08 |
| `actions[]` (per component event, closed graph) | registered kinds only: `navigate`, `set-state`, `submit-form`, `invoke-operation`, `open-modal`; typed params, simple predicates; **no expression language, no JavaScript, no eval** | CV-09, DA-06 |
| `authProfile` | roles/claims, route guards, per-operation auth requirements — describes the **generated app**, never host RBAC | DA-09 |
| `envRequirements[]` | symbolic `{key, purpose, requiredFor[]}` — values live in host Connections/secret management, never in the document | DA-13 |
| `componentDefinitions[]`, `layoutRefs[]` | closed component subtrees referenced by ID; cycle + depth caps; export resolves references | CV-07 |
| `outputLineage[]` | `{canvasVersion, target, generatorPackVersion, assetId, hash, warnings}` append-only refs — source blobs stay in Media | EX-04 |
| `sharePolicy` | per-dataSource include flags, default sample-data **redaction**; the public renderer receives a server-sanitized projection | DS-08 |

### Companion contracts defined here, consumed by later phases

- **Generator capability manifest (PR-08):** each export target declares supported
  component/action/binding/auth capabilities; export preflight blocks/warns by
  severity. All **7** targets (incl. `nextjs`, shipped #1533) get manifests.
- **Source-map convention (DA-10):** generated files carry stable IDs + paths back to
  canvas fields, so OpenAPI/backend generation and diff/repair can round-trip.

### Validation discipline (the ADR 0305 Phase-C correction stands)

Cross-facet references (action → missing operation, binding → missing model field,
`layoutRef` → missing definition) are **soft warnings** in `validateAppDoc` — mid-edit
states must stay saveable. Catalog/schema violations (unknown action kind, uncapped
arrays, credential-shaped strings, executable content) are **hard 422s** on the editor
PATCH and hard failures at workflow emit. The validator also rejects known
token/private-key shapes (defense in depth beside export scrubbing).

## Alternatives weighed

- **Separate host resources per facet** (a models store, an operations store).
  Rejected: the one-document invariant is the program's spine; splitting recreates
  MyndHyve's drift-prone split stores (OP-01 non-port). Big/binary outputs already
  have owners (Media, runs) and are referenced by lineage.
- **An expression language for bindings/conditions.** Rejected: closed-world safety;
  a typed path AST + registered predicates cover the catalog's needs and every
  generator can honestly implement or reject them.
- **Versioned side-schema (a `canvas.app-builder-v2` type).** Rejected: `schemaVersion`
  + open-time migration keeps one type, preserves replay, and matches the ADR 0323
  additive precedent.

## Replay / fork / RBAC

Run artifacts are immutable; migration happens only on working-copy open; `:fork`
reads recorded fields verbatim. No new routes in this ADR (facets ride the existing
canvas GET/PATCH + CAS); every later route that exposes facet-specific operations
inherits the OP-06 route-test contract.

## RFC verdict

**None required.** Host-owned artifact type, additive; no wire field, capability, or
normative facet is touched. (The Phase-5 canvas-content pack kind and any
collection-review wire shape are ADR 0342's flagged RFC watch-items, not this ADR's.)

## Phases

| Phase | Scope | Gate |
|---|---|---|
| 1a | schema + `validateAppDoc` growth + caps + migration fn + fixtures | old fixtures validate; cap/ref-integrity unit tests |
| 1b | editor projections: `coerceApp` carries all facets; inspector reads/writes state/models/operations/actions via chassis property widgets (Phase-2 widgets may land minimal-first) | load/edit/save/reload parity fixture — byte-equivalent for recognized fields |
| 1c | AI emit path: plan/render/deepen nodes may populate the new facets through the SAME normalization gate; capability-manifest + source-map contracts published for Phase 6 | chain fixture: emitted artifact opens, validates, forks verbatim |

## As-built notes (Phase 1a–1c implementation, 2026-07-10)

1. **`operations.input/output` are closed typed FIELD LISTS**, not the sketch's
   `inputSchema`/`outputSchema` — embedding open JSON-Schema objects inside an
   `additionalProperties:false` document would reopen the closed world.
2. **`sharePolicy` and `outputLineage` deliberately did not land** (recorded in
   the schema comment): sharePolicy ships WITH the Phase-3 sanitized-share
   enforcement (schema without enforcement is a false safety promise);
   outputLineage ships with its Phase-6 writer.
3. **`layoutRefs[]` collapsed into `componentDefinitions[]`** — a layout is a
   component definition used as one; a second facet for the same concept would
   be a dual owner. The referencing component type + scoped-frame editing are
   Phase-2 work; definitions are stored + validated (and count against the
   document node budget) from 1a so AI/templates can emit them additively.
4. **`migrateAppDoc` is a pure, tested v1 mechanism, NOT yet wired** into the
   canvas-editor factory: with every facet additive, v1→v1 is the identity, and
   a factory hook with only identity behavior is a consumer-less surface (the
   ADR 0307 rule). Wiring lands with the first real migration.
5. **The capability-manifest honesty suite exposed real parity gaps** the
   uniform "all targets support everything" assumption hid: `react-tailwind`,
   `react-styled`, `react-native`, `flutter`, and `nextjs` do NOT carry
   `themeColors` into generated output, and `react-styled`/`react-native`/
   `flutter` do not map `hideOn`/`columnsMobile`. The manifests record the
   truth; closing the gaps is Phase-6 backlog (EX-02-adjacent).
6. **1c's "AI emit" half moved to Phase 4** — teaching plan/render/deepen to
   populate the new facets is pack-node work (`feature.app-builder.nodes`
   version bump + re-pin), which is exactly the Phase-4 supply-chain gate. 1c
   as landed = the manifest + source-map contracts + their honesty tests.
