# ADR 0581 — Repair the two blind KB detectors, then close the cross-org vector read and the teardown residue

Status: implemented

## Context

The 2026-08-17 feature pass over Knowledge Base / RAG graded the area **D** on
workflows and **C+** on code, with four Blockers. The order in which they are fixed
matters more than usual, because **two of the findings are detectors that cannot see
the thing they exist to police** — and hand-fixing an instance under a blind detector
leaves the generator firing.

### The two blind detectors

**WF-KB-2 — the ADR 0472 builtin-workflow ratchet polices a spelling.** Its entire
notion of "a code-pinned workflow" is `LEGACY_PINNED_WORKFLOWS.map(wf => wf.workflowId)`:
one array in the features barrel. A feature that never enrolled and instead calls
`registerWorkflow({...})` on its boot path is structurally invisible to it. The
companion whole-app scan was blind for a second, independent reason — it matched the
`: WorkflowDefinition` **type annotation**, which an inline object literal never
carries. So a pass reported "GEN-1 CLEAN" over six live pin sites, one of them KB's.

**KB-3 (detector half) — the ADR 0464 erasure-coverage ratchet cannot enumerate KB.**
Every signal it binds (`userId`, `subjectKey`, `subjectId`, `contactId`, email) names a
subject as the record's **topic**. KB rows name a subject as the record's **author**:
they carry only `createdBy`/`updatedBy`. So no KB namespace entered the denominator —
not covered, not debt, not counted — and the gate reported clean over a feature that
ingests uploaded PDFs and Office documents, image OCR, audio transcripts, fetched URLs
and scheduled Drive/OneDrive folders.

### The findings underneath

- **WF-KB-1** — `features/agent-knowledge/feature.ts` registered an in-tree
  `WorkflowDefinition` on the boot path with no `recordOwnership`, while its own
  comment claimed it therefore "lives in the builder workflow registry".
- **KB-1 (Blocker, security)** — the KB routes narrowed `req.body` with a TypeScript
  **cast**, erased at runtime, so caller-supplied `collectionId` / `managed` /
  `documentId` reached the service; and the vector namespace was the bare
  `collectionId` with no org component.
- **KB-2 (Blocker, security/compliance)** — tenant teardown never reclaimed the vector
  mirror.
- **KB-4 (Blocker)** — `removeDocumentRow` wiped with `chunkIds(doc)` instead of the
  `staleWipeIds` union every sibling delete path uses.

## Decision

**Fix the detectors first, then the instances.**

### D1 — Classify `registerWorkflow` call sites by the definition's ORIGIN

`test/workflow-pin-site-ratchet.test.ts` resolves every `registerWorkflow(` /
`registerWorkflowDurable(` call site in `src/` to where its definition came from —
an inline literal, a module `const`, a module-local factory that returns one, versus a
request body / `expandChain` / the composition pipeline — and treats *an in-tree literal
registered without `recordOwnership`* as a pin site.

Both ledgers are **exact-match**, in both directions: a new pin fails red, and a pin
that has been fixed but left listed also fails red, so the list can never decay into a
stale claim. The quarantine is shrink-only (ceiling 7).

Rejected: extending `LEGACY_PINNED_WORKFLOWS` to cover the six sites. That keeps the
gate keyed on enrolment — the very property that made it blind.

