# ADR 0945 — Product-grounded creative and fidelity verification

Status: Accepted (P0–P5 source recovered; integration qualification and owed items pending)

> **Recovery correction (2026-10-25):** the original phase implementation
> records below describe the recovered source, before its integration gate.
> A real API-key request reproduced a review lockout: after key revocation an
> independent admin was refused because the saved submitter was an unresolved
> key. Admission now freezes its human issuer through `canonicalDecider` and
> `canonicalReviewerUserId`; the submitter still cannot approve, and revocation
> no longer blocks another reviewer. All nine binding tests pass after the
> reproduced failure. Full integration checks and the separately authorized
> real-model evaluation remain pending; no paid model call was made.

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
- Media gains `getAssetByServeToken(tenantId, orgId, token)` (indexed, not a scan;
  *P0: a `media:token-idx` collection keyed by the token's SHA-256 — a serve
  token is a bearer credential and the index must not hold a second plaintext
  copy — named off the `media:asset` prefix the legacy byte store shares; a
  miss heals from the bounded tenant slice)*
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

> **CORRECTED 2026-10-20 (P0, architect + code review).** Five points the code
> proved different from the text above:
> 1. **`promptHash` is optional.** The ADR 0399 renderer has no prompt; it
>    records `provider:'openwop'`, `model:'renderer@<version>'`, `op:'render'`
>    and `composedFrom` instead. Every prompted path hashes the FULL prompt (the
>    generate route's `lineage.prompt` is still cut at 500 chars; the video job
>    now stores `promptHash` at submit beside its 2000-char snippet).
> 2. **`grounding` is provenance, not an AI claim.** A composite of real photos
>    carries it without `generatedBy:'ai'`; a composite with an AI layer is AI
>    output. The PATCH write-once rule keeps `grounding` AND, when it was set,
>    `generatedBy:'ai'`, so `lineage:null` cannot launder an AI asset past the
>    P3 gate.
> 3. **Trust boundary.** `cleanLineage` never accepts `grounding`; callers'
>    `lineage` (upload body, PATCH body, node args) cannot write or forge it.
>    Generating paths pass it through a separate server-only
>    `createAsset({grounding})` input, sanitised by `cleanGrounding`.
> 4. **Node paths stamp from host truth.** The AI providers adapter records
>    `aiOrigin {provider, model, op, runId, nodeId, promptHash, inputSha256}` on
>    the scratch bytes it mints; `ctx.features.media.createAssetFromServeUrl`
>    builds `grounding` from it, so `generate-reel` (which passes no lineage) is
>    stamped without a pack change. An edit op's input hash is matched to its
>    source asset in the org. `runId`/`nodeId` are stamped only when the bytes
>    came from the same run.
> 5. **Write-once means first write wins.** Generation dedups by content hash,
>    so a dedup hit on an unstamped row (a byte-identical upload) receives the
>    first `grounding` write by CAS; an existing stamp is never replaced.
> Speech (TTS) audio is not stamped: it is not creative imagery.

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

> **P0 note (2026-10-20).** `ProductSource.serveToken` is a bearer credential to
> the bytes. P1's surface verb must project it out of any recorded node output
> (MED2-R2). A product with no images resolves to `[]`; refusing it with
> `product_depiction_ungrounded` is the generating caller's job (D2). The
> refusal is the same for a foreign-org, unknown or deleted token (no existence
> leak) and names only the token's index.

