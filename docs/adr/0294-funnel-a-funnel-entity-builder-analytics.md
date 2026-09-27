# ADR 0294 — Funnel A: the funnel entity, step routing, per-step analytics, and funnel experiments

**Status:** implemented (all 6 phases, 2026-07-06) — Phase 1 implemented 2026-07-06 (entity + CRUD + lifecycle + toggle + route tests; architect-gated: no route/entity collision, promotions-pattern authz, pages composed via `cmsService.getPage`). Phase 2 implemented 2026-07-06 (public entry/step/next under the publishing public prefix — **step meta + pageSlug only**: the renderer fetches the page through the EXISTING public page read so ADR 0236 experiments/localization/SEO apply verbatim, a correction refining §2's "renders the step's published CMS page" wording; pure `funnelRouting.ts` with outcome/utm first-match rules, goto validated at write; consent-gated best-effort `funnel.step_viewed`/`step_completed` onto the CDP spine with the bounded `?vk=` visitor key; segment-membership predicates recorded as a P3+ deferral). Phase 3 implemented 2026-07-06 (derived `funnels:stat` day rollups — full-recompute rebuild on the reservation/affinity sweep pattern + an on-demand write-scoped route, honest `eventWindow` disclosure; `Order.funnelRef` additive revenue-join contract accepted by `createOrder`, stamped at checkout by ADR 0296; canceled orders excluded, refunds subtract; removed-step history tolerated on the stats read). Phase 4 implemented 2026-07-06 (step splits on the SHARED primitives — `assignWeightedVariant` with the funnel-scoped unit `funnel:<id>:step:<stepId>` + fixed-at-create salt; **the two-proportion z-test + MIN_SESSIONS floor were EXTRACTED from cms/pageExperimentsService into `host/variantAssignment.ts`** (cms re-imports — one z-test, not a fork per surface, completing §5's "extracted (not forked)" intent); variants bind CMS pages with `pageId:null` = holdout; consented-vk-only assignment sharing the ONE consent gate with events; unpublished variant pages degrade to holdout unstamped per the 0236 rule; distinct-visitor results with honest `insufficientSample`; experiments carried across step edits by stepId). Phase 5 implemented 2026-07-06 (builder UI at `/funnels` — master–detail: org funnels list + create; step editor binding CMS pages with an "Edit page" deep-link into the Page Builder (no editor fork); lifecycle actions; per-step analytics with rebuild; per-step 50/50 splits with honest verdicts; 4-locale i18n via the glob catalogs + nav labels; lazy route in the workspace tier + ⌘K via the feature manifest; i18n chunk budget deliberately bumped 282→285 kB with the dated rationale. Recorded trims: the visual routing-rule editor is a follow-on (rules remain fully authorable via the API/packs — a §6 correction); the stats Revenue column renders as a plain number because the P3 rollup sums order totals currency-agnostically — currency-aware rollups are an open question). Phase 6 implemented 2026-07-06 (packs: `feature.funnels.nodes` — list/get/create/set-steps/step-stats, all role:action, writes author DRAFT state only (the promotions firewall — publish/experiments stay human, and the surface exposes NO publish verb, pinned by test); `feature.funnels.agents` — the Funnel Architect persona, tool-allowlisted to funnels nodes; `core.openwop.workflows.funnels` chain pack — the `funnels.optimize-step` PROPOSAL-ONLY optimization chain (get + step-stats → grounded proposal; zero write nodes, empty capabilities, pinned by test). The §7 'AI authorship stays in packs' rule held: no AI calls anywhere in the feature service).
**Date:** 2026-07-06 · **Program:** [ADR 0293](0293-funnel-program.md) · **Closes:** FM-1, FM-2, FM-5
**Toggle:** new `funnels` toggle, OFF, bucket `tenant`, category Marketing.
**Wire impact:** none expected — host-extension routes + public host routes (the
publishing precedent). Anything wire-shaped stops for an RFC first.

## Context

MyndHyve's core surface is the multi-step funnel: an ordered path of published pages
(opt-in → sales → checkout → upsell → downsell → thank-you) with conditional routing
(`FunnelRoutingService`/`RouteEvaluator`), per-step conversion/revenue analytics, and
AI-assisted generation. openwop-app has **all the ingredients** — CMS pages + versions
(ADR 0009), public serving (0012), visitor-scoped experiments + the shared
`host/variantAssignment.ts` (0236), the CDP event spine + collect SDK (0269), journey
chains (0222) and the durable journey runtime (0267, in-progress), commerce checkout
(0177/0225) — **and no funnel entity** (verified: zero funnel-model hits in
`backend/typescript/src`).

## Decision

A new `src/features/funnels/` package that is a **thin composition layer** — every
heavy noun is owned elsewhere:

1. **Entity model** (`DurableCollection`, tenant-prefixed keys per the ADR 0284
   doctrine): `Funnel { funnelId, orgId, name, slug, status: draft|published|archived,
   steps: FunnelStep[] }`; `FunnelStep { stepId, kind: landing|optin|sales|checkout|
   upsell|downsell|thankyou, pageId /* a CMS page — ADR 0009, never a second page
   model */, routing?: StepRule[] }`. Steps are **first-class rows on the funnel**, not
   a view over journey definitions — routing decisions are made per-visitor at page
   speed, while journeys (0222/0267) operate on contacts over time; conflating them
   was considered and rejected (see Alternatives).
2. **Public serving**: `GET /v1/host/openwop-app/public/:orgId/funnels/:slug/:stepIx?`
   renders the step's published CMS page via the existing publishing pipeline
   (published-only, no existence leak — the 0012 gate verbatim). The step chrome
   (progress, next-step link targets) is injected the way page experiments inject
   variant selection: server-side at the public read.
3. **Routing**: `StepRule` = ordered predicates over the visitor context (UTM fields,
   prior-step outcome, segment membership via CDP where consented) → next stepIx.
   Evaluation is a pure function (`funnelRouting.ts`, unit-tested); NO bespoke
   executor — anything time-based or contact-based (abandonment, nurture) is emitted
   as an event and handled by journeys (0267), which is the standing ADR 0222 ruling.
4. **Per-step analytics** (FM-2): steps emit `funnel.step_viewed` /
   `funnel.step_completed` / `funnel.completed` / `funnel.abandoned` through the CDP
   ingest (0269 schema-registered, consent-gated 0268). Rollups (`funnelStats`:
   visits/conversions/revenue per step per day) are computed by a registered
   scheduler job — the ONE scheduler, no new daemon. Revenue joins the commerce
   order on `funnelId`/`stepId` stamps carried in checkout metadata (0296's
   contract). Retention for rollups rides ADR 0287's env-gated engine-retention
   pattern (documented, default off).
5. **Funnel experiments** (FM-5): per-step split = the **same** salted sticky
   assignment as CMS page experiments — `variantAssignment.ts` extended (not forked)
   with a funnel-scoped unit (`funnel:<id>:step:<ix>`), holdout = current published
   step page; significance = the existing two-proportion z-test with the honest
   `insufficientSample` floor. Cross-step "optimization runs" (MyndHyve's hypothesis
   generator) are a **chain pack** (`feature.funnels.chains`) driving the same
   primitives — AI authorship stays in packs, never in the service.
6. **Builder UI**: `frontend/react/src/features/funnels/` — ordered step list, each
   step opening the existing CMS Page Builder for its page (deep-link, no editor
   fork), routing-rule editor, analytics tab, experiment tab. Declared in
   `chrome/features.tsx` (workspace tier).
7. **Packs**: `feature.funnels.nodes` (create/get/list/publish/step-stats) so funnels
   are chat-drivable via the ADR 0058 agent+nodes pattern; an agent-pack persona for
   funnel authoring composes the existing campaign-studio envelopes.

## Alternatives considered

- **Funnel = a journey definition** (steps as 0267 journey nodes): rejected — journey
  nodes operate on contact state over hours/days with durable timers; funnel routing
  is per-anonymous-visitor at request time. Sharing the entity would force one
  runtime to fake the other's semantics. They *compose* instead (funnel events
  trigger journeys).
