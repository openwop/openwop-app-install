# ADR 0628 — the v2 era key, the storage seat, and the per-store disposition

Status: implemented

v2 charter Phase 4, PR **P4-C**. Follows ADR 0625 (RFC 0165 v1.x preparation) and
the P4-B dual-stack wire (`middleware/protocolVersion.ts`).

Corpus: `spec/v2/core/persistence.md` §"The era key", §"The reader rule",
§"The writer rule", §"The seat", §"Per-store disposition"; `versioning.md` §2.2
(axis 4); `replay.md` §"Forking a v1 run"; RFC 0176 §A. Pinned at
`schemas/CORPUS_TAG` = `v2.0.0-rc.3`.

## Context

The v2 cut renames 36 of the 118 event types the protocol registers, and 27 of
those 36 are names this host emits. Those names are persisted, indexed and
unique-keyed; fork and replay read them verbatim. `persistence.md` answers this
with a per-run **era key**, `eventLogSchemaVersion`: absent ⇒ `2` (the v1 era,
never backfilled), `2` = v1 vocabulary, `3` = v2 vocabulary. A v2 host MUST stamp
`3` on every run it creates, discovery MUST advertise that one value and nothing
else, and every reader MUST translate an era-`2` log through
`spec/v2/event-codemap.json` at the storage boundary.

Before this ADR the host had none of it: no era column in either backend, no
codemap, no `eventLogSchemaVersion` anywhere in the backend source, and no
advertisement of the axis at all.

## The problem the corpus does not answer, and what this host does about it

`persistence.md` writes the reader rule for a host that serves **major 2 alone**:
an era-`2` log is translated v1→v2 on read; an era-`3` log is read untranslated.
This host serves **both majors** through the overlap, which `versioning.md` §5
requires and §1.2 constrains: "v1 operations keep their `/v1/…` path keys
unchanged".

Those two obligations meet on a run created today. §"The era key" makes this host
stamp `3`; §"The writer rule" makes an era-`3` log v2 vocabulary. So the v1
representation of that run's log can only stay unchanged if the v1 reader maps
the stored v2 name back to its v1 spelling — and the corpus names no such
obligation anywhere. Reported upstream as a Phase 4 corpus gap rather than
guessed at.

The three candidate readings, and why this one:

- **Stamp `3`, store v1 spellings.** Cheapest, and a lie: the era key would name
  a vocabulary the log is not written in, and §"The reader rule" forbids
  translating an era-`3` log — so the v2 wire would carry v1 names. It would
  also pass the conformance scenarios by luck, because `conformance-noop` emits
  only identity-mapped types. That is precisely the failure mode this PR was
  asked to avoid.
- **Stamp `3`, store v2 spellings, serve them on both wires.** Breaks the v1
  wire for every new run. Not an option.
- **Stamp `3`, store v2 spellings, invert on the v1 read.** Chosen. The map is a
  bijection — 118 rows, 118 distinct v2 names, asserted at load — so the inverse
  is exact and total, and the v1 wire is byte-identical.

## Decisions

1. **The era key is one constant, in one place.** `EVENT_LOG_SCHEMA_VERSION = 3`
   (`storage/eventEra.ts`) is what the storage seat stamps AND what discovery
   advertises; discovery imports it rather than re-typing it. persistence.md
   orders these — "collapsing to one constant is a precondition for advertising,
   not a consequence" — and a single exported constant is that collapse.

2. **THE SEAT IS `Storage.listEvents`** (`storage/storage.ts`), with its two
   writers `appendEvent` / `appendEventsBatch` and the stamp on `insertRun`. It
   is the storage interface's event-list method, not a wrapper: every read of the
   `events` table in the backend goes through it (35 call sites in 23 modules —
   poll, SSE buffered replay and gap fetch, fork, replay divergence, the debug
   bundle, the analytics and summary folds), and the only other statements that
   touch the table are `SELECT MAX(sequence)` and the retention `DELETE`, neither
   of which reads a `type`.

3. **The seat is installed by decorating the Storage object in `openStorage()`**
   (`storage/index.ts`), the sole constructor of a Storage in the running host —
   so there is no unwrapped Storage for a call site to reach, and sqlite and
   Postgres cannot drift apart on the era rules. The decorator is a plain
   own-property object (`{ ...inner, ...overrides }`), NOT a `Proxy`: a Proxy
   with only a `get` trap forwards reads but sends writes to the target, so a
   test that swaps a method on the storage it was handed installs its stub on the
   inner object while reads still resolve to the override — and the override's
   own call re-enters the stub forever. Measured, not theorised; it stack-
   overflowed five legs of `idempotent-run-admission.test.ts`.

