# ADR 0342 — App-Builder application-model & production-lifecycle program (MyndHyve gap remediation)

Status: Accepted (2026-07-11) — Phases 0–4 + 6 implemented (ADRs 0343–0346, 0348), Phase 5 core landed (ADR 0347; 5b/5c recorded), Phase 7 scoped (ADR 0349), Phase 8 partial (golden journey landed; collab LANDED — **§ Status-correction 2026-07-23:** ADR 0335 is implemented and app-builder bound to the chassis collab transport via ADR 0359 Phase 5 (`features/app-builder/definition.tsx` `collab: 'elements'`); the `realtime-collab` toggle staying OFF is a product decision, not open engineering. Remaining Phase-8 residue = perf budgets at 100/250 screens (CV-12) + `/manual-tests` pages + keyboard-only/4-locale journey variants, recorded in the phase table). Standing deferrals updated 2026-07-18 (DECIDE ratification, docs/DECISIONS-adr0342-deploy-stack-clarify.md): **AI-08 clarify LANDED** (composed the existing clarification interrupt — chain 1.3.0, no RFC); **6e backend adapter LANDED** (ADR 0423 — Hono+Drizzle+Postgres emit); **deploy adapter LANDED as ADR 0424** (Cloud Run seam + mock; source→image builds Cloud-Build-gated); 3e live mode (first operation-adapter pack) + 5d pack components (first consumer) still trigger-gated

**Depends on / composes:** ADR 0153 (canvases program), ADR 0305 (editor-parity program) + 0306 (GitHub publish) + 0307 (IDE-bridge scoping), ADR 0310 (canvas editor framework / core-vs-type placement rule), ADR 0323 (screen-flow graph + additive-schema precedent), ADR 0325 (AI node depth), ADR 0337 (graph-first), ADR 0173 (code export), ADR 0028 (governed connections), ADR 0033 (connection packs), ADR 0335 (realtime collaboration program).
**Research (the plan this ADR adopts):** `docs/research/app-builder-myndhyve-gap-analysis-and-remediation.md` (2026-07-10).
**Toggle:** `app-builder` (stable, **ON**, bucket `tenant`) — this program adds NO new top-level toggle. New outward-facing sub-surfaces (consented live-connector preview, hosting deployment) get their own second-convention sub-toggles (the `code-export`/`code-publish` pattern), named in their phase ADRs.
**Companion ADR authored with this program:** ADR 0343 (`canvas.app-builder` comprehensive document facets — Phase 1).

---

## Context

The app-builder has closed its MyndHyve *editor* gap through four programs: ADR 0305
(A–G: DnD/undo/screen CRUD, catalog 14→35+, interactive preview + share, version
history, templates, GitHub publish), ADR 0323 (screen-flow graph), ADR 0325 (research →
deepen → audit AI chain), and ADR 0337 (graph-first + board chrome). The remediation
research doc concludes the remaining difference is **not a missing editor — it is a set
of incomplete loops**: the canvas document is not yet a complete *application* model
(no domain models, operations, bindings, closed actions, auth policy, environment
contract); declared fields are lost in the editor round-trip; the AI pipeline's outputs
are product-thin (no typed PRD/research/plan/audit artifacts, no repair loop); the
workflow chain is host-bundled instead of a signed pack; and production output stops
short of a full lifecycle (no capability manifest, source preview/diff, backend
generation, migrations, or governed deployment).

### Boundaries & pre-existing-surface audit (verified 2026-07-10, main @ 34818772)

