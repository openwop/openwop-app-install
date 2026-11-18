/**
 * ADR 1123 follow-up (#5945) — where a fixture binds a person into an org.
 *
 * `POST /orgs/:orgId/members {subject: 'user:…'}` is the old lane: an admin who
 * knows a person's userId binds them without their consent. Its replacement for
 * people is ADR 1123's add-existing (an opaque candidate from the admin's own
 * pool). Fixtures still need to seed arbitrary members, so they use the auth
 * test seam's copy of the same route. It runs the real handler (scope check,
 * roles, owner rule, events, audit) and is mounted only where `/test/login` is
 * (`OPENWOP_TEST_AUTH_ENABLED`, never on a deployed host, ADR 0833 D8).
 *
 * The sweep that moved 138 files rewrote their URLs in place, so most call
 * `/host/openwop-app/test/orgs/…/members` literally. New fixtures use these.
 */
export const SEED_MEMBERS_PREFIX = '/host/openwop-app/test/orgs';

/** `POST` here with `{displayName, subject, roles}` to seed a member. */
export function seedMembersPath(orgId: string): string {
  return `${SEED_MEMBERS_PREFIX}/${encodeURIComponent(orgId)}/members`;
}

/** `PATCH` here to bind a subject to a placeholder row. */
export function seedMemberPath(orgId: string, memberId: string): string {
  return `${seedMembersPath(orgId)}/${encodeURIComponent(memberId)}`;
}
