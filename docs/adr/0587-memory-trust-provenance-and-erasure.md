# ADR 0587 — per-agent memory: trust provenance, erasure coverage, and failure honesty

Status: implemented (the items in the record below; the rest are named as deferred)

Supersedes nothing. Corrects claims made in ADR 0038 §C, ADR 0120 §100 and
`FEATURES.md` § "Chat memory auto-extraction".

## Context

Three independent single-feature graders (`/grade-code`, `/grade-ux`,
`/grade-workflows`, all 2026-08-19) landed on the **Per-agent knowledge & memory**
substrate and converged on one finding from three directions: *the trust label is
the only thing standing between a person's memory and a tool-enabled model prompt,
and several paths lose it or never had it.*

The substrate itself is sound and is **not** what this ADR changes: one owner
(`host/subjectMemory.ts`), an SR-1 scrub chokepoint with a call-site ratchet, an
RFC 0080 dimension SSoT that refuses to advertise `replay-snapshot` because the
code cannot back it, a fail-closed `per-user` sentinel, structurally-fenced
*borrowed* recall, and a fail-closed consent gate. Those are preserved verbatim.

### The live injection path (AGMEM-2 / MEM-UX-3 / WF-AKM-2)

Traced end to end at `origin/main` @ `dd37ba24`:

1. `persistExchange.ts:111-115` builds an extraction transcript from
   `role === 'user' || role === 'agent'` turns. **Agent turns echo tool results,
   MCP content and fetched web text.**
2. `memoryExtractor.ts` sends it to an LLM; `extractionBinding.ts:32` persists each
   returned line via `addSubjectNote(t, personSubject(userId), '[auto-extracted] ' + fact)`.
3. `subjectMemory.ts:249` wrote the durable row with **`contentTrust:'trusted'`
   hardcoded**, and `:252` tagged the recall row `[NOTE_TAG, subject.id]` — never
   `MEMORY_UNTRUSTED_TAG` (which had exactly one writer repo-wide, and it was not
   this path).
4. `trustOf` therefore reported `'trusted'`, so
   `agentKnowledgeComposition.ts:57-61` placed the content in the **unfenced**
   "Relevant knowledge for this agent" block…
5. …which `chatContext.ts:205-208` folds into the agent's **system scaffold** —
   which is exactly where `conversationToolLoop.ts` compiles provider-native tools.

So: text a webhook, a fetched page or an MCP server put in front of the model could
be laundered into that model's own instruction scaffold on a later, tool-enabled
turn. The docblocks at `extractionOp.ts:17` and `extractionBinding.ts:8` both
**claimed** the untrusted marking the code omitted, and
`test/memory-extraction-binding.test.ts:31` was titled for those semantics while
asserting only a row count.

`WF-AKM-2` is an independent second route to the same mislabelling: the
`feature.agent-knowledge.nodes.ingest` pack node decided `contentTrust` by
`Object.keys(inputs).length === 0`, so any chain edit that routes the trigger body
through an upstream node relabels untrusted external content `'trusted'` —
on a chain the pack's own description advertises as builder-editable.

## Decision

### 1. Trust and provenance are DATA, not a string and not a key count

`addSubjectNote` takes `AddSubjectNoteOptions { source?: 'user' | 'auto-extract' }`.
`contentTrust` is **derived**, never passed: `source === 'auto-extract'` ⇒
`'untrusted'`, always. A caller cannot hand back `'trusted'` for a model-authored
fact. The durable row stores `source`; the recall row is tagged
`MEMORY_UNTRUSTED_TAG` so every existing fence (dispatch split, composition block,
vector metadata) fires without new plumbing.

The `[auto-extracted] ` English prefix is **no longer written**. It was
untranslatable (it lived in content, not in a catalog), it was invisible to every
fence, and it made a model's guess render byte-identical to a fact the user typed.
The UI now reads `source` and renders a localized provenance chip.

Pack nodes read **`ctx.trustBoundary`**, which the run stamps at ignition and which
was already threaded to pack workers at `packHostCallBroker.ts:90` — never a key
count. The correct answer was already on the context and was never read.

