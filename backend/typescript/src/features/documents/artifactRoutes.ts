/**
 * Chat artifact workbench + Library routes (ADR 0069 + ADR 0083) — host-extension,
 * non-normative.
 *
 *   GET /v1/host/openwop-app/artifacts                     (ADR 0083 — the Library list)
 *   GET /v1/host/openwop-app/artifacts/:artifactId
 *   GET /v1/host/openwop-app/artifacts/:artifactId/revisions
 *   GET /v1/host/openwop-app/artifacts/:artifactId/revisions/:revisionId
 *   GET /v1/host/openwop-app/artifacts/:artifactId/diff?from=&to=
 *
 * A type-neutral, READ-ONLY view over durable artifacts (`host/artifactProjection`)
 * spanning THREE sources — documents (ADR 0053), media (RFC 0055), and run-output
 * (ADR 0083). It owns NO data.
 *
 * Gating (ADR 0083 change): NO feature toggle. Run-output artifacts are produced by ANY
 * workflow run — gating on the `documents` toggle (off by default) would hide them and
 * recreate the dead-end. The real boundary is per-RECORD authorization inside the
 * projection (`workspace:read`, resolved FROM the backing record's org), so a non-visible
 * artifact returns 404 (never 403).
 *
 * SUBJECT REQUIRED (ADR 0083 review MED-1): since the route is no longer toggle-gated, the
 * projection's per-record authz is the ONLY gate — and `resolveEffectiveAccess` with no
 * subject falls through to the tenant-OWNER scopes. So these routes fail closed on a missing
 * principal (401) rather than leaning solely on the auth middleware always populating one.
 *
 * Registered from `documentsFeature.registerRoutes` (the feature owns its routes; core
 * never imports the feature).
 *
 * @see src/host/artifactProjection.ts
 */

import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { getArtifact, listArtifactsPage, listArtifactRevisions, getArtifactRevision, diffArtifact } from '../../host/artifactProjection.js';

function tenantOf(req: Request): string {
  return (req as { tenantId?: string }).tenantId ?? 'default';
}
/** The authenticated subject, or throw 401. Fail-closed: an artifact route MUST NOT run with
 *  an absent principal (else the projection authz resolves to tenant-owner). */
function requireSubject(req: Request): string {
  const subject = req.userId ?? req.principal?.principalId;
  if (!subject) throw new OpenwopError('unauthenticated', 'Authentication required.', 401);
  return subject;
}

export function registerArtifactRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/artifacts';

  // ADR 0083 — the Library: every artifact the caller can see, across sources, newest
  // first. Registered BEFORE `/:artifactId` so the bare collection path isn't swallowed.
  app.get(BASE, async (req, res, next) => {
    try {
      // ART-1 — bounded, cursor-paginated Library (response: `{ artifacts, nextCursor? }`;
      // `nextCursor` is additive — older clients ignore it and still get the first page).
      const limitRaw = Number(req.query.limit);
      const page = await listArtifactsPage(tenantOf(req), requireSubject(req), {
        ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: limitRaw } : {}),
        ...(typeof req.query.cursor === 'string' && req.query.cursor ? { cursor: req.query.cursor } : {}),
      });
      res.status(200).json(page);
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/:artifactId`, async (req, res, next) => {
    try {
      const artifact = await getArtifact(tenantOf(req), requireSubject(req), req.params.artifactId);
      if (!artifact) throw new OpenwopError('not_found', 'Artifact not found.', 404, { artifactId: req.params.artifactId });
      res.status(200).json(artifact);
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/:artifactId/revisions`, async (req, res, next) => {
    try {
      const revisions = await listArtifactRevisions(tenantOf(req), requireSubject(req), req.params.artifactId);
      if (!revisions) throw new OpenwopError('not_found', 'Artifact not found.', 404, { artifactId: req.params.artifactId });
      res.status(200).json({ artifactId: req.params.artifactId, revisions });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/:artifactId/revisions/:revisionId`, async (req, res, next) => {
    try {
      const revision = await getArtifactRevision(tenantOf(req), requireSubject(req), req.params.artifactId, req.params.revisionId);
      if (!revision) throw new OpenwopError('not_found', 'Artifact revision not found.', 404, { revisionId: req.params.revisionId });
      res.status(200).json(revision);
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/:artifactId/diff`, async (req, res, next) => {
    try {
      const from = typeof req.query.from === 'string' ? req.query.from : '';
      const to = typeof req.query.to === 'string' ? req.query.to : '';
      const result = await diffArtifact(tenantOf(req), requireSubject(req), req.params.artifactId, from, to);
      if (!result) throw new OpenwopError('not_found', 'Artifact not found.', 404, { artifactId: req.params.artifactId });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });
}
