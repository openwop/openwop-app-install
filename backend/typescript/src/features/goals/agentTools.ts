/**
 * Goals agent tool (XCH-HOLE-1, LLM-EXCHANGE-AUDIT Wave 4) — the ADR 0308
 * seam. `openwop:goals.list` — "what are my goals?" for the model that the
 * heartbeat work-loop (ADR 0313) already plans against. Read-only,
 * tenant-scoped exactly like the route (`listGoals(tenant, state?)`).
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { listGoals } from './goalsService.js';
import type { GoalState } from './types.js';

export const GOALS_LIST_TOOL_ID = 'openwop:goals.list';

const GOAL_STATES: ReadonlySet<string> = new Set(['active', 'satisfied', 'escalated', 'abandoned', 'bound-exceeded']);

export function registerGoalsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: GOALS_LIST_TOOL_ID,
      description:
        'List the workspace\'s goals (RFC 0097): objective, state, completion criteria, bounds, and progress. '
        + 'Use it to ground plans and proposals in the user\'s ACTUAL standing goals instead of guessing. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', description: "Optional state filter: 'active' | 'satisfied' | 'escalated' | 'abandoned' | 'bound-exceeded'." },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // (2026-07 vuln-scan) App-state reads FAIL EMPTY without an acting user — matches
      // the sibling read-tools (documents/app-builder/…). A system-initiated / scheduled
      // turn with no human principal must not enumerate the workspace's standing goals.
      if (!scope.actingUserId) return { content: JSON.stringify({ goals: [] }) };
      const state = typeof input.state === 'string' && GOAL_STATES.has(input.state) ? (input.state as GoalState) : undefined;
      const goals = await listGoals(scope.tenantId, state);
      return { content: JSON.stringify({ goals }) };
    },
  });
}
