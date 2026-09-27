# ADR 0041 — Subject memory: one memory primitive for agents *and* humans

**Status:** implemented (extended by § H49 and § H51, 2026-08-17)
**Date:** 2026-06-15
**Toggle:** none — Personal Memory is **always-on** (§ Correction 2026-06-15: graduated off the
`profile-memory` toggle, like `profiles` itself; durability — the original gating rationale —
is satisfied). The *agent* surface keeps riding `agent-knowledge` (ADR 0038) unchanged.
**Capability:** none new — reuses the RFC 0004 memory store and the `agent-knowledge`
curation model.
**Depends on / composes:** ADR 0038 (per-agent knowledge & memory — generalized here, not
forked), ADR 0005 (user profiles — the human owner + its descriptive-only boundary), ADR
0001 (feature-package architecture), ADR 0003/0048 (opaque principals — `user:<userId>`).
Reuses the host memory adapter (`host/agentMemoryAdapter.ts` → now `host/subjectMemory.ts`,
RFC 0004) and the in-memory RFC-0004 store.
**Surface:** host-internal product config under `/v1/host/openwop-app/*`.
**NON-NORMATIVE — no OpenWOP RFC.** Rides **already-Accepted** RFC 0004 (Memory Layer),
RFC 0048 (opaque owner), RFC 0080 (memory capability dimensions). It touches no `/v1` wire
contract — the memory store keys on an opaque `memoryRef`, which already accepts any owner
string. See § "RFC gate".

## Why this exists

The request: *"per-agent memory must be 100% bulletproof and apply the same way to all
agents, with a visible tab per agent showing their memories. Human user profiles need a
memory too, so a person can train their own profile — eventually a digital twin of
themselves."*

A boundaries audit (2026-06-15, `/architect`, file:line-grounded) found:

1. **Advisor agents are already canonical — nothing to fix.** `advisoryBoardConvene.ts:126`
   and `agent-knowledge/service.ts:301` both call the *same* `resolveAgentKnowledgeRetrieve(…,
   agentMemoryScope(agentId))`. There is one per-agent memory path, not a parallel one. The
   premise's "fix the advisors" fork resolves to: **don't fix — generalize.**
2. **The store is already principal-agnostic; the *scope helper* is not.**
   `agentMemoryScope()` (`agentMemoryAdapter.ts:39-41`) hardcodes `` `agent:${id}` ``, but the
   RFC-0004 store (`inMemorySurfaces.ts` `writeMemoryEntry`/`listMemoryEntries`) keys on a
   fully opaque `memoryRef`. So a human's memory is *the same store* under `user:<userId>` —
   zero new infrastructure.
3. **Memory belongs to a standing instance, not a template.** The agent Knowledge tab is on
   `AgentWorkspacePage` (`:317`, keyed by `rosterId`); `AgentDetailPage` (templates) has no
   tabs. A template is a blueprint with no lived experience — memory accrues on the instance.
4. **`profiles` is declared descriptive-only** (`profilesService.ts:1-15`): identity →
   `users`, authority → RBAC, bytes → media-by-token. Raw memory content **must not** land in
   the `Profile` record.

## Decision

Introduce **subject memory** — one primitive, keyed by a `MemorySubject`, used identically
by agents and humans.

```ts
export type MemorySubject = { kind: 'agent'; id: string } | { kind: 'user'; id: string };
export function subjectMemoryScope(s: MemorySubject): string { return `${s.kind}:${s.id}`; }
```

- `subjectMemoryScope({kind:'agent', id})` ⇒ `agent:<id>` — **byte-identical** to the old
  `agentMemoryScope`, so every existing agent/advisor path is unchanged.
- `subjectMemoryScope({kind:'user', id})` ⇒ `user:<id>` — the human's personal memory.

**Single owner (Finding 2).** `host/subjectMemory.ts` becomes the one owner of: the scope
convention, the RFC-0004 memory **port** (`createSubjectMemoryPort`, moved verbatim from the
old adapter), and the **curated-note CRUD** (`addSubjectNote` / `listSubjectNotes` /
`removeSubjectNote` / `countSubjectNotes`). `host/agentMemoryAdapter.ts` becomes a thin
back-compat **re-export shim** (`agentMemoryScope`, `createAgentMemoryPort`,
`countAgentMemoryByTag`) so dispatch, agent-knowledge, the advisory board, and the routes keep
importing the same symbols with identical behavior.

**No `Profile` schema change (Finding 1 + 4).** Human memories live entirely in the RFC-0004
store at `user:<userId>` — they are *referenced* by the user's opaque id, never inlined into
the descriptive `Profile` record. The profile view surfaces a **derived** `memoryCount` (read
time, never persisted) to drive the "train your twin" progress affordance. (A future
`Profile.knowledge.collectionIds` reference would add bound KB documents for humans — see Open
questions; out of scope here.)

**Self-ownership authority (Finding 3).** A human curating *their own* memory needs no
`memoryWritable` opt-in (that gate exists for agents because a user curates *another* entity's
recall). The owner *is* the authority: the `/profiles/me/memory` routes resolve the caller via
`resolveCallerUser` and key the subject on the caller's own `userId` — intrinsic ownership,
exactly like the other `/me/*` routes.

