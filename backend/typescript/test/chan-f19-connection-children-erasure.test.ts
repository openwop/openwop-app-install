/**
 * CHAN-F19 #10 (ADR 0464 §9) — a connection's child rows on a DSAR.
 *
 * A DSAR revokes the subject's USER-scoped connections (ADR 0780 D4). Their child
 * rows — the `connections:pairing` and `connections:inbound-session` pointers, and the
 * lane's `channel-ingress:settings` (whose bot handle can be the handle of a person's
 * own account) — used to go only through revoke consumers, and the lifecycle seam
 * swallows a consumer's failure. Once the parent row is gone a retry cannot find the
 * child again, so a single failed delete orphaned it for good.
 *
 * Boots the real app and erases through `eraseSubject`. Pins:
 *  - K1: the subject's connection takes its pairing, inbound session and lane
 *    settings with it; another user's connection and an org connection keep theirs;
 *  - K2 (ordering, once per child): the child purge runs BEFORE the revoke and
 *    strictly. A failed pairing or inbound-session delete is reported and keeps the
 *    parent, so the retry finishes the job;
 *  - K4: the lane settings of the subject's connection go even when its revoke fails;
 *  - K3: lane settings left behind by a connection that is already gone are deleted
 *    (the best-effort consumer's residue); a relay lane's settings are kept.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootChannelHarness, type ChannelHarness } from './support/channelCoreHarness.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { createSecretConnection, getConnection } from '../src/features/connections/connectionsService.js';
import { getPairing, pairConnection } from '../src/features/connections/messagingOutbound.js';
import { __setInboundSessionForTest, pickResumeInterrupt } from '../src/features/connections/inboundWebhooks.js';
import { getChannelSettings, laneKeyOf, putChannelSettings } from '../src/features/channel-ingress/stores.js';

let h: ChannelHarness;
beforeAll(async () => { h = await bootChannelHarness('f19j'); }, 120_000);
afterAll(async () => { await h?.close(); });

let n = 0;
/** A connection with all three child rows. The inbound session points at a real run id shape. */
async function connectionWithChildren(scope: 'user' | 'org', userId?: string) {
  const i = n++;
  const conn = await createSecretConnection({
    tenantId: h.ws, provider: 'runway', kind: 'api_key', secret: `rw-f19j-key-${i}-0000`, scope,
    ...(userId ? { userId } : {}), ...(scope === 'org' ? { orgId: h.ws } : {}),
  });
  await pairConnection(conn.connectionId, 'telegram', `chat-${i}`);
  await __setInboundSessionForTest(conn.connectionId, `run-f19j-${i}`);
  const laneKey = laneKeyOf({ kind: 'connection', connectionId: conn.connectionId, provider: 'telegram' });
  await putChannelSettings({ laneKey, tenantId: h.ws, botHandle: `maria_${i}`, updatedAt: new Date().toISOString() });
  return { conn, laneKey };
}

/** The inbound session is private to its module; its read is via the session lookup. */
async function hasInboundSession(connectionId: string): Promise<boolean> {
  const key = `hostext:connections:inbound-session:${connectionId}`;
  return (await hostExtStorage().kvGet(key)) !== null;
}

