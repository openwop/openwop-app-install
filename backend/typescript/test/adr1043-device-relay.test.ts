/**
 * ADR 1043 (CHAN-P1) — the device relay's server side, over HTTP on the real app.
 *
 * Covered (each a D1/D3 item):
 *  - activation: the caller's tenant must be the device's (404), only the person
 *    who registered may activate (anyone else: the same 404, counting nothing, M2), the ACTIVATING
 *    person becomes the owner, with the account id from registration;
 *  - lockout: wrong codes count down `attemptsLeft`; the fifth burns the code and
 *    every later attempt, the right code included, is `activation_locked`;
 *  - the four 401 reasons a relay acts on, and a token row with no expiry is
 *    refused as expired (fail closed), while activate and rotate always write one;
 *  - rotation: a new token works, the old one keeps working inside its grace but
 *    cannot rotate, and stops after the grace; heartbeat reports `rotateAfter`;
 *  - ack: delivered rows go, a permanent failure is dead-lettered at once, a
 *    transient one stays with its attempt count and is dead-lettered at 5, another
 *    device's egress id is ignored, each outcome is in the delivery log;
 *  - presence: the sweep calls its offline hook ONCE for a silent device (the
 *    test injects the hook, so the production hook's log write in
 *    `webhookDeliveryWorker.ts` is not exercised here), and the next heartbeat
 *    brings it back with an `online` log row;
 *  - the relay lane settings route: owner only (another editor 403, another
 *    tenant 404), 404 with the feature off, the same validation as the connection
 *    route, no bot handle, `accountId` updates the self lane's account;
 *  - revoke takes the owner, the lane settings and the lifecycle rows with it;
 *  - only the device's owner or a workspace admin (`host:connections:manage`,
 *    the connections routes' workspace-level check) may revoke; another member
 *    gets 403 `relay_revoke_forbidden`; the listing's `canRevoke` agrees.
 *
 * Red when: activation skips the tenant check or the registrant check, binds the
 * owner at registration, never locks, lets the right code through after a lock;
 * `authDevice` loses a reason or the grace path; rotate accepts a grace token;
 * ack deletes a transient failure or never dead-letters; the sweep marks twice or
 * never; the settings route lets a non-owner in or skips `parseSettingsBody`;
 * revoke leaves the lane behind.
 * Sabotage-witnessed 2026-11-03 (one at a time, each turned this file red):
 * removing the activation tenant check; removing the registrant check; removing
 * the `counted.locked` burn; making rotate accept `viaGrace`; treating every
 * failure as permanent; dropping the `offlineSince` skip in the sweep; removing
 * the owner predicate in `managedRelay`; removing the `onRevoked` purge; not
 * binding the owner at activation; dropping the revoke tombstone (the relay then
 * hears `device_token_invalid`, not `device_revoked`); restoring the old
 * `tokenExpiresAt &&` guard, so a row with no expiry authenticates forever;
 * dropping the owner branch of `canRevokeRelay`; making `isRelayWorkspaceAdmin`
 * always true; making it always false; computing `canRevoke` as `true`.
 *
 * Re-measured in /grade-tests w87 (g2 probes dr-*): 23 of 24 sabotages turned
 * their case red. Two recorded double guards:
 *  - activation tenant check + registrant check: an outsider is refused by BOTH
 *    with the same 404, so removing the tenant check ALONE stays green (probe
 *    dr-tenant-only, vacuous; the 2026-11-03 line above that claimed it is
 *    corrected here). Removing both in one edit turns case 1 red
 *    (dr-tenant-and-registrant). The tenant check alone still matters for an
 *    operator-registered device with no `registeredBy`.
 *  - ack of another device's egress id: the route filters ids by this device's
 *    pending set AND `ackRelayOutbound` deletes `WHERE relay_id = ?`, so dropping
 *    the route filter alone stays green (dr-ack-foreign); witnessed only as a
 *    held pair with the storage scope removed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
const { bootChannelHarness, field, text } = await import('./support/channelCoreHarness.js');
const { saveConfig } = await import('../src/host/featureToggles/service.js');
const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
const { getRelayOwnerRecord } = await import('../src/messaging/relayOwner.js');
const { getRegistration, getPresence, relayForGraceToken, sweepRelayPresence, OFFLINE_AFTER_MS } = await import('../src/messaging/relayLifecycle.js');
const { getChannelSettings } = await import('../src/features/channel-ingress/stores.js');
type Harness = Awaited<ReturnType<typeof bootChannelHarness>>;

const M = '/host/openwop-app/messaging';
const OP = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let h: Harness;

async function send(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const res = await fetch(`${h.base}${M}${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as unknown };
}
const asUser = (cookie: string) => ({ cookie });
const dev = (token: string) => ({ 'x-openwop-device-token': token });

/** Register + activate as the dev-token operator in the harness workspace (no owner). */
async function operatorRelay(channel = 'signal'): Promise<{ relayId: string; token: string }> {
  const reg = await send(`/relay/register?tenantId=${h.ws}`, { headers: OP, body: { channel } });
  const act = await send(`/relay/activate?tenantId=${h.ws}`, { headers: OP, body: { relayId: field(reg.body, 'relayId'), activationCode: field(reg.body, 'activationCode') } });
  expect(act.status).toBe(200);
  return { relayId: text(field(reg.body, 'relayId')), token: text(field(act.body, 'deviceToken')) };
}

