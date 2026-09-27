# ADR 0363 — Authored-Content Accessibility (AI alt-text · shared content-a11y checker · consolidated announcer)

**Status:** implemented (Phases 1–4, 2026-07-12)
**Date:** 2026-07-12

> **Phase → delivery.** P1 AI alt-text (media) · P2 shared content-a11y checker
> (`a11y/contentA11y.ts` + document-editor + CMS) · P3 `ctx.features.accessibility`
> + node/agent packs + backend twin · P4 consolidated announcer + a11y preferences.
> App-builder author-time a11y panel = the one recorded fast-follow (it already
> gets checking through the P3 `accessibility.check` node). Each phase applied the
> `/architect` → implement → `/code-review` → `/ux-review` → fix loop.
**Depends on:** ADR 0001 (feature-package), ADR 0006 (RBAC), ADR 0014 (feature
workflow surfaces), ADR 0007 (Media — the asset the alt-text attaches to),
ADR 0108 (media-to-text vision LLM — **composed**, not forked), ADR 0106
(media-generation cost governance), ADR 0334 (document a11y issues — the
`A11yIssue` model this **generalizes**), ADR 0015 (workspace-as-tenant)
**Toggle:** `accessibility` (default OFF, `bucketUnit: tenant`)
**Surfaces:** authed `/v1/host/openwop-app/accessibility/*` (host-extension,
NON-NORMATIVE — **no OpenWOP RFC**)
**MyndHyve §:** Accessibility · **Baseline:** `src/core/accessibility/`
(audit engine, focus-trap, aria-live announcer, AltTextService, preferences,
auto-fix)

---

## Context — port-not-clone, and the boundaries audit that reshaped it

MyndHyve ships a **core singleton** `src/core/accessibility/`: a live-DOM WCAG
audit engine (contrast SC 1.4.3), focus-trap/restore utilities, an `aria-live`
announcer, an `AltTextService`, a preferences store, and auto-fix remediation.

A naïve port would recreate all six as a new subsystem. The Step-3 boundaries
audit shows **four of the six already exist in this app under other owners** — so
porting them wholesale would be exactly the parallel architecture ADR 0001 and the
"no second system" discipline forbid. The port is therefore **reshaped**: this
feature *composes* what exists and adds only the genuinely-missing, high-value
slice — **AI alt-text for media** and a **shared authored-content a11y checker** —
plus a **consolidation** of the announcer that already exists three times over.

### Pre-existing-surface audit (evidence)

| MyndHyve a11y primitive | Status in openwop-app | Ruling |
|---|---|---|
| **Focus-trap / restore** | **Already exists** — `frontend/react/src/ui/useFocusTrap.ts` (module-level trap stack, nested traps) behind the `ui/Modal` focus-trap contract (DESIGN.md:286, :861). | **Reuse. Do NOT rebuild.** |
| **aria-live announcer** | **Exists 3× (fragmented)** — `chat/MessageFeed.tsx:368` (`role="status"`), `chat/ChatInput.tsx:161` (voice phase), canvas dual live-regions (DESIGN.md:673-679), `document-editor` `onAnnounce()` (`DocumentEditorSurface.tsx:164`), plus `ui/toast.tsx` (`role=alert/status`) and `ui/Notice.tsx` (`role=status aria-live=polite`). No single `announce()` hook. | **Consolidate into ONE shared hook that interops with toast/Notice; do NOT add a 4th parallel region.** |
| **Contrast audit (SC 1.4.3)** | Build-time only — `scripts/check-css-tokens.mjs` (token existence) + `scripts/check-tsx-color-literals.mjs` (no raw literals) + the ADR 0171 AA-bump token solve (`brand/theme/contrast.ts`). These govern the **token layer**, not authored content. | **Reframe: author-time content-color checks, NOT a parallel live-DOM auditor** (that would duplicate the build gate and be a dev tool). |
| **AltTextService** | **Does NOT exist** — `MediaAsset` (`media/mediaService.ts:63-90`) has `name/tags/marketing/renditions/lineage` but **no `altText`**. The only alt-text UI is a CMS section label (`cms/SectionsEditor.tsx:120`). | **Build — genuinely net-new.** Compose ADR 0108 vision path. |
| **Content a11y checker** | **Exists, document-scoped** — `documentA11yIssues(doc): A11yIssue[]` (`document-editor/documentDoc.ts:71`, ADR 0334) flags missing image alt + skipped heading levels (WCAG 1.1.1 / 1.3.1). | **Generalize the `A11yIssue` vocabulary to CMS pages + app-builder screens; do NOT fork a second issue type.** |
| **Preferences store** | Partial — CSS honors `prefers-reduced-motion` / `prefers-color-scheme` / `prefers-contrast` (DESIGN.md:430, :904). No user-level override. | **Thin: a small durable override store; low priority (Phase 4).** |

