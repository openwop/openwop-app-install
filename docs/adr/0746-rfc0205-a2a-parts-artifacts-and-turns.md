# ADR 0746 — RFC 0205: run artifacts and conversation turns speak A2A Parts

Status: implemented

Implements `openwop` **RFC 0205** (`Active`, wire shape locked, no advertisement
gate) on this host. No new wire: the RFC mints the shapes; this ADR records how
this host honours them. Phase WS3 of the 2026-09 RFC witness program.

## Context

Measured at `bfd8b8545`:

- `getArtifact` (`GET /runs/{runId}/artifacts/{artifactId}`) was a stub —
  401 without a Bearer, 405 for a non-GET, 404 for everything else.
- The `conformance-artifact-emit` fixture was vendored but its node
  `conformance.artifact.emit` was not registered, so no run could announce an
  artifact the suite could read back.
- The v2 root did not carry `conversationPrimitive`, although the v1 root
  claims it unconditionally and nothing on `major2Ledger.ts` opted it out.
- No turn carried `parts`; `makeTurn` was content-only.

The two RFC 0205 behavioural scenarios (`v2-artifact-a2a-shape`,
`v2-conversation-turn-parts`) therefore both recorded `inapplicable`.

## Decisions

**D1 — `getArtifact` resolves ANNOUNCED artifacts through the existing seams,
not a new store.** Order: 401 (no Bearer) → 405 → `artifacts:read` (RFC 0049)
→ tenant-scoped run load → non-disclosing 404. `loadReadableRun` gained an
`opts` argument (`scope`, `streamToken: false`) rather than a second loader:
the artifact read authorizes on `artifacts:read`, not `runs:read`, and the SSE
`?streamToken` grant must not open it. Then (`host/runArtifactRead.ts`):

1. *Announcement* — the run's own log must carry an `artifact.created` naming
   the id. The wire names artifacts only through that event.
2. *Ownership* — announcing is not owning (any node can emit any id). A
   `run-event:<runId>:<nodeId>` row must be in the run's tenant AND belong to
   the run or a `parentRunId` ancestor (so an inherited fork prefix still
   reads). A Documents-backed artifact resolves through the ONE ADR 0069
   projection (`getArtifactRevision`), so the org + `ownerSubject` gate that
   guards `/artifacts/*` guards this third door too; no subject ⇒ 404.
3. *Content* — `run-event:` rows are the ADR 0083 `runartifact`
   `DurableCollection`, already cascaded by run delete and retention
   (`storage/{postgres,sqlite}/index.ts`), so there is no new store to register
   with erasure or retention; documents come from their immutable versions.

**D2 — negotiation is major-2 only.** RFC 0205 §A.4: v1 is unchanged. At
contract 2, `req.accepts(['application/json', 'application/a2a+json'])` picks
the A2A `Artifact` when the client prefers it; `Vary: Accept` rides every
negotiated 200. The `application/json` answer is host-defined
(`{artifactId, runId, nodeId?, artifactType, name?, mediaType, payload}`) —
§A.1 leaves it implementation-defined. The v1 read now answers 200 with that
object instead of an unconditional 404, which `artifact-auth` (401-only) is
indifferent to.

**D3 — the A2A body.** One Part: JSON content → `{data, mediaType:
'application/json'}`, text content → `{text, mediaType}`. Encoders
(`dataPart10`, `artifact10`) sit in `host/a2aCodec10.ts` beside `textPart10` /
`message10` — one codec. **No `url` Part is ever produced** (§A.3, register
G3), so the scoping MUST is satisfied by construction.

**D4 — `metadata.openwop.schemaVersion` is omitted (a deviation from a
SHOULD).** This host's artifact-type registry (`host/artifactTypes.ts`) carries
no schema version; any integer would be invented. `artifactTypeId` is carried
only when it matches the `typeId` grammar (`ids.schema.json`), so a host-native
or free-form type never makes the body schema-invalid.

**D5 — the conformance node.** `conformance.artifact.emit` (registered in
`registerConformanceNodes`, so production without
`OPENWOP_ENABLE_CONFORMANCE_NODES` never has it) persists `config.data` via a
new `persistAnnouncedArtifact` — the SAME insert-only `writeRow` as the
executor's persist, so the executor's later terminal persist for the same key
loses the CAS — and emits `artifact.created {artifactId, artifactType, nodeId,
summary?, registered}`. The wire `artifactType` is stored in a new optional
`announcedType` field so `artifactTypeId` keeps its "host-registered only"
meaning for the workbench renderer. The documents `generate` node is unchanged:
it already announces `artifactId` = the immutable version id plus
`documentId`/`versionId`, which D1 resolves.

> **CORRECTED 2026-09-26 (ADR 0755, WIT-ART-1).** "Production without
> `OPENWOP_ENABLE_CONFORMANCE_NODES` never has it" is true and beside the point:
> the reference deploy SETS that flag (`DEPLOY.md` — it is a conformance target),
> and nothing stops a tenant-authored workflow from naming a `conformance.*`
> typeId, so on `app.openwop.dev` any tenant could run this node. Stamping
> `artifactTypeId` when the announced type happened to be host-registered let an
> arbitrary `config.data` (up to the ~1 MB inline ceiling) show in the tenant
> Library as a typed deliverable of that type, never validated against its schema.
> `persistAnnouncedArtifact` now records `announcedType` ONLY; `getArtifact` reads
> `announcedType` first, so the wire answer is unchanged
> (`adr0746-rfc0205-a2a-parts` pins the row). Whether conformance typeIds should be
> refused in tenant workflows at all is a posture question left open (ADR 0755).

