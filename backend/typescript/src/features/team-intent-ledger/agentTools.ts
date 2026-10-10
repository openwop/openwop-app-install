/**
 * ADR 0831 P3 — team-ledger agent tools on the ADR 0308 seam.
 *
 * - `openwop:team-ledger.get` (READ) — "what is this project for, right now?":
 *   the charter goal and objectives, scope, open questions and decision
 *   references at the ledger's current version. Read it BEFORE proposing.
 * - `openwop:team-ledger.propose` (ACTION) — propose a change with a reason. It
 *   NEVER accepts: the change sits in the owner's queue until they accept or
 *   reject it (the human gate). The author is recorded as the agent, and the run
 *   it came from as the source.
 *
 * Both share the route's access predicate (`access.ts`), fail closed without an
 * acting user, and are allowlisted for the chief of staff — not default-on.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { OpenwopError } from '../../types.js';
import { ledgerAccess } from './access.js';
import { cleanWhy, currentState, getLedger, LEDGER_LIMITS, proposeDelta, requireBaseVersion, validatePatch } from './ledgerStore.js';

export const TEAM_LEDGER_GET_TOOL_ID = 'openwop:team-ledger.get';
export const TEAM_LEDGER_PROPOSE_TOOL_ID = 'openwop:team-ledger.propose';

function toolError(error: string, message: string): { content: string; isError: true } {
  return { content: JSON.stringify({ error, message }), isError: true };
}

export function registerTeamLedgerAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
    // A shortened `outOfScope` list would tell the model it may do what the team
    // ruled out — the ADR 0604 H4 polarity. Never compacted.
    schemaCarrying: true,
    def: {
      name: TEAM_LEDGER_GET_TOOL_ID,
      description:
        "Read a project's team intent ledger: its goal and objectives, what is in and out of scope, open questions, "
        + 'and the decisions that shaped it, at the current version. Read it BEFORE proposing a change. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'The project whose ledger to read.' } },
        required: ['projectId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
      if (!projectId) return toolError('validation_error', '`projectId` is required.');
      if (!scope.actingUserId) return toolError('acting_user_required', 'Team-ledger reads run on behalf of a signed-in user.');
      // One indistinguishable not_found for missing / invisible / no ledger (the route's 404 posture).
      const notFound = toolError('not_found', `No team ledger found for project "${projectId}".`);
      const access = await ledgerAccess(scope.tenantId, projectId, scope.actingUserId);
      if (!access) return notFound;
      const ledger = await getLedger(scope.tenantId, access.project.id);
      // Visible project, no ledger yet: say so, so the model can tell the user to start one.
      if (!ledger) return toolError('no_ledger', `Project "${access.project.name}" has no team ledger yet. Someone who can edit the project can start one on its Ledger tab.`);
      return {
        content: JSON.stringify({
          projectId: access.project.id,
          version: ledger.version,
          state: currentState(ledger, access.project),
          canPropose: access.level === 'write',
        }),
      };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'write',
    def: {
      name: TEAM_LEDGER_PROPOSE_TOOL_ID,
      description:
        "Propose a change to a project's team intent ledger, with the reason. Read it with team-ledger.get FIRST and "
        + 'pass the version you read as baseVersion (required). This only PROPOSES: the ledger owner accepts or '
        + 'rejects it, so tell the user it is waiting for the owner. patch may set goal (a string), or any of '
        + 'objectives, inScope, outOfScope, openQuestions, decisionDocumentIds. EVERY list REPLACES the whole current '
        + 'list, decisionDocumentIds included: to add one item, send the current list plus it; to remove one, send '
        + 'the list without it. Invalid input is refused with the reason, never silently changed.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          patch: {
            type: 'object',
            properties: {
              goal: { type: 'string', minLength: 1, maxLength: LEDGER_LIMITS.goal },
              objectives: { type: 'array', maxItems: LEDGER_LIMITS.objectives, items: { type: 'string', minLength: 1, maxLength: LEDGER_LIMITS.objective } },
              inScope: { type: 'array', maxItems: LEDGER_LIMITS.listItems, items: { type: 'string', minLength: 1, maxLength: LEDGER_LIMITS.line } },
              outOfScope: { type: 'array', maxItems: LEDGER_LIMITS.listItems, items: { type: 'string', minLength: 1, maxLength: LEDGER_LIMITS.line } },
              openQuestions: { type: 'array', maxItems: LEDGER_LIMITS.listItems, items: { type: 'string', minLength: 1, maxLength: LEDGER_LIMITS.line } },
              decisionDocumentIds: { type: 'array', maxItems: LEDGER_LIMITS.listItems, items: { type: 'string', minLength: 1, maxLength: 128 } },
            },
            additionalProperties: false,
          },
          why: { type: 'string', minLength: 1, maxLength: LEDGER_LIMITS.why, description: 'Why this change, in one or two sentences (required).' },
          baseVersion: { type: 'integer', minimum: 1, description: 'The ledger version you read with team-ledger.get (required).' },
        },
        required: ['projectId', 'patch', 'why', 'baseVersion'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return toolError('acting_user_required', 'Proposing a ledger change runs on behalf of a signed-in user.');
      const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
      if (!projectId) return toolError('validation_error', '`projectId` is required.');
      const notFound = toolError('not_found', `No team ledger found for project "${projectId}".`);
      const access = await ledgerAccess(scope.tenantId, projectId, scope.actingUserId);
      if (!access) return notFound;
      if (access.level !== 'write') return toolError('forbidden', 'The user this turn acts for cannot edit this project, so it cannot propose ledger changes.');
      const ledger = await getLedger(scope.tenantId, access.project.id);
      // Visible project, no ledger yet: say so, so the model can tell the user to start one.
      if (!ledger) return toolError('no_ledger', `Project "${access.project.name}" has no team ledger yet. Someone who can edit the project can start one on its Ledger tab.`);
      try {
        const patch = await validatePatch(input.patch, access.project);
        const why = cleanWhy(input.why);
        const base = requireBaseVersion(input.baseVersion, ledger.version);
        const delta = await proposeDelta({
          ledger, patch, why,
          author: { kind: 'agent', id: scope.agentProfileId ?? 'agent' },
          ...(scope.runId ? { source: { kind: 'run' as const, ref: scope.runId } } : {}),
          baseVersion: base,
        });
        // Echo what was STORED, so the model can see exactly what the owner will review.
        return { content: JSON.stringify({ proposed: true, deltaId: delta.deltaId, status: delta.status, baseVersion: delta.baseVersion, patch: delta.patch, awaiting: 'the ledger owner must accept or reject it' }) };
      } catch (err) {
        if (err instanceof OpenwopError) return toolError(err.code, err.message);
        throw err;
      }
    },
  });
}
