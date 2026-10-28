/**
 * ADR 0769 — `ctx.messaging.dispatchEgressEnvelope`: the relay chat-egress
 * surface the `vendor.myndhyve.entities` messaging nodes call. Driven through
 * the REAL pack functions (`messaging.chatSend` / `messaging.chatReply`), so the
 * envelope shape under test is the one the pack actually builds.
 *
 * Pinned: tenant binding (a foreign relay fails exactly like a missing one),
 * revoked + channel-mismatch refusals, the envelope → relay mapping (media,
 * inReplyTo), and the host-derived dedup key — the pack's own key embeds
 * `Date.now()`, so a retry of the same (run, node, content) must still enqueue
 * once, while a different run enqueues again.
 *
 * Red when (wave 60 probes, tracker TST-BRB-1): the device tenant check, the revoked
 * or channel refusal is dropped; the host key gains the clock, loses the run or the
 * text; `inReplyTo` is not mapped; a url-only media item is dropped; or the composed
 * adapter loses its SMS half.
 *
 * Double guard, recorded: a retry is deduplicated by `priorSend` (the fast path) AND
 * by `reserveSend` answering `duplicate` (the winner path, `chatEgressAdapter.ts`);
 * dropping either alone stays green, dropping both reds the retry case.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeMessagingAdapter } from '../src/host/chatEgressAdapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
type Ctx = Record<string, unknown>;
type NodeFn = (ctx: Ctx) => Promise<{ outputs: Record<string, unknown> }>;
let pack: { chatSend: NodeFn; chatReply: NodeFn };
let storage: Storage;

const device = (relayId: string, tenantId: string, extra: Record<string, unknown> = {}) => ({
  relayId, tenantId, channel: 'whatsapp' as const, status: 'active' as const, registeredAt: new Date().toISOString(), ...extra,
});

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  pack = (await import(pathToFileURL(join(HERE, '..', '..', '..', 'packs', 'vendor.myndhyve.entities', 'index.mjs')).href)) as typeof pack;
  await storage.upsertRelayDevice(device('rly_a', 'ten-a'));
  await storage.upsertRelayDevice(device('rly_b', 'ten-b'));
  await storage.upsertRelayDevice(device('rly_rev', 'ten-a', { status: 'revoked' }));
});

const ctxFor = (tenantId: string, runId: string, extra: Ctx = {}): Ctx => ({
  runId, nodeId: 'send-1',
  messaging: makeMessagingAdapter({ storage, tenantId, runId }),
  ...extra,
});
const send = (tenantId: string, runId: string, inputs: Ctx) =>
  pack.chatSend(ctxFor(tenantId, runId, { inputs: { channel: 'whatsapp', conversationId: 'conv-1', ...inputs } }));
const queued = async (relayId: string) => storage.listRelayOutbound(relayId, 100);

describe('ADR 0769 — dispatchEgressEnvelope via messaging.chatSend', () => {
  it('enqueues to the tenant\'s own relay and returns the egress id', async () => {
    const before = (await queued('rly_a')).length;
    const { outputs } = await send('ten-a', 'run-1', { connectorInstanceId: 'rly_a', text: 'hello', media: [{ type: 'file', url: 'https://x.test/a.pdf' }] });
    expect(outputs).toMatchObject({ success: true, relayId: 'rly_a' });
    const q = await queued('rly_a');
    expect(q.length).toBe(before + 1);
    const egress = q.find((e) => e.egressId === outputs.messageId)!;
    expect(egress).toMatchObject({ channel: 'whatsapp', conversationId: 'conv-1', text: 'hello', media: [{ url: 'https://x.test/a.pdf' }] });
  });

  it('a retry of the same (run, node, content) enqueues ONCE despite the pack\'s Date.now key', async () => {
    const before = (await queued('rly_a')).length;
    // Fake only Date: the pack's own key embeds Date.now(), so the second send carries
    // a DIFFERENT pack key one second later; the host-derived key must not move.
    vi.useFakeTimers({ toFake: ['Date'] });
    let first: Awaited<ReturnType<typeof send>>;
    let second: Awaited<ReturnType<typeof send>>;
    try {
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      first = await send('ten-a', 'run-retry', { connectorInstanceId: 'rly_a', text: 'once' });
      vi.setSystemTime(new Date('2026-06-01T12:00:01.000Z'));
      second = await send('ten-a', 'run-retry', { connectorInstanceId: 'rly_a', text: 'once' });
    } finally {
      vi.useRealTimers();
    }
    expect(second.outputs).toMatchObject({ success: true, messageId: first.outputs.messageId, deduplicated: true });
    expect((await queued('rly_a')).length).toBe(before + 1);
  });

  it('a different run, or different content, is a different send', async () => {
    const before = (await queued('rly_a')).length;
    await send('ten-a', 'run-x', { connectorInstanceId: 'rly_a', text: 'same' });
    await send('ten-a', 'run-y', { connectorInstanceId: 'rly_a', text: 'same' });
    await send('ten-a', 'run-y', { connectorInstanceId: 'rly_a', text: 'different' });
    expect((await queued('rly_a')).length).toBe(before + 3);
  });

  it('another tenant\'s relay fails exactly like a missing one (no existence leak)', async () => {
    const before = (await queued('rly_b')).length;
    const foreign = await send('ten-a', 'run-2', { connectorInstanceId: 'rly_b', text: 'hi' });
    const missing = await send('ten-a', 'run-2', { connectorInstanceId: 'rly_nope', text: 'hi' });
    expect(foreign.outputs).toEqual({ success: false, error: 'connector_not_found' });
    expect(missing.outputs).toEqual(foreign.outputs);
    expect((await queued('rly_b')).length).toBe(before);
  });

  it('refuses a revoked relay and a channel the relay does not carry', async () => {
    expect((await send('ten-a', 'run-3', { connectorInstanceId: 'rly_rev', text: 'hi' })).outputs).toEqual({ success: false, error: 'connector_revoked' });
    expect((await send('ten-a', 'run-3', { connectorInstanceId: 'rly_a', text: 'hi', channel: 'signal' })).outputs).toEqual({ success: false, error: 'channel_mismatch' });
  });
});

describe('ADR 0769 — the envelope → relay media mapping', () => {
  it('a media item that carries only `url` (no `ref`) is enqueued with that url', async () => {
    const m = makeMessagingAdapter({ storage, tenantId: 'ten-a', runId: 'run-media-url' });
    const out = await m.dispatchEgressEnvelope({
      connectorInstanceId: 'rly_a', nodeId: 'send-media',
      envelope: { channel: 'whatsapp', delivery: { conversationId: 'conv-media' }, content: { text: 'see attached', media: [{ url: 'https://x.test/only-url.png' }] } },
    });
    expect(out).toMatchObject({ success: true, relayId: 'rly_a' });
    const egress = (await queued('rly_a')).find((e) => e.egressId === out.messageId);
    expect(egress, 'the enqueued envelope').toBeDefined();
    expect(egress!.media).toEqual([{ url: 'https://x.test/only-url.png' }]);
  });
});

describe('ADR 0769 — messaging.chatReply threads onto the ingress message', () => {
  it('maps delivery.inReplyTo to replyToMessageId and uses the ingress channel', async () => {
    const ingress = { channel: 'whatsapp', messageId: 'wamid-9', delivery: { conversationId: 'conv-r' } };
    const { outputs } = await pack.chatReply(ctxFor('ten-a', 'run-reply', {
      inputs: { text: 'thanks' }, config: { connectorInstanceId: 'rly_a' },
      variables: { get: (k: string) => (k === '_ingressEnvelope' ? ingress : undefined) },
    }));
    expect(outputs).toMatchObject({ success: true });
    const egress = (await queued('rly_a')).find((e) => e.egressId === outputs.messageId)!;
    expect(egress).toMatchObject({ conversationId: 'conv-r', text: 'thanks', replyToMessageId: 'wamid-9' });
  });
});

describe('ADR 0769 — ctx.messaging keeps its SMS half', () => {
  it('the composed adapter exposes both sendSms and dispatchEgressEnvelope', () => {
    const m = makeMessagingAdapter({ storage, tenantId: 'ten-a', runId: 'r' });
    expect(typeof m.sendSms).toBe('function');
    expect(typeof m.dispatchEgressEnvelope).toBe('function');
  });
});
