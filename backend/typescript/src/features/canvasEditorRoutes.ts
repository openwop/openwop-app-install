/**
 * Canvas-editor route factory (ADR 0310 Phase A — extracted behavior-frozen
 * from the app-builder's routes, ADR 0153 Phase 2b). Every canvas type's
 * host-extension editor surface is the SAME machine over `host.canvas`; only
 * the base path, toggle, canvas type pin, doc validator, and type-specific
 * extra verbs differ. One registration here provides:
 *
 *   GET   <base>/orgs/:orgId/catalog
 *   POST  <base>/orgs/:orgId/canvases/from-artifact            { artifactKey, ownerSubject? }
 *   GET   <base>/orgs/:orgId/canvases/:canvasId
 *   PATCH <base>/orgs/:orgId/canvases/:canvasId                { state, expectedVersion? }
 *   DELETE<base>/orgs/:orgId/canvases/:canvasId                (cascade + share-link purge)
 *   GET   <base>/orgs/:orgId/canvases/:canvasId/versions
 *   GET   <base>/orgs/:orgId/canvases/:canvasId/versions/:versionId
 *   POST  <base>/orgs/:orgId/canvases/:canvasId/versions/:versionId/restore
 *
 * All routes are toggle-gated + `authorizeOrgScope`-gated (read =
 * workspace:read, write = workspace:write); the canvas store is tenant-scoped
 * (no cross-tenant read/write — no existence leak). Every route PINS the
 * canvas type (the grade-pass F4 rule): wrong-type = uniform 404.
 *
 * WF-SHARE-3 — this module NO LONGER imports `purgeLinksForResource` (the one
 * deliberate feature→feature coupling point ruled at the ADR 0310 Phase-A gate).
 * The share-link cascade rides sharing's own `onCanvasDeleted` registration, so
 * a canvas deleted by anything other than this route cascades too.
 *
 * Host-extension only — never the OpenWOP wire, so no RFC (the standing
 * non-normative-surface rule).
 */
import type { Request } from 'express';
import { OpenwopError } from '../types.js';
import type { RouteDeps } from '../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString } from './featureRoute.js';
import type { Subject, SubjectKind } from '../host/subject.js';
import type { User } from './users/usersService.js';
import { listCanvasComponents, catalogPromptSchema } from '../host/canvasComponentCatalog.js';
import { kitsForCanvasType } from '../host/canvasContentPackLoader.js';
import { mintPresentRemoteToken, presentOutlineFor } from '../host/presentRemote.js';
import { createCanvasForTenant, getCanvasForTenant, updateCanvasForTenant, deleteCanvasForTenant, listCanvasVersions, getCanvasVersion, restoreCanvasVersion, type CanvasRecordView } from '../host/canvasSurface.js';
import { seedCanvasFromArtifact } from '../host/canvasFromArtifact.js';
import { registerCollabCanvasType } from '../host/collab/collabRegistry.js';
import type { CollabShape } from '../host/collab/collabStateMirror.js';
import type { Doc as YDoc } from 'yjs';
import { resolveSubjectOrg } from '../host/subjectOrgScope.js';
import { resolveSubjectAccess, levelSatisfies } from '../host/subjectAccess.js';
import { getUser } from './users/usersService.js';
import { getRosterEntry } from '../host/rosterService.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('features.canvasEditorRoutes');

const SUBJECT_KINDS: readonly SubjectKind[] = ['agent', 'user', 'project'];
type Scope = 'workspace:read' | 'workspace:write';

export interface CanvasValidation {
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
}

