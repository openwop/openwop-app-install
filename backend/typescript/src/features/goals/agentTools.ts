/**
 * Goals agent tool (XCH-HOLE-1, LLM-EXCHANGE-AUDIT Wave 4) — the ADR 0308
 * seam. `openwop:goals.list` — "what are my goals?" for the model that the
 * heartbeat work-loop (ADR 0313) already plans against. Read-only; asks the
 * route's question (ADR 0908 D1) and reads the same `listGoals`.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { assertTenantScope } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';
import { GOALS_READ } from './access.js';
import { listGoals } from './goalsService.js';
import type { GoalState } from './types.js';
import { toolError } from '../../host/agentToolKit.js';

export const GOALS_LIST_TOOL_ID = 'openwop:goals.list';

const GOAL_STATES: ReadonlySet<string> = new Set(['active', 'satisfied', 'escalated', 'abandoned', 'bound-exceeded']);

export function registerGoalsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
    def: {
      name: GOALS_LIST_TOOL_ID,
      description:
        'List the workspace\'s standing goals (RFC 0097): objective, state, completion criteria, bounds, and progress. '
        + 'Each goal says whether it is the user\'s own (`mine: true`) or a colleague\'s personal goal (`personal: true, mine: false`) — '
        + 'call only `mine` goals "your goals". Use it to ground plans in real goals instead of guessing. Read-only.',
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
      // ADR 0908 D1 — the read the route asks (`workspace:read` in the tenant),
      // in its req-less form for the acting user, as the surface seam asks it.
      // `listGoals` never returns the conformance fixture to this lane (D4).
      try {
        await assertTenantScope(scope.tenantId, scope.actingUserId, GOALS_READ, { ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}) });
      } catch (err) {
        // A typed refusal, never success-with-empty: the model must not read
        // "no goals" when it was refused the read.
        if (err instanceof OpenwopError) return { content: JSON.stringify({ error: err.code, message: err.message }), isError: true, fromThrow: true };
        throw err;
      }
      // `GL2UX-6` — an unknown filter is a typed refusal (as the route's 400),
      // never a silent "all goals".
      if (input.state !== undefined && (typeof input.state !== 'string' || !GOAL_STATES.has(input.state))) {
        return toolError('validation_error', 'state must be one of: active, satisfied, escalated, abandoned, bound-exceeded.');
      }
      const state = input.state as GoalState | undefined;
      // `GL2UX-2` — these are the WORKSPACE's goals, a colleague's personal ones
      // included; each says whether it is the acting user's own (`mine`), and no
      // person id reaches the model.
      const goals = (await listGoals(scope.tenantId, state)).map(({ owner, ...g }) => ({
        ...g,
        mine: owner.principal === scope.actingUserId,
        personal: owner.principal !== undefined,
      }));
      return { content: JSON.stringify({ goals }) };
    },
  });
}
