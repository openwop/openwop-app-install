/**
 * ADR 1042 D1 (CHAN-P0-1) — Telegram, Discord and WhatsApp-via-Twilio inbound
 * can be configured through the API, not only by writing the store directly.
 *
 * Before: the inbound config took its provider from the connection, and the
 * registry had no `telegram` or `discord`, so neither connection could be
 * created (`connection_provider_unresolved`); a `twilio` connection always
 * configured as inbound SMS, so `whatsapp-twilio` was unreachable.
 *
 * Red when: either registry entry is removed (create 404s); the entries lose
 * their egress pin or gain a consumer node; the inbound route stops honouring
 * `inboundProvider: whatsapp-twilio` on a twilio connection, or starts honouring
 * it on any other provider.
 * Sabotage-witnessed 2026-11-03: deleting the `telegram` entry turned the
 * Telegram case red (404 on create); making `resolveInboundProvider` return the
 * connection provider unconditionally turned the WhatsApp case red; dropping
 * the `connectionProvider === 'twilio'` condition turned the refusal case red.
 * Re-measured in /grade-tests w87 (g2 probes cp-*): renaming either registry
 * entry, `adapterOnly: false` or an extra apiHost on an entry, ignoring
 * `inboundProvider` altogether, and skipping the Telegram secret-token check
 * (the wrong token is then accepted) each turned its case red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootChannelHarness, CONN, field, text, type ChannelHarness } from './support/channelCoreHarness.js';
import { getProvider } from '../src/features/connections/providerRegistry.js';

let h: ChannelHarness;
beforeAll(async () => { h = await bootChannelHarness('c1042p1'); }, 120_000);
afterAll(async () => { await h.close(); });

async function ownedWorkflow(cookie: string): Promise<string> {
  const res = await h.call('/host/openwop-app/workflows', cookie, 'POST', { workflowId: `c1042-wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, nodes: [{ nodeId: 'n', typeId: 'core.noop', config: {} }], edges: [] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return text(field(res.body, 'workflowId'));
}

describe('telegram and discord are configurable providers', () => {
  it('registry entries are governed: adapter-only, no consumer node, pinned egress', () => {
    for (const [id, host] of [['telegram', 'api.telegram.org'], ['discord', 'discord.com']] as const) {
      const p = getProvider(id);
      expect(p, id).toBeTruthy();
      expect(p?.adapterOnly).toBe(true);
      expect(p?.consumerNodes).toEqual([]);
      expect(p?.apiHosts).toEqual([host]);
    }
  });

  it('a Telegram connection is created, its inbound configured, and a signed update is accepted', async () => {
    const editor = await h.editor();
    const created = await h.call(CONN, editor, 'POST', { provider: 'telegram', kind: 'bearer', secret: '123456:ABC-def_ghi' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const connectionId = text(field(created.body, 'connectionId'));
    const workflowId = await ownedWorkflow(editor);
    const secret = 'tg-secret-token-0123456789';
    const put = await h.call(`${CONN}/${encodeURIComponent(connectionId)}/inbound`, editor, 'PUT', { workflowId, signingSecret: secret });
    expect(put.status, JSON.stringify(put.body)).toBe(201);
    expect(field(put.body, 'config', 'provider')).toBe('telegram');

    const ingest = (token: string) => fetch(`${h.base}/host/openwop-app/connections-inbound/${encodeURIComponent(connectionId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': token },
      body: JSON.stringify({ update_id: 9001, message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'hi' } }),
    });
    expect((await ingest('wrong-token-0123456789xx')).status).toBe(401);
    expect((await ingest(secret)).status).toBe(202);
  });

  it('a Discord connection can be created', async () => {
    const editor = await h.editor();
    const created = await h.call(CONN, editor, 'POST', { provider: 'discord', kind: 'bearer', secret: 'discord-bot-token-value' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(field(created.body, 'provider')).toBe('discord');
    // The connection's inbound is the Discord verifier (an app public key as the secret).
    const put = await h.call(`${CONN}/${encodeURIComponent(text(field(created.body, 'connectionId')))}/inbound`, editor, 'PUT', { workflowId: await ownedWorkflow(editor), signingSecret: 'a'.repeat(64) });
    expect(put.status, JSON.stringify(put.body)).toBe(201);
    expect(field(put.body, 'config', 'provider')).toBe('discord');
  });
});

describe('WhatsApp via Twilio rides the twilio connection', () => {
  it('inboundProvider whatsapp-twilio configures WhatsApp; without it the same connection stays SMS', async () => {
    const editor = await h.editor();
    const created = await h.call(CONN, editor, 'POST', { provider: 'twilio', kind: 'basic', secret: 'AC0123456789:authtoken' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = encodeURIComponent(text(field(created.body, 'connectionId')));
    const secret = 'twilio-auth-token-0123456789';

    const sms = await h.call(`${CONN}/${id}/inbound`, editor, 'PUT', { signingSecret: secret });
    expect(sms.status, JSON.stringify(sms.body)).toBe(201);
    expect(field(sms.body, 'config', 'provider')).toBe('twilio');

    const workflowId = await ownedWorkflow(editor);
    const wa = await h.call(`${CONN}/${id}/inbound`, editor, 'PUT', { inboundProvider: 'whatsapp-twilio', workflowId, signingSecret: secret });
    expect(wa.status, JSON.stringify(wa.body)).toBe(201);
    expect(field(wa.body, 'config', 'provider')).toBe('whatsapp-twilio');
    expect(field(wa.body, 'config', 'workflowId')).toBe(workflowId);
  });

  it('no other connection may pick its inbound provider', async () => {
    const editor = await h.editor();
    const created = await h.call(CONN, editor, 'POST', { provider: 'telegram', kind: 'bearer', secret: '654321:XYZ-abc' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = encodeURIComponent(text(field(created.body, 'connectionId')));
    const workflowId = await ownedWorkflow(editor);
    const res = await h.call(`${CONN}/${id}/inbound`, editor, 'PUT', { inboundProvider: 'whatsapp-twilio', workflowId, signingSecret: 'x'.repeat(24) });
    expect(res.status).toBe(400);
    expect(field(res.body, 'error')).toBe('validation_error');
    expect(field(res.body, 'details', 'field')).toBe('inboundProvider');
    expect(text(field(res.body, 'message'))).toContain("cannot receive inbound as 'whatsapp-twilio'");
  });
});