### 2. The AGMEM-2 backlog — what this ADR can and cannot do

**It cannot be fixed properly.** The trust label is unrecoverable after the fact:
once a row exists stamped `'trusted'`, nothing distinguishes a fact the user typed
from one an LLM inferred off a page a tool fetched. The English
`[auto-extracted] ` prefix is the only **positive** discriminator — the only signal
that says *this row IS auto-extracted*.

> **CORRECTED (review of this ADR).** The original wording — "the only discriminator
> any backfill will ever have" — is **overstated, and the overstatement matters
> because it closes off a migration that is actually available.** There is a second
> discriminator, and it runs the other way:
>
> Extraction is fail-closed on an **explicit grant** (`isExtractionGranted`:
> `g?.granted === true`, absent ⇒ no write), and `DELETE /profiles/me/memory-extraction`
> **sets `granted:false` rather than deleting the row** (`memory-auto-extract/routes.ts:44-49`
> → `setExtractionGrant(..., false, ...)` → `grants.put`). So a revoke LEAVES a row.
> Therefore **absence of a grant row proves the subject never enabled extraction**,
> which proves every note in that scope is user-authored.
>
> This is **NEGATIVE identification only**, and its limits are as real as its value:
> it cannot mark which rows *are* auto-extracted, only which scopes contain none;
> and `updatedAt` is a last-write stamp, not an enable timestamp, so it yields **no
> honest date boundary** inside a scope that ever had a grant.
>
> **The decision not to ship a positive backfill STANDS** — unchanged, for the
> reasons below. What changes is the claim: a **bounded, honest completeness
> statement over the no-grant population** is available to a future migration
> ("these scopes are provably clean"), and this ADR should not have implied
> otherwise.

What ships is therefore a **read-side heuristic, explicitly not a backfill**:

- `listSubjectNotes` projects a row with **no `source` field** whose content begins
  with `[auto-extracted] ` as `contentTrust:'untrusted'`, `source:'auto-extract'`.
- `trustOf` (recency) and the RAG metadata projection apply the same prefix check
  unconditionally, because their rows carry no `source` field at all.

Its limits, stated plainly:

- **It over-fences.** A user who literally types `[auto-extracted] ` gets their own
  note fenced. This is the fail-closed direction and is accepted; the heuristic can
  never *grant* trust a row did not have.
- **It is not complete and no backfill can be.** Rows written by the old path whose
  content was truncated, edited, or re-typed without the prefix are indistinguishable
  from user-authored facts, permanently. No migration is proposed, because a
  migration resting on this prefix would produce a *record* of completeness it
  cannot deliver — and a false record is worse than an honest gap.
- **No `UPDATE` is issued.** Stored rows are left byte-identical; the heuristic is a
  projection. That keeps the gap visible and reversible rather than baking a guess
  into durable state.

Operators who need certainty should treat pre-`0587` auto-extracted rows as
untrusted-or-unknown and use the Memory tab's delete affordance.

### 3. Erasure covers the consent grant (AGMEM-4)

`memextract:grant` carried a userId in its key, in `subject` and in `grantedBy`,
had no eraser, and entered **no denominator** — not covered, not debt, not exempt.
A DSAR therefore erased the person's memory and left a live grant authorising
future writes to it.

Two changes, deliberately in **separate commits** because their blast radii differ:

- **The instance:** `features/memory-auto-extract/` registers a
  `registerSubjectEraser` that drops the subject's grant in both directions
  (`subject` as topic, `grantedBy` as actor).
- **The class (ninth blind mechanism):** the erasure gate's matcher set bound every
  *decorated* spelling of "subject" (`subjectKey`, `subjectId`,
  `managerSubjectId`) and **not the bare field name `subject`** — the spelling this
  entire lane standardised on. The gate was blindest exactly where the app is most
  subject-aware. `SUBJECT_ID_FIELD` is widened to bind bare `subject`, and the
  census is re-derived with the file's own two-run recipe rather than quoted.

### 4. A failed read is not an empty one — on the lanes a MODEL reads

