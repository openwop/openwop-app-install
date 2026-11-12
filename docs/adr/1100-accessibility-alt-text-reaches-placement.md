# ADR 1100 — Accessibility: alt text that reaches the page, a checker that looks, and a Reviewer that can read

**Status:** Accepted. P1 is implemented on branch `fl2-89/accessibility`; it becomes `implemented` when that PR merges.
**Date:** 2026-11-11
**Extends:** ADR 0363 (authored-content accessibility). Toggle `accessibility` is unchanged (registered default OFF, `bucketUnit: tenant`; prod stores `beta`).
**Composes:** ADR 0818 §4 / ADR 0830 D1 / ADR 0832 (run-actor org authority, `assertRunScopeOrg`), ADR 0572 + ADR 1048 (replay fast path, the manifest floor), ADR 0721 + ADR 0821 D4 (headless spend metering + attribution), ADR 1031 (safe-mode census), ADR 0206 B4 (CMS media picker), ADR 0334 (document-editor image insert).
**Decision source:** feature loop row 89, grade `docs/steward/workflows-assessment/2026-11-11-accessibility-row89.md` (`A11Y89-1..16`), read on `origin/main` `ae7de6c7e`; prod exposure read-only by the lead on 2026-11-11.
**RFC verdict:** host-extension only. No new RFC. Every change is in-process, a host route under `/v1/host/openwop-app/*`, a pack manifest field the existing corpus already defines (`capabilities: ["side-effectful"]`), or FE.

## Context

ADR 0363 shipped three promises. Read end to end, none of them holds.

**1. "AI alt text for Media."** The vision proposal is generated, confirmed by a person, and stored on `MediaAsset.altText`. Then no placement reads it:

| Where an image is placed | What `alt` it gets | Source |
|---|---|---|
| CMS section (image, hero, columns, gallery, hub, …) | the SECTION's own `alt`, empty after a pick | `SectionsEditor.tsx:54-90` sets only the token; `SectionRenderer.tsx` and `publishing/sectionHtml.ts` read `data.alt` |
| Document editor | the asset's **file name** | `DocumentEditorSurface.tsx:258` `alt: asset.name` |
| DOCX/EPUB/ODT export | the Markdown alt (the file name) | `exportImageResolver` never fills the ADR 0914 `altText` slot |

Only the media list tool and the media `select` surface op ever read it. ADR 0363 matrix #7 ("published pages benefit (better alt text)") is false.

**2. "A shared checker surfaced in the CMS editor."** `cmsPageToA11yModel` reads `image.token` and `hero.imageToken`, and nothing else. At least 13 other placements render an `<img alt>` from section data (the grade lists them). The same projector feeds the pre-publish check, which reports `checkA11yOk` for a page whose images are unlabelled. Its panel also drops `nodeRef`, so even a true finding does not say which section it is in.

**3. "An Accessibility Reviewer agent driven from the AI chat."** Its allowlist is `accessibility.check` and `accessibility.alt-text.generate`. It cannot read a page, a document or the media library, so `check` grades content the model invents and `generate` needs an asset id it cannot discover.

