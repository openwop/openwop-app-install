# ADR 0945 — Product-grounded creative and fidelity verification

Status: Proposed

Date: 2026-10-19

Program: Campaign Studio (ADRs 0941–0962), Tier 1 — creative + pages. Depends on
**0941** (the campaign↔product link on the canonical `MarketingCampaign`),
**0942** (the one gate primitive and per-campaign autonomy), **0943** (the agent
bound to each node). Consumed by **0946** (variant factory), **0947** (proofing),
**0952** (paid media launch), **0953** (social publishing). Net-new feature
design, not a MyndHyve port.

## Context

David's ask: "auto-generate video and images for ads and socials from REAL
product images and assets." The market shows why "real" is the whole point:

- **Meta Advantage+** enables AI creative "enhancements" by default and swaps
  creative silently; brands (True Classic, Kirruna) found ads running with
  generated imagery that did not match what they sell.
- **Google Product Studio** imports real Merchant Center images but warns it
  "may produce unexpected images"; PMax and AI Max give "transparency without
  control".
- Smartly, Pencil, Typeface, Adobe GenStudio and Canva score brand and channel
  compliance. **None verifies a generated asset against the real catalog
  product.** None records which source image, model and prompt produced an ad.

An ad that shows the wrong logo, colour, shape or label is false advertising, a
returns problem and a platform-policy risk. This ADR makes the catalog product's
own imagery the **only** allowed depiction of the product, checks every
generated output against it, and stamps provenance on every generated asset.

## Boundaries audit (state on `docs/campaign-studio-program` at `7ad955ce1`)

Paths are under `backend/typescript/src/` unless they start with `docs/`,
`packs/` or `frontend/`.

**Reused, not rebuilt:**

- **Product catalog (ADR 0410).** `Product.imageAssetTokens: string[]`
  (`features/commerce/commerceService.ts:250`); `getProduct` org-checks
  (`:448-451`); `ctx.features.commerce.getProduct` (`features/commerce/surface.ts:77`).
- **Media owns every byte and its lineage.** `MediaAssetLineage`
  `{derivedFrom, generatedBy:'ai', prompt, model, provider, op, rightsNote}`
  (`features/media/mediaService.ts:36-51`), sanitised by ONE closed-vocabulary
  `cleanLineage` (`:323-339`) that `createAsset` always applies (`:397`, `:425`).
- **Edit ops already exist and never mutate the source.** `POST …/assets/:assetId/ai-edit`
  (`edit | inpaint | background-remove`, `features/media/imageGenRoutes.ts:260-283`)
  and `…/ai-upscale` (`:286`) write a NEW asset with `derivedFrom`
  (`:249`); the honest provider matrix `IMAGE_OP_SUPPORT`
  (`providers/dispatchImages.ts:180-184`) turns an unsupported op into a typed
  `host_capability_missing`.
- **A deterministic compositor with a product layer.** The ADR 0399 renderer
  takes `layers.product` as a media asset id (`features/creative-briefs/render/renderService.ts:355-370`),
  records each layer's `sha256` in `layerAssets`, and hashes the whole composite
  (`compositeHashOf`, `:300`, `:411`). Server-side SVG→PNG via `@resvg/resvg-js`.
- **One vision seam.** `resolveHeadlessAi(tenantId, 'image')` already drives
  autotag (`features/media/mediaService.ts:937`) and alt text (`:997`), with
  honest 422 when no vision provider exists.
- **Video jobs.** One `videoService` job pipeline over the broker
  (`features/creative-video/videoService.ts:130-153`), `requestHash` submit-once
  (`:366`), the `creative-video.t2v` sub-toggle (`features/creative-video/feature.ts:40`).
  Creative-video nodes reach it through `ctx.features` (host extension), not
  `ctx.callVideoGenerator`.
