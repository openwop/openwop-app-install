/**
 * Proposals agent tool (XCH-HOLE-3, LLM-EXCHANGE-AUDIT Wave 4) — the ADR 0308
 * seam. `openwop:proposals.list` — the model's OWN learning-feedback channel
 * (RFC 0096) was invisible to it; an agent can now read what improvements
 * have been proposed/applied/rejected before proposing again. Read-only,
 * tenant-scoped exactly like the route.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { listProposals } from './proposalsService.js';
import { PROPOSAL_KINDS, type ProposalKind, type ProposalState } from './types.js';

export const PROPOSALS_LIST_TOOL_ID = 'openwop:proposals.list';

const STATES: ReadonlySet<string> = new Set(['draft', 'revised', 'applied', 'rejected', 'archived']);
const KINDS: ReadonlySet<string> = new Set(PROPOSAL_KINDS);

export function registerProposalsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: PROPOSALS_LIST_TOOL_ID,
      description:
        'List improvement proposals (RFC 0096): agent packs, workflow chains, prompt templates, and automations '
        + 'that have been proposed, with their state (draft / revised / applied / rejected / archived). '
        + 'Check this BEFORE proposing an improvement — do not re-propose something already rejected or applied. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', description: "Optional state filter: 'draft' | 'revised' | 'applied' | 'rejected' | 'archived'." },
          kind: { type: 'string', description: "Optional kind filter: 'agent-pack' | 'workflow-chain-pack' | 'prompt-template' | 'automation'." },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const state = typeof input.state === 'string' && STATES.has(input.state) ? (input.state as ProposalState) : undefined;
      const kind = typeof input.kind === 'string' && KINDS.has(input.kind) ? (input.kind as ProposalKind) : undefined;
      const proposals = await listProposals(scope.tenantId, { ...(state ? { state } : {}), ...(kind ? { kind } : {}) });
      return { content: JSON.stringify({ proposals }) };
    },
  });
}
