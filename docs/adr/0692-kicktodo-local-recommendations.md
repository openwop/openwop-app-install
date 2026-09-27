# ADR 0692 — "What next" is a KickTodo-local recommender, not the platform one

Status: Accepted (implemented; see § Implementation record)

## Context

The original-intent coverage analysis listed one unwired original promise under
P3: "AI goal recommendations — Discover is curated; no personalized
recommendation lane (platform recommendations feature exists, unwired to
kicktodo)". The KickTodo report card carried it forward as the last P3 item.

The platform feature was read before wiring it, and it is the wrong tool:

| fact | where |
| --- | --- |
| it recommends Commerce `Product`s only; the output projection is `publicProduct(p: Product)` | `features/recommendations/routes.ts:19-35` |
| its affinity is co-purchase, rebuilt from ORDERS | `recommendationsService.ts:152`, test seeds `createProduct`/`createOrder` |
| its sources are a closed constant, no registration seam | `RECO_SOURCES`, `recommendationsService.ts:37-38` |
| it hard-depends on `commerce` | `features/recommendations/feature.ts:39` |

Wiring KickTodo into it means either a source-registry refactor of another
feature (an ADR 0001 boundary crossing) or recommending only PAID challenges —
free ones have no product. Neither honours the promise, which was never "upsell";
it was "the coach knows what you should try next".

## Decision

**A deterministic, explainable recommender inside `kicktodo-core`, over the
participant's own enrollments and the catalog's depth facet (ADR 0443 R4).**

- Inputs: the tenant's published catalog; the CALLER's enrollments (self-data
  only, the journal/today rule). Nothing about anyone else.
- Exclusions: any challenge the participant has in flight (`active`, `snoozed`,
  `escalated`) or has `completed`.
- Reasons, rendered verbatim by the UI, in rank order:
  `next-depth` (one level above the deepest completed) → `same-depth` (the deepest
  completed, or the deepest in flight when nothing is completed) → `starter`
  (newcomer: beginner or unlabeled) → `more`. Within a reason, by title.
- Default three; the route accepts a bounded limit.
- Route `GET /v1/host/openwop-app/kicktodo/challenges/recommended` (toggle-gated,
  identified caller), registered BEFORE the `/challenges/:id` family so the
  literal segment is never read as an id. Host-local; no wire.
- Discover renders "Recommended for you" between the filter states and the grid,
  signed-in only, hidden when empty. The anonymous branch is unchanged: the
  public catalog has no participant to reason about.

No model, no affinity table, no cross-participant signal. When the alpha shows
that depth alone is too thin a signal, the next input is the participant's own
completion evidence, still self-data.

## Alternatives considered

- **Refactor `recommendations` to accept sources.** Rejected: a cross-feature
  refactor of a commerce feature to serve a non-commerce need; and its ranking
  (co-purchase) has no meaning for free content.
- **Recommend via product links.** Rejected: covers paid challenges only, which
  skews Discover toward whatever is monetised.
- **A node in `feature.kicktodo.nodes`.** Deferred: the pack is at 1.28.0 in the
  concurrent ADR 0689 change; a read node (`recommended-challenges`) rides the next
  bump so two branches do not race one version.

## Consequences

- P3's last coverage-analysis item closes with an explanation the participant
  can read, not a score.
- One catalog read plus one enrollment read plus a bounded number of challenge
  point reads per call (one per in-flight/completed enrollment).

## Implementation record

- `kicktodo-core/recommendationService.ts` (`rankRecommendations` pure,
  `recommendedChallengesFor`), route in `kicktodo-core/routes.ts`.
- `client/kicktodoClient.ts` `recommendedChallenges()` (swallow-and-degrade: a
  failed read renders no section, never an error over the catalog).
  This is deliberately the shape the org-selection edge ratchet forbids (`listOrgs().catch(() => [])`, see `ui/useOrgSelection`), and the difference is load-bearing, not stylistic: an org picker GATES a later read, so its silence strands the page in a state that never failed, whereas this strip is garnish beside a catalog that renders on its own — a recommender that 500s must not take Discover down with it. A reader who sees `catch → empty` here should neither "fix" it nor widen the ratchet to catch it; if the strip ever gates anything, this exemption ends.
- `features/kicktodo/DiscoverPage.tsx` "Recommended for you"; i18n ×4.
- Tests: `test/kicktodo-recommendations.test.ts` (pure ranker: newcomer,
  completed-beginner, in-flight-only; store-backed: self-data isolation,
  exclusion, next-depth after completion).
