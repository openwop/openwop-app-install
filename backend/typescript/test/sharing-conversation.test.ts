/**
 * ADR 0122 Phase 1 — `conversation` share resolver.
 * Mint a public link to a conversation, resolve the sanitized read-only transcript
 * snapshot (ADR 0119 render), and confirm revoke makes it go dark (404).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { sharingFeature } from '../src/features/sharing/feature.js';
import { createLink, resolveShared, revokeLink } from '../src/features/sharing/sharingService.js';
import { ensureConversationMeta } from '../src/host/conversationStore.js';

const T = 'shc-tenant';
const ORG = 'org-shc';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-shareconv-')) });
  initHostExtPersistence(await openStorage('memory://'));
  if (sharingFeature.toggleDefault) {
    registerToggleDefault(sharingFeature.toggleDefault); // no app boot in a service test
    await saveConfig({ ...sharingFeature.toggleDefault, status: 'on' }, 'test');
  }
  await createOrg({ tenantId: T, createdBy: 'u1', name: 'Org', orgId: ORG });
  const now = new Date().toISOString();
  await hostExtStorage().createChatSession({ sessionId: 'conv-1', tenantId: T, title: 'Roadmap chat', createdAt: now, updatedAt: now, messageCount: 0 });
  await hostExtStorage().appendChatMessage({ messageId: 'm0', sessionId: 'conv-1', role: 'user', content: 'what is the roadmap', meta: null, authorSubject: 'user:u1', createdAt: now });
  await hostExtStorage().appendChatMessage({ messageId: 'm1', sessionId: 'conv-1', role: 'assistant', content: 'the roadmap is ambitious', meta: null, authorSubject: null, createdAt: now });
});

describe('conversation share resolver', () => {
  it('mints + resolves a read-only transcript snapshot', async () => {
    const link = await createLink(T, ORG, 'u1', { resourceType: 'conversation', resourceId: 'conv-1' });
    const resolved = await resolveShared(link.token);
    expect(resolved.resourceType).toBe('conversation');
    expect(resolved.resource.kind).toBe('conversation');
    expect(resolved.resource.title).toBe('Roadmap chat');
    expect(resolved.resource.messageCount).toBe(2);
    expect(String(resolved.resource.markdown)).toContain('the roadmap is ambitious'); // rendered transcript
  });

  it('owner-only mint (ADR 0122 Phase 2): a non-owner cannot share an owned conversation', async () => {
    const now = new Date().toISOString();
    await hostExtStorage().createChatSession({ sessionId: 'conv-owned', tenantId: T, title: 'Owned', createdAt: now, updatedAt: now, messageCount: 0 });
    await ensureConversationMeta(T, 'conv-owned', { type: 'agent', ownerUserId: 'alice' });
    // bob (a tenant member) cannot mint a link to alice's conversation.
    await expect(createLink(T, ORG, 'bob', { resourceType: 'conversation', resourceId: 'conv-owned' })).rejects.toMatchObject({ code: 'forbidden' });
    // alice (the owner) can.
    const link = await createLink(T, ORG, 'alice', { resourceType: 'conversation', resourceId: 'conv-owned' });
    expect(link.token).toBeTruthy();
  });

  it('404s minting a non-existent conversation', async () => {
    await expect(createLink(T, ORG, 'u1', { resourceType: 'conversation', resourceId: 'nope' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('snapshot-up-to-marker (ADR 0122 Phase 3): a later turn is NOT exposed', async () => {
    const sid = 'conv-snap';
    await hostExtStorage().createChatSession({ sessionId: sid, tenantId: T, title: 'Snap', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', messageCount: 0 });
    await hostExtStorage().appendChatMessage({ messageId: `${sid}-m1`, sessionId: sid, role: 'user', content: 'BEFORE the share', meta: null, authorSubject: null, createdAt: '2020-01-01T00:00:00.000Z' });
    const link = await createLink(T, ORG, 'u1', { resourceType: 'conversation', resourceId: sid }); // createdAt = now (2026)
    // a private turn added AFTER the link was minted
    await hostExtStorage().appendChatMessage({ messageId: `${sid}-m2`, sessionId: sid, role: 'user', content: 'AFTER the share — private', meta: null, authorSubject: null, createdAt: '2030-01-01T00:00:00.000Z' });
    const { resource } = await resolveShared(link.token);
    expect(String(resource.markdown)).toContain('BEFORE the share');
    expect(String(resource.markdown)).not.toContain('AFTER the share'); // later turn stays private
    expect(resource.messageCount).toBe(1);
  });

  it('goes dark (404) after revoke', async () => {
    const link = await createLink(T, ORG, 'u1', { resourceType: 'conversation', resourceId: 'conv-1' });
    await revokeLink(T, ORG, link.token);
    await expect(resolveShared(link.token)).rejects.toMatchObject({ code: 'not_found' });
  });
});