- **The publish edge is a known chokepoint.** `publishAd` takes a `mediaAssetId`
  (`host/adsAdapter.ts:113`, resolved at `:156-158`); ADR 0354 put brand
  enforcement "at the edge where content leaves the tenant".

**Gaps this ADR closes:**

| # | Gap | Evidence |
|---|---|---|
| G1 | A campaign has no product. The brief's product is free text; media's `marketing.product` is free text; the renderer stamps the brief **title** as the product | `features/campaign-brief/types.ts:116-117`; `features/campaign-orchestration/types.ts:14-46` (no product field); `features/media/mediaService.ts:61`; `renderService.ts:420` |
| G2 | Product image tokens are unvalidated strings. `cleanTokens` accepts any non-empty string; they are media **serve tokens** (`frontend/react/src/features/commerce/StorefrontPage.tsx:29`); nothing checks they belong to the product's org, and media has no token→row lookup | `commerceService.ts:364`; media lookups are by id only (`mediaService.ts:532`, `:541`) |
| G3 | Provenance is lossy. The renderer passes `lineage:{source, briefId, templateId}` which `cleanLineage` silently drops; prompts are cut to 500 chars; no prompt hash, run id or source hash is recorded | `renderService.ts:438`; `imageGenRoutes.ts:147`, `:279` |
| G4 | No fidelity check exists for generated media (grep `fidelity` over media, creative and campaign code: no hits) | — |
| G5 | Spend-and-write generation nodes are declared `role:"action"`, so a `:fork` re-dispatches them. `featureSurfaces.ts` says writes need `side-effect` | `packs/feature.creative-video.nodes/pack.json` (`generate`, `text-to-video`), `packs/feature.creative-briefs.nodes/pack.json` (`render`, `render-variants`, `generate-reel`), `packs/feature.campaign-channels.nodes/pack.json` (`render-concepts`); `host/featureSurfaces.ts:9-37` |
| G6 | No AI-disclosure handling anywhere (grep `disclos`, `c2pa`, `aiGenerated`: no hits in src or the ads publish packs) | — |
| G7 | No image-embedding seam (the headless embedder is text-only) and no raster decoder except resvg | `host/headlessAi.ts:471`; `backend/typescript/package.json` |
| G8 | Image-to-video is not in the wire shape. `ctx.callVideoGenerator` has no image input; ADR 0411 P4 is RFC-blocked on `seedImage`. The t2v adapter calls only `/v1/text_to_video` | `../openwop/spec/v1/host-capabilities.md:117-127`; `docs/adr/0411-ai-video-generation-reach.md:49`; `features/creative-video/host/t2vProviderAdapter.ts:58` |

## Decision

### D1 — The product is a reference, and its media is resolved and org-checked

0941 owns the campaign→product edge (`productRefs: {productId, role:'primary'|'secondary'}[]`
on `MarketingCampaign`, same org; 0946 binds a product per variant member). This
ADR owns **resolving product media**:

- `resolveProductMedia({tenantId, orgId, productId})` in `features/commerce`
  returns `ProductSource[] = {assetId, serveToken, sha256, role}` by resolving
  each `imageAssetTokens` entry to a media row **in the product's org**. A token
  that resolves to no row, or to another org, is refused
  `product_media_unresolved` (closes G2 for every grounded path; the storefront is
  unchanged).
- Media gains `getAssetByServeToken(tenantId, orgId, token)` (indexed, not a scan)
  and two typed marketing fields: `productId` and `shotRole`
  (`hero | angle | detail | packaging | label | lifestyle`). Free-text
  `marketing.product` stays for untyped tagging; only `productId` links.
- **Rule: the only allowed depiction of a product is pixels derived from one of
  its `ProductSource` assets.** A product photo that is not on the product does
  not count; the agency attaches it to the product first (0410 owns the catalog).

### D2 — Three grounding modes; text-only generation of a product is refused

`GroundingMode` is a closed set:

