/**
 * ADR 0154 FU-5 — dispatch integration: a human post in a channel with an agent
 * member fires EXACTLY ONE `openwop-app.channel.turn` run, system-fired (managed
 * credential, no actingUserId, channel attribution); a system/agent path (no
 * authorUserId) does NOT dispatch (the no-loop guarantee). `startWorkflowRun` is
 * mocked so the assertion is on the dispatch CONTRACT, not the run engine.
 *
 * What breaks it: an agent reply re-triggering dispatch (a paid-run loop), a turn that
 * threads the POSTER as the acting user (twin recall / BYOK on a workspace-visible
 * reply — ADR 0589 §D2) or loses the ADR 0832 D3 `orgScopeSubject` narrowing.
 * The "no agent member" case is an honest DOUBLE guard: `selectChannelTurnTargets([])`
 * also returns `[]`, so removing the early return alone stays green (w26 probe
 * `dispatch-no-agent`); the case still pins the end-to-end outcome.
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

/** ADR 0879 D1 — a caller holding `workspace:write` (not an admin): the service-level
 *  witnesses below exercise the channel rules, not the role gate (route tests do). */
const FULL_AUTHORITY = { canWrite: true, isAdmin: false };

const T = 'fu5-tenant';
const mock = vi.mocked(startWorkflowRun);
// Forwarded to the MOCKED startWorkflowRun and never read — the one honest cast here.
const deps = {} as StartRunDeps;

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
    const ch = await createChannel(T, 'user:owner', { name: 'ai', visibility: 'public' }, FULL_AUTHORITY);
    await addChannelAgent(T, ch.conversationId, 'user:owner', FULL_AUTHORITY, 'test.helper');
    mock.mockClear();

    await dispatchChannelAgentTurns(deps, T, ch.conversationId, 'm1', 'hello there', 'user:poster');

    expect(mock).toHaveBeenCalledTimes(1);
    const input = mock.mock.calls[0]![1];
    expect(input.workflowId).toBe('openwop-app.channel.turn');
    expect(input.configurable).toMatchObject({
      agentId: 'test.helper', task: 'hello there', conversationId: ch.conversationId, credentialRef: 'managed:openwop-free',
    });
    expect(input.metadata?.channel).toMatchObject({
      source: 'channel', channelId: ch.conversationId, triggeringMessageId: 'm1', agentId: 'test.helper',
    });
    // System-fired: no acting user is threaded onto the run.
    expect('actingUserId' in input).toBe(false);
    // ADR 0832 D3 — the poster bounds the turn's orgs as a NARROWING subject only.
    expect(input.orgScopeSubject).toBe('user:poster');
  });

  it('does NOT dispatch for a system/agent path (no authorUserId) — the no-loop guard', async () => {
    const ch = await createChannel(T, 'user:owner', { name: 'ai2', visibility: 'public' }, FULL_AUTHORITY);
    await addChannelAgent(T, ch.conversationId, 'user:owner', FULL_AUTHORITY, 'test.helper');
    mock.mockClear();

    await dispatchChannelAgentTurns(deps, T, ch.conversationId, 'm2', 'an agent reply', undefined);

    expect(mock).not.toHaveBeenCalled();
  });

  it('does NOT dispatch when the channel has no agent member', async () => {
    const ch = await createChannel(T, 'user:owner', { name: 'humans-only', visibility: 'public' }, FULL_AUTHORITY);
    mock.mockClear();

    await dispatchChannelAgentTurns(deps, T, ch.conversationId, 'm3', 'hi everyone', 'user:poster');

    expect(mock).not.toHaveBeenCalled();
  });
});
