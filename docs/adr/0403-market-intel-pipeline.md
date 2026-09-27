# ADR 0403 — Market-intel research pipeline (VOC · ad-angles · targeting packs · hook bank)

| Field | Value |
|---|---|
| **Status** | implemented |
| **Date** | 2026-07-17 |
| **Feature id / toggle** | **`campaign-brief`** (extends ADR 0156 — **no new toggle**; OFF, bucket `tenant`, category `Marketing`) |
| **Packs** | `feature.campaign-brief.nodes` (+3 nodes, pin bump) · `feature.campaign-brief.agents` (Brief Strategist allowlist +3, pin bump) · **new** `feature.campaign-brief.artifact-types` |
| **Depends on** | ADR 0156 (personas + brief + kernel — the enrichment target + a consumer), 0157/0158 (channel workflows + orchestration — the hook-bank/angle consumers), 0101 (provider-native web search — source acquisition + untrusted fencing), 0011/0084 (KB + notebooks — source storage + retrieval), 0055 (artifact-type packs — RFC 0075) |
| **Closes** | GAP-ANALYSIS §Marketing "Market intel (VOC, ad-angle briefs, targeting packs, hook bank)" (PARTIAL → covered); "Objection mining" (PARTIAL → covered) |
| **RFC verdict** | **Host-ext, no new RFC.** Additive host-ext routes under `/v1/host/openwop-app/campaign-brief/*`, KV-blob stores, recorded run artifacts, and the existing agent+tool turn-time channel. Nothing touches the OpenWOP wire. |

## Context

Today "market intelligence" in this app is two unrelated things, and neither is a **source→evidence→positioning** research pipeline:

1. **Persona attributes** — `campaign-brief`'s `Persona` carries `painPoints[]` / `objections[]` / `goals[]` (`features/campaign-brief/types.ts:29-32`), authored by hand (`personaService.ts:54-76`). They are *assertions*, not *evidence* — no quote, no source, no citation. "Objection mining" exists only as this attribute (GAP-ANALYSIS §Marketing rates it PARTIAL — "captured as persona attribute, not a dedicated mining tool").
2. **The `vendor.myndhyve.market-intel-*` node packs + `market-intel.digest` chain** (ADR 0174) — these mine **campaign performance variance** (over `insights-suite`), a *post-launch analytics* loop. They own the "market-intel" name already, and they are NOT about source material. **This ADR must not collide with that namespace** (see Decision).

Meanwhile the raw capability to turn source material into intelligence already exists but is generic:

- **KB + notebooks** own source storage + retrieval: `notebooks/surface.ts` exposes `getSourceText` (`:110`), `ingestSource` (`:150` — lands a transcript as an untrusted KB document), and `ask` (`:211` — grounded retrieval + fencing); `kb/surface.ts` exposes `rag` (`:32` — retrieve → augmented prompt + citations + coverage).
- **Provider-native web search** (ADR 0101) owns live source acquisition on the user's existing BYOK key, with result bodies **fenced as untrusted** (`fenceUntrustedBlock`) — the highest-risk RAG input, already handled.
- **The proposals-with-citations pattern already exists in this exact feature**: `feature.campaign-brief.nodes.extract-seeds` (ADR 0356) reads a bound KB collection and proposes personas/product/competitors **with source citations, as PROPOSALS the user confirms**. Market-intel VOC is the same shape, one layer deeper (quote-level evidence instead of entity proposals).

So the gap is not a missing subsystem — it is **purpose-built research nodes + typed artifacts** that ride the existing acquisition/retrieval/grounding seams and feed the personas (enrich) and the channel workflows (consume). GAP-ANALYSIS §262 states it directly: *"VOC mining / ad-angle briefs / targeting packs exist only as persona attributes + generic notebooks/web-search. Purpose-built research nodes would close the vibe-marketing/hook-bank story."*

## Boundaries audit (what owns what — nothing here forks)

