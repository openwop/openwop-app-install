/**
 * ADR 1043 D9 (CHAN-P1b, "Per-device, owner approves") — a relay device's peers
 * are approved by the device's OWNER, for that device only, in channel-ingress's
 * sender and pending stores keyed by the device's lane. Over HTTP on the real app.
 *
 * Covered:
 *  - a peer approved on device A is NOT admitted on device B (another member's),
 *    and a tenant-wide relay allowlist row admits nobody in conversation mode;
 *  - only the device's owner approves, denies and sees pending; another member
 *    gets 403 `relay_peers_owner_only` on every route, another tenant 404, and a
 *    workspace admin may list the approved senders (pending hidden) and revoke one,
 *    but not approve;
 *  - a stranger is recorded as pending, dropped `not_paired`, and NOTHING is
 *    queued to them (no pairing prompt from the owner's account);
 *  - the pending cap (100 per lane) and the per-lane record budget (30 a minute) hold;
 *  - (ADR 1042 D12) admission runs BEFORE the device's inbound budget: a flood of
 *    strangers spends none of it, and the hosted lane's group approval needs
 *    `groupAcknowledged` server-side too;
 *  - a group needs `groupAcknowledged: true`, and an approved group is answered
 *    only when it names the assistant;
 *  - the ADR 1042 D8 eraser deletes a relay lane's approvals and pending rows,
 *    for the peer and for the owner.
 *
 * Red when: the relay ingest stops checking approvals or reads another device's
 * lane; the approval's owner is not compared with the device owner; the owner
 * check on the routes is dropped; an admin may approve; a stranger is answered;
 * the cap or the budget is skipped; the group acknowledgement is not required;
 * the eraser skips relay lanes.
 * Double guard (grade-tests w88): admission runs twice through `admitRelayMessage`:
 * once in the route BEFORE the device budget and once again in `ingestRelayMessage`
 * at dispatch. Ignoring the result in only one of them stays green. Breaking the
 * shared `if (!peer.admitted) return peer;` turns cases 1, 2 and 3 and the flood
 * case red.
 * The 30-a-minute case runs with the device limiter OFF. Only the recorder's own
 * budget applies there. The D12 flood case, with the limiter on, witnesses that
 * strangers never spend the device budget.
 * Sabotage-witnessed 2026-11-04 (one at a time, each restored): dropping the
 * approval-owner comparison in `admitRelayPeer` (case 1 red); letting a
 * non-owner through the POST owner check (case 2 red); refusing the admin on
 * revoke (case 2 red); skipping the per-lane eviction in `recordPendingSender`
 * (cap case red); bypassing `pendingRecordAllowed` on the relay path (budget case
 * red); dropping the `groupAcknowledged` check (group case red); making the
 * eraser skip `relay:` lanes (erasure case red). Re-queuing the legacy lane's
 * pairing message turned `messaging-relay-route.test.ts` red.
 * Coordinator follow-up, same day: the device budget taken BEFORE admission again
 * (strangers spend it; budget case red); the hosted POST skipping
 * `requireGroupAcknowledged` (hosted group case red).
 * grade-tests w88 (round 1 + 2): the cap case stamps its rows apart with a faked
 * `Date`, because rows written in one millisecond kept key order. Key order equals
 * age order, so deleting the LRU sort was still green. It now re-touches the oldest
 * row. The admin listing runs while a stranger is still pending. The erasure case
 * asserts its setup landed before it erases.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
const { bootChannelHarness, field, text } = await import('./support/channelCoreHarness.js');
const { saveConfig } = await import('../src/host/featureToggles/service.js');
const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
const { getApprovedSender, listPendingSenders, putChannelSettings, recordPendingSender, PENDING_PER_LANE_CAP } = await import('../src/features/channel-ingress/stores.js');
const { eraseChannelIngressSubject } = await import('../src/features/channel-ingress/erasure.js');
type Harness = Awaited<ReturnType<typeof bootChannelHarness>>;

const M = '/host/openwop-app/messaging';
const OP = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
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
/** The `senderId`s of a listed `approved` / `pending` array (no cast on the untyped body). */
function senderIds(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error(`expected an array, got ${JSON.stringify(v)}`);
  return v.map((e: unknown) => text(field(e, 'senderId')));
}