> **CORRECTED 2026-10-20 (P1, architect + code review).**
> 1. **AI calls stay in the node.** `compose-product-shot` makes the recorded
>    `ctx.callImageEditor` (background-remove) and `ctx.callImageGenerator`
>    (scene) calls itself, so policy, BYOK, the daily image budget and the
>    invocation record apply as for every generation node. The host surface
>    (`ctx.features['creative-briefs']`, the real surface id; "creativeBriefs"
>    above is not a spelling that exists) supplies `productShotSource` (the
>    source's bytes, in-node only, never a serve token), `composeProductShot`
>    and `checkFidelity`. `resolveProductMedia` is not added to the commerce
>    surface: `productShotSource` is its only consumer.
> 2. **The cut-out is matched to the product by HASH**, not asset id: the same
>    bytes can sit under two asset ids (dedup is per collection).
> 3. **Composite repair is a no-op.** The renderer is deterministic, so
>    re-composing reproduces the same pixels; a composite `fail` ends the node
>    with `fidelity_failed`. D3's one repair applies to `edit` mode (P2).
> 4. **Stage A as built (ruleset `fid-a-1`).** Rasterised through
>    `@resvg/resvg-js` (Q4: no new dependency), on a 32×32 grid over the slot
>    the renderer drew the product into (`imageLayerSlot`, the composer's own
>    nudge math). The mask is the cut-out's alpha minus the slot's rounded
>    corners. Checks: byte identity of the placed layer, source-product
>    derivation, dHash ≤ 10, pHash ≤ 12, mean-colour CIEDE2000 ≤ 8; aspect is
>    by construction (contain fit). Measured on the real renderer: identity
>    0/0/0; a recolour 13/15/44.8 (fails); a missing half 8/17/18.5 (fails).
>    Modes other than `composite` are `needs_review` until the P2 judge.
> 5. **G5 reclassification bumps the PACKS, not the nodes.** `role` is how the
>    host executes a node on a fork, not its I/O contract, and
>    `creative-briefs-reel` exact-pins `generate-reel@1.0.0` (ADR 0766): a node
>    version bump would have made this host refuse its own chain.
> 6. **The sub-toggle also asks `commerce`** (ADR 0820 §7 / G11): every
>    product-grounded method reads the catalog.
> 7. **Filed, not fixed:** the older creative-briefs surface writers (`create`,
>    `render`, `renderVariants`, `storeReel`) still sit at the membership floor;
>    only the three new methods ask `workspace:write`. Widening the old ones
>    changes viewer-run behaviour and is its own change.
> 8. **Test seam:** the mock background removal now returns the input's pixels
>    re-encoded (a constant transparent pixel made every mock cut-out an empty
>    silhouette that no check can pass).

> **CORRECTED 2026-10-20 (P2, architect + code review).**
> 1. **The eval rides the ADR 0853/0855 headless-eval pattern, not ADR 0889.**
>    ADR 0889 suites grade an AGENT's trajectory (tool calls are fixtures, so
>    the judge would never run), and ADR 0477 sets use a text-only judge and
>    cannot be pack-shipped. The P2 eval is `test/fixtures/fidelity-judge-eval.json`
>    (identity, colour drift, logo swap, extra part, plus a CI-only fooled-judge
>    case), run in CI with the judge scripted
>    (`adr0945-p2-fidelity-judge.test.ts`) and against a real vision model by the
>    manual merge gate `scripts/eval-fidelity-judge.mts` — **owed**, it needs
>    `OPENWOP_EVAL_ANTHROPIC_KEY` (spend; not run by the builder).
>
>    > **CORRECTED 2026-10-27 (user decision): the live gate runs in the app on
>    > the user's own BYOK key, not from a script with its own Anthropic key.**
>    > The user: "We have BYOK in this app, the user should be able to specify
>    > the provider and model and we use that." The script needed a dedicated
>    > `OPENWOP_EVAL_ANTHROPIC_KEY` that no machine or Secret Manager held, so
>    > the gate could never run; it also only spoke to Anthropic. It is
>    > replaced by `POST /v1/host/openwop-app/creative-briefs/orgs/:orgId/fidelity/judge-check`
>    > and a "Check the fidelity judge" panel under the client's grounding
>    > settings. An admin of the client (`host:members:manage`, since it
>    > spends the workspace's key) picks a provider (Anthropic, Google or
>    > OpenAI), a vision model and one of the workspace's stored AI keys
>    > (`resolveHeadlessAiForSpec`: the ref must be this tenant's and resolve
>    > now, the provider must take images, and the key stays in the closure),
>    > or sends none to test what the fidelity check uses today. The four live
>    > fixture cases run one at a time through the same stage A, judge prompt,
>    > repair and outcome rule as production (`host/creativeFidelity/judgeEval.ts`),
>    > with at most two calls per case, and the first failure stops the run.
>    > The pass bar is unchanged: every case must hold for the judge alone and
>    > for the combined outcome. The fixture moved to
>    > `host/creativeFidelity/judgeEvalFixture.ts` so CI and the check share
>    > one copy. The result is returned to the admin and logged as
>    > `fidelity_judge_check` (provider, model, per-case outcome; no images,
>    > no key). Tests: `adr0945-judge-check.test.ts`,
>    > `adr0945-judge-check-route.test.ts`, the frontend `judgeCheckPanel.test.tsx`.
>    > **The real-model run itself is still owed** until an admin runs the
>    > check in production and the result is recorded here.
>    >
>    > **2026-10-28: first production runs did not get an answer.** Four runs
>    > on two Google keys (`gemini-2.5-pro`, and `gemini-3.0-pro`, which is not
>    > in the catalog) each stopped on the first case with
>    > `provider_unavailable`, after one call. The request shape is valid (the
>    > same call with a fake key reaches Google's key check), and the log held
>    > no reason, because every dispatch error was folded into that one code.
>    > A failed case now carries `providerError: {status, codes}`: the HTTP
>    > status and the provider's own error codes (`RESOURCE_EXHAUSTED`,
>    > `model_not_found`), never its message, which can echo the key or the
>    > prompt. It is logged as `providerStatus`/`providerCodes` and shown in
>    > the panel. The run is still owed.
>    >
>    > **2026-10-29 (00:59Z): the cause is a quota rejection.** The user
>    > authorized a re-run of `gemini-2.5-pro` on `google:personal`. Google
>    > answered the first call with **HTTP 429** after the dispatcher's 429
>    > retries (`calls: 1`, `providerStatus: 429`). The earlier
>    > `provider_unavailable` runs on both keys fit the same cause. The codes
>    > were empty for a different reason: Google's quota 429 puts a long
>    > `message` before `"status": "RESOURCE_EXHAUSTED"`, and the thrown
>    > message keeps only 500 bytes. The dispatcher now reads the code fields
>    > from the whole body (`providerErrorCodes`, attached as
>    > `ProviderHttpError.providerCodes`). The judge summary still filters and
>    > scrubs them. Test: `adr0945-provider-error-codes.test.ts`, sabotage-red
>    > when the attachment is removed. A judge answer is still owed. It needs a
>    > model and key with quota, which is the user's choice.
>    >
>    > **2026-10-29 (10:52Z): the first real answer. The judge got 3 of 4
>    > right, and the miss was the prompt's fault.** The user ran the check on
>    > `google:personal` with `gemini-3.5-flash` (4 calls). The error codes now
>    > arrive: `gemini-3.0-flash` gave 404 `NOT_FOUND` and `gemini-3.8-flash`
>    > gave 503 `UNAVAILABLE` just before. Colour drift, logo swap and the
>    > extra part were all judged `fail`, as expected. The unchanged product
>    > came back `needs_review`, not `pass`. Stage A passed it (dhash, phash
>    > and colour ΔE). The judge matched colour, shape, proportions and parts,
>    > and answered `not_visible` for `logo` and `label_text`, with the
>    > evidence "no logo visible on the product in either image" and "no label
>    > text on the product". The prompt allowed only that answer for an
>    > attribute the product never had, and `not_visible` on a critical
>    > attribute is review. So every product without a logo or printed text
>    > would have gone to review. The prompt now says: `not_visible` only when
>    > the source has the attribute and the candidate hides it; absent from
>    > both is `match`; added to the candidate is `mismatch`. The outcome
>    > rule is unchanged. Test: the new prompt case in
>    > `adr0945-p2-fidelity-judge.test.ts`. The gate still needs one green
>    > re-run on the new prompt.
> 2. **The outcome rule is one function** (`host/creativeFidelity/decide.ts`):
>    the judge can add failures, never remove one; a non-critical mismatch
>    (`proportions`, `part_count`, `extra_or_missing_parts`) is `needs_review`,
>    a critical one is `fail`; composite may still pass on stage A alone when no
>    judge exists (by construction); `none` is `needs_review` (product-presence
>    judging for `productDepiction:'none'` is not built — D2's claim check is
>    owed).
> 3. **Edit-mode geometry.** A result whose aspect ratio drifts more than 2% from
>    the source photo fails `aspect` before any pixel comparison — a reframed
>    edit cannot show the product unchanged. OpenAI's fixed output sizes will
>    fail a non-square photo; use Replicate (keeps the size). The protection
>    mask is built from the cut-out's alpha at the photo's natural size and
>    encoded per provider (Replicate repaints white: product black on white;
>    OpenAI repaints transparent: product opaque).
> 4. **A product binding must be verified, not claimed.** P0 took a generated
>    asset's `productId` only from the source asset's `marketing.productId`,
>    which catalog photos rarely carry. Nodes now pass `productId` to
>    `createAssetFromServeUrl`, and media stamps it only when the catalog
>    confirms the source bytes are one of that product's photos (a
>    `registerProductSourceVerifier` seam commerce fills; media cannot import
>    commerce). An unverified hint is dropped.
> 5. **Repair.** The edit node re-edits ONCE with the failed checks and judge
>    mismatches as constraints; a second `fail` is `fidelity_failed`. The judge's
>    own output gets its one error-fed repair separately.
> 6. **Q1 is still open for David:** edit mode is behind the same sub-toggle as
>    composite and is reached only by choosing the edit node; a per-client
>    opt-in waits on the ADR 0942 policy.
> 7. **Test seam:** the mock inpaint "repaints the surroundings" (a flat backdrop
>    behind the input), so an edit keeps the product's pixels in CI.