| Seam | Owner (file:line) | This ADR's relationship |
|---|---|---|
| **Persona pain-points / objections** | `campaign-brief/personaService.ts:54-76`; `types.ts:29-32` | **ENRICH, don't fork.** VOC evidence *grounds* a persona's assertions (a `painPoint` gains a `sourceRef` to a real quote); the persona entity is unchanged. Evidence has its own lifecycle (browse, cite, reuse across briefs) — the persona is not the store. |
| **Messaging kernel** | `campaign-brief/types.ts:81-93`; `nodes.generate-kernel` | **Consumer, upstream.** Angles reference the kernel's positioning; the kernel is not modified. VOC can be *fed into* kernel generation as grounding, but that is an 0156 seam, not a fork. |
| **Source docs / transcripts / URLs** | `kb/kbService.ts`, `notebooks/notebooksService.ts`; surfaces `kb/surface.ts:32`, `notebooks/surface.ts:110,150,211` | **Compose, never re-store.** Sources live in KB/notebooks. The VOC node retrieves via `kb.rag` / `notebooks.ask` / `notebooks.getSourceText`; it never opens a second source store. |
| **Live web acquisition + untrusted fencing** | ADR 0101 (`host/untrustedContent.ts` `fenceUntrustedBlock`; provider-native `web_search`) | **Ride it.** Web sources enter through the same fenced path; the VOC node treats all source bodies as `<UNTRUSTED>` data. No new fetcher. |
| **Proposals-with-citations precedent** | `packs/feature.campaign-brief.nodes` `extract-seeds` (ADR 0356) | **Extend the pattern.** `extract-voc` is `extract-seeds` at quote granularity — same "retrieve → propose with citations → human confirms" shape, same pack. |
| **Artifact-type registration** | `host/artifactTypePackLoader.ts` (RFC 0075 `kind:"artifact-type"`); precedent `packs/feature.campaign-channels.artifact-types/pack.json` | **Register, don't invent.** The three intel artifacts get schemas in a new `feature.campaign-brief.artifact-types` pack, served at `/schemas/artifacts/{id}.schema.json` and discoverable via `schema.lookup` (`agentToolProvider.ts:397`). |
| **The brief context projection** | `campaign-brief/surface.ts:37-67` (`assembleContext` — the seam channels read the kernel through) | **Extend the projection.** The hook bank is added to `assembleContext` so `campaign-channels.generate` reads tested hooks the same way it already reads the kernel — the honest "hook bank feeds the channel workflows" wiring, no new cross-feature call. |
| **"Market-intel" pack namespace** | `vendor.myndhyve.market-intel-*` (ADR 0174 — performance variance) | **Avoid the collision entirely.** These nodes live under `feature.campaign-brief.nodes`; there is **no `feature.market-intel.*` package** (see Alternative 1). |

## Decision

Ship the market-intel research pipeline as **an extension of `campaign-brief`** — three research nodes, four typed artifacts/stores, an artifact-type pack, and a Brief-Strategist allowlist bump — riding the existing acquisition/grounding/chat seams. **No new feature package, no new toggle, no new agent, no new chat.**

### Typed artifacts (the intelligence shapes)

Each is a **recorded node output** (`role:"action"` → replay/fork read the recorded artifact, never a re-fetch) **and** projected into a `campaign-brief`-owned `DurableCollection` (KV-blob over `host_ext_kv`, tenant+org keyed — the `Persona`/`CampaignBrief` precedent; **no SQL migration**), because these are first-class, browsable, reusable marketing assets with independent lifecycle, not ephemeral drafts. Registered as artifact types so they validate + are schema-discoverable.