**Durability before the twin claim (Finding 4 / Phase 2 — IMPLEMENTED).** The base RFC-0004
store is in-memory (sample-grade) — acceptable for an agent's transient run-recall, **dishonest
for "train your twin over months."** So a **curated note is durable**: it is written to a
`DurableCollection` (`subject-memory:note`, the SAME storage seam profiles/orgs use) as the
*source of truth* for list/count/delete, and *additionally* mirrored to the in-memory + vector
store as a best-effort recall index (so dispatch RAG recall is unchanged from ADR 0038). Both
rows share one id, so delete is consistent across durable + recency + vector. Dispatch
turn-summaries stay ephemeral (transient, regenerated each run). Net: a person's trained
memories persist exactly as durably as their profile.

## Data model

| Concept | Owner | Keying |
|---|---|---|
| Memory entries (notes + turn summaries) | RFC-0004 store (`inMemorySurfaces.ts`) | `tenantId` + `memoryRef` (`agent:<id>` \| `user:<id>`) |
| Scope convention + note CRUD + port | `host/subjectMemory.ts` (single owner) | `MemorySubject` |
| Agent binding (`collectionIds`, `memoryWritable`) | `agentProfile.knowledge` (ADR 0038) | `agentId` |
| Human memory binding | *none needed* — notes key on `user:<userId>` | `userId` |
| Human `memoryCount` (derived) | `profilesService.viewProfile` | computed, never stored |

## Phased plan

- **Phase 1 — backend seam.** `subjectMemory.ts` (scope + port + note CRUD); `agentMemoryAdapter.ts`
  → re-export shim; `agent-knowledge/service.ts` `addNote`/note-count delegate to the seam +
  new `listAgentNotes`/`removeAgentNote`; new `GET/DELETE {BASE}/notes[/:id]` agent routes; new
  `GET/POST/DELETE /v1/host/openwop-app/profiles/me/memory[/:id]` human routes (toggle +
  self-ownership). **Acceptance: every existing agent/advisor memory test passes unchanged**
  (the no-fork proof).
- **Phase 2 — durable curated notes.** Persist curated notes to a `DurableCollection` (source
  of truth) with the in-memory + vector store as a best-effort recall index under the same id;
  notes survive restart. Turn-summaries stay ephemeral.
- **Phase 3 — shared UI.** One subject-parameterized memory-browser component; a Memory tab on
  `AgentWorkspacePage` (instance) and on `ProfilePage`; trusted/untrusted chips reused.
- **Phase 4 — twin framing.** "Train your twin" copy on the profile Memory tab. Originally
  shipped behind a `profile-memory` toggle (OFF); **graduated to always-on 2026-06-15** — a
  person's own profile should not carry an admin-gated tab they can't enable themselves, and
  durability (the gating rationale) is met. The surface is self-owned (caller curates only
  their own memory), so always-on is safe.

## Alternatives weighed

- **Fork a second human-memory service.** Rejected — two systems for one concept (the
  `orgs`↔`accessControl` failure mode); drifts immediately. The seam + shim gives one path.
- **Put memory content on the `Profile` record.** Rejected — violates the descriptive-only
  boundary (`profilesService.ts:1-15`) and bloats every directory read. Memory is referenced
  by `userId`, owned by the RFC-0004 store.
- **Gate human memory on a `memoryWritable` opt-in (agent parity).** Rejected — friction with
  no security benefit; a human owns their own memory by definition.
- **Build template-level (blueprint) memory.** Rejected for now — a template has no lived
  experience and sharing one pool across tenants leaks. Left as a distinct future feature
  (factory seed knowledge).

## RFC gate

**Host-only — no new RFC.** The change keys the existing opaque `memoryRef` on `user:<userId>`
(an already-Accepted RFC 0048 owner) and adds non-normative routes under
`/v1/host/openwop-app/*`. No run-event field, capability flag, event type, or normative MUST
is touched. (If human KB-document binding is added later it likewise rides the Accepted RFC
0011/0018 KB+vector surfaces — still host work.)

## Open questions

- **Cross-subject read (twin reads its human).** Eventually a digital-twin agent may read its
  owner's `user:<userId>` memory. That is a cross-principal access decision (consent + RBAC),
  **deliberately not built here.** Keying on the opaque `user:<userId>` makes it possible later
  with no migration.
- **Human KB-document binding.** `Profile.knowledge.collectionIds` (mirror of
  `agentProfile.knowledge`) would let a human bind cited documents, not just notes. Deferred —
  notes are the "train your twin" MVP.
- **Per-subject memory caps for humans.** The shared `NOTE_CAP` (200) applies to both; revisit
  once durable + real usage exists.

## Implementation status

| Phase | Status | Commit / test |
|---|---|---|
| 1 — backend seam | implemented | `subjectMemory.ts`, shim, profile/agent note routes; `profile-memory-route.test.ts` |
| 2 — durable curated notes | implemented | `DurableCollection('subject-memory:note')`; `subject-memory.test.ts` (survives in-memory wipe) |
| 3 — shared UI | implemented | `memory/MemoryBrowser.tsx`, agent + profile Memory tabs |
| 4 — twin framing | implemented | twin copy honest (notes durable); **always-on** (toggle retired 2026-06-15, like `profiles`) |


## § Follow-on — Temporal Agent Memory (innovation strategy, 2026-06-24)

The innovation strategy proposes memory that **decays**: confidence, provenance,
last-confirmed date, half-life, scope, contradiction set, and a refresh policy; inject a
memory only when effective confidence passes a threshold, and flag contradictions. This
**extends THIS ADR + ADR 0120 (auto-extract)**: subject memory already carries
provenance + untrusted tagging; temporal memory adds decay/confidence/contradiction as
additive fields on a `SubjectNote` + an injection-decision filter in the retrieval
composition (`resolveSubjectKnowledgeRetrieve`). No new store; needs GDPR/deletion
parity (ADR 0028). Host-extension, no new RFC.


