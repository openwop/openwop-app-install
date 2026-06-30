# ADR 0155 — Campaign Studio: Brand & Guardrails

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1–4, 2026-06-27) |
| **Date** | 2026-06-27 |
| **Feature id / toggle** | `brand` (OFF, bucket `tenant`, category `Marketing`) |
| **Packs** | `feature.brand.nodes`, `feature.brand.agents` |
| **Depends on** | ADR 0001 (feature packages), 0006 (RBAC / `accessControl`), 0011 (KB/RAG — for grounded prompts later) |
| **PRD** | [`docs/campaign-studio-prd.md`](../campaign-studio-prd.md) — the first of the 0155–0160 Campaign Studio cluster |
| **RFC gate** | None — host work riding Accepted RFCs (RFC 0049 accessControl, RFC 0005 chat, RFC 0014 surface). **No new RFC.** |

> **§ Correction / extension (2026-06-29 — see [ADR 0170](0170-brand-identity-app-and-marketing-consolidation.md)).**
> The `Brand` model gains an optional visual-**identity** facet, and the feature
> **graduates to always-on/core** (the `OFF / bucket tenant` posture above describes the
> original voice-only feature; ADR 0170 removes the toggle — `workspace:*` RBAC on tenant
> brands is unchanged). ADR 0170 consolidates the white-label **app identity** into this
> same feature: a reserved `brand:host-app` brand (in the existing `host-site` org) drives
> the app's logo/colors/fonts at runtime, mirroring how CMS owns the homepage (ADR 0027).
> A tenant marketing brand's `identity` is inert — only `brand:host-app` drives the chrome.

## Context

The Campaign Studio port ([`docs/campaign-studio-prd.md`](../campaign-studio-prd.md)) brings MyndHyve's composable multi-channel marketing workflow into openwop-app. Its **foundation** — the thing every downstream piece (messaging kernel, the five channel generators, the consistency check) reads — is the **brand**: a structured definition of how a company sounds, plus an always-on **guardrail** that scores generated content for compliance before a human ever sees it.

In MyndHyve this lived in `src/core/brands/` — a rich `Brand` entity (voice profile, formality 1–5, tone registers, positioning, approved/banned phrases, per-channel voice rules) + `BrandVoiceResolver` (injects rules into generation prompts) + a compliance scorer that blends **deterministic** checks (banned-phrase, formality register) with an **LLM** judgement into a 0–100 score.

openwop-app has no brand model today. This ADR adds one as a self-contained feature package, composing existing seams and forking nothing.

## Decision

Ship a `brand` feature package (ADR 0001) with three faces:

1. **A `Brand` entity + service** — tenant+org-scoped, persisted on the generic `DurableCollection` (no schema migration), CRUD over `/v1/host/openwop-app/brand/*`, RBAC-gated through the existing `accessControl` scopes (`workspace:read` / `workspace:write`).
2. **A compliance scorer + voice resolver** — pure, deterministic library functions (`scoreCompliance`, `resolveVoice`) the rest of Campaign Studio composes. The *deterministic* half (banned-phrase / approved-phrase / formality-register / per-channel length) is a pure function with no I/O; the *LLM* half is layered in at the node boundary (which has `ctx.callAI`), keeping the service pure and unit-testable.
3. **`feature.brand.{nodes,agents}` packs + a `ctx.features.brand` surface** — `brand.compliance.check` and `brand.voice.resolve` nodes over the surface, driven by a **Brand Steward** agent through the ONE chat (ADR 0058 chat-drivability; no new chat panel). A frontend `/brand` page manages brands.

### Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Persistence | `DurableCollection<Brand>('brand:brand', b => `${b.tenantId}::${b.id}`)` | The strategy/priority-matrix precedent — no schema migration, tenant-prefixed keys for bounded scans + CTI-1 isolation |
| Brand ↔ org scope | `Brand.orgId` mandatory; reads need `workspace:read`, writes `workspace:write` on that org | Matches strategy (ADR 0079 §Correction — no org-less shared entity); IDOR fail-closed (foreign-tenant/org → 404) |
| Compliance scorer split | Deterministic = pure service fn (60 % weight); LLM = node-layer via `ctx.callAI` (40 % weight) | Service stays pure/unit-testable + replay-trivial; the LLM blend lives where `ctx.callAI` exists (the node). Banned-phrase hit caps the score ≤30 regardless |
| Voice resolver | Pure fn `resolveVoice(brand, { channel?, persona? })` → a prompt-injectable text block | Downstream generators (ADR 0156/0157) compose it; no AI-envelope fork |
| Governance | `Brand.governance` (lockLevel · allowedEditors · requireApproval) maps onto `accessControl` checks, NOT a parallel ACL | RFC 0049 is the one authority surface (David's law — no parallel auth) |
| Chat-drivability | Brand Steward agent (`feature.brand.agents`) + the two nodes; surfaced via `EmbeddedChatPanel`/deep-link | ADR 0058/0073 — never a bespoke "talk to brand" panel |
| Replay/fork | Brand reads are live; the compliance decision is recorded as a node output (read on `:fork`, never re-scored against a mutated brand). LLM-half nondeterminism is the standard recorded-output story | No new wire field; matches the recorded-tool-output precedent |

### Non-goals (this ADR)

- The messaging kernel, brief, channel generators (ADR 0156/0157).
- Visual identity *rendering* (logos/colors are stored as fields but not applied to any layout — that's the page-builder's job, ADR 0157).
- Multi-brand hierarchy (parent→product-line cascade) — modeled as an optional `parentBrandId` field but cascade resolution is deferred to a follow-on.

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **1 — Brand entity + feature package** | `Brand` types · `brandService` (CRUD on `DurableCollection`, tenant+org IDOR) · `routes.ts` (`/brand/*`, toggle + `accessControl`-gated) · `feature.ts` + register in `BACKEND_FEATURES` · toggle default · route tests | backend `npm test` green + tsc clean |
| **2 — Compliance scorer + voice resolver** | Pure `scoreComplianceDeterministic(content, brand)` (banned/approved phrase, formality register, per-channel length → 0–100 + issues) · `resolveVoice(brand, opts)` prompt block · unit tests (the scoring math) | unit tests green |
| **3 — Node + agent packs + surface** | `ctx.features.brand` surface (`getBrand`/`listBrands`/`checkCompliance`/`resolveVoice`) · `feature.brand.nodes` (`brand.compliance.check` blending deterministic + `ctx.callAI` LLM, `brand.voice.resolve`) · `feature.brand.agents` (Brand Steward) · `requiredPacks` wired · pack + surface tests | backend `npm test` green |
| **4 — Frontend brand management** | `src/features/brand/` — `/brand` list + editor (voice · formality · tone registers · approved/banned phrases · per-channel rules · positioning) · `brandClient` · registry + nav wiring · i18n `en` catalog | `( cd frontend/react && npm run build )` green |

Each phase: **`/architect` review before** · implement · **`/code-review` + `/ux-review` after, apply all fixes**. HITL avoided (autonomous).

## Alternatives considered

1. **Extend an existing entity (e.g. `Strategy` or a CRM custom-field) instead of a new `Brand`.** Rejected: brand voice/guardrails are a distinct, reusable primitive five downstream features read; bolting it onto strategy would couple unrelated lifecycles and violate the single-responsibility the feature-package model exists for.
2. **Put the whole compliance scorer (incl. LLM) in the service via `resolveHeadlessAi` (ADR 0110).** Rejected for the *node-driven* path: the node already has `ctx.callAI` with the run's provider/BYOK resolution + replay recording; routing the LLM through a headless service path would duplicate provider resolution and lose the recorded-output replay story. The *deterministic* half stays a pure service fn (composable + unit-testable). (A headless path remains available if a non-run caller ever needs scoring.)
3. **Model guardrails as a new approval/ACL store.** Rejected — governance maps onto `accessControl` (RFC 0049); a parallel ACL is the no-parallel-architecture tripwire.
4. **Do nothing / inline brand text into each generator prompt.** Rejected: that is exactly the "every campaign starts from scratch" problem Bryce hit — brand must be defined once and enforced everywhere, which requires a first-class entity + scorer.

## Open questions

1. **Formality scale mapping.** MyndHyve used 1–5 with named registers. Keep 1–5 or normalize to a 0–1 float? (Decision: keep 1–5 integer with labels for editor clarity; the scorer normalizes internally.)
2. **Banned-phrase matching.** Exact substring (case-insensitive) vs. token/stemmed? (Decision: case-insensitive whole-word for v1; stemming is a follow-on — over-matching risks false guardrail blocks.)
3. **Per-channel rule vocabulary.** Which channel keys? (Decision: `landing_page | ad_variants | email_sequence | creative_briefs | social_posts` — the five Campaign Studio channels, aligned with ADR 0157.)

## Consequences

- Unblocks ADR 0156 (the brief context assembler injects `resolveVoice`; the kernel grounds against brand) and ADR 0157 (each channel child runs `brand.compliance.check`).
- Adds one toggle, one feature package, two packs, one FE page — no core edits beyond the `BACKEND_FEATURES` / `FRONTEND_FEATURES` registry appends.
- Replay-safe, RBAC-honest, no new wire surface.

## Implementation log

_(updated as phases land — phase → commit/test table)_

| Phase | Status | Evidence |
|---|---|---|
| 1 | ✅ Done | `src/features/brand/{types,brandService,routes,feature}.ts` + registered in `BACKEND_FEATURES`; `test/brand-route.test.ts` 7/7 (toggle gate · CRUD · sanitization · cross-org 404 IDOR · governance authority). tsc clean beyond baseline. `/architect` (0 blocking) + `/code-review` (0 findings) passed. |
| 2 | ✅ Done | `src/features/brand/scoring.ts` — pure `scoreComplianceDeterministic` (banned ≤30 cap · whole-word match · per-channel length · formality heuristic) + `resolveVoice` prompt block; `test/brand-scoring.test.ts` 7/7. ReDoS-safe (escaped regex). `/architect` (pure-fn, inline) + `/code-review` (0 findings) passed. |
| 3 | ✅ Done | `src/features/brand/surface.ts` (`ctx.features.brand`: listBrands/getBrand/resolveVoice/checkComplianceDeterministic, tenant-bound) + `packs/feature.brand.{nodes,agents}` (3 nodes incl. `compliance-check` blending deterministic 60 % + `ctx.callAI` LLM 40 %, banned-cap ≤30, graceful degrade; Brand Steward agent) + `surface`+`requiredPacks` wired in `feature.ts`. Tests `brand-surface` (4/4) + `brand-packs` (7/7); boot installs packs clean. `/architect` (inline — surface tenant-trust + provider-default convention) + `/code-review` (0 findings) passed. |
| 4 | ✅ Done | `frontend/react/src/features/brand/` — `/brand` workspace page (list + 6-section editor: identity · voice/formality · approved/banned phrases · positioning · per-channel rules · governance) on the shared `ui/` layer (PageHeader/StateCard/Modal/ConfirmDialog/Field, `.list-row`, status chips) + `brandClient` + `Marketing` nav + en/es/fr/pt-BR catalogs; registered in `FRONTEND_FEATURES`. **Canonical `npm run build` green** (tsc + token/CSS/i18n integrity + vite + bundle-budget). `/architect` (FE conventions) + `/code-review` (0 findings) + `/ux-review` (system-row refactor + inline-style removal applied) passed. |

**Verification (all phases):** backend `brand-{route,scoring,surface,packs}.test.ts` = 25/25; tsc clean beyond the 3 pre-existing `kbService` missing-dep baseline errors; frontend `npm run build` green. No new RFC; rides Accepted RFC 0049/0005/0014.
