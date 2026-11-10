/**
 * ADR 1012 — the chat dispatch lane refuses a provider-executed search on a
 * replay, and stays live outside one.
 *
 * Sabotage-witnessed (2026-10-30, re-probed wave 81): dropping the guard in
 * `dispatchReply`, or the `replaying` check in `assertEffectAllowed`, reds the
 * replay case; a guard that refuses every search turn reds the live control.
 * The live control proves that case reached the dispatch line on the search
 * branch (`webSearch: true`).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { runWithEffectContext, type RunEffectContext } from '../src/host/runEffectContext.js';
import type { RunRecord } from '../src/types.js';

const priorEphemeral = process.env.OPENWOP_BYOK_EPHEMERAL;
process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
afterAll(() => {
  if (priorEphemeral === undefined) delete process.env.OPENWOP_BYOK_EPHEMERAL;
  else process.env.OPENWOP_BYOK_EPHEMERAL = priorEphemeral;
});
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
const reply = (id: string, replaying: boolean) => {
  const ctx: RunEffectContext = { runId: id, replaying };
  return runWithEffectContext(ctx, () => dispatchReply(run(id), [{ role: 'user', content: 'search for it' }]));
};

describe('ADR 1012 — chat native search', () => {
  beforeEach(async () => {
    dispatchChatMock.mockClear();
    await setSecret('byok:openai', 'sk-test', { tenantId: 'demo' });
  });

  it('control: a live turn reaches the provider', async () => {
    const out = await reply('run-1012-chat-live', false);
    expect(out.completion).toBe('ok');
    expect(dispatchChatMock).toHaveBeenCalledTimes(1);
    // It reached the provider on the SEARCH branch the replay guard sits on.
    expect(dispatchChatMock.mock.calls[0]?.[0]).toMatchObject({ provider: 'openai', webSearch: true });
  });

  it('a replay is refused before the provider', async () => {
    await expect(reply('run-1012-chat-replay', true)).rejects.toMatchObject({ code: 'replay_source_missing' });
    expect(dispatchChatMock).not.toHaveBeenCalled();
  });
});
