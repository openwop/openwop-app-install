# ADR 0603 — podcasts: a destructive mix, a corpus-wide fail-open, and two blind gates

Status: implemented

Follows the feature-31 (Podcasts) assessment (`8073d5396`, C+/C+/C+). Closes
`PODC-1`, `PODC-2`, `PODC-3`, `PODWF-1`, `PODU-1`, `PODU-2`, `PODU-3`, `PODU-4`,
`PODU-8`, `PODC-13`, and the `POD-01` manual-test defect. Ports ADR 0602's poller
in its **corrected** form. Does **not** close `PODWF-2` (see §8).

## Context

Feature 31 is two features welded together: the ADR 0390 public *distribution*
lane, graded **B+** and holding, and the ADR 0086 *generation* pipeline
underneath it — ungraded, and exercised by **no test in the repo**. `DEBT-POD-1`
names that as the enabling cause, and it is: 373 LOC across
`packs/feature.podcasts.nodes/index.mjs` and `buildPodcastsSurface` that nothing
imported. Both Blockers lived there.

One item, `PODWF-1`, turned out not to be a podcasts defect at all.

---

## 1. `PODC-1` — the `mix` node silently ERASED an episode's recorded clips

### The defect

`mix` called `recordEpisodeResult({ episodeId, clips })` **unconditionally**, and
`clips` is `[]` whenever `synthesize` produced nothing. Reachable two ways:
`POST /episodes/:id/retry` after a degraded transcript, and a deleted cast
profile (every turn skipped at `if (!voiceId) continue`).

`recordEpisodeResult` merged with `...(patch.clips ? { clips: patch.clips } : {})`.
`[]` is **truthy**, so the empty array **overwrote** the stored list — under a
docblock two lines above reading *"Merges (never clears)"*. The mux gate below is
`clips.length > 0`, so `audioMediaRef` was left pointing at the **previous**
audio: a published show serving old audio under a Studio episode showing nothing.

### Why it survived review

Every *other* field in that same spread rides `surfaceOptStr`, which is falsy for
`''` — so `outlineDocRef`, `transcriptDocRef`, `audioMediaRef` and `error` are all
correctly **dropped**. Only `clips` takes the raw-array path, where the
identical-looking `x ? {x} : {}` idiom silently inverts. A guard right four times
and wrong once, inside one expression list.

### Decision — length-gate, do not thread a clear

The write is gated on `patch.clips.length > 0`, and the docblock now states the
semantics it actually has: an empty `clips` array is a **no-op**, exactly as `''`
is for the strings.

**Rejected: an explicit `clearClips` escape hatch.** Nothing clears clips today —
`retry` re-enqueues without resetting and `mix` is the only writer — so it would
be dead code, and a dead escape hatch is how the next caller gets it wrong. The
docblock instead tells a future caller what to do: add an **explicit** field and
say so at the call site; never ride on `[]`, which is indistinguishable from
"this node produced nothing".

Both ends move. The **service** guard is load-bearing (it holds for every caller,
including the surface's per-clip validation reducing a *non-empty* input to `[]`,
which the node cannot see). The **node** no longer sends a write it has nothing to
say with — and, after §3, returns a typed failure instead.

> **CORRECTED 2026-08-23 (R1 `M2`) — the guard was right and its REPORT was a
> lie, so this fix closed a destructive write by opening a success-with-empty one
> layer up.** `recordEpisodeResult` returned `{ recorded: true }` for a write it
> had just decided to drop. The sentence directly above is the proof that the
> case was *known*: the per-clip validation reducing a non-empty input to `[]` is
> named here as the reason the service guard is load-bearing — and in exactly
> that case the caller was told it had succeeded. `mix` believed it and carried
> on to mux its own unvalidated list and write a **new** `audioMediaRef`: old
> clips beside new audio, this section's inconsistency in reverse, returned as
> `status:'success'` with a `clipCount` for clips that were never stored.
>
> The result now says what happened — `found` and `recorded` are separate facts,
> `applied`/`dropped` name the fields, `clipsRecorded` is the length actually
> STORED, guard and report derive from one table so they cannot drift, and a
> fully-dropped patch no longer bumps `updatedAt`. `mix` refuses on
> `stored !== clips.length`, which covers the PARTIAL case too (a mux must match
> what is stored), with a new typed `podcast_mix_clips_rejected`.
>
> **A test in this ADR's own witness had PINNED the defect** — *"malformed clips …
> also never clear"* asserted `status:'success'` for precisely this case. Writing
> down what the code does is not the same as writing down what it should do.

### 1.2 The class census — MEASURED, not grepped

The question is: `...(X ? { k } : {})` spread guards over **array-valued** `X`,
where `[]` is truthy and the idiom inverts. Walked with the TypeScript checker
(a regex cannot answer "is this expression array-typed"):

| Population | Count |
|---|---:|
| array-typed `...(X ? {k} : {})` spread guards, backend `src` + `test` | **101** (95 in `src`) |
| the same, frontend | **1** |
| of those, merging onto a spread BASE object (`{ ...base, ...(x ? {x}:{}) }`) | **12** |
| plus the other spelling, `{ ...base, k: X ?? [] }` / `|| []` / `cond ? X : []` | **5** |
| **DESTRUCTIVE** — an empty array overwrites a *different* object's value | **1** |

