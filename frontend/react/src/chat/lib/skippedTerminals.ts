/**
 * RFC 0257 (ADR 1027 P3) — the terminal nodes a completed run never reached.
 *
 * A run in which no node failed and every terminal node was skipped (a guard
 * that declined, a router that matched no branch, an `any_failed` handler whose
 * source succeeded) ends `completed`, and its `run.completed` payload names
 * those terminals in `skippedTerminals`. The key is ABSENT whenever a terminal
 * completed, so a non-empty list is the whole signal: this run finished without
 * any final step, and showing it as a plain success would hide that (RFC 0257
 * R1, "silent success").
 *
 * Read from the payload, never derived from the graph: the host records the
 * list from the pinned definition (§A.4), and the SPA may not have the graph.
 *
 * Two spellings, both read. Since suite 2.46.41 the major-2 schema declares the
 * key, so it sits on the payload. A host that serves an older v2 schema carries
 * it under `vendor.openwop-app` (ADR 0725 D3) instead of dropping it.
 */
const VENDOR_CARRY_KEY = 'vendor.openwop-app';

function asIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/** The `skippedTerminals` of a `run.completed` payload, or `undefined` when the
 *  run reached a terminal (or the payload is not a `run.completed` one). */
export function readSkippedTerminals(payload: unknown): string[] | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const seated = asIdList(p.skippedTerminals);
  if (seated) return seated;
  const carry = p[VENDOR_CARRY_KEY];
  return carry && typeof carry === 'object'
    ? asIdList((carry as Record<string, unknown>).skippedTerminals)
    : undefined;
}

/** The marker off the LAST `run.completed` in an event list (a run has one;
 *  the last wins if a log ever carries more). */
export function skippedTerminalsFromEvents(
  events: readonly { type: string; payload?: unknown }[],
): string[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === 'run.completed') return readSkippedTerminals(ev.payload);
  }
  return undefined;
}
