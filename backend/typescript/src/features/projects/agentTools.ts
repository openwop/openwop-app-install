/**
 * Projects agent tool (XCH-HOLE-2, LLM-EXCHANGE-AUDIT Wave 4) — the ADR 0308
 * seam. `openwop:projects.list` — the central work container was unreadable
 * by the model. Access mirrors the list route EXACTLY: every project passes
 * through `resolveProjectAccess` for the ACTING USER, so a `private` project
 * the user is not a member of never surfaces (ADR 0054 D5 — no existence
 * leak). Fails empty without an acting user.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { getProject, listVisibleProjects, resolveProjectAccess, type Project } from './projectsService.js';
import { retrieveForProject } from './projectKnowledgeService.js';
import { resolveComputedProjectHealth } from '../../host/projectHealthProviders.js';
import { listMembers } from '../../host/accessControlService.js';
import { getProjectPortfolio } from './portfolio.js';
import { proposeProjectMemory, PROPOSAL_TEXT_MAX } from './memoryProposals.js';
import { OpenwopError } from '../../types.js';

export const PROJECTS_LIST_TOOL_ID = 'openwop:projects.list';
/** ADR 1093 — one project in full. */
export const PROJECTS_GET_TOOL_ID = 'openwop:projects.get';
/** ADR 1092 — search one project's own knowledge and memory. */
export const PROJECTS_KNOWLEDGE_SEARCH_TOOL_ID = 'openwop:projects.knowledge.search';
/** ADR 1094 — one page of the portfolio. */
export const PROJECTS_PORTFOLIO_TOOL_ID = 'openwop:projects.portfolio';
/** ADR 1092 D2 — propose a project memory fact for a person to approve. */
export const PROJECTS_MEMORY_PROPOSE_TOOL_ID = 'openwop:projects.memory.propose';

/** The shared gate for project-keyed reads: an acting user who can read the
 *  project, else the same not-found for missing and hidden projects (ADR 0054 D5). */
async function readable(projectId: unknown, scope: { tenantId: string; actingUserId?: string }): Promise<{ project: Project; level: 'read' | 'write' } | { error: string }> {
  const id = typeof projectId === 'string' ? projectId.trim() : '';
  if (!id) return { error: JSON.stringify({ error: { code: 'validation_error', message: '`projectId` is required (an id from openwop:projects.list).' } }) };
  if (!scope.actingUserId) return { error: JSON.stringify({ error: { code: 'acting_user_required', message: 'Project reads run on behalf of a signed-in person.' } }) };
  const project = await getProject(scope.tenantId, id);
  const level = project && project.tenantId === scope.tenantId ? await resolveProjectAccess(scope.tenantId, project.id, scope.actingUserId) : 'none';
  if (!project || level === 'none') return { error: JSON.stringify({ error: { code: 'not_found', message: 'No project was found for that id, or you cannot open it.' } }) };
  return { project, level };
}

