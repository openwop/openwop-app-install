/**
 * Knowledge-sync REST (ADR 0107 Phase 2) — `/v1/host/openwop-app/knowledge-sync/*`.
 * Toggle-gated (`knowledge-sync`, OFF) + org-scoped RBAC (workspace:read/write on
 * the source's org) + a uniform 404 on cross-tenant/no-access (no existence leak).
 * Create validates the referenced Connection + KB collection exist in the org, so a
 * source can't bind a foreign credential or collection. "Sync now" + the scheduler
 * binding ride the Phase-3 `knowledge-sync.run` workflow (not yet wired).
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, tenantOf } from '../featureRoute.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { getConnection } from '../connections/connectionsService.js';
import { getCollection } from '../kb/kbService.js';
import { extractDriveFolderId, browseFolders } from '../../host/knowledgeSourceFetch.js';
import {
  createSyncSource, listSyncSources, getSyncSource, deleteSyncSource, setSyncStatus, updateSyncSource,
} from './knowledgeSyncService.js';
import { syncNow } from './knowledgeSyncRunner.js';

const log = createLogger('features.knowledgeSync.routes');
const TOGGLE = { toggleId: 'knowledge-sync', label: 'Knowledge sync' };
const BASE = '/v1/host/openwop-app/knowledge-sync';

const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;
const nowIso = (): string => new Date().toISOString();

/** Gate `scope` on `orgId` for the caller. Throws 403 on missing scope. */
async function requireOrgScopeFor(req: Request, orgId: string, scope: Scope): Promise<void> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}

function reqString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new OpenwopError('validation_error', `\`${field}\` is required.`, 400, { field });
  return v.trim();
}

