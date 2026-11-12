/**
 * ADR 1043 CHAN-F11 (`RELAY-KILL-SWITCH-1`) — a workspace admin switches ONE relay
 * channel off in a workspace, on the real booted app.
 *
 *  (a) every channel is on by default; any member reads the switch; only a workspace
 *      admin changes it (`relay_admin_required` for an editor); switching one channel
 *      leaves the others on;
 *  (b) inbound on a switched-off channel is acknowledged and dropped
 *      (`channel_disabled`) before admission: an approved peer gets no turn, a
 *      stranger is not recorded as pending, and no delivery-log row is written; a
 *      device of another channel is unaffected;
 *  (c) a switched-off channel pulls nothing (`paused`) and nothing new is queued
 *      (`relay_channel_disabled`); egress already queued waits, and is pulled once
 *      the channel is back on;
 *  (d) the devices listing says which devices are paused (`channelEnabled`);
 *  (e) when the switch cannot be read it fails CLOSED and loses nothing: inbound, the
 *      pull and enqueue answer a retryable 503, and nothing is admitted, pulled or queued.
 *
 * Red when: the switch is not checked on inbound (or only after admission), on the
 * pull, or on enqueue; a non-admin can change it; one channel's switch affects
 * another; switching back on loses the queue; a switch read error admits, pulls or queues anything.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
const { bootChannelHarness, field, text } = await import('./support/channelCoreHarness.js');
const { saveConfig } = await import('../src/host/featureToggles/service.js');
const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
const { listPendingSenders, putChannelSettings } = await import('../src/features/channel-ingress/stores.js');
type Harness = Awaited<ReturnType<typeof bootChannelHarness>>;

const M = '/host/openwop-app/messaging';
let h: Harness;
let admin = '';

async function send(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const res = await fetch(`${h.base}${M}${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as unknown };
}
const asUser = (cookie: string) => ({ cookie });
const enabledOf = (body: unknown, channel: string): unknown =>
  ((field(body, 'channels') ?? []) as unknown[]).map((c) => [field(c, 'channel'), field(c, 'enabled')]).find(([ch]) => ch === channel)?.[1];

async function ownedDevice(cookie: string, channel: string) {
  const reg = await send('/relay/register', { headers: asUser(cookie), body: { channel } });
  const relayId = text(field(reg.body, 'relayId'));
  const act = await send('/relay/activate', { headers: asUser(cookie), body: { relayId, activationCode: field(reg.body, 'activationCode') } });
  expect(act.status).toBe(200);
  await putChannelSettings({ laneKey: `relay:${relayId}`, tenantId: h.ws, provider: 'mock', model: 'mock-1', updatedAt: new Date().toISOString() });
  const token = text(field(act.body, 'deviceToken'));
  let n = 0;
  const inbound = (peerId: string) =>
    send('/device/inbound', { headers: { 'x-openwop-device-token': token }, body: { platformMessageId: `m-${relayId}-${n++}`, conversationId: peerId, peerId, text: 'hello' } });
  const outbound = async () => (await send('/device/outbound', { headers: { 'x-openwop-device-token': token } })).body;
  return { relayId, token, inbound, outbound };
}
const setChannel = (cookie: string, channel: string, enabled: boolean) =>
  send(`/relay/channels/${channel}`, { method: 'PUT', headers: asUser(cookie), body: { enabled } });

beforeAll(async () => {
  h = await bootChannelHarness('c1043ks');
  await saveConfig({ ...getToggleDefault('channel-ingress')!, status: 'on' }, 'test');
  const { createMember } = await import('../src/host/accessControlService.js');
  const { userIdFor } = await import('../src/features/users/usersService.js');
  const adminSubject = 'oidc:c1043ks-admin';
  await createMember({ orgId: h.ws, tenantId: h.ws, displayName: 'Admin', subject: userIdFor(h.ws, adminSubject), roles: ['admin'] });
  const login = await fetch(`${h.base}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: adminSubject, tenantId: h.ws, displayName: 'Admin', sharedWorkspace: true }),
  });
  admin = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}, 120_000);
afterAll(async () => {
  await saveConfig({ ...getToggleDefault('channel-ingress')!, status: 'off' }, 'test');
  await h?.close();
});

describe('(a) the switch: default on, read by members, changed by admins only', () => {
  it('every channel starts on; an editor cannot switch one; an admin switches exactly one', async () => {
    const editor = await h.editor();
    const read = await send('/relay/channels', { headers: asUser(editor) });
    expect(read.status).toBe(200);
    expect(field(read.body, 'canManage')).toBe(false);
    expect(field((await send('/relay/channels', { headers: asUser(admin) })).body, 'canManage')).toBe(true);
    for (const ch of ['whatsapp', 'signal', 'imessage', 'discord']) expect(enabledOf(read.body, ch)).toBe(true);

    const refused = await setChannel(editor, 'signal', false);
    expect(refused.status).toBe(403);
    expect(field(refused.body, 'details', 'reason') ?? field(refused.body, 'error', 'details', 'reason')).toBe('relay_admin_required');
    expect((await setChannel(admin, 'signal', 'off' as unknown as boolean)).status).toBe(400);

    const off = await setChannel(admin, 'signal', false);
    expect(off.status).toBe(200);
    expect(enabledOf(off.body, 'signal')).toBe(false);
    expect(enabledOf(off.body, 'whatsapp')).toBe(true);
    expect(enabledOf((await send('/relay/channels', { headers: asUser(editor) })).body, 'signal')).toBe(false);
    expect((await setChannel(admin, 'signal', true)).status).toBe(200);
  });
});

describe('(b)–(d) a switched-off channel', () => {
  it('drops inbound before admission, pulls nothing, queues nothing, and resumes with its queue intact', async () => {
    const editor = await h.editor();
    const sig = await ownedDevice(editor, 'signal');
    const wa = await ownedDevice(editor, 'whatsapp');
    const PEER = '+15550202020';
    expect((await send(`/relay/${sig.relayId}/senders`, { headers: asUser(editor), body: { senderId: PEER } })).status).toBe(201);
    // Something already queued for the signal device before the switch.
    const queued = await send('/relay/enqueue', { headers: asUser(editor), body: { relayId: sig.relayId, conversationId: PEER, text: 'queued before' } });
    expect(queued.status).toBe(201);

    expect((await setChannel(admin, 'signal', false)).status).toBe(200);
    try {
      // (b) the approved peer gets no turn; a stranger is not recorded; no log row.
      const logsBefore = (await h.storage.listDeliveryLog({ tenantId: h.ws, limit: 1000 })).length;
      expect((await sig.inbound(PEER)).body).toMatchObject({ accepted: false, dropped: 'channel_disabled' });
      expect((await sig.inbound('+15550303030')).body).toMatchObject({ accepted: false, dropped: 'channel_disabled' });
      expect(await listPendingSenders(h.ws, `relay:${sig.relayId}`)).toEqual([]);
      expect((await h.storage.listDeliveryLog({ tenantId: h.ws, limit: 1000 })).length).toBe(logsBefore);
      // Another channel's device is untouched (a stranger there is dropped by admission instead).
      expect(field((await wa.inbound('+15550303030')).body, 'dropped')).not.toBe('channel_disabled');

      // (c) nothing pulled, nothing new queued.
      expect(await sig.outbound()).toMatchObject({ messages: [], paused: 'channel_disabled' });
      const refused = await send('/relay/enqueue', { headers: asUser(editor), body: { relayId: sig.relayId, conversationId: PEER, text: 'during' } });
      expect(refused.status).toBe(409);

      // (d) the listing marks the paused device.
      const devices = (field((await send('/relay/devices', { headers: asUser(editor) })).body, 'devices') ?? []) as unknown[];
      const byId = new Map(devices.map((d) => [text(field(d, 'relayId')), field(d, 'channelEnabled')]));
      expect(byId.get(sig.relayId)).toBe(false);
      expect(byId.get(wa.relayId)).toBe(true);
    } finally {
      expect((await setChannel(admin, 'signal', true)).status).toBe(200);
    }
    // Back on: the egress queued before the switch is pulled; the refused one never existed.
    const texts = ((field(await sig.outbound(), 'messages') ?? []) as unknown[]).map((m) => text(field(m, 'text')));
    expect(texts).toEqual(['queued before']);
  });
});

describe('(e) an unreadable switch fails closed and loses nothing', () => {
  it('answers a retryable 503 on inbound, pull and enqueue while the read fails', async () => {
    const editor = await h.editor();
    const dev = await ownedDevice(editor, 'discord');
    const PEER = 'peer-e-1';
    expect((await send(`/relay/${dev.relayId}/senders`, { headers: asUser(editor), body: { senderId: PEER } })).status).toBe(201);
    const logsBefore = (await h.storage.listDeliveryLog({ tenantId: h.ws, limit: 1000 })).length;
    const realGet = h.storage.kvGet.bind(h.storage);
    const spy = vi.spyOn(h.storage, 'kvGet').mockImplementation(async (key: string) => {
      if (key.startsWith('hostext:messaging:relay-channel-switch:')) throw new Error('storage blip');
      return realGet(key);
    });
    try {
      const inbound = await dev.inbound(PEER);
      expect(inbound.status).toBe(503);
      expect(JSON.stringify(inbound.body)).toContain('service_unavailable');
      expect((await send('/device/outbound', { headers: { 'x-openwop-device-token': dev.token } })).status).toBe(503);
      expect((await send('/relay/enqueue', { headers: asUser(editor), body: { relayId: dev.relayId, conversationId: PEER, text: 'during blip' } })).status).toBe(503);
      expect((await h.storage.listDeliveryLog({ tenantId: h.ws, limit: 1000 })).length).toBe(logsBefore);
    } finally {
      spy.mockRestore();
    }
    // Read works again: nothing was queued during the blip.
    expect(field(await dev.outbound(), 'messages')).toEqual([]);
  });
});
