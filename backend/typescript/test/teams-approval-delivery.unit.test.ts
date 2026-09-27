/**
 * Teams approval-card delivery (ADR 0198 Phase B).
 *
 * SERVICE: the delivery filter (action-needed + addressed only), the pref
 * store, the adaptive-card message shape, and the fail-closed no-op paths —
 * with the transport faked (the real one is brokeredFetch, the credential
 * authority; its own guarantees are covered by the brokered-egress suite).
 * HTTP: the self-service pref routes (signed-in only; per-user; tenant-scoped).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  setTeamsDeliveryPref,
  clearTeamsDeliveryPref,
  deliverTeamsApprovalCard,
  buildApprovalCardMessage,
  setTeamsDeliveryTransportForTest,
  type TeamsDeliveryTransport,
} from '../src/host/teamsApprovalDelivery.js';
import type { NotificationRecord } from '../src/types.js';
import type { Storage } from '../src/storage/storage.js';

const T = 'tenant-teams';

function record(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    notificationId: 'ntf-1',
    tenantId: T,
    type: 'openwop-app.workflow.approval-needed',
    priority: 'high',
    status: 'unread',
    title: 'Approve release v2',
    message: 'Sign-off requested for the Q3 release.',
    createdAt: new Date().toISOString(),
    recipientUserId: 'usr-alice',
    ...overrides,
  } as NotificationRecord;
}

describe('teams approval delivery — service (faked transport)', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => { initHostExtPersistence(storage); });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });
  afterEach(async () => {
    setTeamsDeliveryTransportForTest(null);
    await clearTeamsDeliveryPref(T, 'usr-alice');
  });

  function captureTransport(): { calls: Parameters<TeamsDeliveryTransport>[0][] } {
    const calls: Parameters<TeamsDeliveryTransport>[0][] = [];
    setTeamsDeliveryTransportForTest(async (opts) => { calls.push(opts); });
    return { calls };
  }

  it('delivers an addressed action-needed notification to the recipient pref, via THEIR identity', async () => {
    await setTeamsDeliveryPref({ tenantId: T, userId: 'usr-alice', connectionId: 'conn-1', chatId: '19:chat' });
    const { calls } = captureTransport();
    const sent = await deliverTeamsApprovalCard(storage as unknown as Storage, record());
    expect(sent).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.actingUserId).toBe('usr-alice');
    expect(calls[0]!.chatId).toBe('19:chat');
    expect(calls[0]!.correlationId).toBe('notification:ntf-1');
  });

  it('no-ops (silently) without a pref, for broadcasts, and for non-action-needed types', async () => {
    const { calls } = captureTransport();
    expect(await deliverTeamsApprovalCard(storage as unknown as Storage, record())).toBe(false); // no pref
    await setTeamsDeliveryPref({ tenantId: T, userId: 'usr-alice', connectionId: 'conn-1', chatId: '19:chat' });
    const broadcast = record();
    delete (broadcast as { recipientUserId?: string }).recipientUserId;
    expect(await deliverTeamsApprovalCard(storage as unknown as Storage, broadcast)).toBe(false); // broadcast
    expect(await deliverTeamsApprovalCard(storage as unknown as Storage, record({ type: 'workflow.completed' }))).toBe(false); // wrong type
    expect(calls).toHaveLength(0);
  });

  it('a cross-tenant pref never matches', async () => {
    await setTeamsDeliveryPref({ tenantId: 'other-tenant', userId: 'usr-alice', connectionId: 'conn-1', chatId: '19:chat' });
    const { calls } = captureTransport();
    expect(await deliverTeamsApprovalCard(storage as unknown as Storage, record())).toBe(false);
    expect(calls).toHaveLength(0);
    await clearTeamsDeliveryPref('other-tenant', 'usr-alice');
  });

  it('the card carries the title, the message, and ONLY a deep-link action (no decision surface)', () => {
    const msg = buildApprovalCardMessage(record(), 'https://app.example/inbox');
    const attachments = msg.attachments as Array<{ contentType: string; content: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
    const card = JSON.parse(attachments[0]!.content) as { body: Array<{ text: string }>; actions: Array<{ type: string; url: string }> };
    expect(card.body[0]!.text).toBe('Approve release v2');
    expect(card.body[1]!.text).toContain('Q3 release');
    expect(card.actions).toHaveLength(1);
    expect(card.actions[0]!.type).toBe('Action.OpenUrl');
    expect(card.actions[0]!.url).toBe('https://app.example/inbox');
  });
});
