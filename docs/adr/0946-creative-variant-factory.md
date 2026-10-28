# ADR 0946 — Creative variant factory

Status: Accepted (P0–P3/P5 recovered; P4/P6 open; integration qualification pending)

> **Recovery correction (2026-10-25, P0 erasure):** discovery snapshots are not
> write authority. Campaign attribution erasure uses the existing
> `mutateCampaign` writer, which preserves concurrent edits and retirement.
> Variant versions are freshly read and compare-and-swapped; a deleted row is
> skipped, and persistent contention fails retryably rather than reporting a
> completed erasure. Four storage-race regressions are authored; recovery
> qualification is pending.

Date: 2026-10-19

Program: Campaign Studio (ADRs 0941–0962), Tier 1 — creative + pages. Depends on
**0941** (canonical `MarketingCampaign`), **0942** (gates + the `creative.generate` action
class), **0943** (agent per node), **0945** (grounded product creative +
fidelity), **0933** (the one content-rules library). Consumed by **0947**
(proofing reviews a variant set), **0948** (landing variants on funnels), **0949**
(experiments use members as arms), **0950** (promotion records the winner),
**0952/0953** (launch). Net-new feature design, not a MyndHyve port.

## Context

A campaign needs many ads, not one: several angles, per-channel sizes, copy,
images, video and a landing page that matches each. Two market facts shape the
design:

- **Meta's Andromeda retrieval** groups near-identical creatives and treats them
  as one candidate; Meta's own guidance since late 2025 is concept
  **diversity**, not ten recolours of one ad. Tools that "generate 50 variants"
  mostly generate near-duplicates.
- **Adobe GenStudio** pre-flights brand, channel and accessibility before
  review; **Smartly** builds catalog-driven variants per placement; **Pencil**
  keeps brand/legal/performance review in the workflow. None ties copy, image,
  video and landing page into one reviewable, versioned unit that an
  experiment and an approval can both name.

This ADR defines that unit — a **VariantSet** — and the chain that fills it.

## Boundaries audit (state on `docs/campaign-studio-program` at `7ad955ce1`)

Paths are under `backend/typescript/src/` unless they start with `docs/`,
`packs/` or `frontend/`.

**Reused, not rebuilt:**

- **Per-format fan-out exists.** `feature.creative-briefs.nodes.render-variants`
  renders one brief across a template family, reporting per-template failures
  (`packs/feature.creative-briefs.nodes/pack.json`). Templates carry platform and
  pixel size (`features/creative-briefs/render/templates.ts:62-64`, e.g.
  `meta.feed.1x1` `:264`, `tiktok.9x16` `:297`, ten Google Display sizes
  `:94-245`); safe zones are advisory warnings (`renderService.ts:407`).
- **Copy channel generation exists.** The `ad_variants` channel yields
  `platformSets` with per-item refine (`features/campaign-channels/channelWorkflows.ts:25`).
- **A near-duplicate check exists.** `findNearDuplicates` — token-set Jaccard,
  "a pack-local stand-in for embedding cosine" (`packs/feature.campaign-channels.nodes/platformLimits.mjs:66-85`).
- **A text embedder exists.** `resolveHeadlessEmbedder` (`host/headlessAi.ts:471`),
  BYOK-honest.
- **The campaign→asset edge exists but is flat.** `MarketingCampaign.assetIds?:
  string[]` (`features/campaign-orchestration/types.ts:37-39`) — no grouping, no
  concept, no channel, no version.
- **Experiments assign through one helper.** `assignWeightedVariant`
  (`host/variantAssignment.ts:46`); page experiments hold page variants only
  (`features/cms/pageExperimentsService.ts:61-76`).
- **Alt text is a media field** (`features/media/mediaService.ts:100-101`).

**Gaps and duplication risks:**