export interface CanvasEditorRouteConfig {
  /** The type's host-ext root, e.g. '/v1/host/openwop-app/app-builder'. */
  basePath: string;
  feature: { toggleId: string; label: string };
  canvasTypeId: string;
  /** Additive catalog extras (e.g. the app-builder's screen templates). */
  templates?: readonly unknown[];
  /** Additive catalog extras (ADR 0310 Phase D): the pack-declared editor
   *  hints the FE synthesizes a data-driven definition from. */
  editorHints?: unknown;
  /** Closed-world doc validation: errors reject the write (422); warnings ride
   *  the save response (mid-edit cross-reference states). */
  validate?: (state: Record<string, unknown>) => CanvasValidation;
  /** Blank-document factory (ADR 0314): when present, registers
   *  `POST <base>/orgs/:orgId/canvases` — create a new canvas of this type
   *  without a run artifact (the Documents creation gallery). The blank runs
   *  through `validate` exactly like a save, so a type whose blank cannot
   *  satisfy its own schema fails closed with 422 rather than persisting an
   *  invalid document. `name` is the caller's display name. */
  blankState?: (name: string) => Record<string, unknown>;
  // WF-SHARE-3 — `shareResourceType` (the ResourceType whose share links purged
  // on canvas delete) is REMOVED, not merely unused: the purge moved to sharing's
  // own `onCanvasDeleted` registration, which derives the resource type from
  // `canvasTypeId` there. Leaving the option here would have been a second
  // mapping to drift, declared on a seam that no longer reads it.
  /** Real-time collaboration opt-in (ADR 0359 D1): registers the type as
   *  collab-capable with the transport, bound to THIS cfg's own toggle (the
   *  socket enforces `realtime-collab` AND `feature.toggleId`). First-party
   *  types only — the pack registration path (canvas-packs) never sets this
   *  (v1 exclusion, fail-closed by absence). */
  collab?: boolean;
  /** ADR 0359 Phase 6 — the element-type doc↔Y shape (MUST mirror the FE
   *  definition's frames/tree/elements traits; drift-pinned in tests on both
   *  sides). Enables the generic host.canvas derive + apply-into-room. */
  collabShape?: CollabShape;
  /** ADR 0359 Phase 6 — model-specific derive (the `canvas.document`
   *  XmlFragment→ProseMirror case). */
  collabDerive?: (ydoc: YDoc, current: Record<string, unknown>) => Record<string, unknown> | null;
  /** Type-specific verbs (export, publish, …) registered with the same
   *  helpers so gating + type-pinning stay uniform. */
  extraRoutes?: (deps: RouteDeps, helpers: CanvasEditorRouteHelpers) => void;
  /** ADR 0458 grade-pass B1 — an OPTIONAL extra authorization predicate applied
   *  AFTER the toggle + `workspace:read/write` org-scope check on EVERY route
   *  this factory registers (CRUD, versions, present-remote, blank/from-artifact)
   *  AND on the collab ticket-mint path. It exists so a type whose whole surface
   *  is privileged (the KickTodo challenge-outline: every route is a Factory
   *  operation, gated on `host:kicktodo:manage`) can reuse the same gate its
   *  sibling REST routes use, instead of the chassis defaulting to
   *  `workspace:write` alone. Absent ⇒ the six first-party types are byte-for-byte
   *  unchanged. Throws its own typed error (e.g. `forbidden_scope` 403) on refusal. */
  authorize?: (req: Request) => Promise<void>;
}

export interface CanvasEditorRouteHelpers {
  /** The `<base>/orgs/:orgId` route prefix. */
  org: string;
  /** Toggle + org-scope gate bound to the type's feature. */
  authz: (req: Request, scope: Scope) => Promise<{ user: User; orgId: string; tenantId: string }>;
  /** Tenant-scoped, TYPE-PINNED canvas load — wrong type = uniform 404. The
   *  `caller` subject gates a project/user-owned canvas through the ADR 0610
   *  subjectAccess seam (READ minimum; a write route's org-write holder resolves
   *  to 'write' ≥ 'read', so writes are unaffected). */
  loadCanvas: (tenantId: string, canvasId: string, caller: string | undefined) => Promise<CanvasRecordView>;
  notFound: (id: string) => OpenwopError;
}

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

/** Grade pass DATA-CV: assert a canvas owner/project reference RESOLVES in this
 *  tenant/org, mirroring `documents`' `resolveOwnerSubject` (ADR 0046 derived-org
 *  invariant) — a `projectId`/`ownerSubject` was stored as an arbitrary
 *  client-supplied tag (a dangling reference at creation; a project the caller
 *  can't see is a §R6 visibility widening). A project must resolve to THIS org;
 *  a user/agent to THIS tenant. Absent ⇒ ok. Foreign/dangling ⇒ uniform 404. */
async function assertOwnerResolves(subject: Subject | undefined, tenantId: string, orgId: string): Promise<void> {
  if (!subject) return;
  if (subject.kind === 'project') {
    if ((await resolveSubjectOrg(tenantId, subject)) !== orgId) {
      throw new OpenwopError('not_found', 'Owning project not found in this organization.', 404, {});
    }
  } else if (subject.kind === 'user') {
    const u = await getUser(subject.id);
    if (!u || u.tenantId !== tenantId) throw new OpenwopError('not_found', 'Owning user not found in this tenant.', 404, {});
  } else {
    const a = await getRosterEntry(tenantId, subject.id);
    if (!a) throw new OpenwopError('not_found', 'Owning agent not found in this tenant.', 404, {});
  }
}

