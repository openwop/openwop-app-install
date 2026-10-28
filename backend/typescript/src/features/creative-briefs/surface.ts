/**
 * `ctx.features['creative-briefs']` (ADR 0353 P2) — the workflow surface the
 * campaign channel generator composes: when the toggle is ON, generated
 * creative-brief drafts become MANAGED entities (lifecycle/versions/sharing)
 * instead of transient run artifacts. Same toggle + tenant scoping as the
 * routes (the surface gate lives in the feature registration).
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { OpenwopError } from '../../types.js';
import { createBrief, listBriefs, getBrief } from './creativeBriefsService.js';
import { renderForBrief, renderVariantsForBrief, reelPromptForBrief, storeReelRender } from './render/renderService.js';
import { listTemplates } from './render/templates.js';
import { assertEditModeEnabled } from './groundingSettings.js';
import { assertProductGroundedEnabled, productShotSource, composeProductShot, checkFidelity, protectionMask } from './fidelityService.js';
import type { FeatureSurfaceOrgPolicy } from '../../host/featureSurfaces.js';

/** ADR 0945 P1 — the product-grounded methods ask the HTTP door's write scope
 *  (they write assets and verdicts, and read the catalog's bytes). The older
 *  methods keep the membership floor (a pre-existing gap, filed in ADR 0945). */
export const CREATIVE_BRIEFS_SURFACE_POLICY: FeatureSurfaceOrgPolicy = {
  methodScopes: { productShotSource: 'workspace:write', composeProductShot: 'workspace:write', checkFidelity: 'workspace:write', protectionMask: 'workspace:write' },
};

function requireOrg(args: Record<string, unknown>): string {
  const orgId = str(args.orgId);
  if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
  return orgId;
}