| # | Finding | Evidence |
|---|---|---|
| V1 | No entity groups copy + image + video + landing for one campaign | `assetIds` only; grep `VariantSet`: no hits |
| V2 | "Variant" is only dedupe. No concept axes, no diversity score | `platformLimits.mjs:66-85` |
| V3 | Channel specs live in **four** places: copy caps (`platformLimits.mjs:9-22`: `PLATFORM_LIMITS`, `SOCIAL_LIMITS`, `AD_FIELD_SCHEMA_MAX` — note Google headline 30 vs schema max 70), render template sizes (`templates.ts`), CTA presets (`packs/vendor.myndhyve.ads-platforms/index.mjs:45, 532`), and `vendor.myndhyve.ads-creative-validate`, which duplicates `ads.policy.check`'s rule list (ADR 0933 audit) | as cited |
| V4 | Brand "lock" means edit rights only (`lockLevel`, `features/brand/types.ts:99-110`). The renderer accepts any finite `dx/dy/scale` per layer (`renderService.ts:272-287`), so a logo can be scaled or pushed off-canvas | as cited |
| V5 | ADR 0933's library covers pages and emails only; media codes and ad destinations were explicitly deferred ("Later: CTA presets with the first ad destination") | `docs/adr/0933-campaign-ops-content-rules.md` D3.6, phased plan |
| V6 | No contrast check on rendered text; no caption check on video | grep `contrast` in `features/creative-briefs`: none |
| V7 | The channel child workflows are in-tree `WorkflowDefinition`s (`channelWorkflows.ts:16`, `:58-59`) — the deprecated ADR 0072 shape. The factory must not add another | `CLAUDE.md` § Workflows |
| V8 | Naming collision: campaign-ops `CampaignAsset` (a destination: page/email, ADR 0922 D1) vs media `MediaAsset` vs `MarketingCampaign.assetIds` (media ids). Both services export `getAsset` (`features/campaign-ops/assetService.ts:43`, `features/media/mediaService.ts:532`) | as cited |

## Decision

### D1 — `VariantSet`: one versioned unit per campaign creative round

Owned by the canonical campaign owner (0941), in
`features/campaign-orchestration/variants/`:

```ts
interface VariantSet {
  setId: string; tenantId: string; orgId: string;
  campaignId: string;                       // 0941 MarketingCampaign.id — required
  version: number; hash: string;            // sha256(canonical members + concept ids)
  status: 'draft' | 'preflight' | 'in_review' | 'approved' | 'superseded';
  productRefs?: Array<{ productId: string; role: 'primary' | 'secondary' }>; // copied from 0941
  concepts: Concept[];
  members: VariantMember[];
  diversity: DiversityReport;               // D2
  preflight?: { rulesetVersion: string; digest: string; findings: ContentFinding[] }; // D5
  createdByRunId?: string;
  createdAt: string; createdBy: string;
}
interface Concept {
  conceptId: string;
  axes: { angle: string; personaId?: string; hook: HookType; visual: VisualTreatment; format: FormatFamily };
  rationale: string;                        // the agent's reason, shown in review
}
interface VariantMember {
  memberId: string; conceptId: string;
  channel: ChannelSpecId;                   // D3, e.g. 'meta.feed', 'google.rsa', 'email', 'landing'
  kind: 'copy' | 'image' | 'video' | 'landing' | 'email';
  ref: { mediaAssetId: string } | { pageId: string; pageVersion: number }
     | { emailTemplateId: string; version: number } | { copy: Record<string, string> };
  contentHash: string;
  renderId?: string;                        // ADR 0399 render, when composed
  productRef?: { productId: string; variantId?: string }; // per-member binding (0941 Q3)
  fidelityVerdictId?: string;               // ADR 0945, when it depicts a product
}
```

- **Immutable versions** (the ADR 0923/0924 precedent): any change to members
  makes version N+1 with a new hash and marks N `superseded`. 0947 reviews bind
  to `setId@hash`; 0949 arms bind to `setId@version` + `memberId`.
- A member is a **member**, never an "asset" (V8). When a member launches to a
  destination, the launch path (0952/0953, or campaign-ops ADR 0922) registers
  the destination; the member records nothing about destinations.
- `MarketingCampaign.assetIds` stays as the flat library edge; 0941 decides
  whether it becomes a projection of approved members.

