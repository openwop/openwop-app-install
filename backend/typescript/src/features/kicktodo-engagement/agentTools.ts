/**
 * kicktodo-engagement chat tool (chat-first-port gap G6; ADR 0058 / ADR 0308
 * seam). The `feature.kicktodo.nodes.engagement-summary` NODE surfaced the
 * caller's leaderboard standing + awards to WORKFLOWS, but surface-backed nodes
 * are excluded from the chat tool projection — so nothing carried the capability
 * into a conversation. This registers the matching READ tool so KickBot (the
 * participant's guide) can ground "how am I doing / what have I earned?" in
 * ACTUAL engagement state.
 *
 * Authority parity with the engagement REST surface (routes.ts `gate` +
 * `subjectOf`): READ-ONLY, per-tenant toggle-honest, and it reads the ACTING
 * user's OWN view only (the leaderboard is `leaderboard(tenant, callerSubject,
 * challengeId)` over the caller's own enrollments only,
 * awards are the caller's) — never an arbitrary subject. FAILS EMPTY without an
 * acting user (a scheduled/system turn must not enumerate a participant's
 * standing), exactly the kicktodo-core read-tool posture.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { leaderboard, listAwards, myOptIn, type LeaderboardEntry } from './engagementService.js';
import { listEnrollmentsFor } from '../kicktodo-core/enrollmentService.js';

export const KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID = 'openwop:kicktodo.engagement-summary';

type ToolResult = { content: string; isError?: boolean };
function toolError(error: string, message: string): ToolResult {
  return { content: JSON.stringify({ error, message }), isError: true };
}

export function registerKicktodoEngagementAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID,
      description:
        "The user's KickTodo engagement summary: their opt-in leaderboard standing (k-floored — below the floor they see only themselves) plus the awards they have earned. "
        + 'Use it to celebrate progress and ground encouragement in what the user has ACTUALLY achieved. Read-only; shows only the user\'s own view.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope) {
      // Read-tool posture: no acting human ⇒ EMPTY, never another user's standing.
      if (!scope.actingUserId) return { content: JSON.stringify({ optedIn: false, boards: [], awards: [] }) };
      const featureOn = await resolveFeatureToggle('kicktodo-engagement', scope);
      if (!featureOn) return toolError('feature_disabled', 'The KickTodo Engagement feature is not enabled for this workspace.');
      // ADR 0641 decision 13 — boards are per-challenge, so "the user's
      // standing" is now one row per challenge they are in. The tool's input
      // schema stays EMPTY on purpose: an agent should not have to know challenge
      // ids to answer "how am I doing", and deriving the list from the caller's
      // own enrollments keeps the read self-scoped by construction (it can only
      // ever reach challenges this user is enrolled in).
      //
      // `optedIn` is read DIRECTLY from the opt-in row. It used to be inferred
      // from `leaderboard()` throwing `OptInRequiredError`, which decision 13
      // made unreachable for an enrolled caller — so the inference silently
      // started reporting `optedIn: true` for someone who had never joined. A
      // flag about consent must be read from the consent record, not from whether
      // a different call happened to fail.
      const opted = await myOptIn(scope.tenantId, scope.actingUserId);
      const mine = await listEnrollmentsFor(scope.tenantId, scope.actingUserId);
      const challengeIds = [...new Set(mine.map((e) => e.challengeId))];
      const boards: { challengeId: string; belowFloor: boolean; entries: LeaderboardEntry[] }[] = [];
      for (const challengeId of challengeIds) {
        const view = await leaderboard(scope.tenantId, scope.actingUserId, challengeId);
        boards.push({ challengeId, belowFloor: view.belowFloor, entries: view.entries });
      }
      // Awards never required the opt-in, so they are read either way.
      const awards = await listAwards(scope.tenantId, scope.actingUserId);
      return { content: JSON.stringify({ optedIn: Boolean(opted), boards, awards }) };
    },
  });
}
