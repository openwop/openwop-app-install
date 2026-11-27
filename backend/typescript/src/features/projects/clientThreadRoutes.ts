/**
 * ADR 1099 D7 (P3c) — the routes of a project's client threads
 * (`clientThread.ts`). Behind the `projects.client-portal` switch, like every other
 * collaborator surface of a project.
 *
 *  - members: GET  /host/openwop-app/projects/:id/client-threads (read access),
 *             POST /host/openwop-app/projects/:id/client-threads/:collaboratorId (write);
 *  - the collaborator: GET /host/openwop-app/collab/grants/:grantId/messages, their
 *    own thread only, through `checkGrantUse`.
 *
 * A collaborator never POSTs here: their messages arrive through the Project Guide's
 * `message-send` tool and join only when a member approves them.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { checkGrantUse, getCollaborator, kindCollaborationOn, listGrants, type GrantUse } from '../../host/externalCollaborators.js';
import { requireProject } from './routes.js';
import { PROJECT_GRANT_KIND, PROJECTS_CLIENT_PORTAL_TOGGLE } from './clientPortal.js';
import { appendMemberReply, collaboratorView, listClientThread, type ClientThreadEntry } from './clientThread.js';

const notFound = (): OpenwopError => new OpenwopError('not_found', 'Not found.', 404, {});

async function portalOn(tenantId: string): Promise<boolean> {
  return Boolean((await resolveOne(PROJECTS_CLIENT_PORTAL_TOGGLE, { tenantId }))?.enabled);
}

/** Does this collaborator hold a LIVE grant on this project (active, unexpired)? A
 *  member replies only to someone who can still read the reply (casavoga-c9 review:
 *  not to a revoked or erased collaborator whose record survives). */
async function hasProjectGrant(tenantId: string, orgId: string, collaboratorId: string, projectId: string): Promise<boolean> {
  const now = Date.now();
  return (await listGrants(tenantId, orgId, collaboratorId)).some((g) =>
    g.resource.kind === PROJECT_GRANT_KIND && g.resource.id === projectId && g.status === 'active' && Date.parse(g.expiresAt) > now);
}

export function registerProjectClientThreadRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/host/openwop-app/projects/:id/client-threads';

  /** Every collaborator thread of the project, for its members. */
  app.get(BASE, async (req, res, next) => {
    try {
      const project = await requireProject(req, 'workspace:read');
      if (!(await portalOn(project.tenantId))) throw notFound();
      const byCollaborator = new Map<string, ClientThreadEntry[]>();
      for (const e of await listClientThread(project.tenantId, project.id)) {
        byCollaborator.set(e.collaboratorId, [...(byCollaborator.get(e.collaboratorId) ?? []), e]);
      }
      const threads = [];
      for (const [collaboratorId, list] of byCollaborator) {
        const c = await getCollaborator(project.tenantId, project.orgId ?? '', collaboratorId);
        threads.push({ collaboratorId, label: c?.displayName ?? 'Outside collaborator', entries: list.map(({ tenantId: _t, orgId: _o, ...rest }) => rest) });
      }
      res.json({ threads });
    } catch (err) { next(err); }
  });

  /** A member's reply to one collaborator. */
  app.post(`${BASE}/:collaboratorId`, async (req, res, next) => {
    try {
      const project = await requireProject(req, 'workspace:write');
      if (!(await portalOn(project.tenantId)) || !project.orgId) throw notFound();
      const user = await resolveCallerUser(req);
      const collaboratorId = req.params.collaboratorId;
      if (!(await hasProjectGrant(project.tenantId, project.orgId, collaboratorId, project.id))) throw notFound();
      const entry = await appendMemberReply({ tenantId: project.tenantId, orgId: project.orgId, projectId: project.id, collaboratorId, userId: user.userId, text: (req.body ?? {}).text });
      res.status(201).json({ entry: { entryId: entry.entryId, collaboratorId: entry.collaboratorId, author: entry.author, text: entry.text, createdAt: entry.createdAt } });
    } catch (err) { next(err); }
  });

  /** The collaborator's own thread with the firm. Uniform 404 otherwise. */
  app.get('/host/openwop-app/collab/grants/:grantId/messages', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store'); // ADR 0887 S4
      const user = await resolveCallerUser(req);
      let use: GrantUse;
      try {
        use = await checkGrantUse({ grantId: req.params.grantId, via: { userId: user.userId }, action: 'view' });
      } catch {
        throw notFound();
      }
      if (use.grant.resource.kind !== PROJECT_GRANT_KIND || !(await kindCollaborationOn(PROJECT_GRANT_KIND, use.tenantId))) throw notFound();
      const list = await listClientThread(use.tenantId, use.grant.resource.id, use.collaborator.collaboratorId);
      res.json({ messages: list.map(collaboratorView) });
    } catch (err) { next(err); }
  });
}
