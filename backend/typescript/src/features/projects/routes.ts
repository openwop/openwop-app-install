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
  createProject, getProject, updateProject, deleteProject, projectSubject,
  resolveProjectAccess, listVisibleProjects, addProjectMember, removeProjectMember, setProjectVisibility,
  notebookCorpusToDelete, orderProjectAgentCohort, type Project,
} from './projectsService.js';
import { MAX_MULTI_PARTY_PARTICIPANTS } from '../../host/multiPartyConversation.js';
import { deleteNotebook, getNotebook } from '../notebooks/notebooksService.js';
import { deleteConversationCompletely } from '../../host/conversationCascade.js';
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
  subjectConversationId, ensureConversationMeta, getConversationMeta, addParticipant, removeParticipant, refreshEntityChatTitle,
} from '../../host/conversationStore.js';
import { getRosterEntry } from '../../host/rosterService.js';

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
): Promise<(Project & { boardId: string; canWrite?: boolean; deletesCorpus: boolean }) | null> => {
  const p = await getProject(tenantId, id);
  if (!p) return null;
  const boardId = subjectBoardId(tenantId, projectSubject(id));
  // ADR 0601 § Corrections (HIGH-2) — does deleting this project ERASE a source
  // corpus? The delete confirm needs the answer, and it must be the SAME answer
  // the eraser acts on, so it comes from `notebookCorpusToDelete` rather than
  // being re-derived on the client. It was re-derived, as `facet === 'notebook'`,
  // and `ensureNotebookForProject` never sets `facet` — so every project
  // provisioned by opening the Sources tab got the generic warning and learned
  // its corpus was destroyed from the SUCCESS TOAST. Irreversible destruction
  // disclosed after the fact.
  //
  // NO extra read: the predicate is a field on the row `getProject` already
  // returned. The `projects-list-scan-costs.test.ts` concern about a per-row
  // computation does not apply — there is no computation, and the list route's
  // per-row cost is unchanged.
  const deletesCorpus = notebookCorpusToDelete(p) !== undefined;
  // ADR 0063 — project the caller's effective WRITE access so the FE can pre-gate
  // write affordances (add member / visibility / charter / delete …) instead of
  // showing controls that 403 on use. This is a UX hint ONLY: `requireProject`
  // remains the authority on every write route (visibility ≠ authority, ADR 0054
  // D5 — write is `workspace:write` in the project's org, never membership). The
  // same `resolveProjectAccess` the gate uses computes it, so the FE never
  // re-derives the rule. Omitted when no caller is supplied (internal callers).
  if (callerSubject === undefined) return { ...p, boardId, deletesCorpus };
  return { ...p, boardId, deletesCorpus, canWrite: (await resolveProjectAccess(tenantId, id, callerSubject)) === 'write' };
};

