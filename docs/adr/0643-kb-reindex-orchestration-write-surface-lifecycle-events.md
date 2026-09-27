# ADR 0643 — Knowledge Base: a self-completing reindex, a minimal write surface, honest KB lifecycle events, and the port-binding witness that was scoped to the wrong pack

Status: implemented 2026-09-04 (feature loop 2026-09, iteration 5 — Knowledge Base / RAG; closes `KBWF-1/2/3/4/5/7/8/9/12/14` + the by-name half of `KBWF-13` from `WORKFLOWS-ASSESSMENT.md`, `KBC-1..5` + `KBC-22` from `CODEBASE-ASSESSMENT.md`, and the backend half that makes `KBX-1..5` true in `UX-ASSESSMENT.md`, all dated 2026-09-03; `KBWF-6/10/11/15` and `KBWF-13`'s declarative half stay open — see the Implementation record)


> **Renumbered THREE times: 0628 → 0630 (09-04), 0630 → 0642 (09-09), 0642 → 0643 (09-09) — the
> fourth and FIFTH collisions of the loop, both while this branch waited to merge.** The fifth landed
> within hours of the fourth: `0642-v1-end-of-service-inventory.md` was created 100 minutes after this
> file took 0642 and reached `main` first. The pattern is now the finding: **a long-lived branch pays
> a collision toll on every merge, and the only durable fix is to land it.** Original note follows.
>
> **Renumbered TWICE: 0628 → 0630 (2026-09-04), then 0630 → 0642 (2026-09-09) — the FOURTH collision
> of the 2026-09 loop.** The second one is the same shape as the first and confirms the rule rather
> than the cure: this ADR was created at 17:48 on 09-04 and `0630-adopter-steward-reachability-invariant.md`
> at 23:23 — mine is FIRST — but theirs merged to `main` during the five days this branch sat unmerged,
> carrying citations in two tests and three other ADRs (0366, 0636, 0641). Renumbering a MERGED ADR
> rewrites history and re-attributes citations across unrelated decisions, so the unmerged one yields
> regardless of creation order. The durable lesson is not "reserve earlier" — a pushed reservation
> twelve hours old did not prevent the third collision — it is: **re-run `check-adr-refs` at MERGE
> time, every time, and read its exit code rather than its last line.** The original 09-04 note
> follows, with one correction: the sweep that renamed 0630 → 0642 also rewrote this very sentence's
> history (it had said "0628 → 0630"), which is ledger entry #15's lesson repeating — a scripted
> bulk edit must be diff-passed for the places where the OLD number is a historical fact, not a
> reference.
>
> **Renumbered 0628 → 0630 at merge time (2026-09-04).** This ADR was created and its number
> reservation pushed at 2026-09-03 22:37; a peer's `0628-v2-era-key-and-the-storage-seat.md` was created
> at 2026-09-04 10:14 and reached `main` first, with citations in `CHANGELOG.md` and ADR 0629. By the
> collision policy the first-created file keeps the number — but renumbering an ADR that has already
> merged rewrites history and re-attributes citations across two unrelated decisions, so this unmerged
> one yields. Third collision of the 2026-09 feature loop (after 0618 → 0621 and 0625 → 0627); a pushed
> reservation twelve hours old did not prevent it, because a peer's `--next` only sees refs that peer
> has fetched.

## Context

The 2026-09-03 `/grade-workflows` re-grade moved Knowledge Base / RAG **B+ → B−**. All six
Blockers from the 2026-08-17 pass are genuinely closed (verified by mechanism, not by their
notes); two new ones replace them, and one of those is a blast radius the earlier pass named
but never measured.

**1. The ADR 0398 reindex has no host-side driver — and a stalled job freezes the collection.**
The drive loop is `for (let i = 0; i < 10000; i++) await drainReindex(...)` in the SPA
(`frontend/react/src/features/kb/KnowledgeBasePage.tsx:752-757`). The only non-test backend
caller of `drainReindex` is the HTTP door (`features/kb/routes.ts:227`); `registerJob` is used
by ten features and not by `kb`; `grep -rn "reindex" packs/ examples/` → zero.

The part that makes it a Blocker rather than an inconvenience: `assertNoLiveReindex`
(`kbService.ts:1936-1941`) throws **409** while the job is `running` **or `paused`**, and it
guards `ingestDocument` (`:1089`), `deleteDocument` (`:1170`) **and `upsertDocument` (`:1232`)** —
the last being the in-process replace path every managed indexer (production, profiles, strategy,
priority-matrix, docs) calls, so the freeze reaches the derived-KB mirrors too. A filed count is a
floor: the grade said two sites and the review found three. Those have **eight** production callers —
KB routes, agent-knowledge ×3, documents, the knowledge-sync runner, notebooks, personal knowledge,
projects. So an abandoned tab, **or the ordinary daily
embed-budget pause** (`:2058-2059`, which needs no user error at all), leaves the collection
write-frozen for all eight lanes with no lease, TTL or sweeper — including the *scheduled*
sync, silently, on every tick.

**2. The port-binding witness is scoped to exclude the pack that still has the defect.**
`WF-KB-5` (an unbound content port ⇒ a silently empty notification) was closed for the
knowledge pack on 2026-08-18. Its gate, `test/workflow-chain-knowledge-inbox.test.ts:173`,
iterates `PACKS['core.openwop.workflows.knowledge']!` — while the **inbox** pack sits in the
same map (`:51-55`) and in `PHASE2_CHAINS` (`:57`) for every other assertion. Behind the hole,
verified by walking the manifest: `inbox.triage`'s `notify` authors `inputs:['title']` and
binds only `.route`/`.toDrafts`; `inbox.call-debrief`'s `notify` authors `inputs:['title']`
and is fed by a **bare** edge. `packs/feature.notifications.nodes/index.mjs:43` reads
`inputs.message`, so both ship an empty body. The execution twin,
`test/workflow-chain-inbox-execution.test.ts`, reproduces all three vacuity sins the knowledge
file's own docblock catalogues.

**3. The surrounding format and honesty debt** — a read-only `ctx.features.kb`, a
schema-complete `core.openwop.rag` pack that no chain references beside a schema-less
`feature.kb.nodes` that seven chains do, one KB lifecycle event that no operator can discover,
five inert `config.query` keys, three `outputs` blocks with no producer, a positional
`outputRole`, six unclaimed backfill sweeps (one with no caller at all) and six
fire-and-forget index writes including a delete lane.

> **A prescription this ADR had to falsify before writing it down.** The obvious fix for (1)
> is "let `assertNoLiveReindex` ignore a stale job." That is **wrong and would corrupt the
> index**: the guard exists because a concurrent ingest lands only in the ACTIVE namespace
> while the staging build is a one-pass snapshot cursor, so ignoring the job resurrects
> deletes and skews the cursor — exactly what `kbService.ts:1930-1935` documents. A stale job
> must be **cancelled** (staging dropped, `pendingSignature` cleared), never ignored.

## Decision

> **REVIEW CORRECTIONS (2026-09-03, `/architect` pre-implementation pass — 6 Blockers, 5 Shoulds
> folded; the review RAN the call graphs and read the daemon, the budget service and the toggle
> resolver).** The first draft would have shipped a mechanism that is **inert on arrival**: it copied
> knowledge-sync's `featureId` onto a feature that GRADUATED its toggle, and the daemon fails closed
> on an unresolvable one (#1). It also (a) proposed a read-modify-write cancel on a store with no CAS,
> against a `drainReindex` that blind-`put`s a job it read before its provider call — a lost update
> that resurrects a cancelled job over a half-GC'd namespace, i.e. the exact corruption the guard
> exists to prevent (#2); (b) scheduled the destructive half of D1 three phases before the half that
> makes it safe, so a legitimate budget-paused reindex would be cancelled 30 minutes into a DAILY
> budget window — the very outcome the ADR's own "alternatives" section rejects (#3); (c) put a
> namespace-rewriting verb on a surface with no principal to authorize it (#4); (d) proposed emitting
> `document.deleted` on a lane where the `documentId` **is** the erased subject's key (#5); and (e)
> left the cadence unbudgeted against a 120-run/hour tenant ceiling that DROPS over-budget fires,
> which would then trip the lease and cancel the reindex — D1a and D1b together failing more
> reliably than either alone (#6). All corrected below; the review is the record. One claim survived
> attack and is now cited with its call graph rather than its intent (#12).

**D1 — The reindex completes without a browser, and can no longer freeze a collection.**
Two halves, shippable independently; the first is the safety net and lands first.

- **D1a — a lease, and expiry means CANCEL. TWO ceilings, because one clock cannot serve both
  states.** `ReindexJob.updatedAt` (`kbService.ts:1925`) is the lease clock; no new field.
  `assertNoLiveReindex` gains a bounded self-heal that is **status-aware** (review #3): a
  **`running`** job stale beyond `REINDEX_LEASE_MS` (30 min — a drain-liveness lease) is cancelled;
  a **`paused`** job is budget-paused *by construction* (`kbService.ts:2058-2059` is the only writer
  of `paused`) and expires only against `REINDEX_PAUSE_MAX_MS` (48 h — two daily budget rollovers).
  The first draft's single 30-minute clock would have destroyed exactly the legitimate work the
  "D1a alone" alternative was rejected for destroying. Cancelling means the `cancelReindex` path
  (drop staging vectors, clear `pendingSignature`), never merely ignoring — ignoring resurrects
  deletes and skews the cursor (`kbService.ts:1930-1935`).
  **Concurrency (review #2).** The lease check and the cancel are a read-modify-write on a store
  with **no CAS**, and `drainReindex` blind-`put`s a job it read at `:2018` after a provider call
  (`:2069`, `:2091`) — so a naive cancel is lost-updated back to `running`, and the job then resumes
  into a namespace whose vectors were just deleted, with a cursor that skips them, and cuts over onto
  the truncated result. D1a therefore lands (a) a generation/CAS field on `ReindexJob`, using the
  in-tree 4-attempt loop `recordOwnership` already hand-rolls for this exact reason
  (`workflowOwnership.ts:91-99`), so every `reindexJobs.put` re-reads and refuses to write over a row
  whose status has left `running`/`paused`; and (b) `drainReindex` MUST abort its loop when its
  re-read shows `cancelled`/`failed`, leaving the staging namespace to the canceller.
  **A decision, not a side effect (review #8):** with cancel-on-expiry an erasure
  (`eraseSubjectKb` → `deleteDocument`) can now cancel an admin's reindex. Erasure outranks a
  rebuild — that is the right precedence and it is recorded here rather than discovered later.
  Witnesses: a 31-min-stale `running` job unblocks the write AND leaves no staging vectors; a
  29-min-stale one still 409s; a **`paused`** job 31 minutes stale still 409s and survives a budget
  rollover; and a drain suspended mid-batch while a concurrent expiry-cancel lands MUST NOT write
  `running` back, MUST NOT advance `embeddedChunks`, and MUST NOT cut over.
- **D1b — a recorded, scheduler-driven drain.** Following the `knowledge-sync.run` precedent,
  **with one deliberate divergence that decides whether any of this works** (review #1): the job is
  registered with **NO `featureId`**. The ADR 0599 §6 owning-feature gate resolves `featureId`
  through `resolveOne` (`scheduleDaemon.ts:111`), which returns `null` for a **graduated** feature
  (`featureToggles/service.ts:69-70` — `getToggleDefault` is undefined once the toggle is removed),
  and the daemon treats `null` as disabled and calls `recordJobSkipped(_, 'feature-disabled')`
  (`:118-123`). `kb` graduated its toggle (`feature.ts:30`), so copying knowledge-sync's
  `featureId:'kb'` would skip **every fire, forever**, invisibly — an `info` log, not an error — and
  D1a would then cancel the stalled job 30 minutes later. `kb` takes the daemon's documented
  *absent-`featureId` ⇒ ungated* path instead. Concretely: a new chain pack
  `examples/workflow-chain-packs/kb-reindex/` with one chain `kb.reindex` (params
  `orgId`, `collectionId`), one node `feature.kb.nodes.reindex-drain`. `startReindex`
  instantiates it per collection (`expandChain → registerWorkflowDurable → recordRevision →
  recordOwnership`, workflow id `kb.reindex:<orgId>:<collectionId>`) and registers a
  job on a **`*/10` cadence**; each run drains ONE large bounded slice; reaching
  `done`/`cancelled`/`failed` deletes the job **and** the workflow's ownership + registry rows.
  A budget `paused` job therefore resumes by itself when the budget rolls over — which is what
  removes the *ordinary* path into D1a's lease expiry. The SPA loop stays as the interactive fast
  path (it makes the same call) and the Resume button stays honest, but it is no longer the only
  driver.
  **Cadence and budget, stated (review #6).** The scheduler consumes the tenant's autonomous-run
  budget on every fire — 120/hour by default (`runBudgetService.ts:41`), consumed on denial too —
  and **DROPS** an over-budget fire rather than queueing it (`scheduleDaemon.ts:126-136`), which
  under D1a would then cancel the reindex. A per-minute job would eat half the tenant's entire
  budget for the life of the reindex and two concurrent reindexes would eat all of it, starving
  every knowledge-sync tick and host-event trigger. Hence `*/10 * * * *` (6 runs/h) and a per-run
  `maxChunks` sized — **measured, not guessed** — to fit comfortably inside the executor's node
  deadline. A collection needing more runs than the budget allows is reported at `startReindex`
  time, not discovered by silent cancellation.
  **Identity and teardown (review #10).** The workflow id is
  `kb.reindex:<tenantId>:<orgId>:<collectionId>`, mirroring the existing `reindexKey`
  (`kbService.ts:1928`), because `registerWorkflowDurable` writes into a **global** id-keyed map
  (`workflowsRegistry.ts:35-39`) and `orgId` is caller-suppliable (`accessControlService.ts:425`).
  Terminal status removes the ownership record (`removeOwnership`) and the registry row as well as
  the job — knowledge-sync's `deleteSyncSource` (`:778-789`) drops only the job, which is survivable
  for a long-lived sync source and is not for a per-reindex ephemeral workflow that would otherwise
  accumulate a permanent `/builder` gallery entry per reindex ever run.
  **Scope stated precisely: the node re-embeds existing chunks only. It MUST NOT reach media
  extraction** — `kbService.ts:1765-1772` declares that path replay-unsafe by design and sound
  only because every caller is a non-recorded service op. Re-extraction inside a recorded run
  would break `:fork`. **Verified by call graph, not by intent (review #12 — the one claim that
  survived attack):** `drainReindex` (`:2017-2097`) → `docsInCollection` → `chunkMetaRows`
  (`:654-660`, reads the durable `doc.text` only) → `embed` → `vector.upsert` → cutover. Nothing on
  that graph reaches `resolveSource` (`:1810`), `extractTextFromBytes` or `mediaToTextViaLLM`
  (`:1774`) — those are reachable only from `ingestDocument`, which the drain never calls. A ratchet
  pins it: no `feature.kb.nodes` surface verb may transitively reach `extractTextFromBytes`.

**D2 — A minimal, closed-world KB write surface, and schema-bearing nodes (`KBWF-3`, `KBWF-4`).**

> **PRECONDITION added 2026-09-03 after this iteration's `/grade-code` pass (`KBC-1`) — D2 MUST NOT
> ship before it.** The ADR 0608 `boundSubject` gate is mounted on the **HTTP door only**:
> `resolveSubjectAccess` appears for KB at exactly two sites (`kb/routes.ts:83,114`), and
> `kbService` reads `boundSubject` only to SET, RELEASE or PROJECT it (`:869-890`, `:930`) — never
> to gate a read. So `buildKbSurface`'s four verbs, `tenantRetrieve`, `ctx.knowledge`
> (`feature.ts:25` — every workflow run and every agent chat turn) and `docs/surface.ts:38` all read
> straight past it. That is **the read side of the H1 leak** whose birth site was just closed by
> #3625, still open on every non-HTTP lane. Adding `reindexDrain` to that surface would widen an
> ungated **read** bypass into an ungated **write** bypass — my fix reintroducing the family it
> closes. The cure is the one the H1 lesson already names: gate at the **single composition owner**,
> not at each door. `kbService` enforces `boundSubject` for every read and write it serves, the two
> route call sites become redundant (kept as defence in depth), and the surface inherits it by
> construction. Witness: a workflow run and an agent chat turn reading a project-bound collection
> they are not a member of are BOTH refused, asserted at the service, not the route — the existing
> `project-knowledge-visibility.test.ts` asserts only over HTTP, which is why this was invisible.
`ctx.features.kb` gains exactly what D1b needs and nothing more: `reindexDrain({orgId,
collectionId, maxChunks})` and `reindexStatus({orgId, collectionId})`. Ingest is **deliberately
not** exposed (the media constraint above, and every ingest lane already has an owner).
**`reindexDrain` is not a general-purpose verb, and its authorization is STRUCTURAL because no
predicate can transfer (review #4).** The HTTP door is `requireOrgScope(req, 'host:org:manage')`
(`routes.ts:224`) — the highest gate in the feature, chosen because the operation spends provider
budget and rewrites a namespace. That predicate **cannot** be shared: `requireOrgScope` needs a
`req`, and a schedule-fired run has no acting user at all (`inMemorySurfaces.ts:245-249`). Without
a structural control any workflow author in the tenant could add the node to any chain and
force-complete or race-cancel an admin's reindex — `drainReindex`'s terminal branch flips
`activeSignature` and **deletes** the old namespace's vectors (`:2074-2089`). So the verb refuses
unless BOTH (a) a `running`/`paused` job already exists for that collection — which only the
admin-gated `startReindex` can create — AND (b) `scope.workflowId` equals the host-minted
`kbReindexWorkflowId(tenantId, orgId, collectionId)`, i.e. it is callable only from the workflow
`startReindex` itself instantiated. `BundleScope` gains `workflowId` (it already carries `runId`).
Witness: an arbitrary tenant chain declaring `feature.kb.nodes.reindex-drain` is REFUSED with a
typed error, asserted at the node boundary.
`feature.kb.nodes` 1.1.0 → **1.2.0**: the new `reindex-drain` node is `role:"side-effect"` +
`capabilities:["side-effectful"]`; all four nodes gain ADR 0525 `$id` input/output schemas at
`/1.2.0/`; the floor + served set + baseline regenerate together; `feature.ts:34` pin moves in
the same commit; registry republish owed. `core.openwop.rag` is declared **agent-tooling-only**
in its own manifest description — it is referenced by eleven agent `toolAllowlist` arrays and
zero chains, and saying so stops the next reader treating it as dead.

**D3 — KB lifecycle events, ONE site per transition, with the catalog row in the same commit
(`KBWF-5`).** `host.kb.document.updated` already exists at `kbService.ts:1277` and stays the
one `updated` site. Added, ids-only, transition-guarded on the landed row:
`document.ingested` (the created branch of `ingestDocument` only), `document.deleted`,
`reindex.started`, `reindex.completed`, `reindex.failed`. `KB_EVENT_TYPES` is a closed-world
union with a parity leg asserting equality with the catalog in BOTH directions, and the rows
land in `frontend/react/src/settings/hostEventCatalog.ts` in the same commit — the baseline
entry at `test/fixtures/host-event-catalog-baseline.json:9` is removed, not re-baselined.
**Bulk lanes are silent** (the CRM `{silent:true}` precedent): the six backfill sweeps, the
knowledge-sync runner's per-file re-ingest, and notebooks' bulk source ingest pass
`{ silent: true }` and, where a batch is meaningful, emit ONE `document.ingested {count}`.
A 10 000-document import must not ignite 10 000 runs.
**The erasure lanes are silent UNCONDITIONALLY, and that is a correctness rule, not a volume one
(review #5).** `eraseSubjectKb` (`kbService.ts:2154-2185`) deletes documents whose `documentId`
**is the subject key** (`subjectKeyedDocId`, `:2139`), and `removeProfileStrict`
(`profilesKnowledgeService.ts:109-118`) does the same on the DSAR fan-out — so a
`document.deleted{documentId}` there would publish the just-erased person's identifier to external
webhook endpoints and into `metadata.triggerData` of every bound workflow, at the one moment the
system has just promised it is gone. `stripPiiPayload` cannot save it: it matches `email`/`phone`
keys only, and its own docblock (`hostEventDispatcher.ts:164-196`) states that "ids only" is
unenforceable because an id-shaped string carries no signal distinguishing an artifact id from a
person id. `deleteDocument` therefore takes an explicit `{ silent: true }` that the eraser, the DSAR
remover and tenant teardown pass; the emit is on the ROUTE lane only. (Secondary, same site: an
unsilenced erasure would emit one event per document, each consuming the tenant's autonomous-run
budget at `hostEventDispatcher.ts:279` — an erasure could starve every scheduled job for the
window.) Witness: `eraseSubjectKb` over N subject-keyed documents emits ZERO host events, asserted
against a spy on both count and payload.

**D4 — The port-binding witness covers every Phase-2 pack, and the two inbox chains are fixed
at the root (`KBWF-2`).** `test/workflow-chain-knowledge-inbox.test.ts:173` widens from
`PACKS['core.openwop.workflows.knowledge']!` to `PHASE2_CHAINS` — born-red on
`inbox.triage` and `inbox.call-debrief` — and the blast radius is exactly those two, since
`PHASE2_CHAINS` is six chains and `inbox.followup-nudger`'s gate already binds
`draft.content → approve.artifact` (measured in review, not assumed). `inbox.call-debrief` gets a
named `debrief.content → notify.message` edge, replacing its bare one. **`inbox.triage` is NOT
fixable with one edge (review #7):** its `notify` is fed by two **mutually exclusive** conditional
edges (`route → notify.route` on the else branch, `toDrafts → notify.toDrafts` on the then branch),
and the gate passes if ANY edge targets `.message` — so a single binding turns the gate green while
the other branch still delivers an empty body. That is the WF-KB-5 defect surviving its own fix,
invisible to the very gate being widened. It **splits into two branch-owned `notify` nodes.**

> **CORRECTION (2026-09-03, implementation) — the authored-literal option this ADR offered is
> UNIMPLEMENTABLE as intended, and the implementer proved it rather than picking the other option by
> taste.** `executor.ts` merges `{...edgeInputs, ...node.inputs}`, so an authored fixture **wins**
> over every edge-supplied value: an "always non-empty" `inputs.message` literal would statically
> override the branch content on both branches, buying emptiness-avoidance by making the message a
> constant — i.e. by deleting the product. The split is also strictly better than this ADR
> anticipated: with one `notify`, the widened structural gate is satisfied by a single `.message`
> edge and stays blind to the other branch forever; with two, each node must carry its own binding,
> so the gate covers both. A second constraint surfaced only by running the suite:
> `chain-node-undeclared-keys.test.ts` enforces that every notify's `inputs.title` equals its own
> chain's `label`, so the two nodes share a title and the witness discriminates on **body plus an
> exact row count** — the stronger assertion anyway.

The execution witness asserts a NON-EMPTY delivered message **on both branches**, because the
structural gate provably cannot distinguish them. Demonstrated by an identity-preserving sabotage:
the split kept, every node name kept, an edge still targeting `.message` but given a never-firing
condition — the widened **structural gate stays green** while the witness fails on delivery. `test/workflow-chain-inbox-execution.test.ts`
is rewritten on the knowledge-execution pattern — the real `feature.notifications.nodes.notify`
implementation, the real `buildNodeInputs`, delivery asserted **as delivery** at the port —
with legs added for `inbox.call-debrief` and `inbox.followup-nudger`, which have no execution
witness at all today.

**D5 — Format debt (`KBWF-7`, `KBWF-8`, `KBWF-13`).** The five inert `config.query` keys are
deleted (`support:32`, `marketing:122`, `finance:77`, `lighthouse:151`, `it-support:39`) —
`packs/feature.kb.nodes/index.mjs` never reads `ctx.config`. **`finance.month-end-close` is
NOT silently re-scoped:** its config string is the only place the author's period-scoping
intent appears, and binding it into `inputs.query` would change retrieval behaviour, so the
key is deleted and the intent is recorded as an open question below rather than guessed at.
The three `outputs` blocks (`knowledge/pack.json:51,95,127`) are **deleted**, not backed:
the manifest reserves `producedVariables` for values written to the run bag with **no typed port**,
and all three (`answer.content`, `review.content`, `summarize.content`) ride typed ports consumed by
real edges — so backing them would emit `variables[]` entries no node writes, putting the same lie in
a new channel. `metadata.outputs` has zero readers repo-wide (only `workflowChainPackLoader.ts:1553`
writes it).

> **CORRECTION (2026-09-03, implementation) — "declare `outputRole` explicitly" is UNIMPLEMENTABLE
> on this host and needs a spec change, not host work.** The implementer ran the probe rather than
> assuming: `FragmentNode` in the vendored manifest schema is `additionalProperties: false` over
> `{id, typeId, name, position, config, inputs, compensation, irreversibleEffect}`, so authoring
> `outputRole` makes the **whole pack fail to load**
> (`workflow_chain_pack_manifest_invalid … must NOT have additional properties`). And `expandChain`
> never reads an authored value anyway — `:1379` writes the role purely from `primaryNodeId`. Making
> it declarative therefore requires an **RFC 0013 revision in `../openwop`**, which is out of this
> ADR's host scope. The achievable intent shipped instead: `EXPECTED_PRIMARY` in
> `workflow-chain-knowledge-inbox.test.ts` pins the primary terminal **by name for all six Phase-2
> chains**, plus a completeness assertion so a new chain cannot arrive unpinned — a reorder is now
> caught by a red test rather than shipping silently. `KBWF-13` is closed by that pin and re-filed
> as an RFC-gated follow-up.

**D6 — The backfill sweeps and the fire-and-forget writes (`KBWF-10`, `KBWF-11`).**
`backfillProductionKb` (`productionKnowledgeService.ts:98`) has no caller: it is either wired
to a route like its four route-driven siblings or deleted — not left as reachable-only-by-editing.
The six `void` index writes become `await`ed, starting with the one the prior pass missed:
`production/routes.ts:171`, the vendor **DELETE** lane, where a dropped continuation strands a
KB document for a deleted vendor. This host is documented three times over to suspend detached
continuations under `cpu-throttling=true` (`CLAUDE.md:503`, ADR 0556 `:577`, ADR 0585 `:88`),
so `void` here is a known-bad shape. The rule is stated once, in `kbService`'s docblock: a
derived-index write **or a host-event emit** on a mutation path is awaited; a genuinely optional one
is queued, never detached. **That extension is not cosmetic (review #9):** the existing
`host.kb.document.updated` emitter is itself `void emitHostEvent(...)` (`kbService.ts:1277`), as is
`void fireKnowledgeDocumentChanged(...)` (`:1179`, `:1274`) — so the one KB event that exists today
may already be dropped in production, and D3 would have added five more on the same lane. All are
converted in the same commit; `emitHostEvent` never throws by contract
(`hostEventDispatcher.ts:222-229`), so awaiting costs only latency.
**Measured, so the change is not taken on faith (review #13):** all six `void`'d calls already
self-catch (`productionKnowledgeService.ts:79-81,92-94`; `profilesKnowledgeService.ts:99-101`), so
awaiting can never fail the mutation — including on the `assertNoLiveReindex` 409; and in provider
embed mode `ingestDocument` defers vectorization to the next hydrate (`kbService.ts:1141-1152`), so
the awaited cost is a durable put, not a provider round-trip. None of the six is a sweep; the only
sweep is `backfillProductionKb`, whose caller count is confirmed zero.

**D7 — Say the true thing (`KBWF-9`, `KBWF-12`, `KBWF-14`).**
`test/builtin-workflow-ratchet.test.ts` gains a header cross-reference naming
`test/workflow-pin-site-ratchet.test.ts` as the gate that actually enforces the invariant, and
its PHASE 3 / PHASE 4 comments are reworded to claim only what that file checks — they
currently assert a code-pinned workflow "is no longer expressible at ANY layer" while three
live boot-path literals sit in the sibling file's quarantine. `designWorkflow.ts:22`'s stale
`registerBuiltinWorkflow` claim is corrected. "Sync now"
(`knowledge-sync/routes.ts:259-268`) either dispatches `knowledge-sync.run` like the cadence
lane or states in one line why the manual lane is deliberately not a recorded run.

> **R3 REVIEW FOLD (2026-09-04) — two Blockers and six Shoulds against the D1a/D2/KBC-1 build
> (`8c68fcaa5`), folded in the same commit as D3 + KBC-3 + D6. The review is the record; what
> changed, with the witness that pins each:**
>
> - **Blocker 1 — the ADR 0464 eraser skipped every BOUND collection.** KBC-1 made an omitted caller
>   `{ subject: undefined }`; `eraseSubjectKb` passed none, `filterReadable` dropped every
>   project/notebook-bound row, and the eraser returned `{ documentsDeleted: 0 }` over a corpus that
>   still held the subject's `profile:<key>` document — the exact failure its docblock forbids.
>   `kb-erasure-retention.test.ts` had zero `boundSubject` fixtures. FIX: `PREAUTHORIZED_CALLER` at
>   both eraser sites — an ERASER is the sanctioned bypass (no membership to resolve; the fan-out
>   counts its failures). Witness `kb-subject-gate-doors.test.ts` (unbound control, bound leg, the
>   real `eraseSubject` fan-out). Dovetails with D3: the same `deleteDocument` call is `{ silent:
>   true }` unconditionally.
> - **Blocker 2 — `PREAUTHORIZED_CALLER` on user-driven BIND/CREATE doors.** A non-member could bind
>   a bound corpus to an agent (or their profile, a sync source, a public share link, a comment
>   thread) and the USE lanes, pre-authorized BY the binding, then served the private titles and
>   chunk text. The composition's cited "ADR 0608 D5 reconciler" governs advisory-board share-kind
>   provider collections, not agent bindings — the comment is corrected in place. FIX, stated as
>   the rule it is: **every door that turns a user-supplied `collectionId` into a grant resolves
>   the REAL principal** (`callerSubject(req)` / the profile owner / the minting actor / the
>   commenting author / the sync source's creator), and **`PREAUTHORIZED_CALLER` remains only on the
>   use lane after a binding exists**. Of the two options the review offered — re-resolve at use
>   or reconcile on membership removal — this fold does the FIRST wherever a principal exists (the
>   two agent-knowledge HTTP reads re-resolve the READER; every profile-memory lane reads as the
>   owner; the knowledge-sync runner writes as the connection owner on every pass) and STATES the
>   residual for the run/chat lane, where the binding is an owner-scoped grant and the speaker is
>   not the binder: a binding outlives its binder's project membership. Reconciling agent bindings
>   on membership removal needs a membership-change seam the host does not expose; filed as
>   follow-on rather than half-built. The advisory-board reconciler is the one sanctioned
>   pre-authorized bind (share-kind provider collections, never subject-bound; the share is its
>   door). Witnesses: `kb-subject-gate-doors.test.ts` (four doors, each with a member positive
>   control) + `kb-lifecycle-silent-lanes.test.ts` (the runner).

> **CORRECTION (2026-09-12, ADR 0664 D3) — the residual above is TRUE but states only ONE of
> this decision's three consequences.** The decision itself stands: leaving
> `PREAUTHORIZED_CALLER` on the use lane, because "the binding is an owner-scoped grant and
> the speaker is not the binder", is a deliberate product position and ADR 0664 does not
> reverse it. What was understated is its reach.
>
> 1. **Temporal (recorded above):** a binding outlives its binder's project membership.
> 2. **Structural (NOT recorded):** a member who was **never** in the project reads the corpus
>    too, from the moment of binding — not only after someone's membership lapses. A
>    maintainer reading the residual as written would not learn this, and it is the larger of
>    the two: it applies to every tenant member immediately, rather than to one person later.
> 3. **Un-gated selection (NOT recorded):** the run lane's `agentId` is **caller-supplied**
>    (`agent-knowledge/surface.ts:52`, `bootstrap/nodes.ts:1790`) with no visibility check, so
>    any workflow author can point the retrieve node at ANY roster agent and read its bound
>    corpora into a run output they control — including a corpus someone else bound. That is
>    wider than "the people who use the agent", which is the premise the justification above
>    rests on. Filed as `AGKM-10`.
>
> **"the four doors" is now five.** `routes/agents.ts:327` (agent dispatch) is an HTTP lane
> that HOLDS a principal (`req.userId`, used 17 lines later) and passed none — so by this
> fold's own rule, "the FIRST wherever a principal exists", it should have re-resolved and did
> not. It sits on a different router, which is why this enumeration missed it. Fixed in
> ADR 0664 D6, with the door test extended to cover it.
> - **Should 3 — the driver definition was deleted under its recorded run.** `teardownKbReindexDriver`
>   now ARCHIVES (transient + `archivedAt`) a definition any run references — the same rule
>   `routes/workflows.ts` enforces as `workflow_referenced` — and deletes outright only a driver
>   that never fired; the retention sweeper's transient GC collects the archived row once its runs
>   are pruned. Witness: `kb-node-replay.test.ts` forks a finished drain run.
> - **Should 4 — check (b) was satisfiable by any run-creating member.** The driver is registered
>   `transient` (hidden from the gallery and the `/` picker) AND the surface now requires **no
>   acting user** (a schedule fire has none; a human-started run always does).
> - **Should 5 — `commitCollection` exhaustion returned the live row as if committed.** It now throws
>   `409 collection_cas_exhausted`; witnessed on `setRetrievalConfig` and on the cutover.
> - **Should 6 — replay/fork witness for the side-effect node:** `kb-node-replay.test.ts`.
> - **Should 7 — `driver: 'scheduled' | 'interactive-only'` on `ReindexJobView`.** Stamped from
>   `ensureKbReindexDriver`'s outcome so the console can say which. **Legacy live jobs (predating
>   this field) are left to the lease, deliberately:** a boot sweep would have to run after the
>   chain packs load, and a `running` job without a driver is cancelled by D1a within 30 min
>   (48 h for `paused`) — an absent `driver` reads as `interactive-only`, which is the truth for
>   them; the SPA loop still drives them while a tab is open.
> - **Should 8 —** the budget-resume witness now ticks `processDueSchedules` for the second slot.
> - **NIT —** the `core.openwop.rag` manifest now carries the agent-tooling-only sentence D2 decided
>   (patch bump 1.0.1 → 1.0.2, steward manifest regenerated); the `kb-reindex` chain pack's
>   description no longer claims the registry row is deleted (1.0.0 → 1.0.1).

## Boundaries audit

- **No new namespace.** `kb:reindex` (`kbService.ts:1927`) is the existing job store; D1a adds
  no field (`updatedAt` is the lease) and D1b adds no store — the per-collection workflow +
  job ride the existing `wfreg:`/scheduler rows, teardown-reachable exactly as knowledge-sync's are.
- **One owner per concept.** The reindex state machine stays entirely in `kbService`; the node
  is a thin call through the surface, like `feature.knowledge-sync.nodes.run`. No second
  reindex driver is created — the SPA loop calls the same route.
- **No parallel scheduler.** D1b uses `registerJob` → the ONE `scheduleDaemon`
  (`scheduleDaemon.ts:138`), the seam `WF-KB-14`'s tripwire demands. No `features/kb/*Daemon.ts`.
- **The `/builder` reachability rule holds.** The per-collection reindex workflow is registered
  with `recordOwnership`, so it appears in the tenant ownership index — unlike the three
  boot-path turn-workflows, which is precisely why those sit in a shrink-only quarantine.

## RFC verdict

**Host-extension only — no new `../openwop` RFC.** `host.kb.*` are host events on the ADR 0208
dispatcher, not wire events; `ctx.features.kb` is a host workflow surface; the node schemas
ride the existing ADR 0525 convention; the chain uses no new manifest facet. The vendored
chain-pack manifest schema is already byte-identical to the spec SSoT and this ADR does not
touch it.

## Alternatives weighed

- **Leave the browser as the driver and only add the lease (D1a alone).** Cheapest, and it does
  remove the Blocker's teeth. Rejected as the whole answer: a budget-paused reindex would still
  need a human to return and click Resume, so a large collection can never finish unattended —
  and the lease would then routinely *cancel* real work rather than protect against a rare
  abandonment.
- **A bespoke KB drain daemon.** Rejected — that is exactly what `WF-KB-14`'s tripwire forbids
  and what knowledge-sync was just migrated off (`KSWF-1`).
- **Expose `ingest` on `ctx.features.kb` so chains can author documents.** Rejected for now:
  the media-extraction path is replay-unsafe by design, every ingest lane already has an owner,
  and a write verb reachable from a chain would need its own trust/erasure story. Recorded as
  an open question, not shipped by omission.
- **Re-baseline `host.kb.document.updated` in the catalog-parity fixture.** Rejected — the
  baseline is shrink-only and the row is one line; adding the emitter to the catalog is the fix,
  re-baselining is the evasion.

## Phased plan

| Phase | Work | Witness |
|---|---|---|
| P1 | **D1a** — the CAS/generation on `ReindexJob`, the abort-on-non-running re-read in `drainReindex`, and status-aware expiry (`REINDEX_LEASE_MS` for `running`, `REINDEX_PAUSE_MAX_MS` for `paused`). **Safe standalone by construction** — the 30-min lease never touches a budget-paused job | 31-min-stale `running` unblocks the write and leaves no staging vectors; 29-min-stale still 409s; a `paused` job survives 31 min AND a budget rollover; a drain suspended mid-batch against a concurrent expiry-cancel writes nothing back and does not cut over; `kb-reindex.test.ts` green |
| P2 | **D3** — the five new events + catalog rows + `KB_EVENT_TYPES` parity leg (both directions) + the silent bulk lanes | lane-enumerated counts (route 1, backfill 0 + 1 batch, sync 0, notebooks bulk 0 + 1); baseline row removed, not re-baselined |
| P3 | **D2** — surface verbs + `feature.kb.nodes` 1.2.0 (reindex-drain side-effect, 8 schemas at `/1.2.0/`), floor/served/baseline/pin in one bump | `mode:'replay'` fork of a drain serves the recorded outcome; all 4 nodes through the real `buildKbSurface`; generators `--check` green |
| P4 | **D1b** — the `kb-reindex` chain pack + per-collection instantiate + `registerJob` (**no `featureId`**, `*/10` cadence, tenant-qualified id); terminal status deletes job + ownership + registry row | a drain completes with NO browser — asserted POSITIVELY (`recordJobRun` fired) **and** by the absence of `recordJobSkipped` for `feature-disabled` or budget, since a skipped fire otherwise reads as a flaky timeout (review #14); a budget-paused job resumes on the next tick; N runs stay under the 120/h budget; after N reindexes the ownership index holds ZERO `kb.reindex:` rows; `:fork` determinism |
| P5 | **D4** — widen the port gate to `PHASE2_CHAINS`, fix the two inbox chains, rewrite the inbox execution witness | the widened gate is born-red on both chains, then green; delivery asserted at the port; `call-debrief` + `followup-nudger` legs added |
| P6 | **D5** — delete the 5 dead `config.query`, back or delete the 3 `outputs`, declare `outputRole` | `kb-rag-chain-wiring` green; a node reorder no longer moves `primary` |
| P7 | **D6 + D7** — the backfill decision, the awaited writes, the three honesty corrections | `production` delete lane awaited; ratchet header cross-references the real gate |
| P8 | **`KBC-1`** — `boundSubject` enforced in `kbService` for every read/write it serves (the D2 precondition above), plus the `/grade-code` Blockers this iteration also closes: `KBC-3` (`doHydrate:805` embeds every missing chunk in ONE call while `drainReindex` batches at 64, so provider mode degrades to lexical-only permanently above ~2k chunks), `KBC-4` (`documents/routes.ts:285` is the one by-id door in its file that skips `assertOwnerReadable`, which its four siblings call), `KBC-5` (three independent ways a deleted vendor's KB doc survives) | a workflow run and an agent chat turn are refused a project-bound collection at the SERVICE; hydrate is batched + budgeted; the documents door matches its siblings; a deleted vendor's doc is gone on all three paths |
| P9 | closeout: trackers (`KBWF-1..14`, `KBC-1..5`, `KBX-1..14`), ADR → implemented | |

## Open questions

- [ ] `finance.month-end-close` — was the retrieval meant to be period-scoped? D5 deletes the
      inert key rather than guess; if yes, the follow-up binds the period through a declared
      input, which is a behaviour change and needs its own witness.
- [ ] Should `ctx.features.kb` ever expose `ingest`? Deferred with a reason above, not omitted.
- [x] `REINDEX_LEASE_MS` default — **RESOLVED in D1a, not deferred (review #11).** One wall-clock
      number cannot serve both states: `paused` is bounded by a DAILY budget rollover, not by a batch
      duration, so any single value is either too short for a pause or useless as a lease. Two
      ceilings instead. The 30-minute figure still wants measuring against a real large-collection
      drain, but the *shape* no longer depends on getting it right.
- [ ] Per-run `maxChunks` for D1b — must be measured against the executor's node deadline before
      the default is trusted; the budget arithmetic (6 fires/h) depends on it.

> **R5 CORRECTION (2026-09-09, the fifth review round — a data-loss path the fourth round's own fix
> opened).** D1a R4 introduced `cutting-over` so a cancel could not race a flip. But a crash BETWEEN
> the collection flip (`activeSignature = toSig`) and the `status = 'done'` commit leaves a
> `cutting-over` row over an ALREADY-FLIPPED collection; the 30-minute lease then expires it into
> `cancelReindex`, where `collectionNamespace(col, job.toSig)` is no longer a staging namespace at
> all — **it is the collection's SERVING namespace, and the GC wiped the live dense index.** The
> freshness re-check had been applied to the `pendingSignature` clear and NOT to the vector delete
> beside it; that asymmetry was the defect, and the cutover's own comment ("the flip is live
> regardless; the row is reconciled by the lease") pointed recovery straight at it. Cost: a full
> provider re-embed, or silent lexical-only until the daily embed budget allows one. Fixed by
> branching on `col.activeSignature === job.toSig` before the GC — and, because a landed flip means
> the rebuild SUCCEEDED, the cancel now emits `reindex.completed` instead of telling a bound
> operator chain that a successful reindex failed with `lease-expired`. Witnessed born-red: with the
> guard disabled a dense search after the cancel returns ZERO hits.

## Implementation record (2026-09-04)

Renumbered 0628 → 0630 (2026-09-04) and then 0630 → 0642 (2026-09-09) — see the note at the top of this file; the third and fourth collisions of the loop. The renumber sweep itself produced ledger entry #15: diff-checked across four pack files, it still went stale on `packs/.steward-manifest.json`, so the executor refused `feature.kb.nodes` and the drain witness went deterministically red until `1d53d2f43` regenerated it. A diff-checked rename is not a regenerated manifest.

| Phase | Commit(s) | Witness |
|---|---|---|
| P1 D1a | `f75c65a5e`; `8c68fcaa5` (fold: `commitCollection` CAS over every collection-row RMW, identity-aware drift `gen + startedAt + toSig`, `progressAt`, aggregate 409 in the eraser); `67746aa33` (S5: CAS exhaustion → 409, never the live row as if committed) | `kb-reindex` (18: 31-min-stale `running` cancelled + no staging vectors, 29-min still 409s, `paused` survives 31 min AND a rollover, a drain suspended mid-batch against a concurrent cancel writes nothing back; born-red 5/8; 14 sabotages, three of which came back green and were made load-bearing via a storage proxy that parks one `kvGet`/`kvSet`) |
| P1 D1a (4th round) | `64cef45e9` — `cutting-over` status: claim → flip → `done`; CAS exhaustion → `failed` + `reindex.failed{reason:'cutover-conflict'}` + staging GC + reap; `assertNoLiveReindex` treats it as live, which closes the R2 traded window | racing-ingest witness rewritten (refused during the flip, lands after, reverts nothing); cutover-under-exhaustion asserts `failed` + the event + a new reindex startable |
| P2 D3 | `67746aa33` | `kb-lifecycle-one-site` (lane counts; idempotent same-id re-ingest ⇒ 0; reindex events after the staging GC), `kb-lifecycle-silent-lanes` (six sweeps, the runner, the eraser ⇒ 0 events), `host-event-catalog-parity` (= 6 in both directions; baseline row REMOVED) |
| P3 D2 | `8c68fcaa5`; `67746aa33` (S4 no-acting-user on the verb, S6 replay, `core.openwop.rag` 1.0.2 — the earlier commit message had claimed the manifest change falsely) | `kb-service-subject-gate`, node refusal at the boundary (sabotage: `workflowId` check dropped → red), `kb-node-replay` (`mode:'replay'` fork serves the recorded drain), generators `--check` current, schema-ids 1264, `check-pack-version-bump` 10 packs |
| P4 D1b | `8c68fcaa5`; `67746aa33` (S3 archive-under-run, S7 `driver` on the job view, S8 the resume witness ticks `processDueSchedules`) | `kb-reindex-scheduled-drain` (POSITIVE `recordJobRun` + the ABSENCE of `feature-disabled`/budget skips — sabotage: `featureId` restored → red; a budget-paused job resumes on the next tick; N reindexes leave ZERO `kb.reindex:` ownership rows) |
| P5 D4 | `3e38ee452`; `b4c75acdc` (the `toDrafts → notifyDrafted.savedTo` ordering edge the split dropped) | `workflow-chain-knowledge-inbox` (gate born-red on both inbox chains), `workflow-chain-inbox-execution` (189 → 660 ln, seven legs, delivery asserted as a durable row with a NON-EMPTY body on BOTH triage branches; identity-preserving sabotage: gate green, witness red) |
| P6 D5 | `3e38ee452`; `b4c75acdc` (inbox's three `outputs` blocks — six deleted in all); `d49c205f1` (seven chain-pack version bumps) | `kb-rag-chain-wiring`; `EXPECTED_PRIMARY` pins the primary terminal by name for all six Phase-2 chains + a completeness assertion |
| P7 D6 + D7 | `245e3f6f7` (six route-lane `void`s awaited); `8b70aa96b` (witness 2/6 → 6/6); `67746aa33` (the four `kbService` emit sites + the rule in its docblock); `6a153558c` | the D6 witness parks the KB write on a latch and asserts on the RESPONSE (an awaited handler cannot have answered yet); `builtin-workflow-ratchet` header cross-references `workflow-pin-site-ratchet` |
| P8 `KBC-1/3/4/5` | `8c68fcaa5` + `67746aa33` (`KBC-1` + the R3 fold: eraser bypass restored, six bind doors re-authorized); `67746aa33` (`KBC-3`); `245e3f6f7` + `8b70aa96b` (`KBC-4` widened to the door CLASS, `KBC-5` incl. the point-read orphan sweep) | `kb-service-subject-gate`, `kb-subject-gate-doors` (four doors, each with a member positive control), `kb-hydrate-batching` (3× batch ⇒ exactly three calls), `kbc4-documents-ingest-to-kb-idor` (`promote-html` 200-with-body → gated, born-red measured first), `production-kb-lifecycle` (22; nine sabotages each independently red) |
| SPA | `5cb15bcc1` (`KBX-1..14`, `KB-UX-8/9/11/18/20`) | `reindexLifecycle.test.tsx` (20 incl. the continue action, the gated Start/Discard, the stale stamp, the one-notice-speaks partition), `writeFeedback.test.tsx`; `npm run build` green; `notice-announce` 179 → 176 |
| P9 closeout | this commit | trackers ticked; `FEATURE-LOOP-2026-09.md` row 5; `FEATURES.md` + `ROADMAP.md` synced |

**Review rounds:** the `/architect` pre-implementation pass (6 Blockers, 5 Shoulds — the `REVIEW CORRECTIONS` note above), the D1a review (sent back: the "one document" window was the whole cutover, and the drift check was ABA-blind), the D4 chains review (the dropped ordering edge; the lossy-index orphan sweep), and the subject-gate review of `8c68fcaa5` (two witnessed Blockers: the broken eraser and the pre-authorized bind doors — the `R3 REVIEW FOLD` note above). Three of those blocked a commit. **The iteration's ledger holds 15 claims falsified by probe** (ADR draft ×4, my own grade Blocker, a prior tracker row, two filed exploits/evidence, three implementation claims, a commit message, the renumber sweep); each is recorded at the row it corrected, and the pattern is the point: nothing here was closed on a prescription that had not first been made to fail. **Fourth: the review of `67746aa33` (2 Blockers — the agent-profile PUT as a seventh bind door; two of four agent-knowledge reads still pre-authorized — folded in `64cef45e9`, which also exposed and fixed two pre-existing defects: profile saves wiping the curator's bindings, and a first-match-in-tenant scope resolution). A fifth, scoped, re-review confirmed the fold.** Twenty-one claims were falsified by probe across the iteration; the ledger is cited in each tracker's changelog.

**Owed:**
- The field-writer census in `bindCollection`'s docblock is the SSoT for `profile.knowledge.collectionIds` — a new writer of that field MUST be classified there (the seventh door was a second writer the function-caller census could not see).
- `KBX-15`: the console has no label for the `cutting-over` status.
- Registry republish of `feature.kb.nodes@1.2.0`, `core.openwop.rag@1.0.2` and the seven bumped chain packs (`inbox`, `knowledge`, `finance`, `support`, `marketing`, `lighthouse`, `it-support`); `kb-reindex@1.0.1` is new. Until then real-executor witnesses need the local mount.
- The SPA does not yet consume `driver: 'scheduled' | 'interactive-only'` on `ReindexJobView` (R3 S7 stamps it; nothing in `kbClient.ts` / `KnowledgeBasePage.tsx` reads it).
- No boot sweep for legacy live reindex jobs that predate the driver — left to the lease deliberately (R3 S7: a `running` one is cancelled within 30 min, a `paused` one within 48 h of no progress; an absent `driver` reads as `interactive-only`, which is the truth for them).
- Already-instantiated tenant copies of `inbox.triage` do not receive the D4 fix: it adds a node and rewires three edges, so the `notification-push`-style node-local retarget migration does not transfer (GRD-9).
- `finance.month-end-close` — whether retrieval was meant to be period-scoped (open question above; D5 deleted the inert key rather than guess).
- `clearDemoProduction` calls `deleteVendor` directly and never `removeVendor` (`host/demoProductionSeed.ts:164`), so demo teardown strands every mirrored demo vendor — found by Unit E while closing `KBC-5`, filed rather than silently fixed.
- The RFC 0013 revision in `../openwop` for a declarative `outputRole` (`KBWF-13`'s second half; the by-name pin is the host-side stand-in).
- Per-run `maxChunks` for D1b still wants measuring against the executor's node deadline (open question above).
