/**
 * The shared-review `kind`s that KickTodo operator approvals carry, so the Safety
 * inbox (ADR 0438 A2) can filter the ONE shared review store to KickTodo decisions
 * without a parallel queue. Backend sources:
 *   - `kicktodo-community/communityService.ts` → `community-profile`, `community-review`
 *   - `kicktodo-creator/publishService.ts`     → `challenge-publish`
 *   - `kicktodo-commerce/sellerRequestService.ts` → `connect-seller` (ADR 0445 P2)
 * Pure + exported so the filter is unit-pinned against those backend kinds.
 */
export const KICKTODO_REVIEW_KINDS = ['community-profile', 'community-review', 'challenge-publish', 'connect-seller'] as const;

export function isKickTodoReviewKind(kind: string): boolean {
  return (KICKTODO_REVIEW_KINDS as readonly string[]).includes(kind);
}
