/**
 * Proposals agent tool (XCH-HOLE-3, LLM-EXCHANGE-AUDIT Wave 4) — the ADR 0308
 * seam. `openwop:proposals.list` — the model's OWN learning-feedback channel
 * (RFC 0096): an agent reads what improvements have been proposed/applied/
 * rejected before proposing again. Read-only.
 *
 * ADR 0938 D6 — it answers only for a person who may read the route
 * (`assertCanReadProposals`, the predicate the routes call) and returns an empty
 * list without one. Before, it read `scope.tenantId` alone, so it listed for a
 * turn with no acting person and for a person with no role in the workspace.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { listProposals, viewOf } from './proposalsService.js';
import { assertCanReadProposals } from './access.js';
import { PROPOSAL_KINDS, PROPOSAL_STATES, type ProposalKind, type ProposalState } from './types.js';

export const PROPOSALS_LIST_TOOL_ID = 'openwop:proposals.list';

const STATES: ReadonlySet<string> = new Set(PROPOSAL_STATES);
const KINDS: ReadonlySet<string> = new Set(PROPOSAL_KINDS);

export function registerProposalsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
    def: {
      name: PROPOSALS_LIST_TOOL_ID,
      description:
        'List improvement proposals (RFC 0096): agent packs, workflow chains, prompt templates, and automations '
        + 'that have been proposed, with their state (draft / revised / applied / rejected / archived). '
        + 'Check this BEFORE proposing an improvement — do not re-propose something already rejected or applied. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: [...PROPOSAL_STATES], description: 'Optional state filter.' },
          kind: { type: 'string', enum: [...PROPOSAL_KINDS], description: 'Optional kind filter.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return { content: JSON.stringify({ proposals: [] }) };
      try {
        await assertCanReadProposals(scope.tenantId, scope.actingUserId, { personalTenant: scope.personalTenant });
      } catch {
        return { content: JSON.stringify({ proposals: [] }) };
      }
      const ignoredFilters: string[] = [];
      let state: ProposalState | undefined;
      let kind: ProposalKind | undefined;
      if (input.state !== undefined) {
        if (typeof input.state === 'string' && STATES.has(input.state)) state = input.state as ProposalState;
        else ignoredFilters.push('state');
      }
      if (input.kind !== undefined) {
        if (typeof input.kind === 'string' && KINDS.has(input.kind)) kind = input.kind as ProposalKind;
        else ignoredFilters.push('kind');
      }
      const proposals = (await listProposals(scope.tenantId, { ...(state ? { state } : {}), ...(kind ? { kind } : {}) })).map(viewOf);
      return { content: JSON.stringify({ proposals, ...(ignoredFilters.length ? { ignoredFilters } : {}) }) };
    },
  });
}
