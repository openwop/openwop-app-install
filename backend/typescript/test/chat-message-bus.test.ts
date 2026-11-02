/**
 * ADR 0154 FU-6 — the live chat-message bus: appendChatMessageLive persists the
 * message AND publishes a per-conversation live-delivery event.
 *
 * Tracker TST-CEC-4. Red when (w67g3, witnessed): `appendChatMessageLive` stops
 * publishing; the publish channel drops the conversation id; a subscriber
 * listens on the bare prefix instead of its own conversation's channel.
 * Every negative ("not delivered") is asserted only after a positive control on
 * the same bus has arrived, so a bus that delivers nothing cannot pass it. No
 * fixed sleeps: each wait is on the delivery itself. Each case owns its sessions.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { appendChatMessageLive, subscribeConversationMessages } from '../src/host/chatMessageBus.js';

const T = '2026-10-29T12:00:00.000Z';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-chbus-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

async function session(id: string): Promise<void> {
  await hostExtStorage().createChatSession({ sessionId: id, tenantId: 't', title: id, createdAt: T, updatedAt: T, messageCount: 0 });
}
const append = (sessionId: string, messageId: string) =>
  appendChatMessageLive({ messageId, sessionId, role: 'user', content: messageId, meta: null, authorSubject: 'user:a', createdAt: T });

describe('chatMessageBus', () => {
  it('appendChatMessageLive persists the message AND publishes a per-conversation event', async () => {
    await session('bus-a');
    const seen: string[] = [];
    const unsub = await subscribeConversationMessages('bus-a', (id) => seen.push(id));
    await append('bus-a', 'm1');

    await vi.waitFor(() => expect(seen).toEqual(['m1']));
    const msgs = await hostExtStorage().listChatSessionMessages('bus-a');
    expect(msgs.map((m) => m.messageId)).toEqual(['m1']);
    await unsub();
  });

  it('does not deliver another conversation\'s messages, and stops after unsubscribe', async () => {
    await session('bus-b');
    await session('bus-b-other');
    const seen: string[] = [];
    const unsub = await subscribeConversationMessages('bus-b', (id) => seen.push(id));

    // A different conversation — must NOT reach bus-b's subscriber. The control
    // append to bus-b proves the subscriber is live before the absence is read.
    await append('bus-b-other', 'other');
    await append('bus-b', 'control');
    await vi.waitFor(() => expect(seen).toContain('control'));
    expect(seen).toEqual(['control']);

    await unsub();
    // A second, still-subscribed listener is the control for the unsubscribe leg.
    const seen2: string[] = [];
    const unsub2 = await subscribeConversationMessages('bus-b', (id) => seen2.push(id));
    await append('bus-b', 'after');
    await vi.waitFor(() => expect(seen2).toContain('after'));
    expect(seen).toEqual(['control']);
    await unsub2();
  });
});
