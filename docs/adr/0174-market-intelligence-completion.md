# ADR 0174 — Market Intelligence (completion as a workflow-library, NOT a feature package)

**Status:** implemented (2026-07-01) — P1 the net-new `market-intel.shift-detect` node
(`vendor.myndhyve.market-intel-shift-detect`, a deterministic two-artifact diff →
`MarketShiftAlert`; test `market-intel-shift-detect.test.ts`, 4 cases) · P2 the
`market-intel.shift-digest` chain added to `core.openwop.workflows.market-intel` (1.0.0→1.1.0;
research → shift-detect → synthesize; schedulable via RFC 0052; loads under the chain-pack
loader) · P3 closed-loop = the ADR 0039 proposals/goals COMPOSITION (the shift-digest output
is the hand-off; **no net-new store/surface**, per this ADR). The 10 pre-existing
`vendor.myndhyve.market-intel-*` packs + `market-intel.digest` chain were already shipped.
**Date:** 2026-07-01
**Track:** A (Software & App Architecture). **No OpenWOP wire change → no RFC.**
**Composes (does NOT fork):** ADR 0149/0163 (workflow-chain packs), ADR 0082
(insights-suite — the compare-runs/variance pattern), ADR 0084 (Notebooks/KB RAG),
ADR 0011 (KB), ADR 0039 (reviewable learning goals + proposals — closed-loop),
ADR 0052/RFC 0052 (scheduler), ADR 0034 (triggers), ADR 0101 (provider-native web search).
**MyndHyve baseline:** `src/core/market-intel/` (`AIFirstResearchExecutor` real;
`MarketShiftDetectionService`/`AngleReScoringService`/`BatchRunService`/`ResearchScheduleService`
**Partial — coded, not wired**).

> **Boundaries-audit headline (2026-07-01): Market Intelligence is already ~70%
> ported** — as the ADR 0149/0163 pack pattern, live on app.openwop.dev, NOT as a
> feature package. openwop-app already ships **10 `vendor.myndhyve.market-intel-*`
> node packs** (discovery / voc / opportunity-scoring / ad-angles / audience-targeting
> / community-rank / content-extraction / query-builder / thread-triage / crew agent)
> + the boot-installed, Ed25519/SRI-verified **`core.openwop.workflows.market-intel`**
> chain (`market-intel.digest`: discover→voc→score→synthesize). This ADR **records
> that shipped state and closes the residual gap** — it does NOT create a
> `market-intel` feature package (that would duplicate the packs and violate the
> ADR 0082 no-parallel-surface law).

---

## Context — boundaries & duplication audit (done first)

Per-capability owner map — every Market-Intel capability already has an openwop-app
owner; the port is **compose, don't fork**:

| MyndHyve service | openwop-app owner it IS / extends |
|---|---|
| `AIFirstResearchExecutor` (research pipeline) | **Shipped** — the `market-intel.digest` chain over the 10 vendor node packs (the ADR 0149/0163 realization). Deeper passes = more chain packs. |
| `ResearchScheduleService` (recurring) | **RFC 0052 scheduler daemon** (`host/schedulingService.ts` + `host/cronSchedule.ts` + `core.trigger.*`) — register the chain as a job. |
| `BatchRunService` (multi-ICP) | Multiple scheduled/dispatched runs; true parallel fan-out = `core.subWorkflow` (sequential now, RFC 0118 parallel later — the ADR 0158 posture). |
| `MarketShiftDetectionService` (Partial) | Closest owner **insights-suite** (ADR 0082) `variance-compute` — extend, don't fork. **This is the one net-new node.** |
| `AngleReScoringService` (Partial) | A pure node + **evals** (`features/evals`) + ADR 0039 learning signals. |
| `ClosedLoopBridgeService` + Learnings store | **ADR 0039** proposals/goals (`/v1/host/openwop-app/proposals` + `/goals`, RFC 0096/0097) — the proposal-inert learning surface. **No new store.** |
| `LearningsDashboardPanel` | **No parallel dashboard** (ADR 0082 core law) — surface via runs/artifacts/notifications, a Documents digest (ADR 0053), or a Notebook (ADR 0084). |
| 10 source connectors | Superseded by provider-native web search (ADR 0101) + `vendor.myndhyve.web-research`; they do NOT port. |

**Genuinely net-new after dedup:** essentially **one node** — `market-intel.shift-detect`
(diff two prior research-run artifacts → a `MarketShiftAlert`), the wired version of
MyndHyve's Partial detector, cloned from the insights-suite `variance-compute` shape.

## Decision

Complete Market Intelligence as a **workflow-library + one node**, not a feature package:

