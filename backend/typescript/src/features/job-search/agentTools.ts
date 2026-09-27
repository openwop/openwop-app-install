/**
 * ADR 0540 matrix row 4 / ADR 0543 P1 — the job-search CHAT tools.
 *
 * Found by the CFP-1 ratchet, which is worth recording. The career agent's pack
 * originally listed `feature.job-search.nodes.*` in its `toolAllowlist` — but
 * those are workflow NODE type ids, not conversational tool ids. A node runs
 * inside a workflow; an agent tool is the chat-time surface, and the two live in
 * different namespaces. An allowlist entry that resolves to nothing is "a lie to
 * the model in every transport", so the ratchet refused it rather than letting
 * the agent advertise tools it could never call.
 *
 * The exemption list exists but is EMPTY BY DESIGN, and its header says growing
 * it signals the seam needs an RFC. Taking it would have been the wrong fix; the
 * right one is that the tools should exist, which ADR 0540's matrix already
 * said and this closes.
 *
 * Two ADR 0308 rules obeyed literally:
 *
 *  - each tool SHARES the access predicate of the route it mirrors, so route and
 *    tool cannot drift about who may read what;
 *  - each fails EMPTY without an acting user rather than falling back to an
 *    ambient tenant, which would read someone else's workspace.
 *
 * Both are READ-ONLY. Applying is bounded by the ADR 0541 grant and publishing
 * by the ADR 0542 D4 gate; a chat tool that could do either would route around
 * an authority object, which is the whole reason those objects exist.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { JOB_SEARCH_TOGGLE } from './service.js';
import { listListings } from './boards/listing.js';
import { listApplications } from './domain/applications.js';

export const JOB_SEARCH_LISTINGS_TOOL_ID = 'openwop:job-search.listings.read';
export const JOB_SEARCH_APPLICATIONS_TOOL_ID = 'openwop:job-search.applications.read';

const toolError = (code: string, message: string) => ({
  content: JSON.stringify({ error: code, message }),
  isError: true,
});

export function registerJobSearchAgentTools(): void {
  registerFeatureAgentTool({
    // UNTRUSTED. Every field here — title, company, location — is text a JOB
    // BOARD authored, i.e. the most directly attacker-influenced content in this
    // whole vertical. ADR 0542 D3 screens the worst of it out at ingest, but
    // screening is a filter and fencing is the boundary; treating this as
    // trusted because "we stored it" would confuse provenance with safety.
    contentTrust: 'untrusted',
    def: {
      name: JOB_SEARCH_LISTINGS_TOOL_ID,
      description:
        'List the job postings found across this workspace\'s boards, deduped by content. '
        + 'Returns role, company, location, remote flag and which board it came from. '
        + 'Read-only — this never applies to anything and never publishes anything.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max listings to return (default 25).' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!(await resolveFeatureToggle(JOB_SEARCH_TOGGLE, scope))) {
        return toolError('feature_disabled', 'Job search is not enabled for this workspace.');
      }
      if (!scope.actingUserId) return { content: JSON.stringify({ listings: [] }) };

      const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(100, Math.floor(input.limit)))
        : 25;
      const rows = (await listListings(scope.tenantId)).slice(0, limit);
      return {
        content: JSON.stringify({
          listings: rows.map((r) => {
            const v = (r.values ?? {}) as Record<string, unknown>;
            return {
              title: v.title ?? '',
              company: v.company_name ?? '',
              location: v.location ?? null,
              remote: v.remote ?? null,
              board: v.source_board ?? null,
            };
          }),
        }),
      };
    },
  });

  registerFeatureAgentTool({
    // UNTRUSTED for the same reason: a deal title is built from a posting's
    // title and company, so board-authored text rides through the CRM record.
    contentTrust: 'untrusted',
    def: {
      name: JOB_SEARCH_APPLICATIONS_TOOL_ID,
      description:
        'List this workspace\'s job applications and their current pipeline stage. '
        + 'Use it to answer "what have I applied to?" or "what is waiting on a reply?". '
        + 'Read-only — advancing a stage happens through the workflow surface, not here.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization whose applications to list.' },
        },
        required: ['orgId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!(await resolveFeatureToggle(JOB_SEARCH_TOGGLE, scope))) {
        return toolError('feature_disabled', 'Job search is not enabled for this workspace.');
      }
      if (!scope.actingUserId) return { content: JSON.stringify({ applications: [] }) };

      const orgId = typeof input.orgId === 'string' ? input.orgId : '';
      if (!orgId) return { content: JSON.stringify({ applications: [] }) };
      const rows = await listApplications(scope.tenantId, orgId);
      return {
        content: JSON.stringify({
          applications: rows.map(({ deal }) => ({
            title: deal.title,
            stageId: deal.stageId,
            status: deal.status,
          })),
        }),
      };
    },
  });
}