- **Namespace:** `accessibility` route prefix + `features/accessibility/` are free
  (`access-hub` is the unrelated RBAC console, ADR 0144). No collision.
- **Vision dispatch single owner:** `mediaToTextViaLLM()`
  (`kb/kbService.ts:1165`, ADR 0108) is the one vision path (image branch
  `:1117`), a **non-recorded service op** under ADR 0106 budget governance. The
  AltTextService **calls this seam with an alt-text prompt variant** — it does not
  stand up a second `dispatchManagedChat`.
- **Write path single owner:** media mutation is `PATCH /assets/:assetId`
  (`media/routes.ts:268`, whitelist `:271`); the AI-propose→user-apply pattern is
  the existing `POST /assets/:assetId/autotag` (`AutotagProposal`,
  `mediaService.ts:762`). Alt-text **mirrors autotag** (propose → apply via PATCH),
  not a new write verb.

---

## Decision

Ship a toggle-gated **`accessibility`** feature-package that adds the missing a11y
capability by composition, in three parts + one thin follow-on:

1. **AltTextService (media).** Add an additive `altText?: string` +
   `altTextSource?: 'human' | 'ai' | 'decorative'` to `MediaAsset`. A new
   `POST /accessibility/assets/:assetId/alt-text` returns an **`AltTextProposal`**
   (mirrors `AutotagProposal`) produced by composing `mediaToTextViaLLM` with an
   alt-text vision prompt; the client applies it through the **existing** media
   `PATCH` (adds `altText`/`altTextSource` to that whitelist). Governed by ADR 0106
   media budget + `workspace:write`.

2. **Shared content-a11y checker.** Promote `documentA11yIssues` into a shared
   `host/contentA11y.ts` exposing `checkContentA11y(model): A11yIssue[]` over a
   small, typed content shape (blocks with images, headings, links, authored
   colors). One `A11yIssue` vocabulary (`missing-alt`, `heading-skip`,
   `low-contrast`, `link-text`, `img-decorative-unmarked`). `document-editor`
   keeps its existing call (now re-exported); **CMS pages** (`cms`) and
   **app-builder screens** (`app-builder`) adopt the same checker at author time.
   `low-contrast` evaluates **authored** color choices (a CMS block's explicit
   fg/bg tokens), reusing `brand/theme/contrast.ts` ratio math — it is **not** a
   live-DOM sweep.

3. **Consolidated announcer.** A shared `frontend/react/src/ui/announce.ts`
   (`useAnnouncer()` + a single mounted polite/assertive live-region pair) that the
   existing per-surface callers can migrate to. It **interoperates** with
   `toast`/`Notice` (transient vs. inline) rather than replacing them, and honors
   DESIGN.md:860-864 (chat `role=log`, canvas regions). Migration is incremental;
   nothing is ripped out in one shot.

4. **Preferences (Phase 4, thin).** A durable per-user override for
   reduced-motion / increased-contrast that layers over the OS media queries.

### Core-app extension surface (ADR 0014)

- **`ctx.features.accessibility`** — read `checkContent(artifactRef)` →
  `A11yIssue[]`; write `generateAltText(assetId)` → applies to the media asset.
  Advertised at `/.well-known/openwop` **only when the toggle+pack are wired**.
- **Node pack `feature.accessibility.nodes`** (signed, Ed25519+SRI):
  - `accessibility.altText.generate` (media asset → alt text; write; ADR 0106
    budget; ADR 0341 side-effect classification = the media mutation is the
    effect, generation composes the ADR 0108 non-recorded op).
  - `accessibility.check` (content model → `A11yIssue[]`; read; pure).
  These let a workflow **auto-alt-text a whole media library** or **gate publishing
  on zero blocking a11y issues** — real orchestration value, no new machinery.