| Claim | Verdict | Evidence |
|---|---|---|
| `coerceApp()` drops `themeColors` + `dataSources` (DS-01/DA-01 defect) | **TRUE** | `frontend/react/src/features/app-builder/definition.tsx:29-37` returns only `{name, description, theme, screens, connectors}`; `DataSourceRefWidget` (`:53-55`) reads `docState.dataSources` that coercion just dropped |
| Primary `image.src` is a required raw string; `avatar` already uses `mediaRef` (DS-06) | **TRUE** | `backend/typescript/src/features/app-builder/componentCatalog.ts:93-94` vs `:75-76` |
| No `feature.app-builder.workflows` pack; `app-builder.design` host-bundled (AI-11) | **TRUE** | `feature.ts:66-68` pins only `nodes@1.4.1` + `agents@1.2.1`; `feature.ts:72` `builtinWorkflows: [designWorkflowDefinition]`; ROADMAP:100 has promised the pack since ADR 0305 Phase F |
| `navigateTo` is the only component action kind (CV-09) | **TRUE** | `componentCatalog.ts:12` + occurrences on card/button/fab/link |
| Routes host-ext only | **TRUE** | `routes.ts:32` `basePath: '/v1/host/openwop-app/app-builder'`; nothing app-builder-specific in `/.well-known/openwop` (`routes/discovery.ts`) |
| **Doc correction — EX-02 "no Next.js target" is STALE** | **FALSE in doc** | `export/generators.ts:652` `genNextjs` (App Router), shipped PR #1533; `EXPORT_TARGETS` has **7** targets, not the doc's 6. EX-02's residue is only the capability-manifest gate + depth parity |
| **Doc/ROADMAP correction — toggle state** | drift | code `feature.ts` `status: 'on'`; FEATURES.md:550 says ON (right); ROADMAP:100 "toggles remain OFF pending operator flip" is stale |
| **FEATURES correction — wrong ADR ref** | drift | FEATURES.md:550 cites "graph-first (ADR 0339)"; 0339 is the SPA funnel viewer — graph-first is **ADR 0337** |

Single-owner map this program composes (no second owners are created): `host.canvas`
(persistence/CAS/versions), Media (bytes/assets), Sharing (public links), Connections +
ADR 0028 governance (credentials/vendor writes), the workflow catalog + executor
(orchestration), the signed pack registry (`registryInstaller`) (distribution), the
one AI chat (conversation), `validateAppDoc` (document validity).

## Decision

Adopt the research doc's remediation program: make `canvas.app-builder` the
**comprehensive application-design document type** on the shared canvas chassis, and
make the existing workflow/chat/pack/media/connection/publishing systems operate on
that document — phases 0–8, dependency-ordered, all behind the existing `app-builder`
toggle. The research doc's §2 invariants table is **normative for every phase** (one
canvas architecture, one document, one renderer contract, one workflow engine, one AI
chat, packs as the extension boundary, closed-world safety, host-extension first,
replay/fork fidelity, tenant/RBAC discipline).

**Program shape (the ADR 0305 precedent):** one umbrella ADR + companion ADRs where a
phase carries its own decision surface. Companion ADRs are authored **when their phase
begins** (numbers assigned then — the docs/adr/README duplicate-number rule; authoring
seven speculative ADRs now would collide with parallel sessions and go stale). ADR 0343
is authored with this program because Phase 1 is the load-bearing schema decision and
Phase 0+1 are the immediate work.

### Placement rule (ADR 0310, restated for this program)

A capability lands in `frontend/react/src/canvas/` (core) only if at least two canvas
types can use it without App Builder vocabulary — clipboard, visibility/lock, child
constraints, inspector-tab slot, diff seam, entity-graph reuse of `GraphSurface`,
preview state runtime. App-specific schemas, prompts, validation, projections, action
kinds, and generators stay in `features/app-builder/`. Chassis PRs must not import
app-builder vocabulary into `src/canvas/` (Phase 2 gate).

### Phases (mirrors research doc §6; gap IDs refer to its §5 register)

