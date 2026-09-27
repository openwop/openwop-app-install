/**
 * The Safety inbox (ADR 0438 A2) filters the ONE shared review store to the
 * KickTodo approval kinds. This pins the filter against the exact kinds the
 * backend emits, so a rename on either side is caught rather than silently
 * dropping a moderation decision from the operator queue.
 */
import { describe, it, expect } from 'vitest';
import { KICKTODO_REVIEW_KINDS, isKickTodoReviewKind } from '../kicktodoReviewKinds.js';

describe('isKickTodoReviewKind', () => {
  it('accepts exactly the backend KickTodo approval kinds', () => {
    // Sources: kicktodo-community/communityService.ts (community-profile,
    // community-review) + kicktodo-creator/publishService.ts (challenge-publish)
    // + kicktodo-commerce/sellerRequestService.ts (connect-seller, ADR 0445 P2).
    expect([...KICKTODO_REVIEW_KINDS].sort()).toEqual(
      ['challenge-publish', 'community-profile', 'community-review', 'connect-seller'],
    );
    expect(isKickTodoReviewKind('community-profile')).toBe(true);
    expect(isKickTodoReviewKind('community-review')).toBe(true);
    expect(isKickTodoReviewKind('challenge-publish')).toBe(true);
    expect(isKickTodoReviewKind('connect-seller')).toBe(true);
  });

  it('rejects non-KickTodo review kinds so the queue stays scoped', () => {
    expect(isKickTodoReviewKind('run')).toBe(false);
    expect(isKickTodoReviewKind('node')).toBe(false);
    expect(isKickTodoReviewKind('marketplace-listing')).toBe(false);
    expect(isKickTodoReviewKind('')).toBe(false);
  });
});