> **CORRECTED 2026-10-20 (P3, architect + code review).**
> 1. **The gate lives at `host/creativePublishGate.ts`**, not inside
>    `host/creativeFidelity/`: it must read media, and the fidelity library
>    stays free of feature imports. It reads the verdict from the STORE, in the
>    asset's OWN org (the ads adapter runs with `orgId = tenantId`), never the
>    asset's cached `grounding.fidelity`; an unreadable store refuses.
> 2. **Two refusals the text above did not have.** AI bytes that are not a
>    library asset (a bare scratch token carrying the adapter's `aiOrigin`) are
>    `fidelity_unverified` — there is no record to check them against. And a
>    reference is resolved by id, then by serve token, because `publishAd`
>    falls back to treating `mediaAssetId` as a raw token.
> 3. **The approval exemption cannot use `factsDigest`.** ADR 0942's
>    `factsDigest` hashes the risk numbers (spend, audience, …) and cannot name
>    an asset. `needs_review` passes only when a registered check
>    (`registerCreativeReviewApproval`) confirms a person approved THIS asset at
>    THIS verdict; the approvals owner (ADR 0942 / ADR 0947) fills it with a
>    binding on a content hash of `{assetId, verdictId}`. Until then nothing is
>    approved and `needs_review` never publishes — a correction ADR 0942 owes too.
> 4. **`grounding.disclosure` is not stamped.** The stamp is write-once and the
>    disclosure differs per destination; the decision is returned to the caller.
> 5. **Disclosure rows as built** (`disclosureRules.ts`, `disc-2026-10-20`, all
>    provisional until re-verified when each adapter ships, Q6): TikTok AI ⇒
>    platform flag; Meta and Google political AI ⇒ platform flag. No adapter here
>    can set a platform AI flag, so those REFUSE (`disclosure_unsupported`) —
>    a behaviour change: AI media to TikTok, and AI media in political Meta or
>    Google ads, no longer dispatches. **Owed:** EU AI Act Art. 50(4) (needs the
>    audience's geography, ADR 0952) and the client "label more" policy (Q3).
> 6. **Where it runs.** `publishAd`: after the idempotency read and before the
>    dry run (a preview shows the refusal), skipped when this exact ad was
>    already dispatched (a live ad is not un-published by a later verdict). The
>    campaign-ops CMS adapter: in `preview` and again in `write`, for each image
>    token the edit CHANGES (`creative_blocked`, with copy in four locales). The
>    social adapter (ADR 0953) calls it when it ships; the
>    `vendor.myndhyve.ads-publish-*` bypass stays ADR 0941 P4's ratchet.

> **CORRECTED 2026-10-20 (P4, architect review).**
> 1. **Image-to-video is the t2v job with a still**, not a new pipeline: job kind
>    `i2v`, the Runway `image_to_video` task (the still as a data URI), the same
>    job store, broker, spend meter and finaliser. The request hash folds the
>    still's sha256 ONLY when present, so every pre-existing avatar/t2v hash is
>    byte-identical (an in-flight job never re-submits).
> 2. **The source check runs before the hash on every call**, so a dedup hit
>    cannot skip it: a composite or edit whose STORED verdict is `pass`, or a
>    photo the catalog confirms is the product's (media's product-source
>    verifier, commerce-gated). Anything else is `product_depiction_ungrounded`
>    with no spend; a still over 3.5 MB is refused before submit.
> 3. **"Every product video stops at a gate"** is met by a recorded
>    `needs_review` verdict (mode `animate`, "frames cannot be sampled yet"):
>    the finaliser writes it, and the P3 publish gate refuses `needs_review`
>    until a person approves (the approvals owner fills that check). Without the
>    verdict the video would be `fidelity_unverified` and un-approvable.
> 4. **Toggle:** rides `creative-video.t2v` only (same provider and meter); the
>    creative-briefs `product-grounded` sub-toggle is not read across features.
> 5. **Not built (G7):** frame sampling and judging the provider's thumbnail —
>    the Runway task returns no thumbnail here.

> **CORRECTED 2026-10-20 (P5, architect + code review).**
> 1. **Built:** a fidelity chip on every generated media asset (the label says
>    Checked / Needs review / Failed check / Not checked; the cached summary is
>    display only, the publish gate reads the store); a lazily loaded
>    provenance drawer (how it was made, the product photos beside the result,
>    every check with its value and limit, the judge's answers with its
>    evidence as plain text); and a Product shots panel in the product editor
>    (the product's own photos by shot role, with the typed error when a photo
>    no longer resolves). Two host-ext read routes back them:
>    `…/media/orgs/:orgId/assets/:assetId/provenance` and
>    `…/commerce/orgs/:orgId/products/:productId/media`.
> 2. **Deferred:** the product picker in the brief and the campaign. Its data
>    model is ADR 0941's `productRefs` on `MarketingCampaign`, not merged yet;
>    a picker without it would be a second product link. It lands with 0941 /
>    0946.
> 3. **Found in review:** both lazily loaded readers first listed `t` as an
>    effect dependency, so a host whose `t` changes identity per render (the
>    unit-test i18n stub did) refetched in a loop until the worker ran out of
>    memory. The fallback copy is now resolved at render and the effects depend
>    on the ids only.
> 4. **Q1 UI:** the briefs page shows an "Allow edit mode for this client"
>    checkbox (lazy, only when `creative-briefs.product-grounded` is on); a
>    non-admin's save is refused by the server and the box stays as stored.
> 5. **Light/dark:** every element is a shared primitive (`surface-card`,
>    `chip--*`, `Notice`, `Modal`, `card-grid`, `media-thumb`) on theme tokens,
>    so both themes follow the token set; no colour literal was added.

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

### Implementation record

| Phase | Status | Commit / PR | Tests |
|---|---|---|---|
| P0 | implemented 2026-10-20 | #5067 (`feat/cs-0945-p0`) | `adr0945-p0-product-grounding.test.ts` (12), `adr0945-p0-render-video-grounding.test.ts` (3); sabotage-witnessed: PATCH clear, dedup first-write, token org check, full-prompt hash, unresolved refusal, render-id agreement each red a test |
| P1 | implemented 2026-10-20 | #5074 (`feat/cs-0945-p1`, after #5067) | `adr0945-p1-stage-a.test.ts` (5: identity pass, recolour + missing-part sabotage fail, empty silhouette, CIEDE2000 reference pairs), `adr0945-p1-composite-run.test.ts` (5: a real run composes a passing composite, replay fork serves it with no second render/asset, the reclassified `render` node is served on a fork, a foreign cut-out is refused, toggle-off fails closed); sabotage-witnessed: ΔE threshold loosened, mask ignoring alpha, render/compose unclassified, toggle gate removed, byte-identity inverted, cut-out verification skipped each red a test |
| P2 | implemented 2026-10-20 | #5080 (`feat/cs-0945-p2`, after #5074) | `adr0945-p2-fidelity-judge.test.ts` (16: prompt/parser parity, the one repair, 5 fixture eval cases with a scripted judge, judge-absent ⇒ needs_review, reframed edit ⇒ aspect fail, protection-mask encodings), `adr0945-p2-edit-run.test.ts` (4: a real edit run passes and a replay fork serves it without consulting the judge, no vision provider ⇒ needs_review, a twice-failing edit ends `fidelity_failed` after exactly one repair, an unverified product hint is not stamped); live gate `scripts/eval-fidelity-judge.mts` OWED (key + spend); **replaced 2026-10-27** by the in-app BYOK judge check (`…/fidelity/judge-check`, see the P2 correction above), real-model run still owed |
| P3 | implemented 2026-10-20 | #5084 (`feat/cs-0945-p3`, after #5080) | `adr0945-p3-publish-gate.test.ts` (11: non-AI untouched everywhere; ungrounded / unchecked / failed refused; the store beats a lying summary; an unreadable store fails closed; token and URL resolve; needs_review only with an approval for this asset+verdict, a throwing check refuses; AI scratch bytes refused; disclosure rows; `publishAd` refuses before preview; the CMS adapter refuses in preview and write); sabotage-witnessed: publishAd unwired, summary trusted, store fail-open, scratch AI passed, CMS write ungated, token resolution dropped each red a test |
| P4 | implemented 2026-10-20 | #5089 (`feat/cs-0945-p4`, after #5084) | `adr0945-p4-image-to-video.test.ts` (6: a checked shot animates on the one pipeline, stamped `animate` + `needs_review` and held by the publish gate; a product photo only with catalog confirmation; unchecked / under-review stills refused before any submit; one paid job per still; legacy avatar/t2v hashes unchanged; the adapter posts `image_to_video`) |
| P5 | implemented 2026-10-20 | `feat/cs-0945-p5` (after #5089) | `adr0945-p5-read-routes.test.ts` (4: provenance returns the stamp, the stored verdict and in-org sources with no prompt text, a deleted source is `present:false`, another org's asset 404s; product media lists roles, an unresolvable photo is 422, commerce off refuses); FE `media/__tests__/provenance.test.tsx` (chip only for stamped assets and named in words; the drawer shows source beside result, value/limit, and judge evidence as text, never markup); `npm run build` green, entry chunk unchanged |

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

> **DECIDED 2026-10-20 — Q1 (team-lead; David can override): edit mode is OFF
> per client org by default, with explicit opt-in per client org.** Edit mode
> repaints the pixels around the client's real product, so the client whose
> brand it is must say yes. The tenant sub-toggle `creative-briefs.product-grounded`
> stays the master switch; composite mode needs no opt-in. As built (P3): one
> `creative-briefs:grounding-settings` row per (tenant, client org)
> (`editModeEnabled`, default false); `GET/PUT …/creative-briefs/orgs/:orgId/grounding-settings`
> (read: membership; write: the org's admin authority, `host:members:manage`);
> the `edit-product-scene` node is refused `edit_mode_not_enabled` (403) by
> `productShotSource({mode:'edit'})` BEFORE any paid call, and again by
> `protectionMask`. No client-settings record existed on `main` to extend (the
> ADR 0921 `ClientAccount` holds no creative settings), so the row lives with
> the feature that reads it.

> **DECIDED 2026-10-20 — Q3 (team-lead; David can override): label AI content
> wherever the destination offers a label, even where no rule requires it.**
> Transparency is the brand-safe default and an extra label costs nothing. As
> built: `DISCLOSURE_POLICY = 'label-where-offered'` in `disclosureRules.ts`
> (rules version `disc-2026-10-20b`); each row says when a label is
> `requiredWhen` and when it is `offeredWhen`, and the decision records
> `requiredBy: 'rule' | 'policy'`. Today every row's offered and required
> conditions coincide (TikTok's AIGC flag always; Meta's and Google's
> advertiser AI disclosure only exists on political ads), so behaviour is
> unchanged; a destination that offers a label without requiring one (e.g. a
> caption on our own CMS pages, once built) is labelled by default. A per-client
> override (label only where required) is not built; it waits on a client
> creative-settings home (ADR 0942 policy) if a client ever asks for it.
> TikTok stays refusing until the ads adapter's AIGC flag is sandbox-verified
> (`adsAigcFlagEnabled`, ADR 0907 / #5093).

## Open questions

1. ~~**(David)** Should `composite` be the only mode allowed by default, with
   `edit` opt-in per client? Proposed: yes.~~ **Decided 2026-10-20: yes** (see
   the note above).
2. **(David)** Is a fidelity `needs_review` a hard floor at every 0942 autonomy
   preset, including "Full autopilot"? Proposed: yes — not overridable by preset.
3. ~~**(David)** Label every AI-generated scene even where no platform requires it?
   Proposed: per-client choice, default label.~~ **Decided 2026-10-20: label
   wherever a label is offered** (see the note above).
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


### Recovery correction — 2026-10-21 (P0 provenance concurrency)

Existing asset metadata edits, dedup merges, usage increments and collection
rehoming now share a bounded fresh-row CAS boundary. They preserve concurrent
grounding/fidelity and AI classification, never resurrect deleted assets, and
report exhausted retries. Grounding remains first-write-wins while a trusted AI
path may monotonically promote generatedBy. Host aiOrigin also classifies a new
surface-created asset even when caller lineage is absent. Storage-interleaving
and deletion/exhaustion witnesses added; execution pending the next serialized
validation slot.


### Recovery corrections — 2026-10-25 (unvalidated source checkpoint)

The original P1–P5, Q3 disclosure and creative-review binding histories are
retained together. The current requester/waiter checks, submitter-cause
redaction and email-review cards survive the merge. Channel rendering's replay
classification uses a fresh1.15.1 pack rather than reverting current1.15.0.

Prepared corrections refuse unreadable provenance, require the current
product/bytes/mode/sources/rules to match the verdict, and never return an
unconfirmed local verdict. Verdict identity now commits full judge evidence
and the model-check invocation: equal outcome codes alone cannot preserve a
review when its supporting evidence changes.

Review creation confirms a deterministic immutable primary before publishing
its binding index, retaining the first requester and policy across races and
lost acknowledgements. Only the latest exact primary cycle can authorize
publishing. Policy read failures refuse rather than silently selecting a
default, and a named campaign must belong to the asset's client.

Regression cases are authored for changed evidence, failed provenance reads,
product reassignment, unconfirmed storage, concurrent review creation and lost
binding acknowledgements. They have NOT run beside the current release gate.
Generated metadata, native types, focused suites, canonical CI, delegated/key
requester-cause review and a concrete asset/evidence review card still require
qualification. The real-model judge eval required above remains owed; no paid
AI calls have been made for this recovery.


Recovery manual-eval checkpoint — 2026-10-25 (validation pending): the P2
record above named `scripts/eval-fidelity-judge.mts`. The initial recovery
check missed the existing backend-relative entry point; that earlier absence
claim was incorrect. It is now a compatibility entry point to one root runner
that defaults to a zero-call plan and retains the judge-alone acceptance bar. A live run requires an approved Anthropic model, the
dedicated eval key, and a new private report path. It evaluates the four
non-CI-only synthetic fixtures through the production stage-A, judge schema/
repair, and outcome functions. Each must pass both the judge-alone and combined
criteria. Its single-attempt Anthropic transport permits at most eight serial requests of 1,200
output tokens each. It stops on the first provider error/refusal, records
usage and fixture/commit hashes, and never falls back to a managed key.
Strict typechecking and zero-call plans for both entry points passed during
recovery. The required authorized live evaluation remains pending; this
checkpoint claims no model qualification or production release.

Recovery validation correction — 2026-10-25: a real delegated API-key request
could freeze the revocable key as the submitter. Revoking it then stranded an
independent human's decision in the shared fail-closed identity check. This was
reproduced before freezing the canonical human while the delegation is live;
all nine binding cases now pass, including the original self-approval refusal.
The shared review card also passed its actual image/evidence and unreadable/
changed-evidence checks in both inboxes.

Image-to-video previously trusted a stored `pass` tied only to the asset id.
A passing verdict for different bytes was reproduced authorizing a paid job.
Eligibility now also binds actual bytes, product, mode, sources and current
ruleset before any provider submission. The mismatched-evidence case and both
animation/publish suites pass. Native types, strict manual-runner types,
frontend lint, frontend test types (zero baseline) and all 65 focused frontend
cases are green. Full canonical integration and the owed live judge evaluation
remain required before declaring this recovered phase complete.

Independent re-measurement — 2026-10-25, on the merge with main `7981e512c`
(slot 73): the delegated-key binding case was shown RED again by sabotage
(freeze replaced by the raw requester: that one case fails, 1/9) and GREEN
restored (9/9). All 20 test files the recovery adds or changes pass (198
tests); the manual judge runner typechecks under strict and `--plan` reports
`calls_made: 0` (4 fixtures, at most 8 requests × 1,200 output tokens). No
live model call was made. The live fidelity evaluation is still owed and needs
the user's authorization; the merge train is the canonical integration gate.