export function registerCanvasEditorRoutes(deps: RouteDeps, cfg: CanvasEditorRouteConfig): void {
  const { app } = deps;
  const ORG = `${cfg.basePath}/orgs/:orgId`;
  // ADR 0458 grade-pass B1 — the feature/scope gate runs FIRST, then the optional
  // per-type `authorize` predicate. Every route below goes through this one
  // helper, so a privileged type's extra gate cannot be forgotten on a new verb;
  // with no `authorize` set the behavior is exactly `authorizeOrgScope` as before.
  const authz = async (req: Request, scope: Scope): Promise<{ user: User; orgId: string; tenantId: string }> => {
    const result = await authorizeOrgScope(req, cfg.feature, scope);
    if (cfg.authorize) await cfg.authorize(req);
    return result;
  };
  if (cfg.collab) {
    registerCollabCanvasType({
      canvasTypeId: cfg.canvasTypeId,
      toggleId: cfg.feature.toggleId,
      ...(cfg.collabShape ? { shape: cfg.collabShape } : {}),
      ...(cfg.collabDerive ? { deriveState: cfg.collabDerive } : {}),
      ...(cfg.validate ? { validate: cfg.validate } : {}),
      // B1 — the collab room's ticket-mint path consults the SAME predicate, so a
      // workspace member without the type's privilege can't open a live room for
      // a canvas whose REST surface they can't touch.
      ...(cfg.authorize ? { authorize: cfg.authorize } : {}),
    });
  }

  /** Grade pass 2026-07-07 (F4): every editor route PINS the canvas type —
   *  operating on ANY tenant canvas despite a shape-only claim was the bug.
   *  Wrong-type = uniform 404 (no existence leak). */
  async function loadCanvas(tenantId: string, canvasId: string, caller: string | undefined): Promise<CanvasRecordView> {
    const canvas = await getCanvasForTenant(tenantId, canvasId);
    if (!canvas || canvas.canvasTypeId !== cfg.canvasTypeId) {
      // Uniform 404 to the caller; a structured trace for the operator (grade
      // pass GC-CV-7 — type-pin misses were invisible in prod logs).
      if (canvas) log.warn('canvas type-pin miss', { expected: cfg.canvasTypeId, actual: canvas.canvasTypeId, canvasId });
      throw notFound(canvasId);
    }
    // ADR 0610 D3′ / CPC-15 — a project/user-owned canvas is membership-scoped:
    // the org gate is not sufficient. Consult the ONE subjectAccess seam (READ
    // minimum). A null result (org-owned / no membership resolver) ⇒ org gate
    // stands. Uniform 404 on refusal — no existence leak. Every read+write route
    // funnels through here, so the gate can't be forgotten on a new verb.
    if (canvas.ownerSubject) {
      const level = await resolveSubjectAccess(tenantId, canvas.ownerSubject, caller);
      if (level !== null && !levelSatisfies(level, 'read')) throw notFound(canvasId);
    }
    return canvas;
  }

  // The closed component catalog → the editor palette + a deterministic prompt schema.
  app.get(`${ORG}/catalog`, async (req, res, next) => {
    try {
      await authz(req, 'workspace:read');
      // `templates` (ADR 0305 Phase F) is additive — older consumers ignore it.
      res.json({
        canvasTypeId: cfg.canvasTypeId,
        components: listCanvasComponents(cfg.canvasTypeId),
        promptSchema: catalogPromptSchema(cfg.canvasTypeId),
        ...(cfg.templates ? { templates: cfg.templates } : {}),
        // ADR 0347 5a (additive): pack-distributed multi-frame kits.
        ...(kitsForCanvasType(cfg.canvasTypeId).length ? { kits: kitsForCanvasType(cfg.canvasTypeId) } : {}),
        ...(cfg.editorHints !== undefined ? { editor: cfg.editorHints } : {}),
      });
    } catch (err) { next(err); }
  });

  // Create a BLANK canvas of this type (ADR 0314 — the Documents creation
  // gallery). Only registered when the type declares a blank; the blank is
  // validated like any save, so an unsatisfiable schema fails closed (422).
  if (cfg.blankState) {
    const makeBlank = cfg.blankState;
    app.post(`${ORG}/canvases`, async (req, res, next) => {
      try {
        const { user, orgId, tenantId } = await authz(req, 'workspace:write');
        const body = (req.body ?? {}) as Record<string, unknown>;
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : 'Untitled';
        const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : undefined;
        const owner = ownerSubject(body);
        // Same F13 spoof guard as from-artifact: a caller-asserted USER owner
        // must be the caller (§R6 visibility anchors on it).
        if (owner?.kind === 'user' && owner.id !== user.userId) {
          throw new OpenwopError('forbidden', 'ownerSubject user must be the caller.', 403, {});
        }
        // Grade pass DATA-CV: the owner + project reference must RESOLVE in this
        // tenant/org — never a dangling/foreign tag (matches documents).
        await assertOwnerResolves(owner, tenantId, orgId);
        if (projectId) await assertOwnerResolves({ kind: 'project', id: projectId }, tenantId, orgId);
        const state = makeBlank(name);
        const validation = cfg.validate ? cfg.validate(state) : { errors: [], warnings: [] };
        if (validation.errors.length) {
          log.warn('blank canvas rejected by validator', { canvasTypeId: cfg.canvasTypeId, errorCount: validation.errors.length, first: validation.errors[0]!.message });
          throw new OpenwopError('validation_error', `this canvas type has no valid blank document: ${validation.errors[0]!.message}`, 422, { errors: validation.errors });
        }
        // Grade pass GC-CV: an optional client idempotency key dedups a retried
        // create (the FE also disables the button in-flight), so a network retry
        // converges to one canvas instead of a duplicate "Untitled".
        const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey ? `blank:${body.idempotencyKey}` : undefined;
        const canvas = await createCanvasForTenant(tenantId, {
          canvasTypeId: cfg.canvasTypeId,
          name,
          ...(projectId ? { projectId } : {}),
          ...(owner ? { ownerSubject: owner } : {}),
          initialState: state,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        res.status(201).json(canvas);
      } catch (err) { next(err); }
    });
  }

  // Open a run artifact into an editable working copy (idempotent — re-open ⇒ one canvas).
  app.post(`${ORG}/canvases/from-artifact`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const artifactKey = requireString(body.artifactKey, 'artifactKey');
      const owner = ownerSubject(body);
      // Grade pass 2026-07-07 (F13): a caller-asserted USER owner must be the
      // caller — the field anchors §R6 visibility later, so it cannot be spoofed.
      if (owner?.kind === 'user' && owner.id !== user.userId) {
        throw new OpenwopError('forbidden', 'ownerSubject user must be the caller.', 403, {});
      }
      // Grade pass DATA-CV: an asserted owner must resolve in this tenant/org.
      await assertOwnerResolves(owner, tenantId, orgId);
      const canvas = await seedCanvasFromArtifact(tenantId, artifactKey, owner ? { ownerSubject: owner } : undefined);
      if (!canvas) throw notFound(artifactKey);
      res.status(201).json(canvas);
    } catch (err) { next(err); }
  });

  // ADR 0328 Phase 4 — mint a present-remote capability (the QR phone remote).
  // Chassis-level: every canvas type with a registered outline provider gets
  // it. Stateless HMAC token; the SPA builds the join URL from its own origin.
  app.post(`${ORG}/canvases/:canvasId/present-remote`, async (req, res, next) => {
    try {
      // GC-SL-3 (grade pass 2026-07-10) — the minted token grants nav CONTROL
      // (goto/blank on the live show), so minting requires write, not read.
      // Revocation stays TTL-only (4h) by recorded decision: no existing
      // per-canvas field bumps only on end-session (canvas version bumps on
      // every save), and a presentEpoch row is a second state surface a
      // Nice-severity item doesn't justify. Re-open if a real "end session"
      // product affordance ships (GC-SL-2).
      const { user, tenantId } = await authz(req, 'workspace:write');
      const canvas = await loadCanvas(tenantId, req.params.canvasId, user.userId);
      if (!presentOutlineFor(canvas.canvasTypeId, canvas.state as Record<string, unknown>)) {
        throw new OpenwopError('invalid_request', `canvas type '${canvas.canvasTypeId}' has no present mode`, 400);
      }
      res.status(201).json(mintPresentRemoteToken(tenantId, canvas.canvasId));
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/canvases/:canvasId`, async (req, res, next) => {
    try {
      const { user, tenantId } = await authz(req, 'workspace:read');
      const canvas = await loadCanvas(tenantId, req.params.canvasId, user.userId);
      res.json(canvas);
    } catch (err) { next(err); }
  });

  app.patch(`${ORG}/canvases/:canvasId`, async (req, res, next) => {
    try {
      const { user, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      await loadCanvas(tenantId, req.params.canvasId, user.userId);
      const state = body.state;
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw new OpenwopError('invalid_request', '`state` (the canvas object) is required', 400);
      }
      // ADR 0305 Phase C: closed-world catalog violations reject the write;
      // cross-facet reference issues (mid-edit states) come back as warnings.
      const validation = cfg.validate ? cfg.validate(state as Record<string, unknown>) : { errors: [], warnings: [] };
      if (validation.errors.length) {
        log.warn('canvas save rejected by validator', { canvasTypeId: cfg.canvasTypeId, canvasId: req.params.canvasId, errorCount: validation.errors.length, first: validation.errors[0]!.message });
        throw new OpenwopError('validation_error', `canvas state violates the component catalog: ${validation.errors[0]!.message}`, 422, { errors: validation.errors });
      }
      const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined;
      // ADR 0305 Phase E — every editor save opts into snapshot capture
      // (30s-throttled + distinct-version deduped inside host.canvas).
      const result = await updateCanvasForTenant(tenantId, req.params.canvasId, state as Record<string, unknown>, { ...(expectedVersion !== undefined ? { expectedVersion } : {}), snapshot: { capturedBy: user.userId } });
      if (!result) throw notFound(req.params.canvasId);
      res.json({ ...result, warnings: validation.warnings });
    } catch (err) { next(err); }
  });

  // DELETE a canvas + cascade (grade pass 2026-07-07, DATA finding 3): version
  // snapshots + the seed-idempotency row cascade in host.canvas.
  // WF-SHARE-3 — the share-link purge USED to happen here, on the route. It now
  // rides `onCanvasDeleted`, fired by `deleteCanvasForTenant` (the single delete
  // owner), so the paths that never came through a route — app-builder's
  // retention purger, demo-clear seeders — cascade too instead of orphaning
  // links. One choke; this call is deliberately gone rather than duplicated.
  app.delete(`${ORG}/canvases/:canvasId`, async (req, res, next) => {
    try {
      const { user, tenantId } = await authz(req, 'workspace:write');
      await loadCanvas(tenantId, req.params.canvasId, user.userId);
      const deleted = await deleteCanvasForTenant(tenantId, req.params.canvasId);
      if (!deleted) throw notFound(req.params.canvasId);
      // ADR 0334 DATA-1 / ADR 0359 grade pass (DATA-B2): the lifecycle seam now
      // fires inside deleteCanvasForTenant — the single delete owner — so the
      // Documents-browser route and demo-clear paths cascade too.
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── version history (ADR 0305 Phase E — host.canvas owns snapshots) ──

  // Light rows (no snapshot payloads) — the editor's History modal list.
  app.get(`${ORG}/canvases/:canvasId/versions`, async (req, res, next) => {
    try {
      const { user, tenantId } = await authz(req, 'workspace:read');
      await loadCanvas(tenantId, req.params.canvasId, user.userId);
      const rows = await listCanvasVersions(tenantId, req.params.canvasId);
      res.json({ versions: rows.map((v) => ({ versionId: v.versionId, version: v.version, capturedBy: v.capturedBy, capturedAt: v.capturedAt })) });
    } catch (err) { next(err); }
  });

  // One full snapshot (for the client-side change summary).
  app.get(`${ORG}/canvases/:canvasId/versions/:versionId`, async (req, res, next) => {
    try {
      const { user, tenantId } = await authz(req, 'workspace:read');
      await loadCanvas(tenantId, req.params.canvasId, user.userId);
      const v = await getCanvasVersion(tenantId, req.params.canvasId, req.params.versionId);
      if (!v) throw notFound(req.params.versionId);
      res.json({ versionId: v.versionId, version: v.version, capturedBy: v.capturedBy, capturedAt: v.capturedAt, snapshot: v.snapshot });
    } catch (err) { next(err); }
  });

  // NON-DESTRUCTIVE restore — writes the snapshot as a NEW head version.
  app.post(`${ORG}/canvases/:canvasId/versions/:versionId/restore`, async (req, res, next) => {
    try {
      const { user, tenantId } = await authz(req, 'workspace:write');
      await loadCanvas(tenantId, req.params.canvasId, user.userId);
      // DATA-D6: validate the snapshot against the type's schema before it
      // restores (a drifted/old snapshot must not blind-restore into the public
      // viewer). errors → 422 (nothing mutated); warnings ride back in `result`.
      const result = await restoreCanvasVersion(tenantId, req.params.canvasId, req.params.versionId, user.userId, cfg.validate ? { validate: cfg.validate } : {});
      if (!result) throw notFound(req.params.versionId);
      res.json(result);
    } catch (err) { next(err); }
  });

  cfg.extraRoutes?.(deps, { org: ORG, authz, loadCanvas, notFound });
}