1. **Record the shipped state.** Move the ADR 0149 "In progress" market-intel row →
   Done: the 10 vendor node packs + the `market-intel.digest` chain are live.
2. **Author deeper chain packs** for the full `AIFirstResearchExecutor` passes
   (discover→extract→VoC→angle-brief), composing Notebooks/KB RAG (ADR 0084/0011) +
   the vendor nodes — pinned, signed chain packs (RFC 0013).
3. **Add one net-new node** `vendor.myndhyve.market-intel-shift-detect` (extends the
   insights-suite `variance-compute` pattern): input = two prior run-output artifacts,
   output = a `MarketShiftAlert` (new/changed pain points · angle-score deltas ·
   community/intent shifts). Deterministic diff over recorded artifacts → replay-safe.
4. **A scheduled "shift digest" chain** via RFC 0052 (research → shift-detect vs the
   prior run's artifact → notify) — the recurring detector MyndHyve deferred.
5. **Closed-loop via ADR 0039**, not a new store: research findings that recommend an
   action land as **proposals**/**goals** (proposal-inert, human-reviewed); angle
   performance rides **evals**.
6. **No toggle, no dashboard.** Packs are decoupled from toggles (RFC 0076 pinning);
   results surface through **runs / artifacts / notifications / a Documents digest** —
   never a parallel Learnings dashboard (ADR 0082). Add a settings panel only if a
   bespoke library surface is later required.

### Port-not-clone corrections
- **Not a feature package.** A `market-intel` package would fork the shipped packs +
  stand up a parallel research/learning store (ADR 0082 violation). It's a pack library.
- **Never inherit the Partials.** `MarketShiftDetectionService`/`AngleReScoring`/`BatchRun`
  are coded-not-wired upstream; ship only the wired `shift-detect` node + scheduled chain.
- **No Learnings dashboard/store.** Closed-loop is ADR 0039 proposals/goals; the dashboard
  is a Documents/Notebook digest.

## Phased plan
- **Phase 1 — record + shift-detect node.** ROADMAP/FEATURES reflect the shipped packs;
  author + sign `market-intel-shift-detect` (node-pack tests: two-artifact diff →
  alert, deterministic).
- **Phase 2 — deeper chains + scheduled shift-digest.** 2–3 chain packs (deep research;
  scheduled shift digest via RFC 0052). Composes Notebooks/KB.
- **Phase 3 — closed-loop wiring.** Research → ADR 0039 proposal/goal + evals angle
  signal. (No new surface.)

## /prd five-architect compatibility pass

| Architect | Verdict |
|---|---|
| **Spec** | No new wire vocabulary. Research/detection/scheduling are workflow runs + packs on `/v1/host/openwop-app/*`. **N/A.** |
| **Schema** | No new/changed wire schema. Packs ride RFC 0013 (chain) / 0076 (node) / 0003 (agent) manifests — all Accepted. `MarketShiftAlert` is a host-private node-output shape, not a wire type. |
| **Security** | Research content is web-sourced ⇒ fenced `contentTrust:'untrusted'` on ingest (existing KB discipline); closed-loop is **proposal-inert** (ADR 0039 — a finding never auto-acts); no new secrets. |
| **Conformance** | Nothing new advertised → no scenario. Existing pack/scheduler/proposal surfaces stay honest under `OPENWOP_REQUIRE_BEHAVIOR`. |
| **Compatibility** | **Additive.** New signed packs + one node + scheduled chain + ADR 0039 composition; zero change to existing features/wire. Parallel fan-out, if needed, is the Draft RFC 0118 sequential-fallback posture — not a new RFC. |

**RFC gate: none.** Rides Accepted RFC 0013/0076/0003/0052/0096/0097; the only asterisk
(true parallel batch fan-out) is the already-Draft RFC 0118, shipped as sequential now.

## Alternatives considered
1. **A `market-intel` feature package + Learnings dashboard.** Rejected — duplicates the
   shipped packs and forks a parallel research/learning store (ADR 0082 core violation).
2. **Port the 10 source connectors.** Rejected — superseded by provider-native web
   search (ADR 0101) + `vendor.myndhyve.web-research`.
3. **Inherit `MarketShiftDetectionService` wholesale.** Rejected — it's Partial upstream;
   ship the one wired node cloned from `variance-compute`.

## Open questions
- [ ] **Shift-detect baseline.** Diff against the immediately-prior run vs a rolling
  window — start pairwise (prior run), generalize if a consumer needs trend lines.
- [ ] **Settings surface.** Add a thin config panel (ICP list, cadence) only if a real
  consumer needs it; default is scheduled-chain config via the scheduler UI.