| Phase | Scope (gap IDs) | Decision record | Gate |
|---|---|---|---|
| **0 — document-seam corrections** | Preserve `themeColors`/`dataSources` through `coerceApp()`; feed both into graph-node rendering + preview; Image `src` → `mediaRef` (additive migration, explicit external-URL escape hatch decided in-PR); round-trip parity fixtures; fix the FEATURES/ROADMAP drift rows above (DS-01, DA-01, DS-06) | **this ADR** (defect-level; no schema decision) | backend vitest + FE canonical build; a save/reload/share/export fixture proves no recognized field is lost from an AI-emitted artifact |
| **1 — comprehensive application document** | Additive facets: design-system/brand refs, state variables, models, operations, bindings, closed actions, auth profile, env requirements, reusable layouts/components, output lineage, share policy; schema-version + open-time migration; generator capability manifest + source-map convention (DA-02..13 schema side, CV-07/09, DS-02/04/08, PR-08 contract) | **ADR 0343** | old documents validate; invalid refs fail at emit + PATCH; fork copies verbatim; schema↔editor cap parity tests |
| **2 — shared chassis authoring mechanics** | Core tree clipboard + copy-style (CV-04), `hidden`/`locked` (CV-05), child constraints (CV-06), reusable inspector/workspace-tab slot (AI-05, Data/Design/Outputs), `GraphSurface` reuse for the entity view (DA-03), closed action/binding/responsive/template-variable property widgets (CV-10, CT-04), structured diff seam (OP-02) | companion ADR (core canvas) | each core addition proven by a second consumer or domain-neutral contract; no app-builder vocabulary in `src/canvas/` |
| **3 — safe interactive runtime** | Ephemeral `PreviewStateStore` + deterministic closed action/condition interpreter (no eval) (PR-02/03), model/binding/query editors (DA-05/06/08), mock operation runtime + designed loading/error/empty/success states (PR-05, DA-14), consented host-brokered live mode (PR-04), preview diagnostics + sanitized public-share projection (DS-08) | companion ADR | no credential/eval exposure; preview + ≥1 export target pass the same behavior fixtures; public share receives the sanitized projection |
| **4 — pack-native AI pipeline** | `feature.app-builder.workflows` signed chain pack (closes the ADR 0305 F promise; minimum host registration adapter remains) (AI-11); typed `app.prd`/`app.research`/`app.plan`/`app.audit` artifact packs + workbench renderers (AI-04); clarification interrupt (AI-08), grounded brand context (DS-05), optional sourced research + media-concept subflow (AI-02, DS-07), per-screen review/repair + audit-rerun loops (AI-06/07), contextual editor commands launching the same workflows (AI-09); provider/model via AI policy, resolved choice recorded (AI-12) | companion ADR | supply-chain gate: sign/publish/re-pin, Marketplace visibility, replay with old AND new pinned versions |
| **5 — signed content ecosystem** | Multi-screen kits + template variables as signed canvas-content packs installed via the existing registry (CT-04/05), curated catalog growth in value order (CT-01, each addition = renderer + validator + AI description + **all 7** generators + tests in one PR), Marketplace-truth ratings/entitlements (CT-06), declarative pack-contributed components only through the sandboxed UI-plugin seam (CT-07, AI-10) | companion ADR | uninstall/tombstone preserves old runs/canvases; missing pack versions render an actionable compatibility state |
| **6 — production output contract** | Generator capability manifests + export preflight (PR-08), OpenAPI/JSON-Schema generation from the canonical models/operations (DA-10), first backend generator adapter + migrations as reviewable artifacts (DA-11/12), export file-manifest artifacts (hashes, SBOM, env requirements) + source preview/diff, publish pins the reviewed artifact hash (EX-03/04/05); Next.js **depth** parity rides the manifest (EX-02 residue) | companion ADR | same canvas version + same pack versions ⇒ same manifest/hash (recorded nondeterminism excluded) |
| **7 — governed deployment (+ IDE bridge activation)** | Deploy-adapter packs + a deploy workflow (select reviewed export → bind env → preflight → approval → adapter deploy → smoke → release artifact) over Connections, `adapterOnly`, idempotency + rollback info (EX-06, DA-12/13); IDE bridge stays behind the ADR 0307 activation trigger, consuming export artifacts + real 3-way file merges (EX-07/08) | companion ADR | no credential reaches canvas/artifact; partial failure explicit; deploys auditable back to canvas/workflow/pack/export versions |
| **8 — collaboration, scale, hardening** | Opt into ADR 0335 collaboration; 100/250-screen perf budgets (CV-12); golden journey + keyboard-only + 4-locale + public-share abuse tests (OP-05/06/07); manual test pages per toggle state | rides ADR 0335 + test suites (no new decision ADR) | golden-journey suite green in CI |

### Feature-evaluation matrix (the /feature-refinement contract)

1. **Feature-package:** extends `features/app-builder/` on both sides; core additions
   go to `src/canvas/` under the placement rule; registries untouched (already wired).
