/**
 * ADR 0126 Phase 1 — team-channel service (a conversation type:'channel'), and
 * the CHN-1/CHN-2/CHN-3 authorization policy at the service layer:
 *  - management is fail-closed OWNER-only, decided by the `ownerUserId` stamp
 *    (`isChannelOwner`), never by membership — a member is 403, a private-
 *    channel non-member is 404-masked, an ownerless legacy channel denies
 *    everyone (no membership fallback), and the owner cannot be removed;
 *  - reads are membership-gated (404 mask) and an undefined caller never reads
 *    (CHN-3); `assertChannelAccess` (the presence gate) is DEFAULT-DENY 403;
 *  - archived channels drop out of the viewer's channel list.
 * Sabotage-witnessed (wave 26): `isChannelOwner` → false, the 403 throw →
 * return, the 404 mask → off, an ownerless fallback, the owner-removal guard,
 * the archived filter, and the public/private access branches each red the
 * matching case.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { userRef } from '../src/host/conversationStore.js';
import { createMember } from '../src/host/accessControlService.js';
import { createChannel, listChannelsForViewer, getChannel, renameChannel, archiveChannel, addChannelMember, removeChannelMember, assertChannelAccess } from '../src/features/channels/channelService.js';

/** ADR 0879 D1 — a caller holding `workspace:write` (not an admin): the service-level
 *  witnesses below exercise the channel rules, not the role gate (route tests do). */
const FULL_AUTHORITY = { canWrite: true, isAdmin: false };

const T = 'ch-tenant';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-channels-')) });
  initHostExtPersistence(await openStorage('memory://'));
  // ADR 0879 D4 — only a workspace member can be added to a channel.
  for (const subject of ['bob', 'mallory', 'friend']) await createMember({ orgId: T, tenantId: T, displayName: subject, subject, roles: ['editor'] });
});

const OWNER = 'user:owner';