export function registerKnowledgeSyncRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // POST / — create a sync source (workspace:write in body.orgId; the connection +
  // collection MUST exist in that tenant/org).
  app.post(BASE, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const tenantId = tenantOf(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = reqString(body.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const connectionId = reqString(body.connectionId, 'connectionId');
      const collectionId = reqString(body.collectionId, 'collectionId');
      // The connection must belong to this tenant (no binding a foreign credential).
      const conn = await getConnection(tenantId, connectionId);
      if (!conn) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId });
      // The target collection must exist in this org.
      const col = await getCollection(tenantId, orgId, collectionId);
      if (!col) throw new OpenwopError('not_found', 'KB collection not found in this org.', 404, { collectionId });
      const provider = typeof body.provider === 'string' ? body.provider : conn.provider;
      // ADR 0107 — for Google Drive, normalize a pasted folder URL → bare id (server
      // is authority; the stored id is always canonical + passes the list-time guard).
      // Reject an unparseable ref rather than persist one that only 400s at sync time.
      let externalFolderId = typeof body.externalFolderId === 'string' ? body.externalFolderId : '';
      if (provider === 'google') {
        const normalized = extractDriveFolderId(externalFolderId);
        if (!normalized) throw new OpenwopError('validation_error', 'Enter a Google Drive folder link or folder id.', 400, { field: 'externalFolderId' });
        externalFolderId = normalized;
      }
      const source = await createSyncSource(
        tenantId, orgId,
        {
          connectionId, provider, externalFolderId, collectionId,
          cadence: typeof body.cadence === 'string' ? body.cadence : '',
          // Opt-out only: absent/true ⇒ media included (ADR 0108 OQ-3).
          ...(body.includeMedia === false ? { includeMedia: false } : {}),
        },
        nowIso(),
      );
      log.info('knowledge_sync_source_created', { tenantId, orgId, id: source.id, provider: source.provider });
      res.status(201).json({ source });
    } catch (err) { next(err); }
  });

  // GET /?orgId= — list the org's sync sources.
  app.get(BASE, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const orgId = reqString(req.query.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      res.json({ sources: await listSyncSources(tenantOf(req), orgId) });
    } catch (err) { next(err); }
  });

  // GET /browse?orgId=&connectionId=&folderId= — list subfolders for the picker.
  // Read-only; scoped to the caller's own connection (the acting user's drive token).
  app.get(`${BASE}/browse`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const tenantId = tenantOf(req);
      const orgId = reqString(req.query.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      const connectionId = reqString(req.query.connectionId, 'connectionId');
      const conn = await getConnection(tenantId, connectionId);
      if (!conn) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId });
      const folderId = typeof req.query.folderId === 'string' && req.query.folderId.trim() ? req.query.folderId.trim() : 'root';
      const folders = await browseFolders(
        { storage: deps.storage, tenantId, actingUserId: actingUserOf(req) ?? tenantId, orgId },
        conn.provider,
        folderId,
      );
      res.json({ folders, folderId });
    } catch (err) { next(err); }
  });

  // GET /:id — one source (read on its org; uniform 404 cross-tenant/no-access).
  app.get(`${BASE}/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const source = await getSyncSource(tenantOf(req), req.params.id);
      if (!source) throw new OpenwopError('not_found', 'Sync source not found.', 404, { id: req.params.id });
      await requireOrgScopeFor(req, source.orgId, 'workspace:read');
      res.json({ source });
    } catch (err) { next(err); }
  });

  // DELETE /:id — remove a source + its diff cursor (workspace:write).
  app.delete(`${BASE}/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const source = await getSyncSource(tenantOf(req), req.params.id);
      if (!source) throw new OpenwopError('not_found', 'Sync source not found.', 404, { id: req.params.id });
      await requireOrgScopeFor(req, source.orgId, 'workspace:write');
      const deleted = await deleteSyncSource(tenantOf(req), req.params.id);
      log.info('knowledge_sync_source_deleted', { tenantId: tenantOf(req), id: req.params.id, deleted });
      res.json({ deleted });
    } catch (err) { next(err); }
  });

  // POST /:id/(pause|resume) — toggle the source's schedule (workspace:write).
  for (const action of ['pause', 'resume'] as const) {
    app.post(`${BASE}/:id/${action}`, async (req, res, next) => {
      try {
        await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
        const source = await getSyncSource(tenantOf(req), req.params.id);
        if (!source) throw new OpenwopError('not_found', 'Sync source not found.', 404, { id: req.params.id });
        await requireOrgScopeFor(req, source.orgId, 'workspace:write');
        const updated = await setSyncStatus(tenantOf(req), req.params.id, action === 'pause' ? 'paused' : 'active', nowIso());
        res.json({ source: updated });
      } catch (err) { next(err); }
    });
  }

  // PATCH /:id — update mutable settings (currently `includeMedia`; ADR 0108 OQ-3 follow-on),
  // so a source can toggle media on/off without delete+recreate (workspace:write).
  app.patch(`${BASE}/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const source = await getSyncSource(tenantOf(req), req.params.id);
      if (!source) throw new OpenwopError('not_found', 'Sync source not found.', 404, { id: req.params.id });
      await requireOrgScopeFor(req, source.orgId, 'workspace:write');
      const body = (req.body ?? {}) as { includeMedia?: unknown };
      if (body.includeMedia !== undefined && typeof body.includeMedia !== 'boolean') {
        throw new OpenwopError('validation_error', '`includeMedia` must be a boolean.', 400, { field: 'includeMedia' });
      }
      const updated = await updateSyncSource(tenantOf(req), req.params.id, { includeMedia: body.includeMedia as boolean | undefined }, nowIso());
      res.json({ source: updated });
    } catch (err) { next(err); }
  });

  // POST /:id/sync — "Sync now": run one diff pass immediately (workspace:write).
  // Runs inline (the reference host); the scheduler cadence binding ticks the same
  // `syncNow` on the source's cadence (Phase 3b). Per-file failures are isolated.
  app.post(`${BASE}/:id/sync`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const source = await getSyncSource(tenantOf(req), req.params.id);
      if (!source) throw new OpenwopError('not_found', 'Sync source not found.', 404, { id: req.params.id });
      await requireOrgScopeFor(req, source.orgId, 'workspace:write');
      const result = await syncNow({ storage: deps.storage }, tenantOf(req), req.params.id, nowIso());
      res.json({ result, source: await getSyncSource(tenantOf(req), req.params.id) });
    } catch (err) { next(err); }
  });
}
