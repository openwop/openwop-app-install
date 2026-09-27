/**
 * ADR 0460 Phase 2 — the kicktodo-community REVIEW-FLAGS exception source.
 *
 * A review left in `flagged` state is an open moderation exception (it's hidden
 * from the public projection and awaiting a decision on its `community-review`
 * approval). This source reads the tenant's flagged reviews (tenant-scoped) and
 * deep-links the moderator to the safety inbox.
 */

import { listFlaggedReviews } from './communityService.js';
import { registerExceptionSource, type ExceptionRow } from '../../host/exceptionProjection.js';

const SOURCE_KEY = 'kicktodo:review-flags';

async function reviewFlagsExceptionSource(tenantId: string): Promise<ExceptionRow[]> {
  if (!tenantId) return [];
  const flagged = await listFlaggedReviews(tenantId);
  return flagged.map((r) => ({
    id: `review-flag:${r.challengeId}:${r.reviewerSubject}`,
    source: SOURCE_KEY,
    severity: 'attention' as const,
    label: `A review on challenge ${r.challengeId} is flagged and awaiting moderation`,
    owner: { kind: 'system' as const, ref: 'moderation', label: 'moderation' },
    action: { labelKey: 'exceptionActionModerate', href: '/admin/kicktodo/safety' },
    audit: { detectedAt: r.updatedAt, tenantId },
  }));
}

export function registerKicktodoReviewFlagsExceptionSource(): void {
  registerExceptionSource(SOURCE_KEY, reviewFlagsExceptionSource);
}
