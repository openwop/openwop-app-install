/**
 * ADR 0902 D2 — the task-deck parent linkage (ADR 0133 P1), as a leaf module so
 * every caller-metadata entry point can import it without pulling the executor in.
 *
 * Host-written: the sub-run dispatcher and `startDeepRun` stamp it, and the deck
 * nests a run under the parent it names. A caller who could supply it would plant
 * a "delegated" card in another member's deck. Not a RESERVED run-metadata key
 * (that strip also runs on the host paths that legitimately write it): stripped
 * where caller metadata enters — `stripCallerAttribution` (`POST /runs`), the
 * scheduler route's job keys and the schedule daemon's spread — all three through
 * this one constant (`test/adr0902-task-deck-authority.test.ts`).
 */
export const CALLER_LINKAGE_KEYS = ['parentRunId', 'delegatedBy'] as const;
