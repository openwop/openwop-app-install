/**
 * Tenant leaderboard service (ADR 0123 Phase 1c, rebuilt by ADR 0986 D2/D3).
 *
 * Reads the tenant's ratings and ranks those the SERVER attributed to a model.
 * A rating is attributed when it is recorded (`resolveRatingAttribution`, the
 * exchange's per-turn row); a legacy row recorded before that gets the same
 * lookup once here. Nothing reads client-written message meta.
 *
 * Every rating that still names no model is COUNTED (`coverage.unattributed`),
 * so the page can say how much of the signal it could not rank instead of
 * reading as "no ratings yet".
 *
 * @see docs/adr/0986-evals-attributed-leaderboard-and-bound-arena.md
 */
import { listFeedbackForTenant } from '../../host/messageFeedbackStore.js';
import { resolveRatingAttribution, type ServedModel } from '../../host/turnAttribution.js';
import { combineLeaderboard, type ModelRating, type RatedTurn } from './leaderboard.js';

/** Bound the legacy-row lookups so a large tenant cannot burst the storage pool. */
const RESOLVE_CONCURRENCY = 10;

export interface LeaderboardCoverage { attributed: number; unattributed: number }

export async function buildTenantLeaderboard(tenantId: string): Promise<{ leaderboard: ModelRating[]; coverage: LeaderboardCoverage }> {
  const rows = await listFeedbackForTenant(tenantId);
  // Only rows recorded before ADR 0986 — a row checked at write is never re-read,
  // so forged or unattributable ratings cannot make every admin read slower.
  const legacy = rows.filter((f) => !f.attribution && !f.attributionChecked);
  const resolved = new Map<string, ServedModel | null>();
  for (let i = 0; i < legacy.length; i += RESOLVE_CONCURRENCY) {
    await Promise.all(legacy.slice(i, i + RESOLVE_CONCURRENCY).map(async (f) => {
      const key = `${f.conversationId}\t${f.messageId}`;
      if (resolved.has(key)) return;
      resolved.set(key, (await resolveRatingAttribution(tenantId, f.conversationId, f.messageId))?.served ?? null);
    }));
  }
  const rated: RatedTurn[] = [];
  let unattributed = 0;
  for (const f of rows) {
    const served = f.attribution ?? resolved.get(`${f.conversationId}\t${f.messageId}`) ?? null;
    if (!served) { unattributed += 1; continue; }
    rated.push({ provider: served.provider, model: served.model, ...(served.managed ? { managed: true } : {}), rating: f.rating, rater: f.subjectRef });
  }
  return { leaderboard: combineLeaderboard(rated), coverage: { attributed: rated.length, unattributed } };
}