2. **Toggle:** `app-builder` stable/ON; sub-toggles only for the two new outward
   surfaces (live preview, deploy), default OFF, bucket `tenant`, category `Canvases`.
3. **`ctx` workflow surface:** the existing `ctx.features['app-builder']` surface
   (ADR 0173) grows repair/validate/export-manifest ops with the phases; same toggle +
   RBAC; nothing advertised beyond honored behavior.
4. **Node pack:** `feature.app-builder.nodes` grows (clarify, brand-context, media
   concept, repair, openapi-gen, deploy orchestration) via the signed pipeline with
   version bumps + re-pins per phase.
5. **AI chat / envelopes:** no new chat; contextual commands + clarification ride the
   existing chat/interrupt primitives; typed artifacts ride artifact-type packs.
6. **Agent pack:** `feature.app-builder.agents` (App Architect) prompt/tool growth
   only; no new agent surface.
7. **Public surface:** sharing stays on the `sharing` seam; Phase 3 adds the
   server-sanitized share projection + mint-time disclosure (DS-08 closes the recorded
   FEATURES.md data-posture note); uniform 404s, rate/payload caps unchanged.
8. **RBAC/isolation:** every new route under `/v1/host/openwop-app/app-builder/*`,
   org-scoped, toggle-gated, fail-closed, with createApp+cookie-jar route tests
   (toggle-off / role / IDOR / stale-CAS / caps / uniform-404) per OP-06.
9. **Replay/fork:** run artifacts immutable (migrations only on working-copy open);
   pack versions + resolved provider/model + adapter identities recorded in
   lineage/run metadata and read verbatim on `:fork`; repair acceptance is CAS-guarded.
10. **Frontend:** existing feature package + chassis seams; editor stays lazy-chunked.

## Alternatives weighed

- **Author all seven companion ADRs now.** Rejected: speculative numbering collides
  across parallel sessions and the later phases' decisions (pack kinds, deploy adapter
  contracts) depend on what earlier phases learn; the 0305→0306/0307 pattern (author
  at phase start) worked.
- **A new feature-package ("app-platform") for the data/backend model.** Rejected:
  the application model is facets of the SAME `canvas.app-builder` document — a second
  package would create a second owner of the app concept (the orgs↔accessControl
  cautionary tale).
- **Port MyndHyve's shapes directly.** Rejected where the doc records non-ports:
  split client stores (OP-01), free-form CSS/JS (CV-08), raw action editors (CV-09),
  browser autoplay orchestration (AI-03), premium-metadata fakes (CT-06). The doc's
  invariants + this repo's closed-world rule stand.

## PRD-vs-architecture corrections (recorded, not silently fixed)