export function registerProjectsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/projects';
  registerShareableKb(projectShareableKbProvider); // ADR 0100 D2 — board can share project KBs

  app.get(BASE, async (req, res, next) => {
    try {
      // Access-scoped LIST (ADR 0054 D5): only projects the caller can read —
      // the shared `listVisibleProjects` scan (PRJC-3) applies the SAME
      // visibility rule as `resolveProjectAccess`, with org access resolved
      // ONCE per (caller, org) and the in-hand row reused (the old loop
      // re-fetched each row and re-scanned members/customRoles/groups per
      // project). A `private` project the caller isn't a member of is dropped
      // (can't leak metadata the per-id GET would 404). Bounded by PROJECT_CAP.
      const tenantId = tenantOf(req);
      res.json({
        projects: (await listVisibleProjects(tenantId, actingUserOf(req))).map(({ project, level }) => ({
          ...project,
          boardId: subjectBoardId(tenantId, projectSubject(project.id)),
          canWrite: level === 'write', // ADR 0063 — stamped from the level already resolved
        })),
      });
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
      const project = await requireProject(req, 'workspace:write');
      const { id } = project;
      await updateProject(tenantOf(req), id, (req.body ?? {}) as { name?: unknown; workflows?: unknown; charter?: unknown; moderatorRosterId?: unknown; turnPolicy?: unknown });
      res.json(await view(tenantOf(req))(id, actingUserOf(req)));
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:id`, async (req, res, next) => {
    try {
      // `requireProject` already authorized AND returned the row — re-reading it
      // with `getProject` was a second round-trip for data in hand.
      const project = await requireProject(req, 'workspace:write');
      const { id } = project;
      // R2 PRJ2-B2 — a NOTEBOOK is a project (`facet: 'notebook'`) whose bound collection
      // is EXCLUSIVE to it. `deleteNotebook` deletes that collection; this route did not,
      // and the projects list shows notebooks as ordinary tiles with an ordinary Delete
      // (the client type drops `facet` entirely). So deleting one from /projects left the
      // whole ingested corpus and its embeddings with no owner, no surface and no eraser
      // that could reach it — under a confirm that says "cannot be undone".
      // Delegated at the ROUTE: `notebooksService` imports `projectsService`, so calling
      // the other way round in the service layer would be a cycle.
      const tenantId = tenantOf(req);
      // R2 PRJ2-M1 — the project's group conversation, cascaded HERE because the
      // full cascade needs `deps.storage` (the session row + its messages), which
      // the service layer has no handle on. It must run in FULL or not at all:
      // deleting only the meta — the one piece reachable from the service —
      // strips the privacy lock off a surviving session, because
      // `conversationVisibility` treats a conversation with no meta as
      // tenant-visible. The first version of this fix did exactly that and
      // published private project chats to the whole workspace.
      //
      // ADR 0601 / NBC-1 — this used to branch `if (project?.facet === 'notebook')`
      // before delegating, and the branch was the bug. The ADR 0084 correction
      // redefined a notebook as ANY project with a bound KB collection, and
      // `ensureNotebookForProject` (what opening the Sources tab calls) never
      // stamps `facet`. So for every ensure-provisioned project the branch was
      // FALSE, plain `deleteProject` ran, and the exclusive corpus was left with no
      // owner — the very PRJ2-B2 orphan the branch exists to prevent, still live on
      // the lane the correction created.
      //
      // Note this guard lived at the CALLER, so removing the matching one inside
      // `deleteNotebook` does nothing for this door. Both had to move together.
      //
      // The branch stays; its DISCRIMINATOR is what changes. It now asks
      // `getNotebook` — the same question the notebooks door asks — instead of
      // reading a `facet` field that only one of the two provisioning lanes ever
      // sets. The two doors now agree by construction rather than by coincidence,
      // and a plain project's delete path is unchanged.
      //
      // Cascade order matches the notebooks door: the row delete first, then the
      // conversation — UNCONDITIONALLY, and reported truthfully.
      //
      // CORRECTED (ADR 0601 § Corrections / MEDIUM-6): this used to gate the
      // cascade on `out.deleted`, which made it unreachable in the concurrent-
      // delete race (both doors re-read the project between the guard and the
      // delete) and left the stranded-meta self-heal at
      // `conversationCascade.ts:34` with no caller. See the notebooks door for
      // the full reasoning — the two must stay identical, which is why the
      // sequence is asserted through BOTH in one test.
      const isNotebook = (await getNotebook(tenantId, id)) !== null;
      const out = isNotebook
        ? await deleteNotebook(tenantId, id)
        : { ...(await deleteProject(tenantId, id)), collectionDeleted: false };
      const conversationsDeleted = (await deleteConversationCompletely(
        deps.storage, tenantId, subjectConversationId(tenantId, projectSubject(id)),
      )) ? 1 : 0;
      const { collectionDeleted, ...rest } = out;
      res.json({ ...rest, conversationsDeleted, notebookCorpusDeleted: collectionDeleted });
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
      // ADR 0666 D2 follow-up — the project lane keeps its 204 contract; the partial-recall
      // flag is surfaced on the personal lane only (its own surface, its own copy). `PKWF-15`.
      const { removed } = await removeSubjectNote(tenantOf(req), projectSubject(id), req.params.noteId);
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
      // ADR 0643 R3 (Blocker 2) — the project door above resolved this caller's membership
      // of THIS project, not of the project the collection may be bound to; resolve the
      // COLLECTION with the binder's own principal (a member of P1 must not bind P2's
      // private corpus into P1, where P1's agents then read it pre-authorized).
      const col = (await listAllTenantCollections(tenantOf(req), { subject: actingUserOf(req) })).find((c) => c.collectionId === collectionId); // KBC-1
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
      // `COLWF-1` — seat the CHAT-CALLABLE projection, not the roster id.
      //
      // A project member ref is `agent:<rosterId>` by contract (`projectsService` validates it
      // with `getRosterEntry`, and its own error message says so). This seated that ref
      // VERBATIM — but `participantRosterOf` reads the suffix as an AGENT ID, and the RFC 0101
      // speaker rule compares it against `answeringId`, which is the registry projection
      // `agentRef.agentId`. A rosterId is `host:<slug(persona)>`; the projection is the
      // chat-callable id. They never coincide for a real member, so EVERY agent turn in a
      // project room 422'd — the chair's opener included, which halted the cadence on its first
      // edge and meant no project convene ever produced a single agent turn.
      //
      // The BOARD lane already does this mapping and states the reason: `boardCohortAgentRefs`
      // resolves each rosterId and seats `agent:${entry.agentRef.agentId}` "so RFC 0101 roster
      // enforcement matches dispatched ids". Projects was the only `type:'group'` producer
      // seating an id from the roster namespace.
      //
      // This is the ADR 0608 D6 closure INVERTED: before it the guard was a silent no-op, so
      // the mismatch was invisible; making the guard fire correctly turned it into an outage
      // against the one producer that seats the wrong id space.
      //
      // A member whose roster entry has vanished is DROPPED rather than seated under an id the
      // rule cannot match — seating it would re-create the same silent 422, and a seat that can
      // never speak is worse than an absent one.
      //
      // DEDUPED, and the reason is a property worth stating rather than hiding: two roster
      // members can instantiate the SAME registry agent, and they then collapse to one seat.
      // That is not something this mapping introduces — `answeringId` IS the registry
      // projection, so the speaker rule cannot tell those two members apart no matter what is
      // seated. Seating both rosterIds would only produce a second seat that can never match.
      // The board lane has the identical property through `boardCohortAgentRefs`.
      const seen = new Set<string>();
      const agentRefs: string[] = [];
      let moderatorSeatRef: string | undefined;
      for (const m of p.members ?? []) {
        if (!m.ref.startsWith('agent:')) continue;
        const entry = await getRosterEntry(tenantId, m.ref.slice('agent:'.length));
        if (!entry) continue;
        const seatRef = `agent:${entry.agentRef.agentId}`;
        if (entry.rosterId === p.moderatorRosterId) moderatorSeatRef = seatRef;
        if (seen.has(seatRef)) continue;
        seen.add(seatRef);
        agentRefs.push(seatRef);
      }
      const ts = new Date().toISOString();
      try {
        await deps.storage.createChatSession({ sessionId, tenantId, title: `${p.name} · project`, createdAt: ts, updatedAt: ts, messageCount: 0 });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' && code !== '23505') throw err; // already exists ⇒ reuse
        // GRADE-D7 — a project rename previously left the rail title stale
        // forever (the same title-source-guarded refresh the board chat uses).
        await refreshEntityChatTitle(deps.storage, tenantId, sessionId, `${p.name} · project`);
      }
      // CPWF-3 — the advertised multi-party ceiling (MAX_MULTI_PARTY_PARTICIPANTS,
      // the seated-roster cap `multiPartyConversation.maxParticipants`) governs the
      // SEATED agent roster. Seed a NEW room with the capped, moderator-first cohort
      // so it never OPENS above the cap; the reconcile below then holds the ceiling on
      // re-open as project membership changes.
      const seedCohort = orderProjectAgentCohort(p.moderatorRosterId, agentRefs, MAX_MULTI_PARTY_PARTICIPANTS, moderatorSeatRef);
      await ensureConversationMeta(tenantId, sessionId, {
        type: 'group',
        ...(actingUserOf(req) ? { ownerUserId: actingUserOf(req) } : {}),
        ownerSubject: projectSubject(p.id),
        participants: seedCohort,
      });
      // Reconcile the lineup to the project's CURRENT agent members — add the
      // newly-added AND prune agents since removed (the meta is create-or-return,
      // so a re-open tracks roster changes both ways; a removed agent must not keep
      // responding). People are NOT participants — they reach the room via
      // membership (the `subjectAccess` read gate), so only `agent:` refs are synced.
      const meta = await getConversationMeta(tenantId, sessionId);
      const want = new Set(agentRefs);
      const have = (meta?.participants ?? []).map((pp) => pp.subjectRef);
      // ADD (CPWF-3, skip-with-count + grandfather): seat NEW agents only while the
      // seated agent roster is under the cap, moderator-first among the not-yet-seated
      // so which agents fill the remaining slots is deterministic and matches the
      // client-side convene cohort. An existing room already at/over the cap — one
      // seeded before this cap, or a >cap room grandfathered in — admits ZERO new
      // agents: no 4xx, no silent unseat, it simply stops growing.
      // Count only RETAINED members toward the cap — NOT agents `have` still lists
      // that the prune arm below is about to unseat (they are no longer members).
      // The ADD loop runs before the PRUNE loop, so counting a soon-pruned non-member
      // here would occupy a slot and wrongly block a legitimately-added member from
      // being seated for the whole session (it would only self-heal on the next
      // re-open). Filtering by `want` makes a single reconcile converge.
      let seatedAgents = have.filter((ref) => ref.startsWith('agent:') && want.has(ref)).length;
      const unseated = orderProjectAgentCohort(
        p.moderatorRosterId,
        agentRefs.filter((ref) => !have.includes(ref)),
        MAX_MULTI_PARTY_PARTICIPANTS,
      );
      for (const ref of unseated) {
        if (seatedAgents >= MAX_MULTI_PARTY_PARTICIPANTS) break;
        await addParticipant(tenantId, sessionId, ref);
        seatedAgents += 1;
      }
      // PRUNE (unchanged — security): a removed MEMBER must be unseated so it stops
      // responding. This targets NON-members only (`!want.has(ref)`); a member outside
      // the top-cap cohort is never pruned, so a grandfathered >cap room is not
      // silently trimmed.
      for (const ref of have) {
        if (ref.startsWith('agent:') && !want.has(ref)) await removeParticipant(tenantId, sessionId, ref);
      }
      res.status(201).json({ sessionId });
    } catch (err) { next(err); }
  });
}
