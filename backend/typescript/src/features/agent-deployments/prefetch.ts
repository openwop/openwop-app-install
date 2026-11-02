/**
 * ADR 1014 D1 (corrected, user decision 2026-10-31: "at startup + on promote").
 *
 * Production instances boot with an empty disk, so an older agent version a
 * deployment names is fetched from the registry, never carried over. The fetch
 * happens in the BACKGROUND at three moments, and a run never waits on it:
 *   1. boot: every version any deployment row names (`prefetchAllNamedVersions`);
 *   2. after an applied transition: the versions that agent's rows name;
 *   3. when a pin finds its version missing on this instance: the run fails
 *      `agent_version_unavailable` (typed, immediate) and the fetch starts, so the
 *      next run succeeds.
 * Only pack agents (no `ownerTenant`) whose head is a DIFFERENT version are fetched.
 */
import { getAgentRegistry } from '../../executor/agentRegistry.js';
import { fetchArchivedVersion } from '../../packs/installLane.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.agent-deployments.prefetch');

/** At most this many fetches run at once from one call (boot can name many). */
const CONCURRENCY = 4;

/**
 * Start background fetches; resolves when they have settled (tests await it).
 * Never rejects: every caller is detached (`void`), and an unhandled rejection
 * would take the instance down.
 */
export async function prefetchVersions(pairs: Iterable<{ tenant: string; agentId: string; version: string }>): Promise<void> {
  try {
    const todo: Array<{ packName: string; version: string }> = [];
    const seen = new Set<string>();
    for (const { tenant, agentId, version } of pairs) {
      const key = `${tenant}::${agentId}@${version}`; // a tenant's agent can shadow a pack id
      if (seen.has(key)) continue;
      seen.add(key);
      // ADR 0379 — resolved under the row's tenant; only a PACK agent (no owner) is fetched.
      const head = await getAgentRegistry().resolve(agentId, tenant);
      if (!head || head.ownerTenant !== undefined || head.packVersion === version) continue;
      if (getAgentRegistry().get(agentId, undefined, version)) continue;
      todo.push({ packName: head.packName, version });
    }
    let failed = 0;
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const batch = await Promise.all(todo.slice(i, i + CONCURRENCY).map((t) => fetchArchivedVersion(t.packName, t.version)));
      failed += batch.filter((ok) => !ok).length;
    }
    if (failed > 0) log.warn('some archived agent versions could not be fetched', { failed, started: todo.length });
  } catch (err) {
    log.warn('agent version prefetch failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