> **Correction (2026-10-20, P0 build, /architect):** "marks N `superseded`" is
> not built as a write. Rewriting row N after inserting N+1 is a second write
> with a crash window (N+1 exists while N still reads `approved`), and it would
> make the "immutable" claim false. `superseded` is **derived at read**
> (`version < head`); the stored `status` is `draft | preflight | in_review |
> approved` and only ever changes on the head row, by CAS (P2 pre-flight, 0947
> review). The one other rewrite a version row takes is subject erasure
> tombstoning `createdBy`, which is not content and does not move the hash.
>
> As built in P0:
> - **Store:** one collection, `campaign-orchestration:variantset`, of version
>   rows keyed `${tenantId}::${campaignId}::${setId}::v${000001}` with a tenant
>   index. "Sets of a campaign" and "versions of a set" are prefix reads. A set
>   is reachable only under the campaign it was created in.
> - **Writes:** create is `putIfAbsent` of v1; revise names `baseVersion`. A
>   stale base is a 409 (`variant_set_stale`), unchanged content returns the
>   head (`changed:false`), otherwise v(N+1) is inserted with `putIfAbsent`, so
>   two revisions of N cannot both land. A set is capped at 100 versions
>   (`variant_set_version_cap`); versions are never pruned because reviews and
>   arms bind to them.
> - **Hash:** sha256 over canonical (key-sorted) concepts + members, sorted by
>   id, using the audit chain's `canonicalize`. Status, authorship and
>   timestamps are outside it.
> - **Closed world:** concept axes are closed enums; unknown keys are refused;
>   every member names a concept in the set; `kind` must match the `ref` shape;
>   every ref resolves in the campaign's own org (media by `getAsset`, with an
>   `image/*` or `video/*` content type; email by `getTemplateVersion`; landing
>   by a CMS page version). `contentHash` is computed by the server (the media
>   or email content hash, or sha256 of the canonical copy / page snapshot);
>   a caller-supplied `contentHash` is a 400.
> - **Not yet:** `channel` is shape-checked only until P1's spec table closes
>   it; `diversity` and `preflight` are optional until P2; `productRefs` is
>   unpopulated until 0941 P1 adds the field to the campaign.
> - **Replay readiness for P4:** `createVariantSet` takes an optional
>   deterministic `setId`, and a re-executed create (same id, same hash) or
>   revise (head is `baseVersion + 1`, revised from that base, same hash)
>   returns its own row instead of a duplicate or a 409. **P4's nodes must
>   derive `setId` from the run and node, and must send every concept and
>   member id**, since minted ids are random and would change the hash on
>   re-execution.

### D2 — Concepts first; diversity is scored, not hoped for

Generation is two-level: the Creative Director agent proposes **concepts** over
closed axes (angle, persona, hook type, visual treatment, format family); only
then are members produced per concept per channel. The `DiversityReport`:

- **Concept distance:** weighted count of differing axes, pairwise; the set
  reports mean and minimum pairwise distance and axis coverage.
- **Execution distance:** copy similarity by embedding cosine when the BYOK
  embedder resolves, else Jaccard (`findNearDuplicates`, moved to host — the
  ADR 0933 D7 `verifyClaims` precedent: one implementation, the pack imports it);
  image distance by the ADR 0945 perceptual hash.
- **Clusters:** members in the same ad set whose distance is under a threshold
  form a cluster; a cluster larger than one is a `diversity` finding,
  `needs_review`: "these four ads are likely to be treated as one — replace two".
- Scores and the embedding model id are recorded on the set, so a replay reads
  them rather than recomputing with a different model.
- **Honesty:** we do not know Andromeda's internals. The score is a proxy; the UI
  says so, and 0949/0956 delivery data is the check (Q4).

### D3 — One channel spec table

`host/contentRules/channelSpecs.ts` (inside the 0933 library), a dated,
versioned table: per `ChannelSpecId` — copy field caps, required fields, CTA
presets, image sizes and aspect ratios, video duration/aspect/caption rules,
file-size caps. It absorbs the four sources in V3; `templates.ts` keeps layout
geometry but each template declares the `ChannelSpecId` it satisfies, and the
packs import the host table. Where sources disagree today (Google headline 30 vs
70) the table records the platform's limit and a test pins it.

