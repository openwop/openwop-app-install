/**
 * Projects routes (ADR 0046) — host-extension. A project is an org-scoped Subject
 * that owns a board + memory + assigned workflows. It has NO authority of its own
 * (ADR 0045): every route gates on the caller's RBAC scope IN the project's org
 * (read to view, write to mutate) Always-on (graduated off its toggle). Tenant-IDOR throughout.
 *
 * Surface under /v1/host/openwop-app/projects:
 *   GET    /                     list projects                       [workspace:read]
 *   POST   /                     create (+ its board)                [workspace:write in body.orgId]
 *   GET    /:id                  one project (+ board id)            [workspace:read]
 *   PATCH  /:id                  rename / set workflows              [workspace:write]
 *   DELETE /:id                  delete + cascade (board, memory)    [workspace:write]
 *   GET/POST/DELETE /:id/memory  the project's memory                [read / write]
 *   GET    /:id/knowledge        the project's bound docs + notes    [workspace:read]
 *   POST   /:id/knowledge/retrieve   read-only corpus search         [workspace:read]
 *   POST/DELETE /:id/knowledge/bindings[/:cid]  bind/unbind a KB col [project write]
 *   POST   /:id/knowledge/collections        create + bind a col    [project write + write in doc's org]
 *   POST/DELETE /:id/knowledge/collections/:cid/documents  ingest / delete doc [project read + write in doc's org]
 *
 * Knowledge rides the GENERIC `host/subjectKnowledge` binding (keyed on the
 * `project:<id>` subject) + the shared `resolveSubjectKnowledgeRetrieve` — no
 * project-specific retrieval. See `projectKnowledgeService.ts`.
 *
 *   GET    /:id/schedules            the project's cron schedules        [workspace:read]
 *   POST   /:id/schedules            create a schedule                   [workspace:write]
 *   PATCH  /:id/schedules/:jobId     enable/disable / re-cadence         [workspace:write]
 *   DELETE /:id/schedules/:jobId     delete a schedule                   [workspace:write]
 *
 * Schedules ride the ONE scheduler (`host/schedulingService.ts`) via the generic
 * `ownerSubject = project:<id>` — no parallel scheduler. See `projectScheduleService.ts`.
 *
 * @see docs/adr/0046-project-subject.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireString } from '../featureRoute.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { subjectBoardId } from '../../host/kanbanService.js';
import { addSubjectNote, listSubjectNotes, removeSubjectNote } from '../../host/subjectMemory.js';
import { listAllTenantCollections } from '../kb/kbService.js';
import {
  createProject, getProject, listProjects, updateProject, deleteProject, projectSubject,
  resolveProjectAccess, addProjectMember, removeProjectMember, setProjectVisibility, type Project,
} from './projectsService.js';
import {
  getProjectKnowledge, bindCollection, unbindCollection, createBoundCollection,
  ingestDocToProject, deleteDocFromProject, retrieveForProject,
  projectShareableKbProvider,
} from './projectKnowledgeService.js';
import { registerShareableKb } from '../../host/shareableKb.js';
import {
  listProjectSchedules, createProjectSchedule, updateProjectSchedule, deleteProjectSchedule,
} from './projectScheduleService.js';
import {
  subjectConversationId, ensureConversationMeta, getConversationMeta, addParticipant, removeParticipant,
} from '../../host/conversationStore.js';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** RBAC: the caller's scope IN an org (a project has no authority of its own). */
/** Boolean: does the caller hold `scope` IN `orgId`? (the tenant owner implicitly
 *  holds every scope in every org). */
async function hasOrgScope(req: Request, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  return access.scopes.includes(scope);
}

async function requireOrgScope(req: Request, orgId: string, scope: Scope): Promise<void> {
  if (!(await hasOrgScope(req, orgId, scope))) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}