The one is `podcastsService.ts:349`. The other 16 merge-onto-base sites are
same-object normalisations or transforms where `[]` overwrites `[]`
(`app-builder/export/generators.ts`, `cdp/identityService.ts`,
`kicktodo-*`, `approvalService.ts` ×3), or projections onto a base that never
carries the field (`messaging/types.ts` ×3 — `applyEgressExtra`'s `base` is a row
projection with no `media`/`components`/`reactions`; `voiceClient.ts` — `degraded`
is a *sibling* of `data.realtime`, never inside it).

**The boundary, stated so the next reader can widen it deliberately:** this walk
covers the *idiom named in the finding* plus the `?? []` spelling. It does **not**
cover an unconditional `next.k = patch.k` merge, which is a different and much
larger shape. Filed as a floor, not a ceiling.

> **CORRECTED 2026-08-23 (R1 `H1`) — the stated exclusion was hiding TWO LIVE
> DESTRUCTIVE INSTANCES, in a family this repo had already fixed once.** Writing
> "a floor, not a ceiling" is not the same as knowing what is under the floor, and
> the honest thing would have been to *look* before deciding the shape was too
> large. Inside the exclusion:
>
> - `features/agent-knowledge/service.ts` — `getAgentKnowledge` **writes**
>   `setAgentKnowledge(…, { collectionIds: liveIds })` whenever fewer bound ids
>   resolved than are bound, landing through `agentProfileService`'s whole-patch
>   spread. `liveIds` can be `[]`.
> - `features/projects/projectKnowledgeService.ts` — the same, landing through
>   `subjectKnowledge`'s `collectionIds: patch.collectionIds ?? existing`. **This
>   binding is what backs a NOTEBOOK's bound KB collections**
>   (`notebooksService.ts`), so the blast radius was a notebook silently losing
>   its sources on a read.
>
> Both rest on the inference "not in the tenant listing ⇒ deleted", and that is
> not safe: `listAllTenantCollections` reads a tenant SECONDARY INDEX whose own
> contract admits *"the row is simply not enumerated this pass"*, and
> `listByPrefix` under it **skips any row whose decode fails without throwing**.
> One corrupt or schema-drifted index row overwrites the whole binding with `[]`
> and returns **200 with an empty knowledge panel** — a durable erasure on a GET.
>
> The already-hardened sibling was two files away the whole time:
> `profile-memory/profileKnowledgeService.ts` carries `authoritative` +
> `listingLooksWiped` guards under a comment naming this exact harm
> (`TWIN-UX-10`, ADR 0589). Fixed by moving that rule to
> **`host/knowledgeBindingPrune.ts`** and folding all three features onto it,
> rather than leaving a third hand-written copy.
>
> Two prescriptions were falsified before applying. A **tenancy widening** is not
> just the wrong cure but an actively dangerous one — the ADR 0042 ruling records
> that widening the candidate set of exactly this self-heal turns it into a
> data-loss machine, because *"not visible from here"* is indistinguishable from
> *"gone"*. A **length gate at the write layer** would break `unbindCollection`,
> which legitimately writes `[]` when the last collection is removed — trading a
> destructive write for a silent no-op, i.e. the success-with-empty family one
> layer up. The guard's own limit is stated in its docblock: it cannot catch a
> PARTIAL short listing, because distinguishing that from genuine deletions needs
> a per-id lookup the binding has no `orgId` for.

**Witness** `test/podcasts-generation-pipeline.test.ts` — the first test in the
repo to import the pack or `buildPodcastsSurface`. Sabotage (both guards
reverted): 3 red, `expected [] to have a length of 2`. Sabotage (node guard
only): 1 red — an `updatedAt`-unchanged assertion added *specifically* so the
node-side guard cannot be reverted behind the service guard's back, since without
it every other assertion would still pass.

---

## 2. `PODWF-1` — a corpus-wide FAIL-OPEN drop of every `configurable` parameter

### The defect

`buildChainBackedDefinition` restores the bare launch-contract param names onto
`def.variables[]` and every node input (un-prefixing the deferred materialisation)
and **never updated `metadata.deferredParameterAliases`** — the RFC 0124 G1 map
that `deferredConfigurableInputs` translates a run's `configurable` overlay
*through*. So the overlay was written under a variable name no declaration
carried, and `seedRunVariables` dropped it.

**Fail-OPEN, which is why it stayed invisible.** `configurableSchema` is keyed by
the BARE name, so validation passes and no 400 fires; the run **starts**; every
node reads `undefined`; the failure surfaces deep inside a node with an error that
never names the parameter.

### Blast radius — re-measured, not restated

A `tsx` build-time probe (`OPENWOP_MOUNT_LOCAL_PACKS=false`, no backend boot):

| Lane | Before | After |
|---|---:|---:|
| chains loaded | 179 | 179 |
| chains that expand deferred **with params** | 138 | 138 |
| of those, alias→variable broken straight out of `expandChain` | **0** | 0 |
| of those, alias→variable broken after `buildChainBackedDefinition` | **138** | **0** |
| ADR 0472 `MIGRATED` chainIds carrying a non-empty alias map | 34 / 39 | 34 / 39 |

