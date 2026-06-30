/**
 * ADR 0154 FU-6 — the live chat-message bus: appendChatMessageLive persists the
 * message AND publishes a per-conversation live-delivery event.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { appendChatMessageLive, subscribeConversationMessages } from '../src/host/chatMessageBus.js';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-chbus-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('chatMessageBus', () => {
  it('appendChatMessageLive persists the message AND publishes a per-conversation event', async () => {
    const seen: string[] = [];
    const unsub = await subscribeConversationMessages('c1', (id) => seen.push(id));
    const now = new Date().toISOString();
    await hostExtStorage().createChatSession({ sessionId: 'c1', tenantId: 't', title: 'c', createdAt: now, updatedAt: now, messageCount: 0 });
    await appendChatMessageLive({ messageId: 'm1', sessionId: 'c1', role: 'user', content: 'hi', meta: null, authorSubject: 'user:a', createdAt: now });
    await new Promise((r) => setTimeout(r, 10)); // let the fire-and-forget publish flush

    expect(seen).toContain('m1');
    const msgs = await hostExtStorage().listChatSessionMessages('c1');
    expect(msgs.map((m) => m.messageId)).toContain('m1');
    await unsub();
  });

  it('does not deliver another conversation\'s messages, and stops after unsubscribe', async () => {
    const seen: string[] = [];
    const unsub = await subscribeConversationMessages('c1', (id) => seen.push(id));
    const now = new Date().toISOString();
    // A different conversation — must NOT reach c1's subscriber.
    await hostExtStorage().createChatSession({ sessionId: 'c2', tenantId: 't', title: 'c2', createdAt: now, updatedAt: now, messageCount: 0 });
    await appendChatMessageLive({ messageId: 'other', sessionId: 'c2', role: 'user', content: 'x', meta: null, authorSubject: 'user:a', createdAt: now });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).not.toContain('other');

    await unsub();
    await appendChatMessageLive({ messageId: 'after', sessionId: 'c1', role: 'user', content: 'y', meta: null, authorSubject: 'user:a', createdAt: now });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).not.toContain('after');
  });
});
