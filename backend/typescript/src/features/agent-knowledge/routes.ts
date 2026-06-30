/**
 * Agent-knowledge curation routes (ADR 0038) — host-extension, best-effort.
 *
 * Surface under /v1/host/openwop-app/agents/:id/knowledge — per-agent knowledge
 * curation: view, bind/unbind a KB collection, create a collection for the
 * agent, ingest a document (cited RAG), add a private note (recalled memory),
 * toggle curated notes, and a read-only retrieve.
 *
 * ALWAYS-ON (graduated off the `agent-knowledge` toggle 2026-06-16, ADR 0038
 * § Correction). Every route is gated, fail-closed, in this order:
 *   1. `requireOwnedAgent(:id)` — tenant+agent IDOR       (404 cross-tenant)
 *   2. RBAC — workspace:read (view/retrieve) /
 *      workspace:write (bind/ingest/note/delete)          (403 fail-closed)
 *   3. ADR 0036 — `agentProfile` policy on the WRITE
 *      action class (`knowledge.ingest`/`knowledge.note`/
 *      `knowledge.bind`): `permissions.never` ⇒ 403.
 *
 * Org-scoped operations (create collection, ingest, delete doc) ALSO require the
 * caller's `workspace:write` IN the path/body org (the same KB IDOR guard) so a
 * tenant member can't write into an org they don't belong to.
 *
 * @see docs/adr/0038-per-agent-knowledge-memory.md
 * @see src/routes/agentProfile.ts — the requireOwnedAgent IDOR pattern this mirrors
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { getRosterEntry } from '../../host/rosterService.js';
import { getAgentProfile } from '../../host/agentProfileService.js';
import { resolveAgentPolicy } from '../../host/agentPolicyResolver.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { requireString } from '../featureRoute.js';
import {
  getAgentKnowledge,
  createBoundCollection,
  bindCollection,
  unbindCollection,
  ingestDocToAgent,
  ingestFromConnection,
  deleteDocFromAgent,
  addNote,
  listAgentNotes,
  removeAgentNote,
  setMemoryWritable,
  retrieveForAgent,
} from './service.js';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** Resolve the owning agent, fail-closed (mirrors routes/agentProfile.ts:48): a
 *  missing OR cross-tenant agent yields a generic 404 (never leaks existence in
 *  another tenant). This is now the FIRST gate (the feature is always-on). */
async function requireOwnedAgent(req: Request): Promise<string> {
  const id = req.params.id;
  const entry = await getRosterEntry(id);
  if (!entry || entry.tenantId !== tenantOf(req)) {
    throw new OpenwopError('not_found', 'Agent not found.', 404, { id });
  }
  return id;
}

/** Tenant-wide scope gate (these routes are agent-scoped, not org-scoped): the
 *  caller's UNION of scopes across their org memberships in the tenant. The
 *  tenant owner implicitly has every scope. Fail-closed: a subject with no
 *  membership resolves to no scopes ⇒ 403. */
async function requireTenantScope(req: Request, scope: Scope): Promise<void> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req) });
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  }
}

/** Per-org scope gate (org-scoped writes — create collection, ingest, delete
 *  doc): the caller's scope IN that org, the same KB IDOR guard. */
async function requireOrgScopeFor(req: Request, orgId: string, scope: Scope): Promise<void> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}

/** ADR 0036 — enforce the agent's `agentProfile` policy on a knowledge WRITE
 *  action class. A `permissions.never` entry hard-denies (403, fail-closed);
 *  `hitl` for curation is treated as a deny (there is no approval queue for a
 *  user's own curation — the user IS the approver, so a forbidden class blocks
 *  outright). Composes the pure resolver over the host-owned profile. */
async function enforceAgentPolicy(req: Request, agentId: string, actionClass: string): Promise<void> {
  const profile = await getAgentProfile(tenantOf(req), agentId);
  const resolution = resolveAgentPolicy({ profile, actionClass });
  if (resolution.verdict === 'deny') {
    throw new OpenwopError('forbidden_scope', `Action \`${actionClass}\` is denied for this agent by its profile policy.`, 403, {
      agentId,
      actionClass,
      reason: resolution.reason,
    });
  }
}

/** The org id for an org-scoped write — from `req.body.orgId`, validated. */
function orgOf(req: Request): string {
  const orgId = (req.body ?? {})?.orgId;
  return requireString(orgId, 'orgId');
}