## § H49 — the corpus `config.memoryAction` seam, and three honesty fixes under it (2026-08-17)

**Status:** implemented. **Non-normative — no OpenWOP RFC.** Every capability field
touched (`agents.memoryBackends`, `memory.injectionBudget`) already exists in
`capabilities.schema.json`; `config.memoryAction` is a fixture convention the corpus
already ships in the vendored tree; the read routes stay under
`/v1/host/openwop-app/*`. Classification: **additive + safety-fix**.

### The ask

The OpenWOP corpus drives five memory conformance scenarios through a fixture
convention rather than a dedicated node type: a `core.identity` node carrying
`config.memoryAction` (`write-then-read`, `redaction-probe`, `ttl-probe`,
`cross-tenant-probe`, `list-budgeted`), whose results the host must surface as run
VARIABLES the scenario reads back off `GET /v1/runs/{id}`. This host implemented
**none** of it, so those fixtures ran as pass-throughs: run `completed`, variable bag
empty. H48 fixed the ADVERT (an `IMPLEMENTED_MEMORY_ACTIONS` set, deliberately empty)
and recorded the constraint that the driver and the action string must land in the
SAME commit. H49 is that commit.

### Decision — extend the existing owners, gate the PROBE not the SUBSYSTEM

The typeId is **pinned by the vendored fixtures**, so a distinct typeId of our own was
never available; `core.identity` (`bootstrap/nodes.ts`) delegates to a new
`bootstrap/conformanceMemoryProbe.ts`, joining the existing conformance-node family and
mirroring the node's own pre-existing `config.emitDuplicateMessageId` branch. Every
action drives the REAL memory subsystem (`host/inMemorySurfaces.ts` §"RFC 0004 memory")
through the same entry points the HTTP routes and the executor use — a probe with its
own storage, TTL filter or tenant scoping would witness itself instead of the host.

The probe is gated on `conformanceNodesEnabled()` because it fabricates rows and seeds
a synthetic foreign tenant (the `mockAiNode` class of demo machinery). The **memory
subsystem is not gated** — the SR-1 chokepoint, the CTI-1 ref validation and the RFC
0113 budget fix ship unconditionally and benefit every deploy.

`implementedMemoryActions()` is the ONE function read by both the dispatch branch and
the fixture advert in `host/index.ts`, and the action set is **derived from the handler
map** (`new Set(Object.keys(HANDLERS))`), never restated. A hand-kept list is a second
source of truth whose failure mode is silent and asymmetric — lose a handler while
keeping its string and the host ADVERTISES a fixture it cannot run, the exact defect
ADR 0533 wrote the gate to prevent.

### Three honesty fixes the seam exposed, each independently real

1. **RFC 0113 was over-claimed on a live wire path.** The host advertises
   `memory.injectionBudget.supported: true`, but `listMemoryEntries` delegated to
   `budgetByChars`, whose ADR 0148 A4 contract *"always keeps the first item even if it
   alone exceeds the budget"* contradicts RFC 0113 clause 1 (*"A single entry exceeding
   the budget on its own MUST be omitted"*). `GET …/memory?tokenBudget=10` returned 500
   chars. Fixed with a named `keepAtLeastOne` option — default `true` (zero-diff for
   knowledge retrieval, which wants a SOFT budget) and `false` at the memory read. One
   algorithm, two named policies, not two budget models.
   **`test/rfc0113-memory-budget.test.ts` had PINNED the violation**: its case *"always
   keeps ≥1 entry even when the first alone exceeds the budget"* was written from the
   primitive's contract rather than from the RFC, so it agreed with the bug. Inverted.
2. **SR-1 was not implemented at all.** No memory-write redaction existed. The
   executor's run-summary write embeds a slice of the run's OUTPUT, so a run whose
   output carried a BYOK-resolved value persisted it verbatim into an entry that
   `GET /v1/host/openwop-app/memory` then served back. `writeMemoryEntryRedacted` is
   the spec's `writeAgentMemoryRedacted` chokepoint, wired to the registry this host
   **already had** — `byok/ephemeralRunSecrets.ts` IS the spec's `MemorySecretRegistry`
   ("in-process map keyed by `runId`"), so no second registry was introduced. Both
   in-run write sites route through it, pinned by a source-derived NO-GROWTH ratchet.
   `registerRunSecret` (MERGE, never replace) closes a pre-existing hole: a node
   resolving a secret mid-run was invisible to `stripSecretsFromPersisted` too.
3. **CTI-1(1) had no implementation.** `listMemoryEntries`/`getMemoryEntry` passed any
   string to the store. `isWellFormedMemoryRef` now refuses the three shapes the spec
   names (traversal segments, control characters/NUL, oversize) and fails **closed**
   (`[]`/`null`, never an error carrying the ref back — CTI-1(3)). Writes stay
   unvalidated on purpose: every write ref is host-minted, the spec names *resolution*
   time, and failing a write closed would DROP data rather than refuse to serve it.

### Adverts — one flipped, one deliberately left as an under-claim

`capabilities.agents.memoryBackends: ['long-term']` is now advertised, **derived** from
the selected memory surface (`resolveBackendId('memory') !== MEMORY_BACKEND`) rather
than asserted: the §A dimension is a *cross-run **durable** store*, and the default tier
is process-local (its own surface note says "restarts wipe state"). The conformance lane
sets `OPENWOP_SURFACE_MEMORY=durable`, which is what EARNS the claim for the run
measured against it. Blast radius is exactly the four `agentMemory*` scenarios —
`hasLongTermMemory()` has no other consumer in the suite.