> **CORRECTION — R2 review finding F5 (2026-08-18).** The paragraph above described
> what the gate was *meant* to do; as first shipped it did not do it, and the docblock's
> claim that the resolver "answers true only when it can actually SEE the literal" was
> false on the branch that made it. Four defects, all measured on real source:
>
> 1. **Ownership was a FILE-WIDE flag.** `recordsOwnership = /recordOwnership\(/.test(src)`
>    meant a genuine boot-path `registerWorkflow({workflowId,nodes,edges})` added to ANY
>    of the nine sanctioned modules stayed green — laundered by an unrelated ownership
>    call in an unrelated function. Ownership is now paired at the **registration site**
>    (the innermost enclosing function of that call).
> 2. **A spread of a derived product read as an in-tree literal**, because the whole test
>    was `arg.startsWith('{')`. MEASURED: 16 sites, 7 pinned, and **three modules
>    classified IN-TREE *and* ownership-recording** — `features/strategy/cadence.ts`,
>    `features/crm/gmailSyncService.ts`, `host/collab/workflowCollabResource.ts`. They
>    were red-in-waiting: only defect (1) kept them green, so fixing (1) alone would have
>    turned all three red. An object literal is now resolved *through* its top-level
>    spreads.
> 3. **Three shapes never entered the scan**, so no ledger could fire: an ARROW factory
>    (`const mk = () => ({…})` — the house style), an **aliased import** (`registerWorkflow
>    as reg` — which `routes/workflows.ts:34` already uses, hiding the real registration at
>    :561), and a point-free pass (`defs.forEach(registerWorkflow)`). Aliases are now
>    scanned as call sites; value uses are ledgered (`VALUE_REFERENCES`, empty).
> 4. Two resolver precision bugs: the declaration lookup took the FIRST `const <name> =`
>    anywhere in the file rather than the nearest preceding one, and `argumentAt` counted
>    brackets inside string literals.
>
> The **indirect** lane (`SubChainDeps.register: (def: WorkflowDefinition) => void`,
> `host/workflowChainPackLoader.ts`) cannot be resolved by a single-file scanner and is
> not claimed to be: it is detected and held in an exact-match
> `INDIRECT_REGISTRATION_SEAMS` ledger naming its one supplier. Every residual the scan
> genuinely cannot cover (R1–R6) is named in the test's docblock rather than implied away.

### D2 — Widen the erasure ratchet to the actor-attribution class, in its own ledger

`createdBy` / `uploadedBy` / `authorId` become a second signal with its own
`ACTOR_ATTRIBUTED_DEBT` ledger and its own ceiling, because the class asks a different
question ("does a DSAR for X reach a record X *authored*?") whose honest answer is
usually *re-attribute*, not *delete*.

Measured before binding: population 44 → 93 stores. Of the 49 added, 29 already sit in
eraser-registering features; 20 do not; 2 of those are KB's own and are covered by the
eraser this change ships; the remaining **18** are recorded as pre-existing debt.

Rejected: folding 18 entries into the existing `DEBT_CEILING` (9 → 27). One number
would then have meant two different things.

### D3 — Put the org in the vector namespace, and migrate by self-healing rebuild

`collectionNamespace` becomes `${orgId}/${collectionId}` (`#<signature>` suffix
unchanged). Isolation stops depending on the unenforced invariant "collection ids are
random UUIDs or embed their own orgId".

**Migration.** The namespace is *derived, never stored*, so cutover is atomic at
deploy: `hydrated` is process-local with no boot hydration, so the first search after
the change rebuilds each collection into the org-scoped namespace. Local mode
re-embeds deterministically and for free; provider mode reads the durable per-chunk
vector cache, which is keyed `${tenantId}:${documentId}:${chunkIndex}` and therefore
**namespace-independent** — so the migration costs CPU, not provider spend. The
residue is handled where the ids are already computed: the same rebuild deletes the
pre-org namespace's rows (`gcLegacyNamespace`), bounded by the collection's own chunk
count and best-effort, so a failed GC never fails a search and the next rebuild
retries.

Rejected: a boot-time sweep. This host has no all-tenant enumeration primitive, and a
per-collection self-heal needs none.

### D4 — A host-internal vector tenant purge, not a new `VectorSurface` method

`host/vector/vectorTenantPurge.ts` is a registry each backend writes into.
`host.db.vector` is the RFC 0018 **pack-facing** surface — adding `purgeTenant` there
would be a capability-surface change needing an RFC, and a very sharp tool to hand to
pack code. Teardown is a host operation, so it gets a host seam. Every registered
backend is purged (a deployment that switched backends can hold residue in both), and
a backend that throws is **named in the result**, never folded into the success count.

### D5 — Pick, don't cast; and refuse the silent clobber

The routes enumerate the fields a caller MAY send. KB-CODE-11 rest-stripped one field
at this seam and closed one instance of the class; picking closes the class. And
`ingestDocument` now refuses (409) a caller-supplied `documentId` that already exists —
the sanctioned replace path is `upsertDocument`, which removes the prior row first.

## Consequences

