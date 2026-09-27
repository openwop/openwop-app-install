# ADR 0265 — CDP-C: Behavioral segments, calculated traits, audience insights & propensity

**Status:** in-progress (traits/numeric-ops + propensity + audience-insights + event-based engagement traits shipped; **NL segment-author copilot SHIPPED 2026-07-18** — the `segment-author` persona + `persist-segment` node complete the draft→validate→persist trio over the closed-world grounding; behind the OFF `cdp` toggle, the prepared CDP-C graduation vehicle)
**Date:** 2026-07-05

> **Graduation:** the NL segment-author copilot is the **first** CDP sub-program to
> graduate (see [ADR 0262 § Graduation decision](0262-cdp-customer-data-platform-program.md#graduation-decision-added-2026-07-18--the-cdp-graduation-call)) — build IS the GA vehicle, gated on Gate 0 (consent/identity/DSAR proven for segment data) + the `persist-segment` validate-and-human-confirm constraint.
**Depends on:** ADR 0262 (CDP program + rulings), ADR 0263 (CDP-A profile), ADR 0211 (CRM segments live-resolution — **corrected** here), ADR 0018 (analytics), ADR 0019 (email engagement), ADR 0058 (priority-matrix scoring — reused), ADR 0073 (EmbeddedChatPanel), ADR 0099 (run-start-context replay seam)
**Part of:** CDP program (ADR 0262). CDP-C, Phases 0/3.

## Why this exists

CDP audiences must filter on **behavior** (recency, event counts, lookbacks) and **calculated
traits**, preview counts/overlap, and score **propensity** — none of which exist today.
`crm/segmentsService.ts` (ADR 0211) is a real saved-segment store but with a fixed, AND-only
attribute vocabulary (`stage|owner|company|customFields.*`, ops `eq|contains|exists`), no event
predicates, no derived traits, no estimate/overlap endpoints; `customFields` are static; there is no
propensity anywhere (`priority-matrix/scoring.ts` scores *ideas*, not contacts).

## Decision

Extend CRM segments + analytics with behavioral filters, read-time calculated traits, audience
insights, and a **reuse** of the weighted-scoring engine for propensity — keeping live resolution as
the source of truth (ADR 0262 ruling #4).

### 1. Behavioral segment filters (Phase 0)

Extend `SegmentFilter` with an **event-predicate op** reading the analytics store
(`analytics/analyticsService.ts` — `pageview|event|conversion` with timestamps) and email
engagement (`email/engagementService.ts` — opens/clicks/unsubs), plus **OR/NOT/nesting** in the
currently `filters.every(...)` evaluator. Evaluated at read (no materialization).

### 2. Calculated traits (Phase 0)

A read-time **derived-trait resolver** (`daysSinceLastActivity`, `emailClicks30d`,
`lifetimeConversions`, …) computed from the same stores per the CSM `healthFactors`/`healthComputedAt`
computed-with-provenance precedent — exposed on the CDP-A golden record, never persisted as static
`customFields`.

### 3. Estimates, overlap & derived snapshot (Phase 0/3)

`GET /crm/segments/:id/estimate` (size, reuses `resolveSegmentMembers().length`) + a pairwise
overlap endpoint (intersection sizes over resolved id-sets) → Venn in `ContactsTab.tsx`. For large
segments, an **opt-in `crm:segment-snapshot`** written by a scheduled workflow — a **derived cache,
clearly non-authoritative** (live resolution stays SSoT). **This is a deliberate, scoped exception to
ADR 0211's "no materialization" doctrine, recorded there as a correction note** (ADR 0262 ruling #4).

### 4. Propensity scoring (Phase 3, reuse)

**Reuse `priority-matrix/scoring.ts`** retargeted at contacts: a configurable weighted-trait
lead/propensity score (WSJF/RICE-style weights over calculated traits) — pure, deterministic,
explainable, inheriting the score-history + weight-explainer surfaces. Statistical ML stays a later
separate track. A score that gates a run branch is stamped via `runStartContext` (ADR 0099).

### 5. Audience insights + NL author (Phase 3)

A read-time projection joining `resolveSegmentMembers` with analytics/engagement (size trend,
engagement rate, top traits) — the `campaign-intel/attribution.ts` precedent — surfaced via a
`feature.analytics.agents` insights persona. A `feature.crm.agents` **segment-author** persona +
`draft/validate/persist-segment` nodes mirror `workflow-author` exactly (closed-world grounding on
the real filter vocabulary), driven through `EmbeddedChatPanel` — no new chat (ADR 0262 ruling #6).

## Scope / non-goals

- No learned models; propensity is transparent weighted scoring.
- Snapshots never become a second membership authority (enforced by labeling + the live path staying default).

## Phased plan

1. **Phase 0:** event/recency filters + OR/NOT + calculated-trait resolver + estimate/overlap endpoints.
2. **Phase 3:** propensity (reuse scoring) + audience insights projection + segment-author/insights agent packs + derived snapshot.
3. Verify: filter-grammar unit tests, estimate/overlap route tests, snapshot-vs-live parity test.

## Open questions

- [ ] Holdout on a segment (per-contact) — generalize `host/variantAssignment.ts` bucketing keyed on
  `contactId` (recommended); coordinated with CDP-E experiments. Default: shared primitive, one impl.
- [ ] Trait vocabulary is a closed host list; adding one is host-ext.

## Consequences

Audiences become behavioral, previewable, explainable, and scorable — reusing three existing engines
(segments, weighted-scoring, attribution-style projection) rather than new infra. The one cost is a
scoped, documented reversal of ADR 0211's no-materialization stance, contained to an opt-in derived
cache.