| Mode | How | Product pixels | Fidelity check |
|---|---|---|---|
| `composite` (default) | background-remove the source (existing op) → generate a scene **without** the product → place the cut-out with the ADR 0399 renderer | Copied from the source, only scaled | By construction: the product layer's `sha256` must equal the cut-out's; plus D3 stage A on the region |
| `edit` | provider edit with an inverted **protection mask** over the product, so only the surroundings change (`inpaint`, OpenAI or Replicate per `IMAGE_OP_SUPPORT`) | Re-encoded by the provider | D3 stages A + B required |
| `animate` | image-to-video from a grounded still (D7) | Re-rendered per frame | D3 on sampled frames, and a human gate in v1 |

A generation request bound to a product (`productId` present) with no source
asset — i.e. text-to-image or text-to-video describing the product — is refused
`product_depiction_ungrounded`. Text-only generation remains available for
product-less imagery, which is stamped `productDepiction:'none'`; the D3 judge
checks that claim and a product-like object found in it becomes `needs_review`.

### D3 — The fidelity check: deterministic first, model second, typed result

A host library `host/creativeFidelity/` (host, because the ads adapter and later
consumers cannot import features), and a node
`feature.creative-briefs.nodes.fidelity-check`:

- **Stage A, deterministic.** Locate the product region (the composite bbox, or
  the protection mask, or the vision subject box autotag already returns),
  rasterise source and candidate to a fixed grid, then: perceptual hash Hamming
  distance (dHash and pHash, 64-bit) on the region; dominant-colour ΔE2000 between
  source and candidate regions; aspect-ratio drift of the silhouette. Each has a
  threshold in a versioned table (`fidelityRulesetVersion`).
- **Stage B, model judge.** The vision seam gets the `ProductSource` images and
  the candidate, and must answer a closed JSON schema: for each of `logo`,
  `colour`, `shape`, `label_text`, `proportions`, `part_count`,
  `extra_or_missing_parts` → `match | mismatch | not_visible` with an evidence
  string. Invalid output is a typed `fidelity_judge_invalid` with **one**
  error-fed repair, then failure (CLAUDE.md honesty rules). The judge's prompt is
  generated from the schema module, test-pinned like `promptCatalogParity`.
- **Stage C, image embedding similarity** — honest-off until an image-embedding
  provider seam exists (G7); it never gates in v1.
- **Verdict** `FidelityVerdict = {verdictId, assetId, mode, sources[{assetId,
  sha256}], checks[], judge?, outcome: 'pass'|'fail'|'needs_review',
  rulesetVersion, checkedAt, runId?}`, stored in
  `DurableCollection('creative:fidelity-verdict')`, keyed `tenant::org::verdictId`.
  `fail` = any stage-A hard fail or any judge `mismatch` on logo, colour, shape or
  label. `needs_review` = judge unavailable, or `not_visible` on a critical
  attribute. **A missing judge never yields `pass` in `edit` or `animate`.**
- **Repair once.** On `fail`, the chain re-runs generation once with the
  mismatch list as a constraint (tighter mask, or fall back to `composite`). A
  second `fail` ends the node with the typed failure `fidelity_failed`, routed to
  the 0942 gate. Never success-with-empty.

### D4 — Provenance stamp: write-once, on every generated asset

**One lineage record, owned here.** The asset lineage record is media's
`MediaAssetLineage` (ADR 0229). This ADR owns its schema for the program: AI
provenance in the `grounding` facet below, and the supplier facet `suppliedBy`
(`{kind:'vendor', collaboratorId, grantId}` plus `rightsNote`) that ADR 0958 D5
writes for vendor intake. Both are closed, sanitised by the one `cleanLineage`,
and write-once. There is no second lineage or rights record on the asset; ADR
0958's `AssetIntake.rights` is the intake form, and its accepted summary lands in
`rightsNote`.

`MediaAssetLineage` gains a closed `grounding` facet, still sanitised by the one
`cleanLineage`:

