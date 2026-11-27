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

/**
 * The run's frozen AI default (`host/runAiDefault.ts`, issue #5764), as a leaf
 * constant for the same three entry points.
 *
 * Host-written: the run-start contributor freezes it from the workspace's own
 * binding, and the campaign stage launch (`launchAi.ts`) writes it on purpose.
 * Since #5764 a `source: 'workspace'` value carries a stored-secret ref NAME, and
 * `stampRunStartContext` never overwrites a key already present. So a caller who
 * could supply it would choose which of the workspace's stored secrets pays for
 * the run, past the wire-ref check. Not a RESERVED run-metadata key, for the
 * same reason as the linkage (the host's own launch path writes it). Stripped in
 * `stripCallerAttribution` (`POST /runs`), the scheduler route's job keys, and the
 * schedule daemon's spread, which also covers jobs saved before the route refused it
 * (`test/run-ai-default-caller-strip.test.ts`). Reported by a white-label adopter
 * that carried this hardening locally.
 */
export const RUN_AI_DEFAULT_KEY = 'aiDefault';
export const CALLER_AI_DEFAULT_KEYS = [RUN_AI_DEFAULT_KEY] as const;
