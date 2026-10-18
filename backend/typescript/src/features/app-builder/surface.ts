/**
 * App-builder workflow surface (ADR 0173 Phase 2 — the FIRST `ctx.features['app-builder']`
 * surface). Exposes a single `export` op so a workflow/agent can generate framework-native
 * source from an app design and get back a downloadable Media-asset token. Tenant comes
 * from the run scope (CTI-1); the op reads a stored canvas by id OR takes an inline `app`
 * model (so a `render → export` chain works without persisting first). Called from the
 * `feature.app-builder.nodes.export` role:action node ⇒ the recorded output (the token) is
 * read verbatim on replay/fork.
 *
 * @see docs/adr/0173-code-export-multi-framework.md
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { updateCanvasForTenant, getCanvasForCaller, canvasWriteAllowed } from '../../host/canvasSurface.js';
import { catalogTypeListForPrompt, projectComponentCatalog } from './componentCatalog.js';
import { exportCanvas, isExportTarget } from './export/exportService.js';
import { EXPORT_TARGETS } from './export/generators.js';
import { validateAppDoc } from './validateAppDoc.js';
import { OpenwopError } from '../../types.js';

export function buildAppBuilderSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  // ADR 0768 Phase 0 — every canvas load goes through THE shared predicate with
  // the run's acting user. A run with no acting user (schedule/webhook) is
  // refused on member-owned canvases (fail-closed; subjectReadAllowed).
  const caller = { subject: scope.actingUserId };
  return {
    // export({ target, canvasId? , app? }) → { assetToken, serveUrl, fileName, fileCount, sizeBytes, warnings }
    export: async (args) => {
      const target = str(args.target);
      if (!isExportTarget(target)) {
        throw new OpenwopError('validation_error', `target must be one of: ${EXPORT_TARGETS.join(', ')}.`, 400, { field: 'target' });
      }
      // Prefer an inline app model (chain from `render`); else read the stored canvas.
      // (`!Array.isArray` — the same guard applyRepair uses; grade pass AB-CODE-5.)
      let state: unknown = args.app && typeof args.app === 'object' && !Array.isArray(args.app) ? args.app : undefined;
      if (state) {
        // Grade pass 2026-07-07 (F11): an inline model bypassed every validator —
        // no depth/count caps (the recursive generators would RangeError on a
        // deep tree into a 500) and un-slugged ids reached generated source.
        // STRUCTURAL violations are fatal; catalog mismatches (unknown types/
        // props) stay non-fatal here — the generators degrade those to export
        // `warnings[]` by contract, and escaping neutralizes their content.
        const v = validateAppDoc(state);
        const structural = v.errors.filter((e) => e.code === 'illegal_children' || e.path.endsWith('.id') || e.path === 'screens');
        if (structural.length) {
          throw new OpenwopError('validation_error', `inline app is structurally invalid: ${structural[0]!.message}`, 422, { errors: structural });
        }
      }
      if (!state) {
        const canvasId = optStr(args.canvasId);
        if (!canvasId) throw new OpenwopError('invalid_request', 'export needs `app` (inline model) or `canvasId`.', 400);
        const canvas = await getCanvasForCaller(tenantId, canvasId, caller);
        if (!canvas) throw new OpenwopError('not_found', `canvas '${canvasId}' not found`, 404);
        state = canvas.state;
      }
      const result = await exportCanvas(tenantId, state, target);
      // ADR 0835 D1 — a workflow export is lineage too (only the HTTP route
      // recorded it), so a render → export → deploy chain's hash is provable.
      const { appendExportLineage, INLINE_LINEAGE_CANVAS } = await import('./export/lineage.js');
      const storedCanvasId = args.app && typeof args.app === 'object' ? undefined : optStr(args.canvasId);
      await appendExportLineage(tenantId, storedCanvasId ?? INLINE_LINEAGE_CANVAS, {
        canvasVersion: 0, target, fileCount: result.fileCount, sizeBytes: result.sizeBytes, hash: result.hash,
        assetToken: result.assetToken, exportedAt: new Date().toISOString(), warningCount: result.warnings.length,
      }).catch(() => undefined); // best-effort, like the route: the ZIP already exists
      return { ...result };
    },
    // ADR 0358 — getCatalog() → { canvasTypeId, components, promptTypeList }:
    // the machine-readable closed component catalog + the one-line prompt
    // list, both derived live from the SSoT. Pack nodes (deepen/repair) and
    // workflows read THIS instead of carrying a hand-copied type list; the
    // same projection backs the `openwop:app-builder.catalog` agent tool
    // (one set of functions, zero drift — Phase C: promptTypeList rides along
    // so pack JS never re-implements the format logic).
    getCatalog: async () => ({ ...projectComponentCatalog(), promptTypeList: catalogTypeListForPrompt() }),
    // XCH-APPB-3 (LLM-EXCHANGE-AUDIT Wave 2) — validate({ app }) → closed-world
    // verdict for pack nodes. The design chain's render/deepen nodes call this
    // (when the surface is present) so an out-of-catalog component fails the
    // node instead of persisting via the artifact path and 422ing on the
    // user's first editor save. Same owner as every other validation gate
    // (validateAppDoc); the workflow-author `validateDraft` precedent.
    validate: async (args) => {
      const app = args.app;
      if (!app || typeof app !== 'object' || Array.isArray(app)) {
        throw new OpenwopError('validation_error', '`app` must be the app document to validate.', 400, { field: 'app' });
      }
      const v = validateAppDoc(app);
      return { ok: v.errors.length === 0, errors: v.errors, warnings: v.warnings };
    },
    // ADR 0346 4d — getDesign({ canvasId }) → { app, version }: the repair
    // node's tenant-scoped read (the version is the CAS basis).
    getDesign: async (args) => {
      const canvasId = str(args.canvasId);
      const canvas = await getCanvasForCaller(tenantId, canvasId, caller);
      if (!canvas || canvas.canvasTypeId !== 'canvas.app-builder') {
        throw new OpenwopError('not_found', `canvas '${canvasId}' not found`, 404);
      }
      return { app: canvas.state, version: canvas.version };
    },
    // ADR 0346 4d — applyRepair({ canvasId, expectedVersion, app }): the
    // ACCEPTED repair candidate becomes a new working-copy version via CAS
    // (a concurrent edit surfaces as the typed 409 — never a silent clobber).
    // The full validator gates the write exactly like the editor PATCH.
    applyRepair: async (args) => {
      const canvasId = str(args.canvasId);
      const expectedVersion = typeof args.expectedVersion === 'number' ? args.expectedVersion : Number(args.expectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        throw new OpenwopError('validation_error', '`expectedVersion` must be a positive integer (the repair CAS basis).', 400, { field: 'expectedVersion' });
      }
      const app = args.app;
      if (!app || typeof app !== 'object' || Array.isArray(app)) {
        throw new OpenwopError('validation_error', '`app` must be the repaired app document.', 400, { field: 'app' });
      }
      const v = validateAppDoc(app);
      if (v.errors.length) {
        throw new OpenwopError('validation_error', `repaired app is invalid: ${v.errors[0]!.message}`, 422, { errors: v.errors.slice(0, 10) });
      }
      const existing = await getCanvasForCaller(tenantId, canvasId, caller);
      if (!existing || existing.canvasTypeId !== 'canvas.app-builder') {
        throw new OpenwopError('not_found', `canvas '${canvasId}' not found`, 404);
      }
      // ADR 0886 D1 — WRITE on the owner, decided in the owner's org.
      if (!(await canvasWriteAllowed(tenantId, existing, caller))) {
        throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write on the canvas owner', 403, { requiredScope: 'workspace:write' });
      }
      const res = await updateCanvasForTenant(tenantId, canvasId, app as never, {
        expectedVersion,
        snapshot: { capturedBy: 'app-builder.repair' },
      });
      if (!res) throw new OpenwopError('not_found', `canvas '${canvasId}' not found`, 404);
      return { canvasId, newVersion: res.newVersion };
    },

    // ── ADR 0424 — governed deployment (sub-toggle gated; honest-off provider) ──
    deployApp: async (args) => {
      await requireDeploySubToggle(tenantId);
      const orgId = str(args.orgId);
      const actor = await requireDeployAuthority(scope, orgId);
      // ADR 0835 D1 — the approval is enforced HERE, not by the pack's "compose
      // after core.approvalGate" advice: the builder can delete an edge, and a
      // different node could call this surface directly.
      const approval = args.approval as { action?: unknown } | true | undefined;
      const approved = approval === true || (approval !== null && typeof approval === 'object' && (approval.action === 'approve' || approval.action === 'accept'));
      if (!approved) {
        throw new OpenwopError('approval_required', 'A deploy runs only after an approval gate approves it (wire the gate\'s decision into `approval`).', 403, { capability: 'app-deploy' });
      }
      // …and its provenance must be this tenant's own export.
      const exportHash = str(args.exportHash);
      const { isTenantExportHash } = await import('./export/lineage.js');
      if (/^[0-9a-f]{64}$/.test(exportHash) && !(await isTenantExportHash(tenantId, exportHash))) {
        throw new OpenwopError('not_found', 'No export with this `exportHash` exists in this workspace — export the app first.', 404, { field: 'exportHash' });
      }
      const { resolveDeployAdapter } = await import('./deploy/adapter.js');
      const { startDeploy } = await import('./deploy/deployService.js');
      const deployment = await startDeploy(resolveDeployAdapter(), {
        tenantId,
        orgId,
        service: str(args.service),
        image: str(args.image),
        exportHash,
        envKeys: args.envKeys,
        createdBy: actor,
      });
      return { deployment };
    },
    rollbackDeployment: async (args) => {
      await requireDeploySubToggle(tenantId);
      const { resolveDeployAdapter } = await import('./deploy/adapter.js');
      const { rollbackDeploy, getDeployment } = await import('./deploy/deployService.js');
      const rec = await getDeployment(tenantId, str(args.deployKey));
      if (!rec) throw new OpenwopError('not_found', 'Deployment not found.', 404, { deployKey: str(args.deployKey) });
      if (!rec.cloudRunService) {
        throw new OpenwopError('conflict', 'This deployment predates service namespacing and cannot be rolled back from here.', 409, { deployKey: rec.deployKey });
      }
      // The org comes from the record, never the caller — rollback names no org.
      await requireDeployAuthority(scope, rec.orgId);
      return { deployment: await rollbackDeploy(resolveDeployAdapter(), tenantId, rec.deployKey, str(args.toRevision)) };
    },
    deploymentStatus: async (args) => {
      await requireDeploySubToggle(tenantId);
      const { getDeployment } = await import('./deploy/deployService.js');
      const rec = await getDeployment(tenantId, str(args.deployKey));
      // ADR 0835 AB2-CD-5 — the record is its org's: membership in that org (the
      // read floor), never just knowledge of the key.
      if (rec && scope.actingUserId) {
        const { assertRunOrgScope } = await import('../../host/accessControlService.js');
        await assertRunOrgScope(tenantId, scope.actingUserId, rec.orgId, 'workspace:read');
      }
      return { deployment: rec };
    },
  };
}

/**
 * ADR 0835 D1 — who may deploy: a PERSON (a schedule, webhook or channel-caused
 * run has nobody to hold accountable for publishing to the internet) who holds
 * `host:app-deploy:manage` in the deployment's org. `runs:create` — every
 * Editor — used to be enough. Checked here, at the exit, rather than trusted to
 * the seam floor (which skips an empty `orgId` and an actorless run).
 */
async function requireDeployAuthority(scope: BundleScope, orgId: string): Promise<string> {
  if (!scope.actingUserId) {
    throw new OpenwopError('forbidden', 'Deploying an app needs a person behind the run (no acting user).', 403, { capability: 'app-deploy' });
  }
  if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required — a deployment belongs to one organization.', 422, { field: 'orgId' });
  const { assertRunOrgScope } = await import('../../host/accessControlService.js');
  await assertRunOrgScope(scope.tenantId, scope.actingUserId, orgId, 'host:app-deploy:manage');
  return scope.actingUserId;
}

/** ADR 0424 — the `app-builder.deploy` sub-toggle gate (fail-closed). */
async function requireDeploySubToggle(tenantId: string): Promise<void> {
  const { resolveOne } = await import('../../host/featureToggles/service.js');
  const assignment = await resolveOne('app-builder.deploy', { tenantId }).catch(() => null);
  if (assignment?.enabled !== true) {
    throw new OpenwopError('capability_not_provided', 'Governed deployment is not enabled for this workspace (toggle `app-builder.deploy`).', 501, { capability: 'app-deploy' });
  }
}