- **Agent pack `feature.accessibility.agents`** — one **Accessibility Reviewer**
  agent that composes the two nodes and is driven through the **existing chat**
  (ADR 0058 "chat-drivability = agent + node pack"; deep-link `/?agent=…`).
  **No new chat panel, no bespoke textarea.**
- **Envelopes:** none required in Phase 1 (results are typed node outputs). If a
  chat-authored alt-text flow is later wanted, add a single `accessibility.altText`
  envelope routed to the service — deferred and logged, not pre-built.

---

## Data model

```ts
// additive on MediaAsset (media/mediaService.ts)
altText?: string;                                  // ≤ 250 chars
altTextSource?: 'human' | 'ai' | 'decorative';

// host/contentA11y.ts
type A11yIssueKind =
  | 'missing-alt' | 'img-decorative-unmarked'
  | 'heading-skip' | 'low-contrast' | 'link-text';
interface A11yIssue {
  kind: A11yIssueKind;
  severity: 'error' | 'warning';
  wcag: string;            // e.g. '1.1.1', '1.4.3', '1.3.1', '2.4.4'
  nodeRef?: string;        // block/element id within the content model
  detail?: string;         // e.g. measured ratio '3.1:1 (needs 4.5:1)'
}
interface AltTextProposal {                        // mirrors AutotagProposal
  assetId: string; altText: string; confidence: number; model: string;
}
```

---

## Phased plan

- **Phase 1 — AltTextService + media field.** Additive `altText`/`altTextSource`;
  `POST /accessibility/assets/:assetId/alt-text` composing ADR 0108; media `PATCH`
  whitelist extension; media-library "Generate alt text" affordance (autotag UX
  twin). RBAC + ADR 0106 budget. Route tests.
- **Phase 2 — Shared checker.** `host/contentA11y.ts` generalized from
  `documentA11yIssues`; `cms` + `app-builder` author-time adoption via a shared
  `<A11yIssuesPanel>` built on `<Notice>`/`<StateCard>` (no new dashboard).
- **Phase 3 — Extension surface.** `ctx.features.accessibility` +
  `feature.accessibility.{nodes,agents}` signed packs + `/.well-known`
  advertisement + Accessibility Reviewer agent (via existing chat).
- **Phase 4 — Preferences (thin).** Durable reduced-motion / high-contrast
  override store + a settings toggle.
- **Announcer consolidation** runs alongside as incremental migration (no big-bang).

---

## Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | `backend/.../features/accessibility/` + `frontend/.../features/accessibility/`; appended to `BACKEND_FEATURES`/`FRONTEND_FEATURES`; composes media/kb/cms/app-builder via their public seams only. |
| 2 | Toggle + admin | `accessibility`, OFF, `bucketUnit: tenant` (shared authoring surface, ADR 0015); server-authoritative in `FeatureTogglePanel`. |
| 3 | `ctx.<feature>` | Yes — `checkContent` (read), `generateAltText` (write). |
| 4 | Node pack | `feature.accessibility.nodes`: `accessibility.altText.generate`, `accessibility.check`. |
| 5 | Envelopes | None Phase 1 (typed node outputs); optional `accessibility.altText` deferred. |
| 6 | Agent pack | `feature.accessibility.agents`: Accessibility Reviewer (driven via existing chat). |
| 7 | Public surface | **None.** Authoring-side; published pages benefit (better alt text) but add no public route. |
| 8 | RBAC + isolation | `check` = `workspace:read`; `generateAltText`/apply = `workspace:write` + media ownership + ADR 0106 budget; tenant/org IDOR-guarded; fail-closed. |
| 9 | Replay/fork | Alt-text generation composes the ADR 0108 non-recorded service op; the node's effect is the media mutation, classified via ADR 0341 `isSideEffectingNode`; provider determinism via ADR 0326 invocation log. No `featureVariant` stamp needed. |
| 10 | Frontend | `accessibilityClient.ts` + affordances **embedded** in media/cms/app-builder/document surfaces (`<A11yIssuesPanel>`, "Generate alt text"); reuse `useFocusTrap`, the shared announcer, `ui/` tokens; no standalone dashboard. |

---