**`capabilities.memory.supported` stays `false`, and this is a known UNDER-claim, not a
correct value.** RFC 0080 §B says the flag advertises the host-internal adapter plus the
SR-1-redacted read side, all of which this host now has. It stays false because flipping
it activates `memory-degraded-projection` (gated on `memory.supported === true`), which
demands the RFC 0080 §C `memoryDegraded` / `degradedMemoryDimensions` projection on
`GET /v1/agents` that this host does not implement — trading an under-claim
(conformance-safe: scenarios skip cleanly, and the spec says so) for an **over**-claim.
Queued as residue below with the exact ask.

### The corpus scenarios were not sufficient evidence — MEASURED, then FIXED UPSTREAM

Running each scenario against a deliberately sabotaged probe, rather than reasoning
about them, at the suite version this work started on (**1.136.0**):

| scenario | vs a pass-through host | vs `memoryList: []` |
|---|---|---|
| `agentMemoryRoundTrip` | RED | — |
| `agentMemoryRedactionContract` | RED | — |
| `memory-injection-budget` | RED | — |
| `agentMemoryTtlExpiry` | RED | **GREEN** |
| `agentMemoryCrossTenantIsolation` | **GREEN** | GREEN |

`agentMemoryCrossTenantIsolation` was vacuous outright — it fell through to
`expect(probe).toBeFalsy()` and `undefined` is falsy, so a host surfacing nothing passed
a **critical-tier** invariant. `agentMemoryTtlExpiry` was vacuous narrowly — an unset
variable failed but an empty array passed, which is what an over-aggressive TTL filter,
or a write that silently did nothing, produces.

**Correction, recorded rather than edited away:** the first draft of this reasoning — in
the architect review and in the first cut of the source comments — claimed the TTL
scenario "cannot fail" at all. The sabotage falsified it. Unset and empty are different
states and only the empty one was blind.

**Both holes are now closed in the corpus** (openwop#1062, suite **1.136.1**, corpus item
S35 — reported from here). The two fixtures went to `version: "1.1"`:
`conformance-agent-memory-cross-tenant` gains `agent.memoryRef` plus
`ownerEntryId`/`ownerProbe` (an owner-side positive control: write under the run's OWN
tenant and list it back, non-empty) and now requires `crossTenantProbe` to be SET and
exactly `[]`/`null`; `conformance-agent-memory-ttl` gains `freshId`/`expiredId` and
requires fresh ∈ list ∧ expired ∉ list. Re-measured at 1.136.1 with the same
pass-through sabotage: **all five scenarios go RED** (was 3 of 5), and the
`memoryList: []` case now fails too. The host emits exactly those variable names, and
`test/conformance-memory-probe.test.ts` asserts the same names so the two cannot drift
into agreeing while both being wrong.

The host keeps its own **second** CTI-1 control on top of the corpus's:
`foreignSeedVisibleToItsOwnTenant` proves the foreign row actually EXISTS, so the
caller's empty read is a *refusal* rather than an empty store. The corpus's owner-side
control proves reads work at all; this one proves there was something to leak. They are
different claims and both are worth holding.

### Implementation record

| Area | File | Test |
|---|---|---|
| probe driver + derived action set | `bootstrap/conformanceMemoryProbe.ts` | `test/conformance-memory-probe.test.ts` |
| `core.identity` delegation (gated) | `bootstrap/nodes.ts` | ditto |
| advert ⟺ driver, both postures | `host/index.ts` | `test/conformance-fixture-advert-gating.test.ts` |
| RFC 0113 hard budget | `host/memoryBudget.ts`, `host/inMemorySurfaces.ts` | `test/rfc0113-memory-budget.test.ts` |
| SR-1 chokepoint + rules | `host/inMemorySurfaces.ts`, `byok/textRedaction.ts`, `byok/ephemeralRunSecrets.ts` | `test/memory-sr1-chokepoint.test.ts` |
| SR-1 call-site ratchet | `executor/executor.ts`, `bootstrap/nodes.ts` | ditto |
| CTI-1 ref validation | `host/inMemorySurfaces.ts` | `test/memory-ref-validation.test.ts` |
| long-term advert (derived) | `routes/discovery.ts`, `conformance/run.ts` | `test/memory-sr1-chokepoint.test.ts` |
| suite 1.136.0 → **1.136.1** + re-vendor the two v1.1 fixtures | `package-lock.json`, `conformance-fixtures/conformance-agent-memory-{cross-tenant,ttl}.json` | the five scenarios, re-measured |
| S35 variables (`ownerEntryId`/`ownerProbe`, `freshId`/`expiredId`) | `bootstrap/conformanceMemoryProbe.ts` | `test/conformance-memory-probe.test.ts` |

### Residue

