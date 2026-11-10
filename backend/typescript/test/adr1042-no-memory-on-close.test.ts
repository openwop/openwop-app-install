/**
 * ADR 1042 (review N2) — closing a channel-ingress conversation extracts no
 * memory. Its "user" turns are other people's words (fenced channel messages),
 * never the owner's own, so the ADR 0982 extraction lane must not read them,
 * whatever the owner's consent.
 *
 * The extractor is replaced by a recording fake typed against the real
 * `extractConversationMemory` signature: the channel case asserts it received
 * nothing, the ordinary case asserts it received THIS run's tenant and user turn.
 *
 * Red when: the `channelIngress` guard in `maybeExtractMemoryOnClose`
 * (`persistExchange.ts`) is removed, or narrowed so a stamped object no longer
 * counts (e.g. `=== true`).
 * Sabotage-witnessed (w87 g2 probes nm-guard, nm-guard-truthy): each turned the
 * channel case red.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../src/types.js';
import type { ConversationTurn } from '../src/host/conversation.js';
import type { ExtractionOutcome } from '../src/features/memory-auto-extract/extractionOp.js';

const seen = vi.hoisted((): Array<{ tenantId: string; userTurns: readonly string[] }> => []);
vi.mock('../src/features/memory-auto-extract/extractionBinding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/memory-auto-extract/extractionBinding.js')>();
  const extractConversationMemory: typeof actual.extractConversationMemory = async (run, userTurns): Promise<ExtractionOutcome> => {
    seen.push({ tenantId: run.tenantId, userTurns: [...userTurns] });
    return { status: 'skipped', reason: 'no-consent' };
  };
  return { ...actual, extractConversationMemory };
});

const { maybeExtractMemoryOnClose } = await import('../src/host/exchange/persistExchange.js');

const run = (metadata: Record<string, unknown>): RunRecord => ({
  runId: 'r', workflowId: 'openwop-app.conversation', tenantId: 'user:t', status: 'waiting-input', inputs: {},
  metadata: { actingUserId: 'user:t', ...metadata }, configurable: {}, createdAt: '', updatedAt: '',
});
const turns: ConversationTurn[] = [{ messageId: 'c:1:user', turnIndex: 1, role: 'user', from: 'user', content: 'hi', ts: 0 }];

describe('memory extraction on close', () => {
  it('is skipped for a channel-ingress conversation', async () => {
    seen.length = 0;
    await maybeExtractMemoryOnClose(run({ channelIngress: { lane: 'conn:x', scope: 'self' } }), turns);
    expect(seen).toEqual([]);
  });

  it('still runs for an ordinary chat conversation (non-vacuity)', async () => {
    seen.length = 0;
    await maybeExtractMemoryOnClose(run({}), turns);
    expect(seen).toEqual([{ tenantId: 'user:t', userTurns: ['hi'] }]);
  });
});