Four defects sit underneath:
- The workflow surface's `generateAltText` runs at the seam's default `workspace:read` org floor, but the route requires `workspace:write`. A read-only member's run can therefore spend the workspace's vision provider on an image they may not edit. (CORRECTED by the architect pass: the grade's "member of org A can describe org B's image" was false. `host/featureSurfaces.ts` `orgFloor` (`:200-221`) already runs `assertRunScopeOrg` at `workspace:read` on every surface method passed an `orgId`.)
- The chat tool labels vision output from an image as `trusted`.
- The safe-mode census lists that tool as a read with no off-host send. It sends the image to the vision provider.
- A replay fork re-runs the alt-text node live, so it makes a new, unlogged, paid vision call.

**Prod exposure (lead, read-only, 2026-11-11):** the toggle is stored `beta`. There are 74 image assets across 4 tenants; 73 have no alt text, 1 has a human one, and 0 have AI text. There have been 0 runs of an accessibility node and 0 Reviewer conversations. So the feature is latent, and no stored row changes shape: nothing below needs a migration or a backfill.

## Decision

### D1 — Each lane asks for the scope the route asks for (`A11Y89-1`, `-13`)

- **Run lane.** The surface declares `orgPolicy: { methodScopes: { generateAltText: 'workspace:write' } }` (the `cms`, `funnels` and `email` pattern, `cms/feature.ts:38`). The seam's existing `orgFloor` then checks write instead of read. It keeps the floor's lanes (actor → membership + scope; causing member → membership only; no actor and no cause → tenant-trusted) and its per-bundle memo. `surface.ts` gains no check of its own.
- **Chat lane.** The tool replaces its inline `resolveEffectiveAccess` check with `assertOrgScope(scope.tenantId, actingUserId, orgId, 'workspace:write')`. That is exactly the predicate the HTTP route runs (`featureRoute.ts:177`, through `requireCmsScope`), with no personal-owner context. Then route and tool call one helper (CLAUDE.md). `assertRunOrgScope` was rejected for the tool: its workspace-root and `personalTenant` shortcuts would pass callers the route returns 403 to (architect High 3). The tool keeps its sole-org default. A refusal becomes a typed tool error.
- Not mirrored here: the CMS system-site lane (`cmsScope.ts:42-58`). The media route reaches it, the tool does not, and the tool's sole-org default never selects the system site.

### D2 — The library's description reaches the placement (`A11Y89-2`)

The rule is **fill an empty alt, never overwrite an author's**:

- **CMS.** `SectionFields` wraps `onChange` with a pure `fillAltFromLibrary(prev, next, altByToken)` (new `features/cms/altFromLibrary.ts`). It walks the section data. For each object in `next` whose `token` or `imageToken` is a token that appears NOWHERE in `prev`, and whose `alt` is empty, it sets `alt` to the library's description for that token. Comparing by token identity, not by array index, means that reordering or inserting items in `columns`, `gallery` or `hub` never fills an alt an author left empty on purpose (architect Medium 9).
  - It runs only on the base layer (`baseData === undefined`). A locale overlay never gets the base-language description (architect Medium 7).
  - A `decorative` asset fills nothing. CMS has no decorative flag, so an empty alt stays empty and the checker reports it (OQ-1).
  - The lookup is built from the `assets` list the editor already loads (media `listAssets` returns `altText`/`altTextSource`). `MediaAssetRef` gains those two optional fields.
  - The picker's `onSelect` receives the whole asset, and `CmsPage` UPSERTS it into `assets`, replacing by `assetId`. That way an alt set after the page loaded is the one used (architect Medium 8).
- **Document editor.** `onPickImage` inserts `alt: asset.altText` when it has one, `alt: ''` when the asset is marked decorative, and otherwise keeps today's `asset.name`. The document checker has no decorative flag, so a decorative insert reports as missing alt. That errs toward the user and is recorded under OQ-2. Changing the file-name fallback is out of scope: it would turn every existing file-name insert into a new error.
- **Not covered (filed `A11Y89-18`):** agent writes through `cms.update-section-draft` and the section AI bar do not fill alt. They write section data without a picker event.
- **Exports.** With the editor fix, the Markdown alt carries the description, and the exporters already fall back to it. Filling `ResolvedExportImage.altText` from the asset store needs a token→asset read that documents does not have today. That residue is filed (`A11Y89-17`).

Author-time fill, not render-time fallback: a render-time lookup would put a media read on every public section render (FE and the backend prerender), and would silently change pages that were already published.

### D3 — The CMS check looks at every placement and says where (`A11Y89-3`, `-10`)

`cmsPageToA11yModel` becomes a bounded walker (depth ≤ 4, arrays and objects) over each section's `data`:
- Every object with a non-empty string `token` or `imageToken` is an image `{ alt: obj.alt, ref: sectionId }`.
- The exception is where the renderer shows the top-level `imageToken` only for `visual === 'image'`, which is `hero` (`SectionRenderer.tsx:813-823`) and `richText` (`:1253`). There, a token left behind after the author switched `visual` is skipped (architect High 5).
- The hero and CTA link rules stay as they are.
- **No Markdown image rule.** The CMS `inlineMarkdown` (`SectionRenderer.tsx:90-117`) renders no image syntax, so there is no rendered Markdown image to check (architect, premise falsified).
- **Known gap, stated:** Markdown links `[label](url)` render in many string fields (subheadings, notes, column text). Only the hero/CTA links are checked, as today. Filed `A11Y89-19`.

The walker keys on the field names every renderer reads (`token`, `imageToken`, `alt`), so a new section type that follows the convention is covered without a change. A renderer-inventory parity test pins that every picture the renderers read DIRECTLY (`assetUrl(str(x.<field>))`, `<ColumnShot token={str(x.<field>)}>`, and the backend `assetUrl(base, str(x.<field>))`) reads a field in `CMS_IMAGE_TOKEN_KEYS`, so a new spelling turns it red. (CORRECTED at re-grade: an earlier draft said it pins every `alt={…}` site. It does not see a picture read through a local variable, and it does not check the alt side.) A per-type field table was rejected: it would be a second list to keep in step with the renderers.

The panel and the pre-publish check both project the RESOLVED sections, with shared-section refs replaced by their content (`CmsPage.tsx:1146` `resolvedSections`). A shared-section reference carries `data: {}` (`SectionsEditor.tsx:1488`), so checking the raw list missed every image in one (architect High 6). `publishChecks` takes the resolved list as an argument.

`A11yIssuesPanel` takes an optional `describeRef(nodeRef) → string | undefined` and shows it as a location line on each issue. `CmsPage` passes `section N · <type label>`, reusing the existing `sectionType_*` keys, plus one new `a11y` key for the line, in all four locale catalogs. A ref the host cannot describe shows nothing, as today.

### D4 — The Reviewer reads before it checks (`A11Y89-4`)

The agent's `toolAllowlist` adds five existing, governed, `untrusted` reads:
- `openwop:media.list`;
- `openwop:cms.list-pages` and `openwop:cms.get-page` (PUBLISHED pages only);
- `openwop:cms.get-draft-page` (draft and in-review pages by `pageId`, the pre-publish review ADR 0363 exists for; it is `schemaCarrying`, so it is never compacted);
- `openwop:documents.get` (by id).

Each enforces its own toggle and org RBAC, and fails empty without an acting user.

The prompt changes to:
- Read first. Build the content model only from what a read returned, with each section id as `ref`.
- Draft pages and documents are reachable only by an id the user gives (there is no draft-list or document-list tool). Ask for it.
- If a read result carries a compaction marker, the content is incomplete. Say so, and never report it clean (architect Blocker 2: `cms.get-page` and `documents.get` are compactable).
- Find images missing alt text through `media.list` (at most 100 rows, no content-type filter). Say when the library is larger than what was read.

The prompt names the image fields (`token`, `imageToken`, `alt`, and the `visual === 'image'` rule). A test pins that text to the walker's exported key set (CLAUDE.md: model-facing schema text is generated or test-pinned). `vendor.openwop-app.accessibility.agents` goes to `1.0.2`, `packPins.ts` moves with it, and the `LLM-EXCHANGE-AUDIT.md` accessibility row is updated.

No new tool. A server-side "check this page" tool would need a backend twin of the CMS projector, which would be a third copy of the rules.

### D5 — Trust and safe-mode labels match what the tools do (`A11Y89-5`, `-6`, `-12`, `-15`)

- `openwop:accessibility.alt-text.generate` becomes `contentTrust: 'untrusted'`. Its text is a vision model's reading of an image, and an image can carry instructions.
- In `safe-mode-baseline-census.test.ts` it moves from `HOST_READS` to `NO_ASK_READ_EGRESS`, with the adjudication: it sends one image the caller may write to the managed vision provider, else the workspace's BYOK default (the `resolveHeadlessAi` ladder, `headlessAi.ts:336-353`); it returns a proposal and stores nothing; asking would gate every review turn. `tool-content-trust-required.test.ts:201`, which pins it in the trusted set, moves with it.
- `coerceContentA11yModel` keeps a `ref` only if it matches `^[A-Za-z0-9_.:-]{1,128}$`, so `check` cannot echo arbitrary copied text under a trusted label. **Behaviour change for both consumers** (the Reviewer and the campaign-studio Compliance Reviewer, `adr0943-team-pack-suites.test.ts:74`; `check` is channel-safe, `adr1042-channel-safe-tools.test.ts:31`): a ref with spaces or punctuation is dropped, and the issue is still reported without a location. Real section, block and component ids match the pattern.
- The heading-level coercion (`A11Y89-15`, Low) is NOT changed here. `content-a11y-twin.test.ts:67` pins `{}` → level 1, and the fix is not worth that churn. Filed.

### D6 — A replay fork serves the recorded proposal (`A11Y89-7`)

`feature.accessibility.nodes.alt-text-generate` declares `capabilities: ["side-effectful"]`. The node reaches no invocation-logged AI capability (its dispatch is `resolveHeadlessAi` behind `ctx.features`), so the floor generator classifies it `no-ai-reach` and puts it in `MANIFEST_FAST_PATH_SERVED`. A fork then serves the source run's recorded `{assetId, altText}` or fails closed with `replay_source_missing`. It never makes a second paid call. The paid external call is the effect, and serving it is what replay.md requirement 2 asks for. `check` stays unclassified: it is pure, and re-running it is the same answer. `feature.accessibility.nodes` goes to `1.0.2`. The pack header's replay sentence and ADR 0363 matrix #9 are corrected.

**Why the classification is right, and what keeps it right.** The floor generator classifies the node `no-ai-reach` because its reach analysis stops at `ctx.features` (`packNodeReach.mjs:321-339`). It is blind there. The classification is correct only because a person read that `mediaService.generateAltText` dispatches through `resolveHeadlessAi`, which writes no ADR 0326 record. If that dispatch ever moves to the invocation-logged path, the fast path would silently remove RFC 0041 §B divergence detection for this node. A witness pins that premise: `generateAltText` calls `resolveHeadlessAi` and nothing invocation-logged.

Regenerated as a consequence (each diff shown to the lead before it is committed):
- `executor/sideEffectFloor.generated.ts`: floor +1, served +1;
- `docs/steward/SERVED-SET-BASELINE.json` (`scripts/ci.sh:418` `--check`): floor 389 → 390, served 358 → 359, `servedByRole.action` 38 → 39;
- `packs/.steward-manifest.json`: two pack digests;
- `features/packPins.ts`: both packs to `1.0.2`.

### D7 — Spend is attributed to the feature and the person (`A11Y89-11`)

`mediaService.generateAltText(tenantId, orgId, assetId, opts?: { actingSubject?: string })` passes `{ featureId: 'accessibility', actingSubject }` to `resolveHeadlessAi`. The route passes the caller's user id, the tool passes `actingUserId`, and the surface passes the run's acting user when there is one. Autotag is unchanged (it is media's own feature).

### D8 — The dialog offers only what the workspace has (`A11Y89-8`)

`AltTextDialog` shows "Generate with AI" only when `useFeatureAccess('accessibility')` is `enabled && !locked && !loading`. `locked` is the plan paywall the route also enforces (`featureRoute.ts:53-70`; `FeatureAccessContext.tsx:219`). Typing and marking decorative stay available, since they are media's own PATCH and need no toggle.

### D9 — Claims match code (`A11Y89-9`, `-16`)

- The node pack description drops "auto-alt-text a media library" and says the node proposes alt text for one asset.
- The toggle description drops the app-builder editor claim.
- ADR 0363 gets inline correction notes at matrix #7, at matrix #9, and at the P3 "chat-drivable" claim.

The apply-and-batch chain the original pack promised (`A11Y89-9` follow-up) is filed. It needs a media write op for alt text and a "list images missing alt" read, and each needs its own gate decision.

## Alternatives weighed

1. **A render-time fallback to the library's description** (`alt = section.alt || asset.altText`). Rejected: it adds a media read to every public render on two renderers, and it silently changes already-published pages.
2. **A backend "check this CMS page" tool.** Rejected for now: it needs a third twin of the projector. Allowlisting the existing governed reads gives the Reviewer real input today. Revisit if graders find the model's projections unreliable.
3. **Keep the alt-text node `role: action` and route the dispatch through `ctx.callAI`** so the ADR 0326 log discharges replay. Rejected: the dispatch is media's, it takes image input, and moving it would fork the autotag twin.
4. **Overwrite a section's alt with the library's on every pick.** Rejected: an author's hand-written, context-specific alt is better than a generic library description.

## Phased plan

One PR, one phase (P1), off `origin/main`:

| Step | Decision | Files |
|---|---|---|
| 1 | D1, D7 | `features/accessibility/{feature,surface,agentTools}.ts`, `features/media/{mediaService,routes}.ts` |
| 2 | D5 | `features/accessibility/agentTools.ts`, `host/contentA11y.ts`, `test/safe-mode-baseline-census.test.ts`, `test/tool-content-trust-required.test.ts` |
| 3 | D6, D4, D9 (packs) | both `pack.json`, the prompt, `features/packPins.ts`, the regenerated floor, served-set baseline and steward manifest |
| 4 | D2, D3, D8 (FE) | `cms/{altFromLibrary,cmsA11y,publishChecks,SectionsEditor,CmsPage,cmsClient}.ts(x)`, `a11y/A11yIssuesPanel.tsx` + `a11y/i18n` ×4, `document-editor/DocumentEditorSurface.tsx`, `media/AltTextDialog.tsx` |
| 5 | D9 (docs) | `feature.ts` description, ADR 0363 notes, `LLM-EXCHANGE-AUDIT.md`, FEATURES row if it repeats a corrected claim |

Witnesses, written first and shown red on `main` where the defect is behavioural:
- a run whose actor has only `workspace:read` in the org gets `forbidden_scope` from `generateAltText` (D1; red on `main`, where read passes);
- the chat tool refuses a viewer with the route's error (D1);
- the tool returns `untrusted` (D5);
- `fillAltFromLibrary` fills an empty alt, keeps an authored one, and skips decorative (D2);
- the projector finds a columns image and an image inside a resolved shared section, and skips a hero token with `visual !== 'image'` (D3);
- the renderer-inventory parity test (D3);
- the panel renders the location (D3);
- the dialog hides Generate when the toggle is off (D8);
- `isSideEffectingNode('feature.accessibility.nodes.alt-text-generate')` is true (D6);
- the Reviewer's allowlist names the reads, and the prompt names the walker's keys (D4);
- `generateAltText` dispatches through `resolveHeadlessAi`, not the invocation log (D6 premise).

## Architect pass (2026-11-11, before code)

An independent adversarial `/architect` pass found 2 Blockers, 4 Highs, 7 Mediums and 5 Lows in the first draft. All are folded in above. The ones that changed the decision:

| # | Finding | Change |
|---|---|---|
| B1 | The seam's `orgFloor` already checks org membership on every surface call. A second check in `surface.ts` duplicates it, and the planned "non-member" witness is green on `main` | D1 uses `orgPolicy.methodScopes`; grade `A11Y89-1` corrected to the viewer-scope gap (Blocker → High) |
| B2 | The CMS read tools see published pages only, and both are compactable, so the Reviewer could not review a draft and could report a truncated page clean | D4 adds `cms.get-draft-page` and the compaction-marker rule |
| H3 | `assertRunOrgScope` has shortcuts the route does not | the tool uses the route's own `assertOrgScope` |
| H4 | The D6 regeneration list missed `SERVED-SET-BASELINE.json` | named, with the expected counts and a premise witness |
| H5 | The walker would flag hero/richText tokens that never render, and Markdown images do not exist in CMS | `visual` gating; Markdown-image rule dropped; link gap stated |
| H6 | Shared sections were invisible to the check | project `resolvedSections` |
| M7–M13 | overlay fill, stale asset list, index-based compare, D5 wording and test pins, D8 plan lock, prompt parity, decorative docs alt | each folded into D2, D4, D5 or D8 |

Premises it FALSIFIED: the cross-org read (`A11Y89-1` as written), rich-text images as a placement, D4 enabling pre-publish review, and D5's "own configured provider". Premises it VERIFIED: the trusted label, the census row, the fork re-run, the CMS/document-editor placement gaps, the projector's two keys, the tool ids, and the acting-subject spelling.

## Open questions

- [ ] **OQ-1.** Should the CMS gain a per-image "decorative" flag, so an intentionally empty alt stops reporting as missing? Assumption: no, not here. That is a CMS schema change, and today an empty alt is reported, which errs toward the user.
- [ ] **OQ-2.** Should the document editor stop using the file name as a fallback alt? Assumption: no, not in this PR (see D2). Filed with the checker's lack of a "file-name alt" rule.
- [ ] **OQ-3.** The apply/batch chain ("auto-alt-text a library"): is a workflow that WRITES alt text without a person confirming each description acceptable at all? ADR 0363 chose propose → confirm. Filed for a decision.
- [ ] **OQ-4.** Residue filed, not built: `A11Y89-17` (export resolver reads the asset's alt), `A11Y89-18` (agent section writes do not fill alt), `A11Y89-19` (Markdown links in other string fields), `A11Y89-15` (heading-level coercion).

## Implementation record

P1, one PR, branch `fl2-89/accessibility`:

| Decision | Commit | Witness |
|---|---|---|
| D1, D5, D7 (backend) | `24cf3ca8b2` | `adr1100-accessibility.test.ts` (viewer `forbidden_scope` at the floor, red with the policy removed; tool predicate; refs), `tool-content-trust-required`, `safe-mode-baseline-census` |
| D4, D6, D9 (packs) | `bb9dedfef1` | `adr1100-accessibility.test.ts` (allowlist, prompt keys and hero rule, `isSideEffectingNode`, dispatch premise) |
| D2, D3, D8 (FE) | `35cc9d3232` | `cmsA11y`, `altFromLibrary`, `sectionFieldsAltFill`, `publishChecks`, `A11yIssuesPanel`, `altTextDialogAccess`, `imageAlt` |
| D9 (docs) | `f50b9809e6` | — |
| Independent re-grade fixes (code B, UX B−) | `7bce90e956` | `cmsA11yRendererParity`, `adr1100-spend-attribution`, the extended FE cases |
| Generated: floor, served-set baseline, steward manifest | own commits | `side-effect-floor-snapshot`, `gen-*.mjs --check` |

**Changed during implementation (from the re-grades):**
- The library lookup is read at CALL time through a ref that the CMS pick updates synchronously. The Browse button awaits the picker and then calls the onChange it captured before, so a memoized map was stale.
- A swapped picture replaces a library description carried over from the old picture.
- A section with several pictures gives each its own ref (`<sectionId>#<n>`), and the panel names the image. A location is a button that opens the section. A shared section is marked as shared. A failed shared-section read makes the check incomplete, not passed.
- Generate with AI is disabled with a reason when the plan locks it, and disabled while access loads. When it is off, the help copy stops promising it.
- The CMS gains a Reviewer link into the ONE chat, scoped to the agent. (CORRECTED at the second re-grade: it is now labelled "Ask the Accessibility Reviewer", goes through the unsaved-changes guard, and seeds only the title and page id.)
- The tools refuse a plan lock as `not_entitled`.

**Second re-grade (code B+, UX B) fixes:** an incomplete check (unread shared section) is announced and shown as incomplete in the modal too, never as an all-clear. The Reviewer link goes through the unsaved-changes guard, and its seed names only the title and page id. "Go to" scrolls to the section and focuses its Edit button. Sections are numbered as the editor lists them. A swap that removes a carried-over alt is announced as a removal. The prompt says how to treat shared sections, which the reads return as `data: {}`.

**Third re-grade fixes (code B+, UX B+):**
- An unread shared section (still LOADING, or failed) makes the check incomplete. With issues, both the announcement and the publish checklist also say so.
- Sections are numbered over the resolved list, as the editor shows them.
- "Go to" from a tab without the canvas opens the section's editor.
- A library fill or removal is shown under the fields, not only announced.
- The checker warns on a file-name alt (`IMG_2041.jpg`), in both twins, with one pattern pinned equal.
- `cms.get-draft-page` marks shared references with `shared: true`, and the prompt keys on it. The prompt says a `null` draft read means a wrong id, not a published page.
- New witnesses: `a11yLocation`, `altCount`, the panel's warning with issues, the fill note, the publish incomplete row, the twin pattern parity.

**Filed (residue):**
- `A11Y89-15`, `-17`, `-18`, `-19`.
- A feature-head `rows` picture without a `stat` is not rendered but is still reported (the projector over-reports).
- The tool lane's acting subject, the `not_entitled` path and the `fields` skip are not pinned by a test.
- Remove-then-pick keeps the old library alt (the swap logic sees one change at a time). An author's alt that happens to equal another placed picture's library alt can be replaced.
- The document editor has no Reviewer link and no issue locations.
- A shared-section issue's "Go to" opens the locked reference card, not the shared-section editor.
- Two links in one section share one location.
- The Reviewer cannot read a shared section's content (needs a read tool or a resolved draft read).
- Final-round Lows (code A−, UX A−):
  - The CmsPage snapshot wiring has no page-level test.
  - `feature.accessibility.nodes` does not yet document `detail` in its `check` output text. That needs a pack edit plus a digest change, so it goes with the next pack bump.
  - `shared: true` is pinned by source text; the `adr0836` fixture would allow a behavioural test.
  - `reloadShared` has no cancel flag across org switches.
  - A locale change resets `sharedLoaded` for a moment.
  - `FILENAME_ALT` has false positives ("Screenshot 3 shows…") and misses non-ASCII names. It only warns.