Both figures match the assessment exactly. The loader was always honest; this one
lane broke every chain that passed through it. Executed end-to-end:
`podcasts.generate` + `configurable:{episodeId:'ep_A'}` seeded `{}` before and
`{episodeId:'ep_A'}` after.

### Decision — MERGE the moved values, never replace the map

The obvious cure ten lines away (`def.metadata = {...src.metadata}`, copied from
`registerMcpProjectionWorkflows`) would **delete** the alias map — one silent
no-op traded for another. Instead the rename loop records what it **moved**
(materialised → bare) and only those alias *values* are rewritten. An entry whose
variable was not renamed is left exactly as it was, so RFC 0133 §2 produced
variables (used verbatim, never prefixed) are untouched.

### 2.2 The second lane — and it is the same family

`registerMcpProjectionWorkflows` (`features/index.ts:295`) did that very REPLACE.
Left alone, the fix above is **structurally unreachable** for those 19 workflows.
MEASURED: the replace strips a non-empty alias map from **3 of the 4** sampled
projections, plus `chainId`, `expansionMode` (read at
`host/seedWorkflows.ts:196,283`), `expandedFrom` and `mintedPromptTemplates`.

Now a merge — and **additive, not a behaviour change**: the source's metadata here
is `{kind, feature, mcpTool, mcpFeatureToggle, mcpRequiresAuth, mcpSafetyTier,
mcpApproval}`, which collides with **no** chain-derived key, so every ADR 0087
gate is byte-identical to before. Enumerated: `grep '\.metadata = '` over
`backend/typescript/src` finds this as the **only** workflow-definition metadata
REPLACE in a chain-backed post-processor; every other site already merges.

> **SETTLED 2026-08-23 (R1 `M4`) — recorded so the next reader inherits the
> RESULT and not the suspicion.** This section framed the deleted alias map as a
> live hazard on the MCP lane. It was **never live for the deferred-param path**:
> `host/mcpSemantics.ts` builds the run with a hardcoded `configurable: {}` and
> seeds `seedRunVariables(runId, wf.definition.variables, inputs)` from the raw
> inbound `arguments`; `deferredConfigurableInputs` is called **nowhere** in the
> MCP lane, and `grep configurable` over `routes/mcp.ts` + `routes/mcpInvokeSeam.ts`
> returns **zero hits**. An MCP-mounted workflow has no `configurable` overlay to
> translate, so a stale `deferredParameterAliases` had nothing to break there.
>
> The fix nonetheless **stays load-bearing**, for the other four keys, and those
> WERE live: `expansionMode` is the migration-14 skip predicate
> (`host/seedWorkflows.ts`) and `chainId` is read by
> `features/assistant/chainBackedShape.ts`. So §2.2 was right about the class and
> **overstated the alias half**. Corrected rather than deleted, because the
> measurement (3 of 4 sampled projections lost a non-empty map) is real and the
> next person to widen the MCP lane to accept `configurable` re-opens the hazard
> this merge already closes.

### 2.3 The latent security consequence

The stale alias made the RFC 0124 sensitive-param guard
(`routes/runs.ts:315-338`) structurally unable to match: it iterates
`deferredParameterAliases` and tests membership against `sensitiveVarNames`, which
holds the *declared* (renamed) names. It now **can** match. It remains **latent**
because the corpus has **zero** `x-openwop-sensitive` params today, so nothing
changes behaviourally — recorded here so the next person to add one does not have
to rediscover why it works.

**Witness** `test/chain-backed-deferred-param-aliases.test.ts` — 7 tests that
**execute** the drop (real `deferredConfigurableInputs` → `seedRunVariables` → bag
snapshot), not merely inspect the metadata object. Non-vacuity floors are sized to
the measurement (`built >= 170`, `withAliases >= 130`, `checked >= 130`): a bare
`> 0` floor would have passed with the fix reverted, since chains and alias maps
both still exist. Sabotage (alias rewrite deleted): 6/7 red, including
`expected [ …(138) ] to deeply equal []`. Sabotage (MCP merge → replace): **1**
red, the single assertion covering that lane and nothing else.

