# ADR 0172 — Production Intelligence (Vendor Directory + AI production planning)

**Status:** implemented (Phases 1–5 + extension surface — 2026-07-01)
**Date:** 2026-06-30
**Track:** A (Software & App Architecture) — a host feature-package under
`/v1/host/openwop-app/*`. **Nothing touches the OpenWOP wire** (no run-event field,
capability flag, event type, endpoint contract, or normative MUST), so **no new
RFC** (CLAUDE.md § "A spec change needs an RFC"). It rides already-implemented host
seams only.
**Depends on:** ADR 0005 (Profiles — team capability data), ADR 0008 (CRM —
`Company` reference), ADR 0011 (KB/RAG — portfolio indexing), ADR 0014 (feature
workflow surfaces / `ctx.features.*`), ADR 0006 (RBAC), ADR 0015 (workspace-as-
tenant), ADR 0055 (host artifact-type registry), ADR 0083 (run-output artifacts).
**Consumed by:** ADR 0156 (Campaign Brief) / ADR 0158 (Campaign Studio
orchestration) — the primary caller of the production-plan node.
**Owner of production data:** a NEW feature-package
`backend/typescript/src/features/production/` (+ `frontend/react/src/features/
production/`). NOT `profiles`, NOT `crm`, NOT `kb`.
**Surface:** `/v1/host/openwop-app/production/*` (host-extension, NON-NORMATIVE) +
`ctx.features.production` (ADR 0014).
**Toggle:** `production` (default **OFF**, `bucketUnit: tenant`, category
`Business Tools`).
**Packs:** `feature.production.nodes`, `feature.production.agents`.

> **Port context.** This completes the MyndHyve **"Production Intelligence
> (CS-010)"** port that ADR 0005 began. ADR 0005 shipped only *Team Profiles*; the
> § "Out of scope" note in [ROADMAP.md](../../ROADMAP.md) explicitly deferred "the
> rest (Vendor Directory + `ProductionPlanService`) to a future ADR." This is that
> ADR. Baseline source: `/Users/david/dev/myndhyve/` —
> `src/core/workspace/types/vendor.ts`, `.../campaign-studio/types/productionPlan.ts`,
> `.../services/{ProductionContextBuilder,ProductionPlanService}.ts`.

---

## Context — boundaries & pre-existing-surface audit (done first)

A full boundaries audit (2026-06-30) proved every namespace this feature claims is
free and named the single owner of every concept it composes:

**Collision-free namespaces (verified):**
- **No existing `Vendor` / `contractor` / `agency` model, store, route, or type**
  anywhere in `backend/typescript/src`. Every `vendor` hit is an unrelated
  pack-namespace string (`vendor.myndhyve.*`, `vendor.openwop-app.*`) or English
  prose. The `Vendor` entity name is free.
- **No `/production` route prefix, no `ctx.features.production`, no
  `production.plan.*` node, no `production*` service/type.** Every `production` hit
  is the English word or `NODE_ENV === 'production'`. The `production` toggle id,
  the `/v1/host/openwop-app/production` route prefix, and `ctx.features.production`
  are all unclaimed.

**Single owners this feature COMPOSES (does not fork):**
- **Team capability data → Profiles (ADR 0005).**
  `profilesService` (`src/features/profiles/profilesService.ts`) already owns the
  `Profile` per `User.userId` with exactly the fields the ranker needs: `skills`
  (`{name, proficiency 1..5, endorsements}`), `equipment`, `availability`,
  `portfolioAssetTokens`, `interests`, and a `knowledge?: {collectionIds?}` binding
  (ADR 0042). `listProfiles(tenantId)` is the directory read the context-builder
  consumes. **Production adds ZERO team fields** — it reads the profile directory.
- **External company/org → CRM (ADR 0008).** `crmEntitiesService` owns the
  `Company { companyId, tenantId, orgId, name, domain, industry, … }` and exposes
  `getCompany`/`listCompanies` read-only on `ctx.features.crm`. A Vendor **references**
  a `companyId` (optional) rather than re-modelling the org.
