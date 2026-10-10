/**
 * ADR 0821 D4 (corrected by architect #2) / P1 — per-feature attribution of
 * managed (platform-paid) AI spend.
 *
 * Pins:
 *   1. a managed call that names a feature lands one row on
 *      `(tenant, UTC day, featureId)`, and the CAP ROW is unchanged in shape
 *      (still keyed `(bucket, provider, date)` with the same figure);
 *   2. a call that names none but serves a run is attributed from the run's
 *      starter block (`scheduled-agent-chat` → `scheduled-agent-chats`);
 *   3. a call with neither lands on `unattributed` (visible, not folded into chat);
 *   4. an attribution WRITE FAILURE never fails the call (best-effort);
 *   5. the tool-owner derivation recognises both live tool-id shapes and never
 *      mistakes a core namespace for a feature;
 *   6. a plain chat turn (`dispatchReply`) is attributed to `chat`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { resetCachedMasterKey } from '../src/byok/encryption.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  _clearManagedCacheForTests, bootstrapManagedProvider, configureManagedProvider, dispatchManagedChat,
} from '../src/providers/managedProvider.js';
import {
  featureForRunMetadata, featureForToolName, listFeatureSpendForDay, listFeatureSpendForTenant, normalizeFeatureId,
} from '../src/host/managedCredits.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { dispatchReply } from '../src/host/exchange/dispatchTurn.js';

let storage: Storage;
const today = () => new Date().toISOString().slice(0, 10);

function mockMiniMaxSseOnce(completion: string, inputTokens: number, outputTokens: number): void {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: completion } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const body = new ReadableStream<Uint8Array>({
    start(c) { const enc = new TextEncoder(); for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); },
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
}

beforeAll(() => {
  process.env.OPENWOP_BYOK_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.OPENWOP_MANAGED_DAILY_TOKEN_CAP = '1000000';
});

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  configureManagedProvider({ storage, dataDir: '/tmp/openwop-managed-attr-test' });
  _clearManagedCacheForTests();
  resetCachedMasterKey();
  process.env.MINIMAX_API_KEY = 'sk-attr';
  await bootstrapManagedProvider();
});

afterEach(async () => {
  vi.restoreAllMocks();
  __resetHostExtPersistence();
  await storage.close();
  delete process.env.MINIMAX_API_KEY;
});

describe('ADR 0821 D4 — managed spend is attributed per (tenant, day, feature)', () => {
  it('an explicit featureId lands one row; the cap row keeps its key and its figure', async () => {
    mockMiniMaxSseOnce('ok', 30, 12);
    await dispatchManagedChat({ userFacingProvider: 'openwop-free', tenantId: 'user:attr-a', featureId: 'cms', messages: [{ role: 'user', content: 'hi' }] });

    const rows = await listFeatureSpendForTenant('user:attr-a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: 'user:attr-a', day: today(), featureId: 'cms', inputTokens: 30, outputTokens: 12, calls: 1 });
    // Architect #2: the hot cap row is untouched in shape — still read by
    // (bucket, provider, date) and still carrying the full figure.
    expect(await storage.getManagedUsage('user:attr-a', 'openwop-free', today())).toEqual({ inputTokens: 30, outputTokens: 12 });
  });

  it('folds repeated calls (CAS) and keeps features apart', async () => {
    mockMiniMaxSseOnce('a', 10, 1);
    await dispatchManagedChat({ userFacingProvider: 'openwop-free', tenantId: 'user:attr-b', featureId: 'chat', messages: [{ role: 'user', content: 'x' }] });
    mockMiniMaxSseOnce('b', 20, 2);
    await dispatchManagedChat({ userFacingProvider: 'openwop-free', tenantId: 'user:attr-b', featureId: 'chat', messages: [{ role: 'user', content: 'y' }] });
    mockMiniMaxSseOnce('c', 5, 5);
    await dispatchManagedChat({ userFacingProvider: 'openwop-free', tenantId: 'user:attr-b', featureId: 'chat-widget', messages: [{ role: 'user', content: 'z' }] });

    const rows = await listFeatureSpendForTenant('user:attr-b');
    expect(rows.find((r) => r.featureId === 'chat')).toMatchObject({ inputTokens: 30, outputTokens: 3, calls: 2 });
    expect(rows.find((r) => r.featureId === 'chat-widget')).toMatchObject({ inputTokens: 5, outputTokens: 5, calls: 1 });
    // The operator's day read sees both tenants' rows for the day.
    const day = await listFeatureSpendForDay(today());
    expect(day.filter((r) => r.tenantId === 'user:attr-b').map((r) => r.featureId).sort()).toEqual(['chat', 'chat-widget']);
  });

  it('a run-scoped call with no featureId is attributed from the run starter block', async () => {
    const run: RunRecord = {
      runId: 'run-sched-1', workflowId: 'wf-sched', tenantId: 'user:attr-c', status: 'running', inputs: null,
      metadata: { kind: 'scheduled-agent-chat', chatId: 'c1' }, configurable: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await storage.insertRun(run);
    mockMiniMaxSseOnce('ok', 7, 7);
    await dispatchManagedChat({ userFacingProvider: 'openwop-free', tenantId: 'user:attr-c', runId: 'run-sched-1', messages: [{ role: 'user', content: 'tick' }] });
    expect((await listFeatureSpendForTenant('user:attr-c')).map((r) => r.featureId)).toEqual(['scheduled-agent-chats']);
  });

  it('a call with neither lands on `unattributed` (visible, never silently `chat`)', async () => {
    mockMiniMaxSseOnce('ok', 3, 3);
    await dispatchManagedChat({ userFacingProvider: 'openwop-free', tenantId: 'user:attr-d', messages: [{ role: 'user', content: '?' }] });
    expect((await listFeatureSpendForTenant('user:attr-d')).map((r) => r.featureId)).toEqual(['unattributed']);
  });

  it('an attribution write failure never fails the managed call (best-effort, after the call)', async () => {
    // No host-ext persistence ⇒ every DurableCollection access throws. The call
    // must still succeed and the cap row must still be charged.
    __resetHostExtPersistence();
    mockMiniMaxSseOnce('still fine', 4, 4);
    const r = await dispatchManagedChat({ userFacingProvider: 'openwop-free', tenantId: 'user:attr-e', featureId: 'chat', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.completion).toBe('still fine');
    expect(await storage.getManagedUsage('user:attr-e', 'openwop-free', today())).toEqual({ inputTokens: 4, outputTokens: 4 });
  });

  it('a plain chat turn (dispatchReply, managed branch) is attributed to `chat`', async () => {
    const run: RunRecord = {
      runId: 'run-chat-1', workflowId: 'wf-chat', tenantId: 'user:attr-f', status: 'running', inputs: { credentialRef: 'managed:openwop-free' },
      metadata: {}, configurable: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    mockMiniMaxSseOnce('hello', 11, 9);
    await dispatchReply(run, [{ role: 'user', content: 'hello?' }]);
    expect((await listFeatureSpendForTenant('user:attr-f')).map((r) => r.featureId)).toEqual(['chat']);
  });
});

describe('ADR 0821 D4 — featureId derivation', () => {
  it('tool ids: `openwop:feature.<f>.*` and a REGISTERED `openwop:<f>.*`; core namespaces are not features', () => {
    registerToggleDefault({ id: 'territories', label: 'Territories', description: 't', status: 'on', bucketUnit: 'tenant', salt: 'territories' });
    expect(featureForToolName('openwop:feature.crm.search-contacts')).toBe('crm');
    expect(featureForToolName('openwop:territories.list-models')).toBe('territories');
    expect(featureForToolName('openwop:knowledge.search')).toBeNull();
    expect(featureForToolName('openwop:core.http')).toBeNull();
    expect(featureForToolName('not-a-tool')).toBeNull();
  });

  it('run metadata: each starter block maps to its feature; an unmarked run is `workflows`', () => {
    expect(featureForRunMetadata({ kind: 'scheduled-agent-chat' })).toBe('scheduled-agent-chats');
    expect(featureForRunMetadata({ chatSessionId: 's1' })).toBe('chat');
    expect(featureForRunMetadata({ heartbeat: { source: 'heartbeat' } })).toBe('heartbeat');
    expect(featureForRunMetadata({ channel: { source: 'channel' } })).toBe('channels');
    expect(featureForRunMetadata({ schedule: { source: 'schedule' } })).toBe('scheduler');
    expect(featureForRunMetadata({})).toBe('workflows');
  });

  it('a feature id that could corrupt the row key is refused to `unattributed`', () => {
    expect(normalizeFeatureId('crm')).toBe('crm');
    expect(normalizeFeatureId('a:b')).toBe('unattributed');
    expect(normalizeFeatureId('')).toBe('unattributed');
  });
});