## Phase 1 — implementation corrections (2026-07-12, `/architect` pre-review)

Grounding the plan against the real code moved four decisions (correct-don't-rewrite):

1. **`generateAltText` lives in `mediaService.ts` beside `autotagAsset`, NOT the
   accessibility package.** The vision seam is `resolveHeadlessAi(tenantId,
   'image')` (what autotag already uses) + `resolveMediaAsset` for bytes — both
   media-owned. Reimplementing byte-resolution + dispatch in the accessibility
   package would clone the autotag body (the ADR 0001 trap). It is a near-twin of
   `autotagAsset` with an alt-text prompt.
2. **The route is media-hosted + org-scoped + accessibility-toggle-gated:**
   `POST /media/orgs/:orgId/assets/:assetId/alt-text`, whose only addition over
   the autotag handler is a leading `requireFeatureEnabled(req,'accessibility')`.
   The ADR's org-less `/accessibility/assets/:id/alt-text` couldn't satisfy the
   org-scoped guard / `getAsset(tenant,org,asset)`. The accessibility package owns
   the toggle (P1) + the checker/surface/packs (P2–3), not this one media route.
3. **No ADR 0106 budget claim.** `MediaKind` is `'tts'|'stt'` only — there is no
   vision budget, and `autotagAsset` enforces none (vision is governed by
   provider-presence + per-org caps). Alt-text has **autotag-parity governance**
   (provider-absence 422 + `workspace:write` + tenant/org IDOR + per-org caps),
   not a fail-closed media budget. A real vision `MediaKind` is a separate,
   explicitly-scoped change if ever wanted.
4. **`AltTextProposal = { assetId, altText }`** — `model`/`confidence` are dropped
   (the headless dispatch closure returns only text; a synthetic confidence would
   be dishonest). A `DECORATIVE` model verdict returns `altText:''`; the empty
   string is a valid decorative value (`cleanAltText` allows it; `cleanName` does
   not — a dedicated sanitizer). `altTextSource` is an enum-validated
   `'human'|'ai'|'decorative'`.

**Shipped:** `MediaAsset.altText`/`altTextSource` (+ PATCH whitelist), `cleanAltText`
/`coerceAltTextSource`, `generateAltText` service fn, the media-hosted route, the
minimal `accessibility` feature-package (toggle only), 5 new route tests in
`media-intelligence.test.ts`, and the FE `AltTextDialog` (type / generate /
decorative) + alt-status chip on the media cards + `es`/`fr`/`pt-BR` strings.

## Phase 2 — implementation corrections (2026-07-12, `/architect` pre-review)

1. **Checker home is FE, not `host/contentA11y.ts`.** The editors run the check
   synchronously client-side (no network); the WCAG contrast math (`wcagRatio`,
   `brand/theme/contrast.ts`) is FE-only. The shared checker lives at
   **`frontend/react/src/a11y/contentA11y.ts`**. Phase 3's backend
   `accessibility.check` node is a small **pure rules twin** (the `pmToMarkdown`
   FE↔BE-twin precedent), returning locale-free `kind`/`wcag`.
2. **Normalized `ContentA11yModel` + per-feature projectors** (the load-bearing
   seam, previously unstated). The checker walks a normalized
   `{ images, headings, links, colorPairs }` model; each feature owns a tiny pure
   projector (`doc→model`, `page→model`, `screen→model`) importing only the shared
   type. No feature-internal coupling in the checker.
3. **`low-contrast` narrowed.** CMS sections author **no colors**; app-builder
   components author a **foreground `color` only** (no per-component bg). So a
   general authored fg/bg check is not expressible — `low-contrast` is scoped to an
   app-builder component `color` vs a fixed theme reference background, emitted as
   an advisory `warning` (one-theme caveat: the concrete color is frozen at
   pick-time). It is NOT a live-DOM sweep and NOT a CMS check.
4. **`A11yIssue` keeps `messageKey`/`params`** (adds `kind`/`severity`/`wcag`/
   `nodeRef`) so document-editor's existing render keeps working; the checker sets
   one `messageKey` per finding shape and the shared panel resolves it. Strings
   live in a **new FE `a11y` i18n namespace**
   (document-editor's 5 keys migrate there), not scattered per-feature.
5. **CMS `hero` has no `alt` field** — an additive `data.alt` on the hero section
   (small, safe) closes the gap; `image` sections already carry `data.alt`.
6. **Three distinct panel mounts** (no single abstraction): document-editor's
   existing a11y Modal, the app-builder canvas **toolbar-extra** slot, and the
   bespoke `CmsPage` detail column.

**Shipped (P2):** `frontend/react/src/a11y/contentA11y.ts` (checker + normalized
model), the `a11y` i18n ns (×4 locales), `A11yIssuesPanel`, unit tests;
**document-editor** refactored to project→shared-checker→panel (dead keys/CSS
removed); **CMS** projector (`cmsA11y.ts`) + additive hero `alt` field + a
"Check accessibility" toolbar action → panel modal. **App-builder author-time
panel deferred:** app-builder gets a11y checking through Phase 3's
`accessibility.check` node (workflow-time, the architect's app-builder-invokes-
the-shared-checker ruling); the editor toolbar-extra mount is a tracked
fast-follow, not a scope drop.

## Phase 3 — implementation corrections (2026-07-12, `/architect` pre-review)

1. **Chat-drivability requires `registerFeatureAgentTool`, not just the node pack.**
   Surface-backed nodes are excluded from the chat tool projection, so an agent
   whose `toolAllowlist` names `feature.*.nodes.*` typeIds is workflow-drivable but
   NOT chat-drivable (the production-agent precedent). The Accessibility Reviewer
   reaches its capability through `features/accessibility/agentTools.ts`
   (`registerFeatureAgentTool` for `openwop:accessibility.check` +
   `openwop:accessibility.alt-text.generate`, the ADR 0358 seam), wired from
   `registerRoutes`; the agent pack's `toolAllowlist` references THOSE ids. P3 ships
   BOTH the node pack (workflow orchestration) and the agent tools (chat).
2. **`checkContent` takes INLINE content, not an artifact ref.** NodeContext has no
   artifact-read seam, so the surface op + `accessibility.check` node accept a
   normalized `ContentA11yModel` inline (the FE projectors produce it). The backend
   returns locale-free `{ kind, severity, wcag, nodeRef? }`.
3. **Backend checker twin** `host/contentA11y.ts` — a pure port of the FE checker +
   its own WCAG contrast math (no backend contrast util existed); a hex/rgb parser
   (authored theme colors validate as hex upstream; oklch/named skip = no false
   positive). A parity test (`content-a11y-twin.test.ts`) pins FE↔BE to the same
   fixtures against drift.
4. **Packs ship UNSIGNED** like every in-repo `feature.*` pack (dev-mounted; the
   "Ed25519 + SRI" is a future registry-publish concern, not a runnable P3 step). The
   node/agent pack versions (`1.0.0`) are pinned in `feature.ts` `requiredPacks`
   lockstep.
5. **`.well-known` advertisement is automatic** — declaring `surface:` makes
   `host.sample.accessibility` appear in `hostExtensions.featureSurfaces`; no
   capability-block edit. Toggle-gating of the ops is automatic via `featureSurfaces`
   `gate()` (the feature has a `toggleDefault`).

**Shipped (P3):** `host/contentA11y.ts` (twin), `features/accessibility/{surface,
agentTools}.ts`, `feature.ts` (surface + agent-tool registration + pack pins),
`packs/feature.accessibility.{nodes,agents}` (+ reviewer prompt), and tests
(twin parity, node-pack execution, agent-tool chat-drivability + fail-closed,
auto-advertisement).

## Phase 4 — implementation notes (2026-07-12, `/architect` pre-review)

The thin final phase — two additive FE pieces, no cross-surface fan-out:

1. **Consolidated announcer** — `ui/announce.tsx` clones the `toast`/`confirm`
   module-pub/sub + one shell-mounted host (`<GlobalLiveRegion>` at `App.tsx`
   beside `<Toaster>`): imperative `announce(msg, {assertive?})` + `useAnnouncer()`,
   two `sr-only` polite/assertive regions. **Boundary:** it is for INVISIBLE status
   only — `toast`/`Notice` keep their own `role=status/alert` (routing them through
   it would re-introduce the DS-8 double-announce).

   > **Correction (2026-07-27, PR #2620).** The boundary above is sound but its
   > PREMISE was wrong: it assumed `Notice`'s own `role=status` announces. For the
   > common call shape it does not. Most `<Notice>` sites are conditionally mounted
   > (`{err ? <Notice…/> : null}`), so the region enters the DOM with its text
   > already inside — and AT registers a region on insertion, announcing only
   > subsequent mutations. `StateCard` had the identical defect (#2616, proven by
   > reverting the fix and watching the test go red). So "keeps its own role" was
   > not a decision to route around the announcer; it was an unverified belief that
   > the role worked.
   >
   > What survives unchanged is the ANTI-DOUBLE-REGION rule, which is what DS-8
   > actually was (`toast.tsx:80` — "a double region made errors announce twice").
   > `Notice` now takes an opt-in `announce` string, and setting it REPLACES that
   > instance's own region rather than adding to it — never two regions for one
   > message, enforced by construction. `role="alert"` on the error variant is left
   > untouched and explicitly NOT claimed to work; that remains unverified. **One reference adopter:**
   `chat/MessageFeed` (the settled-reply announcement); the canvas/voice/document
   announcers migrate incrementally (documented follow-on, nothing ripped out).
2. **A11y preferences** — `ui/a11yPrefs.ts` mirrors `ThemeToggle`: localStorage +
   `data-reduce-motion`/`data-contrast` on `documentElement` + an `index.html`
   pre-paint line (no flash). **Reduce-motion** = a parallel CSS mirror of the OS
   `@media` block keyed on the attribute (OS-pref OR override collapses motion) +
   `ui/motion.ts` honoring it; motion offers **System/Reduce only** (CSS can't
   force motion back ON against an OS reduce-pref). **Contrast** = a small ADDITIVE
   CSS block (`:root[data-contrast="more"]` — stronger ink/borders, NO ADR 0171
   token regeneration) + the `prefers-contrast:more` OS signal. The `<A11yPrefsControl>`
   lives in the **Sidebar footer** beside Theme/Language — **no new page**. Labels
   reuse the P2 `a11y` i18n ns (×4 locales).

**Shipped (P4):** `ui/announce.tsx`, `ui/a11yPrefs.ts`, `ui/A11yPrefsControl.tsx`,
the `App.tsx`/`Sidebar` mounts, the `MessageFeed` adopter, the global.css mirror +
contrast blocks, the `motion.ts` + `index.html` pre-paint updates, and a unit
test. **ADR 0363 is now fully implemented (Phases 1–4).**

## Alternatives weighed

1. **Faithful port of `src/core/accessibility/` as a core singleton — rejected.**
   Recreates focus-trap, announcer, and contrast that already exist; a textbook
   parallel architecture.
2. **Live-DOM runtime WCAG auditor — rejected for Phase 1.** Duplicates the
   build-time token gate + ADR 0171 solve, is a dev tool more than a product
   surface, and can't cleanly attribute issues to authored content. The
   author-time content checker delivers the user-facing value without the parallel
   auditor. (Revisit as a devtools panel only if demanded.)
3. **Separate alt-text store — rejected.** Alt text is media metadata; it belongs
   on `MediaAsset`, written through the one media `PATCH`, not a sidecar store.
4. **A dedicated "Accessibility" chat panel — rejected.** Violates the single-chat
   rule; the Reviewer agent rides existing chat (ADR 0058).

## Open questions

- Should `low-contrast` checking extend to **theme-token** combinations a CMS
  author selects (bounded, ADR 0171 tokens) only, or also arbitrary authored hex?
  (Assumption: token combos only — raw hex is already banned by the build gate.)
- Alt-text length/policy: enforce a 250-char cap + reject text-in-image verbatim?
  (Assumption: yes, cap + a "decorative" opt-out that sets `alt=""`.)
- Does app-builder screen a11y checking belong here or inside the app-builder
  application-model program (ADR 0342/0346 per-screen review)? (Assumption: the
  **checker** is shared here; app-builder **invokes** it — no duplication.)

## RFC verdict

**Host-extension, NON-NORMATIVE — no OpenWOP RFC.** All routes under
`/v1/host/openwop-app/accessibility/*`; composes Accepted-RFC-backed seams
(vision via managed provider, ADR 0108) and host-internal surfaces. Nothing
touches the wire; `ctx.features.accessibility` is advertised only when honored.