- **Document indexing → KB (ADR 0011).** `kbService.ingestDocument(…)` +
  `KnowledgeCollection.managed?` is the managed-collection mechanism. The exact
  reuse exemplar is `features/strategy/strategyKnowledgeService.ts` (imports
  `createCollection`/`upsertDocument`/`deleteDocument` from `../kb/kbService.js`,
  owns a `managed` collection kept synced by stable entity id). Twin:
  `features/priority-matrix/priorityMatrixKnowledgeService.ts`.
- **Media bytes → the media-asset surface (RFC 0055).** Vendor portfolio samples
  are stored as media-asset **tokens** (like `Profile.portfolioAssetTokens`), never
  inline bytes.
- **Run-output artifacts → ADR 0055/0083.** `host/artifactTypes.ts` +
  `host/runArtifactStore.ts` are implemented; features register a type in
  `features/<id>/artifactTypes.ts` (campaign-studio, slides, code-exec already do).

**Architecture-contract mapping ([ARCHITECTURE.md](../../ARCHITECTURE.md) §
"Existing extension seams"):** every element maps to an existing seam row — product
feature → `src/features/production/`; composition → `BACKEND_FEATURES` /
`FRONTEND_FEATURES`; toggle → `host/featureToggles/`; workflow API →
`ctx.features.production` via `host/featureSurfaces.ts`; durable data →
`DurableCollection`; agents → `feature.production.agents`. **No seam is missing; no
parallel system is created.**

**One gap flagged (not a blocker):** Profiles has **no `ctx.features.profiles`
surface** today. The production surface therefore reads the profile directory
**directly** via `profilesService.listProfiles(scope.tenantId)` inside
`buildProductionSurface` (an in-package import of the profiles service, which is a
sibling *feature service*, not a core→feature up-dependency). Adding a
`ctx.features.profiles` surface to Profiles is a cleaner long-term option but is
out of scope here — noted in Open Questions.

## Decision

Ship a self-contained **`production` feature-package** (ADR 0001) that adds three
capabilities on top of the composed owners above:

1. **Vendor Directory** — a net-new `Vendor` entity (the one genuinely new store),
   tenant+org-scoped, CRUD behind RBAC, optionally referencing a CRM `companyId`.
2. **ProductionContextBuilder** — a pure ranking function that scores the profile
   directory + vendors against a brief's enabled channels → a token-capped AI-prompt
   context. Exposed read-only on `ctx.features.production`.
3. **ProductionPlanService** — generates a `ProductionPlan` (per-asset execution
   route internal/contractor/agency/hybrid, budget, timeline) **as a workflow run**,
   persisted as a durable feature entity **and** projected as a registered
   run-output artifact for preview.

### Port-not-clone corrections (the MyndHyve warts we do NOT inherit)

| MyndHyve shape | Correction here | Why |
|---|---|---|
| `ProductionPlan` is a Firestore doc **coupled to `CampaignBrief`** (`briefId`, `canvasDocId` required) | The plan is generated by a generic `production.plan.generate` **workflow node** whose inputs are an *asset list + a context bundle*; `briefId` is an **optional** provenance ref. Campaign Studio is the first caller, not the owner. | Decouples the reusable planning capability from one product surface (the ADR 0053/0082 "compose, don't fork" lesson). Makes it usable from any workflow. |
| Plan generation is a synchronous service call inside the brief pipeline | Generation is a **run** (`ctx.callAI` inside the node); the durable `ProductionPlan` is written from the run, and additionally emitted as a **run-output artifact** (ADR 0083) for chat/preview. | Replay/fork-safe (AI output recorded in-run, read verbatim on `:fork`); the recorded plan is the source of truth, not a re-resolved call. |
| Team + vendor data assembled by a bespoke `ProductionContextBuilder` reading Firestore directly | The builder is a **pure function** `buildProductionContext(channels, profiles, vendors, opts)` fed by the composed owners (`profilesService.listProfiles`, the vendor store), exposed via `ctx.features.production.buildContext`. | Testable in isolation; no second copy of team data; hard token cap preserved (1500). |
| `team-portfolio` / `vendor-portfolio` are ad-hoc media categories | Portfolio indexing is a **`managed: 'production'` KB collection** per the `strategyKnowledgeService` template; `contentTrust:'untrusted'` fencing + media-token ingest come for free. | Single KB owner; no new vector store; RBAC-protected managed collection. |