/** A device registered and activated by `cookie` (its owner), with a mock-model lane. */
async function ownedDevice(cookie: string, accountId?: string) {
  const reg = await send('/relay/register', { headers: asUser(cookie), body: { channel: 'signal', ...(accountId ? { accountId } : {}) } });
  const relayId = text(field(reg.body, 'relayId'));
  const act = await send('/relay/activate', { headers: asUser(cookie), body: { relayId, activationCode: field(reg.body, 'activationCode') } });
  expect(act.status).toBe(200);
  await putChannelSettings({ laneKey: `relay:${relayId}`, tenantId: h.ws, provider: 'mock', model: 'mock-1', updatedAt: new Date().toISOString() });
  const token = text(field(act.body, 'deviceToken'));
  let n = 0;
  const inbound = (peerId: string, extra: Record<string, unknown> = {}) =>
    send('/device/inbound', { headers: { 'x-openwop-device-token': token }, body: { platformMessageId: `m-${relayId}-${n++}`, conversationId: peerId, peerId, text: 'hello', ...extra } });
  const outbound = async () => field((await send('/device/outbound', { headers: { 'x-openwop-device-token': token } })).body, 'messages');
  return { relayId, inbound, outbound, peers: `/relay/${relayId}/senders` };
}

beforeAll(async () => {
  h = await bootChannelHarness('c1043p');
  await saveConfig({ ...getToggleDefault('channel-ingress')!, status: 'on' }, 'test');
  const { createMember } = await import('../src/host/accessControlService.js');
  const { userIdFor } = await import('../src/features/users/usersService.js');
  const adminSubject = 'oidc:c1043p-admin';
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

describe('D9 — a peer is admitted only on the device whose owner approved it', () => {
  it('approved on A is not admitted on B; a tenant-wide allowlist row admits nobody in conversation mode', async () => {
    const a = await ownedDevice(await h.editor());
    const b = await ownedDevice(await h.editor2());
    const PEER = '+15550101010';
    expect((await send(a.peers, { headers: asUser(await h.editor()), body: { senderId: PEER, label: 'Ana' } })).status).toBe(201);

    expect((await a.inbound(PEER)).body).toMatchObject({ accepted: true });
    expect((await b.inbound(PEER)).body).toMatchObject({ accepted: false, dropped: 'not_paired' });
    // B's owner sees the peer as a request on THEIR device; A's lane is untouched.
    expect((await listPendingSenders(h.ws, `relay:${b.relayId}`)).map((p) => p.senderId)).toEqual([PEER]);
    expect(await listPendingSenders(h.ws, `relay:${a.relayId}`)).toEqual([]);

    // The legacy tenant-wide allowlist (an admin's act) does not admit into conversation mode.
    const q = `?tenantId=${h.ws}`;
    const conn = await send(`/connectors${q}`, { headers: OP, body: { channel: 'signal', enabled: true } });
    const connectorId = text(field(conn.body, 'connectorId'));
    await send(`/connectors/${connectorId}/policy${q}`, { method: 'PUT', headers: OP, body: { dmPolicy: 'open', groupPolicy: 'open', requireMention: false } });
    const OTHER = '+15550102020';
    expect((await send(`/allowlist${q}`, { headers: OP, body: { connectorId, channel: 'signal', peerId: OTHER } })).status).toBeLessThan(300);
    expect((await b.inbound(OTHER)).body).toMatchObject({ accepted: false, dropped: 'not_paired' });

    // An approval row whose owner is not the device's owner admits nothing.
    const { approveSender } = await import('../src/features/channel-ingress/stores.js');
    await approveSender({ tenantId: h.ws, laneKey: `relay:${b.relayId}`, senderId: '+15550103030', ownerUserId: h.editorUserId });
    expect((await b.inbound('+15550103030')).body).toMatchObject({ accepted: false, dropped: 'not_paired' });
  }, 60_000);
});

describe('D9 — only the owner manages a device\'s peers; an admin may revoke', () => {
  it('another member is refused everywhere; an admin lists approved only, cannot approve, and can revoke', async () => {
    const owner = await h.editor();
    const member = await h.editor2();
    const d = await ownedDevice(owner);
    const PEER = '+15550201010';
    const STRANGER = '+15550209999';
    await d.inbound(STRANGER);

    // Another member (workspace write, not the owner, not an admin).
    for (const [method, path, body] of [
      ['GET', d.peers, undefined],
      ['POST', d.peers, { senderId: PEER }],
      ['DELETE', `${d.peers}/${encodeURIComponent(STRANGER)}/pending`, undefined],
      ['DELETE', `${d.peers}/${encodeURIComponent(PEER)}`, undefined],
    ] as const) {
      const r = await send(path, { method, headers: asUser(member), ...(body ? { body } : {}) });
      expect([method, path, r.status, field(r.body, 'details', 'reason')]).toEqual([method, path, 403, 'relay_peers_owner_only']);
    }
    expect(await getApprovedSender(`relay:${d.relayId}`, PEER)).toBeNull();
    const foreign = await send(d.peers, { headers: asUser(await h.outsider()) });
    expect([foreign.status, field(foreign.body, 'error'), field(foreign.body, 'message')]).toEqual([404, 'not_found', 'Relay not found.']);

    // An admin who is not the owner cannot approve.
    const adminApprove = await send(d.peers, { headers: asUser(admin), body: { senderId: PEER } });
    expect([adminApprove.status, field(adminApprove.body, 'details', 'reason')]).toEqual([403, 'relay_peers_owner_only']);
    expect(await getApprovedSender(`relay:${d.relayId}`, PEER)).toBeNull();

    // The owner: sees the pending stranger, approves PEER, denies the stranger.
    const mine = await send(d.peers, { headers: asUser(owner) });
    expect(field(mine.body, 'canApprove')).toBe(true);
    expect(senderIds(field(mine.body, 'pending'))).toEqual([STRANGER]);
    expect((await send(d.peers, { headers: asUser(owner), body: { senderId: PEER } })).status).toBe(201);
    expect((await send(`${d.peers}/${encodeURIComponent(STRANGER)}/pending`, { method: 'DELETE', headers: asUser(owner) })).status).toBe(204);
    expect(await listPendingSenders(h.ws, `relay:${d.relayId}`)).toEqual([]);
    expect((await d.inbound(PEER)).body).toMatchObject({ accepted: true });

    // A second stranger is pending WHILE the admin lists, so "pending hidden" is the
    // route's choice, not an empty store (the owner sees it: positive control).
    const STRANGER2 = '+15550208888';
    await d.inbound(STRANGER2);
    expect(senderIds(field((await send(d.peers, { headers: asUser(owner) })).body, 'pending'))).toEqual([STRANGER2]);

    // The admin sees the approved list (pending hidden) and revokes; the peer is dropped again.
    const seen = await send(d.peers, { headers: asUser(admin) });
    expect(seen.status).toBe(200);
    expect(field(seen.body, 'canApprove')).toBe(false);
    expect(field(seen.body, 'pending')).toEqual([]);
    expect(senderIds(field(seen.body, 'approved'))).toEqual([PEER]);
    expect((await send(`${d.peers}/${encodeURIComponent(PEER)}`, { method: 'DELETE', headers: asUser(admin) })).status).toBe(204);
    expect(await getApprovedSender(`relay:${d.relayId}`, PEER)).toBeNull();
    expect((await d.inbound(PEER)).body).toMatchObject({ accepted: false, dropped: 'not_paired' });

    // With the feature off the routes are not there.
    await saveConfig({ ...getToggleDefault('channel-ingress')!, status: 'off' }, 'test');
    try {
      expect((await send(d.peers, { headers: asUser(owner) })).status).toBe(404);
    } finally {
      await saveConfig({ ...getToggleDefault('channel-ingress')!, status: 'on' }, 'test');
    }
  }, 60_000);
});

describe('D9 — strangers are recorded, never answered, and bounded', () => {
  it('no pairing message is queued; a repeat writer is one row with a count', async () => {
    const d = await ownedDevice(await h.editor());
    const STRANGER = '+15550301010';
    expect((await d.inbound(STRANGER)).body).toMatchObject({ accepted: false, dropped: 'not_paired' });
    expect((await d.inbound(STRANGER)).body).toMatchObject({ accepted: false, dropped: 'not_paired' });
    expect(await d.outbound()).toEqual([]);
    const pending = await listPendingSenders(h.ws, `relay:${d.relayId}`);
    expect(pending.map((p) => [p.senderId, p.count])).toEqual([[STRANGER, 2]]);
    const log = await h.storage.listDeliveryLog({ tenantId: h.ws, direction: 'outbound' });
    expect(log.filter((l) => l.relayId === d.relayId)).toEqual([]);
    // Security review of #5573 (C1): an admission drop writes NO delivery-log row,
    // so strangers cannot grow `messaging_delivery_log` with their chat ids.
    // Red when the drop branch appends to the log again.
    const inboundLog = await h.storage.listDeliveryLog({ tenantId: h.ws, direction: 'inbound' });
    expect(inboundLog.filter((l) => l.relayId === d.relayId)).toEqual([]);
  });

  it('the per-lane cap holds at 100, evicting the least recently seen', async () => {
    const d = await ownedDevice(await h.editor());
    const lane = `relay:${d.relayId}`;
    const id = (i: number): string => `+1555040${String(i).padStart(4, '0')}`;
    // Rows written in one millisecond tie on `lastSeenAt`, and the lane lists in key
    // order (= write order here), so the LRU sort could vanish unnoticed. Fake only
    // `Date`, stamp each row a second apart in the past, then re-touch the OLDEST row
    // so key order and recency disagree.
    const t0 = Date.now() - 10 * 60_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let i = 0; i < PENDING_PER_LANE_CAP; i++) {
        vi.setSystemTime(t0 + i * 1000);
        await recordPendingSender({ tenantId: h.ws, laneKey: lane, senderId: id(i), chatId: id(i) });
      }
      vi.setSystemTime(t0 + 200_000);
      await recordPendingSender({ tenantId: h.ws, laneKey: lane, senderId: id(0), chatId: id(0) }); // now the most recent
    } finally {
      vi.useRealTimers();
    }
    expect(await listPendingSenders(h.ws, lane)).toHaveLength(PENDING_PER_LANE_CAP);
    await d.inbound('+15550499999');
    const after = (await listPendingSenders(h.ws, lane)).map((p) => p.senderId);
    expect(after).toHaveLength(PENDING_PER_LANE_CAP);
    expect(after).toContain('+15550499999');
    expect(after).toContain(id(0)); // re-touched: recently seen, kept
    expect(after).not.toContain(id(1)); // the least recently seen is the one evicted
  }, 60_000);

  it('at most 30 new pending records a minute per device lane, never a 429', async () => {
    const d = await ownedDevice(await h.editor());
    for (let i = 0; i < 31; i++) {
      const r = await d.inbound(`+1555050${String(i).padStart(4, '0')}`);
      expect(r.status).toBe(202);
    }
    expect(await listPendingSenders(h.ws, `relay:${d.relayId}`)).toHaveLength(30);
  }, 60_000);
});