| Artifact / store | Shape (closed-world schema) | Store key | Grounding invariant |
|---|---|---|---|
| **`campaign-brief.voc-evidence`** | `{ quote, sourceRef:{documentId, sourceKind, locator, contentHash}, theme, sentiment: 'pain'\|'desire'\|'objection'\|'praise', personaHint? }` | `campaign-brief:voc-evidence` (`tenant::brief::id`) | Every evidence item **MUST** carry a resolvable `sourceRef`. An extracted quote with no source → **typed failure**, never a bare string. |
| **`campaign-brief.ad-angle`** | `{ claim, proofRefs: vocEvidenceId[], hookVariants:[{text, format}], positioningLens }` | `campaign-brief:ad-angle` (`tenant::brief::id`) | An angle with **empty `proofRefs`** → **typed failure** (an ungrounded angle is not persisted). Each `proofRef` must resolve to a stored `voc-evidence` id. |
| **`hook`** (hook bank entry) | `{ text, format, angleId?, status: 'candidate'\|'tested'\|'retired', metricRef? }` | `campaign-brief:hook` (`tenant::org::id`) — **org-scoped, brief-independent** (the reusable library) | A hook promoted to `tested` may carry a `metricRef` (a `campaign-intel` performance pointer, ADR 0160) — advisory, never required. |
| **`campaign-brief.targeting-pack`** | `{ platform: 'meta'\|'google'\|'linkedin'\|'tiktok', audiences[], interests[], keywords[], rationale, evidenceRefs: vocEvidenceId[] }` | `campaign-brief:targeting-pack` (`tenant::brief::id`) | Platform-keyed; recommendations cite the VOC/persona evidence they derive from. |

The node's write to the durable store is the **justified surface write** precedent (`notebooks.setSourceSummary`, `campaign-brief.setKernel`) — a single narrow write behind the same org-visibility/tenant gate as every read.

### Node contracts (added to `feature.campaign-brief.nodes`, pin bump)

All `role:"action"` (recorded → replay-safe). Each **reads before it writes**, validates output **closed-world against the registered artifact schema**, performs **one bounded error-fed repair**, and returns a **typed failure** (never success-with-empty) when the grounding invariant is violated — the LLM-EXCHANGE non-negotiables.

1. **`extract-voc`** — `{ briefId, collectionId?, sourceRefs?, query?, provider?, model? }` → `{ evidence: VocEvidence[] }`.
   Acquires source text via `kb.rag` / `notebooks.getSourceText` / (for URLs) the ADR 0101 fenced web-search path; mines quotes → pain/desire/objection/praise with **citation back to the source** (`documentId` + `locator` + `contentHash`). Fences all source bodies as untrusted. Closed-world validate → 1 repair → persist + record artifact. A quote missing a `sourceRef` is dropped **and** flagged a typed validation finding (not silently kept).

2. **`generate-angles`** — `{ briefId, personaId?, provider?, model? }` → `{ angles: AdAngle[] }`.
   Reads the brief's VOC evidence + the persona + the kernel; generates positioning angles + hook variants, **each grounded in `proofRefs` pointing at stored `voc-evidence` ids**. Closed-world validate; an angle with empty `proofRefs` → typed failure (one repair, then fail). Emits the hook variants into the **org-scoped hook bank** as `candidate` hooks.

3. **`build-targeting`** — `{ briefId, platform, provider?, model? }` → `{ pack: TargetingPack }`.
   Reads the brief + persona + VOC evidence; recommends platform-keyed audiences/interests/keywords with a rationale citing the evidence. Validate + persist + record. (One node parameterized by `platform`, the ADR 0157 "one generate node, N shapes" factory pattern — not four near-identical nodes.)

### Chat-drivability (agent + nodes, honest — no new agent)

The **existing `feature.campaign-brief.agents.brief-strategist`** (persona `RESEARCH`, `modelClass:"research"`) gets the three new nodes added to its `toolAllowlist` (pin bump `agents` 1.1.0 → 1.2.0). This is the honest owner: it is already a RESEARCH agent driving grounded kernel generation from the ONE chat (ADR 0058), and VOC/angle/targeting research is squarely its remit. Users drive research by deep-linking the main chat scoped to this agent (`navigate('/?agent=feature.campaign-brief.agents.brief-strategist')`) — the ADR 0058 pattern. **No new chat panel, no bespoke "research" agent, no envelope kind** — the turn-time tool loop over the new nodes is the entire chat channel (LLM-EXCHANGE lane 1). `schema.lookup` answers the model's artifact-type asks for the three new types (lane-1 schema access, no RFC 0021 envelope kind).