describe('channel service', () => {
  it('creates a channel as a type:channel conversation', async () => {
    const ch = await createChannel(T, OWNER, { name: 'general', description: 'team-wide', visibility: 'public' }, FULL_AUTHORITY);
    expect(ch.type).toBe('channel');
    expect(ch.channel).toMatchObject({ name: 'general', description: 'team-wide', visibility: 'public' });
    expect(await getChannel(T, ch.conversationId, OWNER)).not.toBeNull();
  });

  it('requires a name', async () => {
    await expect(createChannel(T, OWNER, { visibility: 'public' }, FULL_AUTHORITY)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('lists non-archived channels; archive hides it', async () => {
    const ch = await createChannel(T, OWNER, { name: 'temp' }, FULL_AUTHORITY);
    expect((await listChannelsForViewer(T, OWNER)).some((c) => c.conversationId === ch.conversationId)).toBe(true);
    await archiveChannel(T, ch.conversationId, OWNER, FULL_AUTHORITY);
    expect((await listChannelsForViewer(T, OWNER)).some((c) => c.conversationId === ch.conversationId)).toBe(false);
  });

  it('renames a channel', async () => {
    const ch = await createChannel(T, OWNER, { name: 'old' }, FULL_AUTHORITY);
    const renamed = await renameChannel(T, ch.conversationId, OWNER, FULL_AUTHORITY, 'new-name');
    expect(renamed.channel!.name).toBe('new-name');
  });

  it('adds + removes a member', async () => {
    const ch = await createChannel(T, OWNER, { name: 'members' }, FULL_AUTHORITY);
    const withMember = await addChannelMember(T, ch.conversationId, OWNER, FULL_AUTHORITY, 'bob');
    expect(withMember.participants.some((p) => p.subjectRef === 'user:bob')).toBe(true);
    const without = await removeChannelMember(T, ch.conversationId, OWNER, FULL_AUTHORITY, 'bob');
    expect(without.participants.some((p) => p.subjectRef === 'user:bob')).toBe(false);
  });

  it('404s a non-channel / missing id', async () => {
    await expect(getChannel(T, 'does-not-exist', OWNER)).rejects.toMatchObject({ code: 'not_found' });
  });
});

// CHN-1/CHN-2 — management is fail-closed owner-only; reads are membership-gated.
describe('channel management authorization (CHN-1/CHN-2)', () => {
  it('the owner manages through the ownerUserId stamp (and is stored as the owner-role participant)', async () => {
    const ch = await createChannel(T, OWNER, { name: 'owned', visibility: 'private' }, FULL_AUTHORITY);
    // ensureConversationMeta records the owner as an owner-role participant
    // under the RFC 0041 ref of the raw caller id (`user:` + 'user:owner').
    expect(ch.ownerUserId).toBe(OWNER);
    expect(ch.participants.filter((p) => p.role === 'owner').map((p) => p.subjectRef)).toEqual([userRef(OWNER)]);
    await expect(renameChannel(T, ch.conversationId, OWNER, FULL_AUTHORITY, 'owned2')).resolves.toBeTruthy();
    await expect(getChannel(T, ch.conversationId, OWNER)).resolves.toBeTruthy();
  });

  it('a member who is not the owner is 403 on manage (knows it exists)', async () => {
    const ch = await createChannel(T, OWNER, { name: 'mem-not-owner', visibility: 'private' }, FULL_AUTHORITY);
    await addChannelMember(T, ch.conversationId, OWNER, FULL_AUTHORITY, 'mallory'); // mallory is a member (participant user:mallory)
    // The caller id is the RAW principal id; the service applies userRef() internally.
    await expect(renameChannel(T, ch.conversationId, 'mallory', FULL_AUTHORITY, 'x')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(addChannelMember(T, ch.conversationId, 'mallory', FULL_AUTHORITY, 'evil')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a non-member is 404-masked on manage AND read of a private channel (no existence leak)', async () => {
    const ch = await createChannel(T, OWNER, { name: 'priv-mask', visibility: 'private' }, FULL_AUTHORITY);
    await expect(renameChannel(T, ch.conversationId, 'user:stranger', FULL_AUTHORITY, 'x')).rejects.toMatchObject({ code: 'not_found' });
    await expect(addChannelMember(T, ch.conversationId, 'user:stranger', FULL_AUTHORITY, 'self')).rejects.toMatchObject({ code: 'not_found' });
    await expect(getChannel(T, ch.conversationId, 'user:stranger')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('an ownerless legacy channel denies management to everyone (fail-closed, no membership fallback)', async () => {
    const ch = await createChannel(T, undefined, { name: 'ownerless', visibility: 'public' }, FULL_AUTHORITY);
    expect(ch.ownerUserId).toBeUndefined();
    await expect(renameChannel(T, ch.conversationId, 'user:anyone', FULL_AUTHORITY, 'x')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('the owner cannot be removed (would orphan the channel)', async () => {
    const ch = await createChannel(T, OWNER, { name: 'no-orphan', visibility: 'public' }, FULL_AUTHORITY);
    await addChannelMember(T, ch.conversationId, OWNER, FULL_AUTHORITY, 'user:owner'); // owner self-joins for messaging
    await expect(removeChannelMember(T, ch.conversationId, OWNER, FULL_AUTHORITY, OWNER)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('an undefined caller cannot read a channel (CHN-3, no anon)', async () => {
    const ch = await createChannel(T, OWNER, { name: 'pub-anon', visibility: 'public' }, FULL_AUTHORITY);
    await expect(getChannel(T, ch.conversationId, undefined)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('assertChannelAccess (ADR 0126 Phase 4 presence gate)', () => {
  it('a public channel admits any tenant member + returns the user: ref', async () => {
    const ch = await createChannel(T, 'owner', { name: 'pub', visibility: 'public' }, FULL_AUTHORITY);
    await expect(assertChannelAccess(T, ch.conversationId, 'anyone')).resolves.toEqual({ ref: 'user:anyone' });
  });
  it('a private channel denies a non-member (403, DEFAULT-DENY) and admits after add', async () => {
    const ch = await createChannel(T, 'owner', { name: 'priv', visibility: 'private' }, FULL_AUTHORITY);
    await expect(assertChannelAccess(T, ch.conversationId, 'stranger')).rejects.toMatchObject({ code: 'forbidden' });
    await addChannelMember(T, ch.conversationId, 'owner', FULL_AUTHORITY, 'friend'); // owner adds the member
    await expect(assertChannelAccess(T, ch.conversationId, 'friend')).resolves.toEqual({ ref: 'user:friend' });
  });
  it('an undefined viewer is denied on a private channel', async () => {
    const ch = await createChannel(T, 'owner', { name: 'priv2', visibility: 'private' }, FULL_AUTHORITY);
    await expect(assertChannelAccess(T, ch.conversationId, undefined)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('a non-existent channel is 404', async () => {
    await expect(assertChannelAccess(T, 'nope-nope', 'x')).rejects.toMatchObject({ code: 'not_found' });
  });
});
