/**
 * The Safety inbox (ADR 0438 A2) filters the ONE shared review store to the
 * KickTodo approval kinds. This pins the filter against the exact kinds the
 * backend emits, so a rename on either side is caught rather than silently
 * dropping a moderation decision from the operator queue.
 *
 * w40 correction: the literal list below only pins the FRONTEND side. The
 * backend half is now real: the third case reads the backend's own KickTodo
 * approval-kind set (`kicktodo-core/exceptionSources.ts`, the Exception Ledger's
 * `KICKTODO_APPROVAL_KINDS`) and requires every frontend kind to appear there.
 *
 * Sabotage witnesses (w40 probes): dropping a kind from the frontend constant,
 * an always-true filter, or renaming a kind in the backend set each turn a case
 * here red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('every frontend kind is one the backend KickTodo approval set still names', () => {
    const REPO = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');
    const src = readFileSync(join(REPO, 'backend/typescript/src/features/kicktodo-core/exceptionSources.ts'), 'utf8');
    const block = /KICKTODO_APPROVAL_KINDS\s*=\s*new Set[^(]*\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? '';
    const backendKinds = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // Positive control: the block was found and parsed. `kicktodo-plan-proposal`
    // is there but deliberately NOT in the operator Safety inbox — the
    // participant decides it in the chat Reviews rail (ADR 0458 P4 / ADR 0464).
    expect(backendKinds).toContain('kicktodo-plan-proposal');
    for (const kind of KICKTODO_REVIEW_KINDS) expect(backendKinds).toContain(kind);
  });
});
