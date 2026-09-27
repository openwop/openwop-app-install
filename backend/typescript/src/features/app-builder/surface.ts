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
import { getCanvasForTenant, updateCanvasForTenant } from '../../host/canvasSurface.js';
import { catalogTypeListForPrompt, projectComponentCatalog } from './componentCatalog.js';
import { exportCanvas, isExportTarget } from './export/exportService.js';
import { EXPORT_TARGETS } from './export/generators.js';
import { validateAppDoc } from './validateAppDoc.js';
import { OpenwopError } from '../../types.js';

export function buildAppBuilderSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
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
        const canvas = await getCanvasForTenant(tenantId, canvasId);
        if (!canvas) throw new OpenwopError('not_found', `canvas '${canvasId}' not found`, 404);
        state = canvas.state;
      }
      const result = await exportCanvas(tenantId, state, target);
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
      const canvas = await getCanvasForTenant(tenantId, canvasId);
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
      const existing = await getCanvasForTenant(tenantId, canvasId);
      if (!existing || existing.canvasTypeId !== 'canvas.app-builder') {
        throw new OpenwopError('not_found', `canvas '${canvasId}' not found`, 404);
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
      const { resolveDeployAdapter } = await import('./deploy/adapter.js');
      const { startDeploy } = await import('./deploy/deployService.js');
      const deployment = await startDeploy(resolveDeployAdapter(), {
        tenantId,
        orgId: str(args.orgId),
        service: str(args.service),
        image: str(args.image),
        exportHash: str(args.exportHash),
        envKeys: args.envKeys,
        createdBy: scope.actingUserId ?? `run:${scope.runId ?? 'unknown'}`,
      });
      return { deployment };
    },
    rollbackDeployment: async (args) => {
      await requireDeploySubToggle(tenantId);
      const { resolveDeployAdapter } = await import('./deploy/adapter.js');
      const { rollbackDeploy } = await import('./deploy/deployService.js');
      return { deployment: await rollbackDeploy(resolveDeployAdapter(), tenantId, str(args.deployKey), str(args.toRevision)) };
    },
    deploymentStatus: async (args) => {
      await requireDeploySubToggle(tenantId);
      const { getDeployment } = await import('./deploy/deployService.js');
      return { deployment: await getDeployment(tenantId, str(args.deployKey)) };
    },
  };
}

/** ADR 0424 — the `app-builder.deploy` sub-toggle gate (fail-closed). */
async function requireDeploySubToggle(tenantId: string): Promise<void> {
  const { resolveOne } = await import('../../host/featureToggles/service.js');
  const assignment = await resolveOne('app-builder.deploy', { tenantId }).catch(() => null);
  if (assignment?.enabled !== true) {
    throw new OpenwopError('capability_not_provided', 'Governed deployment is not enabled for this workspace (toggle `app-builder.deploy`).', 501, { capability: 'app-deploy' });
  }
}
