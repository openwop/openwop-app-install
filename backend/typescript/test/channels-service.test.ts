/**
 * ADR 0126 Phase 1 — team-channel service (a conversation type:'channel').
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createChannel, listChannels, getChannel, renameChannel, archiveChannel, addChannelMember, removeChannelMember, assertChannelAccess } from '../src/features/channels/channelService.js';

const T = 'ch-tenant';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-channels-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

const OWNER = 'user:owner';

describe('channel service', () => {
  it('creates a channel as a type:channel conversation', async () => {
    const ch = await createChannel(T, OWNER, { name: 'general', description: 'team-wide', visibility: 'public' });
    expect(ch.type).toBe('channel');
    expect(ch.channel).toMatchObject({ name: 'general', description: 'team-wide', visibility: 'public' });
    expect(await getChannel(T, ch.conversationId, OWNER)).not.toBeNull();
  });

  it('requires a name', async () => {
    await expect(createChannel(T, OWNER, { visibility: 'public' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('lists non-archived channels; archive hides it', async () => {
    const ch = await createChannel(T, OWNER, { name: 'temp' });
    expect((await listChannels(T)).some((c) => c.conversationId === ch.conversationId)).toBe(true);
    await archiveChannel(T, ch.conversationId, OWNER);
    expect((await listChannels(T)).some((c) => c.conversationId === ch.conversationId)).toBe(false);
  });

  it('renames a channel', async () => {
    const ch = await createChannel(T, OWNER, { name: 'old' });
    const renamed = await renameChannel(T, ch.conversationId, OWNER, 'new-name');
    expect(renamed.channel!.name).toBe('new-name');
  });

  it('adds + removes a member', async () => {
    const ch = await createChannel(T, OWNER, { name: 'members' });
    const withMember = await addChannelMember(T, ch.conversationId, OWNER, 'bob');
    expect(withMember.participants.some((p) => p.subjectRef === 'user:bob')).toBe(true);
    const without = await removeChannelMember(T, ch.conversationId, OWNER, 'bob');
    expect(without.participants.some((p) => p.subjectRef === 'user:bob')).toBe(false);
  });

  it('404s a non-channel / missing id', async () => {
    await expect(getChannel(T, 'does-not-exist', OWNER)).rejects.toMatchObject({ code: 'not_found' });
  });
});

// CHN-1/CHN-2 — management is fail-closed owner-only; reads are membership-gated.
describe('channel management authorization (CHN-1/CHN-2)', () => {
  it('the owner can manage even though not stored as a participant', async () => {
    const ch = await createChannel(T, OWNER, { name: 'owned', visibility: 'private' });
    expect(ch.participants.some((p) => p.subjectRef === OWNER)).toBe(false); // owner is NOT auto-added
    await expect(renameChannel(T, ch.conversationId, OWNER, 'owned2')).resolves.toBeTruthy();
    await expect(getChannel(T, ch.conversationId, OWNER)).resolves.toBeTruthy();
  });

  it('a member who is not the owner is 403 on manage (knows it exists)', async () => {
    const ch = await createChannel(T, OWNER, { name: 'mem-not-owner', visibility: 'private' });
    await addChannelMember(T, ch.conversationId, OWNER, 'mallory'); // mallory is a member (participant user:mallory)
    // The caller id is the RAW principal id; the service applies userRef() internally.
    await expect(renameChannel(T, ch.conversationId, 'mallory', 'x')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(addChannelMember(T, ch.conversationId, 'mallory', 'evil')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a non-member is 404-masked on manage AND read of a private channel (no existence leak)', async () => {
    const ch = await createChannel(T, OWNER, { name: 'priv-mask', visibility: 'private' });
    await expect(renameChannel(T, ch.conversationId, 'user:stranger', 'x')).rejects.toMatchObject({ code: 'not_found' });
    await expect(addChannelMember(T, ch.conversationId, 'user:stranger', 'self')).rejects.toMatchObject({ code: 'not_found' });
    await expect(getChannel(T, ch.conversationId, 'user:stranger')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('an ownerless legacy channel denies management to everyone (fail-closed, no membership fallback)', async () => {
    const ch = await createChannel(T, undefined, { name: 'ownerless', visibility: 'public' });
    expect(ch.ownerUserId).toBeUndefined();
    await expect(renameChannel(T, ch.conversationId, 'user:anyone', 'x')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('the owner cannot be removed (would orphan the channel)', async () => {
    const ch = await createChannel(T, OWNER, { name: 'no-orphan', visibility: 'public' });
    await addChannelMember(T, ch.conversationId, OWNER, 'user:owner'); // owner self-joins for messaging
    await expect(removeChannelMember(T, ch.conversationId, OWNER, OWNER)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('an undefined caller cannot read a channel (CHN-3, no anon)', async () => {
    const ch = await createChannel(T, OWNER, { name: 'pub-anon', visibility: 'public' });
    await expect(getChannel(T, ch.conversationId, undefined)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('assertChannelAccess (ADR 0126 Phase 4 presence gate)', () => {
  it('a public channel admits any tenant member + returns the user: ref', async () => {
    const ch = await createChannel(T, 'owner', { name: 'pub', visibility: 'public' });
    await expect(assertChannelAccess(T, ch.conversationId, 'anyone')).resolves.toEqual({ ref: 'user:anyone' });
  });
  it('a private channel denies a non-member (403, DEFAULT-DENY) and admits after add', async () => {
    const ch = await createChannel(T, 'owner', { name: 'priv', visibility: 'private' });
    await expect(assertChannelAccess(T, ch.conversationId, 'stranger')).rejects.toMatchObject({ code: 'forbidden' });
    await addChannelMember(T, ch.conversationId, 'owner', 'friend'); // owner adds the member
    await expect(assertChannelAccess(T, ch.conversationId, 'friend')).resolves.toEqual({ ref: 'user:friend' });
  });
  it('an undefined viewer is denied on a private channel', async () => {
    const ch = await createChannel(T, 'owner', { name: 'priv2', visibility: 'private' });
    await expect(assertChannelAccess(T, ch.conversationId, undefined)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('a non-existent channel is 404', async () => {
    await expect(assertChannelAccess(T, 'nope-nope', 'x')).rejects.toMatchObject({ code: 'not_found' });
  });
});