`ADR 0583` built `failedSources` and applied it one level down. The lanes where the
lie is worst were left bare:

| Lane | Before | After |
|---|---|---|
| live run dispatch (`agentDispatch.ts:613`) | `log.warn` + `chunks = []` | passes `onSourceError`; a fenced degradation line reaches the turn |
| chat/voice compose (`agentKnowledgeComposition.ts:47,93`) | bare `catch { return '' }`, **no log** | logs + reports |
| AI workflow node (`bootstrap/nodes.ts:1743-1750`) | a third silent `catch {}` | logs |
| memory read in dispatch (`agentDispatch.ts:593-597`) | swallowed into `entries = []` | the model is TOLD the read failed |

`MEM-UX-14` is the same defect one layer up from where the widget layer already
learned it: the widget has a dedicated `failed` flag, a `storedUnknown` counter and
copy reading *"This is a failed read, not an empty memory"*. Dispatch had none of
that, so **the model's reply itself was the false empty**.

`retrieveForAgent` (`WF-AKM-3`) likewise returned `status:'success'` +
`hasResults:false` + `failedSources:[]` for a non-existent agent, an absent profile
and a capability-off agent alike. Only the third is an empty corpus; the first is a
typed failure and the second is a named reason.

### 5. Subject authorization on `routes/memory.ts` (AGMEM-1)

The route took `memoryRef` straight from the query with nothing but the global
`authMiddleware`, and `subjectScope` is the totally-predictable `${kind}:${id}` —
so any authenticated tenant member could read *or delete* any person's or agent's
memory. Both sibling doors onto the same rows gate correctly. The predicate is
extracted into **one helper every caller uses**, per the "one helper, route + tool
both call it" rule, applied at the HTTP layer.

