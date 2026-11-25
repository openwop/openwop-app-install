/**
 * Projects (ADR 0046 / ADR 0045 Phase 3). A `kind:'project'` Subject — a bare work
 * container that owns the SAME surfaces an agent/person does (board, memory,
 * assigned workflows) over the unified subject model, with no cognition and no
 * authority of its own (org-scoped). Adds no new infrastructure: the board rides
 * the generic `ownerSubject` (kanban), memory rides the `project:<id>` scope
 * (subjectMemory).
 *
 * § Correction (2026-06-15) — GRADUATED off the feature toggle (always-on). The
 * routes serve unconditionally; access is still org-scoped (a caller acts only on
 * projects in orgs where they hold the scope, and the list filters to readable
 * projects), so always-on is safe — the toggle only ever gated visibility.
 *
 * @see docs/adr/0046-project-subject.md
 */

import { registerMemoryProposalLifecycle } from './memoryProposals.js';
import type { BackendFeature } from '../types.js';
import { setSubjectOrgResolver } from '../../host/subjectOrgScope.js';
import { registerSubjectAccessResolver, registerSubjectRoleResolver } from '../../host/subjectAccess.js';
import { registerSubjectDependent } from '../../host/subjectDependents.js';
import { deleteCanvasForTenant, listCanvasIdsOwnedBy } from '../../host/canvasSurface.js';
import { registerProjectsAgentTools } from './agentTools.js';
import { registerProjectsRoutes } from './routes.js';
import { ADDRESSABLE_PROJECT_ROLES, getProject, listProjects, projectRoleOf, resolveProjectAccess, registerProjectsErasure } from './projectsService.js';
import { registerPrivateProjectProbe } from '../../host/runProjectAccess.js';
import { PROJECTS_CLIENT_PORTAL_TOGGLE, registerProjectClientPortal } from './clientPortal.js';

export const projectsFeature: BackendFeature = {
  id: 'projects',
  registerRoutes: (deps) => {
    registerProjectsRoutes(deps);
    registerProjectsAgentTools(); // XCH-HOLE-2 (Wave 4) — openwop:projects.list (ADR 0308 seam)
    registerMemoryProposalLifecycle(); // ADR 1092 D2 — proposals' eraser and project-delete cascade
    registerProjectsErasure(); // D2 (chat-first port) — DSAR anonymizes a member's ref in place
    registerProjectClientPortal(); // ADR 1099 D3 — the `project` grant kind behind `projects.client-portal`

    // ADR 0054 § Correction (2026-06-16) — the `project-collab` toggle is RETIRED;
    // the collaborative surfaces (members / visibility / chat) are now always-on.
    // WRITE stays org-scoped via `requireProject('workspace:write')` (membership
    // never grants authority), and a `private` project is read-gated to its members
    // via the `subjectAccess` seam below — so always-on is safe. The id is listed in
    // features/index.ts RETIRED_TOGGLE_IDS so any stale durable override is cleared.
    // Fill the subject→org seam so kanban + documents can DERIVE a PROJECT board's
    // owning org (ADR 0046). A `kind:'project'` board's org is the project's
    // current org; every other kind is tenant-global/personal (null).
    setSubjectOrgResolver(async (tenantId, subject) =>
      subject.kind === 'project' ? (await getProject(tenantId, subject.id))?.orgId ?? null : null,
    );
    // Fill the subject→access seam so kanban gates a PROJECT board's surfaces on
    // the caller's RESOLVED access (org authority composed with the project's
    // visibility + members, ADR 0054 D5). Registered PER KIND (ADR 0278) — the
    // seam dispatches on subject.kind, so other features' kinds can't collide.
    registerSubjectAccessResolver('project', async (tenantId, subject, caller) =>
      resolveProjectAccess(tenantId, subject.id, caller),
    );
    // ADR 1133 — which of a tenant's projects are private, read once per request by
    // the run read gate, so a tenant with none pays nothing per run.
    registerPrivateProjectProbe(async (tenantId) =>
      new Set((await listProjects(tenantId)).filter((p) => p.visibility === 'private').map((p) => p.id)),
    );
    // ADR 1137 D4 — a project board's card may be addressed to `project:lead` or
    // `project:contributor`; kanban asks this for the viewer's ADR 1095 role.
    registerSubjectRoleResolver('project', {
      addressable: ADDRESSABLE_PROJECT_ROLES,
      roleOf: async (tenantId, subject, userId) => {
        const p = await getProject(tenantId, subject.id);
        return p ? projectRoleOf(p, userId) ?? null : null;
      },
    });
    // ADR 0839 D2 — canvases a project OWNS (`ownerSubject`) go with it. The canvas
    // store is host-owned, so its registrant lives with the subject's owner; the delete
    // is the canvas's single owner (`deleteCanvasForTenant`: versions, idem row, and the
    // lifecycle fan-out that purges share links and comments).
    registerSubjectDependent('project', 'canvases', {
      count: async (tenantId, subject) => (await listCanvasIdsOwnedBy(tenantId, subject)).length,
      purge: async (tenantId, subject) => {
        let n = 0;
        for (const canvasId of await listCanvasIdsOwnedBy(tenantId, subject)) {
          if (await deleteCanvasForTenant(tenantId, canvasId)) n += 1;
        }
        return n;
      },
    });
  },
  // ADR 1099 D5 (P2) — the Project Guide, the agent a project's collaborator talks to.
  requiredPacks: ['vendor.openwop-app.projects.agents'],
  // No `toggleDefault` — always-on. The collaborative surfaces (members /
  // visibility / chat, ADR 0054) are also always-on as of 2026-06-16 (§ Correction
  // in registerRoutes); WRITE stays org-scoped, READ honors project visibility.
  //
  // ADR 1099 D3 — the one sub-toggle: inviting outside parties (a client, a
  // builder) to one project. Its only consumer is the `project` grant kind's
  // surface (`clientPortal.ts`), which checks it on every invite, grant and use.
  extraToggleDefaults: [{
    id: PROJECTS_CLIENT_PORTAL_TOGGLE,
    label: 'Project client access',
    description:
      'Invite people outside your workspace, such as a client or a builder, to one project. They sign in with their own account, see only that project, and only for as long as you grant. You can take access back at any time.',
    category: 'Productivity',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'projects-client-portal',
  }],
};
