/**
 * Per-org member loader with a tiny module cache (ADR 0261).
 *
 * The shared people-picker (`UserPicker`) resolves a workspace's members by
 * NAME, not by a raw subject id. Every consumer that needs "who's in this org"
 * goes through here so the fetch is paid once per org and reused. It began as
 * a lift of `kanban/AssigneeControl`'s private cache, and that copy survived
 * beside it until CLNP-2(d) folded kanban + KickTodo Circles back onto this one.
 *
 * When no org id is supplied the active workspace's root org is used (its id
 * equals the active workspace/tenant id — ADR 0015).
 */
import { listMembers, type OrgMember } from '../client/accessClient.js';
import { listMyWorkspaces } from '../client/workspaceClient.js';

/**
 * CLNP-2(d) — resolved lists expire after `MEMBERS_CACHE_TTL_MS`. The mutations this
 * tab makes invalidate explicitly (`useOrgsController`, `InviteAcceptPage`); the TTL
 * covers the ones it cannot see — an invite accepted or a member removed in ANOTHER
 * session. Before this the cache never expired and `invalidateOrgMembers` had no
 * caller, so a removed member stayed pickable for the life of the page.
 */
const MEMBERS_CACHE_TTL_MS = 60_000;
const cache = new Map<string, { members: OrgMember[]; at: number }>();
/**
 * IN-FLIGHT dedupe, distinct from `cache` and load-bearing.
 *
 * `cache` is only written AFTER `await listMembers(id)` RESOLVES, so it cannot
 * collapse concurrent callers: every panel that mounts in the same tick misses,
 * and N panels issue N parallel `GET /orgs/:id/members`. `CommentsPanel` renders
 * once per chat message, so a busy conversation was the fan-out shape
 * `middleware/rateLimit.ts` budgets against (default 60 reads/min per IP) — and
 * the docblock there claimed "ONE fetch per org", which the resolve-time cache
 * never guaranteed.
 *
 * Sharing the PROMISE closes it: the first caller starts the request, the rest
 * await the same one. Cleared in `finally` so a REJECTED read is never latched —
 * a failed directory load must be retryable, and the resolved-value cache
 * deliberately does not store failures either.
 */
const inFlight = new Map<string, Promise<OrgMember[]>>();
/*
 * Invalidation is OWNERSHIP of the `inFlight` slot. Dropping the slot is not enough on
 * its own: the pending request's `.then` still runs and would write its
 * pre-invalidation list into `cache`, re-seating precisely the stale members
 * `invalidateOrgMembers` was called to clear (an invite that "didn't take" until a
 * reload). So a load caches only if the slot still holds ITS promise — any
 * invalidation (one org or all) drops the slot, and a later load replaces it.
 * This replaced a per-org generation counter plus a global epoch: the counter could
 * not disown a FIRST load still in flight across a whole-cache invalidation (that org
 * had no entry to bump — grade-code #4), and ownership covers both cases with no
 * extra state (and 33 B less entry chunk, CLNP-8).
 */

async function resolveOrgId(orgId?: string): Promise<string> {
  if (orgId) return orgId;
  return (await listMyWorkspaces()).active;
}

/** Load an org's members. Cached after the first success (for at most
 *  `MEMBERS_CACHE_TTL_MS`), and concurrent callers for the same org share ONE
 *  request. Omit `orgId` for the active workspace. */
export async function loadOrgMembers(orgId?: string, now: () => number = Date.now): Promise<OrgMember[]> {
  const id = await resolveOrgId(orgId);
  const hit = cache.get(id);
  if (hit && now() - hit.at < MEMBERS_CACHE_TTL_MS) return hit.members;
  const pending = inFlight.get(id);
  if (pending) return pending;
  const p = listMembers(id)
    .then((members) => {
      if (inFlight.get(id) === p) cache.set(id, { members, at: now() });
      return members;
    })
    .finally(() => {
      // Only clear the slot if it is still OURS — a load started after an
      // invalidation owns it now, and clearing that one would un-dedupe it.
      if (inFlight.get(id) === p) inFlight.delete(id);
    });
  inFlight.set(id, p);
  return p;
}

/** Drop cached members (e.g. after an invite) so the next load refetches. Any
 *  in-flight read is disowned too — it was issued against the pre-invite state,
 *  so letting it settle into the cache would restore the stale list. */
export function invalidateOrgMembers(orgId?: string): void {
  if (orgId) {
    cache.delete(orgId);
    inFlight.delete(orgId);
  } else {
    cache.clear();
    inFlight.clear();
  }
}
