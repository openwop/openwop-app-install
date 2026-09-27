# ADR 0605 — Knowledge sync: the destructive diff, the confused deputy, and the hard-coded scheduler

**Status:** implemented (2026-08-24) — Tiers 1–7 **plus the R1 review fold-in** landed on `fix/knowledge-sync-destructive-diff`; the doctrine deviation (`KSWF-1`) is **recorded, not fixed**, and every residual below is OPEN.
**Read § "R1 — the adversarial-review fold-in" before copying anything from Tiers 1, 5 or 6: three of that review's four HIGH findings are defects THOSE TIERS CREATED.**
**Date:** 2026-08-24
**Feature:** Knowledge sync — **`FEATURES.md` ordinal 31** · toggle `knowledge-sync` (OFF, `bucketUnit: tenant`) · owning record **ADR 0107**.
**Surface:** host-extension `/v1/host/openwop-app/knowledge-sync/*` + `host/knowledgeSourceFetch.ts` + one cross-cutting change in `features/kb/kbService.ts` + the SPA panel. **No wire change, no capability advertised, no RFC** — see § RFC verdict.
**Supersedes nothing.** **Corrects** ADR 0107 at seven sites (§ Record corrections).

---

## Context

A three-grader single-feature pass on knowledge sync (`/grade-code` **D+**, `/grade-ux`
**C+**, `/grade-workflows` **D — doctrine FAIL**) landed as PR #3453 (`ad2175a7d`). Its
findings live in the **Knowledge sync** sections of `docs/steward/{CODEBASE,UX,WORKFLOWS}-ASSESSMENT.md`.

Two things about that pass shaped this ADR more than the individual findings did.

**First, it was execution-witnessed.** Five defects were *reproduced*, not argued
(`PROBE-KS-1`..`-5`). That matters because the headline defect is one a reader talks
themselves out of: it needs a provider to behave slightly badly, and the code around
it is visibly careful. An argument loses that fight. A measurement — *1200 known files
against a listing truncated at 1000 emits 200 `deleteDocument` calls* — does not.

**Second, the feature's own test suite was an argument FOR the defect.**
`test/knowledge-sync.test.ts:46-51` asserts *"an empty folder prunes all known files"*.
That test is green, deliberate, and (as § "Why the fetch boundary" argues) **correct**.
Any fix aimed at the diff would have landed as a red test, and the red test would have
looked like the regression.

The wound itself, stated once: **the sync could not distinguish "the folder is empty"
from "I could not read the folder", and the second one deletes the customer's knowledge
base.** Three inputs reach it — a `200 OK` with a non-JSON body, the `MAX_LIST_FILES`
truncation, and a mid-pagination degradation that breaks the page-token chain. Every
*hard* failure on the same path was already fail-closed (`failClosed`), which is exactly
why the soft one was dangerous: the loud failures had been thought through, so the quiet
one read as success.

---

## Decision

Fix in **seven tiers**, ordered so that each is independently reviewable and each lands
with a witness that fails without it. Tiers 1–6 change behaviour; Tier 7 changes only
the record. **The doctrine deviation is recorded and NOT fixed** — see § "The doctrine
deviation", which `features/knowledge-sync/routes.ts` and `knowledgeSyncService.ts` both
cite by name.

### Tier 1 — a listing that cannot be proved complete may not delete anything

`4a7dc04d8`. Retires `KSC-1` + `KSC-3` + `KSC-5` + `KSWF-3` together, because all three
routes in are the same missing fact.

- `readJson` **throws a typed 502** on an unparseable `2xx` instead of returning
  `undefined`.
- `listFolder` returns `SyncFolderListing { files, complete, incompleteReason? }`.
  `complete:false` on the `MAX_LIST_FILES` cap, on exhausting `MAX_LIST_PAGES` with
  pages pending, and on a continuation token that cannot be followed — including a
  Graph `@odata.nextLink` the open-redirect guard rightly refuses, which used to be
  read silently as "the folder ends here".
- **`diffFolderListing` is the ONE composition owner** and the guard lives there. It
  tests `listing.complete === true`, not `!complete`, so unknown completeness fails
  **closed**. It suppresses `toPrune` **only** — an incomplete pass still ingests what
  it saw, because it is the *deletion* that requires knowing what you did not see.
- A partial pass is **reported**: `SyncRunResult.listingIncomplete`, a
  `knowledge_sync_listing_incomplete` warn carrying the reason and both counts, and a
  `lastError` sentence that leads with "nothing was removed".

> **CORRECTED 2026-08-24 (R1 review HIGH 2) — this tier left `[]` meaning two things
> ONE LINE LATER, for every provider.** `readJson` throws on an unparseable body, and
> then each lister does `Array.isArray(body?.files) ? body.files : []` and declares the
> folder drained. MEASURED: `{}` and `{"error":{"code":403,…}}` both yielded
> `{ files: [], complete: true }`. The scenarios § Context names — an interposing proxy,
> a captive portal, a provider error page — largely answer with *valid JSON*, so they
> never reached the throw this tier added. Closed by `KSC-19` (`ed8c8c3d1`); see
> § "R1 — the adversarial-review fold-in", including why Google is cured differently
> from the other four.

### Tier 2 — the diff cursor no longer outlives its tenant

`b5a15fb5b`. `KSWF-6` / `PROBE-KS-4`. `SyncFileState` rows are keyed
`<sourceId>:<fileId>` with no tenant and no `tenantOf`, so `purgeTenantHostExt` deleted
the parent `SyncSource` and orphaned every cursor **forever** — each carrying the
external provider file id, the provider revision and the KB document id, retained
through an account delete or a DSAR erasure. Two mechanisms, because neither alone
covers the population: a `tenantId` **field** the generic content walk already reads
(and which backfills in place), plus a `registerTenantPurgeHook` for legacy rows that
runs **before** the walk destroys the parent they resolve through.

### Tier 3 — a sync source may not bind a colleague's connection

`c32f964cc`. `KSC-2`. Create validated only `conn.tenantId` while the runner **adopts**
`conn.userId` as the acting identity, so a `workspace:write` member could bind a
colleague's Drive token and read their files into a collection of their own choosing,
indefinitely, under the colleague's name. **Two lanes**, because a gate on the CREATION
lane is not a gate on the USE lane: one shared `requireOwnConnection` predicate called
by both routes that accept a `connectionId`, plus `SyncSource.createdBy` so every later
pass re-checks. Guarded on `conn.userId && …`, because a **tenant-level** connection
belongs to no person and there is no deputy to confuse.

### Tier 4 — `ragQuery` honours the `contentTrust` it retrieves

`a4b6ef217`. `KSC-4`. `contentTrust` was a stored **label**: `agentDispatch` and
`agentKnowledgeComposition` fenced it and `ragQuery` interpolated `title` and `text`
straight into *"Answer the question using ONLY the context below"* — the lane
`kb.rag` / `kb.search` / `kb.retrieve` reach from workflow nodes. The **title is the
sharper half**: for a synced source it is the remote filename, so anyone who can drop a
file into a watched folder writes text into the `[n] (title)` slot of a prompt. Fenced
via `host/untrustedContent` (the single owner of how this host fences) **inside**
`ragQuery`, not at the call sites — see § Alternatives.

> **CORRECTED 2026-08-24 (R1 review LOW 9) — the tier's code comment claimed more than
> the import buys.** `kbService.ts:55` said reusing the module meant *"this lane cannot
> drift from the chat/dispatch lanes"*. The three lanes share the MODULE, not the
> TREATMENT: `kbService.ts:1516` calls `fenceUntrustedBlock` (defangs the delimiters,
> preserves structure) while `agentDispatch.ts:727` and
> `agentKnowledgeComposition.ts:109` call `fenceUntrustedItems` over items run through
> `neutralizeUntrusted`, which additionally COLLAPSES whitespace. So the untrusted chunk
> BODY is defanged here but not whitespace-neutralized. **The difference is deliberate
> and argued at `buildRagContextBlock`** — a KB chunk is a document excerpt whose
> newlines carry meaning, and the title, which has none, IS collapsed. What was wrong is
> the sentence, not the choice: the comment now states the difference. "We import the
> same file" is not by itself an anti-drift property.

### Tier 5 — the cadence re-arms, the claim covers both lanes, the slot edge is gone

`3ab016815`. `KSWF-2` / `-4` / `-5` / `-11`, `KSC-6` (partly) / `KSC-7`.

- One transient failure retired a scheduled source **permanently**
  (`processDueSyncs(now + 365d)` returned 0). A bounded exponential backoff
  (`nextAttemptAt`, 15m doubling to a 24h cap) keeps it `active`; `error` now means "a
  human must look" rather than "something once failed".

