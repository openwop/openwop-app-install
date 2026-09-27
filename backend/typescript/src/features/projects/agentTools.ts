/**
 * Projects agent tool (XCH-HOLE-2, LLM-EXCHANGE-AUDIT Wave 4) — the ADR 0308
 * seam. `openwop:projects.list` — the central work container was unreadable
 * by the model. Access mirrors the list route EXACTLY: every project passes
 * through `resolveProjectAccess` for the ACTING USER, so a `private` project
 * the user is not a member of never surfaces (ADR 0054 D5 — no existence
 * leak). Fails empty without an acting user.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { listVisibleProjects } from './projectsService.js';

export const PROJECTS_LIST_TOOL_ID = 'openwop:projects.list';

export function registerProjectsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: PROJECTS_LIST_TOOL_ID,
      // UX_UPGRADE-projects R2 (PRJ2-M6) — this used to advertise a
      // `description` field. No row has ever carried one: the descriptive text
      // a project holds is its charter `goal`, and `goal`/`facet`/`access` —
      // all three returned — went undeclared. A model told to expect
      // `description` and handed rows without it reads that as "these projects
      // are undescribed", which is a claim about the portfolio rather than
      // about the payload. Every field named here is emitted below; `goal` and
      // `status` are ABSENT when the project has no charter, which is stated
      // so their absence is not read as an empty value.
      description:
        'List the projects the current user can see. Each row: id, name, visibility, memberCount, '
        + "access ('read' or 'write'), an optional facet, and — only when the project has a charter — "
        + 'its goal (the project\'s one-line description) and status. Use it to ground work in the '
        + 'ACTUAL project portfolio before planning or filing anything. Read-only; private projects '
        + 'the user is not a member of are not shown.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope) {
      if (!scope.actingUserId) {
        return { content: JSON.stringify({ projects: [], note: 'no acting user on this run — nothing visible' }) };
      }
      // The route passes the BARE acting-user id as callerSubject — mirror it.
      // PRJC-3 / WF-PRJ-4 — the SAME shared scan the list route uses (one
      // predicate, one loop): access resolved once per (caller, org), rows
      // reused, private projects still never surface.
      const caller = scope.actingUserId;
      const visible = (await listVisibleProjects(scope.tenantId, caller)).map(({ project: p, level }) => ({
        id: p.id,
        name: p.name,
        ...(p.facet ? { facet: p.facet } : {}),
        ...(p.charter?.goal ? { goal: p.charter.goal } : {}),
        ...(p.charter?.status ? { status: p.charter.status } : {}),
        visibility: p.visibility ?? 'org',
        memberCount: p.members?.length ?? 0,
        access: level,
      }));
      return { content: JSON.stringify({ projects: visible }) };
    },
  });
}
