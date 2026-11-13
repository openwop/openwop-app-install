/**
 * ADR 1058 PR-B — the RFC 0258 wire names this host emits and reads, in ONE
 * place.
 *
 * RFC 0258 is `Active` in openwop 2.46.44 (`$defs/EdgeLoopback`,
 * `nodeCompleted.loopback`, `ApprovalData.loopback`, cap kind
 * `loopback-iterations`, the `loopback` family). These spellings match that
 * diff byte for byte. When the corpus renames one, the fix is one edit here,
 * and every emitter, reader, refusal and test follows. Nothing outside this
 * module spells an RFC 0258 field, event, reason or code as a literal.
 *
 * Kept import-free so the route layer, the executor and the chain loader can
 * all take it without a cycle.
 */

/** `WorkflowEdge.loopback` / `FragmentEdge.loopback` (RFC 0258 §A). */
export const LOOPBACK_EDGE_FIELD = 'loopback' as const;

/**
 * The marker on the gate's `node.completed` (§C.1). Before 2.46.44 declared
 * `nodeCompleted.loopback`, an undeclared key would have been boxed under the
 * vendor hatch on a major-2 read (RFC 0185 §C), so the first host cut wrote the
 * hatch key `openwop-loopback`. The host now writes the declared field and
 * READS both, so any run recorded under the hatch key keeps replaying.
 */
export const LOOPBACK_MARKER_FIELD = 'loopback' as const;
export const LOOPBACK_MARKER_HATCH_KEY = 'openwop-loopback' as const;
/** The key the host writes: the declared field since openwop 2.46.44 (RFC 0258 `Active`,
 *  `nodeCompleted.loopback` vendored). Runs recorded under the hatch key still read. */
export const LOOPBACK_MARKER_WRITE_KEY: string = LOOPBACK_MARKER_FIELD;

/** `ApprovalData.loopback {round, maxIterations, exhausted}` (§D). */
export const APPROVAL_DATA_LOOPBACK_FIELD = 'loopback' as const;

/** The capability facet and its members (§E). */
export const LOOPBACK_CAPABILITY = 'loopback' as const;
export const LOOPBACK_MAX_ITERATIONS_FIELD = 'maxIterations' as const;
export const LOOPBACK_MAX_HISTORY_ENTRY_BYTES_FIELD = 'maxHistoryEntryBytes' as const;

/** The truncated-entry marker (§C.4): `{ truncated: true, bytes }`. */
export const HISTORY_TRUNCATED_FIELD = 'truncated' as const;
export const HISTORY_BYTES_FIELD = 'bytes' as const;

/** The detail event and the cap kind a refine past a `fail` cap emits (§D). */
export const LOOPBACK_LIMIT_EVENT = 'workflow.loopback-limit' as const;
export const LOOPBACK_CAP_KIND = 'loopback-iterations' as const;

/** The run's typed failure past a `fail` cap (§D; registered since 1.0). */
export const LOOPBACK_LIMIT_ERROR_CODE = 'loop_limit_exceeded' as const;

/** `details.reason` on the 400 that refuses a withdrawn refine (§D). */
export const LOOPBACK_EXHAUSTED_REASON = 'loopback_exhausted' as const;