4. **The stamp is on `insertRun`, so every creation path inherits it.**
   persistence.md: "a host with more than one creation path MUST begin stamping
   `3` on ALL of them in the same change". This host has **23** run-creation call
   sites — 19 through `host/runInsert.ts` and 4 deliberate direct
   `storage.insertRun` callers (`host/workforceEval.ts`, `host/anonymousActor.ts`
   per ADR 0604, `routes/testSeam.ts`, `routes/anonSurfaceSeam.ts`) — and all 23
   funnel into the one interface method. Stamping there makes the universality
   structural rather than a matter of inspection, and a creation path added
   tomorrow inherits it.

5. **No backfill, ever.** The migrations add a NULLABLE column and run no
   `UPDATE`. A historical row keeps its absent era and reads as `2`; the reader
   never requires a stored value, and an era-`2` row is never rewritten in place.
   `eraOf()` is the single place absence becomes `2` — the adapters map a NULL
   column to `undefined`, never to `2`, so a pre-cut row stays distinguishable
   from one the host deliberately stamped.

6. **The snapshot field is synthesized, and is emitted under major 2 only.**
   `schemas/v2/run-snapshot.schema.json` REQUIRES `eventLogSchemaVersion`;
   persistence.md says the host "MUST supply `2` from the absent-⇒-`2` rule
   rather than fail the read". `projectRunSnapshot` does that. It is gated on
   the negotiated major because the v1 schema makes the field OPTIONAL and the v1
   document never carried it — adding it there would be a real, if additive,
   change to a wire §1.2 says stays unchanged.

7. **The reader's contract comes from the request, not from the call site.**
   `protocolVersionMiddleware` runs the rest of the request inside an
   `AsyncLocalStorage` carrying the negotiated major, and the seat reads it. A v2
   route therefore cannot forget to ask for translation — which is what §"The
   seat" is really asking for. `listEvents(runId, { contract })` overrides it for
   the one read that escapes the request's async context: the SSE gap fetch,
   whose continuation is scheduled from the appender.

8. **Under major 2 the SSE in-process fast path is taken out.** The record the
   in-proc fan-out delivers carries the APPENDER's vocabulary, because
   `appendEvent` returns what its caller handed it (which keeps webhooks, the
   cost emitter and the v1 stream byte-unchanged). Delivering it on a major-2
   stream would put an untranslated name on the wire and make that the one read
   that bypasses the seat. A major-2 stream therefore routes every frame through
   the serialized gap fetch, i.e. through `listEvents`. The major-1 branch is
   untouched: same bytes, same timing.

9. **The writer rule is structural.** `toStorageVocabulary(type, era)` stores the
   era's spelling: the codemap's v2 name in an era-`3` log, the v1 name in an
   era-`2` one. Passing the caller's argument through would have been correct
   only for the identity rows and would have corrupted all 27 renamed types this
   host emits. A registered v2 type with no v1 preimage is REFUSED rather than
   written into an era-`2` log — the set is derived from
   `schemas/v2/run-event.schema.json` minus the codemap's v2 column and is empty
   today, and the branch exists so it stays empty. A name the codemap does not
   govern at all (this host's `host.<domain>.<entity>.<verb>` events, vendor
   events) is stored verbatim: the v1 contract never closed the type space, and
   refusing there would break a live v1 host to satisfy a rule about v2 names.

10. **The codemap is data.** `schemas/v2/event-codemap.json`, copied verbatim from
    the pinned corpus tag by `scripts/sync-schemas.sh` (which now also carries it
    across from the corpus `spec/v2/` tree, since `@openwop/spec-artifacts` is a
    devDependency and is not in the runtime image). There is no private mapping.

## Per-store disposition (persistence.md §"Per-store disposition")

| Store | v1 artifact | Disposition |
| --- | --- | --- |
| `events` | v1 vocabulary; `UNIQUE (run_id, sequence)` | `translated` |
| `runs` | no `event_log_schema_version`; owner fields on `metadata.owner` | `legacy-stamped` |
| `interrupts` | two-segment opaque store-backed tokens | `drained` |
| `webhooks`, `webhook_deliveries` | subscriptions; serialized deliveries | `unchanged`; `drained` |
| `idempotency`, `idempotent_response`, `invocation_log`, `invocation_claim`, `dispatch_outbox`, `effect_escape_ledger` | keyed records | `unchanged` |
| `audit_log` | audit facts | `never-upgraded` |
| `annotations`, `chat_*`, `messaging_*`, `notifications`, `workspace_files` and the host-extension tables | outside the wire | `unchanged` |
| certification bundles | v1 bundles | `never-upgraded` |

## Implementation record