/** Resolve a project + gate on the caller's RESOLVED access (ADR 0054 D5 —
 *  `resolveProjectAccess` composes org authority with the project's visibility +
 *  members). NO-EXISTENCE-LEAK: a caller with no read access (org-reader of a
 *  `private` project they're not a member of, or a non-member entirely) gets a
 *  uniform 404. With read present, a WRITE op missing write → 403. WRITE is always
 *  org-scoped — membership never grants it. This gate fronts EVERY project-owned
 *  surface (the project, its memory, knowledge, schedules), so a private project
 *  can't leak through any of them. (The board is gated identically in kanban via
 *  the `subjectAccess` seam.) */
async function requireProject(req: Request, scope: Scope): Promise<Project> {
  const project = await getProject(tenantOf(req), req.params.id);
  const level = project ? await resolveProjectAccess(tenantOf(req), project.id, actingUserOf(req)) : 'none';
  if (!project || level === 'none') {
    throw new OpenwopError('not_found', 'Project not found.', 404, { id: req.params.id });
  }
  if (scope === 'workspace:write' && level !== 'write') {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  }
  return project;
}

const view = (tenantId: string) => async (
  id: string,
  callerSubject?: string,
): Promise<(Project & { boardId: string; canWrite?: boolean }) | null> => {
  const p = await getProject(tenantId, id);
  if (!p) return null;
  const boardId = subjectBoardId(tenantId, projectSubject(id));
  // ADR 0063 — project the caller's effective WRITE access so the FE can pre-gate
  // write affordances (add member / visibility / charter / delete …) instead of
  // showing controls that 403 on use. This is a UX hint ONLY: `requireProject`
  // remains the authority on every write route (visibility ≠ authority, ADR 0054
  // D5 — write is `workspace:write` in the project's org, never membership). The
  // same `resolveProjectAccess` the gate uses computes it, so the FE never
  // re-derives the rule. Omitted when no caller is supplied (internal callers).
  if (callerSubject === undefined) return { ...p, boardId };
  return { ...p, boardId, canWrite: (await resolveProjectAccess(tenantId, id, callerSubject)) === 'write' };
};

