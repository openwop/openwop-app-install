/**
 * App-builder editor routes (host-extension, ADR 0153 Phase 2b). The full-screen
 * editor reads the closed component catalog (for the palette), opens a `host.canvas`
 * working copy (seeded from a run's immutable canvas.app-builder artifact), and saves
 * edits back with optimistic concurrency. All routes are toggle-gated (`app-builder`)
 * + `authorizeOrgScope`-gated (read = workspace:read, write = workspace:write); the
 * canvas store is tenant-scoped (no cross-tenant read/write — no existence leak).
 *
 *   GET  …/app-builder/orgs/:orgId/catalog
 *   POST …/app-builder/orgs/:orgId/canvases/from-artifact   { artifactKey, ownerSubject? }
 *   GET  …/app-builder/orgs/:orgId/canvases/:canvasId
 *   PATCH…/app-builder/orgs/:orgId/canvases/:canvasId        { state, expectedVersion? }
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString } from '../featureRoute.js';
import type { Subject, SubjectKind } from '../../host/subject.js';
import { listCanvasComponents, catalogPromptSchema } from '../../host/canvasComponentCatalog.js';
import { getCanvasForTenant, updateCanvasForTenant } from '../../host/canvasSurface.js';
import { seedCanvasFromArtifact } from '../../host/canvasFromArtifact.js';
import { APP_BUILDER_CANVAS_TYPE } from './componentCatalog.js';

const FEATURE = { toggleId: 'app-builder', label: 'App Builder' };
const ORG = '/v1/host/openwop-app/app-builder/orgs/:orgId';
type Scope = 'workspace:read' | 'workspace:write';
const SUBJECT_KINDS: readonly SubjectKind[] = ['agent', 'user', 'project'];

function notFound(id: string): OpenwopError {
  return new OpenwopError('not_found', `canvas '${id}' not found`, 404);
}

/** Parse an optional `ownerSubject` from a request body. */
function ownerSubject(body: Record<string, unknown>): Subject | undefined {
  const o = body.ownerSubject;
  if (o && typeof o === 'object') {
    const kind = (o as { kind?: unknown }).kind;
    const id = (o as { id?: unknown }).id;
    if (typeof kind === 'string' && (SUBJECT_KINDS as readonly string[]).includes(kind) && typeof id === 'string' && id) {
      return { kind: kind as SubjectKind, id };
    }
  }
  return undefined;
}

export function registerAppBuilderRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  // The closed component catalog → the editor palette + a deterministic prompt schema.
  app.get(`${ORG}/catalog`, async (req, res, next) => {
    try {
      await authz(req, 'workspace:read');
      res.json({ canvasTypeId: APP_BUILDER_CANVAS_TYPE, components: listCanvasComponents(APP_BUILDER_CANVAS_TYPE), promptSchema: catalogPromptSchema(APP_BUILDER_CANVAS_TYPE) });
    } catch (err) { next(err); }
  });

  // Open a run artifact into an editable working copy (idempotent — re-open ⇒ one canvas).
  app.post(`${ORG}/canvases/from-artifact`, async (req, res, next) => {
    try {
      const { user } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const artifactKey = requireString(body.artifactKey, 'artifactKey');
      const owner = ownerSubject(body);
      const canvas = await seedCanvasFromArtifact(user.tenantId, artifactKey, owner ? { ownerSubject: owner } : undefined);
      if (!canvas) throw notFound(artifactKey);
      res.status(201).json(canvas);
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/canvases/:canvasId`, async (req, res, next) => {
    try {
      const { user } = await authz(req, 'workspace:read');
      const canvas = await getCanvasForTenant(user.tenantId, req.params.canvasId);
      if (!canvas) throw notFound(req.params.canvasId);
      res.json(canvas);
    } catch (err) { next(err); }
  });

  app.patch(`${ORG}/canvases/:canvasId`, async (req, res, next) => {
    try {
      const { user } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const state = body.state;
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw new OpenwopError('invalid_request', '`state` (the canvas object) is required', 400);
      }
      const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined;
      const result = await updateCanvasForTenant(user.tenantId, req.params.canvasId, state as Record<string, unknown>, expectedVersion !== undefined ? { expectedVersion } : undefined);
      if (!result) throw notFound(req.params.canvasId);
      res.json(result);
    } catch (err) { next(err); }
  });
}