| Item | Where |
| --- | --- |
| Era column, additive, no backfill | `storage/sqlite/schema.ts` mig **44**; `storage/postgres/schema.ts` mig **41** |
| `RunRecord.eventLogSchemaVersion`; NULL ⇒ `undefined` on read | `src/types.ts`; `storage/sqlite/index.ts`; `storage/postgres/index.ts` |
| Era constant, codemap load + bijection assertion, `eraOf`, `toStorageVocabulary`, `toContractVocabulary` | `storage/eventEra.ts` (new) |
| THE SEAT — stamp, writer rule, reader rule, per-run era cache, request-contract async store | `storage/eventEraAdapter.ts` (new) |
| Seat installed at the one Storage constructor | `storage/index.ts` |
| `contract` on the interface's event-list method | `storage/storage.ts` |
| Request contract parked for the seat | `middleware/protocolVersion.ts` |
| `eventLogSchemaVersion` on the v2 snapshot (synthesized) | `routes/runs.ts` `projectRunSnapshot` |
| `eventLogSchemaVersion: 3` on the v2 discovery root | `routes/discovery.ts` `buildV2Advertisement` |
| Major-2 SSE reads every frame through the seat | `routes/streams.ts` |
| `event_type_unmapped` (`spec/v2/errors.json`, 500) | `src/types.ts` `OpenwopErrorCode` |
| Codemap vendored + carried by the sync script | `schemas/v2/event-codemap.json`; `scripts/sync-schemas.sh` |

## Measurement

- **The v1 wire is unchanged.** `origin/main` and this tip were booted on the same
  port against fresh sqlite databases and driven through the same 29-request v1
  transcript (discovery, create, snapshot, three poll cursors, the JSON events
  read, the debug bundle, run list, ancestry, fork, and seven fixtures including
  `conformance-agent-reasoning` and `conformance-orchestrator-dispatch`, which
  emit renamed types). The transcripts differ in exactly three volatile values:
  the per-boot sandbox path, one mock-provider `traceId`, and the Express weak
  ETags derived from bodies carrying those. No field added, removed or renamed;
  no event `type` changed.
- **The seat, witnessed.** An era-`3` run stores `agent.tool-called` /
  `orchestrator.decided` and reads back as `agent.toolCalled` /
  `runOrchestrator.decided` on `/v1/…` and as the v2 spellings on the
  unversioned paths, over poll AND SSE, with sequences verbatim. A run whose era
  column is NULL and whose rows carry v1 spellings reads v1-verbatim on the v1
  wire, translated on the v2 wire, reports `eventLogSchemaVersion: 2`, and its
  rows and NULL era are untouched by the read. A fork of that era-`2` parent is
  era `3` and its prefix is byte-equivalent to the translated parent
  (`replay.md` §"Forking a v1 run").
- **Suite (corpus `origin/main`, `--target-major 2`).** `v2-era-key` 2/2 and
  `v2-era-stamp-universal` 2/2 (both fully red / vacuous at `origin/main`);
  `v2-poll-cursor-v2` 3/4 and `v2-event-type-closed` 1/2, the two remaining
  failures identical at `origin/main` and both explicit non-goals of this PR
  (the sequence-origin-`0` divergence, and the v2 event envelope's
  `schemaVersion` + `runId` id grammar, which belongs to the identity PR).

## Follow-ups

- `v2-v1-events-translated`, `v2-fork-a-v1-run`, `v2-era-2-append-vocabulary` and
  `v2-unmapped-type-refused` need the era-2 seed seam and are blocked on the
  seams PR. The behaviour each asserts is witnessed by hand above.
- This host emits event-type spellings the v2 type space cannot express, found
  while implementing the writer rule: **8** four-segment
  `host.<domain>.<entity>.<verb>` names (`openwop-app.crm.contact-triaged`,
  `openwop-app.entities.entity-written`, `host.forms.submission.created`,
  `openwop-app.kanban.card-moved`, `host.kb.document.updated`,
  `openwop-app.servicedesk.ticket-reply-approved`, `openwop-app.servicedesk.ticket-sla-breached`,
  `openwop-app.whatsapp.health-degraded`) where the vendor grammar admits at most three,
  and **4** carrying an underscore (`openwop-app.conversation.context-degraded`,
  `openwop-app.conversation.recall-used`, `openwop-app.workflow.approval-needed`,
  `openwop-app.workflow.budget-alert`) where the grammar is kebab-only. None is a codemap
  row. They are stored and read verbatim, so nothing breaks today; but
  `v2-event-type-closed` fails on any run that emits one. A rename to conforming
  vendor spellings is its own change.

  Note the asymmetry this produces, which is each rule applied literally rather
  than an inconsistency introduced here: on an era-`3` run those names are read
  UNTRANSLATED (§"The reader rule" translates only an era-`2` log), so a major-2
  read returns them and the closed-enum honesty falls to
  `v2-event-type-closed`; on an era-`2` run — a real pre-cut run that emitted
  one — the same major-2 read fails with `500 event_type_unmapped`, because that
  is exactly what §"The reader rule" prescribes for a type the codemap does not
  name and that carries no conforming vendor spelling. The v1 wire is unaffected
  in both cases. Failing loudly is the point: the alternative is a tolerant
  branch that would hide the very defect the rule exists to surface.
