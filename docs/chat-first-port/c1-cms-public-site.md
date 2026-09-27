# CMS & public site (unit C1) — chat-first port review

Scope: `backend/typescript/src/features/{cms, publishing, custom-domains, accessibility}`
+ `frontend/react/src/features/{cms, publishing, custom-domains, site}`.
Pages are content-kernel rows (`cms.page`, ADRs 0406/0407/0408). Toggles:
`cms-approval-gate` (OFF), `cms-localization` (OFF), `accessibility` (OFF),
`custom-domains` (OFF). CMS + publishing are always-on (ADR 0027).

## Headline

C1 is the unit that **already rides the engine hardest of anything reviewed so
far**: the CMS ships a real chat agent with governed write tools
(`feature.cms.agents.content-editor`), a seeded, tested workflow chain
(`cms.localize-and-submit`), an interrupt-backed publish approval on the shared
ApprovalsInbox (ADR 0066), and an accessibility agent on
`registerFeatureAgentTool`. There is **no orphaned workflow and no toothless
agent** in this unit. The residue is small and specific: (1) the content-editor
agent is built and roster-loaded but has **no entry point from the CMS surface**
(only the localizer is deep-linked); (2) the in_review→approve/reject **decision
is bespoke header buttons by default** because the shared-HITL path is behind an
OFF-by-default toggle; (3) one **AI-behind-a-button** inline translate lane
duplicates the localizer agent. Everything else (the page-builder editor, SEO,
sitemap/RSS/blog, custom domains, version history, experiments) is legitimately
page-shaped.

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Ask the localizer to draft overlays | Deep-link `navigate('/?agent=feature.cms.agents.localizer')` (`CmsPage.tsx:76,608`) | **RIDES** | Leave — the ADR 0058/0073 "no second chat" pattern, done right |
| Author/localize/submit a page by describing intent | `feature.cms.agents.content-editor` with governed write tools (`packs/feature.cms.agents/pack.json:29-45`; surface `surface.ts:85-137`) | **RIDES (unsurfaced)** | Keep the agent; add a CMS entry point (deep-link or `EmbeddedChatPanel`), like the localizer button |
| Localize-a-section-and-submit workflow | `cms.localize-and-submit` chain, boot-loaded gallery template (`examples/workflow-chain-packs/cms-localization/pack.json`; tests `cms-chain-execution.test.ts:105`) — **correction 2026-08-20 (feature-23 assembly): NOT seeded** — `seedWorkflows.ts:59-74` skips chains with required params and this chain has 4; it is reachable via the builder gallery + `/workflows/from-chain`, not as a pre-seeded tenant workflow | **RIDES** | Leave — real igniter (`/workflows/from-chain` + chat run — no seed), human-gated submit, no publish step |
| Submit page for review | `POST …/submit` → `transitionPage('submit')` + `queueContentApprovalIfGated` (`routes.ts:263-321`, `contentApproval.ts:116-132`) | **RIDES** | Leave |
| Approve/publish when gate ON | ApprovalsInbox `content-publish` row + `decideContentPublish` (`contentApproval.ts:43-107`) | **RIDES** | Leave — the correct shared-HITL path |
| Accessibility check + alt-text | `registerFeatureAgentTool` (`accessibility/agentTools.ts:31-94`) + `ctx.features.accessibility` (`surface.ts:24-37`) | **RIDES** | Leave |
| Preview links | Composes the sharing owner (`CmsPage.tsx:365-382`; `createLink/revokeLink`) | **RIDES** | Leave |
| Auto-translate on submit | Bounded, missing-only, review-before-publish (`translate.ts:139-172`, `routes.ts:279-311`) | **RIDES** | Leave |
| **Approve/reject an in_review page (default, gate OFF)** | Bespoke header `<button>`s from `ACTIONS_FOR` → `POST …/approve|reject` (`CmsPage.tsx:80-85,612-614,296-312`; `routes.ts:322-359`) | **PARALLEL** | Route the *decision* through the reviews inbox/interrupt card; make ADR 0066 the default, demolish the approve/reject buttons |
| Inline "translate this field" button | `POST …/translate-section` behind editor button (`CmsPage.tsx:724-736`; `routes.ts:564-601`) | **ADAPTER** | Keep as a thin editor utility; watch drift vs the localizer agent (same sanitizer, review-then-save) |
| Scheduled publish | Admin one-shot + minute sweep over marker rows (`cmsService.ts:1283-1329`, `publishSweep.ts`) | **ADAPTER** | Leave |
| Shared sections library | Reusable section CRUD + impact list (`cmsService.ts:1137-1276`) | **ADAPTER** | Leave |
| Page structural editing (section builder) | Bespoke `SectionsEditor` form editor (`CmsPage.tsx:697-737`) | **PAGE-LEGIT** | Keep; the intent-driven complement is the content-editor agent (above) |
| Version history / diff / restore | Read + restore-into-draft (`cmsService.ts:932-958`; `CmsPage.tsx:802-823`) | **PAGE-LEGIT** | Keep (provenance) |
| Page A/B experiments | Config + read-time results projection over analytics (`pageExperimentsService.ts:386-459`) | **PAGE-LEGIT** | Keep; honest results read, no second event store |
| Public delivery / sitemap / robots / RSS / blog | Unauthed read projections (`publishingService.ts:141-413`) | **PAGE-LEGIT** | Keep |
| SEO metadata editing | Bespoke form `putSeo` (`PublishingPage.tsx:131`; `publishingService.ts:69-104`) | **PAGE-LEGIT** | Keep (config form; no AI) |
| Custom-domain add/verify/remove | Bespoke CRUD + DNS-TXT flow (`custom-domains/routes.ts`; `DomainsPage.tsx`) | **PAGE-LEGIT** | Keep (operator config) |
| Language settings / translator grants | Admin config + RBAC narrowing (`routes.ts:495-556`; `cmsService.ts:1059-1135`) | **PAGE-LEGIT** | Keep |

