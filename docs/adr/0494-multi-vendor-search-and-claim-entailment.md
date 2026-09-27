# ADR 0494 — Multi-vendor web search, and claim-entailment as the next evidence rung

Status: **Phase 1 implemented · Phase 2 implemented** (P2a fetch+extract, P2b entailment verdicts)

> **Status corrected 2026-08-10.** The top line read `Phase 2 Proposed` while §P2b's own
> heading read `(implemented)` and its two open questions were both marked settled — the
> ADR contradicted itself. Verified from the code, not the record: `ClaimSupport`,
> `secondOpinion` and `ResearchClaim.support?: ClaimSupport[]` are all in
> `features/kicktodo-creator/creatorService.ts`, matching §P2b's description exactly.
> The stale correction note at §"Phase 2 — claim entailment" ("P2b — entailment verdicts
> (still Proposed)") is superseded by this line and by §P2b itself.
>
> This mattered: `docs/adr` `Status:` is how unfinished work is picked up here, so the
> stale line put P2b on a work shortlist as implementable. It is not — it is done.

**Depends on:** ADR 0101 (provider-native web search — one capability, provider-aware
backing), ADR 0491 (run-dispatch surfacing; the incident that exposed the DOA research
path), ADR 0415/0458 (the Challenge Factory evidence dossier).
**Surface:** host runtime only. No OpenWOP wire field, capability flag, or run-event.
**NON-NORMATIVE — no new RFC.**

## Why this exists

ADR 0101 Phase 4 made the research capability honest: with no live search adapter the
host refuses instead of fabricating. Honest, but still refusing — and in practice
*always* refusing, because `searchLive` spoke exactly one dialect (Brave's
`x-subscription-token` header, `body.web.results`, Brave's base URL). A tenant holding
a Tavily or Exa key could not use it: the key resolved fine and was then sent to
Brave's endpoint with Brave's header.

Since every evidence-bound pipeline is fail-closed without live search, that single
hard-coded dialect is what kept research gated behind an operator step almost nobody
takes.

### What the competitive pass found (2026)

1. **Free tiers differ by an order of magnitude.** Exa ~20,000 requests/month, Brave
   ~2,000, Tavily ~1,000 credits; all cluster at $5–8 per 1k at scale. Supporting more
   than one vendor is the difference between "configure a key" being a two-minute
   self-serve step and an adoption wall.
2. **Inline, per-claim citations with a visible source panel** are the emerging
   interaction standard (Perplexity), versus listing sources at the end.
3. **Citation *quality* is the field's unsolved problem** — and this is the important
   one. The dangerous errors are not fabrications but **real sources applied
   incorrectly**: a Stanford study found 17–34% of legal-AI queries produced
   incorrect or mis-sourced citations, with accuracy below 66% while *"users trust AI
   citations more while verifying less."* The emerging practice is to treat every
   citation as a claim to be **cross-examined**, and to treat reviewer **disagreement**
   as the signal for human scrutiny.

### Where this app already stands

Finding 3 is worth stating plainly because the Challenge Factory dossier is **ahead of
the field on the structural half**: `claims[].sourceHashes` binds each claim to
specific sources, `sourceHash(url, title)` is re-derived on write so a claim cannot
cite a source that was never recorded, `unsupportedClaimIds` flags claims citing
nothing, and a claim entailed only by a rights-blocked source fails the submit gate.

But the gap is precise, and it is exactly the field's dangerous case:

> The dossier proves a source **exists and was recorded**. It does **not** prove the
> source **supports the claim**.

## Decision

### Phase 1 — multi-vendor search (implemented)

Vendor differences are **data, not branching code**: `host/searchVendors.ts` holds one
descriptor per vendor (request shaping in, result normalization out), and `searchLive`
dispatches through the resolved descriptor.

This follows `host/imageProviderAdapter.ts` (ADR 0115/0244) — the established precedent
for "one host capability, several third-party backends": ONE adapter with an explicit
vendor map, never a module per vendor. **It does not fork ADR 0101's "ONE owner" rule**,
because that rule is about the *capability* (`host.webResearch`); a vendor map lives
inside it.

- **Vendor resolution:** explicit `OPENWOP_WEBSEARCH_ENGINE` wins (an operator pointing
  at a self-hosted or proxied endpoint must not be second-guessed); otherwise infer from
  the key's own prefix, so a user pastes a key and it works. Unknown ⇒ Brave, preserving
  the historical default exactly, so existing deployments are unaffected.
- **Suitability:** each descriptor declares `suitability`. Search APIs are sold for
  programmatic retrieval and return real publisher URLs, so they are `durable` — unlike
  an LLM provider's native grounding, whose links may be licensed for display only. Same
  field, one predicate (`webSearchCapability.ts`) governing both lanes; for a shipped
  vendor the descriptor is now the SSoT.
- **Credential lane unchanged.** The blocker was never the credential — a Tavily key
  already resolved. `resolveSearchKey` (BYOK `web-search` secret → host env) is
  untouched. Adding a Connections lane, as `imageProviderAdapter` has, would make a
  THIRD lane for one credential; that is a separate decision and is deliberately not
  taken here.

#### Rejected: ship a default search key

There is **no defensible zero-config default.** A self-hosted BYOK product cannot ship
a shared search key — cost, abuse, and the vendors' own terms all forbid it, and
pretending otherwise would reintroduce exactly the dishonesty ADR 0101 and ADR 0491
removed. The honest target is *"configured in two minutes"*: support the vendor with the
largest free tier, name it in the refusal copy, and keep the not-configured state
actionable. "Bring a key" is inherent to this product shape; the fix is to make it
trivial, not to fake it.

### Phase 2 — claim entailment

> **CORRECTION (2026-07-27) — this section's original premise was WRONG, and the
> real gap was larger.** It claimed "the research pipeline ALREADY fetches readable
> source content, so the raw material is in hand." It does not. The live Factory
> chain was `research-frame → core.web.search → source-normalize → evidence-graph`:
> `core.web.search` returns url/title/snippet, `normalizeSource` takes only
> url/title/engine, and **`claims` was never wired at all** (`evidence-graph`
> received `candidateId` and nothing else).
>
> Consequence: the dossier carried **zero claims**. `unsupportedClaimIds` was always
> empty, and `plan-generate` — whose prompt says *"Ground every claim ONLY in the
> provided evidence"* — received an evidence summary reading, literally, **"no
> source-supported claims recorded"**. The flagship plan was ungrounded while
> instructing the model that it was grounded: the same false-promise class as
> ADR 0491, one layer down.
>
> So the claim→source binding this ADR called "ahead of the field" is real, correct
> code that the product's flagship pipeline **never exercised**. There were no claims
> to entail. Phase 2 is therefore not "add a verdict field" — it is completing the
> evidence pipeline. Sequenced, with a hard dependency:
>
> **P2a — fetch + extract (implemented below).** You cannot verify entailment of
> claims that do not exist.
> **P2b — entailment verdicts.** Now inert-free: there are claims. _(Written when P2b was
> Proposed; it has since been implemented — see §P2b below and the status line.)_

#### P2a — content fetch + claim extraction (implemented)

- **`core.web.fetch`** — the READ half of `host.webResearch`. The surface always
  exposed `fetchBatch` (SSRF-guarded, redirect-following, readable-text extraction);
  only `search` was ever projected as a node, so a chain could find pages but never
  read one. A separate node rather than folding fetch into search (`research()`
  already composes both) because chains are user-editable and human-reviewed —
  `search → fetch → …` stays legible and each step independently re-runnable.
- **`feature.kicktodo.nodes.claim-extract`** — joins fetched content to recorded
  sources by url and asks the model for claims cited **by source hash**, with the
  response schema taken LIVE from the creator surface (`claimSchema`, the
  `planSchema` pattern — never a hand-copy), temperature 0, and one bounded
  error-fed repair. Replay safety is inherited: `ctx.callAI` rides the invocation
  log, so the extraction is recorded and replayed, never recomputed.
- **Fail-closed, twice.** No readable content ⇒ `no_readable_sources` (and the model
  is never called). Readable content but nothing supported ⇒ `no_supported_claims`.
  Both refuse rather than pass an empty dossier to `plan-generate`, matching
  `StubSourceError`'s posture. The model is not trusted on citation either:
  `recordResearch` re-derives every hash and re-points citations, so an invented
  hash lands in `unsupportedClaimIds`.
- **Chain topology.** `fetch` is a **fan-out from `search`**, not an insert between
  `search` and `normalize` — outputs flow along edges, so a serial insert would have
  starved `normalize` of `results`/`engine`. Both fan-ins use **explicit port refs**
  (`node.port`): `buildNodeInputs` keys by `targetInput ?? 'input'`, so two unported
  parents would both write `input` and the second would silently clobber the first.

#### P2b — entailment verdicts (implemented)

**Status: implemented.** The two open questions are settled:

**Where verdicts live** — ON the claim, in the dossier: `ResearchClaim.support?:
ClaimSupport[]`, each `{sourceHash, verdict, span?, secondOpinion?}`. A sibling
record would create a second owner and a join for data that is meaningless apart
from its claim.

**Cost ceiling** — only pairs a claim actually CITES are judged, never the
claim × source cross product. Citations run 1–2 per claim, so the work is linear
in citations rather than quadratic in the dossier. On top of that the second
opinion is TARGETED: requested only where the first judgement said `supports`,
because a false `supports` is what carries a bad claim through a gate while a
false `unrelated` merely loses one. A hard `maxVerifications` ceiling (default 60)
bounds the worst case, and what it skips is REPORTED — a silent cap would make
"verified" mean different things on different runs.

Also decided in implementation:

- **`supports` without a quoted span is downgraded to `unverifiable`.** A judgement
  that cannot point at the passage is not auditable, and an unauditable pass is
  precisely the false-support this phase exists to catch.
- **An unparseable judgement fails to `unverifiable`, never `supports`** — failing
  open here would let a broken response carry a claim.
- **The gate is back-compatible.** `claimsGate` requires entailment only when
  `support` is present; dossiers recorded before verification keep their structural
  meaning rather than retroactively failing.
- **Disagreement is recorded, not resolved.** A disputed pair stops counting as
  support (so it cannot silently pass) AND surfaces on a new informational
  `disputed` gate row for the human approver. Auto-failing would discard the most
  valuable product of judging twice; silently collapsing it would discard the
  signal entirely.

<!-- superseded proposal retained per correct-don't-rewrite -->

#### P2b — original proposal

Design settled by the competitive pass and the architect review:

- Per `(claim, source)`: `supports` / `contradicts` / `unrelated` / `unverifiable`,
  with the supporting span.
- **Targeted adversarial, not adversarial-by-default.** The dangerous error is a
  false `supports`, not a false `unrelated`. One judgement per pair, and an
  independent second **only for pairs the first marked `supports`** — a 2× on a
  subset rather than on everything, which matters because it runs on the tenant's
  own key.
- **`contradicts` FLAGS, it does not hard-fail.** The field's finding is that
  disagreement is the signal for human scrutiny; auto-failing discards it. Route to
  the existing human gate. A contradicted claim must not count as supported.
- Verdicts are model output ⇒ recorded, never recomputed at replay.

**Open:** where verdicts live (dossier vs sibling record), and the cost ceiling per run.

<!-- original text follows, kept per the correct-don't-rewrite rule -->

#### Original sketch (superseded by the correction above)

The next rung, and the one that would make this genuinely state of the art: verify that
each cited source **supports** its claim, and surface disagreement.

Sketch, to be settled before implementation:

- The research pipeline **already fetches readable source content**
  (`research()` → `fetchBatch({extractReadable:true})`), so the raw material is in hand
  at exactly the moment the dossier is assembled. `recordResearch` stores refs+hashes
  only, so the check MUST happen in the pipeline — a later pass would have nothing to
  read.
- Per `(claim, source)` pair, produce a verdict: `supports` / `contradicts` /
  `unrelated` / `unverifiable`, with the supporting span.
- Adversarial by construction: ≥2 independent judgements per pair with **disagreement
  recorded, not resolved**. The field's finding is that disagreement is the useful
  signal; collapsing it to a single verdict discards the thing worth surfacing.
- Store verdicts alongside `sourceHashes` and extend the submit gate from "cites a
  recorded source" to "cites a source that supports it", with disagreement routed to the
  human reviewer rather than auto-failed.

**Open questions for Phase 2:** where verdicts live (dossier vs. a sibling record); cost
(N claims × M sources × 2 judgements per run); whether a contradiction should hard-fail
the gate or flag; and whether the verdict is replay-stable (it is model output, so it
must be recorded, never recomputed at replay).

#### P2c — mark what was actually READ (implemented)

Found by probing real search results rather than by review: **`mayoclinic.org`
returns HTTP 403 to a server-side fetch.** A major authoritative publisher simply
will not serve one, and it is not alone.

Those sources were already excluded from what a model may cite (`claim-extract`
joins content to sources by url, so an unfetched source is never citable). But
`recordResearch` still stored them, so the dossier — and `summarizeDossier`, which
feeds the plan author — reported *"N sources recorded"* when only a fraction backed
anything. Found and read are different facts, and the artifact a human approves
must not blur them.

- `ResearchSource.retrieved?: boolean` — stamped from the extraction step's read
  set, re-pointed through the SAME hash map as citations. **Absent stays absent**:
  "unknown" (pre-P2c dossiers) must not be relabelled "not read".
- `summarizeDossier` now reports **"N found, M readable"** whenever any source
  carries the mark, and falls back to the old wording when none do.

Consequence worth stating: bot-blocking materially shrinks the usable evidence
base, and the honest response is to show that rather than to count blocked sources
as if they contributed.

## Consequences

A tenant can paste a Brave, Tavily, or Exa key and research works — with Exa's free tier
covering roughly 20,000 searches a month, which makes the two-minute path real. Existing
Brave deployments are byte-unchanged.

Phase 2 remains the honest gap: this app can currently prove a citation *exists*, not
that it *holds*.

## Correction — verified against the live API (2026-07-26)

The first cut of the Exa descriptor was **wrong in a way no hand-written fixture
would have caught**: it sent `contents: { text: false }`, which *suppresses* the very
field it then parsed, so every Exa result would have come back snippet-less. Snippets
are not cosmetic here — the dossier's `ResearchSource` carries one and the model reads
it to judge relevance.

Two of Exa's own doc pages also disagree: the API reference shows `highlights`
accepting `{query, maxCharacters}`, while the coding-agent guide says to pass `true`
and lists the older per-highlight knobs (`numSentences`, `highlightsPerUrl`) as
deprecated, documenting `maxCharacters` under `text` only. Rather than pick a page,
the request now sends the plainly-documented `highlights: true` and the snippet is
capped **client-side** — same budget, no dependence on a contested parameter, and the
cap holds for every vendor.

Settled by a live probe (`POST https://api.exa.ai/search`, HTTP 200): the response
carries `results[]` with `url`, `title`, and `highlights` (array of strings) — real
publisher URLs (health.com, mayoclinic.org), not redirectors, which is what makes the
vendor `durable`. That response is committed, trimmed, as
`test/fixtures/exa-search-response.json` and the parser is pinned against it.

`type: 'auto'` was added per the guide's recommended default.

**Staleness to report upstream:** the API-reference page and the coding-agent guide
disagree on the `highlights` parameter shape.

## Correction — the Vault's `host` scope did nothing (2026-07-26)

Directed by the maintainer: **keys belong on the Connections page, not in env vars.**
Acting on that surfaced a real defect.

`resolveSearchKey` asked only for the TENANT-scoped secret and then fell straight to
`OPENWOP_WEBSEARCH_API_KEY`. But the Secrets Vault on the Connections page writes at
`tenant` **or** `host` scope, and `resolveSecret` deliberately does **not** fall back
from a tenant scope to the host row — a generic fallback would leak host secrets to
tenants (the vuln-scan M3 note in `secretResolver.ts`). So a host-scope `web-search`
key was **unreachable**: an operator would set it, see it in the Vault inventory, and
every research run would still refuse. Exactly the "looks configured, isn't" class this
ADR family exists to remove.

Resolution order is now **tenant → host-global → env**, with the host lane read
SCOPELESSLY at this call site — the same idiom as `billing:stripe-key`, the established
deliberately-host-global operator credential. (Both require `OPENWOP_BYOK_EPHEMERAL=false`;
under ephemeral mode a scopeless ref resolves to null by design.)

A tenant key still wins, so a workspace can bring its own quota.

**Second defect, found by the test for the first:** `liveWebSearchConfigured` called
`resolveNativeWebSearch` unguarded, so a durable-storage hiccup made the PRE-FLIGHT
throw rather than return its typed refusal — the same hazard already fixed in
`search()` and missed in its sibling. It now fails closed.

## Implementation record

| Phase | Change | Test |
|---|---|---|
| 1 | `host/searchVendors.ts` descriptors (Brave/Tavily/Exa); `searchLive` dispatches through them | `test/search-vendors.test.ts` — sabotage-probed by reverting to Brave-only dispatch |
| 1 | `engineIsDurable` consults the descriptor for shipped vendors | same |
| 1 | Refusal copy names the vendors + the free tier | `kicktodo-challenge-author-tools.test.ts` |
| 2 | — | Proposed; not implemented |
