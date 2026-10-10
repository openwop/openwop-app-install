/**
 * `loadOrgMembers` — concurrent callers must share ONE request.
 *
 * THE CLAIM THAT WAS NOT TRUE. `CommentsPanel`'s docblock justified calling this
 * per mounted panel by asserting "ONE fetch per org — served from a module cache,
 * so it adds no rate-limit fan-out". The cache could not deliver that: it was
 * written only AFTER `await listMembers(id)` RESOLVED, so every panel mounting in
 * the same tick missed it and issued its own `GET /orgs/:id/members`. A chat
 * thread renders one panel per message, and `middleware/rateLimit.ts` budgets a
 * per-IP read allowance (default 60/min) that a single reader could blow.
 *
 * Sharing the in-flight PROMISE is what makes the docblock's claim true. These
 * tests pin the four properties that matter, including the two that a naive
 * in-flight map gets wrong (a rejected read must not latch; an invalidation must
 * not be undone by a request already in the air).
 *
 * Gap: #3383 (the Collaboration / Comments batch — CommentsPanel's "ONE fetch per
 * org" docblock was false); the invalidation half is CLNP-8 slot ownership
 * (ff2e5fea8). The resolved-value cache hit is pinned by
 * `orgMembersInvalidation.test.tsx` › "serves the cache inside the TTL and
 * refetches after it", not here.
 *
 * Sabotage that turns it red: removing the `inFlight` lookup reds THE FIX; keying
 * the lookup on anything but the org id reds "distinct orgs"; not clearing the
 * slot in `finally` reds the rejected-read case; caching without the slot-ownership
 * check (or a per-org invalidation that leaves the slot) reds the last case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as AccessClient from '../../client/accessClient.js';
import type { OrgMember } from '../../client/accessClient.js';

const api = vi.hoisted(() => ({ listMembers: vi.fn<typeof AccessClient.listMembers>() }));
vi.mock('../../client/accessClient.js', () => ({ listMembers: api.listMembers }));
vi.mock('../../client/workspaceClient.js', () => ({ listMyWorkspaces: vi.fn(async () => ({ active: 'ws_active', personal: 'user:me', workspaces: [] })) }));

import { loadOrgMembers, invalidateOrgMembers } from '../orgMembers.js';

/** A production-shaped member row. */
const m = (subject: string, displayName: string, orgId = 'org_1'): OrgMember => ({
  memberId: `mem_${subject}`, orgId, tenantId: 'ws_active', subject, displayName,
  roles: ['viewer'], teamIds: [], createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
});
const MEMBERS: OrgMember[] = [m('user_1', 'Ada')];

/** A request whose settlement this test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  api.listMembers.mockReset();
  invalidateOrgMembers();
});
afterEach(() => { invalidateOrgMembers(); });

describe('loadOrgMembers — in-flight dedupe', () => {
  it('THE FIX: N concurrent callers for one org issue ONE request', async () => {
    const d = deferred<OrgMember[]>();
    api.listMembers.mockReturnValue(d.promise);

    // Five panels mounting in the same tick — the CommentsPanel shape.
    const calls = [loadOrgMembers('org_1'), loadOrgMembers('org_1'), loadOrgMembers('org_1'), loadOrgMembers('org_1'), loadOrgMembers('org_1')];
    d.resolve(MEMBERS);
    const results = await Promise.all(calls);

    // Before the fix this was 5: the cache is only written after the await.
    expect(api.listMembers).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toEqual(MEMBERS);
  });

  it('distinct orgs are NOT collapsed into one request', async () => {
    // The guard against "fixing" fan-out by serving the wrong org's members.
    api.listMembers.mockImplementation(async (id: string) => [m(`member_of_${id}`, id, id)]);

    const [a, b] = await Promise.all([loadOrgMembers('org_a'), loadOrgMembers('org_b')]);

    expect(api.listMembers).toHaveBeenCalledTimes(2);
    expect(a[0]!.subject).toBe('member_of_org_a');
    expect(b[0]!.subject).toBe('member_of_org_b');
  });

  it('a REJECTED read is not latched — the next call retries', async () => {
    // An in-flight map that is not cleared in `finally` would serve the rejected
    // promise forever, turning one transient 500 into a permanently broken
    // directory for the session.
    api.listMembers.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(MEMBERS);

    await expect(loadOrgMembers('org_1')).rejects.toThrow('boom');
    await expect(loadOrgMembers('org_1')).resolves.toEqual(MEMBERS);
    expect(api.listMembers).toHaveBeenCalledTimes(2);
  });

  it('invalidation is not undone by a request already in the air', async () => {
    // The subtle half: dropping the in-flight ENTRY does not stop that request's
    // `.then` from running, and it would write its PRE-invalidation list into the
    // cache — re-seating exactly the stale members the caller cleared (an invite
    // that "doesn't take" until a reload). Slot ownership prevents the write.
    const first = deferred<OrgMember[]>();
    api.listMembers.mockReturnValueOnce(first.promise);

    const inFlight = loadOrgMembers('org_1');
    // MUST wait for the request to actually be ISSUED before invalidating.
    // `loadOrgMembers` awaits `resolveOrgId` first, so calling `invalidate`
    // synchronously after it targets a load that has not started yet — a
    // different (and legitimately handled) case, and the reason the first draft
    // of this test failed against correct code. The owned slot only exists once
    // the request is issued, so the scenario only exists once `listMembers` ran.
    await vi.waitFor(() => expect(api.listMembers).toHaveBeenCalledTimes(1));

    invalidateOrgMembers('org_1');           // e.g. an invite just landed
    first.resolve([m('user_1', 'STALE')]);
    await inFlight;

    const fresh = [m('user_1', 'Ada'), m('user_2', 'Grace')];
    api.listMembers.mockResolvedValueOnce(fresh);

    // Must REFETCH, and must not be served the pre-invalidation list.
    await expect(loadOrgMembers('org_1')).resolves.toEqual(fresh);
    expect(api.listMembers).toHaveBeenCalledTimes(2);
  });
});