```ts
grounding?: {
  mode: 'composite' | 'edit' | 'animate' | 'none';
  productId?: string; variantId?: string;
  sources: Array<{ assetId: string; sha256: string }>;  // survives source deletion
  promptHash: string;            // sha256 of the FULL prompt; the text stays in the run log
  provider: string; model: string; op: string;
  runId?: string; nodeId?: string; agentId?: string;    // 0943 per-node agent
  composedFrom?: { renderId: string; templateId: string; briefId?: string }; // fixes G3
  fidelity?: { verdictId: string; outcome: FidelityVerdict['outcome']; rulesetVersion: string };
  disclosure?: AiDisclosure;     // D6
}
```

- Written once by the generating path (media generate/edit, the renderer, the
  video job finaliser, the D2 nodes). `PATCH lineage` cannot set, change or clear
  `grounding` (today `lineage: null` clears everything — ADR 0229; that clear
  keeps `grounding`). Only a new verdict may update `grounding.fidelity`, through
  the fidelity service.
- Every existing generation path gets the facet in P0, so provenance does not
  depend on the new modes being used.

### D5 — One publish-edge gate

`assertCreativePublishable(asset, destination)` in `host/creativeFidelity/`, called
by `adsAdapter.publishAd` (host), the campaign-ops destination adapters (ADR 0922
D2), and the social posting adapter (0953). It refuses:

- `product_depiction_ungrounded` — AI-generated and `marketing.productId` set, no
  `grounding.sources`;
- `fidelity_unverified` — grounded but no verdict, or verdict `fail`;
- `fidelity_needs_review` — verdict `needs_review` with no resolved 0942 approval
  naming this asset and verdict in its `factsDigest`: either the effect class's
  own approval (0942 D3 makes `needs_review` an `approve` floor on it) or a
  `creative.review` gate at stage `compliance` (ADR 0947);
- `disclosure_unsupported` — D6 requires a platform flag the adapter cannot set.

Assets without `generatedBy:'ai'` and without `productId` pass untouched, so the
gate changes nothing for existing content. The gate fails closed when the
verdict store is unreachable.

### D6 — AI disclosure as data, not a checkbox

A pure, dated, versioned table `host/creativeFidelity/disclosureRules.ts` maps
`(destination platform, grounding.mode, realism)` → `AiDisclosure = {required,
label: 'ai-generated'|'ai-edited'|'none', mechanism: 'platform-flag'|'caption'|'overlay',
basis: ruleId}`. Initial rows cover Meta's AI info label, TikTok's AI-generated
content label, YouTube's altered-or-synthetic disclosure, Google political-ad
disclosure and EU AI Act Art. 50 transparency; each row cites its source and date
and is re-verified when the platform adapter ships (Q6). The client's policy may
label **more** than the minimum, never less. The disclosure decision is stamped
in `grounding.disclosure` and applied by the destination adapter.

### D7 — Image-to-video as a host extension (no wire change)

`ctx.features.creativeVideo.imageToVideo({orgId, sourceAssetId, prompt,
durationSec})` and a node `feature.creative-video.nodes.image-to-video`, on the
**same** broker adapter and job store (the ADR 0404 §P4 correction: one
`videoService`, one job pipeline). The source must be a grounded still (D4) or a
`ProductSource`. Without a frame decoder (G7: no ffmpeg on this host), v1 judges
the provider's thumbnail and the first and last frames when the provider returns
them, and **every product video is `needs_review`** until frame sampling exists.

### D8 — Runs, agents and replay

