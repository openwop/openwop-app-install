/**
 * ADR 0982 D1 — where the extraction lane may run, and for whom (`resolveExtractionLane`).
 *
 * The lane writes into ONE place: the person's own memory in their personal `user:` tenant, keyed
 * on their canonical `User.userId`, which is where the Personal Memory route lists notes and the
 * DSAR eraser looks. Every other run shape is a typed skip with no read past the check that
 * refused it. The cases are built through the real seams (`helpers/personalChatRun.ts`).
 *
 * Witnessed (row 57 sabotage, see the PR): dropping the personal-tenant check reds the shared and
 * anon cases; dropping either client check reds its case; accepting a bare `chatSessionId` stamp
 * reds `not-a-chat`; dropping the spelling check reds the operator-bearer case; dropping the
 * split-row arm reds the legacy case.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { ensureConversationMeta } from '../src/host/conversationStore.js';
import { resolveCanonicalUserForTenant, userIdFor, type User } from '../src/features/users/usersService.js';
import { resolveExtractionLane } from '../src/features/memory-auto-extract/extractionBinding.js';
import { personalChat } from './helpers/personalChatRun.js';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0982-lane-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ADR 0982 D1 — resolveExtractionLane', () => {
  it('the person\'s own persisted chat resolves to their canonical id, bound or not', async () => {
    const p = await personalChat('ln-ok');
    expect(await resolveExtractionLane(await p.run())).toEqual({ ok: true, tenantId: p.home, userId: p.userId });
    expect(await resolveExtractionLane(await p.run({ acting: p.principal }))).toEqual({ ok: true, tenantId: p.home, userId: p.userId });
  });

  it('a shared workspace, an anon sandbox or a deployment tenant is not-personal', async () => {
    for (const tenantId of ['ws:team-9', 'anon:sess-9', 'default', 'host-kicktodo']) {
      expect(await resolveExtractionLane({ tenantId, metadata: { actingUserId: 'user:x', chatSessionId: 'c' } }), tenantId)
        .toEqual({ ok: false, reason: 'not-personal' });
    }
  });

  it('a client binding on the run OR on the conversation is client-bound (ADR 0944)', async () => {
    const p = await personalChat('ln-client');
    expect(await resolveExtractionLane(await p.run({ metadata: { 'openwop-app.campaignOps': { orgId: 'org-a' } } })))
      .toEqual({ ok: false, reason: 'client-bound' });
    const run = await p.run({ chat: false });
    await ensureConversationMeta(p.home, run.metadata!['chatSessionId'] as string, { type: 'agent', ownerUserId: p.userId, client: { orgId: 'org-b', name: 'B' } });
    expect(await resolveExtractionLane(run)).toEqual({ ok: false, reason: 'client-bound' });
  });

  it('a run with no server-side conversation record is not-a-chat, even with a stamp (architect A3)', async () => {
    const p = await personalChat('ln-chat');
    expect(await resolveExtractionLane(await p.run({ chat: false }))).toEqual({ ok: false, reason: 'not-a-chat' });
    const arena = await p.run();
    delete arena.metadata!['chatSessionId'];
    expect(await resolveExtractionLane(arena)).toEqual({ ok: false, reason: 'not-a-chat' });
  });

  it('a conversation that is not the person\'s alone is not-a-chat (MAE2CD-8)', async () => {
    const p = await personalChat('ln-solo');
    // Another human participant (a member of the personal workspace).
    const shared = await p.run({ chat: false });
    await ensureConversationMeta(p.home, shared.metadata!['chatSessionId'] as string, { type: 'group', ownerUserId: p.userId, participants: ['user:member-1', 'agent:iris'] });
    expect(await resolveExtractionLane(shared)).toEqual({ ok: false, reason: 'not-a-chat' });
    // Owned by someone else.
    const theirs = await p.run({ chat: false });
    await ensureConversationMeta(p.home, theirs.metadata!['chatSessionId'] as string, { type: 'agent', ownerUserId: 'user:member-1' });
    expect(await resolveExtractionLane(theirs)).toEqual({ ok: false, reason: 'not-a-chat' });
    // No owner at all (a legacy, tenant-visible conversation any member may write to).
    const ownerless = await p.run({ chat: false });
    await ensureConversationMeta(p.home, ownerless.metadata!['chatSessionId'] as string, { type: 'agent' });
    expect(await resolveExtractionLane(ownerless)).toEqual({ ok: false, reason: 'not-a-chat' });
    // Anti-rot: the person plus an agent participant is still theirs alone.
    const withAgent = await p.run({ chat: false });
    await ensureConversationMeta(p.home, withAgent.metadata!['chatSessionId'] as string, { type: 'agent', ownerUserId: p.userId, participants: ['agent:iris'] });
    expect(await resolveExtractionLane(withAgent)).toMatchObject({ ok: true });
  });

  it('an actor that is not this tenant\'s person is no-person (an operator bearer, a stranger)', async () => {
    const p = await personalChat('ln-actor');
    for (const acting of ['bearer:operator', 'oidc:someone-else', 'user:0123456789abcdef0123456789abcdef']) {
      expect(await resolveExtractionLane(await p.run({ acting })), acting).toEqual({ ok: false, reason: 'no-person' });
    }
  });

  it('a person with legacy split rows is still recognised, and keyed on the canonical row (architect A7)', async () => {
    const home = 'user:ln-split-home';
    const principal = 'oidc:ln-split';
    // A randomUUID-era row for this identity, written as the legacy lane wrote it.
    const users = new DurableCollection<User>('users:user', (u) => u.userId);
    const legacyId = 'user:legacy0000000000000000000000000';
    await users.put({ userId: legacyId, tenantId: home, principalId: principal, source: 'oidc', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as User);
    const canonical = await resolveCanonicalUserForTenant({ homeTenant: home, principalId: principal, source: 'oidc' });
    expect(canonical.userId, 'precondition: the fold adopted the legacy row').toBe(legacyId);
    // The bind later mints the deterministic row, and the session acts as THAT row.
    // Written directly: `createUser` dedupes by principal, which is exactly why the split exists
    // only in rows written before that dedupe.
    const bound = { userId: userIdFor(home, principal), tenantId: home, principalId: principal, source: 'oidc', status: 'active', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' } as User;
    await users.put(bound);
    expect(bound.userId).not.toBe(legacyId);
    await ensureConversationMeta(home, 'chat-split', { type: 'agent', ownerUserId: bound.userId });
    const lane = await resolveExtractionLane({ tenantId: home, metadata: { actingUserId: bound.userId, chatSessionId: 'chat-split' } });
    expect(lane).toEqual({ ok: true, tenantId: home, userId: legacyId });
  });
});
