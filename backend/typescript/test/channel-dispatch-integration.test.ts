/**
 * ADR 0154 FU-5 — dispatch integration: a human post in a channel with an agent
 * member fires EXACTLY ONE `openwop-app.channel.turn` run, system-fired (managed
 * credential, no actingUserId, channel attribution); a system/agent path (no
 * authorUserId) does NOT dispatch (the no-loop guarantee). `startWorkflowRun` is
 * mocked so the assertion is on the dispatch CONTRACT, not the run engine.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../src/host/runStarter.js', () => ({ startWorkflowRun: vi.fn(async () => 'run-1') }));

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createChannel, addChannelAgent } from '../src/features/channels/channelService.js';
import { dispatchChannelAgentTurns } from '../src/features/channels/channelAgentDispatch.js';
import { startWorkflowRun } from '../src/host/runStarter.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import type { StartRunDeps } from '../src/host/runStarter.js';

const T = 'fu5-tenant';
const mock = startWorkflowRun as unknown as ReturnType<typeof vi.fn>;
const deps = {} as StartRunDeps; // forwarded to the mocked startWorkflowRun; unused otherwise

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-fu5-')) });
  initHostExtPersistence(await openStorage('memory://'));
  getAgentRegistry().register({
    agentId: 'test.helper', persona: 'Helper', modelClass: 'general',
    systemPrompt: 'help', packName: 'test', packVersion: '0', toolAllowlist: [],
  });
});

describe('channel agent dispatch (FU-5)', () => {
  it('a human post in a sole-agent channel fires exactly one system-fired channel.turn', async () => {
    const ch = await createChannel(T, 'user:owner', { name: 'ai', visibility: 'public' });
    await addChannelAgent(T, ch.conversationId, 'user:owner', 'test.helper');
    mock.mockClear();

    await dispatchChannelAgentTurns(deps, T, ch.conversationId, 'm1', 'hello there', 'user:poster');

    expect(mock).toHaveBeenCalledTimes(1);
    const input = mock.mock.calls[0]![1] as {
      workflowId: string;
      configurable: Record<string, unknown>;
      metadata: { channel?: Record<string, unknown> };
      actingUserId?: unknown;
    };
    expect(input.workflowId).toBe('openwop-app.channel.turn');
    expect(input.configurable).toMatchObject({
      agentId: 'test.helper', task: 'hello there', conversationId: ch.conversationId, credentialRef: 'managed:openwop-free',
    });
    expect(input.metadata.channel).toMatchObject({
      source: 'channel', channelId: ch.conversationId, triggeringMessageId: 'm1', agentId: 'test.helper',
    });
    // System-fired: no acting user is threaded onto the run.
    expect('actingUserId' in input).toBe(false);
  });

  it('does NOT dispatch for a system/agent path (no authorUserId) — the no-loop guard', async () => {
    const ch = await createChannel(T, 'user:owner', { name: 'ai2', visibility: 'public' });
    await addChannelAgent(T, ch.conversationId, 'user:owner', 'test.helper');
    mock.mockClear();

    await dispatchChannelAgentTurns(deps, T, ch.conversationId, 'm2', 'an agent reply', undefined);

    expect(mock).not.toHaveBeenCalled();
  });

  it('does NOT dispatch when the channel has no agent member', async () => {
    const ch = await createChannel(T, 'user:owner', { name: 'humans-only', visibility: 'public' });
    mock.mockClear();

    await dispatchChannelAgentTurns(deps, T, ch.conversationId, 'm3', 'hi everyone', 'user:poster');

    expect(mock).not.toHaveBeenCalled();
  });
});