describe('D9 + ADR 1042 D12 — strangers never spend the device\'s inbound budget', () => {
  it('a flood of strangers is admitted out before the budget; the approved peer still gets its full budget', async () => {
    const owner = await h.editor();
    const d = await ownedDevice(owner);
    const PEER = '+15550801010';
    expect((await send(d.peers, { headers: asUser(owner), body: { senderId: PEER } })).status).toBe(201);
    process.env.OPENWOP_RATELIMIT_DISABLED = 'false';
    process.env.OPENWOP_RATELIMIT_CHANNEL_INBOUND_PER_MIN = '2';
    process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '10000';
    try {
      for (let i = 0; i < 5; i++) {
        const r = await d.inbound(`+1555089${String(i).padStart(4, '0')}`);
        expect([r.status, field(r.body, 'dropped')]).toEqual([202, 'not_paired']);
      }
      // The owner's own outgoing chatter is not admitted either, and spends nothing.
      expect((await d.inbound(PEER, { fromMe: true })).body).toMatchObject({ accepted: false, dropped: 'own_outgoing' });
      expect((await d.inbound(PEER)).status).toBe(202);
      expect((await d.inbound(PEER)).status).toBe(202);
      const over = await d.inbound(PEER);
      expect(over.status).toBe(429);
      expect(field(over.body, 'details', 'reason')).toBe('channel_inbound_rate');
    } finally {
      process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
      delete process.env.OPENWOP_RATELIMIT_CHANNEL_INBOUND_PER_MIN;
      delete process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN;
    }
    expect(await listPendingSenders(h.ws, `relay:${d.relayId}`)).toHaveLength(5);
  }, 60_000);
});