All generating nodes this ADR adds are `role:"side-effect"` + `side-effectful`, so
`:fork` serves the recorded asset and verdict instead of paying again. The
existing generation nodes in G5 are reclassified in the same phase, with pack
bumps and the side-effect floor regenerated. The fidelity node is also
`side-effect` (its model call is served on replay; the verdict id is in the
event log). Each node carries `nodes[].agent.agentId` per 0943 (Creative Director
on composition, Compliance Reviewer on `needs_review`).

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | No new package. Extends `media` (lookup, typed marketing fields, `grounding` facet), `commerce` (`resolveProductMedia`), `creative-briefs` (modes, fidelity node), `creative-video` (image-to-video). Library `host/creativeFidelity/` (no feature imports). |
| 2 | Toggle | Sub-toggle `creative-briefs.product-grounded`, default **OFF**, `bucketUnit:'tenant'`, an `extraToggleDefaults` entry of `creative-briefs` (ADR 0941 D5 toggle rule; no `dependsOn`, AND-gated in code with `creative-briefs`) (the `creative-video.t2v` precedent); image-to-video rides `creative-video.t2v`. The provenance facet and publish gate are always on (media is always-on; they touch only AI assets). |
| 3 | Workflow surface | `ctx.features.commerce.resolveProductMedia` (read); `ctx.features.creativeBriefs.{composeProductShot, checkFidelity}`; `ctx.features.creativeVideo.imageToVideo`. Every op takes `orgId` (ADR 0832 floor). |
| 4 | Node pack | `feature.creative-briefs.nodes` + `compose-product-shot`, `edit-product-scene`, `fidelity-check`; `feature.creative-video.nodes` + `image-to-video`. All side-effect. |
| 5 | Envelopes | None. Model output reaches durable state only through the closed judge schema and the verdict record. |
| 6 | Agent pack | No new agent; the 0943 Creative Director and Compliance Reviewer get these nodes on their allowlists. |
| 7 | Public surface | None. |
| 8 | RBAC | `workspace:write` on the product's org to generate; reading `ProductSource` needs `workspace:read` on that org; cross-org source → uniform 404. |
| 9 | Replay / fork | D8: side-effect nodes, recorded verdicts; `grounding.sources[].sha256` lets an audit re-run stage A after a source is deleted. |
| 10 | Frontend | Product picker in the brief and campaign; a **Product shots** panel (sources by `shotRole`); a fidelity badge and a provenance drawer on `MediaViews`; side-by-side source/candidate with the judge's evidence. 4-locale i18n. |

## Why this is our advantage

- **Durable, replayable runs:** "which product photo, model and prompt made this
  ad, and who approved it" is a `:fork`-able run plus a write-once provenance
  stamp — not a log line.
- **Named agent per node + human gates:** a failed or uncertain verdict becomes
  a role-routed 0942 gate inside the run, not a silent swap. Meta and Google
  automate the swap; we stop it.
- **Client isolation (ADR 0921):** product media resolves only inside the
  client's org.
- **Honesty invariants:** typed failure, one bounded repair, closed-world judge
  schema, never `pass` without evidence.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | `getAssetByServeToken`, `resolveProductMedia`, typed `productId`/`shotRole`, the `grounding` facet on every existing generation path (G3), write-once rule | A test proves a foreign-org token is refused; every generation route writes `grounding`; `PATCH lineage:null` keeps it |
| P1 | `composite` mode, `host/creativeFidelity/` stage A, verdict store, `fidelity-check` node; G5 reclassification | Byte-identity witness on composites; sabotage test (a recoloured product) fails stage A; forked run does not re-dispatch |
| P2 | Stage B judge with one repair; `edit` mode with protection mask | Eval suite (ADR 0889) over a fixture set of known-bad outputs (logo swap, colour drift, extra part) — each caught; judge-absent → `needs_review`, never `pass` |
| P3 | `assertCreativePublishable` in adsAdapter + campaign-ops adapters; disclosure table | Route-level tests: ungrounded and unverified assets refused at publish; untouched for non-AI assets |
| P4 | Image-to-video (D7), human-gated | Job reuses the one pipeline; every product video stops at a gate |
| P5 | Frontend (picker, panel, badge, drawer) | `npm run build` green; light/dark checked |
| Later | Image embeddings (stage C), C2PA credentials, frame sampling, a portable-pack RFC | Each gated on its own trigger (Q4–Q7) |

