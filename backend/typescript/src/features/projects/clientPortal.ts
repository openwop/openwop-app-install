/**
 * ADR 1099 D3 (P1) — a `project` grant kind: a firm can invite a client (or a
 * builder, or any outside party) to ONE project, to view it and to comment.
 *
 * It rides ADR 0958's grants unchanged: the invite, accept, grant, renew and
 * revoke routes are the host's (`routes/externalCollaborators.ts`, ADR 1099 P0b),
 * and every collaborator read goes through `checkGrantUse`. What this module adds
 * is the kind itself and its own collaboration surface, so a firm needs neither
 * campaign-ops nor a client account to use it:
 *
 *  - the switch is the `projects.client-portal` sub-toggle (tenant bucket,
 *    default off). Projects are always-on, so this is the only switch;
 *  - the org rule is "the org exists in this tenant";
 *  - a grant reaches the project only while the project is still in the grant's
 *    org. A project moved to another org, or deleted, is a uniform 404;
 *  - the projection is closed and minimal (the name and the status). What else a
 *    client may see is the firm's choice, made per field in P3 (answer 4).
 *
 * Who may invite and grant stays the default, `host:members:manage` on the org,
 * re-checked for the granter on every use. A project delete revokes its grants.
 *
 * @see docs/adr/1099-project-scoped-client-collaboration.md
 */
import { getOrg } from '../../host/accessControlService.js';
import { listGrants, registerGrantResourceKind, revokeGrant } from '../../host/externalCollaborators.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { registerSubjectDependent } from '../../host/subjectDependents.js';
import { getProject, listProjects, type Project } from './projectsService.js';

export const PROJECT_GRANT_KIND = 'project';
export const PROJECTS_CLIENT_PORTAL_TOGGLE = 'projects.client-portal';
/** The actor a project delete revokes its grants as. */
const DELETE_ACTOR = 'system:project-delete';

/** The project, if it is still in `orgId` of `tenantId`. */
async function projectInOrg(tenantId: string, orgId: string, id: string): Promise<Project | null> {
  const p = await getProject(tenantId, id);
  return p && p.tenantId === tenantId && p.orgId === orgId ? p : null;
}

async function clientPortalOn(tenantId: string): Promise<boolean> {
  return Boolean((await resolveOne(PROJECTS_CLIENT_PORTAL_TOGGLE, { tenantId }))?.enabled);
}

export function registerProjectClientPortal(): void {
  registerGrantResourceKind(PROJECT_GRANT_KIND, {
    featureId: PROJECTS_CLIENT_PORTAL_TOGGLE,
    actions: ['view', 'comment'],
    surface: {
      enabledFor: clientPortalOn,
      async orgOpen(tenantId, orgId) { return (await getOrg(orgId))?.tenantId === tenantId; },
    },
    async exists(tenantId, orgId, id) { return (await projectInOrg(tenantId, orgId, id)) !== null; },
    async project(tenantId, orgId, id) {
      const p = await projectInOrg(tenantId, orgId, id);
      if (!p) return null;
      return { title: p.name, body: { kind: 'project', name: p.name, ...(p.charter?.status ? { status: p.charter.status } : {}) } };
    },
    async list(tenantId, orgId) {
      return (await listProjects(tenantId)).filter((p) => p.orgId === orgId).map((p) => ({ id: p.id, title: p.name }));
    },
  });

  // A deleted project's grants are revoked, so the firm's panel and the audit say
  // so instead of leaving grants that only fail at use.
  const liveGrantsOf = async (tenantId: string, projectId: string) => {
    const p = await getProject(tenantId, projectId);
    if (!p) return [];
    return (await listGrants(tenantId, p.orgId)).filter((g) => g.status === 'active' && g.resource.kind === PROJECT_GRANT_KIND && g.resource.id === projectId);
  };
  registerSubjectDependent('project', 'collaboratorGrants', {
    count: async (tenantId, subject) => (await liveGrantsOf(tenantId, subject.id)).length,
    purge: async (tenantId, subject) => {
      let n = 0;
      for (const g of await liveGrantsOf(tenantId, subject.id)) {
        await revokeGrant(tenantId, g.orgId, g.grantId, DELETE_ACTOR);
        n += 1;
      }
      return n;
    },
  });
}
