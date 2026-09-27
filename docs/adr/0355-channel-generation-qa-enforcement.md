# ADR 0355 — Channel generation QA: enforced platform limits, real fact-check/dedup/readability, persona lens, iteration ops

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1–5, 2026-07-12 — see corrections) |
| **Date** | 2026-07-12 |
| **Feature** | extends **`campaign-channels`** (ADR 0157) — toggle id stable |
| **Closes** | `CSG-GEN-1..6` ([gap register](../CAMPAIGN-STUDIO-GAP-FINDINGS.md)) |
| **Composes** | strict grounding + `kb.rag` claim verify (ADR 0351), brand scorer (ADR 0155/0354), RFC 0126 data-parallel dispatch (per-persona fan-out), `localEmbedding` (dedup similarity), approval-gate refine loop, the ONE chat (iteration ops as agent verbs) |
| **RFC verdict** | **Host-ext, no new RFC.** Per-persona fan-out rides the already-Accepted RFC 0126. |

## Context (boundaries audit)

Generation covers all 5 channels with variants and in-loop compliance scoring, but the spec's rigor
is prompt-hope: **no `maxLength` in any response schema** and char limits as prose
(`packs/feature.campaign-channels.nodes/index.mjs:42,44,52,66,68`); QA length check is
`JSON.stringify(draft).length` (`:162`); fact-check = citation-presence −20 (`:160-161`); no
readability (despite ADR 0157 claiming one — correction recorded), no similarity dedup, no
per-persona loop (`briefContext.ts:15-35` folds personas into one prompt), no named iteration ops
(only the generic refine loopback, `channelWorkflows.ts:31-56`), variants unpaired (`:44,52,60`).
Single owner confirmed: the parameterized `generate` node + `CHANNEL_SPEC` in the channels pack.

## Decision

1. **Platform spec table as data (CSG-GEN-1).** A `PLATFORM_LIMITS` module (named constants:
   Google 30/90, Meta 40/125/250, LinkedIn 70/150/600, per-platform social caps) that (a) injects
   `maxLength` into the per-channel **response schemas** so the model is constrained up front, and
   (b) drives a **deterministic post-validate**: any over-limit field triggers one bounded
   regeneration of just that field (`ctx.callAI`, field-scoped), then hard-truncates at
   word-boundary with a `truncated` flag — never ships an over-limit ad. Unit-tested table ↔
   schema parity (the `capParity.test.ts` pattern).
2. **QA v2 (CSG-GEN-2).** `content.quality.check` becomes a real gate:
   - **Claim-level fact-check**: extract factual claims (envelope, budget-capped) → verify each via
     `kb.rag` (`minScore` per ADR 0351) → `claims: [{text, verdict: supported|unsupported|uncited}]`;
     under `groundingPolicy:'strict'` an `unsupported` claim fails the draft (fail-closed node
     output).
   - **Similarity dedup**: pairwise cosine over `localEmbedding` vectors across variants; pairs
     above threshold flagged + one regenerated (the hash embedder is adequate for near-dup
     detection even while ADR 0351 upgrades retrieval).
   - **Readability**: deterministic Flesch-Kincaid banding per persona seniority (pure fn).
3. **Persona lens (CSG-GEN-3).** Optional `perPersona: true` on the channel run: the child workflow
   fans one generation per persona via **`core.dispatch` + RFC 0126 per-item input**
   (`personaId` as the item), joined deterministically — the segment-winback pattern applied to
   generation. Output drafts carry `personaId`; the approval gate's `itemsFrom` reviews them
   per-persona.
4. **Iteration ops (CSG-GEN-4).** Named refine verbs — `more-like-this`, `add-urgency`,
   `more-technical`, `simplify`, `shorten` — as (a) structured refine payloads on the existing
   approval-gate loopback and (b) **agent tools** on the Channel Generator agent, so "make the ad
   set more technical" works in the ONE chat (AI-first; no new panel). Each op is a prompt
   transform + re-run of the field-scoped generate; results re-enter the same QA gate.