describe('CHAN-F19 #10 — a connection\'s child rows on a DSAR', () => {
  it('K1 the subject\'s connection takes its pairing, inbound session and lane settings; others keep theirs', async () => {
    const subject = `user:f19j-maria-${n}`;
    const theirs = await connectionWithChildren('user', subject);
    const bystander = await connectionWithChildren('user', `user:f19j-joao-${n}`);
    const org = await connectionWithChildren('org');
    expect(await hasInboundSession(theirs.conn.connectionId), 'non-vacuity: the session key shape is right').toBe(true);

    await eraseSubject(h.ws, subject);

    expect(await getConnection(h.ws, theirs.conn.connectionId)).toBeNull();
    expect(await getPairing(theirs.conn.connectionId)).toBeNull();
    expect(await hasInboundSession(theirs.conn.connectionId)).toBe(false);
    expect(await getChannelSettings(theirs.laneKey)).toBeNull();
    for (const kept of [bystander, org]) {
      expect(await getPairing(kept.conn.connectionId)).not.toBeNull();
      expect(await hasInboundSession(kept.conn.connectionId)).toBe(true);
      expect(await getChannelSettings(kept.laneKey)).not.toBeNull();
    }
    // The resume lookup still works for a kept connection (the pointer is intact, not just present).
    await expect(pickResumeInterrupt(h.storage, org.conn.connectionId)).resolves.toBeNull();
  });

  // Each child is witnessed on its own: the revoke consumer would also delete it, so
  // only a failed first pass shows whether the strict purge (and not the consumer) did.
  it.each([
    ['pairing', 'connections:pairing'],
    ['inbound session', 'connections:inbound-session'],
  ])('K2 a failed %s delete is reported and keeps the parent; the retry removes it', async (_label, ns) => {
    const subject = `user:f19j-ana-${n}`;
    const theirs = await connectionWithChildren('user', subject);
    const storage = hostExtStorage();
    const del = storage.kvDelete.bind(storage);
    let failed = false;
    const spy = vi.spyOn(storage, 'kvDelete').mockImplementation(async (key) => {
      if (!failed && key === `hostext:${ns}:${theirs.conn.connectionId}`) {
        failed = true;
        throw new Error(`injected ${ns} delete failure`);
      }
      return del(key);
    });
    let first: Awaited<ReturnType<typeof eraseSubject>>;
    try { first = await eraseSubject(h.ws, subject); } finally { spy.mockRestore(); }
    expect(failed, 'the injection fired').toBe(true);
    expect(first.failed, 'the first pass reports the failure').toBeGreaterThan(0);
    expect(await getConnection(h.ws, theirs.conn.connectionId), 'the parent stays for the retry').not.toBeNull();

    await eraseSubject(h.ws, subject);
    expect(await getPairing(theirs.conn.connectionId)).toBeNull();
    expect(await hasInboundSession(theirs.conn.connectionId)).toBe(false);
    expect(await getConnection(h.ws, theirs.conn.connectionId)).toBeNull();
  });

  it('K4 the lane settings go even when the revoke itself fails (the subject branch, not the orphan sweep)', async () => {
    const subject = `user:f19j-bia-${n}`;
    const theirs = await connectionWithChildren('user', subject);
    const storage = hostExtStorage();
    const del = storage.kvDelete.bind(storage);
    let failed = false;
    const spy = vi.spyOn(storage, 'kvDelete').mockImplementation(async (key) => {
      if (!failed && key === `hostext:connections:connection:${theirs.conn.connectionId}`) {
        failed = true;
        throw new Error('injected connection delete failure');
      }
      return del(key);
    });
    try { await eraseSubject(h.ws, subject); } finally { spy.mockRestore(); }
    expect(failed, 'the injection fired').toBe(true);
    expect(await getConnection(h.ws, theirs.conn.connectionId), 'non-vacuity: the parent survived').not.toBeNull();
    expect(await getChannelSettings(theirs.laneKey)).toBeNull();
  });

  it('K3 lane settings of a connection that is already gone are deleted; a relay lane\'s are kept', async () => {
    const orphan = laneKeyOf({ kind: 'connection', connectionId: `conn-f19j-gone-${n++}`, provider: 'telegram' });
    await putChannelSettings({ laneKey: orphan, tenantId: h.ws, botHandle: 'someone_personal', updatedAt: new Date().toISOString() });
    const relay = laneKeyOf({ kind: 'relay', relayId: `relay-f19j-${n++}`, channel: 'whatsapp' });
    await putChannelSettings({ laneKey: relay, tenantId: h.ws, agentId: 'agent-x', updatedAt: new Date().toISOString() });

    await eraseSubject(h.ws, `user:f19j-anyone-${n}`);

    expect(await getChannelSettings(orphan)).toBeNull();
    expect(await getChannelSettings(relay)).not.toBeNull();
  });
});