export function registerAgentKnowledgeRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/agents/:id/knowledge';

  // ── view ──
  app.get(BASE, async (req, res, next) => {
    try {
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:read');
      res.json(await getAgentKnowledge(tenantOf(req), id));
    } catch (err) { next(err); }
  });

  // ── retrieve (read-only) ──
  app.post(`${BASE}/retrieve`, async (req, res, next) => {
    try {
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:read');
      const query = requireString((req.body ?? {})?.query, 'query');
      res.json(await retrieveForAgent(tenantOf(req), id, query));
    } catch (err) { next(err); }
  });

  // ── bindings ──
  app.post(`${BASE}/bindings`, async (req, res, next) => {
    try {
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:write');
      await enforceAgentPolicy(req, id, 'knowledge.bind');
      const collectionId = requireString((req.body ?? {})?.collectionId, 'collectionId');
      await bindCollection(tenantOf(req), id, collectionId);
      res.status(201).json(await getAgentKnowledge(tenantOf(req), id));
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/bindings/:collectionId`, async (req, res, next) => {
    try {
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:write');
      await enforceAgentPolicy(req, id, 'knowledge.bind');
      await unbindCollection(tenantOf(req), id, req.params.collectionId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── create a collection for the agent (org-scoped) ──
  app.post(`${BASE}/collections`, async (req, res, next) => {
    try {
      const id = await requireOwnedAgent(req);
      const orgId = orgOf(req);
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      await enforceAgentPolicy(req, id, 'knowledge.bind');
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown };
      const col = await createBoundCollection(tenantOf(req), orgId, actingUserOf(req) ?? 'unknown', id, body);
      res.status(201).json(col);
    } catch (err) { next(err); }
  });

  // ── ingest a document into a bound collection (org-scoped) ──
  app.post(`${BASE}/collections/:collectionId/documents`, async (req, res, next) => {
    try {
      const id = await requireOwnedAgent(req);
      const orgId = orgOf(req);
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      await enforceAgentPolicy(req, id, 'knowledge.ingest');
      const body = (req.body ?? {}) as { title?: unknown; text?: unknown; mediaToken?: unknown };
      const doc = await ingestDocToAgent(tenantOf(req), orgId, actingUserOf(req) ?? 'unknown', id, req.params.collectionId, body);
      res.status(201).json(doc);
    } catch (err) { next(err); }
  });

  // ── import a document from the acting user's connected provider (org-scoped) ──
  // Fetches the source via the host knowledge-source seam (broker + brokeredFetch,
  // apiHosts-pinned), then ingests it. A missing provider Connection fails closed
  // (409 credential_required). Google Drive is the first supported provider.
  app.post(`${BASE}/collections/:collectionId/documents/from-connection`, async (req, res, next) => {
    try {
      const id = await requireOwnedAgent(req);
      const orgId = orgOf(req);
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      await enforceAgentPolicy(req, id, 'knowledge.ingest');
      const actor = actingUserOf(req);
      if (!actor) {
        throw new OpenwopError('credential_required', 'Sign in with a connected account to import from a connection.', 409, {});
      }
      const body = (req.body ?? {}) as { provider?: unknown; ref?: unknown };
      const doc = await ingestFromConnection(deps.storage, tenantOf(req), orgId, actor, id, req.params.collectionId, body);
      res.status(201).json(doc);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/collections/:collectionId/documents/:documentId`, async (req, res, next) => {
    try {
      const id = await requireOwnedAgent(req);
      const orgId = orgOf(req);
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      await enforceAgentPolicy(req, id, 'knowledge.ingest');
      await deleteDocFromAgent(tenantOf(req), orgId, id, req.params.collectionId, req.params.documentId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── private notes (recalled memory) ──
  // List the agent's curated notes for the Memory tab (ADR 0041). Read scope.
  app.get(`${BASE}/notes`, async (req, res, next) => {
    try {
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:read');
      res.json({ notes: await listAgentNotes(tenantOf(req), id) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/notes`, async (req, res, next) => {
    try {
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:write');
      await enforceAgentPolicy(req, id, 'knowledge.note');
      const content = requireString((req.body ?? {})?.content, 'content');
      await addNote(tenantOf(req), id, content);
      res.status(201).json(await getAgentKnowledge(tenantOf(req), id));
    } catch (err) { next(err); }
  });

  // Delete a curated note by id (ADR 0041). Write scope + policy; only a curated
  // note is removable (a dispatch turn-summary is not) ⇒ 404 when none matched.
  app.delete(`${BASE}/notes/:noteId`, async (req, res, next) => {
    try {
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:write');
      await enforceAgentPolicy(req, id, 'knowledge.note');
      const removed = await removeAgentNote(tenantOf(req), id, req.params.noteId);
      if (!removed) throw new OpenwopError('not_found', 'Note not found.', 404, { noteId: req.params.noteId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── memory-writable knob ──
  app.put(`${BASE}/memory-writable`, async (req, res, next) => {
    try {
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:write');
      const writable = (req.body ?? {})?.writable;
      if (typeof writable !== 'boolean') {
        throw new OpenwopError('validation_error', 'Field `writable` is required and MUST be a boolean.', 400, { field: 'writable' });
      }
      await setMemoryWritable(tenantOf(req), id, writable);
      res.json(await getAgentKnowledge(tenantOf(req), id));
    } catch (err) { next(err); }
  });
}
