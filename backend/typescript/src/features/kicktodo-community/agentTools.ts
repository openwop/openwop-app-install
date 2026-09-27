/**
 * kicktodo-community chat tool (chat-first-port gap G7; ADR 0058 / ADR 0308
 * seam). The `feature.kicktodo.nodes.challenge-reviews` NODE surfaced a
 * challenge's visible reviews + aggregate rating to WORKFLOWS, but surface-backed
 * nodes are excluded from the chat tool projection — so nothing carried the
 * capability into a conversation. This registers the matching READ tool so
 * KickBot can answer "how is this challenge reviewed?" from ACTUAL review state.
 *
 * Authority parity with the community REST surface (routes.ts `gate` +
 * `GET /reviews/:challengeId`): READ-ONLY, per-tenant toggle-honest. It returns
 * only `visibleReviews` (already moderated + reviewer-identity-free) and the
 * k-floored `aggregateRating` — the exact closed projection the public route
 * serves, so the tool can leak nothing the route does not. FAILS EMPTY without
 * an acting user (the kicktodo read-tool posture); a malformed `challengeId` is
 * a TYPED error, never success-with-empty.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { visibleReviews, aggregateRating } from './communityService.js';

export const KICKTODO_COMMUNITY_REVIEWS_TOOL_ID = 'openwop:kicktodo.community-reviews';

type ToolResult = { content: string; isError?: boolean };
function toolError(error: string, message: string): ToolResult {
  return { content: JSON.stringify({ error, message }), isError: true };
}
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function registerKicktodoCommunityAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_COMMUNITY_REVIEWS_TOOL_ID,
      description:
        'Read the visible reviews and aggregate rating for a published challenge (proof-gated, moderated, reviewer-anonymous). '
        + 'Returns each visible review (rating + optional body + verified-participant/purchase provenance) and the aggregate '
        + '({ count, average } — average withheld below the k-floor). Use it to summarize how a challenge is received. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          challengeId: { type: 'string', description: 'The published challenge id to read reviews for.' },
        },
        required: ['challengeId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // Read-tool posture: no acting human ⇒ EMPTY (annotated).
      //
      // UX_UPGRADE-kicktodo-community R2 (KTC2-M1) — this used to answer
      // `{ reviews: [], aggregate: { count: 0, average: null } }` with no note:
      // byte-identical to a REAL challenge with zero reviews (the happy path
      // below produces exactly that shape for one). `count: 0` was a fabricated
      // statistic — nothing was counted — so a model on an automated turn
      // reported "this challenge has no reviews", a claim about the CHALLENGE
      // that the refusal never established. The feature-off and bad-input paths
      // are typed errors; this was the file's one unannotated empty.
      if (!scope.actingUserId) {
        return {
          content: JSON.stringify({
            reviews: [],
            aggregate: null,
            note: 'This tool only reads from a human-initiated turn — this is NOT a statement about the challenge\'s reviews. Do not tell the user the challenge has no reviews.',
          }),
        };
      }
      const featureOn = await resolveFeatureToggle('kicktodo-community', scope);
      if (!featureOn) return toolError('feature_disabled', 'The KickTodo Community feature is not enabled for this workspace.');
      const challengeId = str(input.challengeId);
      if (!challengeId) return toolError('validation_error', '`challengeId` is required.');
      const [reviews, aggregate] = await Promise.all([
        visibleReviews(scope.tenantId, challengeId),
        aggregateRating(scope.tenantId, challengeId),
      ]);
      return { content: JSON.stringify({ reviews, aggregate }) };
    },
  });
}