describe('ADR 1042 D9 — the hosted lane needs the group acknowledgement server-side too', () => {
  it('POST connections/:id/senders refuses a group without groupAcknowledged, and accepts it with', async () => {
    const editor = await h.editor();
    const created = await h.call('/host/openwop-app/connections', editor, 'POST', { provider: 'telegram', kind: 'bearer', secret: '9:tok' });
    const id = encodeURIComponent(text(field(created.body, 'connectionId')));
    const path = `/host/openwop-app/connections/${id}/senders`;
    const refused = await h.call(path, editor, 'POST', { senderId: 'group:-4242' });
    expect(refused.status).toBe(400);
    expect(field(refused.body, 'details', 'reason')).toBe('group_ack_required');
    expect(await getApprovedSender(`conn:${decodeURIComponent(id)}`, 'group:-4242')).toBeNull();
    expect((await h.call(path, editor, 'POST', { senderId: 'group:-4242', groupAcknowledged: true })).status).toBe(201);
    // A person needs no acknowledgement.
    expect((await h.call(path, editor, 'POST', { senderId: '4243' })).status).toBe(201);
  }, 60_000);
});

describe('D9 — groups need the acknowledgement, and must name the assistant', () => {
  it('approving a group without groupAcknowledged is refused; an approved group is answered only when addressed', async () => {
    const owner = await h.editor();
    const d = await ownedDevice(owner);
    const GROUP = 'group.c1043pteam';
    const refused = await send(d.peers, { headers: asUser(owner), body: { senderId: `group:${GROUP}` } });
    expect(refused.status).toBe(400);
    expect(field(refused.body, 'details', 'reason')).toBe('group_ack_required');
    expect((await send(d.peers, { headers: asUser(owner), body: { senderId: `group:${GROUP}`, groupAcknowledged: true } })).status).toBe(201);

    const inGroup = (t: string) => d.inbound(GROUP, { peerId: '+15550601010', text: t });
    process.env.OPENWOP_MESSAGING_BOT_NAME = 'helper';
    try {
      expect((await inGroup('just chatting')).body).toMatchObject({ accepted: false, dropped: 'not_addressed' });
      expect((await inGroup('@helper what time is it')).body).toMatchObject({ accepted: true });
    } finally {
      delete process.env.OPENWOP_MESSAGING_BOT_NAME;
    }
  }, 60_000);
});

