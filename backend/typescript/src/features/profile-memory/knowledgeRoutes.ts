/**
 * Personal knowledge routes (ADR 0042) — host-extension, best-effort. The human
 * counterpart of the per-agent Knowledge surface (ADR 0038): a person binds cited
 * documents to their OWN profile, building the digital-twin corpus (documents +
 * notes). Part of the always-on Personal Knowledge & Memory feature.
 *
 * Surface under /v1/host/openwop-app/profiles/me/knowledge:
 *   GET    /                                   the caller's knowledge view
 *   POST   /retrieve                           query the caller's own corpus (docs + notes)
 *   POST   /bindings                           bind an existing collection      [read in its org]
 *   DELETE /bindings/:collectionId             unbind a collection              [self]
 *   POST   /collections                        create + bind a collection       [write in org]
 *   POST   /collections/:id/documents          ingest a text document           [write in org]
 *   DELETE /collections/:id/documents/:docId   delete a document                [write in org]
 *
 * Authority: INTRINSIC self-ownership (the subject is the caller's own `userId`);
 * org-scoped WRITES additionally require the caller's `workspace:write` IN that org
 * (the same `kbService` IDOR guard agents use); binding an existing collection
 * requires `workspace:read` in its org (you can't bind what you can't see). Always-on
 * (graduated, like the rest of the feature); `resolveCallerUser` fails closed for anon.
 *
 * @see docs/adr/0042-human-knowledge-binding.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { requireString } from '../featureRoute.js';
import { getOrg, resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import {
  getProfileKnowledge,
  bindCollection,
  unbindCollection,
  createBoundCollection,
  ingestDocToProfile,
  deleteDocFromProfile,
  retrieveForProfile,
} from './profileKnowledgeService.js';
import { listAllTenantCollections } from '../kb/kbService.js';

/**
 * Per-org scope gate — the caller's scope IN that org (the KB IDOR guard).
 *
 * RI-ORG-2 — `orgId` arrives from the REQUEST BODY (`orgOf` below), so the org's
 * EXISTENCE in this tenant is asserted explicitly before authority is resolved.
 * Authorization alone already fenced this: `resolveEffectiveAccess` needs a member
 * row matching `(tenantId, orgId)`, and a foreign org has none ⇒ zero scopes ⇒ 403.
 * But that fence has one hole — under `OPENWOP_DEMO_MODE` the caller's HOME tenant is
 * single-principal, so the (ADR 0508 / GC-6-narrowed) de-facto-owner bypass still
 * returns owner and a body-supplied foreign `orgId` would be accepted, keying a KB row
 * `${tenantId}:${orgId}:` against an org that does not exist here — a dangling
 * reference, contained to the caller's own tenant but wrong.
 *
 * Checking existence FIRST makes the guard correct independently of the demo flag's
 * shape, rather than relying on a bypass staying narrow. Uniform 404 (not 403): a
 * foreign org must be indistinguishable from an absent one.
 */
async function requireOrgScope(tenantId: string, subject: string, orgId: string, scope: Scope): Promise<void> {
  const org = await getOrg(orgId);
  if (!org || org.tenantId !== tenantId) {
    throw new OpenwopError('not_found', 'Organization not found.', 404, { orgId });
  }
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}

const orgOf = (req: Request): string => requireString((req.body ?? {})?.orgId, 'orgId');

export function registerProfileKnowledgeRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/profiles/me/knowledge';

  // GET / — the caller's knowledge view.
  app.get(BASE, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      res.json(await getProfileKnowledge(user.tenantId, user.userId));
    } catch (err) { next(err); }
  });

  // POST /retrieve — query the caller's own corpus (docs + notes). Self-read.
  app.post(`${BASE}/retrieve`, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const query = requireString((req.body ?? {})?.query, 'query');
      res.json(await retrieveForProfile(user.tenantId, user.userId, query));
    } catch (err) { next(err); }
  });

  // POST /bindings — bind an existing collection (needs read in its org).
  app.post(`${BASE}/bindings`, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const collectionId = requireString((req.body ?? {})?.collectionId, 'collectionId');
      const col = (await listAllTenantCollections(user.tenantId, { subject: user.userId })).find((c) => c.collectionId === collectionId); // KBC-1 / ADR 0643 R3 Blocker 2 — the BIND door resolves the binder against the collection's subject
      if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
      await requireOrgScope(user.tenantId, user.userId, col.orgId, 'workspace:read');
      await bindCollection(user.tenantId, user.userId, collectionId);
      res.status(201).json(await getProfileKnowledge(user.tenantId, user.userId));
    } catch (err) { next(err); }
  });

  // DELETE /bindings/:collectionId — unbind (self; removing a reference from your
  // own profile is always safe).
  app.delete(`${BASE}/bindings/:collectionId`, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      await unbindCollection(user.tenantId, user.userId, req.params.collectionId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // POST /collections — create + bind a collection (write in org).
  app.post(`${BASE}/collections`, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const orgId = orgOf(req);
      await requireOrgScope(user.tenantId, user.userId, orgId, 'workspace:write');
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown };
      res.status(201).json(await createBoundCollection(user.tenantId, orgId, user.userId, user.userId, body));
    } catch (err) { next(err); }
  });

  // POST /collections/:id/documents — ingest a text document (write in org).
  app.post(`${BASE}/collections/:collectionId/documents`, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const orgId = orgOf(req);
      await requireOrgScope(user.tenantId, user.userId, orgId, 'workspace:write');
      const body = (req.body ?? {}) as { title?: unknown; text?: unknown; mediaToken?: unknown };
      res.status(201).json(await ingestDocToProfile(user.tenantId, orgId, user.userId, user.userId, req.params.collectionId, body));
    } catch (err) { next(err); }
  });

  // DELETE /collections/:id/documents/:docId — delete a document (write in org).
  app.delete(`${BASE}/collections/:collectionId/documents/:documentId`, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const orgId = orgOf(req);
      await requireOrgScope(user.tenantId, user.userId, orgId, 'workspace:write');
      await deleteDocFromProfile(user.tenantId, orgId, user.userId, req.params.collectionId, req.params.documentId);
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