beforeAll(async () => { h = await bootChannelHarness('c1043'); }, 120_000);
afterAll(async () => { await h?.close(); });

describe('D3 — activation binds the owner, in the right tenant, by the registrant', () => {
  it('another tenant and another person get the same 404; the registrant becomes the owner', async () => {
    const editor = await h.editor();
    const reg = await send('/relay/register', { headers: asUser(editor), body: { channel: 'whatsapp', accountId: '15550001111@s.whatsapp.net' } });
    expect(reg.status).toBe(201);
    const relayId = text(field(reg.body, 'relayId'));
    const activationCode = text(field(reg.body, 'activationCode'));
    // Registration records who registered; nobody owns it yet.
    expect((await getRegistration(relayId))?.registeredBy).toBe(h.editorUserId);
    expect(await getRelayOwnerRecord(relayId, h.ws)).toBeNull();

    const foreign = await send('/relay/activate', { headers: asUser(await h.outsider()), body: { relayId, activationCode } });
    expect(foreign.status).toBe(404);
    // M2 — a non-registrant gets the SAME 404, even with the right code.
    const other = await send('/relay/activate', { headers: asUser(await h.editor2()), body: { relayId, activationCode } });
    expect(other.status).toBe(404);

    const act = await send('/relay/activate', { headers: asUser(editor), body: { relayId, activationCode } });
    expect(act.status).toBe(200);
    expect(field(act.body, 'ownerBound')).toBe(true);
    expect(text(field(act.body, 'deviceToken'))).toMatch(/^dtok_/);
    const expires = Date.parse(text(field(act.body, 'tokenExpiresAt')));
    expect(Date.parse(text(field(act.body, 'rotateAfter')))).toBe(expires - 7 * 24 * 60 * 60 * 1000);
    expect(await getRelayOwnerRecord(relayId, h.ws)).toMatchObject({ ownerUserId: h.editorUserId, ownerAccountId: '15550001111@s.whatsapp.net' });
    expect(await getRegistration(relayId)).toBeNull();
  });

  it('five wrong codes lock the relay; the right code is then refused too', async () => {
    const reg = await send(`/relay/register?tenantId=${h.ws}`, { headers: OP, body: { channel: 'signal' } });
    const relayId = text(field(reg.body, 'relayId'));
    const left: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await send(`/relay/activate?tenantId=${h.ws}`, { headers: OP, body: { relayId, activationCode: `wrong${i}` } });
      expect(r.status).toBe(400);
      left.push(field(r.body, 'details', 'attemptsLeft'));
    }
    expect(left).toEqual([4, 3, 2, 1]);
    const fifth = await send(`/relay/activate?tenantId=${h.ws}`, { headers: OP, body: { relayId, activationCode: 'wrong4' } });
    expect(fifth.status).toBe(403);
    expect(field(fifth.body, 'details', 'reason')).toBe('activation_locked');
    const right = await send(`/relay/activate?tenantId=${h.ws}`, { headers: OP, body: { relayId, activationCode: field(reg.body, 'activationCode') } });
    expect(right.status).toBe(403);
    expect(field(right.body, 'details', 'reason')).toBe('activation_locked');
  });

  it('M2 — another member cannot lock a victim out: wrong codes from a non-registrant count nothing', async () => {
    const owner = await h.editor();
    const attacker = await h.editor2();
    const reg = await send('/relay/register', { headers: asUser(owner), body: { channel: 'signal' } });
    const relayId = text(field(reg.body, 'relayId'));
    for (let i = 0; i < 6; i++) {
      const r = await send('/relay/activate', { headers: asUser(attacker), body: { relayId, activationCode: `guess${i}` } });
      expect(r.status).toBe(404);
    }
    expect(Object.keys((await getRegistration(relayId))?.failuresBy ?? {})).toEqual([]);
    const ok = await send('/relay/activate', { headers: asUser(owner), body: { relayId, activationCode: field(reg.body, 'activationCode') } });
    expect(ok.status).toBe(200);
  });
});