## Alternatives weighed

- **Trust the provider's product mode** (Product Studio, Advantage+). Rejected:
  that is the failure in the incidents; no verification, no record.
- **Judge-only (LLM decides).** Rejected as the sole gate: not deterministic, and
  approvals must bind to a reproducible result. The judge is stage B behind a
  deterministic stage A.
- **Pixel-only.** Rejected: misses a wrong label or logo text at the same
  colours. Both stages are needed.
- **Generate the product from a text description.** Refused outright (D2).
- **Wait for the `seedImage` RFC before any image-to-video.** Rejected: the host
  surface is a host extension; the RFC matters only for portable packs (below).

## RFC verdict

**Host extension, no RFC.** All surfaces are `ctx.features.*` and
`/v1/host/openwop-app/*`; the provenance facet is host data; nothing is
advertised. **Not blocking but recorded:** portable packs (for example
`vendor.myndhyve.ads-image-generate`) cannot express grounded generation through
`ctx.callImageGenerator` / `ctx.callVideoGenerator`, which lack reference-image
inputs (G8). A `referenceImages` / `seedImage` addition needs an RFC in
`../openwop` (the ADR 0411 P4 item); author it with `/prd` when a portable pack
needs it. It is optional and not the program's recommended RFC (ADR 0941 D9).

## Open questions

1. **(David)** Should `composite` be the only mode allowed by default, with
   `edit` opt-in per client? Proposed: yes.
2. **(David)** Is a fidelity `needs_review` a hard floor at every 0942 autonomy
   preset, including "Full autopilot"? Proposed: yes — not overridable by preset.
3. **(David)** Label every AI-generated scene even where no platform requires it?
   Proposed: per-client choice, default label.
4. Perceptual hashing: rasterise through resvg (no new dependency) or add an
   image library? Proposed: resvg first; measure.
5. Threshold calibration: who signs off the stage-A table? Proposed: the P2 eval
   suite sets them; changes bump `fidelityRulesetVersion`.
6. Disclosure rows must be re-verified against each platform's current rules when
   its adapter ships; who owns the dated table? Proposed: the 0952/0953 owners.
7. C2PA content credentials on exported assets: in scope later, or never?
8. Vendor-supplied product photos (0958): require a `rightsNote` and an accepted
   intake (`isUsableMediaAsset`) before they can become a `ProductSource`?
   Proposed: yes. This is an integration with Tier 4's ADR 0958, not a dependency.

## Planning rows

**ROADMAP (Campaign Studio program table):**

| Order | Item | Toggle | Depends on | Pack slug | Wire / RFC gate | Status |
|---|---|---|---|---|---|---|
| T1-1 | **Product-grounded creative and fidelity** ([ADR 0945](docs/adr/0945-product-grounded-creative-and-fidelity.md)) | `creative-briefs.product-grounded` (sub-toggle) | 0941, 0942, 0943, 0410, 0399, 0401, 0404 | `feature.creative-briefs.nodes`, `feature.creative-video.nodes` | Host extension (portable-pack RFC optional, later) | 🔵 Proposed |

**FEATURES "Future features":**

- **Product-grounded creative + fidelity verification (ADR 0945, Proposed
  2026-10-19)** — campaign creative built only from the catalog product's own
  media: composite (cut-out on a generated scene), masked edit, or image-to-video;
  a fidelity check (perceptual + colour + a closed-schema vision judge on logo,
  colour, shape, label) with one repair and typed failure; a write-once
  provenance stamp (sources + hashes, model, prompt hash, run, agent, verdict,
  disclosure) on every generated asset; a publish-edge gate in the ads,
  campaign-ops and social adapters; dated AI-disclosure rules. Sub-toggle
  `creative-briefs.product-grounded` (OFF, tenant). Host-ext, no RFC.
