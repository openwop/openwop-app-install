/**
 * App-builder editor routes (host-extension, ADR 0153 Phase 2b; converted to
 * the shared canvas-editor route factory in ADR 0310 Phase A — wire paths
 * byte-identical). The factory provides catalog / from-artifact / get / patch
 * (validate + snapshot) / delete (cascade + share purge) / versions / restore
 * over `host.canvas`, toggle-gated (`app-builder`) + `authorizeOrgScope`-gated
 * and type-pinned to `canvas.app-builder`. The app-builder's OWN verbs — code
 * export (ADR 0173) and GitHub publish (ADR 0306), each behind its own toggle —
 * register as `extraRoutes`.
 */
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString } from '../featureRoute.js';
import { registerCanvasEditorRoutes } from '../canvasEditorRoutes.js';
import { APP_BUILDER_CANVAS_TYPE } from './componentCatalog.js';
import { SCREEN_TEMPLATES } from './screenTemplates.js';
import { validateAppDoc } from './validateAppDoc.js';
import { exportCanvas, isExportTarget } from './export/exportService.js';
import { appendExportLineage, listExportLineage, registerExportLineageCleanup } from './export/lineage.js';
import { createLogger } from '../../observability/logger.js';
import { publishToGitHub } from './publishService.js';
import { EXPORT_TARGETS } from './export/generators.js';
import { createSyncBinding, deleteSyncBinding, getSyncBinding, getSyncBindingView, getSyncBindingByWebhookId } from './syncBinding.js';
import { syncPushToGitHub } from './githubSync.js';
import { handleSyncWebhook } from './syncWebhook.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { sendError } from '../../middleware/errorEnvelope.js';

const FEATURE = { toggleId: 'app-builder', label: 'App Builder' };
// Code export (ADR 0173) has its OWN toggle so it ships independently of the
// app-builder editor; the canvas read stays tenant-scoped.
const EXPORT_FEATURE = { toggleId: 'code-export', label: 'Code Export' };
// GitHub publish (ADR 0306) — its own toggle again: a vendor WRITE ships on an
// explicit opt-in, independent of the read-only ZIP export.
const PUBLISH_FEATURE = { toggleId: 'code-publish', label: 'Code Publish' };
// Two-way GitHub sync (ADR 0393) — OFF by default: binding wires a durable
// external write channel + an inbound webhook that mutates tenant state.
const SYNC_FEATURE = { toggleId: 'code-sync', label: 'Code Sync' };

const log = createLogger('features.app-builder.routes');