- **`memory.supported` under-claim — QUEUED AS H51. The exact ask, so H51 inherits it
  rather than re-deriving it:**
  1. Implement the RFC 0080 §C degraded projection on `GET /v1/agents`
     (`routes/agents.ts`): the additive optional `memoryDegraded: true` +
     `degradedMemoryDimensions: string[]` on each inventory entry whose
     `AgentManifest.memoryShape` declares a dimension this host's reconciled §A model
     does not satisfy. Members MUST come from the closed eight-name §A enum in
     `agent-inventory-response.schema.json` (`read`, `write`, `search`,
     `long-term-durability`, `compaction`, `attribution`, `replay-snapshot`,
     `retention`) — `memory-degraded-projection.test.ts` asserts the enum and that a
     non-degraded entry carries no non-empty list.
  2. Then flip `capabilities.memory.supported: true` **together with**
     `memory.writable: false` (RFC 0080 §A: `memory.supported` implies the four-op
     read+write contract, and this host's write side is host-internal only — there is no
     client write path). Both in the same commit; `supported: true` without `writable`
     would over-claim a portable write surface.

     > **CORRECTION (H51, 2026-08-17) — step 2's `writable: false` was WRONG, and the
     > reason it gives is a misreading of the field.** `writable` does not describe a
     > *client* write path; RFC 0080 §B says `memory.supported` advertises the
     > **host-internal** `MemoryAdapter` and adds **no** portable client surface at all
     > (no `GET /v1/memory`), so "the write side is host-internal only" is true of the
     > READ side too and cannot be what distinguishes them. §A defines `writable: false`
     > as what a **read-only host** sets — one whose adapter lacks `put`/`delete`. This
     > host has all four ops (`host/inMemorySurfaces.ts`: `listMemoryEntries`,
     > `getMemoryEntry`, `writeMemoryEntry`, `removeMemoryEntry`), the agent-facing port
     > exposes read+write (`host/subjectMemory.ts createSubjectMemoryPort`), and
     > `host/agentDispatch.ts:665` really writes. `writable: false` would be false.
     >
     > It would also have been **self-defeating twice over**. `lib/profiles.ts isMemory()`
     > returns false for a `writable: false` host, so it would have WITHHELD the
     > `openwop-memory` profile step 4 below expects to appear. And under §A an
     > unsatisfied `write` dimension stamps EVERY agent with a `memoryShape` as degraded
     > — manufacturing a non-vacuous degraded branch out of an untrue claim, the exact
     > fabrication RFC 0080's amended acceptance criterion commends the first adopter for
     > refusing.
     >
     > H51 therefore **omits `writable` entirely**: RFC 0080 UQ1 resolved absence as
     > writable (the RFC 0004 four-op default), and the RFC's own positive example omits
     > it. Recorded here rather than edited above, because the reasoning trail is the
     > point — and because this premise died on a spec read, not on a test.
  3. Expect `memory-degraded-projection` to START EXECUTING at that moment — it gates on
     `manifestRuntime.supported === true && memory.supported === true`, and this host
     already advertises the first. That scenario is the witness; do not flip without it
     green.
  4. `deriveProfiles` will then surface the `openwop-memory` profile (it derives across
     `capabilities.memory.*` for read/write AND `capabilities.agents.memoryBackends` for
     durability — a validator MUST NOT look for `memoryBackends` under `memory`). H49
     already supplies the durability half.
  5. Delete the pin `memory.supported stays FALSE — a deliberate, recorded UNDER-claim`
     in `test/memory-sr1-chokepoint.test.ts`; it exists to make this flip a deliberate
     act and says so in its own comment.
- **`host/subjectMemory.ts` is outside the SR-1 chokepoint** — no `runId` is in scope
  at that call boundary, so there is no per-run keyring to redact against. Allowlisted
  with that reason in the call-site ratchet. Closing it means threading a run context
  through the subject-memory port.
- **`rank: 'relevance'` stays unoffered.** RFC 0113 clause 3 delegates it to
  `memory.search` semantic (RFC 0080), which this host does not advertise, so the probe
  deliberately leaves `recencyOrder`/`relevanceOrder` UNSET and the scenario's relevance
  leg soft-skips. An omitted variable is honest; a fabricated ordering would not be.

## § H51 — RFC 0080 §C: the degraded projection, and the advert flip it unblocks (2026-08-17)

### The ask

H49 left `capabilities.memory.supported: false` as a **named** under-claim with a
five-step executable residue (above). This is that work. The residue is followed as
written except for step 2, whose premise died on a spec read — see the correction note
inline there rather than a silent edit.

### Decision — ONE module derives the model, both consumers read it

`host/memoryDimensions.ts` is the RFC 0080 §A single source of truth. It owns the eight
dimension names, the per-tier satisfaction set, the `capabilities.memory` advertisement,
and the §C projection.

This is not tidiness. RFC 0080's own `Updated:` field records that the first adopter's
implementation is trustworthy *because* "single source of truth `host/memoryDimensions.ts`
drives BOTH the advertisement and the projection". Two derivations would be two claims
about one subsystem, and their disagreement — a host advertising `long-term-durability`
while stamping agents as lacking it, or the reverse — is invisible to every schema on the
wire.

The construction makes the drift **impossible rather than detected**:
`satisfiedMemoryDimensions()` reads the dimensions **off** `memoryCapability()`, the very
object `/.well-known/openwop` serves, instead of re-testing the same env vars. A later PR
that advertises `memory.search` or `memory.retention` moves the dimension set with it and
edits nothing here. `test/memory-dimensions.test.ts` proves the coupling by moving ONE
advert input (`OPENWOP_TEST_TRIGGER_COMPACTION`) in both directions and watching the advert
and the model move together.

`longTermMemoryDurable()` MOVED here from `routes/discovery.ts`, where H49 authored it for
the `agents.memoryBackends` advert alone. The §C projection needs the same answer; a second
copy would have been the first drift.

**Not merged into `host/agentCapabilities.ts`,** which owns the RFC 0072/0092 `degraded[]`
field on the same inventory entry. That module's vocabulary is host-SURFACE keys matched
against `listHostSurfaces()`; this one's is the CLOSED eight-name §A enum. Different
vocabularies, different wire fields, different specs. They compose at the one place that
needs both — `routes/agents.ts toEntry`.

