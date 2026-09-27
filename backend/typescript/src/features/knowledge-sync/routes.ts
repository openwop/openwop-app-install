/**
 * Knowledge-sync REST (ADR 0107 Phase 2) — `/v1/host/openwop-app/knowledge-sync/*`.
 * Toggle-gated (`knowledge-sync`, OFF) + org-scoped RBAC (workspace:read/write on
 * the source's org) + a uniform 404 on cross-tenant/no-access (no existence leak).
 * Create validates the referenced Connection + KB collection exist in the org AND
 * that the Connection belongs to the CALLER (`requireOwnConnection`), so a source
 * can't bind a colleague's credential and have the scheduler act as them.
 *
 * ADR 0605 correction: this paragraph used to end "so a source can't bind a foreign
 * credential or collection" while the code checked only `conn.tenantId` — an
 * assertion of a property nothing enforced, which is precisely why a reviewer would
 * not think to check it. The predicate now exists, and both routes that accept a
 * `connectionId` call the same one.
 *
 * "Sync now" runs `syncNow` inline at `POST /:id/sync` below; the scheduled cadence
 * runs the SAME `syncNow` via the `knowledge-sync.run` workflow (WF-KB-3 / KSWF-1) —
 * a per-source scheduler job → the run node → the `knowledge-sync` surface's
 * `runOnce`. The bespoke daemon is deleted (ADR 0605 § R2).
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import { callerSubject } from '../../host/requestSubject.js';
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

/**
 * ADR 0605 Tier 3 (`KSC-2`) — resolve a Connection that belongs to this tenant AND
 * to the CALLER, or fail closed.
 *
 * `getConnection` is tenant-scoped only. That is right for its own job and wrong as
 * the whole check here, because this feature does something unusual with the
 * connection it is handed: `knowledgeSyncRunner` sets `actingUserId` from
 * `conn.userId` and keeps acting as that person on every scheduled pass thereafter.
 * A tenant-only check therefore lets any member with `workspace:write` nominate a
 * colleague as the actor and read that colleague's drive.
 *
 * ONE helper, called by BOTH routes that accept a `connectionId` (create and
 * browse), rather than two hand-written copies that can drift apart.
 *
 * Modelled on `features/crm/gmailSyncService.ts`, which does `conn.userId !==
 * input.userId -> 403` for the identical shape.
 *
 * THE PREDICATE IS `conn.userId && conn.userId !== caller`, NOT `conn.userId !==
 * caller`. The first draft of this guard used the stricter form and was WRONG: it
 * also refused a connection with no `userId` at all — a TENANT-LEVEL connection,
 * which belongs to no person. The runner's identity is `conn.userId ??
 * source.tenantId`, so a user-less connection makes the run act as the bare tenant.
 * There is no one to impersonate, hence no deputy to confuse, and refusing it would
 * have broken a legitimate configuration in the name of a hole it does not have.
 * The narrow predicate is the one that matches the actual escalation.
 */
async function requireOwnConnection(
  req: Request,
  tenantId: string,
  connectionId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getConnection>>>> {
  const conn = await getConnection(tenantId, connectionId);
  // Uniform 404 for "not in this tenant" — no existence leak (unchanged).
  if (!conn) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId });
  if (conn.userId && conn.userId !== actingUserOf(req)) {
    throw new OpenwopError(
      'forbidden',
      'The connection must belong to you. Connect your own account, then add the sync source.',
      403,
      { connectionId },
    );
  }
  return conn;
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
      // The connection must belong to this tenant AND to the CALLER.
      //
      // ADR 0605 Tier 3 (`KSC-2`) — the tenant check alone was a same-tenant
      // confused deputy. `knowledgeSyncRunner` ADOPTS `conn.userId` as the acting
      // identity for every subsequent pass, so a member with `workspace:write` could
      // bind a colleague's Drive token and have the scheduler read that colleague's
      // files into a collection of the binder's choosing — indefinitely, and under
      // the colleague's name. The in-repo counter-example is `crm/gmailSyncService`,
      // which rejects exactly this and cites an ADR for it; the asymmetry is what
      // makes this an oversight rather than a decision.
      const conn = await requireOwnConnection(req, tenantId, connectionId);
      // The target collection must exist in this org — AND be readable by the CREATOR
      // (ADR 0643 R3 Blocker 2): this door turns a user-supplied `collectionId` into a
      // source the runner then writes into and prunes from on every pass, as the
      // connection owner. Resolved here with the real principal, and re-resolved at
      // every pass by `knowledgeSyncRunner` as `conn.userId`.
      const col = await getCollection(tenantId, orgId, collectionId, { subject: callerSubject(req) }); // KBC-1
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
          // ADR 0605 Tier 3 — record who bound this, so the USE lane has a fixed
          // identity to check against. `requireOwnConnection` has just proved this
          // equals `conn.userId`; storing it means a later change to the connection
          // cannot silently move the actor.
          ...(actingUserOf(req) ? { createdBy: actingUserOf(req) } : {}),
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
      // ADR 0605 Tier 3 — the SAME predicate as create, via the same helper.
      //
      // Stated precisely, because it is NOT the create route's defect: this lane
      // passes `actingUserId: actingUserOf(req)` to `browseFolders` below, so the
      // listing has always run on the CALLER'S OWN token. A foreign `connectionId`
      // supplied only `conn.provider`. So this was never a confused deputy and no
      // foreign folder was ever readable here. The guard is added because the
      // route's own header comment claims it is "scoped to the caller's own
      // connection" and that claim should be enforced rather than asserted, and
      // because create and browse sharing ONE predicate is what stops them drifting.
      const conn = await requireOwnConnection(req, tenantId, connectionId);
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
        // ADR 0605 Tier 6 (`KSU-3`) — record that a HUMAN paused this, so the row
        // never shows "Reconnect needed" for a pause the user performed. Resume
        // clears the reason via `setSyncStatus`'s non-paused branch.
        const updated = await setSyncStatus(
          tenantOf(req), req.params.id,
          action === 'pause' ? 'paused' : 'active', nowIso(),
          action === 'pause' ? { pausedReason: 'user' } : { pausedReason: null },
        );
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
  // Runs inline (the reference host); the scheduled cadence runs the same `syncNow`
  // on the source's schedule. Per-file failures are isolated.
  //
  // ADR 0643 (`KBWF-12`) — DELIBERATELY not a recorded run, unlike the cadence lane
  // (`knowledge-sync.run`, WF-KB-3/KSWF-1). "Sync now" is synchronous by contract: the
  // caller gets this pass's own counts in the response body, which a fire-and-forget
  // `startWorkflowRun` cannot return. The two lanes share ONE implementation (`syncNow`)
  // and ONE claim, so the recorded lane is not a second mechanism — this is a transport
  // difference, not a doctrine exception. Routing it through a run would trade an honest
  // synchronous result for a run id the UI would then have to poll.
  //
  // ADR 0605 Tier 5 (`KSWF-4`) — `syncNow` takes the single-runner claim itself, so
  // this lane can no longer race a daemon tick over the same diff cursor. A lost
  // claim surfaces as the `conflict` 409 the error mapper already renders; nothing
  // is caught here, because swallowing it would put this route straight back to
  // reporting a run it did not perform.
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
