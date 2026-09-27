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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const api = vi.hoisted(() => ({ listMembers: vi.fn() }));
vi.mock('../../client/accessClient.js', () => ({ listMembers: api.listMembers }));
vi.mock('../../client/workspaceClient.js', () => ({ listMyWorkspaces: vi.fn(async () => ({ active: 'ws_active' })) }));

import { loadOrgMembers, invalidateOrgMembers } from '../orgMembers.js';

const MEMBERS = [{ subject: 'user_1', displayName: 'Ada' }];

/** A request whose settlement this test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateOrgMembers();
});
afterEach(() => { invalidateOrgMembers(); });

describe('loadOrgMembers — in-flight dedupe', () => {
  it('THE FIX: N concurrent callers for one org issue ONE request', async () => {
    const d = deferred<typeof MEMBERS>();
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
    api.listMembers.mockImplementation(async (id: string) => [{ subject: `member_of_${id}`, displayName: id }]);

    const [a, b] = await Promise.all([loadOrgMembers('org_a'), loadOrgMembers('org_b')]);

    expect(api.listMembers).toHaveBeenCalledTimes(2);
    expect(a[0]!.subject).toBe('member_of_org_a');
    expect(b[0]!.subject).toBe('member_of_org_b');
  });

  it('after resolution the value cache still serves — no repeat request', async () => {
    api.listMembers.mockResolvedValue(MEMBERS);
    await loadOrgMembers('org_1');
    await loadOrgMembers('org_1');
    expect(api.listMembers).toHaveBeenCalledTimes(1);
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
    const first = deferred<typeof MEMBERS>();
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
    first.resolve([{ subject: 'user_1', displayName: 'STALE' }]);
    await inFlight;

    const fresh = [{ subject: 'user_1', displayName: 'Ada' }, { subject: 'user_2', displayName: 'Grace' }];
    api.listMembers.mockResolvedValueOnce(fresh);

    // Must REFETCH, and must not be served the pre-invalidation list.
    await expect(loadOrgMembers('org_1')).resolves.toEqual(fresh);
    expect(api.listMembers).toHaveBeenCalledTimes(2);
  });
});