> **Correction (2026-10-20, P1 build, /architect):** "the packs import the host
> table" cannot be literal. Packs are standalone `.mjs` that import only `node:`
> builtins, which is what keeps them signable and registry-publishable. As
> built:
> - The table is `host/contentRules/channelSpecs.json` (dated, versioned),
>   with typed, load-validated accessors in `channelSpecs.ts`. The ad rule
>   list is `adPolicyRules.json`, and `findNearDuplicates` is
>   `similarity.ts`. These are the first files of the ADR 0933 library
>   directory, which did not exist yet.
> - `scripts/gen-content-rules.mjs` writes a `contentRules.generated.mjs` into
>   each consuming pack, holding exactly what that pack reads. `--check` runs
>   in `scripts/ci.sh`, and `test/adr0946-channel-specs.test.ts` pins every
>   copy. A ctx host surface was rejected: it would make four vendor packs
>   depend on a host feature, and a table edit would silently change a pure
>   node's output across deploys. A generated copy pins the data to the pack
>   version.
> - The 36 ad rows' media, CTA and safe-zone facets are lifted verbatim from
>   `vendor.myndhyve.ads-platforms` 1.0.2, which now reads its generated
>   copy. Its text limits are re-sourced (below), so 19 text-limit values in
>   its output change; everything else is byte-identical across five input
>   shapes. The 9 fixed IAB banner sizes are a separate
>   `google.display-banner` row, because the MyndHyve `google.display` row
>   models responsive ads (1:1 and 1.91:1).
> - `ads-policy` and `ads-creative-validate` carried semantically identical
>   7-rule lists (measured). Both now read the one generated list, with
>   unchanged outputs.
> - Render templates declare `channelSpecId`, and their size is checked
>   against the row (an exact size for a fixed-size row, otherwise within 1%
>   of an image or video aspect ratio).
>
> **Sourced limits (2026-10-20, revised after review).** The first cut of P1
> took MyndHyve's `max` values as platform limits. Many are recommendations,
> so that cut truncated LinkedIn descriptions at 100 when LinkedIn allows
> 300. Every text field now cites its source, retrieved 2026-10-20:
> - `hardMax` is set only from the platform's own published spec page, and
>   load-time validation refuses a `hardMax` without an official URL.
> - `recommended` is a display guideline, from an official or a labelled
>   third-party page.
> - `legacy` is the MyndHyve value it replaced.
> - Of 86 fields, 39 are official, 10 third-party and 37 unsourced. An
>   unsourced field carries no limit.
>
> **Only hard limits block or truncate; recommendations warn.**
> - campaign-channels regenerates and then truncates only over an official
>   hard maximum. Today that means Google (30/90) and LinkedIn (200/300).
> - It warns over a recommendation (Meta headline 27; LinkedIn 70/100; TikTok
>   ad text 100, third-party).
> - Meta and TikTok publish no maximum, so nothing of theirs is truncated.
> - Schema maxLength is the widest hard cap: headline 200, description 300.
> - Social hard caps are LinkedIn 3000, X 280 and Instagram 2200. The legacy
>   Facebook 5000 was unsourced, so Facebook is warn-only (477
>   before "See more", third-party).
>
> The ads-platforms vendor output keeps its shape. `max` is the official hard
> limit where one is published, else the legacy value. 19 fields changed, for
> example LinkedIn feed headline 70→200, Pinterest description 500→800 and
> LinkedIn message CTA 25→20. The PR lists them. **Open for 0952:** the 37
> unsourced fields (YouTube in-stream and bumper, which Google marks N/A;
> Reddit; Snapchat; TikTok; Amazon video and audio; several Meta
> placements) need a platform-side source or an ads-API check before
> anything enforces them.

### D4 — Brand-kit locks enforced by construction

`Brand` gains `creativeLocks` (extends `features/brand`, no new store):
`{ logo: {required, zones, minPx}, textColours: string[], backgroundColours:
string[], fonts: string[], overrideBounds: {maxScale, maxOffsetPct},
requiredDisclaimer? }`. The renderer clamps nudges to `overrideBounds`, refuses
non-listed colours and fonts, and refuses a template whose logo slot violates the
zone. Editing locks follows the existing `governance.lockLevel` RBAC; agents have
no tool that edits them. Pre-flight re-checks the result, so a lock bug shows up
as a finding rather than passing silently.

> **Correction and as-built (2026-10-20, P3):**
> - **V4 was half stale.** The renderer already clamps every nudge globally
>   (`clampNudge`: ±10% of the smaller side, scale 0.8–1.25). What was missing
>   is a *brand* bound. `render/brandLocks.ts` `applyBrandLocks` clamps inside
>   the global clamp, to `overrideBounds`. Offsets are truncated toward zero so
>   a clamped nudge never lands a pixel past the bound. The clamped nudges are
>   the ones rendered, hashed into `compositeHash` and stored, with a
>   `brand-lock-clamped` warning.
> - **Refusals** are a typed 400 `brand_lock_violation` that lists each
>   violation; nothing is drawn. They cover:
>   - a resolved text or background colour outside the lists (the canvas
>     paper, shape fills and the CTA pill count as background);
>   - a font family outside the list;
>   - a required logo that did not resolve;
>   - a logo slot outside the zones or under `minPx`.
>
>   A brief palette accent is the usual way an off-brand colour arrives (the
>   brief wins the accent, ADR 0399 §2), and it is now refused when the
>   brand locks colours.
> - **Lock facts.** Every render now stores `lockFacts` (the colours, fonts,
>   logo slot and nudges it used). That is the producer the P2 `brand-lock`
>   rule reads. **One type:** `BrandCreativeLocks` is the content-rules
>   library's `CreativeLocks`, and `RenderLockFacts` is its `LockFacts`
>   (features import host, never the reverse). A test feeds a locked render's
>   facts through the P2 rule.
> - **Disclaimers.** Templates have no disclaimer layer, so
>   `disclaimerPresent` is false, and a required disclaimer is a P2 pre-flight
>   `block` rather than a render refusal.
> - **Tightened beyond the decision text:** changing `creativeLocks` takes
>   the brand's governance-change bar (org admin, or the creator setting the
>   first lock on an unlocked brand), not only the lockLevel content bar.
>   Locks are guardrails like `compliance`, which already takes that bar.
>   Lock changes are recorded in the brand guardrail audit trail
>   (`AUDIT_FIELDS`). Agents still have no write tool; the brand agent tools
>   are read-only.
> - The locks are sanitized closed-world on write:
>   - colours must be `#hex`, lowercased;
>   - fonts must be family names;
>   - logo zones must be in-bounds percentages;
>   - out-of-range bounds fall back to the renderer's own bounds, never to
>     unbounded;
>   - `null` clears the locks.

