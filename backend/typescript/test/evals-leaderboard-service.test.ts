/**
 * ADR 0986 D2 — the tenant leaderboard service ranks only ratings the SERVER
 * attributed, and counts the rest.
 *
 * - A rating stamped at write (`attribution`) ranks under that model.
 * - A legacy row (no stamp) gets one lookup against the exchange's attribution
 *   row, which must belong to the rating's conversation.
 * - Everything else is `coverage.unattributed` — never dropped silently, never
 *   read from client message meta.
 *
 * Sabotage witnesses: skipping the legacy lookup reds "a legacy row…"; dropping the
 * conversation check in `resolveRatingAttribution` reds "…another conversation";
 * replacing the bound-run arm with `true` reds "a run bound WITHOUT a session
 * stamp…"; dropping the `attributionChecked` filter reds "…never looked up again";
 * not counting unattributed rows reds the coverage case.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { setMessageFeedback } from '../src/host/messageFeedbackStore.js';
import { recordTurnAttribution } from '../src/host/turnAttribution.js';
import { conversationMessageId } from '../src/host/conversationMessageId.js';
import { buildTenantLeaderboard } from '../src/features/evals/leaderboardService.js';
import { setConversationRun } from '../src/host/conversationStore.js';

const T = 'lb-tenant';
const served = (model: string) => ({ served: { provider: 'openai', model }, runId: 'run-1' });

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await setMessageFeedback({ tenantId: T, conversationId: 'c1', messageId: 'a1', subjectRef: 'user:1', rating: 'up', attribution: served('model-A') });
  await setMessageFeedback({ tenantId: T, conversationId: 'c1', messageId: 'a2', subjectRef: 'user:2', rating: 'up', attribution: served('model-A') });
  await setMessageFeedback({ tenantId: T, conversationId: 'c1', messageId: 'b1', subjectRef: 'user:1', rating: 'down', attribution: served('model-B') });
  await setMessageFeedback({ tenantId: T, conversationId: 'c1', messageId: 'x9', subjectRef: 'user:1', rating: 'up' }); // no row anywhere
});

describe('buildTenantLeaderboard', () => {
  it('ranks stamped ratings by model and counts the unattributable one', async () => {
    const { leaderboard, coverage } = await buildTenantLeaderboard(T);
    expect(leaderboard.map((r) => r.model)).toEqual(['model-A', 'model-B']);
    expect(leaderboard[0]).toMatchObject({ up: 2, down: 0, raters: 2 });
    expect(coverage).toEqual({ attributed: 3, unattributed: 1 });
  });

  it('a legacy row is attributed through the exchange row of ITS conversation, never another conversation\'s', async () => {
    const TL = 'lb-legacy';
    const wire = 'run-L:gate:0:2:agent';
    await recordTurnAttribution({ tenantId: TL, wireMessageId: wire, runId: 'run-L', chatSessionId: 'sess-L', served: { provider: 'google', model: 'gemini-x' } });
    await setMessageFeedback({ tenantId: TL, conversationId: 'sess-L', messageId: conversationMessageId(wire), subjectRef: 'user:1', rating: 'up' });
    await setMessageFeedback({ tenantId: TL, conversationId: 'sess-OTHER', messageId: conversationMessageId(wire), subjectRef: 'user:1', rating: 'up' });
    const { leaderboard, coverage } = await buildTenantLeaderboard(TL);
    expect(leaderboard).toEqual([expect.objectContaining({ key: 'google/gemini-x', up: 1 })]);
    expect(coverage).toEqual({ attributed: 1, unattributed: 1 });
  });

  it('a run bound WITHOUT a session stamp attributes only inside the conversation it is bound to', async () => {
    const TB = 'lb-bound';
    const wire = 'run-B:gate:0:2:agent';
    await recordTurnAttribution({ tenantId: TB, wireMessageId: wire, runId: 'run-B', served: { provider: 'openai', model: 'gpt-bound' } });
    await setConversationRun(TB, 'sess-bound', 'run-B');
    await setConversationRun(TB, 'sess-other', 'run-X');
    await setMessageFeedback({ tenantId: TB, conversationId: 'sess-bound', messageId: conversationMessageId(wire), subjectRef: 'user:1', rating: 'up' });
    await setMessageFeedback({ tenantId: TB, conversationId: 'sess-other', messageId: conversationMessageId(wire), subjectRef: 'user:1', rating: 'up' });
    const { leaderboard, coverage } = await buildTenantLeaderboard(TB);
    expect(leaderboard).toEqual([expect.objectContaining({ key: 'openai/gpt-bound', up: 1 })]);
    expect(coverage).toEqual({ attributed: 1, unattributed: 1 });
  });

  it('a rating already checked at write is never looked up again', async () => {
    const TC = 'lb-checked';
    const wire = 'run-C:gate:0:2:agent';
    // Checked (and found nothing) when it was recorded; the row appears later.
    await setMessageFeedback({ tenantId: TC, conversationId: 'sess-C', messageId: conversationMessageId(wire), subjectRef: 'user:1', rating: 'up', attribution: null });
    await recordTurnAttribution({ tenantId: TC, wireMessageId: wire, runId: 'run-C', chatSessionId: 'sess-C', served: { provider: 'openai', model: 'late' } });
    expect((await buildTenantLeaderboard(TC)).coverage).toEqual({ attributed: 0, unattributed: 1 });
  });

  it('a tenant with no feedback sees none of another tenant\'s rows', async () => {
    expect(await buildTenantLeaderboard('no-feedback')).toEqual({ leaderboard: [], coverage: { attributed: 0, unattributed: 0 } });
  });
});
