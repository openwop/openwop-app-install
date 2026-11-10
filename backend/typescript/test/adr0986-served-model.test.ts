/**
 * ADR 0986 D1 — what ANSWERED a turn, as each dispatch branch reports it, and the
 * write rules of the attribution store.
 *
 * `dispatchReply` is driven through the real function with only the network, the
 * key and the managed dispatch stubbed:
 *  - managed reports the user-facing TIER with `managed: true` (H1);
 *  - BYOK reports the model it dispatched — after a class bump that fell back, the
 *    SELECTED model, not the bumped one it asked for first.
 * `recordTurnAttribution`:
 *  - writes no mock row unless the mock provider is enabled (H4);
 *  - is create-only, so a fork re-using the source's wire ids cannot replace the
 *    source's rows (code-review H1);
 *  - never throws (a failed write is logged; the turn goes on).
 *
 * Sabotage witnesses (measured wave 77): `dispatchedModel` → `model` in the BYOK return
 * reds the bump case; dropping `managed: true` reds each managed case; removing the
 * mock gate reds the mock case; `put` instead of a create-only CAS reds the fork case;
 * a rethrown write failure, or dropping its log line, reds the never-throws case.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The failed write's log line, observed through the real logger.
const warns = vi.hoisted((): Array<{ msg: string; fields?: Record<string, unknown> }> => []);
vi.mock('../src/observability/logger.js', async (orig) => {
  const actual = await orig<typeof import('../src/observability/logger.js')>();
  return {
    ...actual,
    createLogger: (component: string) => {
      const real = actual.createLogger(component);
      return { ...real, warn: (msg: string, fields?: Record<string, unknown>) => { warns.push({ msg, ...(fields ? { fields } : {}) }); real.warn(msg, fields); } };
    },
  };
});

let failures: Error[] = [];
vi.mock('../src/providers/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/dispatch.js')>();
  return {
    ...actual,
    dispatchChat: vi.fn(async () => {
      const next = failures.shift();
      if (next) throw next;
      return { completion: 'answered', usage: { inputTokens: 1, outputTokens: 1 } };
    }),
  };
});
vi.mock('../src/byok/secretResolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/byok/secretResolver.js')>();
  return { ...actual, resolveSecret: vi.fn(async () => 'test-key') };
});
vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return {
    ...actual,
    dispatchManagedChat: vi.fn(async () => ({ provider: 'openwop-free', model: 'openwop-free', completion: 'managed answer' })),
    dispatchManagedToolsRound: vi.fn(async () => ({ text: 'tool-loop answer', toolUses: [] })),
  };
});

import { dispatchChat } from '../src/providers/dispatch.js';
import { dispatchReply } from '../src/host/exchange/dispatchTurn.js';
import { runConversationAgentToolTurn } from '../src/host/conversationToolLoop.js';
import type { ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';
import { recordTurnAttribution, getTurnAttribution } from '../src/host/turnAttribution.js';
import { conversationMessageId } from '../src/host/conversationMessageId.js';
import { getClassDefault } from '../src/providers/catalog.js';
import type { RunRecord } from '../src/types.js';

const run = (inputs: Record<string, unknown>): RunRecord => ({
  runId: 'r-served', workflowId: 'wf', tenantId: 'tenant-served', status: 'running', inputs, metadata: {}, configurable: {},
  createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
});

let saved: Record<string, string | undefined> = {};
let reset: () => void = () => {};
beforeAll(async () => {
  saved = { retry: process.env.OPENWOP_PROVIDER_429_RETRY_MS, mock: process.env.OPENWOP_MOCK_PROVIDER_ENABLED };
  process.env.OPENWOP_PROVIDER_429_RETRY_MS = '1';
  const { initHostExtPersistence, __resetHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
  const { openStorage } = await import('../src/storage/index.js');
  initHostExtPersistence(await openStorage('memory://'));
  reset = __resetHostExtPersistence;
});
afterAll(() => {
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  restore('OPENWOP_PROVIDER_429_RETRY_MS', saved.retry);
  restore('OPENWOP_MOCK_PROVIDER_ENABLED', saved.mock);
  reset();
});

describe('dispatchReply reports what answered', () => {
  it('managed: the user-facing tier, marked managed', async () => {
    const out = await dispatchReply(run({ credentialRef: 'managed:openwop-free' }), [{ role: 'user', content: 'hi' }]);
    expect(out.served).toEqual({ provider: 'openwop-free', model: 'openwop-free', managed: true });
  });

  it('BYOK: the model that answered after a class bump fell back, not the bumped one', async () => {
    const bumped = getClassDefault('google', 'reasoning');
    expect(bumped, 'precondition: google has a reasoning class default').toBeTruthy();
    const selected = 'gemini-selected-lite'; // the tenant's own pick, which the bump moves off
    expect(bumped).not.toBe(selected);
    failures = [new Error('google_429: quota'), new Error('google_429: quota')]; // the bump + its one retry
    vi.mocked(dispatchChat).mockClear();
    const out = await dispatchReply(
      run({ provider: 'google', model: selected, credentialRef: 'byok:google' }),
      [{ role: 'user', content: 'hi' }], undefined, undefined, undefined,
      { conversationType: 'group', agentModelClass: 'reasoning' },
    );
    expect(out.served).toEqual({ provider: 'google', model: selected });
    // The bump really ran: asked for twice, then the selection answered.
    expect(failures).toEqual([]);
    expect(vi.mocked(dispatchChat).mock.calls.map(([req]) => req.model)).toEqual([bumped, bumped, selected]);
  });
});

describe('the tool loop reports what answered', () => {
  const agent: ResolvedAgentManifest = { agentId: 'a', persona: 'P', modelClass: 'general', systemPrompt: 'sp', packName: 'test.s986', packVersion: '0.0.1', toolAllowlist: [] };
  const policyResolver: ProviderPolicyResolver = { async resolveForRun() { return []; } };
  it('managed: the tier, marked managed — the same row the single completion lands on', async () => {
    const out = await runConversationAgentToolTurn({
      run: run({ credentialRef: 'managed:openwop-free' }),
      agent,
      systemPrompt: 'sp', history: [], runId: 'r-served', nodeId: 'n', conversationId: 'c',
      policyResolver,
    });
    expect(out?.text).toBe('tool-loop answer');
    expect(out?.served).toEqual({ provider: 'openwop-free', model: 'openwop-free', managed: true });
  });
});

describe('recordTurnAttribution', () => {
  const T = 'tenant-attr';
  it('writes no mock row unless the mock provider is enabled', async () => {
    try {
      process.env.OPENWOP_MOCK_PROVIDER_ENABLED = 'false';
      await recordTurnAttribution({ tenantId: T, wireMessageId: 'run-m:gate:0:2:agent', runId: 'run-m', served: { provider: 'mock', model: 'm' } });
      expect(await getTurnAttribution(T, conversationMessageId('run-m:gate:0:2:agent'))).toBeNull();
      process.env.OPENWOP_MOCK_PROVIDER_ENABLED = 'true';
      await recordTurnAttribution({ tenantId: T, wireMessageId: 'run-m:gate:0:2:agent', runId: 'run-m', served: { provider: 'mock', model: 'm' } });
      expect(await getTurnAttribution(T, conversationMessageId('run-m:gate:0:2:agent'))).toMatchObject({ provider: 'mock', runId: 'run-m' });
    } finally {
      if (saved.mock === undefined) delete process.env.OPENWOP_MOCK_PROVIDER_ENABLED; else process.env.OPENWOP_MOCK_PROVIDER_ENABLED = saved.mock;
    }
  });

  it('never throws: a failed write is logged and the turn it describes goes on', async () => {
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const spy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockRejectedValueOnce(new Error('db down'));
    try {
      await expect(recordTurnAttribution({ tenantId: T, wireMessageId: 'run-f:gate:0:2:agent', runId: 'run-f', served: { provider: 'openai', model: 'x' } })).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
    expect(warns.find((w) => w.msg === 'turn_attribution_write_failed')?.fields).toMatchObject({ runId: 'run-f', error: 'db down' });
    expect(await getTurnAttribution(T, conversationMessageId('run-f:gate:0:2:agent'))).toBeNull();
  });

  it('is create-only: a fork writing the source\'s wire id cannot replace the source\'s row', async () => {
    const wire = 'run-src:gate:0:4:agent'; // a fork keeps the source's conversation id
    await recordTurnAttribution({ tenantId: T, wireMessageId: wire, runId: 'run-src', chatSessionId: 's', served: { provider: 'openai', model: 'gpt-a' } });
    await recordTurnAttribution({ tenantId: T, wireMessageId: wire, runId: 'run-fork', chatSessionId: 's', served: { provider: 'google', model: 'gemini-b' } });
    expect(await getTurnAttribution(T, conversationMessageId(wire))).toMatchObject({ runId: 'run-src', model: 'gpt-a' });
  });
});