### The 10-row evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package architecture** | **Extends `campaign-brief`** (ADR 0156) — the ADR 0356 precedent (extend, no new toggle). New code under `features/campaign-brief/` (`vocService.ts`, `angleService.ts`, `hookBankService.ts`, `targetingService.ts` + route additions). **No `feature.market-intel.*` package** (Alternative 1; avoids the `vendor.myndhyve.market-intel-*` namespace collision). |
| 2 | **Toggle / admin UI** | **No new toggle** — gated by the existing `campaign-brief` toggle (OFF, `tenant`, `Marketing`). The feature description in `feature.ts` gains a clause; the disable-lock graph is unchanged. |
| 3 | **Context surface reads** | Extend `ctx.features['campaign-brief']` (`surface.ts`): add `listVocEvidence` / `listAngles` / `listHooks` / `getTargetingPack` (tenant-trusted reads, org-visibility gated) and add `hooks` to the `assembleContext` projection so `campaign-channels.generate` reads tested hooks the same way it reads the kernel. Writes stay narrow justified-surface ops (`persistVoc`/`persistAngles`/`promoteHook`/`persistTargeting`). |
| 4 | **Node pack** | `feature.campaign-brief.nodes` **+3 nodes** (`extract-voc`, `generate-angles`, `build-targeting`) → **pin bump** in three places (pack.json version, `feature.ts requiredPacks`, the pack-parity test). Reads flow through the surface projection; the three new WRITE-capable nodes get manifest input-docs + `index.mjs` + version bump. |
| 5 | **Artifact-type pack** | **New** `feature.campaign-brief.artifact-types` (`kind:"artifact-type"`, RFC 0075) registering `campaign-brief.{voc-evidence,ad-angle,targeting-pack}` — schemas served + `schema.lookup`-discoverable. The `feature.campaign-channels.artifact-types` precedent. |
| 6 | **Envelopes** | **None new.** Chat-driven research rides the existing agent+tool turn-time loop (lane 1); artifact schema asks ride `schema.lookup`. **No new RFC 0021 envelope kind** (per the ADR: node/artifact schemas are tool asks, not envelope kinds). |
| 7 | **Public surface** | **None.** All routes authed under `/v1/host/openwop-app/campaign-brief/*`. Intel artifacts are internal marketing assets — never public-served. |
| 8 | **RBAC** | **Unchanged.** Reads ride the tenant-trusted surface with the org-visibility gate (the notebooks precedent — a subjectless run serves org-visible only). Writes go through campaign-brief routes carrying the same `accessControl` as personas/briefs. **PII:** a VOC quote can contain customer PII (a review naming a person) → `voc-evidence` is added to `declarePiiFields('campaign-brief.voc-evidence', …)` and rides the retention/erasure seams (ADR 0381). |
| 9 | **Replay / determinism** | **State invariant — research runs snapshot sources by content hash.** `extract-voc` records the resolved source text + `contentHash` as part of its recorded node output (and stamps `contentHash` into each `sourceRef`). A `:fork`/replay reads the recorded evidence — it **never silently re-fetches** live web/reviews/KB (the ADR 0101 "no re-dispatch on replay" guarantee + the notebooks "ingested source is a KB document" pattern). Web bodies are fenced untrusted at acquisition time. Downstream `generate-angles` / `build-targeting` are `ctx.callAI` nodes whose outputs are likewise recorded. |
| 10 | **Frontend** | An **intel workspace** inside the existing `/campaign-brief` area (a new tab / sub-route per brief — **not** a new top-level surface): an **evidence browser** (quotes with source deep-links + theme/sentiment facets), an **angle + hook bank** viewer (angles → their proof quotes; hook bank filterable by status), and a **targeting-pack viewer** (per-platform). Built on the shared `ui/` layer. Recorded artifacts also surface through the existing run/artifact workbench. **Full en/es/fr/pt-BR i18n** — the `check-i18n` gate is FATAL. |

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **1 — VOC** | `voc-evidence` type + `vocService` (persist/list, IDOR, `declarePiiFields`) + routes · `extract-voc` node (kb/notebooks/web-search acquisition, fenced, citation-mandatory, closed-world + 1 repair, typed failure) · `feature.campaign-brief.artifact-types` pack (voc-evidence) · surface `listVocEvidence` · Strategist allowlist +1 · tests (incl. "quote without sourceRef → typed finding" + "replay reads recorded evidence, no re-fetch") | backend tsc + tests; boot installs packs |
| **2 — Angles + hook bank** | `ad-angle` + `hook` types + `angleService`/`hookBankService` (org-scoped hook bank) + routes · `generate-angles` node (evidence+persona+kernel → angles; empty `proofRefs` → typed failure; emit candidate hooks) · artifact-type pack +1 (ad-angle) · surface `listAngles`/`listHooks` + `hooks` in `assembleContext` (channels read it) · promote-hook route · tests (incl. "angle proofRef must resolve") | backend tsc + tests |
| **3 — Targeting** | `targeting-pack` type + `targetingService` + routes · `build-targeting` node (platform-parameterized) · artifact-type pack +1 (targeting-pack) · surface `getTargetingPack` · tests | backend tsc + tests |
| **4 — Workflow-template seeds + FE** | Seed a `market-intel` research chain (`extract-voc → generate-angles → build-targeting`) as a `tmpl.*`-tagged builtin workflow the Strategist can compose-and-run · `frontend/react/src/features/campaign-brief/` intel workspace (evidence browser · angle/hook bank · targeting viewer) · client · en/es/fr/pt-BR | `npm run build` green |