export function registerAppBuilderRoutes(deps: RouteDeps): void {
  registerExportLineageCleanup();

  // ADR 0393 Phase 2 — the PUBLIC inbound sync webhook (`app-builder-sync` ≠
  // `app-builder`, so the authed editor prefix stays gated; allow-listed in
  // auth.ts; scoped raw-body parser in index.ts). No host credential — the
  // GitHub HMAC over the exact raw bytes IS the credential; tenant comes from
  // the stored binding. Toggle honesty: a tenant that turned `code-sync` off
  // gets a 404, so a lingering GitHub webhook cannot keep mutating state.
  deps.app.post('/v1/host/openwop-app/app-builder-sync/webhook/:webhookId', async (req, res, next) => {
    try {
      if (!req.rawBody) {
        // Without the exact signed bytes the HMAC cannot be verified — reject,
        // never re-serialize-and-pretend (the connections-inbound posture).
        sendError(res, 401, 'unauthorized', 'The raw request body is required to verify the webhook signature.');
        return;
      }
      const binding = await getSyncBindingByWebhookId(req.params.webhookId!);
      if (binding) {
        const assignment = await resolveOne('code-sync', { tenantId: binding.tenantId });
        if (!assignment || !assignment.enabled) {
          res.status(404).json({ outcome: 'unknown_webhook' });
          return;
        }
      }
      const result = await handleSyncWebhook({
        storage: deps.storage,
        webhookId: req.params.webhookId!,
        rawBody: req.rawBody,
        signature: req.get('x-hub-signature-256'),
        event: req.get('x-github-event'),
        deliveryId: req.get('x-github-delivery') ?? `no-delivery-id:${Date.now()}`,
      });
      res.status(result.status).json({
        outcome: result.outcome,
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.fallbackBranch ? { fallbackBranch: result.fallbackBranch } : {}),
      });
    } catch (err) { next(err); }
  });
  registerCanvasEditorRoutes(deps, {
    basePath: '/v1/host/openwop-app/app-builder',
    feature: FEATURE,
    canvasTypeId: APP_BUILDER_CANVAS_TYPE,
    // ADR 0359 Phase 5 — collab-capable (both toggles enforced at the socket).
    collab: true,
    // ADR 0359 Phase 6 — the doc↔Y shape (drift-pinned against the FE traits
    // in canvas/__tests__/collabTypes.test.ts + collab-authboundary registry test).
    collabShape: { collections: [{ key: 'screens', nested: { field: 'components', childrenKey: 'children' } }] },
    // `templates` (ADR 0305 Phase F) is additive — older consumers ignore it.
    templates: SCREEN_TEMPLATES,
    // ADR 0305 Phase C: closed-world catalog violations reject the write;
    // cross-facet reference issues (mid-edit states) come back as warnings.
    validate: validateAppDoc,
    // ADR 0314 — blank app: one empty Home screen (the editor expects ≥1 frame
    // and exactly one `isInitial` home).
    blankState: (name) => ({ name, screens: [{ id: 'home', name: 'Home', isInitial: true, components: [] }] }),
    extraRoutes: ({ app, storage }, { org, loadCanvas }) => {
      // Code export (ADR 0173) — generate framework-native source from the canvas → a
      // secret-scrubbed ZIP stored as a Media asset; returns the capability token served
      // by /assets/:token. Gated by the `code-export` toggle + workspace:write; the canvas
      // read is tenant-scoped (CTI-1). Body: { target, format? } (format is always 'zip').
      app.post(`${org}/canvases/:canvasId/export`, async (req, res, next) => {
        try {
          const { user, tenantId } = await authorizeOrgScope(req, EXPORT_FEATURE, 'workspace:write');
          const body = (req.body ?? {}) as Record<string, unknown>;
          if (!isExportTarget(body.target)) {
            throw new OpenwopError('validation_error', `\`target\` must be one of: ${EXPORT_TARGETS.join(', ')}.`, 400, { field: 'target' });
          }
          const canvas = await loadCanvas(tenantId, req.params.canvasId, user.userId);
          const result = await exportCanvas(tenantId, canvas.state, body.target, { strict: body.strict === true });
          // ADR 0348 6c — durable export lineage (side collection; never bumps
          // the canvas version under a live editor session). Best-effort: the
          // ZIP asset already exists by now, so a lineage-write failure must
          // not 500 a completed export (grade pass 2026-07-11 AB-CODE-2); the
          // response hash stays the provenance anchor either way.
          try {
            await appendExportLineage(tenantId, req.params.canvasId!, {
              canvasVersion: canvas.version,
              target: body.target,
              fileCount: result.fileCount,
              sizeBytes: result.sizeBytes,
              hash: result.hash,
              assetToken: result.assetToken,
              exportedAt: new Date().toISOString(),
              warningCount: result.warnings.length,
            });
          } catch (err) {
            log.error('export_lineage_append_failed', { canvasId: req.params.canvasId, error: err instanceof Error ? err.message : String(err) });
          }
          res.status(201).json(result);
        } catch (err) { next(err); }
      });

      // ADR 0348 6c — the canvas's export history (lineage), newest last.
      app.get(`${org}/canvases/:canvasId/exports`, async (req, res, next) => {
        try {
          const { user, tenantId } = await authorizeOrgScope(req, EXPORT_FEATURE, 'workspace:read');
          await loadCanvas(tenantId, req.params.canvasId, user.userId); // tenant + existence gate
          res.json({ exports: await listExportLineage(tenantId, req.params.canvasId!) });
        } catch (err) { next(err); }
      });

      // GitHub publish (ADR 0306) — a governed vendor WRITE behind its own toggle.
      // The route is the ONLY reach for the `github` connection (adapterOnly + zero
      // consumer nodes); the token stays host-side inside `brokeredFetch`.
      app.post(`${org}/canvases/:canvasId/publish`, async (req, res, next) => {
        try {
          const { user, orgId, tenantId } = await authorizeOrgScope(req, PUBLISH_FEATURE, 'workspace:write');
          const body = (req.body ?? {}) as Record<string, unknown>;
          if (!isExportTarget(body.target)) {
            throw new OpenwopError('validation_error', `\`target\` must be one of: ${EXPORT_TARGETS.join(', ')}.`, 400, { field: 'target' });
          }
          const repo = requireString(body.repo, 'repo');
          const canvas = await loadCanvas(tenantId, req.params.canvasId, user.userId);
          const result = await publishToGitHub(
            // A route-side publish has no run — the canvas id is the correlation id
            // (the teamsApprovalDelivery non-run precedent).
            { storage, tenantId, runId: `publish:${req.params.canvasId}`, actingUserId: user.userId, orgId },
            { state: canvas.state, target: body.target, repo, isPrivate: body.private !== false },
          );
          res.status(201).json(result);
        } catch (err) { next(err); }
      });

      // ── ADR 0393 Lane A — two-way GitHub sync ─────────────────────────────
      // Repo binding (A4): wires a durable external write channel + a webhook
      // that can mutate tenant state, so it is gated STRONGER than publish —
      // `host:code-sync:manage`, reserved to built-in admin/owner. The webhook
      // secret returns exactly once here; reads never include it.
      app.put(`${org}/canvases/:canvasId/sync-binding`, async (req, res, next) => {
        try {
          const { user, tenantId } = await authorizeOrgScope(req, SYNC_FEATURE, 'host:code-sync:manage');
          const body = (req.body ?? {}) as Record<string, unknown>;
          if (!isExportTarget(body.target)) {
            throw new OpenwopError('validation_error', `\`target\` must be one of: ${EXPORT_TARGETS.join(', ')}.`, 400, { field: 'target' });
          }
          await loadCanvas(tenantId, req.params.canvasId, user.userId); // tenant + existence gate
          const { view, webhookSecret } = await createSyncBinding(tenantId, req.params.canvasId!, {
            owner: requireString(body.owner, 'owner'),
            repo: requireString(body.repo, 'repo'),
            branch: requireString(body.branch, 'branch'),
            target: body.target,
            boundBy: user.userId,
          });
          res.status(201).json({ binding: view, webhookSecret });
        } catch (err) { next(err); }
      });

      app.get(`${org}/canvases/:canvasId/sync-binding`, async (req, res, next) => {
        try {
          const { user, tenantId } = await authorizeOrgScope(req, SYNC_FEATURE, 'workspace:read');
          await loadCanvas(tenantId, req.params.canvasId, user.userId);
          res.json({ binding: await getSyncBindingView(tenantId, req.params.canvasId!) });
        } catch (err) { next(err); }
      });

      app.delete(`${org}/canvases/:canvasId/sync-binding`, async (req, res, next) => {
        try {
          const { user, tenantId } = await authorizeOrgScope(req, SYNC_FEATURE, 'host:code-sync:manage');
          await loadCanvas(tenantId, req.params.canvasId, user.userId);
          const removed = await deleteSyncBinding(tenantId, req.params.canvasId!);
          if (!removed) throw new OpenwopError('not_found', 'This canvas has no repo binding.', 404);
          res.status(204).end();
        } catch (err) { next(err); }
      });

      // Outbound sync push (A2) — one atomic marker commit onto the active
      // branch. Ordinary editing power (`workspace:write`): the admin-gated
      // binding already authorized WHERE the pushes go.
      app.post(`${org}/canvases/:canvasId/sync`, async (req, res, next) => {
        try {
          const { user, orgId, tenantId } = await authorizeOrgScope(req, SYNC_FEATURE, 'workspace:write');
          const canvas = await loadCanvas(tenantId, req.params.canvasId, user.userId);
          const binding = await getSyncBinding(tenantId, req.params.canvasId!);
          if (!binding) {
            throw new OpenwopError('invalid_request', 'This canvas has no repo binding — an admin must bind a repository first.', 409, { canvasId: req.params.canvasId });
          }
          const result = await syncPushToGitHub(
            { storage, tenantId, runId: `sync:${req.params.canvasId}`, actingUserId: user.userId, orgId },
            binding,
            { app: canvas.state, modelVersion: canvas.version },
          );
          res.status(result.outcome === 'pushed' ? 201 : 200).json(result);
        } catch (err) { next(err); }
      });
    },
  });
}
