# ADR 0946 — Creative variant factory

Status: Proposed

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

### D4 — Brand-kit locks enforced by construction

`Brand` gains `creativeLocks` (extends `features/brand`, no new store):
`{ logo: {required, zones, minPx}, textColours: string[], backgroundColours:
string[], fonts: string[], overrideBounds: {maxScale, maxOffsetPct},
requiredDisclaimer? }`. The renderer clamps nudges to `overrideBounds`, refuses
non-listed colours and fonts, and refuses a template whose logo slot violates the
zone. Editing locks follows the existing `governance.lockLevel` RBAC; agents have
no tool that edits them. Pre-flight re-checks the result, so a lock bug shows up
as a finding rather than passing silently.

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
`pageId@version`. Page experiments stay in `pageExperimentsService` until 0949
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
| 10 | Frontend | A **Variants** tab in the `/campaign-studio` hub: concept board (columns = concepts, rows = channels), diversity map, pre-flight findings per member, version history. 4-locale. |

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