Each phase: **`/architect` before** · implement · **`/code-review` + `/ux-review` after, apply fixes**. LLM-EXCHANGE-AUDIT: land each new node with its tracker row + a `promptCatalogParity`/`agent-prompt-tool-ids` tripwire (schema-SSoT parity — the artifact schema the model sees is generated from the registered artifact-type SSoT, not hand-copied).

## Alternatives considered

1. **A standalone `market-intel` feature-package.** Rejected on two counts. (a) **Namespace collision** — `vendor.myndhyve.market-intel-*` (ADR 0174) already owns "market-intel" for performance variance; a second `market-intel` would be the parallel-architecture tripwire. (b) **It composes `campaign-brief`** — VOC enriches personas, angles reference the kernel, the hook bank feeds the channel workflows through the existing `assembleContext` projection. A separate package would fork the persona/brief seam it depends on. Extending `campaign-brief` (the ADR 0356 precedent) keeps one owner.
2. **An external research-API vendor (dedicated VOC/review-mining SaaS).** Rejected — acquisition (KB/notebooks/ADR 0101 web search), grounding, BYOK, and replay fidelity already live on the existing seams. An external service is at most an outbound-MCP concern (inbound content `<UNTRUSTED>`-fenced), never a new in-app subsystem; it would also move source bodies off the host where the fencing + content-hash snapshot invariant can't be enforced.
3. **VOC as new evidence-carrying fields on `Persona` (fork `personaService`).** Rejected — evidence has its own lifecycle: one quote can support many personas/briefs, evidence is browsed and re-cited independently, and it carries PII that shouldn't inflate the persona blob. Evidence is a first-class store that *references* personas (`personaHint`), the persona/brief split precedent (ADR 0156 Alternative 3).

## Open questions

