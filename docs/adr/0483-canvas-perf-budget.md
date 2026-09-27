# ADR 0483 — The B5 canvas performance budget (200-node ratchet)

Status: Accepted — implemented (this PR)
Date: 2026-07-24
Relates: the 2026-07-24 competitive re-assessment (whitespace item 5 — B5
"scale cliffs" was the ONLY failure mode the 0474-0482 program never
touched: "UNTESTED — no perf budget exists for large graphs").

## Decision

B5 closes as a RATCHET, not an audit ("an audit is a snapshot, a test is a
ratchet"):

1. **The disciplines already exist** — `BaseNode` is memoized and every
   single-node store mutation preserves unchanged nodes' object identities.
   `canvasPerfBudget.test.tsx` PINS both deterministically (reference
   assertions + the react.memo symbol — zero timing flake), verified
   NON-VACUOUS by sabotage probes in review.
   **Correction (review F1 — claim honesty):** these pin the STORE half
   only. `BuilderCanvas`'s `rfNodes` useMemo currently re-mints every
   node's `data` object per edit, so the end-to-end O(1) re-render is NOT
   yet harvested — all 200 memoized nodes still shallow-compare fresh
   `data` props. The per-node data-mapping memoization (stable `data`
   caches + hoisted connect handlers) is the RECORDED FOLLOW-ON that
   converts the pinned discipline into rendered O(1); the store pin is
   what makes that fix possible and keeps it from regressing after it
   lands.
2. **Op ceilings** on a generated 200-node/300-edge graph: serialize,
   single-node update, and 20-update bursts under deliberately generous
   absolute ceilings (≥10× local headroom — the ratchet catches accidental
   O(n²), not millisecond drift). The budget constants live in the test as
   the single source of truth (`CANVAS_PERF_BUDGET`).
3. **The honest advisory**: past the budget the builder shows a dismissible
   info Notice — once per workflow per SESSION (sessionStorage-backed,
   review F2) — naming the budget and the composition cure: sub-workflows
   (the chains-or-stacks doctrine). The threshold has ONE source of truth
   (`builder/perfBudget.ts`, review F3) imported by the test, the shell,
   and interpolated into the copy ×4. i18n ×4.
4. Browser-level frame-rate profiling at 200 nodes is the recorded
   follow-on (the Playwright lane the collab canary also waits on) — the
   jsdom ratchet covers the algorithmic regressions that cause cliffs.

## Implementation record

This PR: the ratchet suite (6 tests: 2 identity, 1 memo, 3 ceilings) + the
large-canvas advisory + i18n ×4 + the assessment B5 row update.
