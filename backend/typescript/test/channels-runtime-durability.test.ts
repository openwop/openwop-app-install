/**
 * CS-WF-1/2 (conversation-stack audit 2026-07-09) — run channel state is a
 * durable write-through cache, mirroring variablesRuntime's ENG-3.
 *
 * Before the fix, `channelsRuntime` was in-memory ONLY (its header claimed the
 * "same persistence posture as variablesRuntime" — stale since ENG-3 made
 * variables durable): a sweeper re-dispatch or a snapshot read on another
 * instance silently lost/omitted channel state. Pins:
 *  - append → persist → (simulated cross-instance) hydrate → snapshot round-trip
 *  - messageId idempotency survives hydration
 *  - clear removes the durable row (tenant-hard-delete cascade parity)
 *  - a live in-memory state is never clobbered by an older durable copy
 *  - the GET /runs/:runId snapshot hydrates channels+variables before
 *    projecting (route-level, in-memory cache wiped between write and read)
 *  - the persist ceiling skips (not corrupts) an oversized state
 *
 * Sabotage-witnessed (wave 26): dropping the kvSet write-through, the hydrate
 * load, the messageId dedupe, the kvDelete in clear, the size ceiling, the
 * `runChannels.has` live-wins guard, or the route's `hydrateRunChannels` each
 * turn the matching case red.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { bareRunId } from './support/bareRunId.js';
import {
  appendChannelMessage, snapshotRunChannels, hydrateRunChannels, clearRunChannels,
  __resetAllRunChannelsForTests, type ConversationMessage,
} from '../src/host/channelsRuntime.js';

let server: http.Server;
let BASE: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const msg = (id: string, content = `content-${id}`): ConversationMessage =>
  ({ messageId: id, role: 'user', content, timestamp: '2026-07-09T00:00:00.000Z' });

// The persist/delete are fire-and-forget (no hook to await); on memory:// they
// complete within a few immediates, so drain instead of sleeping.
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };

const snapIds = (runId: string): string[] | undefined =>
  (snapshotRunChannels(runId)?.messages as ConversationMessage[] | undefined)?.map((m) => m.messageId);
const snapMessages = (runId: string): ConversationMessage[] | undefined =>
  snapshotRunChannels(runId)?.messages as ConversationMessage[] | undefined;

describe('CS-WF-1 — channel state survives a simulated cross-instance hand-off', () => {
  it('append → wipe in-memory → hydrate → snapshot round-trips', async () => {
    appendChannelMessage('run-dur-1', 'messages', msg('m1'));
    appendChannelMessage('run-dur-1', 'messages', msg('m2'));
    await settle();
    __resetAllRunChannelsForTests(); // "the other instance"
    expect(snapshotRunChannels('run-dur-1')).toBeNull();
    await hydrateRunChannels('run-dur-1');
    expect(snapIds('run-dur-1')).toEqual(['m1', 'm2']);
  });

  it('messageId idempotency holds across hydration (no duplicate fold)', async () => {
    appendChannelMessage('run-dur-2', 'messages', msg('a'));
    await settle();
    __resetAllRunChannelsForTests();
    await hydrateRunChannels('run-dur-2');
    appendChannelMessage('run-dur-2', 'messages', msg('a', 'duplicate emission'));
    const messages = snapMessages('run-dur-2');
    expect(messages).toHaveLength(1);
    expect(messages?.[0]?.content).toBe('content-a'); // first write wins
  });

  it('a live in-memory state wins over hydration (no clobber of the executing instance)', async () => {
    appendChannelMessage('run-dur-3', 'messages', msg('x1'));
    await settle(); // durable copy = [x1]
    // An oversized append stays in-memory-only (persist ceiling), so the live
    // state [x1, x2] now DIFFERS from the durable [x1]. (A normal append would
    // write through synchronously on memory://, making live === durable and the
    // guard unobservable — wave 26 probe dur-live-wins proved that vacuous.)
    appendChannelMessage('run-dur-3', 'messages', msg('x2', 'x'.repeat(300 * 1024)));
    await settle();
    await hydrateRunChannels('run-dur-3'); // cache present → no-op
    expect(snapIds('run-dur-3')).toEqual(['x1', 'x2']);
  });

  it('clearRunChannels removes the durable row too (cascade parity)', async () => {
    appendChannelMessage('run-dur-4', 'messages', msg('gone'));
    await settle();
    clearRunChannels('run-dur-4');
    await settle();
    __resetAllRunChannelsForTests();
    await hydrateRunChannels('run-dur-4');
    expect(snapshotRunChannels('run-dur-4')).toBeNull();
  });

  it('the persist ceiling skips an oversized state without corrupting the smaller durable copy', async () => {
    appendChannelMessage('run-dur-5', 'messages', msg('small'));
    await settle();
    appendChannelMessage('run-dur-5', 'messages', msg('huge', 'x'.repeat(300 * 1024)));
    await settle();
    __resetAllRunChannelsForTests();
    await hydrateRunChannels('run-dur-5');
    // The oversized append stayed in-memory-only; the durable copy is the last
    // under-cap state.
    expect(snapIds('run-dur-5')).toEqual(['small']);
  });
});

describe('CS-WF-2 — the run snapshot route hydrates before projecting', () => {
  it('GET /runs/:runId returns channels after the in-memory cache is wiped', async () => {
    // A real run so the route resolves it (conversation gate suspends).
    const workflowId = 'openwop-app.channels.durability-test';
    const registered = await fetch(`${BASE}/host/openwop-app/workflows`, {
      method: 'POST', headers: H, body: JSON.stringify({
        workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.chat.approvalGate', config: { title: 'hold' } }], edges: [],
      }),
    });
    expect(registered.ok, String(registered.status)).toBe(true);
    const create = await fetch(`${BASE}/runs`, {
      method: 'POST', headers: H, body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }),
    });
    expect(create.status).toBe(201);
    const { runId } = await create.json() as { runId: string };
    appendChannelMessage(bareRunId(runId), 'messages', msg('routed'));
    await settle();
    __resetAllRunChannelsForTests(); // snapshot read lands on "another instance"
    const snap = await fetch(`${BASE}/runs/${runId}`, { headers: H });
    expect(snap.status).toBe(200);
    const body = await snap.json() as { channels?: Record<string, ConversationMessage[]> };
    expect(body.channels?.messages?.map((m) => m.messageId)).toEqual(['routed']);
  });
});