### The §A model, derived per tier — and the one dimension that is NOT the bare formula

| Dimension | Derived from | default tier | durable tier |
|---|---|---|---|
| `read` | `memory.supported` — `listMemoryEntries`/`getMemoryEntry` | ✅ | ✅ |
| `write` | `memory.supported` ∧ `writable !== false` — `writeMemoryEntry`/`removeMemoryEntry` | ✅ | ✅ |
| `search` | `memory.search` — unadvertised (recency-only ranking) | ❌ | ❌ |
| `long-term-durability` | `resolveBackendId('memory') !== 'memory'` | ❌ | ✅ |
| `compaction` | `memory.compaction` ⟸ `OPENWOP_TEST_TRIGGER_COMPACTION` seam | ❌ | env |
| `attribution` | `memory.attribution` — unconditional (`memory.written`) | ✅ | ✅ |
| `replay-snapshot` | §A formula **∧** the run-start snapshot rule | ❌ | ❌ |
| `retention` | `memory.retention` — unadvertised | ❌ | ❌ |

`long-term-durability` is the ONLY dimension the deployed tier moves, and the test asserts
that as an equality on the delta rather than as two independent checks — a second dimension
starting to move is a real change in the model and should be stated, not absorbed.

**`replay-snapshot` is the trap, and it is a live one.** §A derives it as
`memoryBackends: ["long-term"]` + `multiAgent.executionModel.version >= 2` — two env-var
conditions this host CAN satisfy today. But `listMemoryEntries` filters by TTL, tag,
recency and the RFC 0113 budget, **never by a run-start logical timestamp**, so RFC 0004
§A's snapshot rule (*"`list` MUST return the snapshot of entries visible at run start"*) is
not implemented and a mid-run write by another run IS visible to the calling run. Deriving
from the formula alone would have advertised a replay determinism this host does not
provide, on a boot that merely sets two env vars. So the formula is conjoined with a named
implementation fact, and that fact is **ratcheted from the source**: the test extracts the
real `listMemoryEntries` body and fails if it ever references a snapshot term, forcing the
constant to be reconsidered instead of leaving a stale `false`. A bare `false` with a
comment rots silently; that is the class this repo has been bitten by repeatedly.

Nothing on the wire consumes `replay-snapshot` today (below), so this costs nothing now and
prevents a silent over-claim later. That is the whole reason to model it.

### Only THREE of the eight names can reach the wire

§C's projection domain is `memoryShape`, and the mapping is the one
`agent-inventory-response.schema.json` states normatively: `longTerm ⇒
long-term-durability`, `scratchpad`/`conversation` ⇒ `write`+`read` "as applicable".
`longTerm` carries `read`+`write` too — RFC 0004 §A binds `memoryBackends` to the four-op
adapter, and a durable store you can neither read nor write is not a capability an agent
could be said to have received.

So `search`, `compaction`, `attribution`, `replay-snapshot` and `retention` can never
appear in a `degradedMemoryDimensions` list from this projection. Inventing a mapping for
them would be this host asserting a §C contract the spec does not define. They stay in the
model (§A describes the HOST, not one agent) and out of the projection, and a test pins
that closure in both directions.

**Strict `=== true`.** A pack's `memoryShape` reaches the projection through
`packs/agentLoader.ts`, which casts raw manifest JSON, so `{ longTerm: "yes" }` is
reachable. A non-boolean is not a declaration — it is an RFC 0003 §C manifest defect that
`agent-manifest.schema.json` rejects at publish/install time (the §D *reject* lane, which
`agent-memory.md` says is disjoint from and strictly precedes this §C *degrade* lane).
Treating a truthy string as a request would let a malformed manifest author a
degraded-dimension list on the wire.

### Both inventory lanes, because both can hide a silent entry

`routes/agents.ts` builds inventory entries in TWO places, and §C-2 makes a silent
satisfied-looking entry non-conformant regardless of which one produced it:

- `toEntry` — registry agents (pack + boot-hydrated user), serving `GET /v1/agents`,
  `GET /v1/agents/{id}` and both host-extension aliases;
- `userRecordToEntry` — the read-through for a durable user agent on an instance whose
  registry has not hydrated it (the cold-instance path `listVisibleAgents` exists for).

Missing the second is the easy defect: it is reached only on a cold instance, so it would
look correct in every ordinary test. The route test drives it deliberately — create through
the real route, drop ONLY the registry row, re-read — with the hydrated stamp asserted first
as a precondition so the cold read is a comparison rather than a hope.

The POST/PATCH echo bodies in `routes/userAgents.ts` are deliberately NOT stamped: they
carry `systemPrompt` and are creation receipts, not the RFC 0072 inventory §C binds to.

### The advert flip, and its full blast radius (measured, not assumed)

`capabilities.memory` is now built by `memoryCapability()`. `supported: false → true`, and
`'openwop-memory-degraded'` is removed from the `conformance/run.ts` opt-out ledger.
`writable` is OMITTED — see the correction on H49's residue step 2.

Every scenario in the installed suite (1.136.1) that consults the `memory` family, with its
gate and its measured disposition:

| Scenario | Gate | Disposition |
|---|---|---|
| `memory-degraded-projection` | `manifestRuntime ∧ memory.supported` | **ACTIVATES** — executed-pass, the witness |
| `multi-agent-memory-lifecycle` (MAE-3 leg) | `+ OPENWOP_TEST_EXPIRED_REPLAY_RUN_ID` | unchanged — the env var is set nowhere in this repo |
| `memory-injection-budget` | `memory.injectionBudget` | unchanged (already executing, H49) |
| `memory-compaction-provenance-tag` | `memory.compaction` | unchanged |
| `agent-platform-profile`, `memory-capability-model-shape`, `requirement-ledger` | server-free (fabricated docs) | unchanged |

