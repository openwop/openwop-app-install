/**
 * ADR 0123 Phase 1c — tenant leaderboard service.
 *
 * Aggregates a tenant's `MessageFeedback` into a per-model win-rate + Elo ranking
 * (`combineLeaderboard`). The feedback→model JOIN (a rated message's producing
 * model) is an INJECTED resolver — the route binds it to the message-meta lookup;
 * tests inject a stub. A message whose model can't be resolved is dropped (it can't
 * be attributed), keeping the ranking honest.
 *
 * @see docs/adr/0123-eval-feedback-leaderboard.md
 */
import { listFeedbackForTenant } from '../../host/messageFeedbackStore.js';
import { combineLeaderboard, type EvalModelRating } from './leaderboard.js';

/** Resolve the producing model for a rated message, or null if unattributable. */
export type ModelResolver = (conversationId: string, messageId: string) => Promise<string | null> | (string | null);

/** CONV-1: bound the concurrent model-resolution fan-out so a large-feedback tenant can't
 *  exhaust the storage pool (the prior code was a sequential N+1; unbounded Promise.all
 *  would burst O(unique-messages) reads at once). Analytics read — pool-safety over speed. */
const RESOLVE_CONCURRENCY = 10;

export async function buildTenantLeaderboard(tenantId: string, resolveModel: ModelResolver): Promise<EvalModelRating[]> {
  const rows = await listFeedbackForTenant(tenantId);
  // DEDUPE unique (conversation,message) keys — re-ratings reference the same message, so
  // they collapse to one resolve. Tab-separated (ids don't contain a tab).
  const uniqueKeys = [...new Set(rows.map((f) => `${f.conversationId}\t${f.messageId}`))];
  const modelByKey = new Map<string, string | null>();
  for (let i = 0; i < uniqueKeys.length; i += RESOLVE_CONCURRENCY) {
    const resolved = await Promise.all(uniqueKeys.slice(i, i + RESOLVE_CONCURRENCY).map(async (key) => {
      const [conversationId, messageId] = key.split('\t');
      return [key, await resolveModel(conversationId!, messageId!)] as const;
    }));
    for (const [key, model] of resolved) modelByKey.set(key, model);
  }
  const rated: Array<{ model: string; rating: 'up' | 'down' | 'neutral' }> = [];
  for (const f of rows) {
    const model = modelByKey.get(`${f.conversationId}\t${f.messageId}`);
    if (!model) continue; // unattributable → dropped (honest)
    rated.push({ model, rating: f.rating });
  }
  return combineLeaderboard(rated);
}
