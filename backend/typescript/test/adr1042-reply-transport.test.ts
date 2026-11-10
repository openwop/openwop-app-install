/**
 * ADR 1042 D4 (CHAN-P0-4) — the channel reply transport.
 *
 * Before: `setMessagingTransport`/`sendOutbound` had no production caller, so
 * no answer ever went back to a chat. Now `sendChannelReply` dispatches to a
 * per-provider transport through the connections broker (pinned to the inbound
 * connection, run as the paired owner), to the source chat only, and dedups on
 * (lane, inbound message id) in the ADR 0619 send ledger.
 *
 * The broker is faked at its module boundary (its own guarantees are the
 * brokered-egress suite's); the `{credential}` path guard is exercised on the
 * REAL brokeredFetch at the end.
 *
 * Red when: a transport sends to another chat, drops the connection pin or the
 * owner, uses the wrong auth placement (Telegram path / Discord `Bot`); a
 * repeated inbound id sends twice; a failed send blocks its retry; the relay
 * reply reaches a foreign tenant's device; the broker substitutes a credential
 * outside the URL path or a secret that would change the URL's shape.
 * Sabotage-witnessed 2026-11-03: making the ledger key unique per call (removing
 * only the `priorSend` short-circuit stays green: the reserve CAS still dedups),
 * removing `releaseSend` on failure, dropping `connectionId` from the Telegram
 * call, and removing the `parsed.pathname` check in brokeredFetch each turned
 * exactly their case red.
 * Wave 87: `undici` is mocked to record and refuse every dial, so the placement
 * sabotages (the pathname check, the secret-shape check) dial the mock, never
 * the network; dropping `actingUserId` from the Discord or Slack transport turns
 * its case red (both now assert the broker deps).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface Call { fn: 'fetch' | 'post'; deps: { tenantId: string; actingUserId?: string }; opts: Record<string, unknown> }
const calls: Call[] = [];
let respond: () => { status: number; json: unknown } = () => ({ status: 200, json: {} });

// The REAL broker (the placement case) dials through undici: record every dial and
// throw, so no case can ever reach the network, and a dial is observable.
const dials = vi.hoisted(() => [] as string[]);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: vi.fn(async (url: string | URL) => {
      dials.push(String(url));
      throw new TypeError('dial blocked in test');
    }),
  };
});

vi.mock('../src/host/brokeredEgress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/brokeredEgress.js')>();
  const fake = (fn: 'fetch' | 'post') => vi.fn(async (deps: Call['deps'], opts: Record<string, unknown>) => {
    calls.push({ fn, deps, opts });
    const r = respond();
    return { outcome: 'sent', res: { status: r.status, json: async () => r.json }, provenance: { provider: String(opts.provider), connectionId: 'c', scope: 'user' } };
  });
  return { ...actual, brokeredFetch: fake('fetch'), brokeredPost: fake('post') };
});

const { openSqliteStorage } = await import('../src/storage/sqlite/index.js');
const { initHostExtPersistence, __resetHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
const { sendChannelReply } = await import('../src/features/connections/messagingOutbound.js');
const { registerChannelReplyTransports } = await import('../src/features/channel-ingress/transports.js');
type ChannelReply = import('../src/features/connections/messagingOutbound.js').ChannelReply;

const { configureSecretResolver } = await import('../src/byok/secretResolver.js');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const storage = openSqliteStorage(':memory:');
beforeAll(() => {
  initHostExtPersistence(storage);
  configureSecretResolver({ storage, dataDir: mkdtempSync(join(tmpdir(), 'openwop-c1042-reply-')) });
  registerChannelReplyTransports(storage);
});
afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });
beforeEach(() => { calls.length = 0; dials.length = 0; });

const reply = (over: Partial<ChannelReply>): ChannelReply => ({
  tenantId: 't-reply', lane: { kind: 'connection', connectionId: 'conn:tg', provider: 'telegram' },
  chatId: '42', inboundMessageId: '1001', text: 'Hello back', actingUserId: 'user:owner', ...over,
});

describe('per-provider transports', () => {
  it('telegram: credential in the path, pinned connection, owner, source chat; a repeat is deduped', async () => {
    respond = () => ({ status: 200, json: { ok: true, result: { message_id: 7 } } });
    expect(await sendChannelReply(reply({}))).toMatchObject({ delivered: true, providerRef: '7' });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.deps).toMatchObject({ tenantId: 't-reply', actingUserId: 'user:owner' });
    expect(c.opts).toMatchObject({ provider: 'telegram', url: 'https://api.telegram.org/bot{credential}/sendMessage', credentialInPath: true, connectionId: 'conn:tg', method: 'POST' });
    expect(JSON.parse(String(c.opts.body))).toMatchObject({ chat_id: '42', text: 'Hello back' });
    // The same inbound message settles again: the ledger answers, nothing is sent.
    expect(await sendChannelReply(reply({}))).toMatchObject({ delivered: true, deduped: true });
    expect(calls).toHaveLength(1);
  });

  it('a failed send is not recorded, so its retry sends', async () => {
    respond = () => ({ status: 400, json: { ok: false } });
    expect(await sendChannelReply(reply({ inboundMessageId: '2002' }))).toMatchObject({ delivered: false, reason: 'telegram_rejected_400' });
    respond = () => ({ status: 200, json: { ok: true, result: { message_id: 8 } } });
    expect(await sendChannelReply(reply({ inboundMessageId: '2002' }))).toMatchObject({ delivered: true, providerRef: '8' });
    expect(calls).toHaveLength(2);
  });

  it('discord: Bot auth to the source channel, no mention pings', async () => {
    respond = () => ({ status: 200, json: { id: 'd-1' } });
    const out = await sendChannelReply(reply({ lane: { kind: 'connection', connectionId: 'conn:dc', provider: 'discord' }, chatId: '555', inboundMessageId: 'i-1' }));
    expect(out).toMatchObject({ delivered: true, providerRef: 'd-1' });
    expect(calls[0]!.deps).toMatchObject({ tenantId: 't-reply', actingUserId: 'user:owner' });
    expect(calls[0]!.opts).toMatchObject({ provider: 'discord', url: 'https://discord.com/api/v10/channels/555/messages', authScheme: 'bot', connectionId: 'conn:dc' });
    expect(JSON.parse(String(calls[0]!.opts.body))).toEqual({ content: 'Hello back', allowed_mentions: { parse: [] } });
  });

  it('slack: chat.postMessage in the source thread through the existing adapter, pinned', async () => {
    respond = () => ({ status: 200, json: { ok: true, ts: '171.9' } });
    const out = await sendChannelReply(reply({ lane: { kind: 'connection', connectionId: 'conn:sl', provider: 'slack' }, chatId: 'C1', threadId: '171.1', inboundMessageId: 's-1' }));
    expect(out).toMatchObject({ delivered: true, providerRef: '171.9' });
    expect(calls[0]).toMatchObject({ fn: 'post', deps: { tenantId: 't-reply', actingUserId: 'user:owner' }, opts: { provider: 'slack', connectionId: 'conn:sl' } });
    expect(JSON.parse(String(calls[0]!.opts.body))).toMatchObject({ channel: 'C1', text: 'Hello back', thread_ts: '171.1' });
  });

  it('relay: queued to the originating device; never to another tenant\'s device', async () => {
    const now = new Date().toISOString();
    await storage.upsertRelayDevice({ relayId: 'relay_mine', tenantId: 't-reply', channel: 'signal', status: 'active', registeredAt: now });
    await storage.upsertRelayDevice({ relayId: 'relay_theirs', tenantId: 't-other', channel: 'signal', status: 'active', registeredAt: now });
    const lane = (relayId: string) => ({ kind: 'relay' as const, relayId, channel: 'signal' });
    expect(await sendChannelReply(reply({ lane: lane('relay_mine'), chatId: '+15550001', inboundMessageId: 'r-1' }))).toMatchObject({ delivered: true });
    expect((await storage.listRelayOutbound('relay_mine', 10)).map((m) => [m.conversationId, m.text, m.replyToMessageId])).toEqual([['+15550001', 'Hello back', 'r-1']]);
    expect(await sendChannelReply(reply({ lane: lane('relay_theirs'), chatId: '+15550001', inboundMessageId: 'r-2' }))).toMatchObject({ delivered: false, reason: 'relay_unavailable' });
    expect(await storage.listRelayOutbound('relay_theirs', 10)).toEqual([]);
  });

  it('a provider with no transport is a typed no-op', async () => {
    expect(await sendChannelReply(reply({ lane: { kind: 'connection', connectionId: 'c', provider: 'zoom-webinar' }, inboundMessageId: 'z' }))).toEqual({ delivered: false, reason: 'no_transport' });
  });
});

describe('brokeredFetch {credential} placement (the real broker)', () => {
  it('refuses a placeholder outside the path and a secret that would reshape the URL', async () => {
    const real = await vi.importActual<typeof import('../src/host/brokeredEgress.js')>('../src/host/brokeredEgress.js');
    const { createSecretConnection } = await import('../src/features/connections/connectionsService.js');
    const ok = await createSecretConnection({ tenantId: 't-bf', provider: 'telegram', kind: 'bearer', secret: '1:abc', scope: 'user', userId: 'user:bf' });
    const bad = await createSecretConnection({ tenantId: 't-bf2', provider: 'telegram', kind: 'bearer', secret: '1:abc/../x', scope: 'user', userId: 'user:bf2' });
    const deps = (tenantId: string, actingUserId: string) => ({ tenantId, actingUserId });
    // Non-vacuity: both credentials DO resolve, so a `no_connection` below is the
    // placement guard, not a missing row.
    const { resolveConnectionCredential } = await import('../src/features/connections/connectionsService.js');
    expect(await resolveConnectionCredential({ egress: { url: 'https://api.telegram.org/' }, tenantId: 't-bf', provider: 'telegram', actingUserId: 'user:bf', connectionId: ok.connectionId })).toMatchObject({ secret: '1:abc' });
    expect(await resolveConnectionCredential({ egress: { url: 'https://api.telegram.org/' }, tenantId: 't-bf2', provider: 'telegram', actingUserId: 'user:bf2', connectionId: bad.connectionId })).toMatchObject({ secret: '1:abc/../x' });
    const inQuery = await real.brokeredFetch(deps('t-bf', 'user:bf'), { provider: 'telegram', url: 'https://api.telegram.org/sendMessage?token=%7Bcredential%7D', method: 'POST', body: '{}', credentialInPath: true, connectionId: ok.connectionId });
    expect(inQuery.outcome).toBe('no_connection');
    const reshaping = await real.brokeredFetch(deps('t-bf2', 'user:bf2'), { provider: 'telegram', url: 'https://api.telegram.org/bot{credential}/sendMessage', method: 'POST', body: '{}', credentialInPath: true, connectionId: bad.connectionId });
    expect(reshaping.outcome).toBe('no_connection');
    // Neither refusal dialled anything.
    expect(dials).toEqual([]);
    // Positive control: a well-formed path placeholder IS dialled, with the secret
    // substituted into the path only (the mocked dial then fails).
    const good = await real.brokeredFetch(deps('t-bf', 'user:bf'), { provider: 'telegram', url: 'https://api.telegram.org/bot{credential}/sendMessage', method: 'POST', body: '{}', credentialInPath: true, connectionId: ok.connectionId });
    expect(good.outcome).toBe('request_failed');
    expect(dials).toEqual(['https://api.telegram.org/bot1:abc/sendMessage']);
  });
});