### The data model

```
Vendor {                                   // NEW — the one net-new store
  vendorId, tenantId, orgId,               // tenant+org key = CTI-1 isolation
  type: 'contractor' | 'agency',
  name,                                    // bounded text
  companyId?,                              // OPTIONAL ref → CRM Company (ADR 0008)
  contactEmail?, website?, region?,
  capabilities: { name, category, qualityRating?: 1..5 }[],
  priceRanges: { capability, min, max, unit:
                 'per-hour'|'per-project'|'per-month'|'per-word'|'per-asset' }[],
  pastProjects: { projectId, name, completedAt? }[],
  portfolioAssetTokens: string[],          // media-asset refs (bytes stay in Media)
  contractStatus: 'active' | 'inactive' | 'preferred',
  notes?, lastVerifiedAt?,
  createdBy?, createdAt, updatedAt
}

ProductionPlan {                           // durable feature entity + artifact
  planId, tenantId, orgId,
  briefId?, workflowRunId,                 // provenance (briefId OPTIONAL — decoupled)
  strategySummary,
  recommendations: ProductionRecommendation[],  // per-asset route + rationale + budget
  totalBudget: { min, max, currency, breakdown? },
  timeline: { estimatedDeliveryDate, milestones[] },
  capabilityAssessment: { strengths[], gaps[], overallRecommendation, confidence },
  status: 'draft' | 'approved' | 'in_production' | 'completed',
  generatedAt, updatedAt, updatedBy?
}
// ProductionRecommendation carries executionRoute, rationale, budget, timelineEstimate,
// and (route-dependent) internalMatch{suggestedMembers[],gaps[]} / outsourceSpec{matchingVendors[]}.
```

Both stores use `DurableCollection` keyed by the entity id, tenant+org enforced on
every read/write (the profiles/CRM IDOR pattern). **A vendor field confers no
authority** (the RFC 0087 §B invariant carried from ADR 0005): `qualityRating`,
`contractStatus`, and capabilities are descriptive — they never widen a scope.

### Authority model (composes ADR 0006)

- **Vendor read** — any tenant member with `workspace:read` in the vendor's org.
- **Vendor write/delete** — `workspace:write` (org-scoped); delete may be gated to
  admin (`host:members:manage`) — see Open Questions. Cross-tenant/cross-org access
  fails closed with `not_found` (no existence leak).
- **Production plan** — generated behind `workspace:write` + the `production`
  toggle; the plan's `status` transitions (`draft→approved→…`) require
  `workspace:write`; V1 is **advisory-only** (no PM/task side-effects), matching the
  MyndHyve `status: 'pending'` advisory posture.
- **Context builder** (`ctx.features.production.buildContext`) — read-only, gated by
  the toggle in the feature-surface `gate()` (off ⇒ `ctx.features.production`
  refused).

## Phased implementation plan

**Phase 1 — Vendor Directory (REST + store).** `productionService` +
`DurableCollection<Vendor>('production:vendor', v => v.vendorId, …, v => v.tenantId)`.
Routes under `/v1/host/openwop-app/production/vendors`: `GET` (org directory,
search/filter), `POST`, `GET/:id`, `PATCH/:id`, `DELETE/:id` (+ portfolio token
add/remove with image-content-type + same-tenant validation, the ADR 0005 Phase-2
rule). Optional `companyId` validated against `ctx.features.crm.getCompany` at write.
Feature-package wiring (`feature.ts` + append to `BACKEND_FEATURES`) + the
`production` toggle. Route-harness tests (authz + toggle gate + IDOR + collision
smoke on `/production`).

**Phase 2 — ProductionContextBuilder + `ctx.features.production`.** Pure
`buildProductionContext(...)` (channel→skill-category map, +2/skill +1/interest,
top-10 members / top-5 vendors, hard 1500-token cap). `buildProductionSurface(scope)`
exposes read-only `buildContext(args)` + `listVendors()` + `getPlan(id)` on
`ctx.features.production`; `surface: { id:'production', build }` in `feature.ts`
(auto-advertised as `host.sample.production` via the live registry — `discovery.ts`).
Reads `profilesService.listProfiles(scope.tenantId)` for the team side.

