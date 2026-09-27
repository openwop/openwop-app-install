/**
 * Pure helpers for the Catalog & content-health surface (ADR 0438 A3). Kept
 * separate so the aggregation is unit-pinned independent of the React render.
 */
import type { ChallengeSummary } from '../../client/kicktodoClient.js';

/** Count published-catalog challenges by lifecycle `status`, returned as sorted
 *  [status, count] pairs (descending count, then status name) for stable display. */
export function countByState(challenges: ChallengeSummary[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const c of challenges) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  return [...counts.entries()].sort(([sa, na], [sb, nb]) => (nb - na) || sa.localeCompare(sb));
}