describe('D1 — device auth reasons and token rotation', () => {
  it('names each refusal', async () => {
    const missing = await send('/device/heartbeat', { body: {} });
    expect(missing.status).toBe(401);
    expect(field(missing.body, 'details', 'reason')).toBe('device_token_missing');
    const invalid = await send('/device/heartbeat', { headers: dev('dtok_nope'), body: {} });
    expect(invalid.status).toBe(401);
    expect(field(invalid.body, 'details', 'reason')).toBe('device_token_invalid');

    const a = await operatorRelay();
    const row = await h.storage.getRelayDevice(a.relayId);
    await h.storage.upsertRelayDevice({ ...row!, tokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await send('/device/heartbeat', { headers: dev(a.token), body: {} });
    expect(expired.status).toBe(401);
    expect(field(expired.body, 'details', 'reason')).toBe('device_token_expired');

    // Fail closed: a token row with NO expiry (legacy or corrupt) is expired, not eternal.
    const c = await operatorRelay();
    const rowC = await h.storage.getRelayDevice(c.relayId);
    expect(rowC?.tokenExpiresAt).toBeTruthy(); // activation always writes one
    const noExpiry = { ...rowC! };
    delete noExpiry.tokenExpiresAt;
    await h.storage.upsertRelayDevice(noExpiry);
    const eternal = await send('/device/heartbeat', { headers: dev(c.token), body: {} });
    expect(eternal.status).toBe(401);
    expect(field(eternal.body, 'details', 'reason')).toBe('device_token_expired');
    // Rotation always writes an expiry too, so a rotated token is never this row.
    const d = await operatorRelay();
    const rot = await send('/device/rotate', { headers: dev(d.token), body: {} });
    expect((await h.storage.getRelayDevice(d.relayId))?.tokenExpiresAt).toBe(field(rot.body, 'tokenExpiresAt'));

    const b = await operatorRelay();
    // Revoke drops the hash; the route's tombstone is what lets the relay hear "revoked".
    expect((await send(`/relay/revoke?tenantId=${h.ws}`, { headers: OP, body: { relayId: b.relayId } })).status).toBe(200);
    const revoked = await send('/device/heartbeat', { headers: dev(b.token), body: {} });
    expect(revoked.status).toBe(401);
    expect(field(revoked.body, 'details', 'reason')).toBe('device_revoked');
  });

  it('rotates; the old token works inside its grace, cannot rotate, and dies after it', async () => {
    const { token: oldToken, relayId } = await operatorRelay();
    const hb = await send('/device/heartbeat', { headers: dev(oldToken), body: {} });
    expect(Date.parse(text(field(hb.body, 'rotateAfter')))).toBeLessThan(Date.parse(text(field(hb.body, 'tokenExpiresAt'))));

    const rot = await send('/device/rotate', { headers: dev(oldToken), body: {} });
    expect(rot.status).toBe(200);
    const newToken = text(field(rot.body, 'deviceToken'));
    expect(newToken).not.toBe(oldToken);
    expect((await send('/device/heartbeat', { headers: dev(newToken), body: {} })).status).toBe(200);
    expect((await send('/device/heartbeat', { headers: dev(oldToken), body: {} })).status).toBe(200); // grace
    const fork = await send('/device/rotate', { headers: dev(oldToken), body: {} });
    expect(fork.status).toBe(401);
    expect(field(fork.body, 'details', 'reason')).toBe('device_token_superseded');

    const { createHash } = await import('node:crypto');
    const oldHash = createHash('sha256').update(oldToken).digest('hex');
    const until = Date.parse(text(field(rot.body, 'previousTokenValidUntil')));
    expect(await relayForGraceToken(oldHash, until - 1)).toBe(relayId);
    expect(await relayForGraceToken(oldHash, until + 1)).toBeNull();
    expect((await send('/device/heartbeat', { headers: dev(oldToken), body: {} })).status).toBe(401); // the expired grace row is gone
  });
});

describe('D1 — ack: delivered, permanent, transient and dead-letter', () => {
  it('each outcome lands where the contract says', async () => {
    const a = await operatorRelay();
    const b = await operatorRelay();
    const enqueue = async (relayId: string, t: string) =>
      text(field((await send(`/relay/enqueue?tenantId=${h.ws}`, { headers: OP, body: { relayId, conversationId: '+1555', text: t } })).body, 'egressId'));
    const ok = await enqueue(a.relayId, 'ok');
    const perm = await enqueue(a.relayId, 'perm');
    const flaky = await enqueue(a.relayId, 'flaky');
    const foreign = await enqueue(b.relayId, 'not yours');

    const first = await send('/device/ack', { headers: dev(a.token), body: {
      egressIds: [ok, foreign],
      failed: [{ egressId: perm, error: 'recipient not on WhatsApp', permanent: true }, { egressId: flaky, error: 'socket closed' }],
    } });
    expect(first.body).toEqual({ acked: 1, failed: 2, deadLettered: 1 });
    const queued = field((await send('/device/outbound', { headers: dev(a.token) })).body, 'messages');
    expect(Array.isArray(queued) ? queued.map((m) => [field(m, 'egressId'), field(m, 'attempts')]) : queued).toEqual([[flaky, 1]]);
    // The other device's egress is untouched.
    const bq = field((await send('/device/outbound', { headers: dev(b.token) })).body, 'messages');
    expect(Array.isArray(bq) ? bq.map((m) => field(m, 'egressId')) : bq).toEqual([foreign]);

    for (let i = 2; i <= 4; i++) {
      const r = await send('/device/ack', { headers: dev(a.token), body: { failed: [{ egressId: flaky, error: 'socket closed' }] } });
      expect(r.body).toEqual({ acked: 0, failed: 1, deadLettered: 0 });
    }
    const last = await send('/device/ack', { headers: dev(a.token), body: { failed: [{ egressId: flaky, error: 'socket closed' }] } });
    expect(last.body).toEqual({ acked: 0, failed: 1, deadLettered: 1 });
    expect(field((await send('/device/outbound', { headers: dev(a.token) })).body, 'messages')).toEqual([]);

    const logs = await h.storage.listDeliveryLog({ tenantId: h.ws, direction: 'outbound' });
    const mine = logs.filter((l) => l.relayId === a.relayId).map((l) => `${l.status} ${l.detail ?? ''}`);
    expect(mine).toContain(`delivered egress ${ok}: delivered`);
    expect(mine).toContain(`failed egress ${perm}: permanent: recipient not on WhatsApp`);
    expect(mine).toContain(`failed egress ${flaky}: max_attempts: socket closed`);
    expect((await send('/device/ack', { headers: dev(a.token), body: {} })).status).toBe(400);
  });
});

describe('D3 — offline marking', () => {
  it('marks a silent device offline once, and back online on its next heartbeat', async () => {
    const a = await operatorRelay();
    await send('/device/heartbeat', { headers: dev(a.token), body: { status: 'connected' } });
    const list = async () => {
      const d = field((await send(`/relay/devices?tenantId=${h.ws}`, { headers: OP })).body, 'devices');
      return Array.isArray(d) ? d.find((x) => field(x, 'relayId') === a.relayId) : undefined;
    };
    expect(field(await list(), 'presence')).toBe('online');
    expect(field(await list(), 'deviceTokenHash')).toBeUndefined();

    const later = Date.parse((await getPresence(a.relayId))!.lastHeartbeatAt) + OFFLINE_AFTER_MS + 1000;
    const marked: string[] = [];
    await sweepRelayPresence(async (row) => { marked.push(row.relayId); }, later);
    await sweepRelayPresence(async (row) => { marked.push(row.relayId); }, later + 60_000);
    expect(marked.filter((id) => id === a.relayId)).toEqual([a.relayId]);
    expect(field(await list(), 'presence')).toBe('offline');

    await send('/device/heartbeat', { headers: dev(a.token), body: {} });
    expect(field(await list(), 'presence')).toBe('online');
    const logs = await h.storage.listDeliveryLog({ tenantId: h.ws });
    expect(logs.filter((l) => l.relayId === a.relayId).map((l) => l.status)).toContain('online');
  });
});

describe('D3 — the relay lane settings route, and revoke', () => {
  beforeAll(async () => { await saveConfig({ ...getToggleDefault('channel-ingress')!, status: 'on' }, 'test'); });
  afterAll(async () => { await saveConfig({ ...getToggleDefault('channel-ingress')!, status: 'off' }, 'test'); });

  it('owner only, sibling validation, account id, and revoke purges the lane', async () => {
    const editor = await h.editor();
    const reg = await send('/relay/register', { headers: asUser(editor), body: { channel: 'signal' } });
    const relayId = text(field(reg.body, 'relayId'));
    const act = await send('/relay/activate', { headers: asUser(editor), body: { relayId, activationCode: field(reg.body, 'activationCode') } });
    await send('/device/heartbeat', { headers: dev(text(field(act.body, 'deviceToken'))), body: {} });
    expect(await getPresence(relayId)).not.toBeNull();
    const path = `/relay/${relayId}/channel`;

    const notOwner = await send(path, { headers: asUser(await h.editor2()) });
    expect(notOwner.status).toBe(403);
    expect(field(notOwner.body, 'message')).toBe('Only the person who activated this relay can manage it.');
    expect((await send(path, { headers: asUser(await h.outsider()) })).status).toBe(404);
    // Each 400 is refused by the check under test (its own field), not an earlier one.
    for (const [bad, f] of [[{ agentId: 'no.such.agent' }, 'agentId'], [{ model: 'bad model!' }, 'model'], [{ botHandle: 'bot' }, 'botHandle']] as const) {
      const r = await send(path, { method: 'PUT', headers: asUser(editor), body: bad });
      expect([f, r.status, field(r.body, 'details', 'field')]).toEqual([f, 400, f]);
    }

    const put = await send(path, { method: 'PUT', headers: asUser(editor), body: { provider: 'mock', model: 'mock-1', accountId: '+15550002222' } });
    expect(put.status).toBe(200);
    expect(field(put.body, 'settings', 'model')).toBe('mock-1');
    expect(field(put.body, 'accountId')).toBe('+15550002222');
    expect((await getRelayOwnerRecord(relayId, h.ws))?.ownerAccountId).toBe('+15550002222');
    const got = await send(path, { headers: asUser(editor) });
    expect(field(got.body, 'settings', 'provider')).toBe('mock');

    await saveConfig({ ...getToggleDefault('channel-ingress')!, status: 'off' }, 'test');
    expect((await send(path, { headers: asUser(editor) })).status).toBe(404);
    await saveConfig({ ...getToggleDefault('channel-ingress')!, status: 'on' }, 'test');

    const revoked = await send('/relay/revoke', { headers: asUser(editor), body: { relayId } });
    expect(revoked.status).toBe(200);
    expect(await getChannelSettings(`relay:${relayId}`)).toBeNull();
    expect(await getRelayOwnerRecord(relayId, h.ws)).toBeNull();
    expect(await getPresence(relayId)).toBeNull();
  });
});

describe('D3 follow-up — who may revoke a relay, and canRevoke', () => {
  it('the owner and a workspace admin may; another member is refused; canRevoke says the same', async () => {
    const { createMember } = await import('../src/host/accessControlService.js');
    const { userIdFor } = await import('../src/features/users/usersService.js');
    const adminSubject = 'oidc:c1043-admin';
    await createMember({ orgId: h.ws, tenantId: h.ws, displayName: 'Admin', subject: userIdFor(h.ws, adminSubject), roles: ['admin'] });
    const login = await fetch(`${h.base}/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: adminSubject, tenantId: h.ws, displayName: 'Admin', sharedWorkspace: true }),
    });
    const admin = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const owner = await h.editor();
    const member = await h.editor2();

    const mint = async () => {
      const reg = await send('/relay/register', { headers: asUser(owner), body: { channel: 'signal' } });
      const relayId = text(field(reg.body, 'relayId'));
      expect((await send('/relay/activate', { headers: asUser(owner), body: { relayId, activationCode: field(reg.body, 'activationCode') } })).status).toBe(200);
      return relayId;
    };
    const canRevokeFor = async (cookie: string, relayId: string) => {
      const list = field((await send('/relay/devices', { headers: asUser(cookie) })).body, 'devices');
      return Array.isArray(list) ? field(list.find((d) => field(d, 'relayId') === relayId), 'canRevoke') : undefined;
    };

    const a = await mint();
    expect(await canRevokeFor(owner, a)).toBe(true);
    expect(await canRevokeFor(admin, a)).toBe(true);
    expect(await canRevokeFor(member, a)).toBe(false);

    const refused = await send('/relay/revoke', { headers: asUser(member), body: { relayId: a } });
    expect(refused.status).toBe(403);
    expect(field(refused.body, 'details', 'reason')).toBe('relay_revoke_forbidden');
    expect((await h.storage.getRelayDevice(a))?.status).toBe('active');

    expect((await send('/relay/revoke', { headers: asUser(admin), body: { relayId: a } })).status).toBe(200);
    expect((await h.storage.getRelayDevice(a))?.status).toBe('revoked');
    expect(await canRevokeFor(owner, a)).toBe(false); // nothing left to revoke

    const b = await mint();
    expect((await send('/relay/revoke', { headers: asUser(owner), body: { relayId: b } })).status).toBe(200);
    expect((await h.storage.getRelayDevice(b))?.status).toBe('revoked');
  });
});

describe('M3 — lifecycle writes never undo a concurrent one', () => {
  it('a revoke landing between auth and the heartbeat write stays revoked', async () => {
    const a = await operatorRelay();
    // Land the revoke INSIDE the heartbeat: the first read that authenticates it
    // returns the active row, then the revoke happens before the write.
    const real = h.storage.getRelayDeviceByTokenHash.bind(h.storage);
    let fired = false;
    h.storage.getRelayDeviceByTokenHash = async (hash: string) => {
      const row = await real(hash);
      if (!fired && row?.relayId === a.relayId) { fired = true; await h.storage.revokeRelayDevice(a.relayId); }
      return row;
    };
    try {
      const hb = await send('/device/heartbeat', { headers: dev(a.token), body: {} });
      // The revoke here is the storage call, not the route, so no tombstone is
      // written and the re-auth reads `device_token_invalid`; the claim is the 401
      // plus the row staying revoked below, not which reason the relay hears.
      expect(hb.status).toBe(401);
    } finally { h.storage.getRelayDeviceByTokenHash = real; }
    const row = await h.storage.getRelayDevice(a.relayId);
    expect(row?.status).toBe('revoked');
    expect(row?.deviceTokenHash).toBeUndefined();
  });

  it('a heartbeat during a rotation does not restore the old hash', async () => {
    const a = await operatorRelay();
    const { createHash } = await import('node:crypto');
    const oldHash = createHash('sha256').update(a.token).digest('hex');
    const real = h.storage.getRelayDeviceByTokenHash.bind(h.storage);
    let rotatedTo: string | undefined;
    h.storage.getRelayDeviceByTokenHash = async (hash: string) => {
      const row = await real(hash);
      if (!rotatedTo && row?.relayId === a.relayId) {
        rotatedTo = 'f'.repeat(64);
        await h.storage.rotateRelayDeviceToken(a.relayId, oldHash, rotatedTo, new Date(Date.now() + 86_400_000).toISOString());
      }
      return row;
    };
    try {
      await send('/device/heartbeat', { headers: dev(a.token), body: {} });
    } finally { h.storage.getRelayDeviceByTokenHash = real; }
    expect((await h.storage.getRelayDevice(a.relayId))?.deviceTokenHash).toBe(rotatedTo);
  });
});

describe('H1 — sending through a device is its owner\'s act; relay config is an admin\'s', () => {
  it('another member cannot enqueue through the owner\'s device, nor change workspace relay config', async () => {
    const owner = await h.editor();
    const member = await h.editor2();
    const reg = await send('/relay/register', { headers: asUser(owner), body: { channel: 'whatsapp' } });
    const relayId = text(field(reg.body, 'relayId'));
    await send('/relay/activate', { headers: asUser(owner), body: { relayId, activationCode: field(reg.body, 'activationCode') } });
    const body = { relayId, conversationId: '15550009999@s.whatsapp.net', text: 'hi', media: [{ url: 'http://localhost:8080/secret' }] };

    const stolen = await send('/relay/enqueue', { headers: asUser(member), body });
    expect(stolen.status).toBe(403);
    expect(field(stolen.body, 'details', 'reason')).toBe('relay_owner_required');
    expect(await h.storage.listRelayOutbound(relayId, 10)).toEqual([]);
    expect((await send('/relay/enqueue', { headers: asUser(owner), body: { ...body, media: undefined } })).status).toBe(201);

    // The workflow chat-egress path (ctx.messaging) holds the same line: only a
    // run acting AS the owner may send through an owned device.
    const { makeChatEgressAdapter } = await import('../src/host/chatEgressAdapter.js');
    const envelope = { channel: 'whatsapp', delivery: { conversationId: '15550009999@s.whatsapp.net' }, content: { text: 'from a run' } };
    const asMember = makeChatEgressAdapter({ storage: h.storage, tenantId: h.ws, runId: 'run-m', actingUserId: h.editor2UserId });
    expect(await asMember.dispatchEgressEnvelope({ envelope, connectorInstanceId: relayId, nodeId: 'n' })).toEqual({ success: false, error: 'connector_not_found' });
    const asSystem = makeChatEgressAdapter({ storage: h.storage, tenantId: h.ws, runId: 'run-s' });
    expect(await asSystem.dispatchEgressEnvelope({ envelope, connectorInstanceId: relayId, nodeId: 'n' })).toEqual({ success: false, error: 'connector_not_found' });
    const asOwner = makeChatEgressAdapter({ storage: h.storage, tenantId: h.ws, runId: 'run-o', actingUserId: h.editorUserId });
    expect((await asOwner.dispatchEgressEnvelope({ envelope, connectorInstanceId: relayId, nodeId: 'n' })).success).toBe(true);

    for (const [path, method, b] of [
      ['/connectors', 'POST', { channel: 'whatsapp', enabled: true }],
      ['/routing', 'POST', { pattern: '*', workflowId: 'x' }],
      ['/allowlist', 'POST', { connectorId: 'conn_whatsapp_x', channel: 'whatsapp', peerId: '1' }],
      ['/pairing', 'GET', undefined],
      ['/sessions', 'GET', undefined],
      ['/identities', 'GET', undefined],
    ] as const) {
      const r = await send(path, { method, headers: asUser(member), ...(b ? { body: b } : {}) });
      expect([path, r.status, field(r.body, 'details', 'reason')]).toEqual([path, 403, 'relay_admin_required']);
    }
  });
});