**Phase 3 — ProductionPlanService + node pack + artifact type.**
`feature.production.nodes` with `production.context.build` (deterministic — wraps the
Phase-2 builder) and `production.plan.generate` (`role:'action'` — runs `ctx.callAI`
with a Zod-validated response schema, writes the `ProductionPlan`, emits the
run-output artifact). Register a `production-plan` artifact type
(`features/production/artifactTypes.ts`, ADR 0055) for workbench preview. Plan-status
transition routes (`POST /production/plans/:id/approve` etc.). The node is
independently runnable AND dispatchable so ADR 0158's DAG can slot it post-merge,
pre-consistency-check.

**Phase 4 — Portfolio KB indexing.** `productionKnowledgeService.ts` (mirrors
`strategyKnowledgeService`): extend the KB `managed` union to include `'production'`;
create/keep-synced `managed:'production'` collections; a vendor's
`portfolioAssetTokens` (and team portfolios) `upsertDocument` by stable
`vendor:<id>`/`profile:<id>` doc id on write, `deleteDocument` on delete. The
context-builder's `portfolioKBContext` option is filled from a `ctx.kb.search` over
these collections. Managed collections are RBAC-protected + hand-edit-suppressed in
the FE (the ADR 0100 transparency pattern).

> **§Correction + completion (2026-07-12 fold-in).** The vendor half shipped in
> Phase 4; the **team-portfolio half was deferred** and is now DONE — but NOT as
> planned. The plan put `profile:<id>` docs *alongside* `vendor:<id>` in the
> per-org `mgd-production-<org>` collection; that is impossible cleanly because
> **profiles are tenant-scoped with no org** (ADR 0005) and profile CRUD carries no
> `orgId`. So team profiles index into a **distinct tenant-level collection**
> `mgd-team-<tenant>` under a reserved sentinel org `_team` (`createCollection`
> never validates org existence), via `features/profiles/profilesKnowledgeService.ts`
> (mirrors the vendor indexer: best-effort, gated on `production`, reusing
> `managed:'production'` so no managed-union/board-enumerator change). It indexes
> DESCRIPTIVE capability text only (skills/equipment/interests/jobTitle/bio —
> team-visible per ADR 0005, so no leak; contact/location PII + opaque
> `portfolioAssetTokens` excluded, the media-byte deferral unchanged). Wired at the
> profile-edit routes (`updateOwnProfile`/`setOwnSkills`) + a subject-eraser for
> GDPR removal. Empty profiles are unindexed, not stored as noise.

**Phase 5 — Agent pack + Frontend.** `feature.production.agents`: a **Production
Planner** agent (`persona: 'RESEARCH'`, `toolAllowlist` scoped ONLY to
`openwop:feature.production.nodes.*`) — the chat-drivable path (ADR 0058), no bespoke
panel. Frontend `src/features/production/`: a **Vendors & Contractors** admin page
(search/filter/add-edit/pricing editor) + a read-only **Production Plan** view
(recommendations, budget, capability gaps), registered in `FRONTEND_FEATURES` +
`FEATURES` (`frontend/react/src/chrome/features.tsx`). Canonical `npm run build` gate.

## Core-app extension surface (the "not just REST+UI" checklist)

- **`ctx.features.production`** (ADR 0014) — `buildContext`, `listVendors`,
  `getPlan`; toggle+RBAC gated; auto-advertised in `/.well-known/openwop`.
- **Node pack** `feature.production.nodes` — `production.context.build` (sensor/read),
  `production.plan.generate` (action). Signed via the registry pipeline; declared in
  `requiredPacks`.
- **Agent pack** `feature.production.agents` — the Production Planner (allowlisted to
  its own nodes only).
- **Artifact type** `production-plan` (ADR 0055) — run-output projection for preview.
- **Envelopes** — none new; plan generation is a workflow run, not a chat envelope
  (chat-drivability = agent + nodes, ADR 0058).

## Architectural constraints honored