export function buildCreativeBriefsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    create: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      const brief = await createBrief(tenantId, orgId, str(args.actor) || 'workflow', {
        title: args.title, assetType: args.assetType, sceneDescription: args.sceneDescription,
        composition: args.composition, cameraAngle: args.cameraAngle, lighting: args.lighting,
        brandPalette: args.brandPalette, messagingIntent: args.messagingIntent,
        platformSpec: args.platformSpec, directions: args.directions, moodBoard: args.moodBoard,
        campaignBriefId: args.campaignBriefId,
      });
      return { brief };
    },
    list: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      return { briefs: await listBriefs(tenantId, orgId) };
    },
    get: async (args) => {
      const orgId = str(args.orgId);
      const b = await getBrief(tenantId, orgId, str(args.briefId));
      return { found: !!b, ...(b ? { brief: b } : {}) };
    },
    // ADR 0399 — the layout-template catalog (static geometry; the node's
    // template-id vocabulary comes from HERE, never a prompt hand-copy).
    listRenderTemplates: async () => ({ templates: listTemplates() }),
    // ADR 0399 §2/§3 — deterministic render(s) stored as media assets. Bytes
    // never cross the node result boundary (the ADR 0115 seam precedent): the
    // node gets ids + warnings, the library owns the pixels.
    render: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      const record = await renderForBrief(tenantId, orgId, scope.actingUserId ?? scope.runId ?? 'workflow', {
        briefId: str(args.briefId),
        templateId: str(args.templateId),
        ...(typeof args.directionIndex === 'number' ? { directionIndex: args.directionIndex } : {}),
        ...(args.copy && typeof args.copy === 'object' ? { copy: args.copy as Record<string, unknown> } : {}),
        ...(args.layers && typeof args.layers === 'object' ? { layers: args.layers as Record<string, unknown> } : {}),
        ...(args.overrides !== undefined ? { overrides: args.overrides } : {}),
        ...(args.brandId !== undefined ? { brandId: args.brandId } : {}),
      });
      return { render: record, mediaAssetId: record.mediaAssetId, warnings: record.warnings };
    },
    // ADR 0411 P3 — the reel (video) legs, split so the generate-reel node can
    // gate video generation between them (derive → generate → store).
    reelPrompt: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      const brief = await getBrief(tenantId, orgId, str(args.briefId));
      if (!brief) throw new OpenwopError('not_found', 'Creative brief not found.', 404, { briefId: str(args.briefId) });
      return { prompt: reelPromptForBrief(brief, typeof args.directionIndex === 'number' ? args.directionIndex : undefined) };
    },
    storeReel: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      const record = await storeReelRender({
        tenantId, orgId,
        briefId: str(args.briefId),
        actor: scope.actingUserId ?? scope.runId ?? 'workflow',
        videoAssetId: str(args.videoAssetId),
        prompt: str(args.prompt),
        ...(str(args.renderId) ? { renderId: str(args.renderId) } : {}),
        ...(str(args.aspectRatio) ? { aspectRatio: str(args.aspectRatio) } : {}),
        ...(typeof args.durationSeconds === 'number' ? { durationSeconds: args.durationSeconds } : {}),
        ...(typeof args.directionIndex === 'number' ? { directionIndex: args.directionIndex } : {}),
        ...(str(args.provider) ? { provider: str(args.provider) } : {}),
      });
      return { render: record };
    },
    renderVariants: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      const result = await renderVariantsForBrief(tenantId, orgId, scope.actingUserId ?? scope.runId ?? 'workflow', {
        briefId: str(args.briefId),
        templateIds: args.templateIds,
        ...(typeof args.directionIndex === 'number' ? { directionIndex: args.directionIndex } : {}),
        ...(args.copy && typeof args.copy === 'object' ? { copy: args.copy as Record<string, unknown> } : {}),
        ...(args.layers && typeof args.layers === 'object' ? { layers: args.layers as Record<string, unknown> } : {}),
        ...(args.overrides !== undefined ? { overrides: args.overrides } : {}),
        ...(args.brandId !== undefined ? { brandId: args.brandId } : {}),
      });
      return result;
    },
    // ADR 0945 P1 — composite mode. The source's BYTES are returned for the
    // node's recorded image-edit call and must never reach a node output.
    productShotSource: async (args) => {
      const orgId = requireOrg(args);
      await assertProductGroundedEnabled(tenantId, scope.actingUserId);
      // ADR 0945 Q1 — an edit-mode caller is refused HERE, before any paid call.
      if (str(args.mode) === 'edit') await assertEditModeEnabled(tenantId, orgId);
      return productShotSource(tenantId, orgId, str(args.productId), str(args.sourceAssetId) || undefined);
    },
    composeProductShot: async (args) => {
      const orgId = requireOrg(args);
      await assertProductGroundedEnabled(tenantId, scope.actingUserId);
      const render = await composeProductShot(tenantId, orgId, scope.actingUserId ?? scope.runId ?? 'workflow', {
        productId: str(args.productId), briefId: str(args.briefId), templateId: str(args.templateId),
        cutoutAssetId: str(args.cutoutAssetId), backgroundAssetId: str(args.backgroundAssetId),
        ...(typeof args.directionIndex === 'number' ? { directionIndex: args.directionIndex } : {}),
        ...(args.copy && typeof args.copy === 'object' ? { copy: args.copy as Record<string, unknown> } : {}),
      });
      return { render, mediaAssetId: render.mediaAssetId, warnings: render.warnings };
    },
    checkFidelity: async (args) => {
      const orgId = requireOrg(args);
      await assertProductGroundedEnabled(tenantId, scope.actingUserId);
      return { verdict: await checkFidelity(tenantId, orgId, str(args.assetId), { ...(scope.runId ? { runId: scope.runId } : {}), ...(str(args.maskAssetId) ? { maskAssetId: str(args.maskAssetId) } : {}) }) };
    },
    // ADR 0945 P2 — edit mode's protection mask (bytes in-node only).
    protectionMask: async (args) => {
      const orgId = requireOrg(args);
      await assertProductGroundedEnabled(tenantId, scope.actingUserId);
      return protectionMask(tenantId, orgId, str(args.productId), str(args.cutoutAssetId), str(args.provider));
    },
  };
}