> **CORRECTED 2026-08-24 (R1 review HIGH 3) — "keeps it `active`" was written for an
> ACTIVE source and applied unconditionally.** The line is `terminal ? 'error' :
> 'active'`, so one failing pass on a **paused** source set it `active` and dropped its
> `pausedReason` — the daemon then resumed DELETING documents from a source the user had
> explicitly stopped, and a `connection-revoked` pause lost Tier 6's whole `KSU-3`
> deliverable, which nothing re-applies (there is no `onConnectionRestored`). Pre-batch
> the same line wrote `'error'`, which both `listActiveSyncSourcesForTenant` and
> `isSyncDue` exclude: destructive of the pause, but NOT self-resuming. **This tier
> upgraded it into an auto-resume** — the batch's own diagnosis ("a gate on one lane is
> not a gate on the invariant") applied to itself. Closed by `statusAfterPass` +
> a refusal on a revoked pause (`08aaacb40`), which also closes `KSC-17`.
- The claim moved from `processDueSyncs` into **`syncNow`** — the one choke both the
  daemon tick and `POST /:id/sync` pass through. A lost claim throws `conflict` 409
  **without** touching status.
- ~~The wall-clock `Math.floor(now / CLAIM_SLOT_MS)` key is **deleted, not moved**: it was
  the defect.~~ The key is now data-derived (`syncStateVersion`, folding `lastSyncedAt`
  and `consecutiveFailures`), the way `scheduleDaemon` keys on `nextFireAt`.

> **CORRECTED 2026-08-24 (R1 review HIGH 1) — the struck sentence is half right, and the
> half it gets wrong cost a PERMANENT wedge.** The slot was the `KSWF-5` defect *and* it
> was simultaneously the only thing recovering a crashed pass, because `claimOnce` is
> contractually never released on failure. Once the key stopped rotating on its own, a
> lane that claimed and died held that source's claim forever — measured at +1 min, +1 h,
> +1 day and +30 days, with two `processDueSyncs` a day apart both returning 0 and the UI
> saying "A sync is already running… Try again once it finishes". **This tier cited
> `scheduleDaemon` as its model and adopted the key without the mechanism twelve lines
> above it** (`scheduleDaemon.ts:84-89`: advancing only after dispatch leaves a slot
> "perpetually due AND un-claimable"). Closed by `KSWF-19` (`08aaacb40`) — a pre-run
> lease that rotates the key from DATA, plus the per-tick prune this daemon was the only
> one of four to lack. **Copying a shape means copying what makes it safe, not the part
> that looks like the fix.**
- `test/idempotency-lane-tripwire.test.ts`'s offender predicate was
  `f.rel.startsWith('routes/')`, so **every feature-package route file was outside its
  population** — most of this app's routes, and the structural reason it could not have
  observed `KSWF-4` even in principle. Broadened after measuring the blast radius (0
  files), then sabotage-proved non-vacuous.

### Tier 6 — the UX of the destructive act

`e5b0d1322`. `KSU-1` / `-2` / `-3` / `-4` / `-8` / `-10`, `KSC-14` / `KSC-15`.
The feature's defining act is deleting the user's knowledge, and on the path it actually
takes — a scheduled run — that deletion was reported **nowhere**: the daemon discarded
the result, the row stored no summary, and the only deletion report in the product was a
four-second auto-dismissing toast on a **manual** run. The pass now persists `lastRun`;
`lastSyncedAt` renders; a revoked credential gets its own chip and ~~drops the Resume
button that could not work~~ (`pausedReason`); turning media off confirms first; and the
one-way semantics are disclosed **before** you bind a collection.

