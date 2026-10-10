/**
 * ADR 0852 D2 — which project a run is working on, when the answer lives in a
 * feature the ledger must not depend on (a campaign run ⇒ the campaign's
 * project). A feature registers a resolver that reads HOST-WRITTEN run metadata
 * and returns a project id; the team ledger's run-start contributor asks here
 * after its own kanban / schedule branches.
 *
 * Resolvers read only keys that `POST /runs` strips from caller input
 * (`stripCallerAttribution`), so a caller cannot point a run at someone else's
 * project through them. Fail-soft: a resolver that throws resolves nothing.
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runProjectBinding');

export type RunProjectResolver = (tenantId: string, metadata: Readonly<Record<string, unknown>>) => Promise<string | undefined>;

const resolvers: Array<{ id: string; fn: RunProjectResolver }> = [];

export function registerRunProjectResolver(id: string, fn: RunProjectResolver): void {
  if (resolvers.some((r) => r.id === id)) return; // idempotent across re-registration
  resolvers.push({ id, fn });
}

/** The first project id a resolver returns for this run's metadata, if any. */
export async function resolveRunProject(tenantId: string, metadata: Readonly<Record<string, unknown>>): Promise<string | undefined> {
  for (const r of resolvers) {
    try {
      const id = await r.fn(tenantId, metadata);
      if (id) return id;
    } catch (err) {
      log.warn('run_project_resolver_failed', { id: r.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return undefined;
}
