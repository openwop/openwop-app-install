/**
 * Prompt-library routes (ADR 0116 Phase 1) — host-extension, org-scoped + RBAC.
 * `/v1/host/openwop-app/prompts/orgs/:orgId/entries` CRUD, gated by `authorizeOrgScope`:
 *   list/get → workspace:read · create/update/delete → workspace:write.
 * Tenant+org IDOR-guarded (uniform 404); a dangling `promptRef` is rejected.
 *
 * @see docs/adr/0116-prompt-library.md
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope } from '../featureRoute.js';
import { createEntry, deleteEntry, getEntry, listEntries, updateEntry, renderEntry } from './promptLibraryService.js';
import { OpenwopError } from '../../types.js';


export function registerPromptLibraryRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/prompts/orgs/:orgId/entries';

  app.get(BASE, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      res.json({ entries: await listEntries(tenantId, orgId, user.userId) });
    } catch (err) { next(err); }
  });

  app.post(BASE, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      const entry = await createEntry(tenantId, orgId, user.userId, (req.body ?? {}) as Record<string, unknown>);
      res.status(201).json({ entry });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/:entryId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      const entry = await getEntry(tenantId, orgId, req.params.entryId, user.userId);
      if (!entry) throw new OpenwopError('not_found', 'Prompt entry not found.', 404, { entryId: req.params.entryId });
      res.json({ entry });
    } catch (err) { next(err); }
  });

  // ADR 0116 Phase 2 — render a library entry: resolve its `promptRef` template +
  // substitute variables (`composePromptTemplate`). The `/`-insertion (Phase 3)
  // calls this. Read-gated; untrusted bindings are fenced by the composer.
  app.post(`${BASE}/:entryId/render`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      const bindings = ((req.body as { variables?: unknown })?.variables ?? {}) as Record<string, unknown>;
      // Single source for render — the SAME `renderEntry` the ctx.prompts surface uses.
      res.json(await renderEntry(tenantId, orgId, req.params.entryId, bindings, user.userId));
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/:entryId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      const entry = await updateEntry(tenantId, orgId, req.params.entryId, user.userId, (req.body ?? {}) as Record<string, unknown>);
      res.json({ entry });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:entryId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      await deleteEntry(tenantId, orgId, req.params.entryId);
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
