/**
 * ADR 1042 CHAN-P0-8 — what the channels settings page needs that the channel
 * core did not expose:
 *
 *  1. `GET /connections/:id/senders` marks each approval `mine` when the caller
 *     is its owner (the one person `PUT …/self` lets mark it), so the page shows
 *     the "this is me" control only to that person without guessing who the
 *     caller is.
 *  2. `GET /messaging/relay/devices` lists the workspace's relay devices with
 *     their owner and online state, under the SAME tenant predicate as
 *     `relay/revoke`, never a secret, and the owner's own platform account only
 *     to that owner.
 *  3. `DELETE /connections/:id/senders/:senderId/pending` denies a pending
 *     request (removes it; the sender stays blocked), under the same gates as
 *     revoke.
 *
 * Red when: `mine` is true for someone other than the approver; a deny is open
 * to someone who cannot manage the connection, or approves; the device list
 * leaks another workspace's device, a token hash or an activation code, or shows
 * the owner's account id to a different member.
 * Sabotage-witnessed 2026-11-03 (each turned its own case red; restored, all green):
 * `mine: true` for every row; dropping the `ownedByCaller` guard on `accountId`;
 * listing devices for a fixed `'default'` tenant; and a deny that also approves.
 * Re-measured in /grade-tests w87 (g2 probes sr-*): the above, plus a deny that
 * skips `managedConnection`'s manage check, a deny that removes nothing, a row
 * spreading the device record (secrets), `online: true` before any heartbeat,
 * and dropping the storage `tenant_id` filter on `listRelayDevices` (only the
 * outsider assertion catches that one; the fixed-tenant sabotage reds on the
 * editor's own lookup first) each turned its case red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootChannelHarness, CONN, field, text, type ChannelHarness } from './support/channelCoreHarness.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { approveSender, recordPendingSender } from '../src/features/channel-ingress/stores.js';

let h: ChannelHarness;
async function setToggle(status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault('channel-ingress');
  expect(d).toBeTruthy();
  await saveConfig({ ...d!, status }, 'test');
}
beforeAll(async () => { h = await bootChannelHarness('c1042p8'); await setToggle('on'); }, 120_000);
afterAll(async () => { await setToggle('off'); await h.close(); });

const M = '/host/openwop-app/messaging';
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

describe('GET /connections/:id/senders — `mine`', () => {
  it('is true only for the caller who approved the sender', async () => {
    const editor = await h.editor();
    const created = await h.call(CONN, editor, 'POST', { provider: 'telegram', kind: 'bearer', secret: '77:tok' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const raw = text(field(created.body, 'connectionId'));
    const id = encodeURIComponent(raw);
    expect((await h.call(`${CONN}/${id}/senders`, editor, 'POST', { senderId: '111' })).status).toBe(201);
    // A second approval on the same lane, owned by someone else (the store seam, as
    // the other adr1042 files do: editor2 cannot manage the editor's own connection).
    await approveSender({ tenantId: h.ws, laneKey: `conn:${raw}`, senderId: '222', ownerUserId: h.editor2UserId });

    const rows = list(field((await h.call(`${CONN}/${id}/senders`, editor)).body, 'approved'));
    const mineOf = new Map(rows.map((s) => [field(s, 'senderId'), field(s, 'mine')]));
    expect(Object.fromEntries(mineOf)).toEqual({ 111: true, 222: false });
    // The self route agrees with the flag: the caller may mark only the row that is `mine`.
    expect((await h.call(`${CONN}/${id}/senders/222/self`, editor, 'PUT', { self: true })).status).toBe(403);
    expect((await h.call(`${CONN}/${id}/senders/111/self`, editor, 'PUT', { self: true })).status).toBe(200);
  });
});

describe('DELETE /connections/:id/senders/:senderId/pending — deny', () => {
  it('removes the request for someone who manages the connection with a workspace write, and approves nobody', async () => {
    const editor = await h.editor();
    const created = await h.call(CONN, editor, 'POST', { provider: 'telegram', kind: 'bearer', secret: '78:tok' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const raw = text(field(created.body, 'connectionId'));
    const id = encodeURIComponent(raw);
    await recordPendingSender({ tenantId: h.ws, laneKey: `conn:${raw}`, senderId: '333', chatId: '333' });
    await recordPendingSender({ tenantId: h.ws, laneKey: `conn:${raw}`, senderId: 'group:-100', chatId: '-100' });
    const pendingIds = async (): Promise<unknown[]> => list(field((await h.call(`${CONN}/${id}/senders`, editor)).body, 'pending')).map((p) => field(p, 'senderId')).sort();
    expect(await pendingIds()).toEqual(['333', 'group:-100']);

    // Someone who cannot manage this (personal) connection cannot deny on it.
    const stranger = await h.call(`${CONN}/${id}/senders/333/pending`, await h.editor2(), 'DELETE');
    expect(stranger.status, JSON.stringify(stranger.body)).toBe(403);
    expect(field(stranger.body, 'message')).toBe('Only the connecting user may manage this connection.');
    expect(await pendingIds()).toEqual(['333', 'group:-100']);

    expect((await h.call(`${CONN}/${id}/senders/${encodeURIComponent('group:-100')}/pending`, editor, 'DELETE')).status).toBe(204);
    expect(await pendingIds()).toEqual(['333']);
    // Denying is not approving: the group is still blocked.
    expect(field((await h.call(`${CONN}/${id}/senders`, editor)).body, 'approved')).toEqual([]);
  });
});

describe('GET /messaging/relay/devices', () => {
  it('lists this workspace\'s devices with owner and online state, no secrets, account id only to its owner', async () => {
    const editor = await h.editor();
    const reg = await h.call(`${M}/relay/register`, editor, 'POST', { channel: 'signal', deviceName: 'Desk phone', accountId: '+15550004321' });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const relayId = text(field(reg.body, 'relayId'));
    const act = await h.call(`${M}/relay/activate`, editor, 'POST', { relayId, activationCode: field(reg.body, 'activationCode') });
    expect(act.status).toBe(200);
    // Not online until it heartbeats.
    const before = list(field((await h.call(`${M}/relay/devices`, editor)).body, 'devices')).find((d) => field(d, 'relayId') === relayId);
    expect(field(before, 'online')).toBe(false);
    const hb = await fetch(`${h.base}${M}/device/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-openwop-device-token': text(field(act.body, 'deviceToken')) }, body: '{}' });
    expect(hb.status).toBe(200);

    const mine = await h.call(`${M}/relay/devices`, editor);
    expect(mine.status).toBe(200);
    const row = list(field(mine.body, 'devices')).find((d) => field(d, 'relayId') === relayId);
    expect(row).toMatchObject({ relayId, channel: 'signal', deviceName: 'Desk phone', status: 'active', online: true, owner: { userId: h.editorUserId, ownedByCaller: true, accountId: '+15550004321' } });
    expect(typeof field(row, 'lastHeartbeatAt')).toBe('string');
    for (const secret of ['deviceTokenHash', 'activationCode', 'activationExpiresAt', 'tokenExpiresAt']) expect(field(row, secret)).toBeUndefined();

    // Another member sees the device and its owner, never the owner's phone number.
    const seen = list(field((await h.call(`${M}/relay/devices`, await h.editor2())).body, 'devices')).find((d) => field(d, 'relayId') === relayId);
    expect(field(seen, 'owner')).toEqual({ userId: h.editorUserId, ownedByCaller: false });

    // Someone outside the workspace does not see it.
    const outside = await h.call(`${M}/relay/devices`, await h.outsider());
    expect(list(field(outside.body, 'devices')).some((d) => field(d, 'relayId') === relayId)).toBe(false);

    // Revoked through the existing route, it lists as revoked and offline.
    expect((await h.call(`${M}/relay/revoke`, editor, 'POST', { relayId })).status).toBe(200);
    const after = list(field((await h.call(`${M}/relay/devices`, editor)).body, 'devices')).find((d) => field(d, 'relayId') === relayId);
    expect(after).toMatchObject({ status: 'revoked', online: false });
  });
});
