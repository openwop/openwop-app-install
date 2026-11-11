/**
 * ADR 1043 RELAY-LOG-RETENTION-1 — every delete path of `messaging_delivery_log`,
 * on the REAL booted app (its boot registers the eraser and the age-out).
 *
 * Covered:
 *  (a) retention: the default-window sweep the retention daemon runs deletes rows
 *      older than 7 days and keeps newer ones; a tenant under legal hold keeps
 *      its old rows; `OPENWOP_RELAY_DELIVERY_LOG_RETENTION_DAYS` moves the window;
 *  (b) erasure by contact id: `eraseSubject` deletes the rows whose
 *      `conversation_id` EQUALS the key, in that tenant only, and not a row whose
 *      id merely starts with it;
 *  (c) erasure by device owner: erasing a relay's owner deletes that relay's rows
 *      (found through the relay-owner record), not another relay's;
 *  (d) tenant teardown deletes the tenant's rows and no other tenant's;
 *  (e) revoke deletes the revoked device's rows and inbound claims, and not
 *      another device's;
 *  (f) `messaging:inbound-claim`: erasure by contact id (exact, one tenant) and by
 *      device owner deletes the claims (a deleted claim is claimable again);
 *  (g) CHAN-F12: the boot registers the `relay-outbound` default-window sweep (the
 *      sweep's own cases are in `adr1043-relay-outbound-retention.test.ts`).
 *
 * Red when: the sweep is not registered at boot, ignores the cutoff or the hold,
 * or the knob; the eraser is not registered, matches by prefix or crosses
 * tenants; the owner leg is dropped from `eraseRelayOwnerSubject`; the table
 * loses its `tenant_id` teardown reach; the revoke route stops deleting.
 * Sabotage-witnessed 2026-11-04, one edit at a time, each turned exactly its
 * own case red: passing no held tenants to `pruneDeliveryLog` (a); erasing
 * `${key}5` instead of the key (b); dropping the owner leg's delete in
 * `eraseRelayOwnerSubject` (c); filtering the table out of sqlite
 * `deleteAllTenantData`'s introspection loop (d); removing the revoke route's
 * delete (e). Then, for the claims: dropping the `conversationId` match from
 * `eraseRelayOwnerSubject`'s claim call (f, contact); dropping its `relayIds`
 * (f, owner); removing the revoke route's claim delete (e).
 * Re-witnessed 2026-11-05 (/grade-tests w89), each red on its own case: the sweep
 * unregistered, a doubled cutoff, the knob ignored, the delivery-log eraser
 * unregistered, a prefix (LIKE) or tenant-less sqlite erase, the owner match
 * dropped, the revoke delete widened past one relay, a prefix claim match.
 *
 * Double guard (claims tenant fence): `deleteRelayInboundClaims` reads through
 * `claims.listForTenantIndexed(tenantId)` (a scan of that tenant's index only)
 * AND re-checks `c.tenantId !== tenantId`. Dropping the re-check alone stays
 * green (probed); the index scan in `host/hostExtPersistence.ts` is the guard a
 * cross-tenant claim meets first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeliveryLogRecord } from '../src/messaging/types.js';

process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
const { bootChannelHarness, field, text } = await import('./support/channelCoreHarness.js');
const { runDefaultWindowSweeps } = await import('../src/host/retentionPurger.js');
const { setRetentionHold, clearRetentionHold } = await import('../src/host/retentionHold.js');
const { eraseSubject } = await import('../src/host/subjectErasure.js');
const { recordRelayOwner } = await import('../src/messaging/relayOwner.js');
const { claimRelayInbound } = await import('../src/messaging/inboundClaims.js');
type Harness = Awaited<ReturnType<typeof bootChannelHarness>>;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const OP = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let h: Harness;
let seq = 0;

beforeAll(async () => { h = await bootChannelHarness('c1043dl'); }, 120_000);
afterAll(async () => { await h?.close(); });

async function log(tenantId: string, conversationId: string, opts: { relayId?: string; ageDays?: number } = {}): Promise<string> {
  const logId = `dlv_test_${++seq}`;
  const rec: DeliveryLogRecord = {
    logId, tenantId, channel: 'whatsapp', direction: 'inbound', conversationId, status: 'ingested',
    at: new Date(NOW - (opts.ageDays ?? 0) * DAY).toISOString(),
    ...(opts.relayId ? { relayId: opts.relayId } : {}),
  };
  await h.storage.appendDeliveryLog(rec);
  return logId;
}
const ids = async (tenantId: string): Promise<string[]> =>
  (await h.storage.listDeliveryLog({ tenantId, limit: 1000 })).map((r) => r.logId).sort();

describe('(a) retention', () => {
  it('the boot-registered sweep deletes rows past 7 days, keeps newer ones, and skips a held tenant', async () => {
    const T = 'tenant:dl-retention';
    const H = 'tenant:dl-held';
    await log(T, '+15550000001', { ageDays: 8 });
    const fresh = await log(T, '+15550000001', { ageDays: 6 });
    const heldOld = await log(H, '+15550000002', { ageDays: 30 });
    await setRetentionHold(H, 'litigation');
    try {
      const results = await runDefaultWindowSweeps(NOW);
      expect(results.find((r) => r.feature === 'messaging-delivery-log')).toMatchObject({ ok: true, failed: 0 });
      expect(await ids(T)).toEqual([fresh]);
      expect(await ids(H)).toEqual([heldOld]);
    } finally {
      await clearRetentionHold(H);
    }
  });

  it('OPENWOP_RELAY_DELIVERY_LOG_RETENTION_DAYS moves the window', async () => {
    const T = 'tenant:dl-knob';
    await log(T, '+15550000003', { ageDays: 2 });
    const half = await log(T, '+15550000003', { ageDays: 0.5 });
    process.env.OPENWOP_RELAY_DELIVERY_LOG_RETENTION_DAYS = '1';
    try {
      await runDefaultWindowSweeps(NOW);
    } finally {
      delete process.env.OPENWOP_RELAY_DELIVERY_LOG_RETENTION_DAYS;
    }
    expect(await ids(T)).toEqual([half]);
  });
});

describe('(b) erasure by contact id', () => {
  it('deletes the rows whose conversation_id equals the key, in that tenant only', async () => {
    const T = 'tenant:dl-erase';
    const OTHER = 'tenant:dl-erase-other';
    const phone = '+15550001234';
    await log(T, phone);
    await log(T, phone, { relayId: 'relay_dl_x' });
    const near = await log(T, `${phone}5`);
    const elsewhere = await log(OTHER, phone);

    const res = await eraseSubject(T, phone);
    expect(res.failed).toBe(0);
    expect(res.rowsTouched).toBeGreaterThanOrEqual(2);
    expect(await ids(T)).toEqual([near]);
    expect(await ids(OTHER)).toEqual([elsewhere]);
  });
});

describe('(c) erasure by device owner', () => {
  it('erasing a relay\'s owner deletes that relay\'s rows, not another relay\'s', async () => {
    const T = h.ws;
    const owner = 'user:dl-owner';
    await recordRelayOwner('relay_dl_mine', T, owner);
    await recordRelayOwner('relay_dl_theirs', T, 'user:dl-other');
    await log(T, '+15550002001', { relayId: 'relay_dl_mine' });
    await log(T, '', { relayId: 'relay_dl_mine' }); // an offline row carries no contact
    const theirs = await log(T, '+15550002002', { relayId: 'relay_dl_theirs' });

    const res = await eraseSubject(T, owner);
    expect(res.failed).toBe(0);
    const left = (await h.storage.listDeliveryLog({ tenantId: T, limit: 1000 })).filter((r) => r.relayId === 'relay_dl_mine' || r.relayId === 'relay_dl_theirs');
    expect(left.map((r) => r.logId)).toEqual([theirs]);
  });
});

describe('(d) tenant teardown', () => {
  it('deleteAllTenantData deletes the tenant\'s rows and no other tenant\'s', async () => {
    const T = 'tenant:dl-teardown';
    const KEEP = 'tenant:dl-teardown-keep';
    await log(T, '+15550003001');
    const kept = await log(KEEP, '+15550003001');
    await h.storage.deleteAllTenantData(T);
    expect(await ids(T)).toEqual([]);
    expect(await ids(KEEP)).toEqual([kept]);
  });
});

describe('(e) revoke', () => {
  async function send(path: string, body: unknown) {
    const res = await fetch(`${h.base}/host/openwop-app/messaging${path}?tenantId=${h.ws}`, { method: 'POST', headers: OP, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as unknown };
  }
  async function relay(): Promise<string> {
    const reg = await send('/relay/register', { channel: 'signal' });
    const relayId = text(field(reg.body, 'relayId'));
    const act = await send('/relay/activate', { relayId, activationCode: field(reg.body, 'activationCode') });
    expect(act.status).toBe(200);
    return relayId;
  }

  it('revoking a device deletes its delivery-log rows and inbound claims, not another device\'s', async () => {
    const a = await relay();
    const b = await relay();
    await log(h.ws, '+15550004001', { relayId: a });
    const kept = await log(h.ws, '+15550004002', { relayId: b });
    expect(await claimRelayInbound({ relayId: a, tenantId: h.ws }, '+15550004001', 'm1')).toBe(true);
    expect(await claimRelayInbound({ relayId: b, tenantId: h.ws }, '+15550004002', 'm1')).toBe(true);
    expect((await send('/relay/revoke', { relayId: a })).status).toBe(200);
    const rows = (await h.storage.listDeliveryLog({ tenantId: h.ws, limit: 1000 })).filter((r) => r.relayId === a || r.relayId === b);
    expect(rows.map((r) => r.logId)).toEqual([kept]);
    // A claim that still exists dedupes (false); a deleted one is claimable again (true).
    expect(await claimRelayInbound({ relayId: a, tenantId: h.ws }, '+15550004001', 'm1')).toBe(true);
    expect(await claimRelayInbound({ relayId: b, tenantId: h.ws }, '+15550004002', 'm1')).toBe(false);
  });
});

describe('(f) inbound dedup claims (`messaging:inbound-claim`)', () => {
  // A claim that still exists dedupes a redelivery (false); a deleted one is claimable again (true).
  const claim = (tenantId: string, relayId: string, conversationId: string) => claimRelayInbound({ relayId, tenantId }, conversationId, 'm1');

  it('erasing a contact deletes the claims whose conversation id equals the key, in that tenant only', async () => {
    const T = 'tenant:cl-erase';
    const OTHER = 'tenant:cl-erase-other';
    const phone = '+15550005001';
    expect(await claim(T, 'relay_cl_a', phone)).toBe(true);
    expect(await claim(T, 'relay_cl_a', `${phone}5`)).toBe(true);
    expect(await claim(OTHER, 'relay_cl_o', phone)).toBe(true);
    expect((await eraseSubject(T, phone)).failed).toBe(0);
    expect(await claim(T, 'relay_cl_a', phone)).toBe(true);
    expect(await claim(T, 'relay_cl_a', `${phone}5`)).toBe(false);
    expect(await claim(OTHER, 'relay_cl_o', phone)).toBe(false);
  });

  it('erasing a relay\'s owner deletes that relay\'s claims, not another relay\'s', async () => {
    const T = h.ws;
    await recordRelayOwner('relay_cl_mine', T, 'user:cl-owner');
    await recordRelayOwner('relay_cl_theirs', T, 'user:cl-other');
    expect(await claim(T, 'relay_cl_mine', '+15550005101')).toBe(true);
    expect(await claim(T, 'relay_cl_theirs', '+15550005102')).toBe(true);
    expect((await eraseSubject(T, 'user:cl-owner')).failed).toBe(0);
    expect(await claim(T, 'relay_cl_mine', '+15550005101')).toBe(true);
    expect(await claim(T, 'relay_cl_theirs', '+15550005102')).toBe(false);
  });
});

describe('(g) CHAN-F12: undelivered relay egress (boot registration)', () => {
  it('the boot-registered sweep deletes egress older than the device token lifetime, and keeps newer egress', async () => {
    const T = 'tenant:or-boot';
    const relayId = 'relay_or_boot';
    await h.storage.upsertRelayDevice({ relayId, tenantId: T, channel: 'whatsapp', status: 'active', registeredAt: '2026-01-01T00:00:00.000Z' });
    const q = (egressId: string, ageDays: number) => h.storage.enqueueRelayOutbound({
      egressId, relayId, channel: 'whatsapp', conversationId: '+15550006001', text: 'hi', enqueuedAt: new Date(NOW - ageDays * DAY).toISOString(),
    });
    await q('egr_or_boot_old', 31);
    await q('egr_or_boot_new', 29);
    const results = await runDefaultWindowSweeps(NOW);
    expect(results.find((r) => r.feature === 'relay-outbound')).toMatchObject({ ok: true, failed: 0 });
    expect((await h.storage.listRelayOutbound(relayId, 10)).map((e) => e.egressId)).toEqual(['egr_or_boot_new']);
  });
});
