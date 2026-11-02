/**
 * ADR 1012 — the chat dispatch lane refuses a provider-executed search on a
 * replay, and stays live outside one.
 *
 * Sabotage-witnessed (2026-10-30): dropping the guard in `dispatchReply` reds
 * the replay case. The live control proves that case reached the dispatch line.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatchChatMock } = vi.hoisted(() => ({
  dispatchChatMock: vi.fn(async (_req: unknown) => ({ completion: 'ok', usage: { inputTokens: 1, outputTokens: 1 } })),
}));
vi.mock('../src/providers/dispatch.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/dispatch.js')>();
  return { ...original, dispatchChat: dispatchChatMock };
});

import { openStorage } from '../src/storage/index.js';
import { configureSecretResolver, setSecret } from '../src/byok/secretResolver.js';
import { dispatchReply } from '../src/host/exchange/dispatchTurn.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import type { RunRecord } from '../src/types.js';

process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
const storage = await openStorage('memory://');
configureSecretResolver({ storage, dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr1012-')) });

function run(runId: string): RunRecord {
  const now = new Date().toISOString();
  return {
    runId, workflowId: 'wf', tenantId: 'demo', status: 'running',
    inputs: { provider: 'openai', model: 'gpt-x', credentialRef: 'byok:openai', webSearch: true },
    metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
}
const reply = (id: string, replaying: boolean) => runWithEffectContext(
  { runId: id, replaying } as Parameters<typeof runWithEffectContext>[0],
  () => dispatchReply(run(id), [{ role: 'user', content: 'search for it' }]),
);

describe('ADR 1012 — chat native search', () => {
  beforeEach(async () => {
    dispatchChatMock.mockClear();
    await setSecret('byok:openai', 'sk-test', { tenantId: 'demo' });
  });

  it('control: a live turn reaches the provider', async () => {
    await reply('run-1012-chat-live', false);
    expect(dispatchChatMock).toHaveBeenCalledTimes(1);
  });

  it('a replay is refused before the provider', async () => {
    await expect(reply('run-1012-chat-replay', true)).rejects.toMatchObject({ code: 'replay_source_missing' });
    expect(dispatchChatMock).not.toHaveBeenCalled();
  });
});