- One vector rebuild per collection on first search after deploy (CPU only).
- KB is now in the ADR 0464 and ADR 0077 seams; the exemption comment in
  `retention-purgers.test.ts` is corrected in place rather than deleted.
- The KB retention purger is deliberately narrower than its siblings: it reclaims the
  **derived residue of deleted documents** and never live tenant knowledge, which has
  no age semantics. That boundary is asserted, not implied.
- 18 previously-invisible actor-attribution debt entries are now visible and ceilinged.

## Known residuals, stated

- **pgvector is not executed in CI.** The tenant DELETE is pinned as a pure SQL builder
  and the purger is asserted to be registered *beside* the adapter, which is what stops
  the two drifting; that a live pgvector runs the DELETE is the same residual the
  adapter has carried since it shipped.
- **Free-text content** that merely mentions an erased subject is not reachable by an
  id-keyed eraser (the same residual `features/crm/erasure.ts` records for approval
  prose). Tenant teardown is the backstop.
- `kb:veccache` / `kb:docrev` carry no subject field, so the widened ratchet still
  cannot see them; they are reached by cascade and by the orphan purger, and the gate
  asserts its own blind spot rather than leaving it unsaid.
- **The pin-site scan is a regex scanner, not a parser.** Six residuals are named in
  `test/workflow-pin-site-ratchet.test.ts`'s docblock (R1 indirect/injected registrars,
  R2 value references, R3 assignment-only bindings, R4 literals that layer on a derived
  product but write the definition body themselves, R5 cross-module origin, R6 no regex
  tokenization). R1 and R2 have their own exact-match ledgers so the blind spot fails
  red when something enters it; the rest are conservative in the DERIVED direction and
  backstopped by the tier-3 module fallback plus the exact-match ledgers.
- **Deferred to a second PR:** WF-KB-5 (unbound human/external legs on the three
  `knowledge.*` chains), WF-KB-15, the UX findings, and KB-5..KB-16.

## Implementation record

| Decision | Change | Test |
|---|---|---|
| D1 | `test/workflow-pin-site-ratchet.test.ts` | 10 tests, incl. a fresh-pin probe + a comments-are-not-code probe |
| D1 (R2 / F5) | same file: site-scoped ownership pairing, spread-aware origin resolution, arrow-factory + alias + point-free + injected-registrar detection, nearest-preceding declaration lookup, string-aware `argumentAt` | 20 tests. Four laundering shapes appended to the sanctioned `features/crm/gmailSyncService.ts` and re-run against BOTH gates: old 10/10 green, new RED, every time; a legitimate `expandChain → recordOwnership` addition stays green (negative control) |
| D4 (R2 / F9) | `routes/account.ts` reports `vectorRows` / `vectorBackends` / `vectorBackendsFailed` in the response AND the ADR 0284 audit payload | `account-delete.test.ts` — 4 tests: none-configured, purged, failed (named in both, and NOT confusable with none-configured), and failure-does-not-abort-teardown. Sabotage: reverting the route to its pre-fix shape turns exactly those 4 red |
| WF-KB-1 | `examples/workflow-chain-packs/agent-knowledge/pack.json`; `features/agent-knowledge/feature.ts` → `registerChainBackedWorkflow` | `agent-knowledge-auto-ingest-chain.test.ts` (real loader); `agent-knowledge-route.test.ts` reachability assertion corrected |
| D2 | `test/subject-erasure-feature-stores.test.ts` widened | 13 tests |
| D3 / D5 | `features/kb/kbService.ts`, `features/kb/routes.ts` | `kb-cross-org-isolation.test.ts` |
| D4 | `host/vector/vectorTenantPurge.ts`, `pgVectorVector.ts`, `inMemorySurfaces.ts`, `routes/account.ts`, `retentionSweepDaemon.ts` | `kb-vector-tenant-teardown.test.ts` |
| KB-4 | `removeDocumentRow` → `staleWipeIds` union | `kb-cross-org-isolation.test.ts` (store-level tail probe) |
| KB-3 data | `kbService.ts` eraser + retention purger + `declarePiiFields` | `kb-erasure-retention.test.ts` |

Every fix was sabotage-proved: reverting the org component, the wipe union, the route
picks, the memory purger and the eraser registration each turns exactly its own test(s)
red and nothing else.
