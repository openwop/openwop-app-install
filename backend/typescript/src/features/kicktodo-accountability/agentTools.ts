/**
 * Accountability chat tools (ADR 0419 P4; ADR 0308 seam) — the Steward skill's +
 * KickBot's grounding: the acting user's OWN circles with their self-view feeds,
 * and the coach plan-change proposals awaiting their decision. Fail EMPTY without
 * an acting user; a system turn never enumerates circles or proposals.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { listCirclesOwnedBy, resolveCircleByOpaqueId } from './circleService.js';
import { listProposalsFor } from './cohortService.js';
import { circleFeedFor } from './projectionService.js';
import { listEnrollmentsFor } from '../kicktodo-core/enrollmentService.js';

export const KICKTODO_CIRCLES_TOOL_ID = 'openwop:kicktodo.circles';
export const KICKTODO_PROPOSALS_TOOL_ID = 'openwop:kicktodo.proposals';

export function registerKicktodoAccountabilityAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_CIRCLES_TOOL_ID,
      description:
        "The user's OWN accountability circles with their projected progress feeds. "
        + 'Use to ground update drafts for partners/coaches in what is actually shared. Read-only; grant scopes always apply.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope) {
      if (!scope.actingUserId) return { content: JSON.stringify({ circles: [] }) };
      const circles = await listCirclesOwnedBy(scope.tenantId, scope.actingUserId);
      const out = [] as Array<Record<string, unknown>>;
      for (const c of circles) {
        const feed = await circleFeedFor(await resolveCircleByOpaqueId(c.id), scope.actingUserId).catch(() => null);
        out.push({ circleId: c.id, name: c.name, type: c.type, feed });
      }
      return { content: JSON.stringify({ circles: out }) };
    },
  });

  // A coach can propose plan changes a participant must decide on (ADR 0419 P3).
  // This lets KickBot READ those pending proposals for the user's OWN enrollments
  // so it can explain and talk them through ("your coach suggested moving rest
  // days to weekends — want to look at it?"). It only READS — applying/dismissing
  // stays on the governed proposals route (the participant's decision). Self-scoped
  // by construction (only the acting user's own enrollments); fails EMPTY without
  // a human principal. Read-only.
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_PROPOSALS_TOOL_ID,
      description:
        "Plan-change proposals a coach has raised on the user's OWN enrollments and that await the user's decision "
        + '(apply or dismiss). Use to explain a pending proposal and help them decide — you never apply it yourself; the user '
        + 'decides on the governed card/route. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope) {
      if (!scope.actingUserId) return { content: JSON.stringify({ proposals: [] }) };
      const mine = await listEnrollmentsFor(scope.tenantId, scope.actingUserId);
      const out: Array<Record<string, unknown>> = [];
      for (const e of mine) {
        for (const p of await listProposalsFor(scope.tenantId, e.id)) out.push({ ...p });
      }
      return { content: JSON.stringify({ proposals: out }) };
    },
  });
}