export function registerProjectsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/projects';
  registerShareableKb(projectShareableKbProvider); // ADR 0100 D2 — board can share project KBs

  app.get(BASE, async (req, res, next) => {
    try {
      // Access-scoped LIST (ADR 0054 D5): only projects the caller can read —
      // `resolveProjectAccess` composes org `workspace:read` with the project's
      // visibility/members, so a `private` project the caller isn't a member of is
      // dropped (can't leak metadata the per-id GET would 404). Bounded by PROJECT_CAP.
      const tenantId = tenantOf(req);
      const project = view(tenantId);
      const caller = actingUserOf(req);
      const out: unknown[] = [];
      for (const p of await listProjects(tenantId)) {
        const level = await resolveProjectAccess(tenantId, p.id, caller);
        if (level === 'none') continue;
        // Reuse the level already resolved for the read filter: call view WITHOUT a
        // caller (so it does NOT resolve access a second time) and stamp canWrite
        // from `level` (ADR 0063). Avoids doubling the per-project access scan.
        const base = await project(p.id);
        if (base) out.push({ ...base, canWrite: level === 'write' });
      }
      res.json({ projects: out });
    } catch (err) { next(err); }
  });

  app.post(BASE, async (req, res, next) => {
    try {
      const orgId = requireString((req.body ?? {})?.orgId, 'orgId');
      await requireOrgScope(req, orgId, 'workspace:write');
      const project = await createProject(tenantOf(req), orgId, (req.body ?? {}) as { name?: unknown });
      res.status(201).json(await view(tenantOf(req))(project.id, actingUserOf(req)));
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/:id`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:read');
      res.json(await view(tenantOf(req))(id, actingUserOf(req)));
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/:id`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:write');
      await updateProject(tenantOf(req), id, (req.body ?? {}) as { name?: unknown; workflows?: unknown; charter?: unknown; moderatorRosterId?: unknown; turnPolicy?: unknown });
      res.json(await view(tenantOf(req))(id, actingUserOf(req)));
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:id`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:write');
      res.json(await deleteProject(tenantOf(req), id));
    } catch (err) { next(err); }
  });

  // ── the project's memory (the `project:<id>` subject scope) ──
  app.get(`${BASE}/:id/memory`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:read');
      res.json({ notes: await listSubjectNotes(tenantOf(req), projectSubject(id)) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/:id/memory`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:write');
      await addSubjectNote(tenantOf(req), projectSubject(id), (req.body ?? {})?.content);
      res.status(201).json({ notes: await listSubjectNotes(tenantOf(req), projectSubject(id)) });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:id/memory/:noteId`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:write');
      const removed = await removeSubjectNote(tenantOf(req), projectSubject(id), req.params.noteId);
      if (!removed) throw new OpenwopError('not_found', 'Memory not found.', 404, { noteId: req.params.noteId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── the project's KNOWLEDGE (cited documents — the generic subject binding) ──
  const orgOf = (req: Request): string => requireString((req.body ?? {})?.orgId, 'orgId');

  app.get(`${BASE}/:id/knowledge`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:read');
      res.json(await getProjectKnowledge(tenantOf(req), id));
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/:id/knowledge/retrieve`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:read');
      const query = requireString((req.body ?? {})?.query, 'query');
      res.json(await retrieveForProject(tenantOf(req), id, query));
    } catch (err) { next(err); }
  });

  // Bind an existing collection. Mutating the project's binding set is a PROJECT
  // write (symmetric with unbind + the memory surface) — a read-only collaborator
  // must not be able to change what the project's agents/workflows retrieve. ALSO
  // needs read in the collection's org (can't bind what you can't see).
  app.post(`${BASE}/:id/knowledge/bindings`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:write');
      const collectionId = requireString((req.body ?? {})?.collectionId, 'collectionId');
      const col = (await listAllTenantCollections(tenantOf(req))).find((c) => c.collectionId === collectionId);
      if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
      await requireOrgScope(req, col.orgId, 'workspace:read');
      await bindCollection(tenantOf(req), id, collectionId);
      res.status(201).json(await getProjectKnowledge(tenantOf(req), id));
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:id/knowledge/bindings/:collectionId`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:write');
      await unbindCollection(tenantOf(req), id, req.params.collectionId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // Create + bind a new collection. Binding mutates the project → PROJECT write
  // (like bind/unbind); creating the collection → write IN the doc's org.
  app.post(`${BASE}/:id/knowledge/collections`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:write');
      const orgId = orgOf(req);
      await requireOrgScope(req, orgId, 'workspace:write');
      res.status(201).json(await createBoundCollection(tenantOf(req), orgId, actingUserOf(req) ?? 'unknown', id, (req.body ?? {}) as { name?: unknown; description?: unknown }));
    } catch (err) { next(err); }
  });

  // Ingest / delete a doc edits the (already-bound) KB collection, not the project's
  // binding set — so project READ + write IN the doc's org is the right gate.
  app.post(`${BASE}/:id/knowledge/collections/:collectionId/documents`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:read');
      const orgId = orgOf(req);
      await requireOrgScope(req, orgId, 'workspace:write');
      res.status(201).json(await ingestDocToProject(tenantOf(req), orgId, actingUserOf(req) ?? 'unknown', id, req.params.collectionId, (req.body ?? {}) as { title?: unknown; text?: unknown; contentBase64?: unknown; contentType?: unknown }));
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:id/knowledge/collections/:collectionId/documents/:documentId`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:read');
      const orgId = orgOf(req);
      await requireOrgScope(req, orgId, 'workspace:write');
      await deleteDocFromProject(tenantOf(req), orgId, id, req.params.collectionId, req.params.documentId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── the project's SCHEDULES (cron jobs owned by the project subject) ──
  app.get(`${BASE}/:id/schedules`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:read');
      res.json({ schedules: await listProjectSchedules(tenantOf(req), id) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/:id/schedules`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:write');
      const schedule = await createProjectSchedule(tenantOf(req), id, (req.body ?? {}) as { cronExpr?: unknown; workflowId?: unknown; timezone?: unknown });
      res.status(201).json(schedule);
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/:id/schedules/:jobId`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:write');
      const schedule = await updateProjectSchedule(tenantOf(req), id, req.params.jobId, (req.body ?? {}) as { enabled?: unknown; cronExpr?: unknown; workflowId?: unknown; timezone?: unknown });
      res.json(schedule);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:id/schedules/:jobId`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:write');
      await deleteProjectSchedule(tenantOf(req), id, req.params.jobId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── ADR 0054 D2/D5 — membership + visibility (always-on since 2026-06-16; the
  //    `project-collab` toggle was retired. WRITE stays org-scoped via
  //    `requireProject('workspace:write')` — membership never grants authority). ──
  app.get(`${BASE}/:id/members`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:read');
      const p = await getProject(tenantOf(req), id);
      res.json({ members: p?.members ?? [], visibility: p?.visibility ?? 'org' });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/:id/members`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:write');
      const body = (req.body ?? {}) as { ref?: unknown; role?: unknown };
      const updated = await addProjectMember(tenantOf(req), id, body.ref, body.role);
      res.status(201).json({ members: updated.members ?? [] });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:id/members/:ref`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:write');
      await removeProjectMember(tenantOf(req), id, decodeURIComponent(req.params.ref));
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/:id/visibility`, async (req, res, next) => {
    try {
      const { id } = await requireProject(req, 'workspace:write');
      await setProjectVisibility(tenantOf(req), id, (req.body ?? {})?.visibility);
      res.json(await view(tenantOf(req))(id, actingUserOf(req)));
    } catch (err) { next(err); }
  });

  // ── ADR 0054 D3 — the project group chat ──
  // Ensure (idempotent) the ONE `type:'group'` conversation bound to `project:<id>`
  // (ADR 0043 substrate; no second chat system), seed its lineup from the project's
  // AGENT members, and return its sessionId for the chat surface to open. Gated on
  // project READ access (so a `private` project's chat is gated to its members like
  // every other surface — `requireProject` already enforces; always-on since 2026-06-16).
  app.post(`${BASE}/:id/chat`, async (req, res, next) => {
    try {
      const p = await requireProject(req, 'workspace:read'); // also loads the project (no re-fetch)
      const tenantId = tenantOf(req);
      const sessionId = subjectConversationId(tenantId, projectSubject(p.id));
      const agentRefs = (p.members ?? []).filter((m) => m.ref.startsWith('agent:')).map((m) => m.ref);
      const ts = new Date().toISOString();
      try {
        await deps.storage.createChatSession({ sessionId, tenantId, title: `${p.name} · project`, createdAt: ts, updatedAt: ts, messageCount: 0 });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' && code !== '23505') throw err; // already exists ⇒ reuse
      }
      await ensureConversationMeta(tenantId, sessionId, {
        type: 'group',
        ...(actingUserOf(req) ? { ownerUserId: actingUserOf(req) } : {}),
        ownerSubject: projectSubject(p.id),
        participants: agentRefs,
      });
      // Reconcile the lineup to the project's CURRENT agent members — add the
      // newly-added AND prune agents since removed (the meta is create-or-return,
      // so a re-open tracks roster changes both ways; a removed agent must not keep
      // responding). People are NOT participants — they reach the room via
      // membership (the `subjectAccess` read gate), so only `agent:` refs are synced.
      const meta = await getConversationMeta(tenantId, sessionId);
      const want = new Set(agentRefs);
      const have = (meta?.participants ?? []).map((pp) => pp.subjectRef);
      for (const ref of agentRefs) {
        if (!have.includes(ref)) await addParticipant(tenantId, sessionId, ref);
      }
      for (const ref of have) {
        if (ref.startsWith('agent:') && !want.has(ref)) await removeParticipant(tenantId, sessionId, ref);
      }
      res.status(201).json({ sessionId });
    } catch (err) { next(err); }
  });
}