> **CORRECTED (review of this ADR).** As first shipped, this section claimed the
> helper "CALLS the same underlying primitives" as the sibling doors. **It did
> not.** The sibling agent-knowledge door calls `featureRoute.requireTenantScope`;
> `memoryRefAccess`'s `agent:` arm called `resolveEffectiveAccess(tenantId,
> { subject })`, which is a *different* function with three consequences:
>
> 1. **Wrong primitive.** `resolveEffectiveAccess({subject})` is org-scoped and
>    first-match; its own docblock (`accessControlService.ts:1228`) says it "is the
>    wrong tool" for a surface that is not org-scoped, because a subject who is
>    `viewer` in one org and `editor` in another resolves to whichever membership
>    the store returned first. Memory refs are not org-scoped.
> 2. **A fail-open arm.** The member branch is guarded by `opts.subject !== undefined`,
>    so `{ subject: undefined }` fell through to the tenant-owner branch
>    (`:1298`) and returned `OWNER_SCOPES`. The helper's docblock said "FAIL-CLOSED
>    by construction: the switch has no default-allow arm" — true of the switch,
>    **false of the predicate it delegated to.** Unreachable on today's routing,
>    but nothing asserted that.
> 3. **A gate with no exit.** MEASURED: the **wildcard operator principal** (env
>    API key / admin token / conformance harness) has no member row in any tenant,
>    so a legitimate `agent:` read returned `403 Missing required scope:
>    workspace:read` — a scope it can never obtain. 403 before, 200 after.
>
> **Fixed** by calling `requireTenantScope` — literally the sibling's call, so the
> claim in this section is now true rather than aspirational.
>
> **Scoped down from the review's own claim:** it also predicted a solo user in
> their own personal workspace would 403. **MEASURED FALSE** — a signed-in session
> resolves `basis=member` with 29 scopes, because ADR 0025 auto-provisioning gives
> a personal workspace a personal org *and* an owner membership. That case returned
> 200 under both predicates.
>
> **What still refuses, deliberately:** a tenant-scoped (non-wildcard) API-key
> principal has no member row and no personal workspace, so it 403s. That is
> `requireTenantScope`'s behaviour, shared verbatim with the sibling door. If it
> should have an exit, that is one decision in `requireTenantScope` — not a second
> opinion in this helper, which is the exact defect this section exists to close.
>
> **Coverage added:** the six original cases all asserted REFUSALS plus one demo
> 200, so a refuse-everything gate passed them all — which is how (3) shipped
> invisibly. Allow-path witnesses now live in `test/memory-endpoint.test.ts`
> (wildcard operator; discriminating) and `test/memory-ref-access-allow.test.ts`
> (a real cookie session's own `user:` read and personal-workspace `agent:` read,
> labelled ANTI-ROT, plus a cross-subject refusal).

### 6. `compactMemory` carries trust forward (AGMEM-3)

The symmetric half of §1: fixing the write path is pointless if compaction
launders it. `compactMemory` honoured SR-1 carry-forward and dropped
`MEMORY_UNTRUSTED_TAG`, so N sources of which any were untrusted collapsed into one
archive that reads trusted. The archive now carries the tag when **any** source
does. Latent today (one env-gated non-test caller) — fixed at the primitive so the
next caller inherits the right behaviour.

> **CORRECTED (review of this ADR) — the symmetric-half fix was itself
> asymmetric, and its asymmetry DESTROYED the signal it dropped.**
>
> As first shipped, `anyUntrusted` read only `r.tags.includes(MEMORY_UNTRUSTED_TAG)`.
> Every *other* read path in this ADR was taught both halves of "untrusted" — the
> tag **or** the legacy `[auto-extracted] ` content prefix (`trustOf`, the vector
> metadata projection, `projectNote`). This one was not, because
> `hasLegacyAutoExtractedPrefix` was module-private in `subjectMemory.ts` and
> `subjectMemory → inMemorySurfaces` already exists, so the reverse import is a
> cycle. The gap was **structural**, not an oversight of care — which is why the
> fix is structural too.
>
> Why it is worse than incomplete: `compactMemory` **joins** source contents. A
> pre-`0587` legacy row is fenced ONLY by that prefix — "the only signal they will
> ever have", as §2 says — so unless it happens to sort first, the archive no
> longer *starts with* the prefix **and** is written with no tag. A fenced row goes
> in and a permanently trusted row comes out, unrecoverably. Compaction is the one
> path in the tree that can do that, which is exactly why it must ask the whole
> question.
>
> **Fixed** by moving `LEGACY_AUTO_EXTRACTED_PREFIX` + `hasLegacyAutoExtractedPrefix`
> to the leaf `memoryTrust.ts` (created for precisely this cycle) beside a new
> `isUntrustedMemoryRow(tags, content)` — the whole question, asked once, by every
> caller. `subjectMemory.ts` re-exports the constant so every existing importer is
> byte-identical.

### 7. The ingest node is declared side-effecting (WF-AKM-1)

`feature.agent-knowledge.nodes.ingest` — a durable, chunked, embedded KB write
reachable from an untrusted webhook — was in **none** of `MANIFEST_SIDE_EFFECT_FLOOR`,
`MANIFEST_FAST_PATH_SERVED` or `SIDE_EFFECTING_TYPE_PATTERNS`, and no
`assertEffectAllowed` seam covered it (`EffectKind` has no memory/document kind).
Both #2871 legs were missing simultaneously, so a `:fork` in `replay` mode
re-executes it and writes a **second** document.

Fixed with **both** legs in one commit: `role:"side-effect"` in the manifest **and**
an explicit typeId entry in `executor/sideEffects.ts`, with the generated sets
regenerated. Five docblocks asserting *"`role:action` ⇒ replay/fork read the
recorded result"* are corrected in place — `git grep "role === 'action'" -- src/executor/`
returns **zero**; the executor never reads `role`, only the generator does, and it
reads `side-effect`.

## Alternatives weighed

- **Backfill the backlog by prefix.** Rejected as a *durable* change (see §2). Kept
  as a read-side projection so the gap stays visible.
- **Invert `trustOf` to fail-closed at the type level (AGMEM-8).** The structural
  cure the other defects are instances of, and the right eventual shape. Deferred:
  the assessment's own sequencing says do it *after* the known-good fixes land, so
  it hardens verified behaviour rather than refactoring under uncertainty.
- **Widen `eraseSubjectMemory` to sweep `agent:` scopes (MEM-UX-4).** Rejected on
  the ADR 0042 lesson — the obvious widening is the dangerous move, and an agent's
  operational recall is arguably the tenant's, not the subject's. The *exclusion*
  may be correct; **the silence was not**, so the fix is disclosure, not a wider
  eraser.

## Implementation record

Status: **implemented** for the items below. All commits carry the DCO trailer and
each was verified with RUN sabotage probes (not asserted ones) plus an anti-rot arm.

| § | Item | Commit |
|---|---|---|
| 1, 2 | `AGMEM-2` / `MEM-UX-3` — trust + provenance as data; the legacy read heuristic | `170da2222` |
| 1, 7 | `WF-AKM-2` (`ctx.trustBoundary`) + `WF-AKM-1` (both #2871 legs, 5 docblocks, `GEN-AKM-1` gate) | `a793568f8` |
| 3 | `AGMEM-4` instance — the `memextract:grant` eraser | `6bff02996` |
| 3 | `AGMEM-4` class — the bare-`subject` matcher, census 121→129, + the nav-settings eraser | `671e55eef` |
| 5, 6 | `AGMEM-1` route subject authz; `AGMEM-3` compaction trust carry-forward | `853cf6fc3` |
| 1, 4, 7 | `MEM-UX-1` / `-3` / `-4` / `-13` — the UI, the copy, and the two false doc claims | `73df1b6c3` |
| 4 | `WF-AKM-3`, `WF-AKM-6`, `MEM-UX-14` — failure honesty on the model-facing lanes | `e7e559b3f` |
| 4 | `AGMEM-12` — the per-user sentinel was correct and SILENT | `f38476d34` |

### Adversarial-review fold-in (PR #3400)

An independent review of the above found the security core sound (census, pack and
gate arithmetic all survived re-derivation) and **seven defects**, two of them in
the same family as the ones this ADR closes. Each fix below was verified with a
sabotage probe that was **RUN**, not asserted; where a probe did not discriminate,
that is recorded rather than glossed.

| # | Finding | Fix | Commit |
|---|---|---|---|
| F1 | The census floor shipped at `121` — byte-identical to `origin/main` — while the population is `129`, and the two stores the widening FOUND appeared in no assertion at all. **This file's own docblocks call such a floor decorative, twice measured.** Third time. | Floor → 129; named tripwires for `memextract:grant` + `navigation-settings:config`. **Probe:** with `subject\|` deleted, the shipped gate's ONLY red was an incidental staleness check; all three assertions now redden. | `c98ff15e6` |
| F2 | §6's fix read the tag only, so compaction could **destroy** the legacy prefix — the only fence a pre-`0587` row has. See the correction note in §6. | `isUntrustedMemoryRow` in the leaf `memoryTrust.ts`; both halves, one predicate. | `c24c50248` |
| F3 | §5's "one helper" called a *different* primitive; fail-open arm; a gate with no exit; **no test asserted any ALLOW**. See the correction note in §5. | `requireTenantScope` (the sibling's own call) + allow-path witnesses in two harnesses. | `afd38a9b0` |
| F4 | User-visible **mojibake** in the `MEM-UX-13` honesty copy, `en` + `es`. No gate could see it: key-parity finds missing keys, not garbled values. Enumerating the CLASS found a **third**, pre-existing, in `chat/i18n/es.ts`. | All three repaired; `check-i18n.mjs` gains a fatal **decode test** (re-encode each Latin-1 run, decode as strict UTF-8, flag when it succeeds AND differs) — not a character-class heuristic, which false-positives on real prose. | `830672b7b` |
| F5 | `MEM-UX-1` changed both routes to return `{notes, recallOnlyCount}` **in this same batch**, then both clients discarded it and re-fetched the identical URL. Doubles the request count and lets the disclosed count describe a different read than the list on screen. | One request; the count rides the `list` callback, so it also stays correct across `refresh()` — which the mount-once effect never did. | `c91d2ccc0` |
| F6 | The widening's one classification flip (`email:template`) is a **false positive** — `EmailTemplate.subject` is a mail header, not a person — and the docblock said only that it was ledger-neutral. | Docblock now states precision **7/9, not 8/9** (2 of 9 signal changes match a non-person `subject`), and names the standing risk. | `c98ff15e6` |
| F7 | The `AGMEM-12` warn is per-**retrieve** and unbounded, burying the signal it adds. | Once per profile per process, bounded at 1000 with clear-at-cap. | `1c1fdc1ab` |

**Two review claims were tested rather than accepted, and one did not survive:**

- **`AGMEM-2` backlog wording — review CORRECT, ADR §2 amended.** A second,
  negative discriminator does exist. See the correction note in §2.
- **F3's solo-personal-workspace prediction — MEASURED FALSE.** A signed-in session
  resolves `basis=member` with 29 scopes, so that case returned 200 under both
  predicates; only the wildcard-operator principal was broken. Recorded in §5 and
  in the test file, which labels its personal-workspace case ANTI-ROT rather than
  claiming it witnesses the fix. (My own first probe read "zero member rows" — that
  was **my** error: `listMembers(tenantId, orgId)` is org-scoped and I passed one
  argument. The route-level probe is the authority.)

### Deliberately NOT done, with reasons

- **`MEM-UX-1` full projection.** Turn summaries are DISCLOSED (a count) but not
  listed as first-class deletable rows. A delete affordance for them would have to
  reach the recency tier and the vector tier while there is no durable row to
  delete — a partial delete that LOOKS complete is worse than an honest gap, and
  `AGMEM-5` (the generic DELETE already desyncs those tiers) has to land first.
- **A durable backfill of the `AGMEM-2` backlog.** See §2. A *positive* backfill —
  one that marks rows as auto-extracted — would rest on the English prefix and would
  produce a RECORD of completeness it cannot deliver. **This decision is unchanged
  by the review**, but its scope is now stated accurately: a **negative** migration
  over the no-grant population *is* available to a future change (absence of a
  grant row proves the subject never enabled extraction ⇒ that scope is provably
  user-authored), and it is deferred rather than impossible. It would mark no row
  as auto-extracted and could offer no date boundary, so it does not close
  `AGMEM-2`; it only bounds it honestly.
- **`AGMEM-8`** — inverting `trustOf` to an explicit fail-closed field. The
  structural cure the other defects are instances of, and the assessment's own
  sequencing says do it after the known-good fixes, not under uncertainty.
- **`MEM-UX-12`** — the localized failure strings are unreachable because the
  clients throw `Error` and every catch prefers `e.message`. NOT fixed, because
  `agentKnowledgeClient.asJson` surfaces the SERVER's `message` when present, so
  `e.message` is sometimes real prose and sometimes an opaque developer string.
  Blindly preferring the localized string would DROP genuine server prose; blindly
  keeping `e.message` is the current defect. The correct fix is a typed client
  error carrying a `userFacing` flag, across all three clients — a shared-client
  change with a blast radius beyond this feature. A heuristic here would be exactly
  the "partial fix inverts a safety property" trap.
- **`WF-AKM-4/5/7/8/9/10/12/13/14`, `AGMEM-5/6/7/9/10/11`, `MEM-UX-2/5..11/15..20`,
  `GEN-AKM-2/3/4`** — out of this batch's scope; unchanged in the assessments.

## Open questions

- `AGMEM-8` (invert `trustOf` to an explicit row-level field defaulting
  unknown ⇒ untrusted) remains open and is the structural cure.
- `AGMEM-9` — `subject-memory:note` is registered fully `ERASED` while its eraser
  forms only the `user:` scope. Either widen or downgrade the registry entry to a
  stated `PARTIAL_COVERAGE`; §4's disclosure is the interim honesty fix.
- `AGMEM-10` — no retention/TTL on this feature's writes; a person's memory is
  indefinite by default. The host honestly does not advertise the `retention`
  dimension, so this is a product gap, not a wire lie.