- **Boundaries / single source of truth:** Production owns only the Vendor entity +
  the ProductionPlan; team data stays in Profiles, org identity in CRM, bytes in
  Media, vectors in KB. No parallel roster/identity/store.
- **No authority from description (RFC 0087 §B):** no vendor/plan field widens a scope.
- **Tenant+org isolation (CTI-1):** every read/write scoped; cross-scope = `not_found`.
- **Replay/fork:** the plan's AI output is recorded in-run and the durable
  `ProductionPlan` is read verbatim on `:fork` — never re-resolved.
- **No wire surface → no RFC:** entirely `/v1/host/openwop-app/*`; no capability flip,
  no event type. (Advertising `host.sample.production` is derived from the live
  feature-surface registry — not a wire-capability claim.)
- **Secret hygiene:** free-text (notes, capability names) scrubbed for secret-shaped
  tokens before persistence (the profiles/annotations redaction reuse).

## Alternatives considered

1. **Extend CRM `Company` with vendor fields (custom fields).** Rejected — a Vendor
   is a distinct concept (capabilities, quality ratings, price-range units, contract
   status) that `Company` doesn't model; bolting it on bloats the CRM entity and
   couples production churn to the sales pipeline store. Own the Vendor record in
   `production`, **reference** a `companyId` — the Profiles-references-media precedent.
2. **Clone MyndHyve's `ProductionPlan` bound to `CampaignBrief`.** Rejected — see the
   port-not-clone table; couples a reusable capability to one surface and puts a
   non-deterministic AI call outside the run/replay envelope.
3. **A new `production` RFC + `capabilities.production`.** Rejected — pure
   host-extension product surface, no cross-host/wire contract; CLAUDE.md is explicit
   that `/v1/host/openwop-app/*` never needs an RFC.
4. **Fold production into the campaign-studio package.** Rejected — the Vendor
   Directory + planning are useful beyond marketing (any asset-production decision);
   a standalone feature keeps campaign-studio from owning a second domain. Campaign
   Studio *consumes* the node.
5. **Add a `ctx.features.profiles` surface now to feed the builder.** Deferred — the
   in-package `profilesService.listProfiles` read is sufficient and lower-risk;
   promoting it to a `ctx` surface is a Profiles change, tracked as an Open Question.

## Implementation (phase → artifact)

| Phase | Shipped | Tests |
|---|---|---|
| 1 — Vendor Directory (REST + store) | `features/production/productionService.ts` (Vendor `DurableCollection`, tenant+org CTI-1, per-org cap, price-range normalization) + `routes.ts` (`/production/orgs/:orgId/vendors` CRUD + portfolio, `authorizeOrgScope`, CRM `companyId` IDOR-validation) + `feature.ts` + `production` toggle + `BACKEND_FEATURES` | `production-route.test.ts` (6: toggle/RBAC/IDOR/CRUD/companyId/plan) |
| 2 — ProductionContextBuilder + `ctx.features.production` | `productionContext.ts` (pure ranker: channel→category, skill-name inference, token cap, gaps) + `surface.ts` (`buildContext`/`listVendors`/`getVendor`/`listPlans`/`getPlan`/`savePlan`) | `production-context.test.ts` (6: mapping/ranking/gaps/token-cap) |
| 3 — ProductionPlanService + node pack + artifact type | `productionService.ts` (`ProductionPlan` store + advisory status transitions, untrusted-AI-output sanitizers) + `artifactTypes.ts` (`production.plan`, ADR 0055) + `packs/feature.production.nodes` (`context-build`, `plan-generate` role:action) | route test (plan read + status) |
| 4 — Portfolio KB indexing | `productionKnowledgeService.ts` (`managed:'production'` collection, best-effort/fail-open, wired into vendor CRUD) + kbService `managed` union extended | (rides KB suite) |
| 5 — Agent pack + Frontend | `packs/feature.production.agents` (Production Planner, allowlisted to own nodes) + `frontend/react/src/features/production/*` (page + client + routes + en/pt-BR/fr/es i18n), `FRONTEND_FEATURES` | `productionClient.test.ts` (6) |