1. **Source ToS / compliance for third-party reviews.** The app **does not ship a review-site scraper**. Sources are user-supplied (uploaded docs, pasted transcripts, URLs the user fetches via the ADR 0101 web-search seam). Mining VOC over third-party review platforms is the **operator's/user's compliance responsibility**; this ADR flags it explicitly and declines to add any crawler. Decision needed: whether to surface a one-time in-product consent/notice on the `extract-voc` surface.
2. **Multilingual VOC.** Source material may be non-English. v1 preserves the **original-language quote** in `voc-evidence.quote` (never silently translated — a translated "quote" is no longer a citation) and leaves optional translation to a follow-on. The UI i18n (×4) is orthogonal to the *content* language of a quote.
3. **Theme taxonomy.** `sentiment` is a closed vocabulary (`pain|desire|objection|praise`); `theme` is free-text v1. Open: whether to promote `theme` to a per-tenant closed vocabulary to power cross-brief evidence rollups (defer until a rollup consumer exists — the ADR 0082 "no store without a consumer" law).

## Consequences

- Closes the GAP-ANALYSIS §Marketing "market intel" PARTIAL and the "objection mining" PARTIAL with **purpose-built, grounded, replay-safe** nodes — no new subsystem.
- Adds three nodes (one pin bump), one artifact-type pack, four KV-blob stores, four service files, one FE tab, and an allowlist bump. **No new toggle, no new agent, no new chat, no core edits beyond registry appends, no wire change.**
- Unblocks a richer channel-generation grounding (channels can echo *tested hooks*, not just the kernel) and evidence-grounded personas.

## Implementation log

All four phases implemented 2026-07-17 on `feat/adr-0403-market-intel`.

| Phase | Commit | Tests |
|---|---|---|
| 1 — VOC | `6ea37ded` | `campaign-brief-voc.test.ts` (service/surface/node incl. citation-drop findings + typed failures + parity pin) · `campaign-brief-voc-routes.test.ts` (RBAC/IDOR) |
| 2+3 — Angles/hooks/targeting | `1d98cc8d` | `campaign-brief-angles.test.ts` · `campaign-brief-hooks-routes.test.ts` (lattice, 409 guard, IDOR) |
| 4 — Chain + channels echo + FE | `1cb1b544` | `campaign-brief-intel-workflow.test.ts` · consumption pin in `campaign-brief-kb-integration.test.ts` |

**Correction notes** (implementation vs the proposal — rationale trail preserved):

1. **Source acquisition (§ node contract 1):** `extract-voc` acquires via **`kb.rag` only** in v1. Live-URL acquisition remains the upstream chat/ADR-0101 web-search seam (a pack node cannot invoke provider-native web search directly); `notebooks.getSourceText` support is a follow-on. The `sourceKind` vocabulary (`kb|notebook|web|manual`) is future-proofed for both.
2. **Stronger grounding than specified:** rather than validating model-emitted `sourceRef`s, the node has the model cite a retrieved-context **index** and builds every `sourceRef` itself (documentId + `chunk:<n>` locator + sha256 of the chunk) + verifies the quote appears verbatim in that chunk. The same index→id mapping grounds `proofRefs` (generate-angles) and `evidenceRefs` (build-targeting), with the surface re-validating closed-world at persist time.
3. **Hook artifact-type id:** registered as **`campaign-brief.hook`**, not the proposal's bare `hook` (namespace hygiene in the shared artifact registry — architect ruling).
4. **Hook promotion is route-only:** `candidate→tested→retired` (a transition lattice) is deliberately NOT a surface op — the agent must never self-certify hooks, because `assembleContext` projects **tested-only** hooks (capped 20) back into channel generation.
5. **Referential integrity addition:** evidence curation-delete is a typed **409 `evidence_cited`** while an angle or targeting pack cites it; brief-delete cascades evidence + angles + targeting while the org hook bank deliberately survives.
6. **Chain home (§ Phase 4):** the research chain registers as **`BackendFeature.builtinWorkflows`** (`campaign-studio.market-intel`, the CHANNEL_WORKFLOWS/ADR 0072 seam), not a `tmpl.*` entry — `tmpl.*` stays deterministic-stub-only per the established rule.
7. **`contentHash` validation:** strict hex (`/^[a-f0-9]{16,128}$/`), not `cleanString` — the shared secret-shape scrub redacts any ≥40-char opaque blob, which every sha256 digest is.
