/**
 * ADR 0941 D2b — host-written run stamps a sub-workflow CHILD inherits from its
 * parent, optionally projected by the owning feature.
 *
 * A child run is built FRESH (`executor/subWorkflowDispatcher.ts`): it carries
 * no actor and only the reserved-stripped handoff. A stamp that says which
 * larger unit of work a run belongs to (the ADR 0941 campaign run tag) and the
 * decision frozen for that unit (the campaign's goal) must reach the child too,
 * or a nested chain silently leaves the campaign. A feature registers the KEYS;
 * core never names them.
 *
 * Only keys the host writes may be registered: the copy is taken from the
 * PARENT RUN ROW, never from a caller, so it is as trustworthy as the parent's
 * own stamp. A feature may project scope without delegating run-specific
 * authority. The copy runs before the run-start contributors,
 * whose no-overwrite merge then keeps it (a frozen decision is inherited, not
 * re-resolved against live state).
 */

type MetadataProjector = (value: unknown) => unknown;
const keys = new Map<string, MetadataProjector>();

export function registerInheritedRunMetadataKey(key: string, project: MetadataProjector = (value) => value): void {
  keys.set(key, project);
}

/** Registered parent values, projected before fresh child contributors run. */
export function inheritedRunMetadata(parent: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!parent) return out;
  for (const [k, project] of keys) {
    if (k in parent && parent[k] !== undefined) {
      const value = project(parent[k]);
      if (value !== undefined) out[k] = value;
    }
  }
  return out;
}