### D5 — Pre-flight through the ONE content-rules library (no fifth checker)

This ADR extends ADR 0933's `host/contentRules/` rather than adding a checker:

- **New destinations:** `openwop.ad.<platform>`, `openwop.social.<platform>`, and
  media members (images, video).
- **New rule sets:** `channel-policy` (D3 table; the name 0941 uses), `accessibility` (alt text present and
  not a placeholder; rendered text contrast ≥ 4.5:1 computed from the renderer's
  resolved colours; minimum text size; captions on video), `diversity` (D2),
  `fidelity` (folds the ADR 0945 verdict: `fail` → `block`, `needs_review` →
  `needs_review`), `brand-lock` (D4).
- **Folded in, not duplicated:** brand compliance (`scoreComplianceDeterministic`,
  ADR 0933 D7), the trust/regulated/link rules (ADR 0933 D3), and
  `ads.policy.check`, which becomes a consumer of the library; the duplicate list
  in `ads-creative-validate` is removed (ADR 0933's "Later" row, executed here).
- Same semantics as 0933: deterministic ids, `block | needs_review | info`, the
  report stored on the set with a digest, recomputed at review decision time
  (0947). For a new set every finding is "introduced".

> **As built (2026-10-20, P2, /architect):**
> - **The 0933 finding frame lives here first.** `host/contentRules/findings.ts`
>   holds 0933 D1's `ContentFinding` verbatim, 0933 D4's id
>   (`sha256(ruleId, assetId, field, normalized span)`) and the report digest,
>   with `ruleSet` extended by this ADR's five values. It is the library's
>   single owner of the frame, and 0933's page and email rule sets plug into it.
> - **The rules are pure.** `creative/checkCreative(input)` takes a plain
>   input (concepts, members with copy, media facts, render facts, fidelity
>   verdicts, brand locks, optional embeddings) and returns `{rulesetVersion,
>   asOf, findings, digest, diversity}`. `asOf` is its only clock; embeddings
>   arrive with their model id and are never computed inside it. P4's
>   `preflight` node builds the input from a VariantSet and stores the report.
>   P2 ships no route, node or store write.
> - **Missing facts never pass.** No producer yet supplies video captions, a
>   perceptual hash (ADR 0945) or render lock facts (P3/P4). Rule by rule:
>   - unknown captions → `needs_review`;
>   - no perceptual hash → image distance `not_measured` in the report;
>   - locks with no lock facts → `brand-lock.unverified` (`needs_review`);
>   - text over an image → contrast `info` ("not computed");
>   - a product member with no fidelity verdict → `needs_review`.
> - **Text limits by source:**
>   - over an official `hardMax` → `block`;
>   - over only the unsourced legacy value → `needs_review` (the platform's
>     limit is unconfirmed);
>   - over a `recommended` length → `info`;
>   - an empty field → `block`.
> - **Severities:** the other channel-policy violations, missing or placeholder alt
>   text, contrast below WCAG (4.5:1, or 3:1 for large text), missing
>   captions where the platform requires them, a fidelity `fail`, and every
>   brand-lock violation are `block`. A diversity cluster is `needs_review`
>   (open question 2's proposal, taken). Text under 12px is `needs_review`.
> - **Diversity proxy:**
>   - Concept distance is the share of the five axes that differ.
>   - Two members in one ad set are near when their concepts are within 0.2,
>     and either their copy is at least 0.8 similar (cosine if embeddings are
>     given, else token Jaccard) or their images are within 10 of 64
>     perceptual-hash bits.
>   - With no measurable modality, the same concept in one ad set counts as
>     near.
>   - The thresholds are part of `CREATIVE_RULES_VERSION`, which also embeds
>     the channel table's version, so a table edit moves the digest.
> - **The 0933 owner's review (2026-10-20):**
>   - (a) canonical JSON moved to the pure `host/canonicalJson.ts`, so the
>     library imports no storage. The audit chain re-exports it, pinned
>     byte-identical by `test/canonical-json-audit-identity.test.ts`.
>   - (b) a golden digest vector.
>   - (c) same-id findings merge order-independently, and a block is never
>     dropped.
>   - (d) `rulesetVersion` is per family (`creative@…`).
> - **Not in P2:** folding `ads.policy.check` and the brand deterministic score
>   into the same report. Those consumers are packs and features that the P4
>   preflight node composes; the shared rule list already lives in the
>   library (P1).

### D6 — The factory is a chain, with an agent per node, under 0942 gates

Chain pack `campaign-studio.variant-factory` (`kind:"workflow-chain"`, RFC 0013 /
ADR 0163, under `packs/`), never an in-tree definition (V7):

1. `read-campaign` (campaign, brief, products via 0945 `resolveProductMedia`,
   brand locks, client memory via 0944) — Strategist.
2. `propose-concepts` — Creative Director; closed concept schema, one repair.
3. **gate** — 0942's `autonomy-gate` node with class `plan.approve` (the concepts
   are the basis for spend); the campaign's policy decides whether a human picks
   concepts or it passes.
4. **cost estimate** against the ADR 0106 media budget (0942's `creative.generate`
   chokepoint) for the planned members;
   over budget → typed `variant_budget_exceeded`, never a partial silent run.
5. Fan-out per concept (RFC 0118 parallel dispatch) into sub-chain
   `variant-factory.concept`: copy (Copywriter) → image via ADR 0945 modes →
   fidelity → optional video → optional landing variant (D7).
6. `assemble-set` → `score-diversity` → `preflight` (D5).
7. Hand the set to the 0947 review chain (its stages are the gates).

Every writing node is `side-effect`; partial failures are reported per member,
never dropped. The chain is visible in `/builder` and the `/` picker because it
instantiates through `…/workflows/from-chain`.

### D7 — Landing variants reuse CMS

A landing member is a CMS **draft** page created through the CMS service (a
duplicate of the campaign's base page with section overrides), referenced by
`pageId@version`.

> **Correction (2026-10-20, P0 build):** a CMS draft has no version row until it
> is snapshotted (submit, publish or a seed offer), and `pageId@version` must
> name an immutable snapshot for the set's hash to mean anything. P0 resolves
> `pageVersion` against the page's `PageVersion` rows in the campaign's org, so
> P4's landing step must snapshot the draft before adding the member. Page experiments stay in `pageExperimentsService` until 0949
unifies them. This ADR adds no page model.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Extends `campaign-orchestration` (`variants/` module: store, service, routes, surface). Library extensions in `host/contentRules/` (0933). Brand locks in `features/brand`. |
| 2 | Toggle | Sub-toggle `campaign-orchestration.variant-factory`, default **OFF**, `bucketUnit:'tenant'`, an `extraToggleDefaults` entry of `campaign-orchestration` (ADR 0941 D5 toggle rule; no `dependsOn`, AND-gated in code with `campaign-orchestration` and `creative-briefs`). |
| 3 | Workflow surface | `ctx.features.campaignOrchestration.variants.{get, list, propose, assemble, scoreDiversity, preflight}`; every op takes `orgId` and `campaignId`. |
| 4 | Node pack | `feature.campaign-orchestration.nodes` + `propose-concepts`, `assemble-set`, `score-diversity`, `preflight`; chain pack `campaign-studio.variant-factory` (+ sub-chain). |
| 5 | Envelopes | None. Concepts and members reach durable state through closed schemas and the set service. |
| 6 | Agent pack | Uses the 0943 roster (Strategist, Creative Director, Copywriter, Compliance Reviewer); no new agent. |
| 7 | Public surface | None (client review is 0947). |
| 8 | RBAC | `workspace:read`/`write` on the campaign's org via `authorizeOrgScope`; cross-org set → uniform 404. |
| 9 | Replay / fork | Side-effect writers; recorded diversity scores and embedding model id; pre-flight `asOf` stored (0933 D5). |
| 10 | Frontend | A **Variants** tab in the `/campaign-studio` hub: concept board (columns = concepts, rows = channels), diversity map, pre-flight findings per member, version history. 4-locale. **As built (P5):** a **Variants section on the campaign detail** at `/campaigns` (where a campaign opens; `/campaign-studio/:canvasId` is the ADR 0153 canvas editor, not a hub). It is lazy, in its own chunk, so the entry chunk is unchanged. It is read-only, because sets are made by the factory chain or the API and every edit is a version. It renders nothing when the sub-toggle is off. Diversity and pre-flight show as "not scored / not run yet" until P2/P4 store them. |

## Why this is our advantage

- **A durable graph with a named agent per node:** strategist, art direction,
  copy and compliance are separate governed steps with their own tools, not one
  "generate 50" button.
- **Gates by the campaign's autonomy policy (0942):** the same chain runs
  hands-off for one client and concept-by-concept for another.
- **One versioned unit:** review (0947), experiments (0949) and promotion (0950)
  all name `setId@hash`, so "which version won, who approved it, against which
  rules" is a join, not a forensic exercise. Replay shows why each concept exists.
- **Concept diversity as a measured property** — competitors either ignore it or
  generate near-duplicates at scale.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | `VariantSet` store + service + routes, immutable versions, hash | Route tests: cross-org 404; a member edit makes a new version and supersedes the old |
| P1 | D3 channel spec table; move `findNearDuplicates` + limits to host; packs import it | One table, pinned by test; the duplicate rule list in `ads-creative-validate` removed |
| P2 | D5 rule sets (channel, accessibility, diversity, fidelity, brand-lock) in `host/contentRules/` | Positive and negative fixture per rule; sabotage: removing a rule reddens a test |
| P3 | D4 brand locks in the renderer | Witness: an over-scaled logo nudge is clamped; a non-brand colour is refused |
| P4 | Chain pack + sub-chain + nodes (D6), budget estimate | Chain loads via the chain loader, shows in `/builder`; a fork re-dispatches nothing |
| P5 | Frontend Variants tab | `npm run build` green; light/dark |
| P6 | Link to 0949 arms; record winners from 0950 | Arms reference `setId@version#memberId` |

### Implementation record

| Phase | What shipped | Tests |
|---|---|---|
| P5 (2026-10-20) | `frontend/react/src/features/campaign-orchestration/CampaignVariantsSection.tsx` (lazy) and `variantsClient.ts`, mounted on the campaign detail; 4-locale copy; DESIGN.md §5 row. Entry chunk flat (468 B headroom on the base, 493 B after; i18n chunk −2 B). | `campaignVariantsSection.test.tsx` (3). Sabotage: a failed read shown as empty, the card rendered when off, and the head shown instead of the chosen version each red a case. |
| P0 (2026-10-20) | `features/campaign-orchestration/variants/` (types, service, routes, erasure): immutable version rows, hash, derived `superseded`, closed-world refs, replay-idempotent create/revise; routes under `…/campaigns/:campaignId/variant-sets` gated on `campaign-orchestration` + sub-toggle `campaign-orchestration.variant-factory` (OFF, tenant) + `creative-briefs`, access through the campaign's own scoped read; campaign delete purges its sets; data export includes every version; the eraser tombstones `createdBy` on version rows and on campaigns (taking `campaign-orchestration:campaign` off the actor-attribution debt ledger, 20 → 19). Ratchet: undeclared feature edges 99 → 100 (`campaign-orchestration → email`). | `test/adr0946-variant-sets.test.ts` (14). Sabotage witnesses: no stale-base check, `put` for v(N+1), tenant-only media lookup, status not derived, no campaign-delete hook — each reddens its named case. |
| P1 (2026-10-20) | `host/contentRules/` (`channelSpecs.json` + `.ts`, `adPolicyRules.json` + `.ts`, `similarity.ts`); `scripts/gen-content-rules.mjs` (+ `--check` in `scripts/ci.sh`); campaign-channels.nodes 1.16.0 (recovery composition), ads-platforms / ads-policy / ads-creative-validate 1.1.0 read generated copies; templates declare `channelSpecId`. Behaviour change (pinned): copy QA enforces only official hard limits (Google 30/90, LinkedIn 200/300) and warns on recommendations; schema max headline 70 → 200, description 150 → 300; the unsourced Facebook post cap is dropped. | `test/adr0946-channel-specs.test.ts` (9). Sabotage: a hand edit to a generated copy, enforcing recommendations as caps, and pointing a template at a row its size does not satisfy each red a named case. |
| P2 (2026-10-20) | `host/contentRules/findings.ts` (the 0933 frame) and `host/contentRules/creative/` (`checkCreative`; `channel-policy`, `accessibility`, `diversity`, `fidelity`, `brand-lock`; 33 rule ids). Pure, with no route, node or store write. Stacked on P1 (#5091) for `channelSpecs.ts`. | `test/adr0946-creative-rules.test.ts`: one clean negative fixture for every rule, one positive fixture per rule id, and a source scan that fails when a rule id has no fixture. |
| P3 (2026-10-20) | `Brand.creativeLocks` + `sanitizeCreativeLocks` (features/brand), the governance-change bar and the audit field for lock changes; `creative-briefs/render/brandLocks.ts` `applyBrandLocks` wired into `renderForBrief` (clamp, refuse, `lockFacts` on the render). | `test/adr0946-brand-locks.test.ts` (8). Witnesses: an over-scaled logo nudge is clamped, and a non-brand colour is refused (unit and route). Sabotage: removing the `maxScale` clamp, the background-colour check or the PATCH gate each reddens its case. |

## Alternatives weighed

- **Keep variants as loose media ids on the campaign.** Rejected: no version, so
  an approval or an experiment cannot name what it covered.
- **One variant set per channel.** Rejected: the landing page and the ad that
  points to it must be reviewed and tested together.
- **Put VariantSet in `creative-briefs`.** Rejected: a brief is one asset's
  production document; the set spans copy, email and pages and belongs to the
  campaign.
- **A diversity model from a vendor.** Deferred: the proxy is cheap and honest;
  revisit with delivery data.
- **A new pre-flight checker for ads.** Rejected: it would be the fifth checker
  ADR 0933 exists to stop.

## RFC verdict

**Host extension, no RFC.** Routes under `/v1/host/openwop-app/campaign-orchestration/*`,
`ctx.features.*`, a chain pack on Accepted RFC 0013 + RFC 0118. Nothing advertised.

## Open questions

1. **(David)** Default concept count and member cap per set (cost)? Proposed:
   4 concepts × the campaign's channels, capped by the media budget.
2. **(David)** Is a diversity cluster `needs_review` (proposed) or `block`?
3. **(David)** Landing variants in v1, or ads + copy first? Proposed: v1 includes
   one landing variant per concept, as CMS drafts.
4. How is the diversity proxy validated? Proposed: 0956 compares cluster size to
   per-ad delivery share after 30 days; thresholds adjust by ruleset version.
5. Can a variant set exist without a campaign (an ad-hoc creative round)?
   Proposed: no — 0941 makes the campaign the root.
6. The 0933 library is campaign-ops-owned today. Who owns `channelSpecs.ts`?
   Proposed: the library owner, with 0952/0953 adding platform rows.

## Planning rows

**ROADMAP (Campaign Studio program table):**

| Order | Item | Toggle | Depends on | Pack slug | Wire / RFC gate | Status |
|---|---|---|---|---|---|---|
| T1-2 | **Creative variant factory** ([ADR 0946](docs/adr/0946-creative-variant-factory.md)) | `campaign-orchestration.variant-factory` (sub-toggle) | 0941, 0942, 0943, 0945, 0933, 0399 | `feature.campaign-orchestration.nodes`, chain `campaign-studio.variant-factory` | Host extension (RFC 0013/0118 Accepted) | 🔵 Proposed |

**FEATURES "Future features":**

- **Creative variant factory (ADR 0946, Proposed 2026-10-19)** — one versioned
  `VariantSet` per campaign round tying copy, images, video, email and landing
  variants to concepts; concept-first generation with a measured diversity score
  (copy embeddings, image perceptual distance, near-duplicate clusters flagged,
  for Meta Andromeda-style grouping); one dated channel-spec table; brand-kit
  locks enforced in the renderer; pre-flight through the ONE ADR 0933
  content-rules library (channel, accessibility, fidelity, brand-lock rules). Runs
  as the chain `campaign-studio.variant-factory` with an agent per node under 0942
  gates. Sub-toggle `campaign-orchestration.variant-factory` (OFF, tenant).
  Host-ext, no RFC.


Recovery focused-validation checkpoint — 2026-10-25: all recovered P0/P1/P2/P3/P5
histories remain ancestors of the composed branch. The route/store suite now
exercises actual owner-issued render, verdict and product ids (including their
bytes/product binding), legacy media byte hashing, disabled Email references,
and erasure races with concurrent rename/deletion/contention. The broader
creative/variant focused backend suites and variant section frontend suite are
green after fixing two incomplete test fixtures. Generated content-rule copies,
served/steward metadata, pack argument parity and dependency measurements have
been refreshed; no ceiling was raised. Native types, frontend lint/test types
and 65 focused frontend cases are green. Canonical CI and rollout remain
pending; P4 generation and P6 experiment wiring are not claimed as recovered.

Recovery re-measurement — 2026-10-25, on the merge with main `7981e512c`
(slot 73): the variant-set erasure cases (retired campaign, concurrent campaign
edit, version removed after discovery, retryable contention), owner-ref
resolution, legacy media bytes, Email-off refusal and brand locks all pass. A
new case pins the Creative-Briefs-off leg of the `campaign-orchestration →
creative-briefs` read (the whole variant route 404s), which the ADR 0439
ratchet now counts (115 → 117 with `creative-briefs → commerce`). Brand
updates still go through `brands.compareAndSwap`. The bumped packs
(`feature.campaign-channels.nodes` 1.16.0, `vendor.myndhyve.ads-*` 1.1.0) are
not production-pinned, so they ship vendored; no new pin is needed.
P4/P6 remain open.
