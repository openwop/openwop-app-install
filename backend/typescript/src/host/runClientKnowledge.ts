/**
 * ADR 0944 D5 — the run lane's per-CLIENT knowledge. A client run searches the
 * knowledge collections that client designated for campaign work, alongside the
 * agent's own binding (an agent profile binds collections per AGENT, which
 * cannot say "this client's", finding M5).
 *
 * The owning feature (campaign-ops) registers the resolver; it answers from the
 * run's frozen context snapshot, so a fork searches the same collections, and
 * every id in it was checked to belong to the run's client org. Host code never
 * imports the feature. Unregistered, or any fault ⇒ no extra collections.
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runClientKnowledge');

export type RunClientKnowledgeResolver = (tenantId: string, runId: string) => Promise<string[]>;

let resolver: RunClientKnowledgeResolver | null = null;

export function registerRunClientKnowledge(fn: RunClientKnowledgeResolver): void {
  resolver = fn;
}

export async function runClientCollectionIds(tenantId: string, runId: string | undefined): Promise<string[]> {
  if (!resolver || !runId) return [];
  try {
    return await resolver(tenantId, runId);
  } catch (err) {
    log.warn('run_client_knowledge_failed', { tenantId, runId, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