No scenario goes red, so there was no blocker to report.

**The second-order effect the residue did not name.** `deriveProfiles` now surfaces
`openwop-memory` (supported ✅, `writable` not-false ✅, `memoryBackends` includes
`long-term` on the conformance tier ✅ — the profile derives across TWO subtrees, and a
validator must not look for `memoryBackends` under `memory`). That profile carries a
**certification floor** of four scenarios (`lib/profiles.ts`):
`memory-capability-model-shape`, `memory-attribution-shape`,
`memory-attribution-emits-on-write`, `memory-degraded-projection`. Checked before flipping:
`conformance/certify.ts` resolves an unproven derivable profile into `notClaimed` with a
reason rather than failing the run, and no host test pins `claimedProfiles`. So the flip is
safe either way, and the ADR 0550 claims document simply gains an honest new row —
`claimed` if all four witness, `notClaimed` with the blocking requirement named if not.

### Non-vacuity — the corpus proves ONE direction, and this host proves the other

Under the conformance boot (`OPENWOP_SURFACE_MEMORY=durable`) all three
memoryShape-requestable dimensions are satisfied, so **no agent is honestly degraded** and
the scenario exercises the §C-1 NON-degraded direction only. That is exactly the position
RFC 0080's amended acceptance criterion describes and accepts.

`OPENWOP_DEGRADED_AGENT_ID` is deliberately **not** set. It names an agent the scenario then
REQUIRES to be degraded; on the durable tier no agent is, so setting it would either
hard-fail the leg or force a fabricated degraded agent — the dishonest direction the RFC's
amendment explicitly commends the first adopter for refusing.

The degraded-STAMP direction is proven instead at the host boundary, on this host's
**DEFAULT (process-local) memory tier** — a shipped configuration, the one `app.openwop.dev`
runs — where `long-term-durability` is genuinely absent and an agent declaring
`memoryShape.longTerm` is genuinely degraded. Nothing is fabricated: the agents are
ordinary, the tier is real, the stamp is the truth about that deployment. RFC 0080 says the
degraded-STAMP direction *"is exercised the first time an honest host that genuinely lacks a
memory dimension adopts the projection"*. **On its default tier, this host is that host** —
and it is worth being precise about where: at its own boundary, not in the corpus lane.

### What the corpus scenario can and cannot see — MEASURED against a sabotaged host

A green corpus scenario is not evidence on its own. Each row is the scenario run against a
deliberately broken projection, diff proven applied against a snapshot first, restored
byte-exact after.

| # | Sabotage | Corpus scenario |
|---|---|---|
| C1 | no §C projection AT ALL (the pre-H51 host) | **GREEN** |
| C2 | over-stamp: every agent degraded on `read`+`write`+`long-term-durability` | **GREEN** |
| C3 | over-stamp carrying `longTerm` (outside the §A enum) | **GREEN** — see below |
| C3b | C3 **plus** disabling `closeAndOrderDimensions`'s enum filter | RED — *"members MUST be RFC 0080 §A dimension names (got longTerm)"* |
| C4 | stamped with an EMPTY `degradedMemoryDimensions` | RED — the §C-1 iff |
| C5 | `memory.supported` back to `false`, opt-out ledger entry still removed | RED — *"host MUST advertise the openwop-memory-degraded profile"* |

**C1 is the finding to sit with.** On this host's conformance tier the corpus scenario
cannot distinguish an implemented §C projection from no projection at all — because on the
durable tier the honest output of both is "stamp nothing". Its non-degraded direction is a
shape check over a set that happens to be clean. That is not a defect in the scenario; it is
the structural limit RFC 0080's amended acceptance criterion already names, and it is
exactly why the degraded direction is proven at the host boundary instead of being declared
satisfied by a green lane. **C5 is what makes the lane worth anything at all** — it proves
the flip and the ledger removal are load-bearing rather than decorative.

**C3 was expected RED and came back GREEN, which under the A-grade rule is a defect report.
Investigated rather than recorded as a pass, and it was not a test defect — it was a
sabotage that never produced the defective OUTPUT.** `closeAndOrderDimensions` filters
`MEMORY_DIMENSIONS` rather than spreading what the mapper collected, so the bad name never
left the module; C3b confirms the scenario's enum assertion fires the moment a bad name
actually reaches the wire. The closure was doing real safety work while resting on a
`.filter` a future editor could "simplify" to `[...dims]` with no visible change for any
valid input — so it was renamed to say what it does, exported, and given its own behavioral
test (sabotage S12).

**C2 is the residual blindness**, and it is the reason the unit test's durable-tier leg
asserts the fields are ABSENT rather than merely well-formed: an over-stamp satisfies every
assertion the corpus makes. Sabotage S4 measures that this host catches it.

### Sabotage table

Every row snapshots the file, proves the diff **against that snapshot** before any test
result is read, and proves a byte-exact restore after. The final tree diff was empty.
Each red was checked for WHICH assertion failed — a red on a setup or non-vacuity guard
is not evidence the test detects the defect.

