/**
 * Knowledge-sync REST (ADR 0107 Phase 2) — `/v1/host/openwop-app/knowledge-sync/*`.
 * Toggle-gated (`knowledge-sync`, OFF) + org-scoped RBAC (workspace:read/write on
 * the source's org) + a uniform 404 CROSS-TENANT (no existence leak across tenants).
 *
 * ADR 1101 D9 (`KS2CD-4`) correction — this used to say "a uniform 404 on
 * cross-tenant/no-access". Inside ONE tenant a source in an org the caller cannot
 * read answers 403 (`requireOrgScopeFor` runs after the row is found), like every
 * sibling door; the claim was the part that was false, not the behaviour.
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
import type { Scope } from '../../host/accessControlService.js';
import { getConnection } from '../connections/connectionsService.js';
import { getCollection } from '../kb/kbService.js';
import { extractDriveFolderId, browseFolders } from '../../host/knowledgeSourceFetch.js';
import {
  createSyncSource, listSyncSources, getSyncSource, setSyncStatus, updateSyncSource,
  removeSyncSource, rebindSyncSource, withSyncedCounts, cleanFolderName,
} from './knowledgeSyncService.js';
import { syncNow } from './knowledgeSyncRunner.js';
import { holdsOrgScope } from './knowledgeSyncAccess.js';

const log = createLogger('features.knowledgeSync.routes');
const TOGGLE = { toggleId: 'knowledge-sync', label: 'Knowledge sync' };
const BASE = '/host/openwop-app/knowledge-sync';

const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;
const nowIso = (): string => new Date().toISOString();

/** Gate `scope` on `orgId` for the caller. Throws 403 on missing scope. ADR 1101
 *  D3 — through `holdsOrgScope`, the ONE predicate the sync pass also asks. */
async function requireOrgScopeFor(req: Request, orgId: string, scope: Scope): Promise<void> {
  if (!(await holdsOrgScope(tenantOf(req), [actingUserOf(req)], orgId, scope))) {
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
  // ADR 1101 D2 — an ORG-shared connection (an `orgId`, no person) cannot drive a
  // sync and never could: the pass acts as the bare tenant, which holds no
  // `connections:use` on any org, so the broker refused it before the pin and the
  // pinned lane refuses it now. Saying so here beats a source that fails every pass.
  // (Browse "worked" for it only because browse acts as the requester.)
  if (!conn.userId && conn.orgId) {
    throw new OpenwopError(
      'validation_error',
      'An organization-shared connection cannot be used for a sync. Use your own connected account, or a workspace connection.',
      400,
      { connectionId, reason: 'org_connection' },
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
          // ADR 1101 D8 — the folder's display name as picked (a label, never an id).
          ...(cleanFolderName(body.folderName) ? { folderName: cleanFolderName(body.folderName) } : {}),
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
      res.json({ sources: await withSyncedCounts(await listSyncSources(tenantOf(req), orgId)) });
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
        // ADR 1101 D2 — pinned to the connection just validated, like the sync lane.
        { storage: deps.storage, tenantId, actingUserId: actingUserOf(req) ?? tenantId, orgId, connectionId },
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
      res.json({ source: (await withSyncedCounts([source]))[0] });
    } catch (err) { next(err); }
  });

  // DELETE /:id — REMOVE a source and the documents it synced (workspace:write).
  //
  // ADR 1101 D5 — the collection is a mirror of the folder; ending the mirror ends
  // its copies (they used to stay, frozen, untrusted and citable: `KSC-10`). Resumable
  // in bounded batches: 202 `{ removing, remaining }` means call again; 200
  // `{ deleted, documentsRemoved }` means done. Each document is deleted as THIS
  // member, who holds `workspace:write` on the org (checked just above).
  app.delete(`${BASE}/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
      const source = await getSyncSource(tenantOf(req), req.params.id);
      if (!source) throw new OpenwopError('not_found', 'Sync source not found.', 404, { id: req.params.id });
      await requireOrgScopeFor(req, source.orgId, 'workspace:write');
      const out = await removeSyncSource(tenantOf(req), req.params.id, { subject: callerSubject(req) }, nowIso());
      if (out.status === 'gone') throw new OpenwopError('not_found', 'Sync source not found.', 404, { id: req.params.id });
      if (out.status === 'removing') {
        res.status(202).json({ deleted: false, removing: true, documentsRemoved: out.removed, remaining: out.remaining });
        return;
      }
      log.info('knowledge_sync_source_deleted', { tenantId: tenantOf(req), id: req.params.id, documentsRemoved: out.removed });
      res.json({ deleted: true, documentsRemoved: out.removed });
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
        //
        // ADR 1101 D8 — Resume also re-arms a STOPPED (`error`) source with a fresh
        // retry count (a person re-arming it starts over; the next failure used to be
        // terminal at once) and clears the stale error, which kept saying "reconnect"
        // after the user had. A source being REMOVED cannot be resumed.
        if (action === 'resume' && source.status === 'paused' && source.pausedReason === 'removing') {
          throw new OpenwopError('conflict', 'This sync source is being removed.', 409, { reason: 'removing' });
        }
        // ADR 1101 D1 — a pause through the CAS keeps a running pass's lease, so the
        // pass still ends, and records its outcome on the FRESH (paused) row.
        const updated = action === 'pause'
          ? await setSyncStatus(tenantOf(req), req.params.id, 'paused', nowIso(), { pausedReason: 'user' })
          : await setSyncStatus(tenantOf(req), req.params.id, 'active', nowIso(), { pausedReason: null, retry: null, lastError: undefined });
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
      const body = (req.body ?? {}) as { includeMedia?: unknown; connectionId?: unknown };
      if (body.includeMedia !== undefined && typeof body.includeMedia !== 'boolean') {
        throw new OpenwopError('validation_error', '`includeMedia` must be a boolean.', 400, { field: 'includeMedia' });
      }
      // ADR 1101 D5b — REBIND to the caller's own connection, keeping the source id
      // (so every synced document keeps its id). Same predicate as create
      // (`requireOwnConnection`), and the same provider family: a folder id means
      // nothing to another provider.
      let updated = source;
      if (body.connectionId !== undefined) {
        // The rebinder becomes the identity every later pass acts as and is checked
        // against; with no person there is nothing to record, and deleting `createdBy`
        // would hand the source the legacy shape the identity guard skips (grade-code #10).
        if (!actingUserOf(req)) throw new OpenwopError('forbidden', 'Sign in as a member to switch a sync to your account.', 403, { reason: 'no_actor' });
        const connectionId = reqString(body.connectionId, 'connectionId');
        const conn = await requireOwnConnection(req, tenantOf(req), connectionId);
        const family = (p: string): string => (p === 'microsoft-sharepoint' ? 'microsoft-graph' : p);
        if (family(conn.provider) !== family(source.provider)) {
          throw new OpenwopError('validation_error', 'Choose a connection for the same provider as this sync source.', 400, { field: 'connectionId', reason: 'provider_mismatch' });
        }
        const rebound = await rebindSyncSource(tenantOf(req), req.params.id, { connectionId, createdBy: actingUserOf(req) }, nowIso());
        if (!rebound) throw new OpenwopError('not_found', 'Sync source not found.', 404, { id: req.params.id });
        updated = rebound;
        log.info('knowledge_sync_source_rebound', { tenantId: tenantOf(req), id: req.params.id, provider: conn.provider });
      }
      if (body.includeMedia !== undefined) {
        const patched = await updateSyncSource(tenantOf(req), req.params.id, { includeMedia: body.includeMedia as boolean }, nowIso());
        if (patched) updated = patched;
      }
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