> **CORRECTED 2026-08-24 (R1 review, HIGH 3's UI half) — the struck clause shipped a
> wedge, and its premise was false.** Resume is not an action against the provider: it
> flips the row back to `active`. There is **no `onConnectionRestored` hook anywhere**
> (`connectionLifecycle.ts` registers revoke only), so nothing else clears
> `pausedReason` — disabling Resume left a revoked source **permanently paused with no
> in-product exit**, i.e. the same wedge family as HIGH 1, created by the fix for a
> different problem in the same batch. Resume is now enabled and is the escape;
> **"Sync now" is disabled instead**, which matches a real server-side refusal rather
> than a guess (`083ac88e2`). *"An action guaranteed to fail is worse than no action"* is
> a good rule; it was applied to the wrong control, and a gate with no exit is a defect
> in its own right. `KSU-10`'s quarantine
row was **deleted, not annotated** — `check-notice-announce` was exiting 0 while naming
this feature in its exemption list, i.e. structurally incapable of failing on it — and
its baseline lowered 191 → 189 to match, sabotage-proved at 188.

### Tier 7 — the record (this ADR)

Seven false or self-contradicting claims corrected at their sites, this ADR written, and
`KSWF-1` recorded. **No behaviour change.** § Record corrections lists each one and what
it now says.

---

## Why the cure went at the fetch boundary and not in `diffFolder`

This is the load-bearing decision of the whole batch, and the obvious alternative is
wrong in a way that is only visible if you state the contract out loud.

`diffFolder(known, listed)` is pure. Given the files that are in the folder and the
files it has seen before, it returns NEW / CHANGED / DELETED / UNCHANGED. Its rule for
DELETED — *a file I have state for and did not see is gone* — **is the product rule**,
and it is the rule for a folder that is genuinely empty too: emptying a watched folder
*should* empty the mirrored collection. That is what one-way mirroring means.

So `test/knowledge-sync.test.ts:46-51` — *"an empty folder prunes all known files"* — is
**a correct test of a correct contract**, and the assessment's own path-to-A+ (CODEBASE
step 3: *"rewrite `knowledge-sync.test.ts:46-51` … and register the old assertion in
`defect-pin-vocabulary.test.ts`"*) is **falsified by this batch**. It read the test as a
defect-pin because the *behaviour* was destructive; but the test does not pin a defect,
it pins a guarantee. Following that prescription would have deleted a real guarantee and
replaced it with a weaker one, and the feature would have stopped pruning emptied
folders — a silent product regression traded for a data-loss fix.

**The defect was never in the diff. It was that the fetch layer returned `[]` for two
different facts** — *the folder is empty* and *I could not read the folder* — and the
diff, being pure, has no way to tell them apart and no business guessing. A function
cannot be blamed for an input that lies to it.

Three consequences followed from putting the cure at the boundary:

1. **The type carries the fact.** `SyncFolderListing` makes completeness explicit, so
   the ambiguity cannot be reintroduced by a future lister that "forgot" — the guard
   tests `complete === true`, and a missing flag fails closed.
2. **`diffFolder` stays pure and its test stays green.** No guarantee was traded away;
   `knowledge-sync.test.ts:46-51` passes unchanged, which is the signal that the fix did
   not cost anything it should not have.
3. **The guard has ONE owner.** `diffFolderListing` is the single composition point, so
   there is no per-lister copy to drift. (This is the same shape as Tier 3's
   `requireOwnConnection` and Tier 4's in-`ragQuery` placement: one shared rule beats N
   hand-written copies, every time.)

The corollary is uncomfortable and worth writing down: **an incomplete listing still
ingests.** That is deliberate. Ingesting what you saw is safe; deleting what you did not
see is not. Suppressing `toPrune` alone is the smallest refusal that closes the wound.

---

## Alternatives weighed

| # | Alternative | Verdict |
|---|---|---|
| 1 | **Special-case a *wholly empty* listing** — refuse to prune when `listed.length === 0`. | **Rejected.** Cheap and nearly right, and it fails on the two findings that matter most: `KSC-3` (1000 of 1600 files listed — not empty, still prunes 200 live documents) and `KSC-5` (page 1 parses, page 2 degrades — not empty either). It also *destroys* the correct empty-folder guarantee. A heuristic on the count cannot answer a question about provenance. |
| 2 | **A prune circuit-breaker** — cap the fraction of a source's state prunable in one pass. | **Deferred, not rejected** (CODEBASE path-to-A+ step 4). It is defence in depth against a *genuine* mass deletion, which Tier 1 does not address; but as the primary cure it is a threshold nobody can choose correctly, and it would have made the `KSC-3` truncation *quieter* rather than *refused*. Filed OPEN. |
| 3 | **Fix `diffFolder`** — teach the diff to be conservative. | **Rejected** — § above. It breaks a correct guarantee and misplaces the knowledge. |
| 4 | **Tier 2: a `tenantOf` on the cursor collection** instead of a `tenantId` field. | **Rejected.** `tenantOf` mints an index marker on every put, doubling writes on the hottest path in the feature (once per synced file) to buy a `listForTenantIndexed` this feature does not use. The field is what the generic walk's `jsonTenantId` fallback already reads, and it **backfills in place**. |
| 5 | **Tier 3: guard on `conn.userId !== caller`** (the first draft, and the in-repo `gmailSyncService` shape). | **Rejected as written** — it also refuses a connection with **no** `userId`, i.e. a **tenant-level** connection, which belongs to no person. The runner's identity is `conn.userId ?? source.tenantId`, so such a connection makes the pass act as the bare tenant: nobody to impersonate, no deputy to confuse. The over-broad form would have broken a legitimate configuration in the name of a hole it does not have. A test pins the tenant-level case as ALLOWED. |
| 6 | **Tier 4: fence at the `ctx.features.kb` call sites** rather than inside `ragQuery`. | **Rejected — wrong by construction.** The consumer population is a **FLOOR** and cannot be measured: `ctx.features.kb` is a runtime **string-keyed** surface, so pack- and MCP-mediated callers are invisible to static grep (this batch found three only by grepping `packs/*.mjs`). A fix keyed to an enumerated list is wrong the moment a pack adds a caller. The one choke every caller passes through is the function. |
| 7 | **Tier 5: key the claim on `lastSyncedAt`** (the assessment's own suggestion). | **Rejected — WORSE than the bug.** A *failed* run leaves `lastSyncedAt` untouched, so a failing source would become permanently unclaimable. Keying on `updatedAt` alone (my second draft) was also wrong: `updatedAt` is set to the caller's `now`, so two attempts sharing a millisecond produce the same key and the second is refused as a duplicate of a pass that already finished — a silently skipped scheduled run, the exact class the key exists to prevent. A frozen-clock test found it. |
| 8 | **Tier 7: fix the https-only gap in the code** instead of correcting the claim. | **Deferred with a stated reason.** A per-hop scheme check changes what `fetchGuardedBytes` accepts from a live provider — a behaviour change, which owes a witness against a real redirect chain. A records tier must not smuggle one in. Filed OPEN as `KSC-8`; the claim is corrected precisely in the meantime, at both code sites and in ADR 0107. |
| 9 | **Migrate the scheduler to `registerJob` → `startWorkflowRun`** in this batch. | **Rejected — BLOCKED, see below.** |

---

## The doctrine deviation (`KSWF-1`) — recorded, not fixed

> **§ R2 — CLOSED 2026-08-31 (`KSWF-1` + `WF-KB-3`). The deviation below is FIXED;
> the section is kept as the reasoning trail.** The recurring sync now rides the
> sanctioned seam (the gmailSync twin, "Option B"): a per-source `knowledge-sync.run`
> chain-backed workflow (owned, replayable) fired by the ONE host scheduler via
> `registerJob`→`startWorkflowRun`. Shipped: node pack `packs/feature.knowledge-sync.nodes`
> (one `run` node), chain `examples/workflow-chain-packs/knowledge-sync`, `SyncSource.jobId`
> + `ensureKnowledgeSyncWorkflow`/`registerKnowledgeSyncJob`/`updateKnowledgeSyncJob`/
> `deleteKnowledgeSyncJob` + a boot `backfillKnowledgeSyncJobs`, the WF-KB-4 spend gate
> moved to the `knowledge-sync` surface's `runOnce` (fail-closed; a disabled tenant does
> ZERO egress, witnessed), the claim + prune helpers moved to the service, and
> **`knowledgeSyncDaemon.ts` DELETED** (with its `index.ts` start). `KSWF-16`'s tripwire
> is satisfied.
>
> **The "blocked on `WF-KB-10`" claim throughout this section was true only for the
> MULTI-NODE decomposition** (expressing ingest/prune as chain nodes that read the KB
> surface). The one-node wrapper (the node calls `runKnowledgeSyncOnce`, which writes
> directly via `kbService.ingestDocument`/`deleteDocument`, not the read-only
> `ctx.features.kb`) needs no KB-write node, so `WF-KB-10` never blocked it. Witness
> `test/knowledge-sync-workflow.test.ts`.

Cited by name from `features/knowledge-sync/routes.ts` and `knowledgeSyncService.ts`.

**What is actually there.** The scheduled sync is an **in-tree imperative DAG**
(`knowledgeSyncRunner.runKnowledgeSyncOnce`: list → diff → fetch+ingest → prune) driven
by a **bespoke self-rescheduling `setTimeout`** (`knowledgeSyncDaemon.ts`, started from
`index.ts:875`). It produces **no workflow run at all** — no `WorkflowDefinition`, no
chain pack, no node pack, no stack, no `registerWorkflow*` call anywhere in the package,
no `surface.ts`, no agent tool, nothing in the tenant ownership index. There is nothing
to replay, nothing to fork, nothing a builder can edit, and nothing the `/` picker or a
named agent can reach. This is the (d) outcome of the chains-or-stacks doctrine, and the
grade was **D — doctrine FAIL**.

**The sanctioned seam exists and is bypassed.** `host/schedulingService.registerJob` →
`host/scheduleDaemon.ts` → `startWorkflowRun`, in wide use across the feature packages
(`grep -rl registerJob backend/typescript/src/features` → 21 files; the assessment counted
13 *call sites*, and neither number is this feature). And the
**isomorphic twin is already on it**: `features/crm/gmailSyncService.ts` is the same
shape — a connected-account folder poller — riding `registerJob` with the *identical*
`['15m','hourly','daily']` cadence tuple. The asymmetry is what makes this an
oversight rather than a decision. (ADR 0107's Phase-3b correction *did* record a
deliberate choice — "a feature-service node is a signed node pack, disproportionate" —
but that reasoning weighs the cost of a node pack against a timer, and never weighs the
cost of standing outside the run model: no replay, no fork, no ownership index, no
builder, no chat drivability, and a second job runner to keep alive.)

**Target shape, when it is unblocked.**

1. A **node pack** exposing the sync steps as nodes (`list` / `diff` / `ingest` /
   `prune`), reading and writing through `features/kb/surface.ts`.
2. A **workflow-chain pack** (`kind:"workflow-chain"`, RFC 0013 / ADR 0163) wiring those
   nodes with the gate edges the destructive step needs — in particular an edge
   condition on `listing.complete` so the Tier 1 refusal is expressed **in the graph**
   rather than in a host `if`.
3. `SyncSource.cadence` bound through **`registerJob`**, so `scheduleDaemon` fires
   `startWorkflowRun` on the chain. `POST /:id/sync` starts the same run.
4. `SyncSource.runId` (today a dead field, `KSWF-8`) becomes real, and the run is
   replayable, forkable, visible in the ownership index, and editable in `/builder`.
5. `knowledgeSyncDaemon.ts` is **deleted**, not kept alongside.

**BLOCKED on `WF-KB-10`.** `features/kb/surface.ts` exposes **read** methods only —
`search`, `rag`, `retrieve`, `listCollections`, and nothing else (verified 2026-08-24 by
reading `buildKbSurface` in full). There is **no write method**, so **no node can
ingest a document today** and steps 3–5 of the sync cannot be expressed as nodes at all.
Migrating the scheduler before that lands would produce a chain that lists and diffs and
then calls back into host code to do the work — a worse shape than the honest procedure
that is there now, and one that would have to be unpicked. `WF-KB-10` first.

**Tripwire (`KSWF-16`).** Any *future* knowledge-sync sequencing — cross-run pagination,
a re-embed campaign, a staged multi-source backfill, a scheduled freshness audit — MUST
land as a chain pack or a kanban stack bound to `registerJob`. Never as another
in-feature procedure. One deviation is a debt; two is a pattern.

---

## Record corrections (Tier 7)

Each was a live falsehood a reader would act on. Corrections **append** — strikethrough
plus a dated note — and never rewrite the original rationale.

| # | Site | Was | Now |
|---|---|---|---|
| 1 | `FEATURES.md:199` | *"Phase 2 manages sync sources; the scheduled sync run + UI are later phases"* — and contradicting `FEATURES.md:605` of the same file | Struck. Says what shipped (daemon **on by default**, picker, Sync-now, pause/resume) and **that a sync DELETES**, including hand-uploaded documents. This is the sentence a tenant admin reads before enabling a paid-egress surface. |
| 2 | `features/knowledge-sync/routes.ts:7` | *"'Sync now' + the scheduler binding ride the Phase-3 `knowledge-sync.run` workflow (not yet wired)"* — in the file that wires it | **Already corrected in Tier 3** (`c32f964cc`), not in Tier 7. Recorded here so the ledger is not double-counted. |
| 3 | `features/knowledge-sync/knowledgeSyncDaemon.ts:8-10` | *"a daemon tick overlapping a manual 'Sync now' … can't double-run a source"* and *"self-expiring (the slot rotates)"* | **Already corrected in Tier 5** (`3ab016815`). Both claims were false; the second was not a safety property but the `KSWF-5` defect. The docblock now states what is true **and** that it was false before. |
| 4 | ADR 0107 status line + `host/knowledgeSourceFetch.ts` (×2 docblocks) | *"https-only"* | ~~Struck~~ **CORRECTED 2026-08-24 (feature-31 closeout): struck at the two code docblocks only — the ADR 0107 status line was NOT touched by this batch (`git show e3b50b6e8 -- docs/adr/0107-*.md` shows line 3 as unchanged context) and the strike was applied at the closeout. See the note below the table.** Stated precisely: **hop 1 only**. Per-hop revalidation is the resolved **address** (private-range) and nothing else — not the scheme, not the host denylist — and `undiciFetch` is called with the default `redirect:'follow'`. Code fix filed OPEN as `KSC-8`. |
| 5 | ADR 0107 § Phase 5 | *"a list of sync sources with **last-sync status**"*, marked IMPLEMENTED | Recorded as **delivered 2026-08-24 by Tier 6**, not as always-having-been. `lastSyncedAt` was fetched, typed, backend-written and never rendered for fourteen months; the "IMPLEMENTED" note re-described the promise instead of checking it. |
| 6 | ADR 0107 § OQ-1 | hard-delete *"with a per-source **keep on delete** opt-out"* | Stated plainly: the hard-delete shipped, the opt-out **never did** — zero code hits repo-wide. **This batch does not change that**; it makes the deletion honest, not optional. Filed OPEN as `KSU-22`. |
| 7 | ADR 0107 § Surface (`:6`) | *"a scheduled diff-sync **executor run**"* | Struck. There is no run. The ADR contradicted itself: Phase 3b declined the workflow lane three lines above. Eight downstream sites inherited the phrase; ~~all corrected~~ **CORRECTED 2026-08-24 (feature-31 closeout): FOUR were not — all four inside ADR 0107 itself (`:37`, `:38`, `:48` § Decision, `:91` Phase 2). Struck at the closeout; see the note below the table.** |

> **CLOSEOUT CORRECTION 2026-08-24 (feature-31 closeout) — six further internal contradictions, each
> re-derived against the merged tree `e3b50b6e8` (#3454) rather than against this document.** Recorded, not
> silently edited, because the pattern across all six is one thing: **a number or a scope carried forward
> from a draft instead of re-derived after the thing it counted changed.**
>
> 1. **Row 7's *"all corrected"* is false — four sites survive, all inside ADR 0107.** `grep -n 'executor
>    run' docs/adr/0107-*.md` on the merged tree returns `:37` (boundaries table, *Run state* row — the row
>    immediately ABOVE it was corrected, which is how it hid), `:38` (*Binary → text* row), **`:48` — §
>    Decision, the ADR's core sentence** (*"a scheduled executor run … the run is the state machine"*), and
>    `:91` (Phase 2, still ending with the *"not yet wired"* sentence THIS TABLE's row 2 reports as
>    corrected in `routes.ts`). All four struck at the closeout.
> 2. **§ Residuals is headed *"ALL OPEN"* and opens *"Nothing below is fixed by this batch"*, over a list
>    containing two rows the batch CLOSED** — `KSWF-15` and `KSC-17`, both struck-through and marked
>    *"CLOSED 2026-08-24 (R1)"* in place. The Status line at `:3` repeats the false generalisation
>    (*"every residual below is OPEN"*). The individual rows are honest; the heading and the two summary
>    sentences were not re-derived when R1 closed two of their members.
> 3. **§ R1 claims the review *"sabotage-verified all seven cures (each went RED when broken)"* (`:436-437`)
>    while the Tier 7 row (`:385`) says *"No new witness, by construction"*.** A tier with no assertion
>    cannot have gone RED. **Six cures, not seven** — and Tier 7 is right to have no witness, so the
>    over-claim is in the summary, not in the tier.
> 4. **One population, two counts.** `:468` says *"**five** listers claim `complete: true`"*; `:379` says
>    *"all **four** providers"*. There are **four** lister functions — `listGoogleDriveFolder`,
>    `listOneDriveFolder`, `listDropboxFolder`, `listBoxFolder` — and `listFolder`'s dispatch routes FIVE
>    provider ids into them (`microsoft-graph` and `microsoft-sharepoint` share one lister). The batch's own
>    test file states this distinction explicitly; the ADR lost it between two rows.
> 5. **`:386`'s parenthetical contradicts the design it explains.** *"`listingArray` returns `[]` → **13
>    RED** (5 providers × 3 body shapes)"* — 5 × 3 is 15, and `:468`/`:509` both record that **Google is
>    deliberately NOT on `listingArray`** (it discriminates on `kind`), so Google's cases cannot redden from
>    that sabotage at all. The 13 is right; the derivation offered for it names the one provider the design
>    excludes.
> 6. **`KSC-21` is cited in shipped code and filed nowhere in this ADR.**
>    `features/knowledge-sync/feature.ts:48` reads *"ADR 0605 R2 (`KSC-21`) — the DSAR eraser for
>    `knowledge-sync:source`"*; `grep -c 'KSC-21'` on this file returns **0**. § R2 describes exactly that
>    eraser and attaches no id, filing only the residual `KSC-22`. The row does exist —
>    `CODEBASE-ASSESSMENT.md:9688`, CLOSED — so nothing is lost; but this ADR's own § "an ID is a claim"
>    lesson failed at the one site written to honour it.
>
> **What none of these changes:** every behavioural claim spot-checked at the closeout held —
> `diffFolderListing` is the sole composition owner, all four listers refuse a `2xx` with no listing array,
> `boxDrained` no longer substitutes the page size for the folder size, the eraser tombstones rather than
> deletes, and the 191 -> 189 baseline is exact. The defects here are in the RECORD's arithmetic and scope
> language, which is precisely the class a records tier is least able to catch in itself.
>
> **CLOSEOUT CORRECTION 2026-08-24 — row 4 of this table DECLARED an edit that was not made,
> which is the one failure mode this table's own preamble exists to prevent.** The preamble two
> lines above says corrections *"append — strikethrough plus a dated note"*. Measured on the
> merged tree `e3b50b6e8`: `knowledgeSourceFetch.ts:247` carries `~~https-only~~` and `:298`
> quotes the superseded sentence verbatim — both genuine. **ADR 0107's status line carries
> neither.** The whole ADR 0107 diff in this squash is seven hunks and none of them touches line
> 3; the correction note that DOES exist sits under § Surface, seven lines lower, and misdirects
> the reader by saying *"the status line below"* when the status line is above it. So for the
> life of this batch the un-struck claim and two records asserting it had been struck coexisted.
> Both the strike and the direction are fixed at the closeout; `KSC-8` itself stays OPEN and
> deliberately unfixed as CODE, exactly as row 4 and its own tracker row say. **Why this is worth
> a note rather than a silent edit: the batch verified its own record corrections by re-reading
> the correction, not by re-reading the corrected site** — the same instrument error `KSC-17`
> records one tier earlier (*"re-verified by RE-READING rather than RE-RUNNING"*), reappearing
> in the tier whose entire subject matter is record accuracy.
>
> **CORRECTION 2026-08-24 — `KSC-8` and `KSC-13` are NOT new findings, and the Tier 7
> commit message (`322a437b0`) says they are.** Both rows were filed in
> `CODEBASE-ASSESSMENT.md` on 2026-08-23, in the assessment merged as #3453
> (`ad2175a7d`), before this batch began. `KSC-8`'s original text already named the
> implicit `redirect:'follow'` up to 20 hops *and* the guard module's own `'error'`
> default; `KSC-13`'s already named the OneDrive docblock "53 lines above the function".
> What Tier 7 actually did is narrower and worth stating exactly: it **closed** `KSC-13`
> (all five sites corrected) and **sharpened the claim** over `KSC-8`'s deliberately
> unfixed code, which stays OPEN. This table and the rows below always cited the correct
> row ids — the overstatement lives only in that commit message and in the orchestrator's
> report of it, and this note is here because a `git log` reader sees the commit message
> and not the rows. Caught by the tracker pass, which checked each id against the row text
> instead of trusting the number: **an ID is a claim.**

Two further doc-rot sites from `KSC-13` are corrected in the same pass:
`knowledgeSourceFetch.ts` called OneDrive byte download *"a follow-on"* 53 lines above
its implementation, and called Office/PDF binary extraction *"a follow-on"* after it
shipped. Both survived because **each sentence described the correct design**, so it
reads as current long after it has become a description of the past rather than the plan.

---

## Implementation record

| Tier | Commit | Changed | Witness (each sabotage-proved; restore verified by **diffing the file**) |
|---|---|---|---|
| 1 | `4a7dc04d8` | `knowledgeSourceFetch.ts`, `knowledgeSyncRunner.ts`, `knowledgeSyncService.ts` | **new** `test/knowledge-sync-destructive-diff.test.ts` + `knowledge-sync-runner.test.ts`, `knowledge-source-list-folder.test.ts`. Guard removed → 5 RED · `readJson` swallow restored → 6 RED (all four providers) · truncation reports COMPLETE → 4 RED |
| 2 | `b5a15fb5b` | `feature.ts`, `knowledgeSyncService.ts`, `knowledgeSyncRunner.ts` | **new** `test/knowledge-sync-tenant-purge.test.ts`. Drop the `tenantId` write → FIELD lane RED · hook returns 0 → HOOK lane RED · delete the feature registration → HOOK lane RED. **The witness was rebuilt twice** — v1 was vacuous (two overlapping mechanisms make each other's witness unfalsifiable), v2 called `registerTenantPurgeHook` itself and so proved the function, not the wiring |
| 3 | `c32f964cc` | `routes.ts`, `knowledgeSyncRunner.ts`, `knowledgeSyncService.ts` | **new** `test/knowledge-sync-connection-owner.test.ts`. Route guard → `if (false)` → CREATE + BROWSE RED · runner guard → `if (false)` → USE-lane RED. **The browse witness was vacuous and the sabotage is what showed it**: `expect(status).toBe(403)` stayed green with the guard deleted, because `failClosed` also answers 403 — two different refusals wearing one status code. It now asserts the cause |
| 4 | `a4b6ef217` | `features/kb/kbService.ts` | **new** `test/kb-rag-untrusted-fence.test.ts`. Raw interpolation restored → 3 RED · body fenced but NOT the title → 1 RED (the filename test alone — which is what shows the title assertion is load-bearing on its own) |
| 5 | `3ab016815` | `knowledgeSyncDaemon.ts`, `knowledgeSyncRunner.ts`, `knowledgeSyncService.ts`, `routes.ts` | `knowledge-sync-daemon.test.ts`, `knowledge-sync-runner.test.ts`, `idempotency-lane-tripwire.test.ts`. Wall-clock slot key restored → 5 RED · first failure terminal again → 1 RED · claim removed from `syncNow` → 1 RED · `isSyncDue` ignores backoff → 1 RED · `claimOnce` planted in a feature route → 2 RED (the broadened tripwire) |
| 6 | `e5b0d1322` | `KnowledgeSyncPanel.tsx`, i18n ×4, `knowledgeSyncClient.ts`, `knowledgeSyncService.ts`, `routes.ts`, `knowledgeSyncRunner.ts`, `check-notice-announce.mjs`, `notice-announce-0598-cohort.mjs` | `check-notice-announce` baseline 191 → 189, sabotage-proved at 188. **NO component test was added** — see `KSU-17`, OPEN and now broader: the destructive controls this tier touched (media toggle confirm, pause polarity, last-run rendering) are gate-verified but **unratcheted** |
| 7 | *this commit* | `FEATURES.md`, ADR 0107, ADR 0605, `feature.ts`, `knowledgeSyncService.ts`, `knowledgeSourceFetch.ts` (comments + one user-visible toggle description) | **No new witness, by construction** — a records tier changes no behaviour, and inventing an assertion to look rigorous would be worse than none. Verified by the type/lint/i18n/ADR-ref gates listed in the commit |
| **R1a** | `ed8c8c3d1` | `knowledgeSourceFetch.ts` | `knowledge-sync-destructive-diff.test.ts` +21. `listingArray` returns `[]` → **13 RED** (5 providers × 3 body shapes) · `driveListingFiles` degrades → **4 RED** · `kind` dropped from the mask → **1 RED** · `boxDrained` fallback restored → **2 RED** · a `diffFolder(` planted in `src/` → **1 RED** |
| **R1b** | `08aaacb40` | `knowledgeSyncService.ts`, `knowledgeSyncDaemon.ts`, `knowledgeSyncRunner.ts`, `idempotency-lane-tripwire.test.ts` | `knowledge-sync-runner.test.ts` +7, `knowledge-sync-daemon.test.ts` +3. Pre-run lease removed → **1 RED** (*the crash-recovery witness — a promise that never settles, not a throw*) · `syncStartedAt` dropped from the key → **2 RED** · `isSyncDue` ignores the lease → **2 RED** · per-tick prune removed → **1 RED** · `statusAfterPass` stops preserving → **3 RED** · revoked refusal removed → **1 RED** |
| **R1c** | `083ac88e2` | `KnowledgeSyncPanel.tsx`, i18n ×4 | `KnowledgeSyncPanel.test.tsx` +8. Resume re-disabled → **1 RED** · "Sync now" re-enabled → **1 RED** · raw blob back in the announcement → **1 RED** · media-off confirm removed → **1 RED** · `lastRun` ladder collapsed → **1 RED** · `skippedMedia` dropped from the fixture → **1 RED (on the SECOND attempt — the first assertion was green with the fixture broken; see § R1)** |

---

## Residuals — ALL OPEN

Nothing below is fixed by this batch. Filed so that the next reader inherits the list
rather than the impression that a graded feature is now clean.

**Doctrine**
- `KSWF-1` — the scheduled sync produces no run. **Blocked on `WF-KB-10`** (`features/kb/surface.ts` has no write method, so no node can ingest). Target shape + tripwire above.
- `WF-KB-10` — the KB surface exposes reads only. The unblocking prerequisite.
- `KSWF-8` — `SyncSource.runId` is declared, documented, written nowhere, and serialised as `undefined` on every response. Left in place because deleting it changes a shipped response shape.
- `KSWF-16` — the tripwire itself; it is a standing obligation, not a task.

**Security / egress**
- ~~`KSC-8` — `fetchGuardedBytes` hand-rolls a weaker subset of `guardedEgressFetch`: **no per-hop scheme check** (the corrected "https-only" claim), no `AbortSignal.timeout`, no `maxResponseSize` (the cap is applied *post*-buffering), and it skips the ADR 0187 tenant egress firewall.~~ **CLOSED 2026-08-28 by ADR 0609.** All four gaps fixed: a bounded manual redirect loop re-applies the scheme arm (via ADR 0607's shared predicate), the denied-host literal, and the ADR 0187 tenant policy on EVERY hop; `AbortSignal.timeout`; and the size cap now bounds what is READ rather than judging what was already read. The deferral's stated debt — *"owes a witness against a real redirect chain"* — is paid by 11 tests driving a real loopback server through a real `undiciFetch`, six-way sabotage-verified. Note the witness is deliberately a **half-witness in two parts** and says so: the production `https:`→`http:` downgrade needs a TLS endpoint the suite cannot stand up, so per-hop-ness is shown via a `file://` redirect target and https-ness via hop 1 with the dev flag off.
- `KSC-9` — **the four "SSRF-denied" cases in `test/knowledge-source-list-folder.test.ts` mock `webhookEgressGuard` wholesale** (`:9-16`), so they assert that a **mocked predicate was called**, not that any guard works. **Tier 1 touched this file and did NOT repair the mock** — it adapted the listing-shape assertions to `SyncFolderListing` and added `complete` assertions; the mock declarations and every `mDenied` case are byte-unchanged. No redirect-to-private-IP and no DNS-rebind coverage exists on this path.

**Correctness / lifecycle**
- `KSC-6` **PARTIAL** — Tier 5 gave the cadence a bounded backoff, but the *panel* half is untouched: the button still keys on `status === 'paused'`, so an errored source shows a **Pause** icon and clicking it pauses. Recovery from `error` remains a two-click accident. Same site as `KSWF-14`.
- `KSC-10` / `KSC-11` / `KSWF-12` — deleting a sync source orphans every document it ingested; deleting the KB collection leaves the source `active`, reporting clean `unchanged` passes into a collection that no longer exists (**silent success, not an error**).
- `KSU-22` **(NEW)** — ADR 0107 OQ-1's per-source **"keep on delete"** opt-out was proposed and never built (zero code hits). A collection bound to a drive destroys hand-uploaded documents on the next pass and there is no supported way to opt out.
- `KSWF-13` — no per-*run* spend bound: `TICK_BUDGET_MS` is checked between tenants and between sources, never inside `runKnowledgeSyncOnce`, so one source can fetch, OCR and embed up to `MAX_LIST_FILES` files.
- ~~`KSWF-15` — the `knowledge-sync:` claim prefix is never self-pruned, and a data-derived key mints one row per pass. Same trade `scheduleDaemon` already makes; belongs with that finding.~~ **CLOSED 2026-08-24 (R1).** It was not the same trade and it was not hygiene: with the key no longer rotating on its own (HIGH 1), the unpruned prefix was the *second* reason a crashed source could never run again, and the global backstop it deferred to is a **no-op at `OPENWOP_IDEMPOTENCY_TTL_DAYS=0`**. `pruneStaleKnowledgeSyncClaims` runs per tick at `2 × SYNC_LEASE_MS`.
- `KSWF-20` **(NEW, R1)** — a pass that OUTLIVES its 60-minute lease is still a double-run window. A crash is not observable from outside the dead instance, so no constant removes this; a renewing heartbeat does. Pairs with `KSWF-13` (no per-run spend bound).
- `KSU-23` **(NEW, R1)** — exactly one row now announces, in `t()` copy rather than a raw server blob, but the sentence carries no count of how many sources failed. The single-slot assertive region cannot hold N; an aggregate pluralised announcement is the cure.
- `KSWF-18` — a CHANGED file is delete-then-ingested; an **ingest** failure (unlike a fetch failure) leaves the KB missing that document with the cursor un-advanced.
- `KSC-16` / ~~`KSC-17`~~ — revocation only re-labels `active` sources~~, and `POST /:id/sync` is not blocked for a `paused` one, so a manual retry discards the revocation reason~~. **`KSC-17` CLOSED 2026-08-24 (R1) — and its tracker row was FALSE when written.** It said a manual sync "flips it to `error`"; Tier 5 had already changed that to `active`, i.e. an auto-RESUME, which is strictly worse. `KSC-16` stands unchanged.
- `KSC-12` — **premise superseded, not closed by fixing it.** The "defect-pin" reading of `knowledge-sync.test.ts:46-51` is withdrawn: it pins a correct guarantee. See § "Why the fetch boundary".

**Coverage / instruments — the honest half**
- **`CT-KSU-1`..`-8` — NONE RUN. No browser ran on this feature at any point in the assessment or this batch.** Every visual, keyboard, focus-order, contrast and screen-reader claim in the UX row and in Tier 6 is **static-only**. `CT-KSU-2` in particular decides whether `KSU-16` is an Improvement or a Blocker, and that is unresolved.
- `PROBE-KS-6` — the **route-level** version of `PROBE-KS-1`: boot `createApp`, hold the daemon claim, `POST …/:id/sync` over supertest, assert 409. Tier 5's witness drives `syncNow` directly, one call short of the route. `KSWF-10` (the manual sync route has **no** test at all) is open for the same reason.
- `PROBE-KS-7` — re-run the Tier 2 erasure witness against **Postgres** and against the full `routes/account.ts` account-delete composition. Verified on `memory://` only; *sqlite masks Postgres type errors* is a live class here.
- `PROBE-KS-9` / `-10` — full `npm run ci`; a live-provider soak on a >1000-file folder (the `KSWF-3` thrash hypothesis is derived, not measured).
- `KSU-17` — the frontend suite still asserts only two fixed reads; nothing covers pause/resume, remove, the media toggle, or the `failed > 0` warning branch. Tier 6 widened what is unratcheted.
- `KSC-1`'s **premise remains UNPROVEN**: the batch proves the host mishandled a non-JSON `200`, **not** that any provider emits one. The exposure is an interposing proxy, a captive portal, or a provider error page. **The cure is fail-closed regardless** — it refuses to delete on a listing it cannot vouch for, which is correct whether or not the trigger is ever observed — so the unproven premise lowers the *likelihood*, never the *correctness*.
- The `ctx.features.kb` consumer population behind Tier 4 is a **FLOOR, not a measurement**: the surface is runtime string-keyed, so pack- and MCP-mediated callers are invisible to static grep. Tier 4's in-function placement is what makes the floor not matter for the prompt lane; it does **not** make the list complete.
- Tier 4 closes the `augmentedPrompt` only. `RagResult.contexts` still carries raw `text`/`title` **with** their `contentTrust`, which is correct for structured data — but a caller that builds its own prompt from `contexts` and ignores `contentTrust` is still unfenced. That is a per-caller obligation this change cannot discharge centrally.
- Tier 2's residual: a cursor with **neither** a `tenantId` **nor** a surviving parent is reachable by neither mechanism. `deleteSyncSource` cascades, so that set should be empty outside a crash mid-delete, and **no detector for it is possible from the row alone.**
- Tier 3's residual: sources created before `createdBy` existed carry none and keep the previous behaviour. Retro-attributing an owner would fabricate the very fact the check depends on.
- `KSU-5`/`-6`/`-7`/`-9`/`-11`/`-12`/`-13`/`-14`/`-15`/`-18`/`-20`, `KSC-18`, `KSWF-9`/`-17` — untouched; see the tracker rows.

---

## R1 — the adversarial-review fold-in (2026-08-24)

The seven tiers above were put through an adversarial review that sabotage-verified all
seven cures (each went RED when broken), confirmed the 191 → 189 baseline lowering is
real (188 exits 1), and found backend `tsc` 0, `npm run build` 0, `eslint src
--max-warnings=0` 0, 118/118 tests green. **None of that is re-litigated here.**

**Three of its four HIGH findings are defects THIS BATCH CREATED, and that is the
finding.** Not "the fix was incomplete" — the fix reproduced, one layer up or one lane
over, the exact family it was written to close. Each is recorded below as a *class*,
because the individual defects are less useful than the shape.

### The theme, stated once

| # | The tier's cure | What it reintroduced |
|---|---|---|
| HIGH 1 | Tier 5 deleted the wall-clock claim slot as *"not a safety property, it was the defect"* | The slot was ALSO the only crash-recovery mechanism. Deleting it traded a 10-minute double-run window for an **unbounded single-source outage** |
| HIGH 2 | Tier 1 made `readJson` throw so `[]` could not mean two facts | Every lister did `Array.isArray(body?.files) ? … : []` **one line later** and declared the folder drained — `[]` still meant two facts |
| HIGH 3 | Tier 5 gave a failed pass a backoff instead of retiring the source | The same line now writes `'active'` unconditionally, so a failed pass **UN-PAUSES** a source and re-arms a destructive cadence. Tier 6's `KSU-3` deliverable evaporates after one click |
| — | Tier 6 disabled Resume on a revoked source, *"an action guaranteed to fail is worse than no action"* | There is no `onConnectionRestored`, so **nothing else clears `pausedReason`** — a revoked source became permanently paused with no in-product exit |

The common mechanic: **each cure was verified against the defect it named and never
against its own failure mode.** Every one of them has a witness that passes. Tier 5's
claim test proves two lanes cannot both win; it cannot see that neither can win *ever
again*. Tier 1's `readJson` test proves an HTML error page throws; it cannot see the
JSON one. Tier 5's backoff test proves an `active` source stays schedulable; there was
no paused source in the file. **A witness written from the defect cannot observe the
cure**, which is why "what is this cure's own failure mode?" has to be asked explicitly.

### What changed

| Finding | Disposition | Commit | Cure |
|---|---|---|---|
| **HIGH 1** — the claim key wedges a source permanently on any mid-pass crash | **FIXED** (`KSWF-19` filed + closed; `KSWF-15` closed; `KSWF-20` filed OPEN) | `08aaacb40` | The whole `scheduleDaemon` shape, not the key alone — see below |
| **HIGH 2** — five listers claim `complete: true` for a 200 carrying no listing | **FIXED**, every provider, each with its own witness (`KSC-19`) | `ed8c8c3d1` | One shared `listingArray`; Google discriminated on `kind` |
| **HIGH 3** — a failed "Sync now" un-pauses a paused source | **FIXED** (`KSC-17` corrected + closed) | `08aaacb40` + `083ac88e2` | `statusAfterPass`; a revoked pause refuses the run; Resume re-enabled |
| **HIGH 4** — `KSC-17` re-verified by re-READING instead of re-RUNNING | **FIXED** | tracker commit | The row is corrected, and says so |
| **MEDIUM 5** — Box infers completeness from its own page size | **FIXED** (`KSC-20`) | `ed8c8c3d1` | `boxDrained`; a SHORT PAGE is the drain signal |
| **MEDIUM 6** — three `KSU-*` rows closed with no witness anywhere | **FIXED** (7 witnesses; `KSU-17` OPEN → PARTIAL) | `083ac88e2` | …and the fixture, whose symptom the review got wrong — see below |
| **LOW 7** — a raw server blob in an assertive announcement, N rows stomping | **PARTIAL**, residual filed as `KSU-23` | `083ac88e2` | One `t()` announcement per list; the count is the residual |
| **LOW 8** — `diffFolder` exported with no tripwire | **FIXED** | `ed8c8c3d1` | A scan with an explicit non-vacuity arm |
| **LOW 9** — the Tier 4 "cannot drift" fence claim is not accurate | **FIXED (the claim, not the code)** | records | The three lanes share the MODULE, not the TREATMENT |

### HIGH 1 — which cure is load-bearing, and why the other one is not

The review offered "advance the state version before running, **and/or** add a per-tick
`pruneOnceByPrefix`". Both landed. They are not equals and the ADR should say which is
which.

**LOAD-BEARING: the pre-run lease** (`beginSyncAttempt` stamps `SyncSource.syncStartedAt`
between winning the claim and running it; `syncStateVersion` folds it in). It is
`scheduleDaemon`'s advance-before-dispatch, and it recovers a crashed source
**deterministically, within `SYNC_LEASE_MS`, with no daemon tick, no restart and no
operator**. It also makes the 409 message true.

**BELT: the per-tick prune.** It bounds the table (`KSWF-15`) and removes a
configuration in which nothing ever frees these rows — the global backstop
(`retentionSweepDaemon.ts:427`) is a **no-op at `OPENWOP_IDEMPOTENCY_TTL_DAYS=0`**. But
it is a second escape, not the mechanism: it depends on the daemon running, and a host
with the daemon kill-switched would recover on the lease alone.

**The cure was then checked against its own failure mode, which is the whole point of
this section.** Rotating the claim key mid-pass is exactly what lets the *next* tick win
a fresh claim over a pass that is still running — the double-run `KSWF-5` was about. So
`isSyncDue` and `syncNow` both refuse while the lease is live. And **no wall-clock edge
returns**: `KSWF-5` was a claim KEY derived from the clock, so two lanes either side of a
boundary computed DIFFERENT keys and both won; this is a bound on a FIELD, the key stays
data-derived, and two lanes arriving as the lease lapses read one row and compute one key.

The residual is stated rather than hidden: a pass that OUTLIVES its 60-minute lease is
still a double-run window (`KSWF-20`), a crash is not observable from outside the dead
instance, and no better constant removes that — a renewing heartbeat does.

**The crash witness is simulated by a promise that NEVER SETTLES.** A thrown error runs
`syncNow`'s catch, which writes the row and frees the key; that path was never broken, so
a witness built on a throw would be vacuous. What scale-in, an OOM kill and a deploy
landing mid-pass all leave behind is a claim taken and *nothing after it*.

### HIGH 2 — where the review's prescription was NOT followed

The review offered: *"Throw the same typed 502, or at minimum `partialListing(out, …)`."*
**Both forms are wrong for Google**, and the reason is the argument this ADR already
makes at § "Why the fetch boundary".

A Drive partial response (`fields=…`) omits a field whose value is empty, so an empty
folder can arrive as `{"kind":"drive#fileList"}` with no `files` key at all. Requiring the
array unconditionally makes every emptied Drive folder a permanent 502; treating a missing
array as *incomplete* makes it never prune. **Either one destroys the correct
empty-folder guarantee** — trading a data-loss bug for a sync that never converges, which
is the exact swap Alternative 1 was rejected for.

So Google discriminates on `kind`, which the mask now requests and which is never a
default value. **This is correct under either reading of the Drive contract** — if Drive
in fact always sends `files: []`, the `kind` branch simply never fires and the array
branch has already accepted the response. The design does not depend on resolving that
uncertainty, and that is why it was chosen over the two forms that are each wrong in
exactly one of the two worlds, silently.

`browseFolders` was **deliberately not changed** and the asymmetry is recorded on
`GEN-KS-5`: a browse that shows nothing is visible to the user and deletes nothing,
whereas the same substitution on the sync lane prunes the collection.

### The green sabotage — the review's own account falsified

Seventeen sabotage probes were run for this fold-in. **Sixteen went RED on the first
attempt. The seventeenth was mine, and it falsified the review.**

MEDIUM 6 states the broken fixture makes `t('syncResult', { skipped: undefined })` render
*"…, undefined media skipped, …"*. The first cut of the assertion was written to that
wording — `not.toContain('undefined')` — and **it stayed GREEN with the fixture still
broken**. MEASURED: i18next interpolates an `undefined` value as the EMPTY STRING, so it
renders `"Synced: 2 updated, 1 removed, ␣media skipped, 0 failed."` The defect is real
(a missing number and a double space); the symptom named was not. The assertion is on the
whole sentence now, and re-sabotaged RED.

**A green sabotage is a finding even — especially — when the thing it falsifies is the
review that prescribed the fix.** ADR 0605's own § Record corrections makes the general
version of this point about `FEATURES.md`; this is the same lesson arriving through the
review lane instead of the code lane.

### What was NOT done, stated plainly

- **`CT-KSU-1..8` remain NONE RUN.** No browser has rendered this feature at any point —
  not in the assessment, not in Tiers 1–7, not here. Every visual, focus, contrast and
  screen-reader claim in Tier 6 *and in this fold-in* is static-only. `CT-KSU-4` decides
  whether any of the LOW 7 announcement work is audible at all.
- **`npm run ci` was not run** in this fold-in (it is run once, at the end, by the
  orchestrator). What WAS run: backend `tsc` 0, 150 backend tests over 9 knowledge-sync
  files, frontend `tsc` 0, `eslint src --max-warnings=0` 0, 19 frontend tests,
  `check-notice-announce` EXIT 0 (baseline 189 unchanged), `check-i18n` EXIT 0.
- **`PROBE-KS-6`/`-7`/`-9`/`-10` are still OPEN**, unchanged — including the route-level
  409 over supertest, which is now MORE interesting than it was: `syncNow` has two
  distinct 409s (a live lease and a lost claim) and one 409 for a revoked pause, and
  nothing exercises any of them through the route.
- **`KSWF-1` is unmoved** and still blocked on `WF-KB-10`. Nothing in this fold-in
  touches the doctrine deviation, and `KSWF-16` — the standing tripwire — **passed
  again**: no new daemon, no new `setInterval`, no second timer. The lease rides a field
  on the existing row; the prune rides the existing tick.

---

## R2 — the ratchet that refused the batch's last gap (2026-08-24)

Full CI went red on exactly two ratchets, both firing because **this batch introduced
what they police**. That is the honest framing and it is worth keeping: neither was a
pre-existing failure the batch tripped over, and neither was noise.

### `test/fenced-truncation.test.ts` — a new handler of fenced text (CLASSIFIED)

Tier 4 made `features/kb/kbService.ts` import `untrustedContent.js`, which puts it in
that ratchet's population. It is classified **`PRODUCES`** — it fences and defangs and
never shortens a fence.

That classification was **independently re-derived rather than accepted**, because the
`TRUNCATES` alternative would oblige the file to call `truncateFencedContent` and a
wrong `PRODUCES` is exactly the silent decapitation TOCC-4 is about. MEASURED, three
hops out from `buildRagContextBlock` (`kbService.ts:1526-1531`) through
`ragQuery` → `routes.ts:240` / `surface.ts:33-37` → the `feature.kb` / `campaign-brief`
/ `campaign-channels` node packs → `core.openwop.ai` → `providers/dispatch.ts`:

- **No caller applies any length bound to `augmentedPrompt`.** Not the HTTP route, not
  a node pack, not the provider dispatch.
- Every bound *inside* `kbService.ts` is either a **count** bound on an array (`topK`,
  `MAX.retrieveCollections`, `MAX.chunksPerDoc`) or a **char** bound at **ingest** on
  raw pre-fence text (`cleanString(input.title, MAX.title)` at `:1052` and `:1182` —
  both inside `ingestDocument`/`upsertDocument`, neither anywhere on the compose path)
  or on the **query input** (`MAX.query`), which lands *outside* the fenced region.
- The three seams that could plausibly shorten a fence all shorten something else:
  `compact.ts` `elideArrays` removes **whole elements** and `minifyJsonText` copies
  string literals byte-for-byte, `transcriptBudget.windowTranscript` drops **whole
  turns**, and `openaiSideband.ts:360` — the one real 4000-char bound on fenced text —
  already uses the helper.
- `truncateFencedContent` is deliberately **not** imported: there is nothing here to
  shorten.

**One population-boundary observation, recorded rather than filed as clean:**
`bootstrap/nodes.ts:1268` does `prompt.slice(0, 80)` in the MOCK ai node, and a chain
wiring `retrieve.augmentedPrompt` into it would put a bare slice on a possibly-fenced
string. It is a mock echo that is never re-fed to a model, and the file is outside the
ratchet's population **by construction** (it contains neither `untrustedContent.js` nor
`toModelToolResult`; `grep -c` = 0). Named so the boundary is a known fact rather than
an accident.

### `test/subject-erasure-feature-stores.test.ts` — and the entry that was the wrong move

Tier 3 added `SyncSource.createdBy`, which made `knowledge-sync:source` an
**actor-attributed** store — MEASURED, with the gate's own two-run recipe: census
**129 → 130, ADDED 1, LOST 0** — with no eraser reaching it. A DSAR therefore left two
things behind: a durable row naming the erased person, **and a cadence still fetching a
drive on a credential nobody live had authorised**.

The first attempt recorded an `ACTOR_ATTRIBUTED_DEBT` line. **That was wrong and the
ratchet was right to refuse it** (`ACTOR_DEBT_CEILING` 22, entry made 23): the ceiling
exists to stop a batch growing the ledger to pay for a field the *same batch*
introduced. Let that through once and the number stops meaning "debt we inherited" and
starts meaning "debt we are willing to create", which is the one thing a shrink-only
ledger cannot survive. The debt line is removed; **ledger 22, ceiling 22, census +1**.

### Why DISABLE, and why the ledger's usual answer is wrong here

`ACTOR_ATTRIBUTED_DEBT`'s standing rationale is *"the row is an ORG business record its
author happens to have created, so the honest erasure is RE-ATTRIBUTE"*. That does not
apply. `createdBy` here is **not provenance** — it is the confused-deputy GUARD Tier 3
added, the fixed expectation every later pass re-checks. So:

- **RE-ATTRIBUTE is wrong.** The source binds *that person's* Drive credential; naming a
  different member as creator leaves a sync running on a token whose owner no longer
  exists to authorise it — the deputy confusion the field exists to prevent, re-created
  by the erasure.
- **DELETE is wrong.** It silently stops an org's folder sync, and a pass **DELETES KB
  documents**, so a half-understood erasure has destructive reach into data that is not
  the erased person's.
- **DISABLE is conservative and reversible**: pause the schedule, tombstone the
  identifier, require a live member to re-bind their own connection.

**TOMBSTONE, NEVER `delete`.** `createdBy: ERASED_CREATOR`, not `undefined`. The runner
guard is `conn.userId && source.createdBy && …`, so a row with **no** `createdBy` is the
LEGACY shape the guard *skips*: deleting the field would hand the source back the exact
pre-`KSC-2` behaviour. **Deletion becomes a grant**, in a fix written to close a grant.

**The pause honours Tier 3's predicate rather than inventing one.** A source is paused
only when its connection names a PERSON. A **tenant-level** connection carries no
`userId` — the run acts as the bare tenant, there is nobody to impersonate, and pausing
it would stop a legitimate org sync in the name of a hole it does not have. That is the
over-reach `requireOwnConnection`'s first draft made; one predicate, both lanes. A
missing or unreadable connection fails **closed** (pause). An already-paused source
keeps its own `pausedReason`, so a `connection-revoked` pause does not lose Tier 6's
reconnect instruction.

### The exit — checked, because R1 already caught this wedge once

R1's finding was that Tier 6 disabled Resume on a revoked source and, with no
`onConnectionRestored` hook, left it permanently paused with no in-product exit. A
`creator-erased` pause must not repeat it, and it does not:

- `POST /:id/resume` is **unconditional** (route and panel both), so the schedule can be
  re-armed. Resume re-arms the SCHEDULE; it does not re-authorise the CREDENTIAL, and
  the run still refuses fail-closed — **defence in depth, not a dead end**.
- The refusal and the `lastError` both **name the real exit** ("add the folder again with
  your own connected account"), and the runner gives the erased-creator case its own
  message rather than the drifted-owner one, which would be true and useless. A pause
  with an illegible exit is the wedge; a pause that says what to do is not.
- Asserted end-to-end: *the real exit WORKS* — a live member re-binding syncs normally.

### Implementation record

| Tier | Commit | Changed | Witness (sabotage-proved; restore verified by **diffing the file**) |
|---|---|---|---|
| **R2** | *this commit* | `knowledgeSyncService.ts`, `knowledgeSyncRunner.ts`, `feature.ts`, `host/subjectEraserManifest.ts`, `subject-erasure-feature-stores.test.ts`, `fenced-truncation.test.ts`, `knowledgeSyncClient.ts` | **new** `test/knowledge-sync-subject-erasure.test.ts` (14). Registration removed → **6 RED** across 3 files · eraser a no-op → **13 of 14 RED** · field DELETED instead of tombstoned → **10 RED** · tenant-level predicate dropped → **1 RED** (the right one) · `createdBy` match dropped → **1 RED** (the right one) |

**THE SABOTAGE FOUND A REAL DEFECT IN THE WITNESS, and it is the more useful half.**
The first cut of the no-op probe left **6 of 14 GREEN**, and five of those six were
assertions of a **NON-EFFECT** — "the row still exists", "a second call changes
nothing", "the sentinel re-pauses nothing", "an empty argument is a no-op", "a re-bound
source runs" — every one of which a **dead eraser satisfies perfectly**. They read as
guarding the disable-don't-delete decision and guarded nothing. Each now carries a
**positive control** asserting the eraser actually acted, and the re-run is **13 of 14
RED** (the survivor tests registration, which the registration sabotage reddens). This
is the repo's *"non-vacuous ≠ meaningful"* lesson arriving one layer in: the file was
green, the cure was correct, and the witness was still decorative until a probe said so.

### What was NOT done, stated plainly

- **`npm run ci` was not run here** (the orchestrator runs it). What WAS run, unpiped:
  backend `tsc` **0**; the two ratchets + the eraser manifest **46/46**; the new witness
  + 6 knowledge-sync files **121/121**; 11 erasure/consent/account-delete suites
  **99/99**; frontend `tsc` **0**, `eslint src --max-warnings=0` **0**, frontend
  knowledge-sync tests **19/19**. Backend has no eslint binary — the lint gate is
  frontend-only.
- **No browser.** `CT-KSU-1..8` remain NONE RUN, unchanged by this fold-in.
- **`memory://` only.** `PROBE-KS-7` still stands and now covers this eraser too: it has
  not been run against Postgres or through `routes/account.ts`.
- **The identity-space residual is real and is NOT closed.** This eraser matches
  `createdBy` by exact `userId`. A DSAR arriving only as an email or a CRM `contactId`
  does not reach it, because the one shipped resolver (`crm/erasure.ts
  resolveCrmSubjectKeys`) is one-directional email/phone → contactId. Matching a
  non-userId key heuristically would pause a **stranger's** sync on a coincidence.
  Filed as `KSC-22`; it is the `marketplace:review` / `email:soft-bounce-count` residual,
  not a knowledge-sync defect.
- **`knowledge-sync:filestate` is untouched and invisible**, stated rather than implied:
  it carries no subject field of any shape, so no widening of the ratchet can see it. It
  is folder state, not a person's data, reclaimed by `deleteSyncSource`'s cascade and
  `purgeTenantSyncCursors`.
- **No dedicated chip for `creator-erased` in the panel.** The two states already render
  differently — this one always carries a `lastError`, rendered as a focusable warning
  `<Notice>` naming the exit, where a plain `user` pause carries none. A dedicated chip
  plus four locales is a real improvement and is **filed (`KSU-24`), not smuggled in**.
  The client type is widened so it stops claiming two values when the wire has three.

---

## RFC verdict

**No RFC.** Nothing here touches the OpenWOP wire: no run-event field, no capability
flag, no event type, no endpoint contract on `/v1/runs*`, no normative `MUST`. Every
route changed is a non-normative host extension under
`/v1/host/openwop-app/knowledge-sync/*`; the one cross-feature change (Tier 4) is
host-internal prompt construction inside `kbService.ragQuery`. ADR 0107's own verdict —
host assembly over Accepted RFCs 0046 / 0076 / 0099 — is unchanged.

**When that stops being true:** `KSWF-1`'s migration turns the sync into a real workflow
run. That is still host work (chains ride the *existing* RFC 0013 chain format), **unless**
it needs something the pack format does not yet express — sub-chain nesting or a
run-produced variable bag. Those are additive **RFC 0013 revisions** authored in
`../openwop`, per CLAUDE.md § "Workflows — never hard-code". Reverting to a pinned
in-tree definition is not an option in either direction.