| # | Sabotage | Result |
|---|---|---|
| S1 | projection never stamps (the pre-H51 silent state) | RED — the degraded-stamp leg, both lanes |
| S2 | emit `longTerm` instead of the §A name | RED — `toEqual(['long-term-durability'])` |
| S3 | stamp with an EMPTY dimension list | RED — the §C-1 iff |
| S4 | over-stamp: drop the `satisfied` filter | RED ×2 — default-tier exactness **and** the durable-tier ABSENT leg |
| S5 | drop the projection from `userRecordToEntry` ONLY | RED — the cold-instance read-through leg alone |
| S6 | advertise `writable: false` | RED ×2 — read/write tier-independence + the wire advert leg |
| S7 | `longTermMemoryDurable()` returns true unconditionally | RED ×2 — the tier-delta equality + the stamp |
| S8 | relax the `memoryShape` guard to truthy | RED — the malformed-manifest leg |
| S9 | add a `snapshotAt` term to `listMemoryEntries` | RED — the `replay-snapshot` SOURCE ratchet |
| S10 | reorder `MEMORY_DIMENSIONS` | RED — corpus-enum parity |
| S11 | over-strict: drop `long-term-durability` from the mapping | RED ×2 — guards the regression direction, so S8 is not just "any change is red" |
| S12 | `closeAndOrderDimensions` → `[...dims]` | RED — the structural-closure leg alone |
| S13 | `tokenCounter` outside the schema enum | RED — the advert-validates leg |
| S14 | `compaction.trigger` outside the enum (reachable only on the seam posture) | RED — proves the test's posture loop does work |
| S15 | strip the §C fields from the host-extension ALIAS by-id handler only | RED — names the alias path; the normative route is untouched, so the leg discriminates |

S11 and S14 exist because a guard that only fires in one direction is half a guard: S11
proves the mapping test rejects an under-mapping as well as an over-mapping, and S14 proves
the schema test would have missed a defect reachable only when
`OPENWOP_TEST_TRIGGER_COMPACTION` is set.

### One thing measured rather than argued: the projection is per-agent

`toEntry` calls `projectMemoryDegradation` once per inventory entry, and each call rebuilds
`memoryCapability()` and re-reads two env vars — a per-row recomputation on a route the SPA
hits on load. Hoisting it to once-per-request was considered and rejected on a
**measurement**, not a hunch: **1.16 µs/agent**, linear (50 → 63 µs, 200 → 227 µs, 1000 →
1166 µs). A realistic 200-agent inventory pays **0.23 ms**, against a route that already
does a storage read and serialises 200 objects. Hoisting would trade that for an optional
"precomputed set" parameter a caller can pass stale. Not worth it.

### Implementation record

| Area | File | Test |
|---|---|---|
| §A dimension model + advert + §C projection (SSoT) | `host/memoryDimensions.ts` | `test/memory-dimensions.test.ts` |
| closed-world enum filter (structural) | `host/memoryDimensions.ts` (`closeAndOrderDimensions`) | ditto (S12) |
| `capabilities.memory` validates its own schema, both tiers × both compaction postures | — | ditto (S13/S14, corpus copy via ajv) |
| `capabilities.memory` reads the SSoT; `longTermMemoryDurable` moved out | `routes/discovery.ts` | `test/memory-dimensions.test.ts`, `test/memory-degraded-projection-route.test.ts` |
| §C stamp, registry lane | `routes/agents.ts` (`toEntry`) | `test/memory-degraded-projection-route.test.ts` |
| §C stamp, read-through lane | `routes/agents.ts` (`userRecordToEntry`) | ditto (cold-instance leg) |
| closed-enum parity with the corpus schema | `host/memoryDimensions.ts` | `test/memory-dimensions.test.ts` (reads `@openwop/openwop-conformance`) |
| `replay-snapshot` source ratchet | `host/memoryDimensions.ts` | `test/memory-dimensions.test.ts` |
| wire shape vs `agent-inventory-response.schema.json` | — | `test/memory-degraded-projection-route.test.ts` (ajv, corpus copy) |
| advert flip + opt-out ledger removal | `routes/discovery.ts`, `conformance/run.ts` | `memory-degraded-projection` executed-pass |
| H49 pin deleted, on its own instruction | `test/memory-sr1-chokepoint.test.ts` | — |

### Residue

- **TTL is implemented but unadvertised in TWO places, both available honesty flips,
  deliberately not taken here.** `capabilities.memory.ttlSupported` (the RFC 0004 §E
  field) and `capabilities.memory.retention.{ttl,forget}` (the RFC 0080 §A field) are both
  absent, while the host honours `expiresAt` (`notExpired` in `listMemoryEntries`, proven
  non-vacuously by H49's `ttl-probe`) and offers a tenant-scoped delete-by-subject
  (`clearSubjectMemory`). They stay unadvertised so this PR's diff stays on its own
  decision; because the dimension set is read off the advert, advertising `retention`
  later moves the model with zero edits to `memoryDimensions.ts`.
- **RFC 0004 §A's run-start snapshot rule is unimplemented** — see `replay-snapshot` above.
  The obligation is incurred by the `agents.memoryBackends` advert (H49), not by this flip;
  H51 makes it explicit and ratchets it rather than inheriting it silently. Closing it means
  a run-start logical timestamp threaded into `listMemoryEntries`/`getMemoryEntry`.
- **`multi-agent-memory-lifecycle`'s MAE-3 leg is now one env var from executing.** With
  `memory.supported: true` its gate is `phase2OrLater ∧ memory.supported ∧
  OPENWOP_TEST_EXPIRED_REPLAY_RUN_ID`, and only the last is missing. Whoever sets that var
  will be demanding a `422 replay_memory_snapshot_unavailable` this host does not serve —
  the same gap as the row above, reached from the other side.
- `search` / `rank: 'relevance'` stay unoffered (unchanged from H49).
