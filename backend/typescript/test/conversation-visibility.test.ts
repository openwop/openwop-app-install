/**
 * CS-BE-5 (conversation-stack audit 2026-07-09) — direct unit coverage for the
 * conversation visibility predicates. These gate every conversation read (rail,
 * session routes, voice transcript stream, and — since CS-BE-1 — the interrupt
 * resolve path), yet had NO direct tests. Pins:
 *  - legacy/unowned tenant-visibility (back-compat)
 *  - owned fail-closed for anonymous + stranger callers
 *  - owner + participant grants
 *  - channel semantics (public = any authenticated tenant caller; private =
 *    owner/participant; anon always denied)
 *  - rail-list narrowing (public channel readable ≠ rail-listed)
 *  - isVisibleToAsync fallback to the sync predicate when no subject resolver
 */
import { describe, expect, it } from 'vitest';
import { isVisibleTo, isRailListed, isVisibleToAsync } from '../src/host/conversationVisibility.js';
import { userRef, type ConversationMeta } from '../src/host/conversationStore.js';

const ts = '2026-07-09T00:00:00.000Z';
function meta(over: Partial<ConversationMeta>): ConversationMeta {
  return {
    conversationId: 'c1', tenantId: 't1', type: 'agent',
    participants: [], createdAt: ts, updatedAt: ts,
    ...over,
  } as ConversationMeta;
}

describe('isVisibleTo — ownership predicate', () => {
  it('null meta (legacy, pre-model) is tenant-visible to anyone', () => {
    expect(isVisibleTo(null, 'anyone')).toBe(true);
    expect(isVisibleTo(null, undefined)).toBe(true);
  });
  it('unowned meta stays tenant-visible', () => {
    expect(isVisibleTo(meta({}), 'stranger')).toBe(true);
  });
  it('owned meta denies an anonymous caller (fail-closed)', () => {
    expect(isVisibleTo(meta({ ownerUserId: 'alice' }), undefined)).toBe(false);
  });
  it('owned meta denies a same-tenant stranger', () => {
    expect(isVisibleTo(meta({ ownerUserId: 'alice' }), 'mallory')).toBe(false);
  });
  it('owner and participant read; participant match is by subjectRef', () => {
    const m = meta({
      ownerUserId: 'alice',
      participants: [
        { subjectRef: userRef('alice'), role: 'owner', addedAt: ts },
        { subjectRef: userRef('bob'), role: 'member', addedAt: ts },
      ],
    });
    expect(isVisibleTo(m, 'alice')).toBe(true);
    expect(isVisibleTo(m, 'bob')).toBe(true);
    expect(isVisibleTo(m, 'carol')).toBe(false);
  });
});

describe('isVisibleTo — channel semantics', () => {
  const channel = (visibility: 'public' | 'private') => meta({
    type: 'channel', ownerUserId: 'alice',
    channel: { visibility } as NonNullable<ConversationMeta['channel']>,
    participants: [{ subjectRef: userRef('bob'), role: 'member', addedAt: ts }],
  });
  it('public channel: any AUTHENTICATED tenant caller reads; anon denied', () => {
    expect(isVisibleTo(channel('public'), 'carol')).toBe(true);
    expect(isVisibleTo(channel('public'), undefined)).toBe(false);
  });
  it('private channel: owner/participant only', () => {
    expect(isVisibleTo(channel('private'), 'alice')).toBe(true);
    expect(isVisibleTo(channel('private'), 'bob')).toBe(true);
    expect(isVisibleTo(channel('private'), 'carol')).toBe(false);
    expect(isVisibleTo(channel('private'), undefined)).toBe(false);
  });
});

describe('isRailListed — display is narrower than read', () => {
  it('a public channel is readable by a non-member but NOT rail-listed for them', () => {
    const m = meta({
      type: 'channel', ownerUserId: 'alice',
      channel: { visibility: 'public' } as NonNullable<ConversationMeta['channel']>,
      participants: [{ subjectRef: userRef('bob'), role: 'member', addedAt: ts }],
    });
    expect(isVisibleTo(m, 'carol')).toBe(true);
    expect(isRailListed(m, 'carol')).toBe(false);
    expect(isRailListed(m, 'bob')).toBe(true);
  });
});

describe('isVisibleToAsync — subject-ACL fallback', () => {
  it('with no ownerSubject it falls back to the sync predicate', async () => {
    await expect(isVisibleToAsync(meta({ ownerUserId: 'alice' }), 't1', 'alice')).resolves.toBe(true);
    await expect(isVisibleToAsync(meta({ ownerUserId: 'alice' }), 't1', 'mallory')).resolves.toBe(false);
    await expect(isVisibleToAsync(null, 't1', undefined)).resolves.toBe(true);
  });
});
