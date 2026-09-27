/**
 * RFC 0194 §A — a run's log is CLOSED by its terminal event. After it, no
 * FORWARD-EXECUTION event may be appended: a second terminal, run.started /
 * resumed / resuming (v2 `run.resume-started`) / paused / restored, `node.*`,
 * `interrupt.*`. Anything else (compensation, the dead-letter record, the
 * RFC 0151 §E `authorization.decided` audit trail, vendor types) may follow.
 * This mirrors the corpus rule in `@openwop/openwop-conformance`
 * `lib/terminal-shape.ts`, in this host's internal spellings.
 *
 * ONE definition, used at two layers:
 *  - the STORE (`appendEvent`, inside the per-run serialization it already
 *    takes), the authority. It holds ACROSS instances. MEASURED in production on
 *    2026-09-22 (rev 00733, suite 2.35.1): `run.started run.cancelled
 *    node.started`, a cancel on one instance racing the executor on another,
 *    which the per-process guard could not see;
 *  - `eventLog.append`, a per-process fast path that refuses without a store
 *    round-trip once this process has seen the terminal event.
 */
export const TERMINAL_RUN_EVENT_TYPES: readonly string[] = ['run.completed', 'run.failed', 'run.cancelled'];

const FORWARD_RUN_EVENTS: ReadonlySet<string> = new Set([
  ...TERMINAL_RUN_EVENT_TYPES, // a SECOND terminal
  'run.started', 'run.resumed', 'run.resuming', 'run.resume-started', 'run.paused',
  'run.restored-from-snapshot', 'workflow.restored',
]);

/** True when `type` is forward execution, i.e. MUST NOT follow a terminal event. */
export function isForwardExecutionEvent(type: string): boolean {
  return FORWARD_RUN_EVENTS.has(type) || type.startsWith('node.') || type.startsWith('interrupt.');
}

/** Thrown for a forward-execution append behind a run's terminal event. Callers
 *  on abort/cleanup paths treat it as "the run already ended", nothing more. */
export class RunLogClosedError extends Error {
  readonly code = 'OPENWOP_RUN_LOG_CLOSED';
  constructor(readonly runId: string, readonly type: string, readonly closedBy: string) {
    super(`run ${runId} log is closed by ${closedBy}; refusing ${type} (RFC 0194 §A)`);
  }
}