export function registerProjectsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
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

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
    def: {
      name: PROJECTS_GET_TOOL_ID,
      description:
        'Read one project in full: its name, visibility, your access (\'read\' or \'write\'), its charter '
        + '(goal, objectives, brief, status, the health a person set, start and end dates, milestones), '
        + 'its members (name when known, ref and role), the workflows bound to it, and, when a feature computes '
        + 'one, its computed health with the reason and source. Use it after openwop:projects.list to '
        + 'ground work in one project. Read-only; a private project you are not a member of reads as not found.',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string', description: 'A project id from openwop:projects.list.' } }, required: ['projectId'], additionalProperties: false },
    },
    async run(input, scope) {
      const r = await readable(input.projectId, scope);
      if ('error' in r) return { content: r.error, isError: true };
      const p = r.project;
      const { computed } = await resolveComputedProjectHealth({ tenantId: scope.tenantId, project: p, callerUserId: scope.actingUserId! });
      const names = new Map((await listMembers(scope.tenantId, p.orgId)).filter((m) => m.subject).map((m) => [m.subject!, m.displayName?.trim() || 'a member']));
      return { content: JSON.stringify({
        id: p.id, name: p.name, visibility: p.visibility ?? 'org', access: r.level,
        ...(p.facet ? { facet: p.facet } : {}),
        ...(p.charter ? { charter: p.charter } : {}),
        // Names from the org directory, so the model can say who; an agent member keeps its ref.
        members: (p.members ?? []).map((m) => ({ ref: m.ref, role: m.role, ...(names.get(m.ref.replace(/^user:/, '')) ? { name: names.get(m.ref.replace(/^user:/, '')) } : {}) })),
        workflows: p.workflows,
        ...(computed ? { computedHealth: computed } : {}),
      }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
    def: {
      name: PROJECTS_KNOWLEDGE_SEARCH_TOOL_ID,
      description:
        "Search one project's own knowledge: the document collections bound to the project and its "
        + 'project memory. Returns the most relevant chunks, each marked kb or memory, and the sources '
        + 'that could not be searched (failedSources), so an empty answer is never mistaken for "nothing '
        + 'there" when a source failed. Prefer it to openwop:knowledge.search when the question is about '
        + 'a single project. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'A project id from openwop:projects.list.' },
          query: { type: 'string', minLength: 1, description: 'What to look for.' },
          resultLimit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max chunks to return (default 6).' },
        },
        required: ['projectId', 'query'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const r = await readable(input.projectId, scope);
      if ('error' in r) return { content: r.error, isError: true };
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query) return { content: JSON.stringify({ error: { code: 'validation_error', message: '`query` is required.' } }), isError: true };
      const limit = typeof input.resultLimit === 'number' && Number.isInteger(input.resultLimit) ? Math.min(20, Math.max(1, input.resultLimit)) : 6;
      const out = await retrieveForProject(scope.tenantId, r.project.id, query);
      return { content: JSON.stringify({ projectId: r.project.id, chunks: out.chunks.slice(0, limit), hasResults: out.hasResults, failedSources: out.failedSources }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
    def: {
      name: PROJECTS_PORTFOLIO_TOOL_ID,
      description:
        'One page of the projects the current user can see, sorted by name, each with its status, your '
        + "access, its health (the value a person set, and the computed reading with its reason when a "
        + 'feature provides one), its lead, member count and next open milestone. Filter by orgId, '
        + 'lead ("me" or a subject) and status; archived projects are left out unless status is "archived". '
        + 'Page with cursor (the nextCursor of the previous page) and limit (1-100, default 25); total is '
        + 'the count across all pages. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string' }, lead: { type: 'string', description: '"me" or a member subject.' },
          status: { type: 'string', enum: ['planning', 'active', 'paused', 'done', 'archived'] },
          cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return { content: JSON.stringify({ error: { code: 'acting_user_required', message: 'The portfolio is read for a signed-in person.' } }), isError: true };
      try {
        return { content: JSON.stringify(await getProjectPortfolio({ tenantId: scope.tenantId, callerSubject: scope.actingUserId, orgId: input.orgId, lead: input.lead, status: input.status, cursor: input.cursor, limit: input.limit })) };
      } catch (err) {
        if (err instanceof OpenwopError && err.code === 'validation_error') return { content: JSON.stringify({ error: { code: 'validation_error', message: err.message } }), isError: true, fromThrow: true };
        throw err;
      }
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'write',
    def: {
      name: PROJECTS_MEMORY_PROPOSE_TOOL_ID,
      description:
        "Propose a fact for a project's memory (a decision, a preference, something the team should not "
        + 'forget). It is NOT saved yet: it waits on the project\'s Memory tab until a person with write '
        + 'access approves it, and only then becomes project memory. Say so to the person. One short, '
        + `self-contained fact per call, at most ${PROPOSAL_TEXT_MAX} characters; proposing the same text twice files it once.`,
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'A project id from openwop:projects.list.' }, text: { type: 'string', minLength: 1, maxLength: PROPOSAL_TEXT_MAX, description: 'The fact, in one or two sentences.' } },
        required: ['projectId', 'text'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const r = await readable(input.projectId, scope);
      if ('error' in r) return { content: r.error, isError: true };
      try {
        const p = await proposeProjectMemory({ tenantId: scope.tenantId, project: r.project, text: input.text, createdBy: `user:${scope.actingUserId!}`, proposer: scope.agentProfileId ?? scope.runId ?? 'an agent' });
        return { content: JSON.stringify({ proposalId: p.proposalId, status: p.status, note: 'Waiting on the project\'s Memory tab for a person to approve.' }) };
      } catch (err) {
        if (err instanceof OpenwopError && (err.code === 'validation_error' || err.code === 'conflict')) return { content: JSON.stringify({ error: { code: err.code, message: err.message } }), isError: true, fromThrow: true };
        throw err;
      }
    },
  });
}