**Determinism preserved** (the assessment's "do not break"): `podcasts.generate`
still builds byte-identical across two builds, `expansionId = 02c19ee80741` —
the exact value the workflows grader recorded. Re-checked for four other chains.

---

## 3. `PODC-2` + `PODC-3` — six success-with-empty returns, and a dead error channel

Six sites returned `status:'success'` with an empty payload, so a wholly broken
generation finished as `done`: `projectStatus(completed)` says `'done'`, no
transcript Document, no audio, and nothing anywhere says why. That is the
CLAUDE.md non-negotiable violated six times in 262 lines.

Now typed, with codes an operator can act on:
`podcast_episode_not_found` (4 nodes), `podcast_outline_empty`,
`podcast_transcript_unusable`, `podcast_no_cast_voice`,
`podcast_synthesis_returned_no_audio`, `podcast_mix_no_clips`.

**One bounded error-FED repair** on each of the two model-calling nodes — exactly
one, and fed the specific error rather than a blind re-ask. `parseTurns` returned
a bare `[]` for four distinct causes, which is *why* the failure was unreportable;
it now returns `{ turns, reason }` and the reason is what both the repair prompt
and the durable `error` field carry.

> **CORRECTED 2026-08-23 (R1 `H2`) — the repair itself could not reach the wire,
> so on the outline path the typed failure this section advertises was
> unreachable.** Both repairs prepended `{ role: 'assistant', content: '' }` to
> echo the failed turn. It reaches the provider unfiltered (`aiProvidersHost`
> copies `content` verbatim; `providers/dispatch` passes the string through) and
> `providerForModel` defaults to **anthropic**, which rejects a non-final message
> with empty content. On the outline path the repair fires *precisely because*
> the model returned nothing, so `''` is the only value that case can ever have:
> instead of `podcast_outline_empty` with `episode.error` written, `askOutline`
> threw an `AiProviderError`, **`failEpisode` never ran**, nothing reached
> `episode.error`, and the operator saw a raw provider error that never named the
> cause. The whole §3/§3.2 chain — typed failure → durable `error` → the Studio's
> render — was broken at its first link, for the one input that reaches it.
>
> **The mocked `ctx.callAI` could not see this, and that is the lesson**: a
> message shape only a real provider rejects is invisible to every test that
> stands in for the provider. Corroborated statically instead —
> `grep "role: 'assistant'" packs/*/index.mjs` shows podcasts was the **only**
> pack hard-coding `content: ''`; every other repair loop echoes real prior
> output. The assistant turn is dropped entirely (the corrective USER message
> already carries the whole signal), and the assertion gates on the **shape**, not
> on the provider, because the 400 is SUSPECT — reasoned from the API contract,
> not verified against a live endpoint. What would settle it: one live call with
> an empty non-final assistant message.

### 3.1 The speaker match

`parseTurns` filtered turns with an exact `Set.has(t.speaker)` against the cast
names, so a perfectly valid transcript writing `"Host:"` — or `"host"`, or
`" Host"` — matched nothing and **every** turn was dropped, yielding zero turns
and a `done` run with no audio.

The comparison is now normalised (trim, strip a trailing colon, casefold) and the
**canonical cast spelling** is what gets stored. **Deliberately not fuzzy:** fuzzy
matching is a different and worse defect — it would voice a turn as the wrong cast
member and be nearly invisible. `Hosta` still fails, loudly, naming both what the
model said and what the cast is.

`synthesize`'s voice lookup was moved onto the **same** normalisation. Leaving it
on exact match would have made the cast FILTER and the cast LOOKUP disagree, and
the disagreement falls through to `fallbackVoice` — the first speaker's voice.
That is the family this fix closes, reintroduced one function over.

### 3.2 `PODC-3` — and the half that would have re-committed the family

The episode `error` field was declared, accepted by the surface, stored by the
service, typed on the wire client, and **rendered by the Studio**
(`PodcastStudioPage.tsx:491`) — and written by **nothing**. The path was dead only
at the write end. Every typed failure now writes it, best-effort and never masking
the failure.

The other half: an `error` left over from the previous run would render next to a
freshly-queued episode. Cleared explicitly at `enqueueGeneration` (shared by
create + retry) via a new named `clearEpisodeError`, and the 202 response no
longer echoes the value it just cleared. **Explicit and named on purpose**:
`recordEpisodeResult` merges and never clears, because `''` is falsy there and an
empty string is indistinguishable from "this node had nothing to say" — the exact
confusion that made §1 destructive. A clear must be something a caller **asks
for**.

**Witness** 11 further tests in the same file (17 total). Sabotages: exact speaker
match restored → 1 red (`Host:: expected 'failed' to be 'success'`); the `error`
write removed → 4 red, the PODC-3 assertions and only those; the outline repair
removed + mix back to success-with-empty → 5 red, including *"exactly ONE bounded
repair — not zero, not a loop: expected 1 to be 2"*. A non-vacuity guard rides
with the synthesize rule: **zero turns must NOT be a synthesize failure**, so the
node cannot pass by inventing a failure for a case it cannot diagnose.

Pack legs move together: `pack.json` 1.0.1 → 1.0.2 → 1.0.3, all five node type
versions 1.0.0 → 1.1.0 (their return contract changed), the model-facing node
DESCRIPTIONS now name the failure codes and the repair (catalog↔behaviour parity),
the `requiredPacks` pin in `features/podcasts/feature.ts`, and
`packs/.steward-manifest.json` (`gen-steward-manifest --check` exit 0).

---

## 4. `PODU-1` — public audio finally has a transcript (WCAG 2.1 SC 1.2.1, Level A)

The public episode page shipped a bare `<audio>`. The gap was deferred **twice**
on the premise that no transcript existed. It does, and the code said so in two
places: `feature.podcasts.nodes.transcript` writes an ADR 0053 Document and
records `transcriptDocRef`, and `publicRoutes.ts:275-279` states *"the data exists
for generated episodes"*.

What that R2 SP-8 comment correctly refused was leaking the internal
`transcriptDocRef` id onto the public wire — a public consumer cannot fetch an
authed document, so the ref bought nothing. This ships the projection **SP-8
itself named** as the fix: the CONTENT, resolved server-side, bounded at 200 KB.
SP-8's rule is unchanged and now test-pinned.

- `getPublicEpisodeTranscript` reads through `documentsService.listVersions`,
  which filters tenant **and** org, so a mis-referenced doc from another org
  cannot be projected.
- On the **single-episode** route only. Not the show/index reads: those list up to
  20 episodes and a transcript is unbounded model prose.
- On the **prerender** too. That document is what a bot, a reader-mode client and
  any no-JS visitor receive — exactly the consumers least able to play audio, so a
  text alternative living only in the React tree would be missing for the people
  it exists for. Escaped; a `<script>` payload is pinned inert.
- In the SPA: a labelled `<section>` with an `<h2>` (reachable by heading
  navigation, not just by sight); the scroll container is `tabIndex={0}` +
  `role="region"` with a name, because a scrollable region that cannot be focused
  fails SC 2.1.1 — a fresh a11y defect inside the a11y fix.
- Copy in all four locales.

### What REMAINS — stated, not left to be rediscovered

An episode with no `transcriptDocRef` still has **no** text alternative. An
INGESTED episode (ADR 0562) legitimately has none, and an episode generated before
this change has none either. That absence is now **said** — *"No transcript is
available for this episode."* — in the SPA and in the prerender, rather than being
invisible. Making a transcript unconditional would mean transcribing arbitrary
uploaded audio, which is a separate capability, not a rendering change. **This
closes SC 1.2.1 for generated episodes and makes the remaining gap legible; it
does not close it for ingested ones.**

**Cross-feature edge.** `podcasts → documents` (static import) takes the
undeclared-edge ratchet 95 → 96, raised with its reason per that file's own
instruction. Copying the transcript into the podcasts store to keep the read
in-feature is the parallel-store defect. Left UNDECLARED because `dependsOn` is a
disable-LOCK; the off case degrades in both directions and is pinned by test.

> **CORRECTED 2026-08-23 (R1 `M1`) — "degrades in both directions" was false in
> both halves, and the dependency decision was resting on behaviour the code did
> not have.**
>
> 1. The ratchet comment claimed `writeDocument` "already returns `''`" with
>    documents off. It returned `''` only when the surface is **ABSENT**. A
>    disabled toggle does not remove the method — `host/featureSurfaces.ts`
>    **wraps** it and throws `host_capability_disabled` per call — so the awaited
>    call REJECTED, the node threw, and `failEpisode` never ran. The cited test
>    pinned the *missing-ref* case, not the documents-OFF case, which was
>    **unpinned entirely**. The node now catches exactly that code and returns
>    `''`, which is what the comment always claimed. Scoped deliberately:
>    swallowing every error would turn a storage outage into a silent "this
>    episode has no transcript" — the family §3 exists to close, one layer down.
> 2. "an episode whose ref was recorded while documents was ON still resolves,
>    because the service layer has no toggle gate" was **true and was a defect**,
>    not a degradation. A tenant that disabled `documents` still had its document
>    content served on an **UNAUTHENTICATED, `public`-cached route**, bypassing
>    the gate whose stated purpose is that a feature's data is not read for a
>    tenant that disabled it. `getPublicEpisodeTranscript` now resolves the
>    `documents` toggle itself (the `features/strategy/routes.ts` precedent) and
>    returns `null`, so the page states the same honest absence direction (1)
>    produces. Deliberately not a distinct public state: telling an anonymous
>    visitor which internal features their host disabled is a config leak.
>
> The UNDECLARED conclusion is **unchanged and still correct** — a disable-lock is
> the wrong instrument for a soft, degrading read, and this is not a
> raise-the-baseline-instead-of-fixing move — but it now rests on measured
> behaviour, and both directions are pinned by test.
>
> **`L5` lands in the same projection.** `transcriptDocRef` is a plain id on a
> mutable episode row; tenant and org were re-checked and the document **KIND**
> was not, so a mis-set or hand-edited ref could project any document in the same
> tenant+org — a briefing, a decision record — onto that same public 300s-cached
> page. Both checks live at the ONE composition owner (the JSON route and the
> prerender both call it), not at each caller.
>
> **`L6` — three a11y nits inside this a11y fix.** The `<h2>` id was a
> document-global literal (two panels on one document would collide); the scroll
> container repeated the section's own accessible name, so a screen reader met two
> nested regions both called "Transcript"; and `tabIndex={0}` was unconditional,
> adding a tab stop that announces a region with nothing behind it whenever the
> transcript does not overflow. Each is fixed on mechanism (`useId`, a distinct
> name in four locales, a measured-and-re-measured overflow), not by deleting the
> attribute. The prerender was checked for the same three and is clean.

---

## 5. `PODU-2`/`-3`/`-4`/`-8` — the notebooks fixes that never transferred

`PODU-2` is `NBU-2`'s exact shape: a failure card above a skeleton that spun
forever (`shows` stayed `null` on the catch), `error` never cleared, no retry.
Fixed with the suppression that must ride alongside: stopping the hang by
rendering "No shows yet" over an unread list trades a hang for a **lie**.

> **CORRECTED 2026-08-23 (R1 `C1`, MERGE BLOCKER) — the bound was UNREACHABLE in
> production, and its witness could not see that.** `attempts` was an
> effect-LOCAL while `episodes` sat in the effect's dependency array, so every
> **successful** tick's `setEpisodes(freshArray)` changed the deps, ran cleanup,
> cleared the interval, and restarted the effect with `attempts = 0`. The counter
> could never exceed 1 while the server answered — so the give-up card was
> reachable only after ~60 **consecutive read failures**, never for the stalled or
> `awaiting-approval` generation the whole bound exists for. `PODU-3` was not
> closed; the copy stating "about 180 seconds" was describing a budget that could
> not be spent.
>
> The effect now depends on the identity of the **cohort** (a sorted join of the
> pending episode ids) rather than the identity of the array. A tick that changes
> only an `updatedAt` does not restart the budget; a genuinely new pending cohort
> does, deliberately. Falsified before applying: nothing inside the tick reads
> `episodes` — it calls a setter — so dropping it closes over nothing stale.
>
> **The transferable lesson is the witness, not the effect.**
> `mockResolvedValue([EPISODE()])` returns the SAME array instance on every call,
> so `Object.is` held, React bailed out of the re-render, the interval survived
> and the counter accumulated. The test was entirely non-vacuous — it drove 61
> ticks and asserted the card, the copy, the register and the cap — and it still
> **measured a condition production never has**, because `fetch(...).json()`
> allocates a fresh object per response. Switching to `mockImplementation` alone,
> with the old code, turns **5 of 12 red**. A mock must model the real object
> IDENTITY of what it stands in for, not just its shape.
>
> Class enumerated, and it is **one**: the only other bounded poller in the SPA
> (`NotebooksPage.pollUntilLanded`) holds its counter in the closure of a
> `setTimeout` chain created by a `useCallback`, which no re-render re-creates;
> `chat/conversationTransport.ts` is a plain async function.

`PODU-3`/`-4` are `NBU-6`'s shape and worse — `.catch(() => undefined)`, no bound
at all, `runId` on the type and rendered nowhere, `awaiting-approval` polling
forever with Delete as its only action. Ported from ADR 0602 in its **corrected**
form, whose own review found the first cut had re-committed the inversion it
existed to remove: bounded and the bound states itself; the give-up is not a
failure claim; it clears only on **evidence**, and evidence is the exact episode
**IDs** (`M2`), not a count; an **errored** recheck is never rendered as "still
working" (`M1`); the recheck outcome is announced directly (`M9`); the card clears
on any arrival route (`M3a`); `runId` links `/runs/:id` (`H4`).

`PODU-8` — **and its own test had pinned it.** `listNotebooksForPodcasts` mapped
404 (the notebooks *feature* switched off) onto the same bare `[]` as "you have
none yet", and `notebooksReadHonesty.test.ts:14-16` asserted exactly that. So a
user whose administrator disabled notebooks was told to "create a research
notebook first" — an instruction with no surface to perform it on. Now
`{ notebooks, featureUnavailable }`, two cards. **Not a throw:** a switched-off
feature is not a failed read either, and routing it into the failed-read card
would be the same conflation one step over.

**Witness** `__tests__/podcastsFailureRecovery.test.tsx` — 12 tests, each
state-changing assertion paired with a **control** that would fail if the copy
were deleted rather than conditioned. Sabotages: the `M1` catch collapsed into the
"still working" branch → 1 red, exactly that assertion; the cap + the run link
removed → 6 red.

---

## 6. `PODC-13` — "route withdrawn, nav strings retained", and the class is 5

`4dc9091a9` deleted `notebooksLabel`/`notebooksHint` and left
`podcastsLabel`/`podcastsHint` **two lines away**, both orphaned by ONE sentence in
`features/registry.ts` withdrawing both routes.

Enumerated over `nav.ts`'s own Label+Hint **destination** pairs (86 of 197 keys),
checked against every reference in `src`. The class is **five**, not one:
`mission`, `opsWebhooks`, `evals`, `modelRouter`, `podcasts` — `evals` and
`model-router` say so in their own route files (*"NO standalone nav entry:
permanently subsumed by the Models console"*). **5 pairs × 4 locales = 40 strings
deleted.** MEASURED that no nav key is ever assembled dynamically, which is what
makes the quoted-token scan sound here.

---

## 7. The instruments

**`check-failure-card-recovery.mjs` — NEW.** All eight read-only UX gates exited 0
on the assessment pass and none could see any Blocker. `PODU-2`'s card **did**
pass `announce`, so `check-failure-card-announce` was satisfied by its own
criterion, correctly — and no gate anywhere asked whether a failure card offers
**recovery**. MEASURED at **48 of 170** failure cards (701 StateCards); a debt
figure that already includes the `PODU-2` fix, so it cannot be satisfied by
re-breaking it. PROVED: deleting the retry → `✗ 49 … (baseline 48)`, exit 1;
restored → exit 0. Two vacuity guards (a walk-size floor and a
`failureCards < 100` criterion floor), and an **empty** allowlist — the obvious
candidate already had a Retry button, so listing it would have been a decorative
exception.

The element parser + failure criterion moved to a shared `failureCardScan.mjs`
rather than being hand-copied. It matters **doubly** for the recovery gate: the
naive `<`/`>` scan truncates at the first arrow function, which is precisely where
`action` lives — a copied-but-simplified parser would have reported every card as
a dead end.

> **CORRECTED 2026-08-23 (R1 `L1`/`L2`/`L3`) — three ways these new instruments
> could report clean while blind. None was live; all three are the shape this ADR
> is named after, inside the instruments built to catch it.**
>
> - **`L1`** — the recovery criterion was `/\baction=/`, a test for the PROP, not
>   for a recovery. `action={undefined}`, `action={null}` and
>   `action={cond && <Button …/>}` all satisfied it while rendering nothing, and
>   the last is the shape a contributor reaches for *because* it looks
>   conditional. A gate a dead end can satisfy by NAMING the escape hatch
>   certifies the defect. `hasRecoveryAction` now slices the action's expression
>   container by brace depth and requires something actuatable inside it. The
>   baseline is honest under the stricter rule because it was **re-measured** with
>   it: still 48 of 170, so the tightening moves no number.
> - **`L3`** — `elements()`'s quote tracking treats `'` as a delimiter inside JSX
>   TEXT CHILDREN, so `action={<Button>Don't stop</Button>}` opens a string that
>   never closes and the slice runs to EOF, swallowing a LATER card's `action=`.
>   That is a **silent false negative** in the recovery gate, i.e. the exact
>   direction the parser docblock spends three paragraphs guarding against, one
>   case over. Parsing it properly needs a real parse; **bounding it does not** —
>   a slice that reaches EOF now throws a named desync instead of returning a
>   confident answer. Measured: 702 elements, 0 runaways.
> - **`L2`** — `check-nav-destination-orphans` did not strip comments, while its
>   sibling in the same directory exports `stripComments` for exactly that reason
>   and this repo carries a standing lesson that ratchet gates count comments.
>   Since the scan is a quoted-token search, a key merely MENTIONED in a comment
>   reads as a live reference — and the comment that explains a withdrawal is
>   exactly the comment that names the withdrawn key, so the false negative aims
>   at the class the gate exists for. Reused, not re-written.

**`check-nav-destination-orphans.mjs` — NEW, fatal at zero.** `check-i18n` prints
these BY NAME and still exits 0 (orphans are `console.warn` and never set
`failed`) — which is how the class survived two sweeps: **a warning that names
your defect and passes is indistinguishable from one that doesn't.** PROVED:
re-adding the podcasts pair → exit 1 naming it.

**The manual suite.** `POD-01` was **unfalsifiable**: *"produced and playable (or
an honest not-configured state)"* passes whether the generate path works perfectly
or is wholly broken, because every possible outcome satisfies one of the two
disjuncts. And the feature is toggle-OFF with no enable-first case. Replaced with
five cases, several stating what a FAIL looks like: `POD-00` (enable-first,
blocker), `POD-01` (four separately-checkable stages), `POD-02` (a run that cannot
succeed must fail visibly, name the cast profile, clear the old error on retry,
and never erase the recorded clips — §1/§3 as a human-runnable check), `POD-03`
(publish + the public transcript), `POD-04` (failed-read recovery).

---

## 8. Not closed here

- **`PODWF-2`** (`metadata.kind`/`feature` dropped by
  `registerLegacyDefsChainBacked`). The *dangerous* half of the asymmetry — the
  REPLACE that deletes the alias map — is closed in §2.2 because `PODWF-1`'s fix
  is unreachable without it. The remaining half is adding `kind`/`feature`
  restoration to `registerLegacyDefsChainBacked`, which the grader ranked
  behaviourally inert (**zero readers exist**; every hit is a write site). Left
  for the closeout, sequenced after `PODWF-1` exactly as instructed.
- **SC 1.2.1 for INGESTED episodes** — see §4. The absence is stated, not closed.
- **The wider array-merge shape** (`next.k = patch.k` with no guard) — outside the
  §1.2 walk's stated boundary. **NARROWED 2026-08-23:** the two DESTRUCTIVE
  members found inside that boundary are closed (see §1.2's correction); what
  remains open is the non-destructive remainder of the shape, which has not been
  walked. Still a floor.

### Residuals opened by the R1 review

- **`knowledgeBindingPrune`'s PARTIAL-listing hole.** The guard refuses on an
  empty listing and on a non-authoritative one; it cannot detect a listing that
  came back SHORT but non-empty (2 of 3 rows enumerated while all 3 are bound),
  because distinguishing that from two genuine deletions needs a per-id lookup
  the binding has no `orgId` for. Stated in the module's docblock so the limit is
  inherited rather than rediscovered. Closing it properly means the binding
  storing `orgId` alongside `collectionId` — a data-model change, not a guard.
- **`WFAU-4`-shaped: the H2 400 is SUSPECT, not PROVED.** That anthropic rejects a
  non-final assistant message with empty content is reasoned from the API
  contract and was **not** verified against a live endpoint, so the assertion
  gates on the message SHAPE. One live call with such a message would settle it.
- **`L4`'s ordering is argued, not pinned.** Clearing `episode.error` before
  `startWorkflowRun` is correct because the dispatch is `setImmediate` and
  `clearEpisodeError` is an unguarded read-modify-write — but opening that window
  deterministically means controlling the scheduler, and a test that pretends to
  would be a flake rather than a proof. No witness; the mechanism is stated at
  the call site.
- **`M3`'s key set is a claim.** `HOST_DERIVED_METADATA_KEYS` asserts that nothing
  a client sends may author those five keys. Adding a sixth is the same claim
  again and must be checked, not assumed. `kind`/`feature` are deliberately absent
  — `PODWF-2` stays sequenced for the closeout, above.

---

## Implementation record

| § | Item | Commit | Witness |
|---|---|---|---|
| 1 | `PODC-1` destructive mix | `dc436e8d7` | `podcasts-generation-pipeline.test.ts` (6) |
| 2 | `PODWF-1` fail-open aliases + the MCP replace | `749425dae` | `chain-backed-deferred-param-aliases.test.ts` (7) |
| 3 | `PODC-2`/`PODC-3` typed failures + error channel | `c0d858a5e` | `podcasts-generation-pipeline.test.ts` (17) |
| 4 | `PODU-1` public transcript | `e5a52e478` | `podcasts-public-transcript.test.ts` (7) |
| 5 | `PODU-2`/`-3`/`-4`/`-8` UX port | `9c5132416` | `podcastsFailureRecovery.test.tsx` (12) + `notebooksReadHonesty.test.ts` (4) |
| 6, 7 | nav-orphan class + two gates + manual suite | `54ce93730` | both gates proved fail-before/pass-after |
| 4 | `podcasts → documents` ratchet 95 → 96 | `e0f232d09` | `feature-dependency-parity.test.ts` |

Gates: full backend `vitest` — 1767 files / 14 121 tests, 1 failure, which was the
dependency ratchet above and is closed by `e0f232d09`. Frontend `npm run build`
(the canonical chain, including both new gates) exit 0; `check-test-types` 172
(baseline holds); `gen-steward-manifest --check` exit 0.

### Round-1 review fold-in (2026-08-23)

An adversarial review found **1 Critical, 2 High, 4 Medium and 6 Low**, nearly all
reproduced by probe or sabotage. Every one is folded in above as an inline
correction at the section it falsifies, rather than by editing the original
reasoning — the reasoning is the record, including where it was wrong.

| Item | Where | Disposition | Commit | Sabotage |
|---|---|---|---|---|
| `C1` the poll bound was unreachable | §5 | fixed (mechanism **and** witness) | `22dfcb0f6` | deps reverted → 6/14 red |
| `H1` two more prune-on-read binding wipes | §1.2 | fixed, shared rule + `profile-memory` folded on | `018e5d863` | `listingLooksWiped` removed → 4 red, all 3 features |
| `M1`-elevated public-route toggle bypass, `L5` kind check | §4 | fixed at the one composition owner | `6395c7bdb` | each guard removed → 1 red apiece |
| `H2` empty assistant turn; `M1` `writeDocument` toggle throw + the false ratchet comment | §3, §4 | fixed; comment corrected in place | `e2a150218` | turns restored → 2 red; catch removed → 1 red |
| `M2` success reported for a dropped write | §1 | fixed both layers; a pinning test rewritten | `e8fe546ae` | service guard → 3 red; node guard → 2 red |
| `M3` host-derived metadata unprotected | §2.2 | fixed by a KEY-SUBSET; the whole-`metadata` prescription **refused** | `4b6a255a8` | restore loop neutered → 1 red |
| `M4` the MCP alias suspicion | §2.2 | **settled** (never live for that path); recorded | — | n/a |
| `L1`/`L2`/`L3` blind instruments | §7 | fixed; baselines re-measured, unmoved | `a1e69c3a7` | each proved fail-before / pass-after |
| `L4` clear-before-run; `L6` three a11y nits | §3, §4 | fixed (`L4` argued, no witness — see §8) | `bb6451d54` | all three `L6` nits reverted → 3 red |

**Verified and explicitly NOT changed**, so the next reviewer does not re-litigate
them: the `clearClips` rejection stands (no DSAR/erasure path reaches clips;
`deleteEpisode` drops the whole row; re-generation replaces wholesale); the
speaker match is normalised and **not** fuzzy, with both call sites normalising
identically; determinism re-measured byte-identical (`02c19ee80741`); the pack's
two-step bump is two separate commits with all legs agreeing; the nav gate's zero
is real (control = 86).

R1 gates: frontend `npm run build` exit 0 (the full chain — `check-css-tokens`,
`check-tsx-color-literals`, both failure-card gates, `check-i18n`,
`check-nav-destination-orphans`, `check-built-css`, `check-bundle-budget`,
`check-csp-script-hash`); `check-test-types` **172** (baseline holds);
`gen-steward-manifest --check` exit 0 (the pack moved twice);
`tsc --noEmit` exit 0 in both workspaces.