describe('D9 — erasure covers the per-device approvals', () => {
  it('erasing the peer, or the owner, deletes the relay lane\'s approvals and pending rows', async () => {
    const owner = await h.editor();
    const d = await ownedDevice(owner);
    const lane = `relay:${d.relayId}`;
    const PEER = '+15550701010';
    const KEPT = '+15550702020';
    expect((await send(d.peers, { headers: asUser(owner), body: { senderId: PEER } })).status).toBe(201);
    expect((await send(d.peers, { headers: asUser(owner), body: { senderId: KEPT } })).status).toBe(201);
    await d.inbound('+15550703030');
    // Positive controls: the setup landed, so the "gone" checks below can fail.
    expect(await getApprovedSender(lane, PEER)).not.toBeNull();
    expect((await listPendingSenders(h.ws, lane)).map((p) => p.senderId)).toEqual(['+15550703030']);

    await eraseChannelIngressSubject(h.ws, PEER);
    expect(await getApprovedSender(lane, PEER)).toBeNull();
    expect(await getApprovedSender(lane, KEPT)).not.toBeNull();
    await eraseChannelIngressSubject(h.ws, '+15550703030');
    expect(await listPendingSenders(h.ws, lane)).toEqual([]);

    await eraseChannelIngressSubject(h.ws, h.editorUserId);
    expect(await getApprovedSender(lane, KEPT)).toBeNull();
  }, 60_000);
});
