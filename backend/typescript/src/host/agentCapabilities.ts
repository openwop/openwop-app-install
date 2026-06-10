/**
 * A11 — agent capability negotiation (RFC 0092) for the reference host.
 *
 * An agent manifest may declare `requiresCapabilities[]`; a host that doesn't
 * advertise a listed key surfaces the agent as degraded on `GET /v1/agents`
 * (reusing the RFC 0072 §C `degraded[]` field). These helpers compute the unmet
 * set against the host's advertised surfaces and merge it into `degraded[]`.
 */

import { listHostSurfaces } from '../bootstrap/hostSurfaceRegistry.js';

/** The capability keys this host advertises (supported host surfaces). */
export function advertisedCapabilitySet(): Set<string> {
  return new Set(listHostSurfaces().filter((s) => s.supported).map((s) => s.name));
}

/** Keys in `required` that `advertised` does not contain (the degraded set). */
export function unmetCapabilities(required: readonly string[] | undefined, advertised: ReadonlySet<string>): string[] {
  if (!required || required.length === 0) return [];
  return required.filter((k) => !advertised.has(k));
}

/** Merge an agent's pack-declared `degraded[]` with the capability keys it
 *  requires but the host doesn't advertise — the RFC 0092 §B projection.
 *  Returns undefined when nothing is degraded (so the field is omitted). */
export function mergeDegraded(
  packDegraded: readonly string[] | undefined,
  requiresCapabilities: readonly string[] | undefined,
  advertised: ReadonlySet<string>,
): string[] | undefined {
  const merged = new Set<string>(packDegraded ?? []);
  for (const k of unmetCapabilities(requiresCapabilities, advertised)) merged.add(k);
  return merged.size > 0 ? [...merged].sort() : undefined;
}