**Counts:** RIDES 8, ADAPTER 3, PARALLEL 1, THEATER 0, PAGE-LEGIT 7.

## Blockers (from scouting) — each with the honest alternative

1. **The approvals owner is instantiated but bypassed by default.** ADR 0066
   built the correct path — `content-publish` rows on the shared ApprovalsInbox,
   `decideContentPublish` with CAS + org-RBAC + IDOR (`contentApproval.ts:43-107`)
   — but it only engages when `cms-approval-gate` is ON, and the toggle defaults
   OFF (`feature.ts:51-59`). For every default tenant the in_review→approve/reject
   *decision* is a pair of bespoke header buttons (`CmsPage.tsx:612-614`,
   `ACTIONS_FOR` `:80-85`) hitting `POST …/approve|reject` directly
   (`routes.ts:322-359`). That is a human decision rendered outside the shared
   HITL machinery — law 4. **Alternative:** default the gate ON (or always mint a
   `content-publish` interrupt on `submit` regardless of the toggle) so the
   decision renders as a reviews-inbox/interrupt card with a durable record;
   demolish the approve/reject buttons. Keep publish/unpublish/archive as admin
   *state* controls (they are status transitions, not review decisions).

2. **The content-editor agent has no CMS-surface igniter.** The agent and its
   six governed tools are declared (`packs/feature.cms.agents/pack.json:29-45`)
   and boot-installed via `requiredPacks` (`feature.ts:30-33`), so it is
   roster-reachable in the main chat — but nothing in the CMS UI opens it. Only
   the *localizer* gets a deep-link button (`CmsPage.tsx:608`). This is not
   theater (the execution path is real and tested), but the capability is
   invisible where users author. **Alternative:** add an "author with AI" affordance
   on the page detail that deep-links `?agent=feature.cms.agents.content-editor`
   (or renders `chat/EmbeddedChatPanel` scoped to it), mirroring the localizer
   button and `builder/CreateWithAiPanel`.

3. **The section model is not a canvas, and re-platforming it is out of scope.**
   The interface test says structural editing → canvas trait, but the CMS section
   editor (`SectionsEditor`, typed `SECTION_TYPES` in `cmsService.ts:60-61`, kernel
   `blocks` kind `:199-205`) predates the canvas chassis and has deep, page-specific
   validation/sanitization. This is a genuine PAGE-LEGIT bespoke editor, not a
   demolition target — the intent-driven complement already exists (the
   content-editor agent). **No port; recorded so a future canvas unification is a
   deliberate decision, not an accident.**

## Demolition list (with regression pins to add)

- **Approve/reject header buttons** (`CmsPage.tsx:612-614` for the `in_review`
  entries of `ACTIONS_FOR` `:81`). Replace with a reviews-inbox/interrupt-card
  decision. Pin: a test asserting `submit` on a page (default config) opens a
  `content-publish` approval and that no direct `/approve` route flips
  draft→published without an inbox row (extend `contentApproval` tests).
- **Nothing else.** The inline translate button, page builder, SEO form, domains
  form, experiments panel, and all public read surfaces are keepers.

## New-code inventory (small)

- One CMS entry-point control opening the content-editor agent
  (deep-link or `EmbeddedChatPanel` override — no new chat).
- Gate-default flip (or unconditional `content-publish` mint on submit) +
  removal of the approve/reject buttons; the decide handler already exists.
- Regression pins above. No new nodes, no new workflow, no new owner, no wire
  change.

## Phased plan (gated on real gates; never demolish before the replacement works)

- **P1 — Surface the content-editor agent.** Add the entry point; verify in
  `/browser`. Close with `/code-review` + `/ux-review`. (Purely additive; no
  demolition.)
- **P2 — Make the publish decision ride HITL by default.** Flip
  `cms-approval-gate` default ON *or* mint the interrupt on every submit; confirm
  the reviews-inbox card renders and leaves a durable record; only then demolish
  the approve/reject buttons and land the regression pins. Close with
  `/code-review` + `/ux-review`.
- **P3 — Grade pass.** `/grade-code` + `/grade-data` over the touched CMS
  surface (the ADR 0458 sweep precedent caught an authz-parity miss every earlier
  review missed).

## Deferred honestly

- **Page-builder → canvas unification:** deferred. The section model is a
  first-class bespoke editor with page-specific validation; a canvas port is a
  large, deliberate effort, not C1 residue.
- **SEO / custom-domains / experiments as chat-driven flows:** deferred. All are
  low-frequency operator config that read honestly and describe intent poorly;
  page-shaped is correct. An `registerFeatureAgentTool` for "set SEO" or "add
  domain" is possible later but not warranted now.
- **Custom-domains + accessibility toggles OFF:** reviewed on merits above; both
  are correctly built (RIDES / PAGE-LEGIT) and simply not activated.