1. **EX-02 is stale:** the Next.js App Router target already ships (`generators.ts:652`,
   PR #1533; 7 targets). The phase-6 work is the capability manifest + depth parity,
   not a new target.
2. **Doc §5.7/§4 "six generators/targets"** → seven everywhere a parity gate is stated.
3. **Toggle posture:** `app-builder`/`code-export`/`code-publish` are ON in code;
   ROADMAP's "remain OFF pending operator flip" note is corrected with this ADR's
   docs PR (Phase 0 also owns the FEATURES "ADR 0339"→0337 ref fix).

## RFC gate (wire vs host-extension)

**Default verdict: host work, no RFC** — additive facets on the host-owned
`canvas.app-builder` artifact type, `/v1/host/openwop-app/app-builder/*` routes,
existing pack kinds, canvas UI/preview, Media/Sharing/Connections composition. The
normative `canvas.app-builder.export[]` facet is never appended to (the ADR 0173 rule).

**Three watch-items are RFC-gated and flagged loudly** (each requires a `../openwop`
RFC reaching ≥ Accepted via `/prd` *before* its slice ships, per doc §9):

1. **Canvas-content pack kind (Phase 5):** no RFC while it is a host-private registry
   convention; an RFC the moment it is promoted to a normative cross-host pack kind.
2. **Per-screen approval (Phase 4, AI-07):** compose existing accepted approval/child-run
   shapes; if a collection-review **wire** contract (new envelope/run-event field) turns
   out to be required, that is an RFC first.
3. **Any new advertised capability** in `/.well-known/openwop` (none is planned;
   `OPENWOP_REQUIRE_BEHAVIOR=true` enforces honesty).

## Open questions

- Sub-toggle names/granularity for live-connector preview and deploy (one `app-deploy`
  toggle vs per-adapter) — decided in the Phase 3/7 ADRs.
- External-URL images: keep a separate explicit component/option after DS-06, or
  migrate fully to `mediaRef`? (Phase 0 PR decides; additive either way.)
- Whether `componentDefinitions[]` reuse (CV-07) needs chassis support (a scoped-frame
  editor) or stays a type-level projection — Phase 2 ADR.
- Backend generator first target (DA-11) — pick one stack with conformance fixtures
  before breadth; candidate decided in the Phase 6 ADR.

## Phase → commit table (updated as phases land)

| Phase | Status |
|---|---|
| 0 | landed (PR #1664) — coerceApp preserves themeColors/dataSources; board-node theme/data parity via the single-owner `appThemeVars()`; image `src`→mediaRef + MediaRefWidget manual-URL entry; round-trip parity fixture |
| 1 (ADR 0343) | landed (this PR) — 1a schema+validator facets (two-gate parity suite), 1b declarative coerceApp w/ compile-time facet exhaustiveness, 1c generator capability manifests + source-map convention (honesty suite exposed the recorded themeColors/responsive parity gaps); see ADR 0343 as-built notes |
| 2 | landed (ADR 0344 implemented — 2a #1670 clipboard, 2b #1672 hidden/locked, 2c #1673 child constraints, 2d #1674 structured diff; workspace-tab slot + entity graph deferred to Phase 3 per first-consumer rule) |
| 3 | landed (ADR 0345 implemented) — 3a #1676 sanitized share + sharePolicy, 3b #1678 preview state + closed action interpreter, 3c #1681 mock op runtime + diagnostics drawer, 3d #1684 Data workspace + entity graph (the deferred 0344 seams landed with their consumer); 3e live mode deferred w/ activation trigger (adapter seam = EX-01) |
| 4 | landed (ADR 0346 implemented — 4a+4b #1690 workflows chain pack + model policy, 4c #1692 typed app.research + generic renderer, 4d repair loop; clarify (AI-08) deferred w/ RFC-gate trigger) |
| 5 | ADR 0347 Accepted — 5a #1694 (canvas-content kits + variables); 5b catalog growth + 5c Marketplace truth = recorded pending; 5d deferred (first-consumer) |
| 6 | landed (ADR 0348 implemented) — 6a #1695 theme/responsive parity closed, 6b preflight, 6c lineage (side-collection as-built), 6d OpenAPI-in-bundle (#1696); 6e backend adapter deferred pending stack decision |
| 7 | scoped (ADR 0349, the ADR 0307 pattern) — the deploy CONTRACT is shipped (hash-addressed lineage, in-bundle OpenAPI, symbolic envRequirements, the 0306 governed-write path, proven approval chains); workflow/adapter/sub-toggle activate together when a concrete provider is chosen (same trigger fires 3e live preview) |
| 8 | partial (this PR) — **residue triage 2026-07-23:** the exit criterion (golden-journey green in CI) is MET (`app-builder-golden-journey.test.ts` in the default vitest run); the `/manual-tests` follow-up LANDED (the `app-builder` suite, APPB-01..05, walks the same seams per toggle state); the 100/250-screen perf budget (CV-12) + keyboard-only/4-locale journey variants stay recorded follow-ups (viewport culling already ships; `/builder` is in the axe e2e scan — a dedicated perf/journey harness is the remaining nice-to-have). The GOLDEN JOURNEY e2e (OP-07) walks every program seam through the real HTTP boundary (blank → comprehensive facets + closed-world 422 → pack kit on the catalog → export w/ preflight+strict+hash+OpenAPI → lineage → versions → SANITIZED share). Collaboration rides ADR 0335, in flight in a parallel session (not duplicated here). Recorded follow-ups: perf budgets at 100/250 screens (CV-12), /manual-tests pages, keyboard-only + 4-locale journey variants |