- **Funnel = an ordered CMS collection** (no new entity): rejected — routing rules,
  checkout binding, and step analytics have no home on pages; stamping them into page
  meta bloats the page model every other consumer reads.
- **Port `FunnelRoutingService`**: rejected — Firestore/client-side architecture,
  and its routing DSL predates the CDP consent model.

## Phases

| Phase | Ships | Gate |
|---|---|---|
| 1 | Entity + CRUD routes + publish lifecycle + toggle + FEATURES.md row | route tests (createApp, tenant-guard) |
| 2 | Public step serving + routing evaluation + step events | public-route tests; consent-off path verified |
| 3 | Rollups + analytics routes + revenue join contract (with 0296) | scheduler-job test; probe checklist in DATA-ASSESSMENT |
| 4 | Step experiments via shared assigner | reuse-not-fork check on `variantAssignment.ts` |
| 5 | Builder UI + ⌘K + i18n (4 locales, parity-gated) | FE build gates |
| 6 | Node/agent packs + optimization chain pack | pack validation tests |

## Open questions

- Slug namespace: per-org funnel slugs vs sharing the CMS page-slug namespace
  (leaning per-org `funnels/` prefix — zero collision with page slugs).
- Anonymous visitor identity for routing/experiments: reuse the 0236 consent-gated
  `sessionKey` verbatim (leaning yes — one visitor identity everywhere).
- Whether `funnel.abandoned` needs a durable timer at all in Phase 2 or is derivable
  in rollups (leaning derivable; timers belong to 0267).

> **Correction (2026-07-09, routing):** the master–detail funnels page kept the
> open funnel as in-page `selectedId` state. The selection now rides the URL
> (`?org=<orgId>&funnel=<funnelId>`, the CRM deep-link pattern — the ADR
> 0079/0058 routing-correction wave): shareable, reload-stable, and cleared
> automatically when an org switch or delete invalidates it. The stacked
> list + editor layout is unchanged.
