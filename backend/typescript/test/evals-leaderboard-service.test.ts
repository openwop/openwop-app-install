/**
 * ADR 0123 Phase 1c — tenant leaderboard service (feedback aggregation + join).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { setMessageFeedback } from '../src/host/messageFeedbackStore.js';
import { buildTenantLeaderboard } from '../src/features/evals/leaderboardService.js';

const T = 'lb-tenant';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  // model A: 2 up, 1 down; model B: 1 up, 1 down. Each msg maps to a model below.
  await setMessageFeedback({ tenantId: T, conversationId: 'c1', messageId: 'a1', subjectRef: 'user:1', rating: 'up' });
  await setMessageFeedback({ tenantId: T, conversationId: 'c1', messageId: 'a2', subjectRef: 'user:1', rating: 'up' });
  await setMessageFeedback({ tenantId: T, conversationId: 'c1', messageId: 'a3', subjectRef: 'user:1', rating: 'down' });
  await setMessageFeedback({ tenantId: T, conversationId: 'c1', messageId: 'b1', subjectRef: 'user:1', rating: 'up' });
  await setMessageFeedback({ tenantId: T, conversationId: 'c1', messageId: 'b2', subjectRef: 'user:1', rating: 'down' });
  await setMessageFeedback({ tenantId: T, conversationId: 'c1', messageId: 'x9', subjectRef: 'user:1', rating: 'up' }); // unattributable
});

const resolver = (_c: string, m: string): string | null => (m.startsWith('a') ? 'model-A' : m.startsWith('b') ? 'model-B' : null);

describe('buildTenantLeaderboard', () => {
  it('aggregates feedback → per-model win-rate + Elo, ranked', async () => {
    const lb = await buildTenantLeaderboard(T, resolver);
    const a = lb.find((m) => m.model === 'model-A')!;
    const b = lb.find((m) => m.model === 'model-B')!;
    expect(a).toMatchObject({ up: 2, down: 1 });
    expect(a.winRate).toBeCloseTo(2 / 3);
    expect(b.winRate).toBeCloseTo(0.5);
    expect(a.elo).toBeGreaterThan(b.elo); // A ranks above B
    expect(lb[0]!.model).toBe('model-A');
  });

  it('drops unattributable feedback (model x9 → null)', async () => {
    const lb = await buildTenantLeaderboard(T, resolver);
    expect(lb.some((m) => m.model === null || m.model === '')).toBe(false);
    // only the two attributable models present
    expect(new Set(lb.map((m) => m.model))).toEqual(new Set(['model-A', 'model-B']));
  });

  it('empty tenant → empty leaderboard', async () => {
    expect(await buildTenantLeaderboard('no-feedback', resolver)).toEqual([]);
  });

  it('CONV-1: dedupes — two feedback rows on the SAME message resolve the model ONCE', async () => {
    await setMessageFeedback({ tenantId: 'dedup-t', conversationId: 'c', messageId: 'm1', subjectRef: 'user:1', rating: 'up' });
    await setMessageFeedback({ tenantId: 'dedup-t', conversationId: 'c', messageId: 'm1', subjectRef: 'user:2', rating: 'down' });
    let calls = 0;
    const counting = (_c: string, _m: string): string | null => { calls++; return 'model-A'; };
    await buildTenantLeaderboard('dedup-t', counting);
    expect(calls).toBe(1); // the shared message is resolved once, not once per feedback row
  });
});