5. **A/B pairing (CSG-GEN-5).** Ad/subject variants become labeled pairs
   `{ variantA, variantB, hypothesis }` (the hypothesis is generated, e.g. "benefit-led vs
   fear-of-loss") — feeding ADR 0357's performance attribution. Volume stays quality-first: no
   100-piece quota (deliberate deviation from the source spec; recorded — variant breadth scales by
   `variantsPerPlatform` config, not a piece count).
6. **Competitor differentiation (CSG-GEN-6).** Optional `competitors[]` on the brief (names +
   claimed strengths, manually entered or KB-extracted via ADR 0356's extraction envelope); when
   present, a differentiation instruction block + a QA check that drafts don't parrot competitor
   claims.

## Phases

| Phase | Ships | Gaps |
|---|---|---|
| 1 | `PLATFORM_LIMITS` + schema maxLength + post-validate/regen/truncate | GEN-1 |
| 2 | QA v2: claims verify + dedup + readability (strict-mode fail-closed) | GEN-2 |
| 3 | Iteration ops (gate payloads + agent tools) | GEN-4 |
| 4 | Per-persona fan-out (RFC 0126) | GEN-3 |
| 5 | A/B pairs + hypothesis; competitor block | GEN-5, GEN-6 |

## Matrix highlights

Toggle `campaign-channels` (stable). Packs: `feature.campaign-channels.nodes` major bump (schemas
change shape for pairs — artifact-type pack versioned accordingly). Replay: QA verdicts, claims,
dedup pairs, and regen outcomes are node outputs; per-persona fan-out merges deterministically (RFC
0118 §G ordering). RBAC unchanged. AI-first: every new op reachable via chat agent verbs.

## Alternatives weighed

- *Enforce limits by truncation only*: rejected — silent truncation ships broken copy; regen-first,
  truncate-with-flag last.
- *LLM-judge for dedup/readability*: rejected — deterministic is cheaper, replayable, and adequate;
  the LLM budget goes to claim extraction.
- *The spec's 100–200 piece volume target*: deliberately not ported (quality>volume; breadth is a
  config knob). Recorded as a correction to the source spec.

## As-built corrections (2026-07-12)

- **Dedup = token-Jaccard (0.8), not embedding cosine**: packs are standalone .mjs with no
  backend imports; a deterministic Jaccard over word sets serves the near-dup purpose with
  zero dependencies (open Q1 superseded).
- **Per-persona fan-out shipped as the NODE capability** (`personaId` input → a focused
  generation), which is exactly what a `core.dispatch` per-item child passes (RFC 0126 — the
  segment-winback pattern); the chain-pack fan-out SHAPE is composed by callers, not baked
  into the spine (a per-persona campaign is a caller decision).
- **A/B pairs are additive** (`abLabel` on variants + set-level `hypothesis`) so the ads
  publish path's `variants[]` contract is untouched.
- **Iteration ops live on the generate node** (`refineOp` + `priorDraft`) — reachable from
  the approval-gate refine loop AND as agent tool inputs through the ONE chat; unknown ops
  fail loudly.
- Readability ships as an informational band on the report (not a scored gate) until a
  persona-level readability target exists.
- **Decision 2's claim-VERDICT verification SHIPPED (Option A, 2026-07-12, pack
  1.9.0)**: per-claim verdicts (`supported|unsupported|uncited`) are computed by the
  pure `verifyClaims(claimTexts, contexts)` (`platformLimits.mjs`) against the
  grounding retrieval's ALREADY-retrieved `kb.rag` contexts — no second retrieval;
  the generate node retains `r.contexts` (previously discarded) and threads it to
  `scoreQuality`, which rides the verdicts on the report (`qualityReport.claimVerdicts`).
  A conservative token-overlap threshold stands in for embedding cosine (packs are
  standalone .mjs, zero backend imports): a cited claim is `unsupported` only when its
  quantified proof token (`%`/`×`) appears in NO retrieved chunk (the strongest
  un-grounded signal); superlative-only claims fall back to salient-token containment.
  `uncited`/`unsupported` stay WARNING findings by default (score penalty as before);
  under `groundingPolicy:'strict'` any `unsupported` claim FAILS the node closed
  (`grounding_insufficient`) — this only bites when coverage exists but a specific
  claim doesn't match (coverage:none already fails earlier). Per-CLAIM retrieval
  (a distinct `kb.rag` round-trip per claim) is deferred as a recall enhancement.
- **Decision 6's competitor-parroting QA check shipped as prompt guidance only
  (BRAND-CODE-6 grade note)**: the COMPETITORS block instructs differentiation, but no
  deterministic "draft parrots a competitor claim" detector exists yet (deferred — it
  needs the competitor claimed-strengths corpus from ADR 0356 extraction to match
  against).
- **Grade-pass hardening (2026-07-12, pack 1.7.0)**: limit findings carry the platform
  SET index and truncation targets by index, so duplicate same-platform sets can't be
  mis-cut (QA-CODE-1); A/B pair shape is validated (WARNING finding, never node-failing)
  when pairing metadata is present (QA-CODE-4); the ad_variants schema maxLengths derive
  from `AD_FIELD_SCHEMA_MAX` with a table↔schema parity test (QA-CODE-5); the prompt
  solicits TikTok, which was validated but never asked for (QA-CODE-6); strict grounding
  floors `kb.rag` at `STRICT_MIN_SCORE = 0.25` (KB-CODE-2 mirror); managed creative-brief
  creation is idempotent on (campaignBriefId, title) with a `briefCreateErrors` count
  (CB-CODE-5).

## Phase → implementation record

| Phase | Ships | Evidence |
|---|---|---|
| 1 | `platformLimits.mjs` (limits AS DATA) + schema `maxLength` + prompt tables + deterministic post-validate → ONE regen → word-boundary truncate + flag | `packs/feature.campaign-channels.nodes/{platformLimits,index}.mjs`; `test/campaign-generation-qa.test.ts` |
| 2 | QA v2: per-field charLimit ERRORs, claim-level `[src_N]` check (the vendor pack's proof patterns), near-dup pairs, readability band | same |
| 3 | Named iteration ops (`more-like-this`/`add-urgency`/`more-technical`/`simplify`/`shorten`) | same |
| 4 | `personaId` focused generation (the RFC 0126 per-item input) | same |
| 5 | A/B pairs + hypothesis · brief `competitors[]` (validated, FE input, prompt block) | same + `campaign-brief` |