**D6 — v2 `conversationPrimitive`.** `{status: 'experimental', since: '2.0',
until: '2.1', witness: 'claims-check'}` — the declaration's witness and
`facets: []` (`spec/v2/declaration.json`), the same claim as the unconditional
v1 flag.

**D7 — `parts` on every turn with an honest projection.** `makeTurn` derives
`parts` from `content` with the pure `partsFromTurnContent`:

| content | parts |
|---|---|
| string | `[{text}]` |
| `ContentPart[]` of only text | one `text` Part each |
| `ContentPart[]` with image/file/audio | **omitted** |
| other JSON | `[{data, mediaType:'application/json'}]` |
| null/undefined | omitted |

Media omits `parts` entirely: a `raw` Part would inline the base64 a second
time into the run log (the codec's own rule), a `url` Part would publish a
reference whose authorization this seam cannot state, and a text-only half
would make the A2A reading say something the turn did not. §B.7 makes a
parts-less turn valid forever. `content` is unchanged (§B.6). The cost is that
text turns now carry their text twice in the log — the RFC's chosen design
(SHOULD emit `parts`, keep `content`). Replay/fork: turns are read back
verbatim, `parts` is a deterministic function of `content`, and the channel
projection (`appendChannelMessage`) carries `content` only; secret redaction
(`stripSecretsFromPersisted`) is value-based and covers `parts` identically;
`vendorKeyCarry` does not descend into the external turn `$ref`, so `parts`
survives the v2 read. The mock lifecycle's agent turns now carry `speakerId`
(= `from`), without which they were v2-invalid (RFC 0101 conditional) with or
without `parts`.

## Alternatives weighed

- **A new `(tenant, runId, artifactId)` store.** Rejected: a second artifact
  store beside `runartifact` + the projection, needing its own delete, retention
  and DSAR wiring — the orphan class `/grade-data` exists to find.
- **Serve the payload from the `artifact.created` event.** Rejected: the event
  outlives an erased document, so the read would resurrect erased content; and
  the closed v2 `artifactCreated` def has no seat for a payload.
- **`raw` Parts for media turns.** Rejected (D7).
- **Negotiate at v1 too.** Rejected: RFC 0205 §A.4 / Unresolved question 1.

## `/architect` verdict (before code)

Proceed. Two required changes, both adopted: **HIGH-1** — the announcement
alone is not ownership; a `run-event:` row must belong to the run or its
`parentRunId` ancestry (D1.2), pinned by a test that a run announcing another
run's artifact reads 404 (sabotage: dropping the ancestry check turns it 200).
**HIGH-2** — negotiation stays major-2 only with `Vary: Accept` (D2). MEDIUM:
bound the event scan (500-event pages, 50k cap), reuse `writeRow` (D5), record
the `schemaVersion` omission (D4), route-level tests for auth order, tenant
non-disclosure and both media types.

## Implementation record

| Phase | What | Test |
|---|---|---|
| 1 | codec encoders + `parts` on turns | `test/adr0746-rfc0205-a2a-parts.test.ts` §B |
| 2 | `getArtifact`, `persistAnnouncedArtifact`, conformance node | same file §A (HTTP, both tenants, both majors, documents path) |
| 3 | v2 `conversationPrimitive` | same file + `adr0670-v2-advert-validates` |

Sabotage-proven: removing `parts` from `makeTurn` reds the two turn legs;
removing the ancestry check reds the ownership leg.

## Open questions

- `schemaVersion` (D4) closes when the artifact-type registry grows a version.
- A `system` turn gets `parts` like any other; RFC 0205 Unresolved question 2
  (its A2A role) is the corpus's to settle.

## Follow-up (2026-09-26, ADR 0755 — END `/grade-code` pass)

- **WIT-ART-1** — see the D5 correction: announced rows never carry `artifactTypeId`.
- **WIT-ART-2** — the 1:1 fallback agent turn (`conversationExchange.ts`) now carries
  `speakerId: 'assistant'` when no roster is declared. ADR 0746 put `parts` on every
  turn and fixed `speakerId` only in the fixture node, so every real 1:1 reply was
  v2-invalid. `test/adr0755-fallback-turn-speaker.test.ts` (sabotage-proven).
- **WIT-ART-5** — the Documents lane now also requires the announced VERSION to have
  been produced by the run or an ancestor (HIGH-1 applied to the second lane).
- **WIT-ART-6** — each non-disclosing 404 logs its reason at debug (closed set), never
  in the response.
- **WIT-ART-8** — legs added: an `owk_` key without `artifacts:read` → 403 + challenge
  (with the control), and a valid `?streamToken` presented by another tenant → 404
  (sabotage: honouring the grant turns it red).
- **WIT-ART-9** — the 405 carries `Allow: GET, HEAD` and goes through `sendError`
  (vendor-prefixed at major 2, since `method_not_allowed` is not a registered v2 code);
  HEAD is served.
- **WIT-ART-10** — the byte ceiling is measured in bytes (`Buffer.byteLength`), and an
  untyped artifact omits `artifactType` instead of inventing `'unknown'`.
- **Open:** the linear announcement scan (WIT-ART-4 — needs an `artifactId → seq`
  index), `parts` stored twice per text turn (WIT-ART-7), and the two access
  predicates over `run-event:` rows (WIT-ART-3 — run access is sufficient for a run
  reader today; recorded, not unified).