Commits: `8696cac` (ADR + docs) · `74efa01` (backend Phases 1–4) · `c9f89b7`
(frontend Phase 5) · `8f9285c` (ux tones + FE test). Gates: backend `tsc` +
vitest green; frontend `npm run build` (tsc + i18n/token/CSS integrity + vite) +
eslint(0) + vitest green. Host-extension only — no wire, no RFC.

## Open questions

- [ ] **Vendor delete authority.** `workspace:write` vs admin-only
  (`host:members:manage`)? MyndHyve gated delete to admin+; default to `workspace:write`
  unless a consumer needs stricter, matching CRM entity deletes.
- [ ] **`ctx.features.profiles` surface.** Add a read-only profiles surface (cleaner
  than the in-package service read) or keep the direct import? Decide with the
  Profiles owner; not blocking.
- [ ] **Plan advisory → actionable.** V1 is advisory (`status` only). Wiring
  accepted recommendations to real work (task-deck ADR 0133 / assignments ADR 0049)
  is a future phase — do NOT invent a parallel task store.
- [ ] **Channel→skill map source.** Hard-coded (MyndHyve) vs tenant-configurable.
  Start hard-coded; make it data-driven only if a consumer needs it.
- [ ] **Portfolio asset TTL.** Same media-retention caveat as ADR 0005 Phase 2 —
  confirm portfolio tokens outlive the 7-day default or refresh.

## Correction note (PIC-2, 2026-08-29) — durable write is now REJECTING, not coercing

Phase 3 shipped the `ProductionPlan` write (`savePlan`) with **coercing**
sanitizers only: a non-array `recommendations` became `[]` (succeed-with-empty),
an unknown `executionRoute` became `'internal'`, an unknown vendor `type` became
`'contractor'` — invalid model output was silently normalised into durable state
(proved by probe P2/P3). That violates the repo non-negotiable *"invalid model
output is a typed failure, never success-with-empty."*

`savePlan` now runs `assertValidPlanContent(input)` **before** any coercion or
`plans.put`: a **semantic** violation (non-array `recommendations`, an
`executionRoute`/vendor `type` outside the SSoT enum constants
`EXECUTION_ROUTES`/`VENDOR_TYPES`, or a blank `strategySummary`) is a typed
`OpenwopError('validation_error', …, 422, { errors })` that blocks persistence —
inherited by all three callers (agent tool, plan-generate node, seed). The
boundary is **semantic only**: cosmetic issues (length caps, currency ISO
normalisation per PROD2-R2, numeric clamping, array truncation) are still
COERCED, and a legitimately-sparse plan (empty `recommendations`, absent
optionals) still persists. Keyed on the SSoT enum constants so it cannot drift
from the coercion sets or the `production.plan` artifact schema. Deterministic +
pure ⇒ replay/`:fork` safe; forward-only (already-persisted coerced rows are not
re-validated). Host-only — no wire, no RFC. Witness:
`test/production-plan-reject-invalid.test.ts` (born-red + sabotage-verified).

The gate rejects: a non-array `recommendations`, a **non-object** recommendation
entry (a primitive/null would otherwise be fabricated into a full placeholder
rec), a **present-but-invalid** `executionRoute`, and a blank/non-string
`strategySummary`. The `plan-generate` node (`packs/feature.production.nodes`)
catches the typed failure and returns `status:'failed'` (code `plan_invalid`)
rather than letting an uncaught throw escape — the PROD2-R4 lesson (a node that
throws instead of returning a status can take the campaign spine down).

**Residual (honest scope — a smaller follow-up):** an *absent* required per-rec
field (`assetType`, `executionRoute`, `rationale`) is still **soft-defaulted** by
the cleaners (`executionRoute`→'internal', `assetType`→'asset', `rationale`→'')
rather than rejected — the existing de-facto contract tolerates it (e.g. the
PROD2-R2 test saves recs without a `rationale`), so requiring presence is a
separate, wider change. `matchingVendors[].type` is likewise NOT gated: PIC-1
already drops hallucinated vendors and a directory-backed vendor's `type` is
advisory, so a hard plan-reject on it would regress PIC-1's drop-and-keep. So the
boundary is closed-world for **structure + present-value enums**, not yet for
absent-required-field presence.
